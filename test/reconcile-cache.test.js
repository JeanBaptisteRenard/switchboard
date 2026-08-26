const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sessionCache = require('../session-cache');
const { getFolderIndexMtimeMs } = require('../folder-index-state');

// Minimal valid session transcript: one line carries `cwd` (for deriveProjectPath)
// and a user message (so readSessionFile yields a non-null session).
function writeSession(folderPath, cwd) {
  fs.mkdirSync(folderPath, { recursive: true });
  const line = JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: 'hello' } });
  fs.writeFileSync(path.join(folderPath, 'session.jsonl'), line + '\n', 'utf8');
}

// In-memory fake of the db layer that init() expects, recording which folders
// actually got (re)indexed (i.e. had refreshFolder do work and upsert sessions).
function makeFakeDb(metaMap) {
  const indexedFolders = new Set();
  return {
    indexedFolders,
    db: {
      deleteCachedFolder() {},
      getCachedByFolder() { return []; },
      upsertCachedSessions(sessions) { for (const s of sessions) indexedFolders.add(s.folder); },
      deleteCachedSession() {},
      deleteSearchFolder() {},
      deleteSearchSession() {},
      upsertSearchEntries() {},
      setFolderMeta(folder, projectPath, indexMtimeMs) { metaMap.set(folder, { folder, projectPath, indexMtimeMs }); },
      getAllFolderMeta() { return metaMap; },
      getAllMeta() { return new Map(); },
      getAllCached() { return []; },
      getSetting() { return {}; },
      getMeta() { return null; },
      setName() {},
    },
  };
}

test('reconcileCacheFromFilesystem indexes new and stale folders but skips up-to-date ones', () => {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-reconcile-'));
  try {
    // never-indexed (no meta), stale (meta older than disk), and up-to-date folders
    writeSession(path.join(projectsDir, 'proj-new'), '/tmp/proj-new');
    writeSession(path.join(projectsDir, 'proj-stale'), '/tmp/proj-stale');
    writeSession(path.join(projectsDir, 'proj-current'), '/tmp/proj-current');

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

    assert.ok(fake.indexedFolders.has('proj-new'), 'new folder should be indexed');
    assert.ok(fake.indexedFolders.has('proj-stale'), 'stale folder (older indexMtimeMs) should be re-indexed');
    assert.ok(!fake.indexedFolders.has('proj-current'), 'up-to-date folder should be skipped');
  } finally {
    fs.rmSync(projectsDir, { recursive: true, force: true });
  }
});

// --- codex folders ---

const ROLLOUT = 'rollout-2026-08-26T11-55-02-01a03f6c-fdf9-7c83-86e3-c388f81d765c.jsonl';

function writeRollout(dayDir, cwd) {
  fs.mkdirSync(dayDir, { recursive: true });
  const lines = [
    { timestamp: '2026-08-26T10:00:00Z', type: 'session_meta', payload: { session_id: 'root', cwd } },
    { timestamp: '2026-08-26T10:00:01Z', type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }] } },
  ];
  fs.writeFileSync(path.join(dayDir, ROLLOUT), lines.map(l => JSON.stringify(l)).join('\n') + '\n', 'utf8');
}

// A codex date folder holds sessions from many projects, so it has no
// folder-level project path. refreshFolder used to bail on exactly that
// condition, which would have skipped every codex folder silently.
test('reconcile indexes codex date folders even though they have no folder project', () => {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-claude-'));
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-codex-'));
  const prevHome = process.env.CODEX_HOME;
  try {
    process.env.CODEX_HOME = codexHome;
    writeRollout(path.join(codexHome, 'sessions', '2026', '08', '26'), '/tmp/some-project');

    const metaMap = new Map();
    const fake = makeFakeDb(metaMap);
    sessionCache.init({
      PROJECTS_DIR: projectsDir, activeSessions: new Map(),
      getMainWindow: () => null, log: console, db: fake.db,
    });

    sessionCache.reconcileCacheFromFilesystem();
    assert.ok(fake.indexedFolders.has('codex/2026/08/26'), 'codex folder should be indexed');
    // cache_meta records a null project for it — many projects share the folder.
    assert.equal(metaMap.get('codex/2026/08/26').projectPath, null);

    // Second pass: unchanged on disk, so the mtime gate must skip it. Without
    // this the date folders would be fully re-read on every get-projects call.
    const second = makeFakeDb(metaMap);
    sessionCache.init({
      PROJECTS_DIR: projectsDir, activeSessions: new Map(),
      getMainWindow: () => null, log: console, db: second.db,
    });
    sessionCache.reconcileCacheFromFilesystem();
    assert.equal(second.indexedFolders.size, 0, 'up-to-date codex folder should be skipped');
  } finally {
    if (prevHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prevHome;
    fs.rmSync(projectsDir, { recursive: true, force: true });
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test('a codex home that does not exist contributes nothing and does not throw', () => {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-nocodex-'));
  const prevHome = process.env.CODEX_HOME;
  try {
    process.env.CODEX_HOME = path.join(os.tmpdir(), 'switchboard-definitely-absent-' + process.pid);
    writeSession(path.join(projectsDir, 'proj'), '/tmp/proj');

    const metaMap = new Map();
    const fake = makeFakeDb(metaMap);
    sessionCache.init({
      PROJECTS_DIR: projectsDir, activeSessions: new Map(),
      getMainWindow: () => null, log: console, db: fake.db,
    });

    sessionCache.reconcileCacheFromFilesystem();
    assert.ok(fake.indexedFolders.has('proj'), 'claude folders still indexed');
    assert.equal([...fake.indexedFolders].filter(f => f.startsWith('codex/')).length, 0);
  } finally {
    if (prevHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prevHome;
    fs.rmSync(projectsDir, { recursive: true, force: true });
  }
});
