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
      // The CLI also writes the envelope the other way round (/pre-compact),
      // and a command's own output back as a user record.
      ins.run('phantom-msg', 'f1', '/tmp/p1', '<command-message>pre-compact</command-message>\\n<command-name>/pre-compact</command-name>', '2026-01-01T01:00:00Z');
      ins.run('phantom-out', 'f1', '/tmp/p1', '<local-command-stdout>Set model to Sonnet 5</local-command-stdout>', '2026-01-01T02:00:00Z');
      ins.run('real', 'f1', '/tmp/p1', 'fix the watcher', '2026-01-02T00:00:00Z');
      ins.run('other-folder', 'f2', '/tmp/p2', 'unrelated work', '2026-01-03T00:00:00Z');
      db.prepare('INSERT INTO cache_meta (folder, projectPath, indexMtimeMs) VALUES (?, ?, ?)').run('f1', '/tmp/p1', 123);
      db.prepare('INSERT INTO cache_meta (folder, projectPath, indexMtimeMs) VALUES (?, ?, ?)').run('f2', '/tmp/p2', 456);
      // Mirror upsertSearchEntries: map row first, then the content column
      // store, then the fts5 shadow row, all sharing the same rowid.
      const insMap = db.prepare('INSERT INTO search_map (rowid, id, type, folder) VALUES (?, ?, ?, ?)');
      const insContent = db.prepare('INSERT INTO search_content (rowid, title, body) VALUES (?, ?, ?)');
      const insFts = db.prepare('INSERT INTO search_fts (rowid, title, body) VALUES (?, ?, ?)');
      const insMetrics = db.prepare('INSERT INTO session_metrics (sessionId, date, model, messageCount) VALUES (?, ?, ?, ?)');
      let rowid = 0;
      for (const id of ['phantom', 'phantom-msg', 'phantom-out', 'real']) {
        rowid++;
        insMap.run(rowid, id, 'session', 'f1');
        insContent.run(rowid, id, 'body');
        insFts.run(rowid, id, 'body');
        insMetrics.run(id, '2026-01-01', 'sonnet', 2);
      }
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
        searchIds: db.prepare("SELECT id FROM search_map WHERE type = 'session' ORDER BY id").all().map(r => r.id),
        searchContent: db.prepare('SELECT COUNT(*) AS n FROM search_content').get().n,
        metricIds: db.prepare('SELECT sessionId FROM session_metrics ORDER BY sessionId').all().map(r => r.sessionId),
        version: db.prepare("SELECT value FROM settings WHERE key = 'db_version'").get()?.value,
      }));
    `, dir);
    assert.equal(inspect.status, 0, inspect.stderr);
    const state = JSON.parse(inspect.stdout.trim().split('\n').pop());

    assert.deepEqual(state.ids, ['other-folder', 'real'],
      'every bookkeeping summary is dropped, whichever envelope tag opens it; real rows stay');
    assert.deepEqual(state.folders, ['f2'],
      'the affected folder loses its index gate so reconcile re-reads the purged file; untouched folders keep theirs');
    assert.deepEqual(state.searchIds, ['real'], 'the purged rows leave no stale search entry behind');
    assert.equal(state.searchContent, 1);
    assert.deepEqual(state.metricIds, ['real'],
      'a phantom sits on a file that is never re-read, so its metrics would inflate the daily counts and totals forever');
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

// The migration runner has no transaction of its own and better-sqlite3
// autocommits every statement, so an interruption between the session_cache
// deletes and the search-table purge used to be permanent: the relaunch is
// already at db_version 9 and its SELECT no longer matches the rows it dropped,
// leaving their search entries orphaned for good. The trigger below stands in
// for that interruption -- it aborts the purge midway through the loop.
test('migration v9 leaves no orphaned search entry when the purge is interrupted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-cmd-purge-atomic-'));
  try {
    const init = loadDbModule(dir);
    assert.equal(init.status, 0, init.stderr);

    const seed = runInElectronNode(`
      const Database = require('better-sqlite3');
      const db = new Database(require('path').join(process.env.SWITCHBOARD_DATA_DIR, 'switchboard.db'));
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('db_version', '8')").run();
      const ins = db.prepare('INSERT INTO session_cache (sessionId, folder, projectPath, summary, modified) VALUES (?, ?, ?, ?, ?)');
      const insMap = db.prepare('INSERT INTO search_map (rowid, id, type, folder) VALUES (?, ?, ?, ?)');
      const insContent = db.prepare('INSERT INTO search_content (rowid, title, body) VALUES (?, ?, ?)');
      const insFts = db.prepare('INSERT INTO search_fts (rowid, title, body) VALUES (?, ?, ?)');
      let rowid = 0;
      for (const [id, folder] of [['p1', 'f1'], ['p2', 'f2']]) {
        ins.run(id, folder, '/tmp/' + folder, '<command-name>/clear</command-name>', '2026-01-01T00:00:00Z');
        db.prepare('INSERT INTO cache_meta (folder, projectPath, indexMtimeMs) VALUES (?, ?, ?)').run(folder, '/tmp/' + folder, 1);
        rowid++;
        insMap.run(rowid, id, 'session', folder);
        insContent.run(rowid, id, 'body');
        insFts.run(rowid, id, 'body');
      }
      db.exec("CREATE TRIGGER purge_interrupted BEFORE DELETE ON cache_meta WHEN OLD.folder = 'f2' BEGIN SELECT RAISE(ABORT, 'interrupted'); END");
    `, dir);
    assert.equal(seed.status, 0, seed.stderr);

    const r = loadDbModule(dir);
    assert.equal(r.status, 0, r.stderr);

    const inspect = runInElectronNode(`
      const Database = require('better-sqlite3');
      const db = new Database(require('path').join(process.env.SWITCHBOARD_DATA_DIR, 'switchboard.db'), { readonly: true });
      console.log(JSON.stringify({
        orphans: db.prepare(\`SELECT m.id FROM search_map m
          WHERE m.type = 'session'
            AND NOT EXISTS (SELECT 1 FROM session_cache c WHERE c.sessionId = m.id)\`).all().map(r => r.id),
      }));
    `, dir);
    assert.equal(inspect.status, 0, inspect.stderr);
    const state = JSON.parse(inspect.stdout.trim().split('\n').pop());

    assert.deepEqual(state.orphans, [],
      'an interrupted purge must roll back whole: a row dropped from session_cache without its search entry is unreachable and never retried');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
