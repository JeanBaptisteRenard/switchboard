const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');

// SWITCHBOARD_DATA_DIR lets dev/agent runs use a separate DB from the
// installed AppImage so they don't race on session_cache (main.js also
// isolates Electron userData / the single-instance lock off the same
// variable). Default stays ~/.switchboard so existing installs keep working.
// Resolve env var at require-time (any later mutation would be ignored).
const DATA_DIR = process.env.SWITCHBOARD_DATA_DIR
  ? path.resolve(process.env.SWITCHBOARD_DATA_DIR.replace(/^~(?=$|\/)/, os.homedir()))
  : path.join(os.homedir(), '.switchboard');
const fs = require('fs');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'switchboard.db');

// Migrate from old locations if needed — never when running against an
// override dir, so a dev instance can't relocate the real app's legacy DB.
const OLD_LOCATIONS = process.env.SWITCHBOARD_DATA_DIR ? [] : [
  path.join(os.homedir(), '.claude', 'browser', 'switchboard.db'),
  path.join(os.homedir(), '.claude', 'browser', 'session-browser.db'),
  path.join(os.homedir(), '.claude', 'session-browser.db'),
];
// Skip the legacy ~/.claude/browser/ migration when running with a custom
// DATA_DIR (typical dev/agent setup) — otherwise a fresh dev DB would steal
// the AppImage's old data on first launch.
const IS_DEFAULT_DATA_DIR = !process.env.SWITCHBOARD_DATA_DIR;
if (IS_DEFAULT_DATA_DIR && !fs.existsSync(DB_PATH)) {
  for (const oldPath of OLD_LOCATIONS) {
    if (fs.existsSync(oldPath)) {
      fs.renameSync(oldPath, DB_PATH);
      try { fs.renameSync(oldPath + '-wal', DB_PATH + '-wal'); } catch {}
      try { fs.renameSync(oldPath + '-shm', DB_PATH + '-shm'); } catch {}
      break;
    }
  }
}
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
// NORMAL is the standard pairing with WAL: the WAL is still synced on
// checkpoint, so the database cannot corrupt; at most the last transactions
// before an OS-level power loss are rolled back. Default FULL fsyncs every
// write for no extra integrity in WAL mode.
db.pragma('synchronous = NORMAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS session_meta (
    sessionId TEXT PRIMARY KEY,
    name TEXT,
    starred INTEGER DEFAULT 0,
    archived INTEGER DEFAULT 0
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS session_cache (
    sessionId TEXT PRIMARY KEY,
    folder TEXT NOT NULL,
    projectPath TEXT,
    summary TEXT,
    firstPrompt TEXT,
    created TEXT,
    modified TEXT,
    messageCount INTEGER DEFAULT 0,
    slug TEXT,
    aiTitle TEXT,
    parentSessionId TEXT,
    agentId TEXT,
    subagentType TEXT,
    description TEXT,
    fileMtime TEXT
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS cache_meta (
    folder TEXT PRIMARY KEY,
    projectPath TEXT,
    indexMtimeMs REAL
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )
`);

// Index for fast folder lookups
db.exec('CREATE INDEX IF NOT EXISTS idx_session_cache_folder ON session_cache(folder)');
db.exec('CREATE INDEX IF NOT EXISTS idx_session_cache_slug ON session_cache(slug)');

// --- Migrations ---
// Each migration runs once, in order. Add new migrations to the end.
let searchFtsRecreated = false;
const migrations = [
  // v1: (superseded by v2)
  () => {},
  // v2: Clear session cache to re-index with corrected worktree paths
  (db) => {
    try { db.exec('DELETE FROM session_cache'); } catch {}
    try { db.exec('DELETE FROM cache_meta'); } catch {}
    try { db.exec('DELETE FROM search_map'); } catch {}
    try { db.exec('DROP TABLE IF EXISTS search_fts'); } catch {}
    searchFtsRecreated = true;
  },
  // v3: Add aiTitle column for AI-generated session titles. Clear cache so a
  // re-index repopulates the column. Also clear session_meta.name entries that
  // were clobbered by AI titles in v0.0.29 (when ai-title was written into the
  // user-name column). We cannot tell with certainty which names came from an
  // AI title vs a manual rename, but the safe heuristic is: drop names whose
  // value matches the JSONL aiTitle on next index. That post-index cleanup is
  // not done here — instead we accept that any pre-fix AI-title pollution
  // remains until the user renames manually, and only future indexes are clean.
  (db) => {
    try { db.exec('ALTER TABLE session_cache ADD COLUMN aiTitle TEXT'); } catch {}
    try { db.exec('DELETE FROM session_cache'); } catch {}
    try { db.exec('DELETE FROM cache_meta'); } catch {}
  },
  // v4: Add subagent columns. Subagent transcripts live under
  // <folder>/<parentSessionId>/subagents/agent-<agentId>.jsonl alongside a
  // .meta.json sidecar holding { agentType, description }. We surface them as
  // first-class rows in session_cache, keyed by sessionId = "sub:<parent>:<agentId>".
  // Clear cache so subagent rows get picked up on first re-index.
  (db) => {
    try { db.exec('ALTER TABLE session_cache ADD COLUMN parentSessionId TEXT'); } catch {}
    try { db.exec('ALTER TABLE session_cache ADD COLUMN agentId TEXT'); } catch {}
    try { db.exec('ALTER TABLE session_cache ADD COLUMN subagentType TEXT'); } catch {}
    try { db.exec('ALTER TABLE session_cache ADD COLUMN description TEXT'); } catch {}
    try { db.exec('CREATE INDEX IF NOT EXISTS idx_session_cache_parent ON session_cache(parentSessionId)'); } catch {}
    try { db.exec('DELETE FROM session_cache'); } catch {}
    try { db.exec('DELETE FROM cache_meta'); } catch {}
  },
  // v5: per-(session,date,model) metrics for the stats screen (tokens, tool calls,
  // messages bucketed by message timestamp). Populated on next cold-start rebuild
  // (the scan worker re-reads every JSONL), so no separate backfill is needed.
  (db) => {
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS session_metrics (
        sessionId TEXT NOT NULL,
        date TEXT NOT NULL,
        model TEXT NOT NULL DEFAULT '',
        messageCount INTEGER DEFAULT 0,
        toolCallCount INTEGER DEFAULT 0,
        inputTokens INTEGER DEFAULT 0,
        outputTokens INTEGER DEFAULT 0,
        cacheReadTokens INTEGER DEFAULT 0,
        cacheCreationTokens INTEGER DEFAULT 0,
        PRIMARY KEY (sessionId, date, model)
      )`);
      db.exec('CREATE INDEX IF NOT EXISTS idx_session_metrics_date ON session_metrics(date)');
    } catch {}
  },
  // v6: Convert search_fts from a plain fts5 table (which stores a full copy of
  // title+body, inflating the DB ~14x) to an external-content fts5 table backed
  // by search_content (which stores a single, truncated copy). This drops the DB
  // from ~190 MB to ~35-40 MB for a typical 13 MB raw-text corpus.
  //
  // snippet() continues to work unchanged: fts5 reads the columns from
  // search_content on demand instead of its own shadow tables. The body stored
  // in search_content is truncated to FTS_BODY_MAX_CHARS (32 KB) so the content
  // table itself stays small.
  //
  // searchFtsRecreated = true tells main.js to trigger a full repopulate via
  // populateCacheViaWorker(), which will re-insert all rows with the new schema.
  //
  // VACUUM: the DROP TABLE calls above free ~152 MB of pages (the old plain
  // search_fts shadow tables) but SQLite only adds them to the freelist — the
  // file stays at its old size. Without VACUUM the user sees "stopped growing"
  // rather than "actually shrank". A one-time VACUUM here reclaims that space
  // immediately: empirically 225 MB → 37.9 MB in ~0.5 s on a 236 MB real DB.
  // VACUUM cannot run inside a SQLite transaction. The migrations loop (lines
  // above) is NOT wrapped in a transaction, so calling db.exec('VACUUM') here
  // is legal and runs atomically against the now-empty freelist pages.
  (db) => {
    try { db.exec('DROP TABLE IF EXISTS search_fts'); } catch {}
    try { db.exec('DROP TABLE IF EXISTS search_content'); } catch {}
    try { db.exec('DELETE FROM search_map'); } catch {}
    try { db.exec('VACUUM'); } catch {}
    searchFtsRecreated = true;
  },
  // v7: Split display time from cache invalidation. `modified` now holds the last
  // message timestamp from the JSONL (resuming a session appends untimestamped
  // bookkeeping records that bump mtime, making idle sessions show "just now");
  // the new fileMtime column takes over as the re-index change-detection key.
  // Clear cache so a re-index repopulates both columns.
  //
  // Upstream numbered this v4; here it lands as v7 because migrations are
  // index-addressed (db_version == migrations.length) and our v4-v6 already
  // shipped. Installs sitting at db_version 6 run exactly this one on upgrade.
  (db) => {
    try { db.exec('ALTER TABLE session_cache ADD COLUMN fileMtime TEXT'); } catch {}
    try { db.exec('DELETE FROM session_cache'); } catch {}
    try { db.exec('DELETE FROM cache_meta'); } catch {}
  },
  // Upstream replaced its own v4 with a () => {} no-op and moved the fileMtime
  // ALTER into the schema-reconciliation pass below. Our array is
  // index-addressed with v4-v6 already shipped, so v7 stays as the fast path
  // for fork installs; the reconciliation block covers foreign-version DBs.
  // v8: backfill the initial-scan completeness marker (settings key
  // 'initial_scan_complete'). The scan worker now streams one DB write per
  // folder, so an interrupted first scan leaves session_cache PARTIALLY
  // populated — indistinguishable, by row count alone, from a finished scan.
  // session-cache.js therefore writes this marker only when the worker's
  // final done message arrives, and get-projects treats "cache populated but
  // marker absent" as an interrupted first scan: it resumes the background
  // worker instead of running the synchronous reconcile sweep (which would
  // re-parse every still-missing folder on the main thread — the multi-minute
  // freeze the marker exists to prevent).
  //
  // Existing installs predate the marker but were populated by builds that
  // wrote the whole scan in a single final-message batch: a populated cache
  // here can only mean a completed scan, never a partial one (partial states
  // only became possible with the per-folder streaming that ships alongside
  // this migration). Blessing them is therefore safe — and necessary, or
  // every existing user would be thrown back into a full cold-start scan.
  (db) => {
    try {
      const row = db.prepare('SELECT COUNT(*) AS cnt FROM session_cache').get();
      if (row.cnt > 0) {
        // JSON.stringify(true) to match setSetting's encoding.
        db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('initial_scan_complete', 'true')").run();
      }
    } catch {}
  },
  // v9: purge rows summarised from local-command bookkeeping. /clear and /model
  // open a new transcript whose first records are only that bookkeeping, which
  // read-session-file.js used to take as the summary — titling every session
  // started by /clear "<command-name>/clear…" and listing bookkeeping-only
  // transcripts as phantom sessions. The parser no longer does; drop the rows
  // it already wrote, plus the cache_meta gate for their folders so the next
  // reconcile re-reads exactly those files (every other file in the folder
  // still hits the fileMtime fast path and is left untouched).
  (db) => {
    try {
      // Both tag orders the CLI writes: <command-name> first, and
      // <command-message> first (/auto-compact, /pre-compact).
      const bad = db.prepare(`SELECT sessionId, folder FROM session_cache
         WHERE summary LIKE '<command-name>%' OR summary LIKE '<command-message>%'
            OR summary LIKE '<local-command-stdout>%'`
      ).all();
      if (bad.length === 0) return;
      const delRow = db.prepare('DELETE FROM session_cache WHERE sessionId = ?');
      const delFolderMeta = db.prepare('DELETE FROM cache_meta WHERE folder = ?');
      // One transaction: a purge interrupted halfway cannot be resumed, because
      // the next launch is already at db_version 9 and the SELECT above no
      // longer matches the rows it dropped — whatever it left behind in the
      // search tables would stay orphaned forever.
      db.transaction(() => {
        for (const { sessionId, folder } of bad) {
          delRow.run(sessionId);
          if (folder) delFolderMeta.run(folder);
        }
        // Search entries and per-session metrics live in tables created further
        // down this file, so they may not exist yet on a DB this migration is
        // the first to touch — prepared separately so a missing table throws
        // here instead of skipping the purge above. Metrics must go the same way
        // deleteCachedSession drops them: a phantom's file is never re-read, so
        // its rows would keep inflating the daily counts and totals for good.
        // External-content FTS5 ordering: fts delete first (it reads
        // search_content), then content, then the map.
        try {
          const delMetrics = db.prepare('DELETE FROM session_metrics WHERE sessionId = ?');
          const delFts = db.prepare("DELETE FROM search_fts WHERE rowid IN (SELECT rowid FROM search_map WHERE type = 'session' AND id = ?)");
          const delContent = db.prepare("DELETE FROM search_content WHERE rowid IN (SELECT rowid FROM search_map WHERE type = 'session' AND id = ?)");
          const delMap = db.prepare("DELETE FROM search_map WHERE type = 'session' AND id = ?");
          for (const { sessionId } of bad) {
            delMetrics.run(sessionId);
            delFts.run(sessionId);
            delContent.run(sessionId);
            delMap.run(sessionId);
          }
        } catch {}
      })();
    } catch {}
  },
];

const currentDbVersion = (() => {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'db_version'").get();
    return row ? JSON.parse(row.value) : 0;
  } catch { return 0; }
})();

for (let i = currentDbVersion; i < migrations.length; i++) {
  migrations[i](db);
}
if (migrations.length > currentDbVersion) {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('db_version', ?)").run(JSON.stringify(migrations.length));
}

// --- Schema reconciliation ---
// Version-numbered migrations cannot be trusted to add columns: a DB already
// migrated to a HIGHER version by a build from a parallel branch skips this
// branch's migrations entirely (a db_version-5 DB from the subagent branch
// never ran our v4, so the fileMtime ALTER never happened and every prepare()
// below crashed the app at startup). Required columns are therefore ensured by
// inspecting the actual schema, independent of db_version. Errors here are
// deliberately NOT swallowed: a transient failure (e.g. SQLITE_BUSY) must not
// be recorded as migrated — the next launch simply retries.
{
  const cols = new Set(db.prepare('PRAGMA table_info(session_cache)').all().map(c => c.name));
  let mustReindex = false;
  if (!cols.has('aiTitle')) db.exec('ALTER TABLE session_cache ADD COLUMN aiTitle TEXT');
  // Fork columns (shipped in our v4): a foreign-version DB may have skipped
  // that migration the same way. Their absence means subagent rows were never
  // indexed, so a re-index is needed too.
  for (const col of ['parentSessionId', 'agentId', 'subagentType', 'description', 'bridgeSessionId', 'mergedIntoSessionId']) {
    if (!cols.has(col)) {
      db.exec(`ALTER TABLE session_cache ADD COLUMN ${col} TEXT`);
      mustReindex = true;
    }
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_session_cache_parent ON session_cache(parentSessionId)');
  // Fork table (shipped in our v5), referenced unconditionally by prepare()
  // below — must exist whatever db_version claims.
  db.exec(`CREATE TABLE IF NOT EXISTS session_metrics (
    sessionId TEXT NOT NULL,
    date TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT '',
    messageCount INTEGER DEFAULT 0,
    toolCallCount INTEGER DEFAULT 0,
    inputTokens INTEGER DEFAULT 0,
    outputTokens INTEGER DEFAULT 0,
    cacheReadTokens INTEGER DEFAULT 0,
    cacheCreationTokens INTEGER DEFAULT 0,
    PRIMARY KEY (sessionId, date, model)
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_session_metrics_date ON session_metrics(date)');
  if (!cols.has('fileMtime')) {
    db.exec('ALTER TABLE session_cache ADD COLUMN fileMtime TEXT');
    // fileMtime's introduction changed what `modified` means (file mtime →
    // last-message timestamp), so cached values written by pre-fileMtime code
    // are stale. Clear the cache to force a full re-index; without this,
    // dormant folders would keep mtime-based times indefinitely because the
    // folder-level index gate never re-reads them.
    mustReindex = true;
  }
  if (mustReindex) {
    db.exec('DELETE FROM session_cache');
    db.exec('DELETE FROM cache_meta');
    // The cache is empty again, so the coming rescan is a fresh initial scan:
    // drop the completeness marker so an interruption of THAT scan is detected
    // (cache partially repopulated + marker absent → get-projects resumes the
    // background worker instead of reconciling synchronously), and so
    // buildProjectsFromCache stays on its zero-I/O fallback while it runs.
    db.exec("DELETE FROM settings WHERE key = 'initial_scan_complete'");
  }
}

// --- FTS5 full-text search (external-content table) ---
//
// Body is capped at FTS_BODY_MAX_CHARS before being stored. This bounds the
// content table size independently of raw transcript length, while keeping
// enough text for useful snippet() previews.
const FTS_BODY_MAX_CHARS = 32768; // 32 768 JS characters (UTF-16 code units); surrogate-pair split at the boundary is negligible for ASCII transcripts

// Query cap + MATCH-expression construction live in fts-match.js, shared with
// workers/search-query.js so the two query paths cannot drift apart.
const { buildFtsMatch } = require('./fts-match');

// search_content holds the plaintext the fts5 index reads columns from.
// It is the single authoritative copy: title is full-length; body is
// truncated to FTS_BODY_MAX_CHARS. Keeping this separate from search_map
// (which stores only id/type/folder) lets us JOIN on rowid cheaply.
db.exec(`
  CREATE TABLE IF NOT EXISTS search_content (
    rowid INTEGER PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    body  TEXT NOT NULL DEFAULT ''
  )
`);

// search_fts is an external-content fts5 table: it stores only the trigram
// index, not a copy of title/body. snippet()/highlight() work by reading
// the corresponding row from search_content at query time (zero extra copy).
// This eliminates the ~14x amplification of the old plain fts5 table.
db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
    title, body,
    content='search_content',
    tokenize='trigram case_sensitive 0'
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS search_map (
    rowid INTEGER PRIMARY KEY,
    id TEXT NOT NULL,
    type TEXT NOT NULL,
    folder TEXT
  )
`);

db.exec('CREATE INDEX IF NOT EXISTS idx_search_map_type_id ON search_map(type, id)');

const stmts = {
  get: db.prepare('SELECT * FROM session_meta WHERE sessionId = ?'),
  getAll: db.prepare('SELECT * FROM session_meta'),
  upsertName: db.prepare(`
    INSERT INTO session_meta (sessionId, name) VALUES (?, ?)
    ON CONFLICT(sessionId) DO UPDATE SET name = excluded.name
  `),
  upsertStar: db.prepare(`
    INSERT INTO session_meta (sessionId, starred) VALUES (?, 1)
    ON CONFLICT(sessionId) DO UPDATE SET starred = CASE WHEN starred = 1 THEN 0 ELSE 1 END
  `),
  upsertArchived: db.prepare(`
    INSERT INTO session_meta (sessionId, archived) VALUES (?, ?)
    ON CONFLICT(sessionId) DO UPDATE SET archived = excluded.archived
  `),
  // Session cache statements
  cacheCount: db.prepare('SELECT COUNT(*) as cnt FROM session_cache'),
  cacheGetAll: db.prepare('SELECT * FROM session_cache'),
  cacheUpsert: db.prepare(`
    INSERT INTO session_cache (sessionId, folder, projectPath, summary, firstPrompt, created, modified, messageCount, slug, aiTitle, parentSessionId, agentId, subagentType, description, fileMtime, bridgeSessionId, mergedIntoSessionId)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(sessionId) DO UPDATE SET
      folder = excluded.folder, projectPath = excluded.projectPath,
      summary = excluded.summary, firstPrompt = excluded.firstPrompt,
      created = excluded.created, modified = excluded.modified,
      messageCount = excluded.messageCount, slug = excluded.slug,
      aiTitle = excluded.aiTitle, fileMtime = excluded.fileMtime,
      parentSessionId = excluded.parentSessionId, agentId = excluded.agentId,
      subagentType = excluded.subagentType, description = excluded.description,
      bridgeSessionId = excluded.bridgeSessionId,
      mergedIntoSessionId = excluded.mergedIntoSessionId
  `),
  cacheGetByParent: db.prepare('SELECT * FROM session_cache WHERE parentSessionId = ? ORDER BY created ASC'),
  // Kept as SELECT * (upstream narrowed this to sessionId+fileMtime): our
  // reconcile path in session-cache.js caches the whole row so a header-only
  // refresh can merge display fields without re-reading the transcript body.
  // fileMtime still comes through, so upstream's invalidation key works.
  cacheGetByFolder: db.prepare('SELECT * FROM session_cache WHERE folder = ?'),
  cacheGetFolder: db.prepare('SELECT folder FROM session_cache WHERE sessionId = ?'),
  cacheGetSession: db.prepare('SELECT * FROM session_cache WHERE sessionId = ?'),
  cacheDeleteSession: db.prepare('DELETE FROM session_cache WHERE sessionId = ?'),
  cacheDeleteFolder: db.prepare('DELETE FROM session_cache WHERE folder = ?'),
  // Bumps both columns: `modified` drives sidebar sort order, `fileMtime` is the
  // re-index invalidation key (upstream's v7 split). Leaving fileMtime behind
  // would make the touched row look dirty forever.
  cacheTouchModified: db.prepare('UPDATE session_cache SET modified = ?, fileMtime = ? WHERE sessionId = ?'),
  // Session metrics statements (per-(session,date,model) token/tool/message counts)
  metricsDeleteBySession: db.prepare('DELETE FROM session_metrics WHERE sessionId = ?'),
  metricsDeleteByFolder: db.prepare('DELETE FROM session_metrics WHERE sessionId IN (SELECT sessionId FROM session_cache WHERE folder = ?)'),
  metricsInsert: db.prepare(`
    INSERT INTO session_metrics
      (sessionId, date, model, messageCount, toolCallCount, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  // Cache meta statements
  metaGet: db.prepare('SELECT * FROM cache_meta WHERE folder = ?'),
  metaGetAll: db.prepare('SELECT * FROM cache_meta'),
  metaUpsert: db.prepare(`
    INSERT INTO cache_meta (folder, projectPath, indexMtimeMs)
    VALUES (?, ?, ?)
    ON CONFLICT(folder) DO UPDATE SET
      projectPath = excluded.projectPath, indexMtimeMs = excluded.indexMtimeMs
  `),
  metaDelete: db.prepare('DELETE FROM cache_meta WHERE folder = ?'),
  // FTS search statements
  // External-content protocol: search_content is the authoritative column store;
  // search_fts holds only the trigram index and reads columns from search_content
  // at query time. Delete/insert must keep both tables in sync.
  searchDeleteContentBySession: db.prepare('DELETE FROM search_content WHERE rowid IN (SELECT rowid FROM search_map WHERE type = \'session\' AND id = ?)'),
  searchDeleteBySession: db.prepare('DELETE FROM search_fts WHERE rowid IN (SELECT rowid FROM search_map WHERE type = \'session\' AND id = ?)'),
  searchMapDeleteBySession: db.prepare('DELETE FROM search_map WHERE type = \'session\' AND id = ?'),
  searchDeleteContentByFolder: db.prepare('DELETE FROM search_content WHERE rowid IN (SELECT rowid FROM search_map WHERE type = \'session\' AND folder = ?)'),
  searchDeleteByFolder: db.prepare('DELETE FROM search_fts WHERE rowid IN (SELECT rowid FROM search_map WHERE type = \'session\' AND folder = ?)'),
  searchMapDeleteByFolder: db.prepare('DELETE FROM search_map WHERE type = \'session\' AND folder = ?'),
  searchDeleteContentByType: db.prepare('DELETE FROM search_content WHERE rowid IN (SELECT rowid FROM search_map WHERE type = ?)'),
  searchDeleteByType: db.prepare('DELETE FROM search_fts WHERE rowid IN (SELECT rowid FROM search_map WHERE type = ?)'),
  searchMapDeleteByType: db.prepare('DELETE FROM search_map WHERE type = ?'),
  // Insert: search_content row first (external-content protocol requires the
  // content row to exist before the fts5 shadow row is written).
  searchInsertContent: db.prepare('INSERT OR REPLACE INTO search_content(rowid, title, body) VALUES (?, ?, ?)'),
  searchInsertFts: db.prepare('INSERT OR REPLACE INTO search_fts(rowid, title, body) VALUES (?, ?, ?)'),
  searchInsertMap: db.prepare('INSERT OR REPLACE INTO search_map(id, type, folder) VALUES (?, ?, ?)'),
  searchMapLookup: db.prepare('SELECT rowid FROM search_map WHERE id = ? AND type = ?'),
  // Title update: patches search_content (the authoritative column store) and
  // immediately removes the old fts5 shadow row via the 'delete' command then
  // reinserts it with the new title. See updateSearchTitle() for the full
  // two-step delete + reinsert protocol — the index is NOT lazily rebuilt.
  searchUpdateTitle: db.prepare('UPDATE search_content SET title = ? WHERE rowid = (SELECT rowid FROM search_map WHERE id = ? AND type = ?)'),
  searchDeleteContentByRowid: db.prepare('DELETE FROM search_content WHERE rowid = ?'),
  searchDeleteByRowid: db.prepare('DELETE FROM search_fts WHERE rowid = ?'),
  searchMapDeleteByRowid: db.prepare('DELETE FROM search_map WHERE rowid = ?'),
  searchContentGet: db.prepare('SELECT title, body FROM search_content WHERE rowid = ?'),
  // fts5 external-content delete command: removes the shadow row by its old
  // column values. Used before reinserting with updated title.
  searchFtsDeleteRow: db.prepare("INSERT INTO search_fts(search_fts, rowid, title, body) VALUES('delete', ?, ?, ?)"),
  searchFtsInsertRow: db.prepare('INSERT INTO search_fts(rowid, title, body) VALUES(?, ?, ?)'),
  // Settings statements
  settingsGet: db.prepare('SELECT value FROM settings WHERE key = ?'),
  settingsUpsert: db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `),
  settingsDelete: db.prepare('DELETE FROM settings WHERE key = ?'),
  searchQuery: db.prepare(`
    SELECT search_map.id, snippet(search_fts, 1, '<mark>', '</mark>', '...', 40) as snippet
    FROM search_fts
    JOIN search_map ON search_fts.rowid = search_map.rowid
    WHERE search_map.type = ? AND search_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `),
};

function getMeta(sessionId) {
  return stmts.get.get(sessionId) || null;
}

function getAllMeta() {
  const rows = stmts.getAll.all();
  const map = new Map();
  for (const row of rows) map.set(row.sessionId, row);
  return map;
}

function setName(sessionId, name) {
  stmts.upsertName.run(sessionId, name);
}

function toggleStar(sessionId) {
  stmts.upsertStar.run(sessionId);
  const row = stmts.get.get(sessionId);
  return row.starred;
}

function setArchived(sessionId, archived) {
  stmts.upsertArchived.run(sessionId, archived ? 1 : 0);
}

// --- Session cache functions ---

function isCachePopulated() {
  return stmts.cacheCount.get().cnt > 0;
}

function getAllCached() {
  return stmts.cacheGetAll.all();
}

const upsertCachedSessionsBatch = db.transaction((sessions) => {
  for (const s of sessions) {
    stmts.cacheUpsert.run(
      s.sessionId, s.folder, s.projectPath, s.summary,
      s.firstPrompt, s.created, s.modified, s.messageCount || 0,
      s.slug || null, s.aiTitle || null,
      s.parentSessionId || null, s.agentId || null,
      s.subagentType || null, s.description || null,
      s.fileMtime || null, s.bridgeSessionId || null, s.mergedIntoSessionId || null
    );
  }
});

// Replace all metric rows for a session in one transaction: delete-by-session
// then insert the fresh per-(date,model) rows. Called whenever a session is read
// in full (cold-start rebuild + NEW-file branch of the incremental refresh).
const replaceSessionMetricsBatch = db.transaction((sessionId, rows) => {
  stmts.metricsDeleteBySession.run(sessionId);
  for (const r of rows || []) {
    stmts.metricsInsert.run(
      sessionId, r.date, r.model || '',
      r.messageCount | 0, r.toolCallCount | 0,
      r.inputTokens | 0, r.outputTokens | 0,
      r.cacheReadTokens | 0, r.cacheCreationTokens | 0
    );
  }
});

function replaceSessionMetrics(sessionId, rows) {
  replaceSessionMetricsBatch(sessionId, rows);
}

function getCachedByParent(parentSessionId) {
  return stmts.cacheGetByParent.all(parentSessionId);
}

function upsertCachedSessions(sessions) {
  upsertCachedSessionsBatch(sessions);
}

function getCachedByFolder(folder) {
  return stmts.cacheGetByFolder.all(folder);
}

function getCachedFolder(sessionId) {
  const row = stmts.cacheGetFolder.get(sessionId);
  return row ? row.folder : null;
}

function getCachedSession(sessionId) {
  return stmts.cacheGetSession.get(sessionId) || null;
}

function deleteCachedSession(sessionId) {
  stmts.metricsDeleteBySession.run(sessionId);
  stmts.cacheDeleteSession.run(sessionId);
}

function deleteCachedFolder(folder) {
  // Delete metrics first — metricsDeleteByFolder sub-selects on session_cache,
  // so it must run before the session_cache rows for this folder are gone.
  stmts.metricsDeleteByFolder.run(folder);
  stmts.cacheDeleteFolder.run(folder);
  stmts.metaDelete.run(folder);
}

function getFolderMeta(folder) {
  return stmts.metaGet.get(folder) || null;
}

function getAllFolderMeta() {
  const rows = stmts.metaGetAll.all();
  const map = new Map();
  for (const row of rows) map.set(row.folder, row);
  return map;
}

function setFolderMeta(folder, projectPath, indexMtimeMs) {
  stmts.metaUpsert.run(folder, projectPath, indexMtimeMs);
}

// --- FTS search functions ---

const upsertSearchEntriesBatch = db.transaction((entries) => {
  for (const e of entries) {
    // Delete any existing FTS + content rows for this (id, type) pair before
    // inserting. search_map uses INSERT OR REPLACE which deletes the old row
    // and creates a new one with a new rowid, but the orphaned search_fts and
    // search_content rows keyed to the old rowid would never be cleaned up —
    // causing duplicate search results and unbounded table growth.
    const existing = stmts.searchMapLookup.get(e.id, e.type);
    if (existing) {
      stmts.searchDeleteByRowid.run(existing.rowid);
      stmts.searchDeleteContentByRowid.run(existing.rowid);
      stmts.searchMapDeleteByRowid.run(existing.rowid);
    }
    const result = stmts.searchInsertMap.run(e.id, e.type, e.folder || null);
    const rid = result.lastInsertRowid;
    const title = e.title || '';
    // Truncate body to FTS_BODY_MAX_CHARS: bounds search_content size and
    // keeps the fts5 index compact without sacrificing meaningful snippets
    // (the first 32 KB of a transcript covers the most-relevant content).
    const body = (e.body || '').slice(0, FTS_BODY_MAX_CHARS);
    // External-content protocol: search_content row must exist before the
    // fts5 shadow row so that fts5 can read columns for snippet() at insert.
    stmts.searchInsertContent.run(rid, title, body);
    stmts.searchInsertFts.run(rid, title, body);
  }
});

function deleteSearchSession(sessionId) {
  // External-content FTS5 protocol: delete from search_fts FIRST while
  // search_content rows still exist. SQLite reads search_content to locate the
  // trigram entries to remove from the shadow tables; if content is gone first,
  // those entries are never cleaned up and accumulate as ghost trigrams.
  // search_map is deleted last because the rowid sub-select in the two DELETE
  // stmts above still needs to resolve.
  stmts.searchDeleteBySession.run(sessionId);
  stmts.searchDeleteContentBySession.run(sessionId);
  stmts.searchMapDeleteBySession.run(sessionId);
}

function deleteSearchFolder(folder) {
  // Same external-content FTS5 ordering: FTS delete before content delete.
  stmts.searchDeleteByFolder.run(folder);
  stmts.searchDeleteContentByFolder.run(folder);
  stmts.searchMapDeleteByFolder.run(folder);
}

function deleteSearchType(type) {
  // Same external-content FTS5 ordering: FTS delete before content delete.
  stmts.searchDeleteByType.run(type);
  stmts.searchDeleteContentByType.run(type);
  stmts.searchMapDeleteByType.run(type);
}

function upsertSearchEntries(entries) {
  upsertSearchEntriesBatch(entries);
}

function updateSearchTitle(id, type, title) {
  // For an external-content fts5 table, updating search_content is the
  // authoritative change (snippet() reads columns from there). The fts5 index
  // is also patched: delete the old shadow row then re-insert with the new
  // title so trigram search on title reflects the rename immediately.
  try {
    const mapRow = stmts.searchMapLookup.get(id, type);
    if (!mapRow) return;
    const rid = mapRow.rowid;
    const contentRow = stmts.searchContentGet.get(rid);
    if (!contentRow) return;
    // Update the content table first.
    stmts.searchUpdateTitle.run(title, id, type);
    // Patch the fts5 index: external-content delete + reinsert.
    // The 'delete' command removes the old shadow row without touching the
    // content table; the plain insert adds the updated shadow row.
    stmts.searchFtsDeleteRow.run(rid, contentRow.title, contentRow.body);
    stmts.searchFtsInsertRow.run(rid, title, contentRow.body);
  } catch {}
}

function searchByType(type, query, limit = 50, titleOnly = false) {
  try {
    // Cap + escape via the shared fts-match.js helper — a long pasted string
    // (e.g. a GitLab MR URL) otherwise becomes a huge trigram phrase intersect
    // that can block this thread for ~60 s. See fts-match.js for the details.
    const match = buildFtsMatch(query, titleOnly);
    return stmts.searchQuery.all(type, match, limit);
  } catch {
    return [];
  }
}

function isSearchIndexPopulated() {
  const row = db.prepare('SELECT COUNT(*) as cnt FROM search_map WHERE type = ?').get('session');
  return row.cnt > 0;
}

// --- Settings functions ---

function getSetting(key) {
  const row = stmts.settingsGet.get(key);
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

function setSetting(key, value) {
  stmts.settingsUpsert.run(key, JSON.stringify(value));
}

function deleteSetting(key) {
  stmts.settingsDelete.run(key);
}

// --- Initial-scan completeness marker ---
// The scan worker streams per-folder DB writes, so "session_cache has rows"
// no longer implies "the initial scan finished" — an interrupted first scan
// leaves a partial cache. This marker is the authoritative signal: written by
// session-cache.js only on the worker's final successful done message,
// backfilled once for pre-marker installs by migration v8, cleared whenever
// the schema-reconciliation pass wipes the cache for a re-index.
const INITIAL_SCAN_COMPLETE_KEY = 'initial_scan_complete';

function isInitialScanComplete() {
  return getSetting(INITIAL_SCAN_COMPLETE_KEY) === true;
}

function setInitialScanComplete() {
  setSetting(INITIAL_SCAN_COMPLETE_KEY, true);
}

// --- Daily activity aggregate (for stats heatmap) ---

// Returns [{date: 'YYYY-MM-DD', messageCount, sessionCount}, ...] sorted ASC.
// Aggregates ALL rows in session_cache (parent sessions + subagents) so the
// heatmap reflects real usage regardless of whether Claude rotated the parent
// JSONL files.
function getDailyActivity() {
  return db.prepare(`
    SELECT
      substr(modified, 1, 10) AS date,
      SUM(messageCount)       AS messageCount,
      COUNT(*)                AS sessionCount
    FROM session_cache
    WHERE modified IS NOT NULL
      AND length(modified) >= 10
    GROUP BY date
    ORDER BY date ASC
  `).all();
}

// --- Session metrics aggregates (for the stats screen) ---

// One row per day, summed across all models. Powers the heatmap + daily bars.
// messageCount/toolCallCount/tokens come from session_metrics (bucketed by the
// per-message timestamp, not the session mtime); sessionCount counts distinct
// sessions active that day.
// Stats statements are memoized on first use (the stats screen may never be
// opened) instead of being re-parsed on every call.
let dailyMetricsStmt;
function getDailyMetrics() {
  dailyMetricsStmt ??= db.prepare(`
    SELECT date,
           SUM(messageCount)            AS messageCount,
           SUM(toolCallCount)           AS toolCallCount,
           SUM(inputTokens + outputTokens) AS tokens,
           COUNT(DISTINCT sessionId)    AS sessionCount
    FROM session_metrics
    GROUP BY date
    ORDER BY date ASC
  `);
  return dailyMetricsStmt.all();
}

// [{date, tokensByModel: {model: tokens}}] sorted by date. Excludes the '' model
// bucket (synthetic / model-less assistant turns carry no tokens anyway).
let dailyModelTokensStmt;
function getDailyModelTokens() {
  dailyModelTokensStmt ??= db.prepare(`
    SELECT date, model, SUM(inputTokens + outputTokens) AS tokens
    FROM session_metrics
    WHERE model != ''
    GROUP BY date, model
  `);
  const rows = dailyModelTokensStmt.all();
  const byDate = new Map();
  for (const r of rows) {
    let entry = byDate.get(r.date);
    if (!entry) {
      entry = { date: r.date, tokensByModel: {} };
      byDate.set(r.date, entry);
    }
    entry.tokensByModel[r.model] = r.tokens;
  }
  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

// {model: {inputTokens, outputTokens}} across all time. Excludes '' model.
let modelUsageStmt;
function getModelUsage() {
  modelUsageStmt ??= db.prepare(`
    SELECT model,
           SUM(inputTokens)  AS inputTokens,
           SUM(outputTokens) AS outputTokens
    FROM session_metrics
    WHERE model != ''
    GROUP BY model
  `);
  const rows = modelUsageStmt.all();
  const out = {};
  for (const r of rows) {
    out[r.model] = { inputTokens: r.inputTokens, outputTokens: r.outputTokens };
  }
  return out;
}

// {totalSessions, totalMessages, totalToolCalls, totalTokens}. totalSessions
// counts ONLY parent (human) sessions — subagents would otherwise inflate it,
// and so would a compaction mirror row (mergedIntoSessionId set): it is the
// same session as the row it merged into, not a second one.
let totalSessionsStmt;
let totalMetricsStmt;
function getTotalCounts() {
  totalSessionsStmt ??= db.prepare(
    'SELECT COUNT(*) AS cnt FROM session_cache WHERE parentSessionId IS NULL AND mergedIntoSessionId IS NULL'
  );
  totalMetricsStmt ??= db.prepare(`
    SELECT
      SUM(messageCount)            AS totalMessages,
      SUM(toolCallCount)           AS totalToolCalls,
      SUM(inputTokens + outputTokens) AS totalTokens
    FROM session_metrics
  `);
  const sessions = totalSessionsStmt.get();
  const metrics = totalMetricsStmt.get();
  return {
    totalSessions: sessions.cnt || 0,
    totalMessages: metrics.totalMessages || 0,
    totalToolCalls: metrics.totalToolCalls || 0,
    totalTokens: metrics.totalTokens || 0,
  };
}

function closeDb() {
  // Truncate the WAL back into the main file on clean shutdown. Long-lived
  // reader connections (the scan worker) can starve SQLite's automatic
  // checkpoints, letting the -wal file grow to tens of MB (witnessed: 39 MB)
  // and adding read amplification on every query of the next run.
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch {}
  try { db.close(); } catch {}
}

module.exports = {
  getMeta, getAllMeta, setName, toggleStar, setArchived,
  isCachePopulated, getAllCached, getCachedByFolder, getCachedByParent, getCachedFolder, getCachedSession, upsertCachedSessions,
  touchCachedModified: (sessionId, modified, fileMtime = modified) => stmts.cacheTouchModified.run(modified, fileMtime, sessionId),
  deleteCachedSession, deleteCachedFolder,
  replaceSessionMetrics,
  getFolderMeta, getAllFolderMeta, setFolderMeta,
  upsertSearchEntries, updateSearchTitle, deleteSearchSession, deleteSearchFolder, deleteSearchType,
  searchByType, isSearchIndexPopulated, searchFtsRecreated,
  getSetting, setSetting, deleteSetting,
  isInitialScanComplete, setInitialScanComplete,
  getDailyActivity,
  getDailyMetrics, getDailyModelTokens, getModelUsage, getTotalCounts,
  closeDb,
  // Exported so main.js can pass the resolved path to the search-query worker
  // without re-deriving the SWITCHBOARD_DATA_DIR logic in a second place.
  DB_PATH,
};
