/**
 * session_cache.bridgeSessionId (issue #197 -- see .ai/contexts/session-cache.md).
 * Added via the schema-reconciliation pass (not a numbered migration): that
 * pass is version-independent, so it also covers a DB migrated past ours by
 * a parallel branch that never shipped this column. Existing databases
 * already carry the duplicated rows the bug produced; the reconciliation's
 * cache wipe is what repairs them, by forcing every folder through the
 * now-deduping indexer on the next scan.
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

test('fresh database gets the bridgeSessionId column', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-bridge-fresh-'));
  try {
    const r = loadDbModule(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(inspectDb(dir).cols.includes('bridgeSessionId'));
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
      // Simulate the pre-fix schema (no bridgeSessionId column) with the bug's
      // exact symptom already present: parent and mirror indexed as two rows.
      db.exec('ALTER TABLE session_cache DROP COLUMN bridgeSessionId');
      const ins = db.prepare('INSERT INTO session_cache (sessionId, folder, projectPath, summary, modified) VALUES (?, ?, ?, ?, ?)');
      ins.run('e4b389ac', 'f1', '/tmp/p1', 'New project', '2026-09-06T18:13:27.000Z');
      ins.run('1b1def07', 'f1', '/tmp/p1', 'New project', '2026-09-06T18:13:34.000Z');
      db.prepare('INSERT INTO cache_meta (folder, projectPath, indexMtimeMs) VALUES (?, ?, ?)').run('f1', '/tmp/p1', 123);
    `, dir);
    assert.equal(seed.status, 0, seed.stderr);

    const r = loadDbModule(dir);
    assert.equal(r.status, 0, r.stderr);

    const state = inspectDb(dir);
    assert.ok(state.cols.includes('bridgeSessionId'), 'column added');
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
    assert.equal(state.cacheCount, 0, 'stale cache cleared for re-index');
    assert.equal(state.metaCount, 0, 'folder index gate cleared for re-index');
    assert.ok(state.cols.includes('futureColumn'), 'foreign column preserved');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
