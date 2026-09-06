/**
 * session_cache.bridgeSessionId and .mergedIntoSessionId (issue #197 -- see
 * .ai/contexts/session-cache.md). Added via the schema-reconciliation pass
 * (not a numbered migration): that pass is version-independent, so it also
 * covers a DB migrated past ours by a parallel branch that never shipped
 * these columns. Existing databases already carry the duplicated rows the
 * bug produced; the reconciliation's cache wipe is what repairs them, by
 * forcing every folder through the now-merging indexer on the next scan.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_DIR = path.join(__dirname, '..');
const electronBin = require('electron');

function runInElectronNode(code, dataDir) {
  return spawnSync(electronBin, ['-e', code], {
    cwd: APP_DIR,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SWITCHBOARD_DATA_DIR: dataDir },
    encoding: 'utf8',
  });
}

function loadDbModule(dataDir) {
  return runInElectronNode(`require(${JSON.stringify(path.join(APP_DIR, 'db.js'))})`, dataDir);
}

function inspectDb(dataDir) {
  const r = runInElectronNode(`
    const Database = require('better-sqlite3');
    const db = new Database(require('path').join(process.env.SWITCHBOARD_DATA_DIR, 'switchboard.db'), { readonly: true });
    console.log(JSON.stringify({
      cols: db.prepare('PRAGMA table_info(session_cache)').all().map(c => c.name),
      cacheCount: db.prepare('SELECT COUNT(*) AS n FROM session_cache').get().n,
      metaCount: db.prepare('SELECT COUNT(*) AS n FROM cache_meta').get().n,
    }));
  `, dataDir);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

test('fresh database gets the bridgeSessionId and mergedIntoSessionId columns', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-bridge-fresh-'));
  try {
    const r = loadDbModule(dir);
    assert.equal(r.status, 0, r.stderr);
    const cols = inspectDb(dir).cols;
    assert.ok(cols.includes('bridgeSessionId'));
    assert.ok(cols.includes('mergedIntoSessionId'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an existing database with already-duplicated mirror rows is wiped for re-index once bridgeSessionId is added', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-bridge-upgrade-'));
  try {
    const init = loadDbModule(dir);
    assert.equal(init.status, 0, init.stderr);

    const seed = runInElectronNode(`
      const Database = require('better-sqlite3');
      const db = new Database(require('path').join(process.env.SWITCHBOARD_DATA_DIR, 'switchboard.db'));
      // Simulate the pre-fix schema (neither column) with the bug's exact
      // symptom already present: parent and mirror indexed as two rows.
      db.exec('ALTER TABLE session_cache DROP COLUMN bridgeSessionId');
      db.exec('ALTER TABLE session_cache DROP COLUMN mergedIntoSessionId');
      const ins = db.prepare('INSERT INTO session_cache (sessionId, folder, projectPath, summary, modified) VALUES (?, ?, ?, ?, ?)');
      ins.run('e4b389ac', 'f1', '/tmp/p1', 'New project', '2026-09-06T18:13:27.000Z');
      ins.run('1b1def07', 'f1', '/tmp/p1', 'New project', '2026-09-06T18:13:34.000Z');
      db.prepare('INSERT INTO cache_meta (folder, projectPath, indexMtimeMs) VALUES (?, ?, ?)').run('f1', '/tmp/p1', 123);
    `, dir);
    assert.equal(seed.status, 0, seed.stderr);

    const r = loadDbModule(dir);
    assert.equal(r.status, 0, r.stderr);

    const state = inspectDb(dir);
    assert.ok(state.cols.includes('bridgeSessionId'), 'bridgeSessionId column added');
    assert.ok(state.cols.includes('mergedIntoSessionId'), 'mergedIntoSessionId column added');
    assert.equal(state.cacheCount, 0, 'stale duplicated rows cleared -- repaired by re-index, not patched in place');
    assert.equal(state.metaCount, 0, 'folder index gate cleared so the next scan actually re-reads f1');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Same class of regression as db-schema-reconcile.test.js's "foreign
// higher-version" case: a DB already migrated past our latest numbered
// migration by a parallel branch that never shipped this column must still
// get it via the schema-reconciliation pass, not crash at prepare().
test('foreign higher-version database without bridgeSessionId is reconciled, not crashed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-bridge-foreign-'));
  try {
    const seed = runInElectronNode(`
      const Database = require('better-sqlite3');
      const db = new Database(require('path').join(process.env.SWITCHBOARD_DATA_DIR, 'switchboard.db'));
      db.exec(\`CREATE TABLE session_cache (
        sessionId TEXT PRIMARY KEY, folder TEXT NOT NULL, projectPath TEXT,
        summary TEXT, firstPrompt TEXT, created TEXT, modified TEXT,
        messageCount INTEGER DEFAULT 0, slug TEXT, aiTitle TEXT,
        parentSessionId TEXT, agentId TEXT, subagentType TEXT,
        description TEXT, fileMtime TEXT, futureColumn TEXT
      )\`);
      db.exec('CREATE TABLE cache_meta (folder TEXT PRIMARY KEY, projectPath TEXT, indexMtimeMs REAL)');
      db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
      db.prepare("INSERT INTO settings (key, value) VALUES ('db_version', '20')").run();
      db.prepare("INSERT INTO session_cache (sessionId, folder, modified) VALUES ('s1', 'f1', '2026-01-01T00:00:00Z')").run();
      db.prepare("INSERT INTO cache_meta (folder, indexMtimeMs) VALUES ('f1', 123)").run();
    `, dir);
    assert.equal(seed.status, 0, seed.stderr);

    const r = loadDbModule(dir);
    assert.equal(r.status, 0, r.stderr);

    const state = inspectDb(dir);
    assert.ok(state.cols.includes('bridgeSessionId'), 'bridgeSessionId column added despite the higher foreign version');
    assert.ok(state.cols.includes('mergedIntoSessionId'), 'mergedIntoSessionId column added despite the higher foreign version');
    assert.equal(state.cacheCount, 0, 'stale cache cleared for re-index');
    assert.equal(state.metaCount, 0, 'folder index gate cleared for re-index');
    assert.ok(state.cols.includes('futureColumn'), 'foreign column preserved');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Real SQL, not the pure-JS mirror in db-session-metrics.test.js: a
// compaction mirror row (mergedIntoSessionId set) must not inflate
// getTotalCounts().totalSessions -- it is the same session as the row it
// merged into, not a second one.
test('getTotalCounts excludes a compaction mirror row from totalSessions but still sums its metrics', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-bridge-totals-'));
  try {
    const init = loadDbModule(dir);
    assert.equal(init.status, 0, init.stderr);

    const seed = runInElectronNode(`
      const Database = require('better-sqlite3');
      const db = new Database(require('path').join(process.env.SWITCHBOARD_DATA_DIR, 'switchboard.db'));
      const ins = db.prepare('INSERT INTO session_cache (sessionId, folder, projectPath, summary, modified, mergedIntoSessionId) VALUES (?, ?, ?, ?, ?, ?)');
      ins.run('parent', 'f1', '/tmp/p1', 'New project', '2026-09-03T21:16:00.000Z', null);
      ins.run('mirror', 'f1', '/tmp/p1', 'New project', '2026-09-05T22:15:05.000Z', 'parent');
      ins.run('independent', 'f1', '/tmp/p1', 'unrelated work', '2026-09-06T18:03:00.000Z', null);
      const insMetrics = db.prepare('INSERT INTO session_metrics (sessionId, date, model, messageCount, toolCallCount, inputTokens, outputTokens) VALUES (?, ?, ?, ?, ?, ?, ?)');
      insMetrics.run('parent', '2026-09-03', 'claude-sonnet-4-6', 2, 0, 100, 50);
      insMetrics.run('mirror', '2026-09-05', 'claude-sonnet-4-6', 1, 0, 9, 4);
      insMetrics.run('independent', '2026-09-06', 'claude-sonnet-4-6', 1, 0, 7, 3);
    `, dir);
    assert.equal(seed.status, 0, seed.stderr);

    const inspect = runInElectronNode(`
      const db = require(${JSON.stringify(path.join(APP_DIR, 'db.js'))});
      console.log(JSON.stringify(db.getTotalCounts()));
    `, dir);
    assert.equal(inspect.status, 0, inspect.stderr);
    const totals = JSON.parse(inspect.stdout.trim().split('\n').pop());

    assert.equal(totals.totalSessions, 2, 'parent + independent -- the mirror is not a third session');
    assert.equal(totals.totalMessages, 4, '2 + 1 + 1, both files\' non-overlapping messages counted');
    assert.equal(totals.totalTokens, 173, '150 + 13 + 10, both files\' non-overlapping tokens summed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
