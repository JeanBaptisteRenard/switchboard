'use strict';

// buildProjectsFromCache's empty-directory fallback vs the initial scan.
//
// The fallback resolves folder -> projectPath through cache_meta and, for
// folders the indexer hasn't seen yet, falls back to deriveProjectPath():
// a readdir plus up to a 256 KB JSONL head read, synchronously on the main
// process. On a COLD start that used to run for EVERY folder under
// ~/.claude/projects/ (cache_meta entirely empty), twice per sidebar paint
// (the renderer's showArchived false/true Promise.all) -- per-folder
// synchronous I/O in the exact window where get-projects promises to return
// "whatever's cached right now" (PR #124 review finding 2).
//
// While the initial scan is incomplete (persistent initial_scan_complete
// marker absent), the fallback must instead use a zero-I/O best-effort decode
// of the folder name, and must not backfill the guess into cache_meta. Once
// the marker is present (scan completed), the original derive-and-backfill
// path is unchanged.
//
// deriveProjectPath is spied on by patching the derive-project-path module
// BEFORE session-cache.js is required (it destructures the function at
// require time). fs.existsSync is patched at runtime (session-cache calls it
// through the module object). node --test gives this file its own process,
// so neither patch leaks into other test files.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const deriveModule = require('../derive-project-path');
const realDerive = deriveModule.deriveProjectPath;
let deriveCalls = 0;
deriveModule.deriveProjectPath = (...args) => { deriveCalls++; return realDerive(...args); };

const sessionCache = require('../session-cache');

function writeSession(folderPath, cwd) {
  fs.mkdirSync(folderPath, { recursive: true });
  const line = JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: 'hello' } });
  fs.writeFileSync(path.join(folderPath, 'session.jsonl'), line + '\n', 'utf8');
}

function initCache(projectsDir, { initialScanComplete, setFolderMetaCalls }) {
  sessionCache.init({
    PROJECTS_DIR: projectsDir,
    activeSessions: new Map(),
    getMainWindow: () => null,
    log: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
    db: {
      isInitialScanComplete: () => initialScanComplete,
      setInitialScanComplete: () => {},
      deleteCachedFolder: () => {}, getCachedByFolder: () => [],
      upsertCachedSessions: () => {}, touchCachedModified: () => {},
      deleteCachedSession: () => {}, replaceSessionMetrics: () => {},
      deleteSearchFolder: () => {}, deleteSearchSession: () => {},
      upsertSearchEntries: () => {},
      setFolderMeta: (folder, projectPath, indexMtimeMs) => setFolderMetaCalls.push({ folder, projectPath, indexMtimeMs }),
      getFolderMeta: () => null,
      getAllFolderMeta: () => new Map(), // cache_meta empty: the indexer has seen nothing yet
      getAllMeta: () => new Map(),
      getAllCached: () => [], // session_cache empty too
      getSetting: () => ({}),
      getMeta: () => null,
      setName: () => {},
    },
  });
}

test('cold start in flight: the empty-dir fallback does zero per-folder I/O and never persists the guessed path', () => {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-bpfc-cold-'));
  const realExistsSync = fs.existsSync;
  try {
    // Real JSONLs with a real cwd: if deriveProjectPath ran, it would succeed
    // -- the test must prove it isn't given the chance to.
    writeSession(path.join(projectsDir, '-tmp-proj-a'), '/tmp/proj/a');
    writeSession(path.join(projectsDir, '-tmp-proj-b'), '/tmp/proj/b');

    const setFolderMetaCalls = [];
    initCache(projectsDir, { initialScanComplete: false, setFolderMetaCalls });

    deriveCalls = 0;
    let existsCalls = 0;
    fs.existsSync = (...args) => { existsCalls++; return realExistsSync(...args); };

    // Twice: the renderer's loadProjects fires get-projects for
    // showArchived=false and true back to back.
    const first = sessionCache.buildProjectsFromCache(false);
    const second = sessionCache.buildProjectsFromCache(true);

    fs.existsSync = realExistsSync;

    assert.equal(deriveCalls, 0,
      'deriveProjectPath (readdir + 256 KB JSONL head read per folder) must not run while the initial scan is incomplete');
    assert.equal(existsCalls, 0,
      'no fs.existsSync missing-probe either -- the cold fallback must be pure string work');
    assert.equal(setFolderMetaCalls.length, 0,
      'the lossy decoded guess must never be written into cache_meta, or it would shadow the real derived path');

    // The placeholder entries are still useful: best-effort decoded path,
    // on-disk folder name as the id, never flagged missing.
    for (const projects of [first, second]) {
      const paths = projects.map(p => p.projectPath).sort();
      assert.deepEqual(paths, ['/tmp/proj/a', '/tmp/proj/b']);
      for (const p of projects) {
        assert.match(p.folder, /^-tmp-proj-[ab]$/, 'placeholder keeps the on-disk folder name as its id');
        assert.equal(p.missing, false);
      }
    }
  } finally {
    fs.existsSync = realExistsSync;
    fs.rmSync(projectsDir, { recursive: true, force: true });
  }
});

test('scan complete: the fallback still derives real paths and backfills cache_meta (warm path unchanged)', () => {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-bpfc-warm-'));
  try {
    writeSession(path.join(projectsDir, '-tmp-proj-a'), '/tmp/proj-a');

    const setFolderMetaCalls = [];
    initCache(projectsDir, { initialScanComplete: true, setFolderMetaCalls });

    deriveCalls = 0;
    const projects = sessionCache.buildProjectsFromCache(false);

    assert.equal(deriveCalls, 1, 'a folder unknown to cache_meta is derived for real once the scan is complete');
    assert.deepEqual(setFolderMetaCalls.map(c => c.projectPath), ['/tmp/proj-a'],
      'the real derived path is backfilled so subsequent renders are pure DB reads');
    assert.deepEqual(projects.map(p => p.projectPath), ['/tmp/proj-a']);
  } finally {
    fs.rmSync(projectsDir, { recursive: true, force: true });
  }
});
