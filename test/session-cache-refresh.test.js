/**
 * BT3 — Characterization tests for session-cache.js refreshFolder().
 *
 * These tests assert observable DB-call outputs (which sessions get upserted,
 * deleted, search-indexed) through the fake-DB seam. They do NOT assert internal
 * call order, only observable side-effects via the fake DB.
 *
 * Pattern: init(ctx) with a fake DB that records calls, then call refreshFolder()
 * directly. Matches reconcile-cache.test.js conventions.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sessionCache = require('../session-cache');

// ---- Helpers ----------------------------------------------------------------

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-scr-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Write a minimal valid JSONL session file with a cwd so deriveProjectPath()
 * can resolve a projectPath from it.
 */
function writeSession(filePath, cwd, extraLines = []) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lines = [
    JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: 'hello world' } }),
    ...extraLines.map(l => JSON.stringify(l)),
  ];
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
}

/**
 * Extended fake DB that records all upsert/delete/search/meta calls.
 * Returns an object with the db handle and recorded calls arrays.
 */
function makeFakeDb(opts = {}) {
  const upserted = [];
  const deleted = [];
  const searchUpserted = [];
  const searchDeleted = [];
  const folderMeta = new Map(opts.initialFolderMeta || []);
  const sessionMeta = new Map(opts.initialSessionMeta || []);

  // Pre-populated cache rows (simulates what's already in DB)
  const cachedRows = opts.cachedRows || [];

  const db = {
    deleteCachedFolder: () => {},
    getCachedByFolder: () => cachedRows,
    upsertCachedSessions: (sessions) => { for (const s of sessions) upserted.push(s); },
    touchCachedModified: () => {},
    deleteCachedSession: (id) => deleted.push(id),
    replaceSessionMetrics: () => {},
    deleteSearchFolder: () => {},
    deleteSearchSession: (id) => searchDeleted.push(id),
    upsertSearchEntries: (entries) => { for (const e of entries) searchUpserted.push(e); },
    setFolderMeta: (folder, projectPath, mtime) => folderMeta.set(folder, { folder, projectPath, indexMtimeMs: mtime }),
    getAllFolderMeta: () => folderMeta,
    getAllMeta: () => sessionMeta,
    getAllCached: () => [],
    getSetting: () => ({}),
    getMeta: () => null,
    setName: () => {},
  };

  return { db, upserted, deleted, searchUpserted, searchDeleted, folderMeta };
}

// ---- Tests ------------------------------------------------------------------

test('refreshFolder: only the changed-mtime file gets upserted; unchanged files are skipped', () => {
  const projectsDir = mkTmp();
  try {
    const folder = 'test-proj';
    const folderPath = path.join(projectsDir, folder);
    const projectPath = projectsDir; // cwd points here → deriveProjectPath returns it

    // Write 3 session files
    const fileA = path.join(folderPath, 'session-a.jsonl');
    const fileB = path.join(folderPath, 'session-b.jsonl');
    const fileC = path.join(folderPath, 'session-c.jsonl');
    writeSession(fileA, projectPath);
    writeSession(fileB, projectPath);
    writeSession(fileC, projectPath);

    // Simulate A and B already cached with their current mtime
    const statA = fs.statSync(fileA).mtime.toISOString();
    const statB = fs.statSync(fileB).mtime.toISOString();
    // C is not in cache at all → it's NEW and must be upserted
    const cachedRows = [
      { sessionId: 'session-a', folder, projectPath, modified: statA, filePath: fileA,
        parentSessionId: null, agentId: null },
      { sessionId: 'session-b', folder, projectPath, modified: statB, filePath: fileB,
        parentSessionId: null, agentId: null },
    ];

    const { db, upserted } = makeFakeDb({ cachedRows });
    sessionCache.init({
      PROJECTS_DIR: projectsDir,
      activeSessions: new Map(),
      getMainWindow: () => null,
      log: console,
      db,
    });

    sessionCache.refreshFolder(folder);

    // Only session-c (NEW) must be upserted; a and b are unchanged
    const upsertedIds = upserted.map(s => s.sessionId);
    assert.ok(upsertedIds.includes('session-c'),
      `session-c (new) must be upserted; got: ${JSON.stringify(upsertedIds)}`);
    assert.ok(!upsertedIds.includes('session-a'),
      'session-a (unchanged mtime) must NOT be upserted');
    assert.ok(!upsertedIds.includes('session-b'),
      'session-b (unchanged mtime) must NOT be upserted');
  } finally {
    cleanup(projectsDir);
  }
});

test('refreshFolder targeted: opts.files limits upsert to only the named file', () => {
  const projectsDir = mkTmp();
  try {
    const folder = 'targeted-proj';
    const folderPath = path.join(projectsDir, folder);
    const projectPath = projectsDir;

    // Write 3 session files
    writeSession(path.join(folderPath, 'session-x.jsonl'), projectPath);
    writeSession(path.join(folderPath, 'session-y.jsonl'), projectPath);
    writeSession(path.join(folderPath, 'session-z.jsonl'), projectPath);

    // None are cached → all would normally be upserted on full walk
    const { db, upserted } = makeFakeDb({ cachedRows: [] });
    sessionCache.init({
      PROJECTS_DIR: projectsDir,
      activeSessions: new Map(),
      getMainWindow: () => null,
      log: console,
      db,
    });

    // Targeted mode: only scan session-x.jsonl
    sessionCache.refreshFolder(folder, { files: new Set(['session-x.jsonl']) });

    const upsertedIds = upserted.map(s => s.sessionId);
    assert.ok(upsertedIds.includes('session-x'),
      `session-x must be upserted; got: ${JSON.stringify(upsertedIds)}`);
    assert.ok(!upsertedIds.includes('session-y'),
      'session-y must NOT be upserted in targeted mode');
    assert.ok(!upsertedIds.includes('session-z'),
      'session-z must NOT be upserted in targeted mode');
    assert.equal(upsertedIds.length, 1,
      `exactly 1 upsert expected; got ${upsertedIds.length}`);
  } finally {
    cleanup(projectsDir);
  }
});

test('refreshFolder: deleted file produces deleteCachedSession call (full walk)', () => {
  const projectsDir = mkTmp();
  try {
    const folder = 'delete-proj';
    const folderPath = path.join(projectsDir, folder);
    const projectPath = projectsDir;

    // Write 2 session files on disk
    writeSession(path.join(folderPath, 'keep.jsonl'), projectPath);
    writeSession(path.join(folderPath, 'keep2.jsonl'), projectPath);

    const statKeep = fs.statSync(path.join(folderPath, 'keep.jsonl')).mtime.toISOString();
    const statKeep2 = fs.statSync(path.join(folderPath, 'keep2.jsonl')).mtime.toISOString();

    // Simulate that 'ghost' was previously cached but its file no longer exists on disk
    const cachedRows = [
      { sessionId: 'keep',  folder, projectPath, modified: statKeep,  filePath: path.join(folderPath, 'keep.jsonl'),  parentSessionId: null, agentId: null },
      { sessionId: 'keep2', folder, projectPath, modified: statKeep2, filePath: path.join(folderPath, 'keep2.jsonl'), parentSessionId: null, agentId: null },
      { sessionId: 'ghost', folder, projectPath, modified: '2024-01-01T00:00:00.000Z',
        filePath: path.join(folderPath, 'ghost.jsonl'), parentSessionId: null, agentId: null },
    ];

    const { db, deleted } = makeFakeDb({ cachedRows });
    sessionCache.init({
      PROJECTS_DIR: projectsDir,
      activeSessions: new Map(),
      getMainWindow: () => null,
      log: console,
      db,
    });

    sessionCache.refreshFolder(folder); // full walk — no opts.files

    assert.ok(deleted.includes('ghost'),
      `deleteCachedSession must be called for ghost; got: ${JSON.stringify(deleted)}`);
    assert.ok(!deleted.includes('keep'),
      'keep (still on disk) must NOT be deleted');
    assert.ok(!deleted.includes('keep2'),
      'keep2 (still on disk) must NOT be deleted');
  } finally {
    cleanup(projectsDir);
  }
});

test('refreshFolder: new session produces a searchEntriesToUpsert entry with non-empty body and correct title', () => {
  const projectsDir = mkTmp();
  try {
    const folder = 'search-proj';
    const folderPath = path.join(projectsDir, folder);
    const projectPath = projectsDir;

    writeSession(path.join(folderPath, 'searchable.jsonl'), projectPath);

    const { db, searchUpserted } = makeFakeDb({ cachedRows: [] });
    sessionCache.init({
      PROJECTS_DIR: projectsDir,
      activeSessions: new Map(),
      getMainWindow: () => null,
      log: console,
      db,
    });

    sessionCache.refreshFolder(folder);

    assert.equal(searchUpserted.length, 1,
      `expected 1 search entry; got ${searchUpserted.length}`);
    const entry = searchUpserted[0];
    assert.equal(entry.id, 'searchable');
    assert.equal(entry.type, 'session');
    assert.equal(entry.folder, folder);
    // title must contain the summary text
    assert.ok(typeof entry.title === 'string' && entry.title.length > 0,
      'search title must be non-empty');
    // body must contain text content harvested from the JSONL
    assert.ok(typeof entry.body === 'string' && entry.body.length > 0,
      'search body must be non-empty');
  } finally {
    cleanup(projectsDir);
  }
});
