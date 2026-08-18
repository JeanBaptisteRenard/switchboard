'use strict';

// Cold-start indexing UX fix.
//
// populateCacheViaWorker() used to accumulate every folder's parsed sessions
// in the worker and write them ALL to the DB in one shot only after the
// worker's single final message — meaning a large ~/.claude/projects/ history
// left the sidebar with nothing at all for the whole scan (witnessed live:
// user force-quit believing the app had hung). It now writes each folder to
// the DB as its message streams in (workers/scan-projects.js), and only
// emits the new indexing-progress event on a genuine first run (empty
// session_cache at call time) so warm-start rebuilds never show a banner.
//
// Spins the REAL worker (workers/scan-projects.js has no native deps) against
// a temp PROJECTS_DIR with real fixture .jsonl files — same pattern as
// test/reconcile-cache.test.js (main-thread refreshFolder) and
// test/search-worker-db-failure.test.js (a different real worker).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sessionCache = require('../session-cache');

function writeSession(folderPath, cwd) {
  fs.mkdirSync(folderPath, { recursive: true });
  const line = JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: 'hello' } });
  fs.writeFileSync(path.join(folderPath, 'session.jsonl'), line + '\n', 'utf8');
}

function makeFakeDb({ isCachePopulated }) {
  const calls = { upsertCachedSessions: [], setFolderMeta: [], deleteCachedFolder: [] };
  const sentEvents = [];
  return {
    calls,
    sentEvents,
    isCachePopulated: () => isCachePopulated,
    deleteCachedFolder: (folder) => calls.deleteCachedFolder.push(folder),
    getCachedByFolder: () => [],
    upsertCachedSessions: (rows) => calls.upsertCachedSessions.push(rows),
    touchCachedModified: () => {},
    deleteCachedSession: () => {},
    replaceSessionMetrics: () => {},
    deleteSearchFolder: () => {},
    deleteSearchSession: () => {},
    upsertSearchEntries: () => {},
    setFolderMeta: (folder, projectPath, indexMtimeMs) => calls.setFolderMeta.push({ folder, projectPath, indexMtimeMs }),
    getAllFolderMeta: () => new Map(),
    getAllMeta: () => new Map(),
    getAllCached: () => [],
    getSetting: () => ({}),
    getMeta: () => null,
    setName: () => {},
  };
}

function initCache(projectsDir, db) {
  const sentEvents = db.sentEvents;
  sessionCache.init({
    PROJECTS_DIR: projectsDir,
    activeSessions: new Map(),
    getMainWindow: () => ({
      isDestroyed: () => false,
      webContents: { send: (...args) => sentEvents.push(args) },
    }),
    log: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
    db,
  });
}

test('populateCacheViaWorker writes each folder to the DB as it streams in (not batched at the end)', async () => {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-cold-'));
  try {
    writeSession(path.join(projectsDir, 'proj-a'), '/tmp/proj-a');
    writeSession(path.join(projectsDir, 'proj-b'), '/tmp/proj-b');
    writeSession(path.join(projectsDir, 'proj-c'), '/tmp/proj-c');

    const db = makeFakeDb({ isCachePopulated: false });
    initCache(projectsDir, db);

    await sessionCache.populateCacheViaWorker();

    assert.equal(db.calls.upsertCachedSessions.length, 3,
      'one upsertCachedSessions call per folder, proving progressive per-folder writes rather than one final batch');
    assert.equal(db.calls.setFolderMeta.length, 3);
  } finally {
    fs.rmSync(projectsDir, { recursive: true, force: true });
  }
});

test('cold start (empty cache) emits indexing-progress events ending in done:true, with increasing counters', async () => {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-cold-2-'));
  try {
    writeSession(path.join(projectsDir, 'proj-a'), '/tmp/proj-a');
    writeSession(path.join(projectsDir, 'proj-b'), '/tmp/proj-b');

    const db = makeFakeDb({ isCachePopulated: false });
    initCache(projectsDir, db);

    await sessionCache.populateCacheViaWorker();

    const progressEvents = db.sentEvents
      .filter(([channel]) => channel === 'indexing-progress')
      .map(([, payload]) => payload);

    assert.ok(progressEvents.length >= 2, 'expected at least one progress event per folder plus a final done event');
    for (const p of progressEvents) {
      assert.equal(p.coldStart, true);
      assert.equal(p.total, 2);
    }
    const last = progressEvents[progressEvents.length - 1];
    assert.equal(last.done, true, 'the final indexing-progress event must report done:true');
    assert.equal(last.sessionsSoFar, 2, 'both sessions must be counted by the time indexing finishes');

    // current/sessionsSoFar must never regress across the stream.
    let prevCurrent = 0, prevSessions = 0;
    for (const p of progressEvents) {
      assert.ok(p.current >= prevCurrent, 'current must be monotonically non-decreasing');
      assert.ok(p.sessionsSoFar >= prevSessions, 'sessionsSoFar must be monotonically non-decreasing');
      prevCurrent = p.current;
      prevSessions = p.sessionsSoFar;
    }
  } finally {
    fs.rmSync(projectsDir, { recursive: true, force: true });
  }
});

test('warm start (cache already populated) never emits indexing-progress', async () => {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-warm-'));
  try {
    writeSession(path.join(projectsDir, 'proj-a'), '/tmp/proj-a');

    const db = makeFakeDb({ isCachePopulated: true });
    initCache(projectsDir, db);

    await sessionCache.populateCacheViaWorker();

    const progressEvents = db.sentEvents.filter(([channel]) => channel === 'indexing-progress');
    assert.equal(progressEvents.length, 0, 'a warm-start rebuild must never trigger the first-run banner');

    // The existing small-status-bar mechanism is untouched by this change.
    const statusEvents = db.sentEvents.filter(([channel]) => channel === 'status-update');
    assert.ok(statusEvents.length > 0, 'status-update should still fire for the small activity indicator');
  } finally {
    fs.rmSync(projectsDir, { recursive: true, force: true });
  }
});
