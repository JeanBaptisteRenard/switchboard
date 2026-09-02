'use strict';

// Migration v8: the initial-scan completeness marker (settings key
// 'initial_scan_complete').
//
// The scan worker streams one DB write per folder, so a populated
// session_cache no longer proves the initial scan finished -- an interrupted
// scan leaves a partial cache that a row-count check cannot tell apart from a
// complete one. The marker is the authoritative signal: session-cache.js
// writes it on the worker's final successful done message, and get-projects
// treats "cache populated but marker absent" as an interrupted scan to resume
// in the background (never a warm start).
//
// Existing installs (<= v0.0.50) have a populated cache but no marker, because
// pre-marker builds wrote the whole scan in a single final-message batch --
// a populated cache from those builds can only mean a completed scan.
// Migration v8 must bless them, or every existing user would be thrown back
// into a full cold-start rescan on upgrade. A fresh (empty) DB must NOT get
// the marker: its first real scan earns it on completion.
//
// Same Electron-as-Node subprocess pattern as test/db-schema-reconcile.test.js
// (better-sqlite3 is compiled for Electron's ABI; db.js opens its database at
// require() time, so each scenario loads it in a fresh child process).

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

function inspectMarker(dataDir) {
  const r = runInElectronNode(`
    const Database = require('better-sqlite3');
    const db = new Database(require('path').join(process.env.SWITCHBOARD_DATA_DIR, 'switchboard.db'), { readonly: true });
    console.log(JSON.stringify({
      marker: db.prepare("SELECT value FROM settings WHERE key = 'initial_scan_complete'").get()?.value ?? null,
      version: db.prepare("SELECT value FROM settings WHERE key = 'db_version'").get()?.value,
      cacheCount: db.prepare('SELECT COUNT(*) AS n FROM session_cache').get().n,
    }));
  `, dataDir);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

test('fresh empty database does NOT get the completeness marker', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-marker-fresh-'));
  try {
    const r = loadDbModule(dir);
    assert.equal(r.status, 0, r.stderr);

    const state = inspectMarker(dir);
    assert.equal(state.marker, null,
      'an empty cache means no scan ever completed -- the marker must be earned by the first successful scan, ' +
      'otherwise an interrupted first scan would be blessed as complete on relaunch');
    assert.equal(state.version, '9');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pre-marker install (populated cache, db_version 7) gets the marker backfilled on upgrade', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-marker-upgrade-'));
  try {
    // Build a realistic v0.0.50-era DB: let db.js create the full current
    // schema, then rewind db_version to 7, drop the marker migration v8 just
    // wrote (there is none: the cache is empty, but delete defensively), and
    // seed a cached session -- the state a completed pre-marker scan leaves.
    const init = loadDbModule(dir);
    assert.equal(init.status, 0, init.stderr);
    const seed = runInElectronNode(`
      const Database = require('better-sqlite3');
      const db = new Database(require('path').join(process.env.SWITCHBOARD_DATA_DIR, 'switchboard.db'));
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('db_version', '7')").run();
      db.prepare("DELETE FROM settings WHERE key = 'initial_scan_complete'").run();
      db.prepare("INSERT INTO session_cache (sessionId, folder, modified) VALUES ('s1', 'f1', '2026-01-01T00:00:00Z')").run();
      db.prepare("INSERT INTO cache_meta (folder, projectPath, indexMtimeMs) VALUES ('f1', '/tmp/p1', 123)").run();
    `, dir);
    assert.equal(seed.status, 0, seed.stderr);

    const r = loadDbModule(dir);
    assert.equal(r.status, 0, r.stderr);

    const state = inspectMarker(dir);
    assert.equal(state.marker, 'true',
      'a populated pre-marker cache can only come from a completed batch-write scan -- ' +
      'migration v8 must bless it or every existing install would re-run the full cold-start scan');
    assert.equal(state.version, '9');
    assert.equal(state.cacheCount, 1, 'the existing cache rows are preserved, not rescanned');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the backfill runs once: a partial cache after an interrupted post-marker scan is NOT re-blessed on relaunch', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-marker-partial-'));
  try {
    // First load: fresh DB, migrations run to completion (db_version 9), no
    // marker (empty cache). Now simulate an interrupted first scan: some rows
    // land in session_cache, the marker is never written.
    const init = loadDbModule(dir);
    assert.equal(init.status, 0, init.stderr);
    const seed = runInElectronNode(`
      const Database = require('better-sqlite3');
      const db = new Database(require('path').join(process.env.SWITCHBOARD_DATA_DIR, 'switchboard.db'));
      db.prepare("INSERT INTO session_cache (sessionId, folder, modified) VALUES ('s1', 'f1', '2026-01-01T00:00:00Z')").run();
    `, dir);
    assert.equal(seed.status, 0, seed.stderr);

    // Relaunch: db_version is already 9, so no migration runs again -- the v8
    // marker backfill included.
    // If it did, the partial cache would be blessed as complete and the next
    // get-projects would take the warm branch straight into the synchronous
    // reconcile sweep -- the freeze the marker exists to prevent.
    const r = loadDbModule(dir);
    assert.equal(r.status, 0, r.stderr);

    const state = inspectMarker(dir);
    assert.equal(state.marker, null,
      'a partial cache without the marker must stay unmarked across relaunches until a scan actually completes');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
