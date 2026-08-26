const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_DIR = path.join(__dirname, '..');
// better-sqlite3 is compiled for Electron's ABI — run every DB snippet under
// Electron-as-Node, same as the other db.js tests.
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

// Migration v9 purges the rows a pre-fix parser summarised from the
// slash-command records /clear writes into the transcript it opens. Those rows
// cannot heal on their own: the phantom ones sit on a file that never changes
// again (so the watcher never revisits it), and the real ones keep the bad
// title because the header-only refresh path only overwrites a summary it can
// re-derive.
test('migration v9 purges slash-command summaries and re-opens their folder for re-indexing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-cmd-purge-'));
  try {
    const init = loadDbModule(dir);
    assert.equal(init.status, 0, init.stderr);

    const seed = runInElectronNode(`
      const Database = require('better-sqlite3');
      const db = new Database(require('path').join(process.env.SWITCHBOARD_DATA_DIR, 'switchboard.db'));
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('db_version', '8')").run();
      const ins = db.prepare('INSERT INTO session_cache (sessionId, folder, projectPath, summary, modified) VALUES (?, ?, ?, ?, ?)');
      ins.run('phantom', 'f1', '/tmp/p1', '<command-name>/clear</command-name>\\n<command-message>clear</command-message>', '2026-01-01T00:00:00Z');
      ins.run('real', 'f1', '/tmp/p1', 'fix the watcher', '2026-01-02T00:00:00Z');
      ins.run('other-folder', 'f2', '/tmp/p2', 'unrelated work', '2026-01-03T00:00:00Z');
      db.prepare('INSERT INTO cache_meta (folder, projectPath, indexMtimeMs) VALUES (?, ?, ?)').run('f1', '/tmp/p1', 123);
      db.prepare('INSERT INTO cache_meta (folder, projectPath, indexMtimeMs) VALUES (?, ?, ?)').run('f2', '/tmp/p2', 456);
      // Mirror upsertSearchEntries: map row first, then the content column
      // store, then the fts5 shadow row, all sharing the same rowid.
      db.prepare('INSERT INTO search_map (rowid, id, type, folder) VALUES (1, ?, ?, ?)').run('phantom', 'session', 'f1');
      db.prepare('INSERT INTO search_content (rowid, title, body) VALUES (1, ?, ?)').run('<command-name>/clear</command-name>', 'body');
      db.prepare('INSERT INTO search_fts (rowid, title, body) VALUES (1, ?, ?)').run('<command-name>/clear</command-name>', 'body');
    `, dir);
    assert.equal(seed.status, 0, seed.stderr);

    const r = loadDbModule(dir);
    assert.equal(r.status, 0, r.stderr);

    const inspect = runInElectronNode(`
      const Database = require('better-sqlite3');
      const db = new Database(require('path').join(process.env.SWITCHBOARD_DATA_DIR, 'switchboard.db'), { readonly: true });
      console.log(JSON.stringify({
        ids: db.prepare('SELECT sessionId FROM session_cache ORDER BY sessionId').all().map(r => r.sessionId),
        folders: db.prepare('SELECT folder FROM cache_meta ORDER BY folder').all().map(r => r.folder),
        searchIds: db.prepare("SELECT id FROM search_map WHERE type = 'session'").all().map(r => r.id),
        searchContent: db.prepare('SELECT COUNT(*) AS n FROM search_content').get().n,
        version: db.prepare("SELECT value FROM settings WHERE key = 'db_version'").get()?.value,
      }));
    `, dir);
    assert.equal(inspect.status, 0, inspect.stderr);
    const state = JSON.parse(inspect.stdout.trim().split('\n').pop());

    assert.deepEqual(state.ids, ['other-folder', 'real'], 'only the command-summary row is dropped');
    assert.deepEqual(state.folders, ['f2'],
      'the affected folder loses its index gate so reconcile re-reads the purged file; untouched folders keep theirs');
    assert.deepEqual(state.searchIds, [], 'the purged row leaves no stale search entry behind');
    assert.equal(state.searchContent, 0);
    assert.equal(state.version, '9');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('migration v9 is a no-op on a database with no command summaries', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-cmd-purge-noop-'));
  try {
    const init = loadDbModule(dir);
    assert.equal(init.status, 0, init.stderr);

    const seed = runInElectronNode(`
      const Database = require('better-sqlite3');
      const db = new Database(require('path').join(process.env.SWITCHBOARD_DATA_DIR, 'switchboard.db'));
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('db_version', '8')").run();
      db.prepare('INSERT INTO session_cache (sessionId, folder, summary, modified) VALUES (?, ?, ?, ?)')
        .run('s1', 'f1', 'real work', '2026-01-01T00:00:00Z');
      db.prepare('INSERT INTO cache_meta (folder, projectPath, indexMtimeMs) VALUES (?, ?, ?)').run('f1', '/tmp/p1', 123);
    `, dir);
    assert.equal(seed.status, 0, seed.stderr);

    const r = loadDbModule(dir);
    assert.equal(r.status, 0, r.stderr);

    const inspect = runInElectronNode(`
      const Database = require('better-sqlite3');
      const db = new Database(require('path').join(process.env.SWITCHBOARD_DATA_DIR, 'switchboard.db'), { readonly: true });
      console.log(JSON.stringify({
        cacheCount: db.prepare('SELECT COUNT(*) AS n FROM session_cache').get().n,
        metaCount: db.prepare('SELECT COUNT(*) AS n FROM cache_meta').get().n,
      }));
    `, dir);
    assert.equal(inspect.status, 0, inspect.stderr);
    const state = JSON.parse(inspect.stdout.trim().split('\n').pop());
    assert.equal(state.cacheCount, 1, 'no re-index forced on installs that never hit the bug');
    assert.equal(state.metaCount, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
