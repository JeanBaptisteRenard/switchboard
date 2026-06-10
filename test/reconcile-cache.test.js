const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sessionCache = require('../session-cache');
const { getFolderIndexMtimeMs } = require('../folder-index-state');

// Minimal valid transcript: a `cwd` line (for deriveProjectPath) and a user
// message (so readSessionFile yields a non-null session).
function writeSession(folderPath, cwd) {
  fs.mkdirSync(folderPath, { recursive: true });
  const line = JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: 'hello' } });
  fs.writeFileSync(path.join(folderPath, 'session.jsonl'), line + '\n', 'utf8');
}

// In-memory fake of the db layer init() expects.
// folderMetaCalls records every setFolderMeta(folder, projectPath, indexMtimeMs)
// invocation so tests can assert at the observable seam (which folders were
// stamped with a non-zero indexMtimeMs) rather than inspecting internal bookkeeping.
function makeFakeDb(metaMap) {
  const folderMetaCalls = [];
  const noop = () => {};
  return {
    folderMetaCalls,
    db: {
      deleteCachedFolder: noop,
      getCachedByFolder: () => [],
      upsertCachedSessions: noop,
      touchCachedModified: noop,
      deleteCachedSession: noop,
      replaceSessionMetrics: noop,
      deleteSearchFolder: noop,
      deleteSearchSession: noop,
      upsertSearchEntries: noop,
      setFolderMeta: (folder, projectPath, indexMtimeMs) => {
        metaMap.set(folder, { folder, projectPath, indexMtimeMs });
        folderMetaCalls.push({ folder, projectPath, indexMtimeMs });
      },
      getAllFolderMeta: () => metaMap,
      getAllMeta: () => new Map(),
      getAllCached: () => [],
      getSetting: () => ({}),
      getMeta: () => null,
      setName: noop,
    },
  };
}

test('reconcileCacheFromFilesystem indexes new and stale folders but skips up-to-date ones', () => {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-reconcile-'));
  try {
    writeSession(path.join(projectsDir, 'proj-new'), '/tmp/proj-new');       // never indexed (no meta)
    writeSession(path.join(projectsDir, 'proj-stale'), '/tmp/proj-stale');   // meta older than disk
    writeSession(path.join(projectsDir, 'proj-current'), '/tmp/proj-current'); // meta == disk

    const metaMap = new Map();
    metaMap.set('proj-stale', { folder: 'proj-stale', projectPath: '/tmp/proj-stale', indexMtimeMs: 0 });
    metaMap.set('proj-current', {
      folder: 'proj-current', projectPath: '/tmp/proj-current',
      indexMtimeMs: getFolderIndexMtimeMs(path.join(projectsDir, 'proj-current')),
    });

    const fake = makeFakeDb(metaMap);
    sessionCache.init({
      PROJECTS_DIR: projectsDir,
      activeSessions: new Map(),
      getMainWindow: () => null,
      log: console,
      db: fake.db,
    });

    sessionCache.reconcileCacheFromFilesystem();

    // Assert at the observable seam: setFolderMeta was called with a non-zero
    // indexMtimeMs for folders that were (re)indexed, and was NOT called for
    // the up-to-date folder. This survives refactors that restructure internal
    // bookkeeping (e.g. bulk upserts) as long as the folder-meta contract holds.
    const indexedFolders = fake.folderMetaCalls
      .filter(c => c.indexMtimeMs > 0)
      .map(c => c.folder);

    assert.ok(indexedFolders.includes('proj-new'), 'new folder should be stamped with non-zero indexMtimeMs');
    assert.ok(indexedFolders.includes('proj-stale'), 'stale folder should be re-stamped with non-zero indexMtimeMs');
    assert.ok(!indexedFolders.includes('proj-current'), 'up-to-date folder must not be re-indexed');
  } finally {
    fs.rmSync(projectsDir, { recursive: true, force: true });
  }
});
