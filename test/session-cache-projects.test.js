/**
 * BT4 — Characterization tests for session-cache.js buildProjectsFromCache().
 *
 * Tests observable output contract: grouping, sorting, archive filtering, and
 * missing-project ordering. Uses the fake-DB pattern to inject fixture rows
 * without touching SQLite.
 *
 * buildProjectsFromCache() also calls fs.readdirSync(PROJECTS_DIR) to include
 * empty project directories. We create a temporary PROJECTS_DIR and write the
 * relevant sub-directories so the fs calls don't error.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sessionCache = require('../session-cache');

// ---- Helpers ----------------------------------------------------------------

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-scp-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Build a minimal fake DB for buildProjectsFromCache tests.
 * cachedRows  — array of rows returned by getAllCached()
 * metaEntries — Map<sessionId, { name, starred, archived }> returned by getAllMeta()
 * folderMeta  — Map<folderName, { projectPath }> returned by getAllFolderMeta()
 */
function makeFakeDb({ cachedRows = [], metaEntries = new Map(), folderMeta = new Map() } = {}) {
  return {
    deleteCachedFolder: () => {},
    getCachedByFolder: () => [],
    upsertCachedSessions: () => {},
    touchCachedModified: () => {},
    deleteCachedSession: () => {},
    replaceSessionMetrics: () => {},
    deleteSearchFolder: () => {},
    deleteSearchSession: () => {},
    upsertSearchEntries: () => {},
    setFolderMeta: () => {},
    getAllFolderMeta: () => folderMeta,
    getAllMeta: () => metaEntries,
    getAllCached: () => cachedRows,
    getSetting: () => ({}),
    getMeta: () => null,
    setName: () => {},
  };
}

/**
 * Initialize sessionCache with the given fake DB and a temp projectsDir.
 * The projectsDir is expected to already exist.
 */
function initCache(projectsDir, db) {
  sessionCache.init({
    PROJECTS_DIR: projectsDir,
    activeSessions: new Map(),
    getMainWindow: () => null,
    log: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
    db,
  });
}

// ---- Tests ------------------------------------------------------------------

test('buildProjectsFromCache: sessions with the same projectPath are merged into one project entry', () => {
  const projectsDir = mkTmp();
  try {
    // Create 2 folders that both resolve to the same projectPath (via folderMeta)
    const projectPath = '/home/user/my-project';
    fs.mkdirSync(path.join(projectsDir, 'folder-a'));
    fs.mkdirSync(path.join(projectsDir, 'folder-b'));

    const folderMeta = new Map([
      ['folder-a', { projectPath }],
      ['folder-b', { projectPath }],
    ]);

    const cachedRows = [
      { sessionId: 's1', folder: 'folder-a', projectPath, summary: 'session 1',
        firstPrompt: 'session 1', modified: '2024-03-15T10:00:00.000Z',
        created: '2024-03-15T10:00:00.000Z', messageCount: 1,
        parentSessionId: null, agentId: null, subagentType: null,
        description: null, slug: null, aiTitle: null },
      { sessionId: 's2', folder: 'folder-b', projectPath, summary: 'session 2',
        firstPrompt: 'session 2', modified: '2024-03-15T11:00:00.000Z',
        created: '2024-03-15T11:00:00.000Z', messageCount: 2,
        parentSessionId: null, agentId: null, subagentType: null,
        description: null, slug: null, aiTitle: null },
    ];

    const db = makeFakeDb({ cachedRows, folderMeta });
    initCache(projectsDir, db);

    const projects = sessionCache.buildProjectsFromCache(true);

    // Both sessions share the same projectPath → exactly 1 project entry
    const projectEntries = projects.filter(p => p.projectPath === projectPath);
    assert.equal(projectEntries.length, 1,
      `expected 1 merged project for ${projectPath}; got ${projectEntries.length}`);
    assert.equal(projectEntries[0].sessions.length, 2,
      'merged project must have 2 sessions');
  } finally {
    cleanup(projectsDir);
  }
});

test('buildProjectsFromCache: sessions within a project are sorted by modified DESC', () => {
  const projectsDir = mkTmp();
  try {
    const projectPath = '/home/user/sort-project';
    fs.mkdirSync(path.join(projectsDir, 'sort-folder'));

    const folderMeta = new Map([
      ['sort-folder', { projectPath }],
    ]);

    const cachedRows = [
      { sessionId: 's-oldest', folder: 'sort-folder', projectPath,
        summary: 'oldest', firstPrompt: 'oldest',
        modified: '2024-01-01T00:00:00.000Z', created: '2024-01-01T00:00:00.000Z',
        messageCount: 1, parentSessionId: null, agentId: null,
        subagentType: null, description: null, slug: null, aiTitle: null },
      { sessionId: 's-newest', folder: 'sort-folder', projectPath,
        summary: 'newest', firstPrompt: 'newest',
        modified: '2024-03-15T12:00:00.000Z', created: '2024-03-15T12:00:00.000Z',
        messageCount: 2, parentSessionId: null, agentId: null,
        subagentType: null, description: null, slug: null, aiTitle: null },
      { sessionId: 's-middle', folder: 'sort-folder', projectPath,
        summary: 'middle', firstPrompt: 'middle',
        modified: '2024-02-10T08:00:00.000Z', created: '2024-02-10T08:00:00.000Z',
        messageCount: 1, parentSessionId: null, agentId: null,
        subagentType: null, description: null, slug: null, aiTitle: null },
    ];

    const db = makeFakeDb({ cachedRows, folderMeta });
    initCache(projectsDir, db);

    const projects = sessionCache.buildProjectsFromCache(true);

    const proj = projects.find(p => p.projectPath === projectPath);
    assert.ok(proj, 'project must exist in output');
    assert.equal(proj.sessions.length, 3);

    // Verify descending order: newest first
    const ids = proj.sessions.map(s => s.sessionId);
    assert.equal(ids[0], 's-newest', 'newest must be first');
    assert.equal(ids[1], 's-middle', 'middle must be second');
    assert.equal(ids[2], 's-oldest', 'oldest must be last');
  } finally {
    cleanup(projectsDir);
  }
});

test('buildProjectsFromCache: archived session excluded when showArchived=false', () => {
  const projectsDir = mkTmp();
  try {
    const projectPath = '/home/user/archive-project';
    fs.mkdirSync(path.join(projectsDir, 'archive-folder'));

    const folderMeta = new Map([
      ['archive-folder', { projectPath }],
    ]);

    const cachedRows = [
      { sessionId: 'visible', folder: 'archive-folder', projectPath,
        summary: 'visible session', firstPrompt: 'visible',
        modified: '2024-03-15T10:00:00.000Z', created: '2024-03-15T10:00:00.000Z',
        messageCount: 1, parentSessionId: null, agentId: null,
        subagentType: null, description: null, slug: null, aiTitle: null },
      { sessionId: 'archived-one', folder: 'archive-folder', projectPath,
        summary: 'archived session', firstPrompt: 'archived',
        modified: '2024-03-15T09:00:00.000Z', created: '2024-03-15T09:00:00.000Z',
        messageCount: 2, parentSessionId: null, agentId: null,
        subagentType: null, description: null, slug: null, aiTitle: null },
    ];

    // Mark 'archived-one' as archived in session meta
    const metaEntries = new Map([
      ['archived-one', { name: null, starred: 0, archived: 1 }],
    ]);

    const db = makeFakeDb({ cachedRows, folderMeta, metaEntries });
    initCache(projectsDir, db);

    // showArchived = false → archived-one must be excluded
    const projects = sessionCache.buildProjectsFromCache(false);

    const proj = projects.find(p => p.projectPath === projectPath);
    assert.ok(proj, 'project with visible sessions must still appear');
    const sessionIds = proj.sessions.map(s => s.sessionId);
    assert.ok(sessionIds.includes('visible'),
      'visible session must be present');
    assert.ok(!sessionIds.includes('archived-one'),
      'archived session must be excluded when showArchived=false');

    // showArchived = true → both must appear
    const projectsWithArchived = sessionCache.buildProjectsFromCache(true);
    const projAll = projectsWithArchived.find(p => p.projectPath === projectPath);
    assert.ok(projAll, 'project must appear when showArchived=true');
    assert.equal(projAll.sessions.length, 2,
      'both sessions must appear when showArchived=true');
  } finally {
    cleanup(projectsDir);
  }
});

test('buildProjectsFromCache: missing project sorts to bottom', () => {
  const projectsDir = mkTmp();
  try {
    // present-project actually exists on disk; missing-project does not
    const presentPath = projectsDir; // guaranteed to exist
    const missingPath = path.join(projectsDir, '__nonexistent_path__', 'project');

    fs.mkdirSync(path.join(projectsDir, 'present-folder'));
    fs.mkdirSync(path.join(projectsDir, 'missing-folder'));

    const folderMeta = new Map([
      ['present-folder', { projectPath: presentPath }],
      ['missing-folder', { projectPath: missingPath }],
    ]);

    // Both projects have a session; the missing one's session is newer
    // (to verify that "missing" sort key beats recency)
    const cachedRows = [
      { sessionId: 'present-s', folder: 'present-folder', projectPath: presentPath,
        summary: 'present', firstPrompt: 'present',
        modified: '2024-01-01T00:00:00.000Z', created: '2024-01-01T00:00:00.000Z',
        messageCount: 1, parentSessionId: null, agentId: null,
        subagentType: null, description: null, slug: null, aiTitle: null },
      { sessionId: 'missing-s', folder: 'missing-folder', projectPath: missingPath,
        summary: 'missing', firstPrompt: 'missing',
        modified: '2024-12-31T23:59:59.000Z', created: '2024-12-31T23:59:59.000Z',
        messageCount: 1, parentSessionId: null, agentId: null,
        subagentType: null, description: null, slug: null, aiTitle: null },
    ];

    const db = makeFakeDb({ cachedRows, folderMeta });
    initCache(projectsDir, db);

    const projects = sessionCache.buildProjectsFromCache(true);

    // Filter to only our two test projects (other empty dirs may appear)
    const relevant = projects.filter(
      p => p.projectPath === presentPath || p.projectPath === missingPath
    );
    assert.ok(relevant.length >= 2,
      `expected both test projects; got: ${relevant.map(p => p.projectPath).join(', ')}`);

    const presentIdx = relevant.findIndex(p => p.projectPath === presentPath);
    const missingIdx = relevant.findIndex(p => p.projectPath === missingPath);
    assert.ok(presentIdx < missingIdx,
      `present project (idx ${presentIdx}) must sort before missing project (idx ${missingIdx})`);
  } finally {
    cleanup(projectsDir);
  }
});
