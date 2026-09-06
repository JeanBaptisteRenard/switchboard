/**
 * Compaction-mirror union merge, exercised through session-cache.js's real
 * entry points (issue #197). See .ai/contexts/session-cache.md for the
 * mechanism and the measurement this fix is built on.
 *
 * Fixture shape mirrors the real pair measured on disk: two top-level
 * transcripts share a `bridge-session` record's bridgeSessionId, the
 * mirror's `created` (first event) is later than the parent's, and its
 * duplicated tail carries the SAME timestamp as the parent's last assistant
 * turn (byte-identical recopy), after which it continues with genuinely new,
 * later-timestamped content the parent never receives. A third, differently
 * -bridged transcript must always keep its own, unaffected row.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sessionCache = require('../session-cache');

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-bridge-dedup-'));
}
function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}
function writeJsonl(filePath, lines) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, lines.map(l => JSON.stringify(l)).join('\n') + '\n', 'utf8');
}

// Extends session-cache-refresh.test.js's fake DB with replaceSessionMetrics
// call recording and a real, mutable session_cache-shaped store (needed
// because upserted merged/touched rows must be visible to buildProjectsFromCache
// and to a second refreshFolder pass within the same test).
function makeFakeDb(opts = {}) {
  const store = new Map((opts.cachedRows || []).map(r => [r.sessionId, { ...r }]));
  const deleted = [];
  const searchUpserted = [];
  const searchDeleted = [];
  const metricsReplaced = [];
  const folderMeta = new Map(opts.initialFolderMeta || []);
  const sessionMeta = new Map(opts.initialSessionMeta || []);

  const db = {
    deleteCachedFolder: () => {},
    getCachedByFolder: (folder) => Array.from(store.values()).filter(r => r.folder === folder),
    getAllCached: () => Array.from(store.values()),
    upsertCachedSessions: (sessions) => { for (const s of sessions) store.set(s.sessionId, { ...store.get(s.sessionId), ...s }); },
    touchCachedModified: () => {},
    deleteCachedSession: (id) => { deleted.push(id); store.delete(id); },
    replaceSessionMetrics: (sessionId, dailyMetrics) => metricsReplaced.push({ sessionId, dailyMetrics }),
    deleteSearchFolder: () => {},
    deleteSearchSession: (id) => searchDeleted.push(id),
    upsertSearchEntries: (entries) => { for (const e of entries) searchUpserted.push(e); },
    setFolderMeta: (folder, projectPath, mtime) => folderMeta.set(folder, { folder, projectPath, indexMtimeMs: mtime }),
    getAllFolderMeta: () => folderMeta,
    getAllMeta: () => sessionMeta,
    getSetting: () => ({}),
    getMeta: () => null,
    setName: () => {},
  };

  return { db, store, deleted, searchUpserted, searchDeleted, metricsReplaced, folderMeta };
}

const PARENT_USAGE = { input_tokens: 100, output_tokens: 50 };
const MIRROR_NEW_USAGE = { input_tokens: 9, output_tokens: 4 };

test('refreshFolder: a compaction mirror keeps its own row (mergedIntoSessionId set), contributes only its post-cutoff tokens, and an independent session is untouched', () => {
  const projectsDir = mkTmp();
  try {
    const folder = 'proj';
    const folderPath = path.join(projectsDir, folder);
    const projectPath = projectsDir;

    const parentPath = path.join(folderPath, 'e4b389ac.jsonl');
    const mirrorPath = path.join(folderPath, '1b1def07.jsonl');
    const independentPath = path.join(folderPath, '2932029d.jsonl');

    writeJsonl(parentPath, [
      { type: 'bridge-session', sessionId: 'e4b389ac', bridgeSessionId: 'cse_1', lastSequenceNum: 0 },
      { type: 'user', cwd: projectPath, timestamp: '2026-09-03T21:15:40.535Z', message: { role: 'user', content: 'New project' } },
      { type: 'assistant', timestamp: '2026-09-03T21:16:00.000Z', message: { model: 'claude-sonnet-4-6', usage: PARENT_USAGE } },
    ]);
    // Mirror: same bridgeSessionId. Its recopied prefix is only the parent's
    // LAST turn (the assistant reply, at the exact same timestamp -- a
    // byte-identical recopy of the retained context window, not the whole
    // conversation from its absolute start), then genuinely new content
    // afterward. This keeps the mirror's own first-event timestamp strictly
    // after the parent's `created`, matching the real fixture (the mirror's
    // duplicated window is recent context, never the session's opening turn).
    writeJsonl(mirrorPath, [
      { type: 'custom-title', customTitle: 'supervision-locale (3)', sessionId: '1b1def07' },
      { type: 'assistant', timestamp: '2026-09-03T21:16:00.000Z', message: { model: 'claude-sonnet-4-6', usage: PARENT_USAGE } },
      { type: 'user', cwd: projectPath, timestamp: '2026-09-05T22:15:00.000Z', message: { role: 'user', content: 'continue please' } },
      { type: 'assistant', timestamp: '2026-09-05T22:15:05.000Z', message: { model: 'claude-sonnet-4-6', usage: MIRROR_NEW_USAGE } },
      { type: 'bridge-session', sessionId: '1b1def07', bridgeSessionId: 'cse_1', lastSequenceNum: 7481 },
    ]);
    writeJsonl(independentPath, [
      { type: 'bridge-session', sessionId: '2932029d', bridgeSessionId: 'cse_2', lastSequenceNum: 0 },
      { type: 'user', cwd: projectPath, timestamp: '2026-09-06T18:02:54.000Z', message: { role: 'user', content: 'unrelated work' } },
      { type: 'assistant', timestamp: '2026-09-06T18:03:00.000Z', message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 7, output_tokens: 3 } } },
    ]);

    const parentFileMtime = fs.statSync(parentPath).mtime.toISOString();
    const cachedRows = [
      {
        sessionId: 'e4b389ac', folder, projectPath, fileMtime: parentFileMtime,
        created: '2026-09-03T21:15:40.535Z', modified: '2026-09-03T21:16:00.000Z',
        messageCount: 2, bridgeSessionId: 'cse_1', mergedIntoSessionId: null,
        filePath: parentPath, parentSessionId: null, agentId: null,
      },
    ];

    const { db, store, deleted, searchUpserted, metricsReplaced } = makeFakeDb({ cachedRows });
    sessionCache.init({ PROJECTS_DIR: projectsDir, activeSessions: new Map(), getMainWindow: () => null, log: console, db });

    // Watcher-style targeted refresh: only the two brand-new files were seen.
    sessionCache.refreshFolder(folder, { files: new Set(['1b1def07.jsonl', '2932029d.jsonl']) });

    assert.ok(store.has('1b1def07'), 'the mirror keeps its own session_cache row');
    assert.equal(store.get('1b1def07').mergedIntoSessionId, 'e4b389ac');
    assert.equal(store.get('1b1def07').messageCount, 2, 'only the 2 post-cutoff entries (the duplicated pair is excluded)');
    assert.equal(store.get('2932029d').mergedIntoSessionId, undefined, 'the differently-bridged session is never merged');
    assert.equal(deleted.length, 0, 'nothing is deleted -- the parent is untouched, the mirror keeps its row');

    const mirrorMetrics = metricsReplaced.find(m => m.sessionId === '1b1def07');
    assert.ok(mirrorMetrics, 'the mirror gets its own session_metrics rows');
    const mirrorTotalInput = mirrorMetrics.dailyMetrics.reduce((sum, m) => sum + m.inputTokens, 0);
    assert.equal(mirrorTotalInput, MIRROR_NEW_USAGE.input_tokens, 'mirror tokens are exactly its post-cutoff usage, not the duplicated parent usage too');
    assert.ok(!metricsReplaced.some(m => m.sessionId === 'e4b389ac'), 'parent was not re-read (unchanged mtime); its metrics are untouched, never doubled');

    const mirrorSearch = searchUpserted.find(e => e.id === '1b1def07');
    assert.ok(mirrorSearch, 'the mirror still gets a search entry so its post-compaction content is findable');
  } finally {
    cleanup(projectsDir);
  }
});

test('buildProjectsFromCache: the mirror does not appear as its own sidebar entry; its messageCount and modified roll up onto the parent', () => {
  const projectsDir = mkTmp();
  try {
    const folder = 'proj';
    const cachedRows = [
      {
        sessionId: 'parent', folder, projectPath: '/tmp/proj', summary: 'New project', firstPrompt: 'New project',
        created: '2026-09-03T21:15:40.535Z', modified: '2026-09-03T21:16:00.000Z', messageCount: 2,
        bridgeSessionId: 'cse_1', mergedIntoSessionId: null, parentSessionId: null, agentId: null,
      },
      {
        sessionId: 'mirror', folder, projectPath: '/tmp/proj', summary: 'continue please', firstPrompt: 'continue please',
        created: '2026-09-05T22:14:52.000Z', modified: '2026-09-05T22:15:05.000Z', messageCount: 2,
        bridgeSessionId: 'cse_1', mergedIntoSessionId: 'parent', parentSessionId: null, agentId: null,
      },
      {
        sessionId: 'independent', folder, projectPath: '/tmp/proj', summary: 'unrelated work', firstPrompt: 'unrelated work',
        created: '2026-09-06T18:02:54.000Z', modified: '2026-09-06T18:03:00.000Z', messageCount: 2,
        bridgeSessionId: 'cse_2', mergedIntoSessionId: null, parentSessionId: null, agentId: null,
      },
    ];
    const { db } = makeFakeDb({ cachedRows });
    sessionCache.init({ PROJECTS_DIR: projectsDir, activeSessions: new Map(), getMainWindow: () => null, log: console, db });

    const projects = sessionCache.buildProjectsFromCache(false);
    const proj = projects.find(p => p.projectPath === '/tmp/proj');
    assert.ok(proj);
    const ids = proj.sessions.map(s => s.sessionId).sort();
    assert.deepEqual(ids, ['independent', 'parent'], 'the mirror is never listed as its own sidebar entry');

    const parentEntry = proj.sessions.find(s => s.sessionId === 'parent');
    assert.equal(parentEntry.messageCount, 4, 'parent (2) + mirror (2) rolled up');
    assert.equal(parentEntry.modified, '2026-09-05T22:15:05.000Z', 'displayed modified reflects the mirror\'s later activity, not the frozen parent\'s');
  } finally {
    cleanup(projectsDir);
  }
});

test('refreshFolder: an existing row misidentified as parent is re-parented (not deleted) once a genuinely earlier file is discovered', () => {
  const projectsDir = mkTmp();
  try {
    const folder = 'proj2';
    const folderPath = path.join(projectsDir, folder);
    const projectPath = projectsDir;

    const truParentPath = path.join(folderPath, 'true-parent.jsonl');
    writeJsonl(truParentPath, [
      { type: 'bridge-session', sessionId: 'true-parent', bridgeSessionId: 'cse_1', lastSequenceNum: 0 },
      { type: 'user', cwd: projectPath, timestamp: '2026-09-03T21:15:40.535Z', message: { role: 'user', content: 'New project' } },
      { type: 'assistant', timestamp: '2026-09-03T21:16:00.000Z', message: { model: 'claude-sonnet-4-6', usage: PARENT_USAGE } },
    ]);

    // Already cached under a LATER created -- as if it had been indexed first
    // (e.g. discovered by an earlier watcher flush) before true-parent.jsonl
    // was ever read.
    const cachedRows = [
      {
        sessionId: 'was-cached-first', folder, projectPath, fileMtime: '2026-09-05T22:14:52.000Z',
        created: '2026-09-05T22:14:52.000Z', modified: '2026-09-05T22:14:52.000Z', messageCount: 3,
        bridgeSessionId: 'cse_1', mergedIntoSessionId: null,
        filePath: path.join(folderPath, 'was-cached-first.jsonl'),
        parentSessionId: null, agentId: null,
      },
    ];

    const { db, store, deleted } = makeFakeDb({ cachedRows });
    sessionCache.init({ PROJECTS_DIR: projectsDir, activeSessions: new Map(), getMainWindow: () => null, log: console, db });

    sessionCache.refreshFolder(folder, { files: new Set(['true-parent.jsonl']) });

    assert.ok(store.has('true-parent'), 'the genuinely earlier file becomes its own row');
    assert.equal(store.get('true-parent').mergedIntoSessionId, undefined);
    assert.ok(store.has('was-cached-first'), 'the previously-cached row is NOT deleted');
    assert.equal(store.get('was-cached-first').mergedIntoSessionId, 'true-parent', 're-parented onto the genuinely earlier file');
    assert.equal(store.get('was-cached-first').messageCount, 3, 'its stored contribution is untouched (re-parented without a re-read)');
    assert.deepEqual(deleted, []);
  } finally {
    cleanup(projectsDir);
  }
});

test('readFolderFromFilesystem: a fresh full-folder scan merges the mirror in one pass with no double-counted tokens', () => {
  const projectsDir = mkTmp();
  try {
    const folder = 'proj3';
    const folderPath = path.join(projectsDir, folder);
    const projectPath = projectsDir;

    writeJsonl(path.join(folderPath, 'parent.jsonl'), [
      { type: 'bridge-session', sessionId: 'parent', bridgeSessionId: 'cse_1', lastSequenceNum: 0 },
      { type: 'user', cwd: projectPath, timestamp: '2026-09-03T21:15:40.535Z', message: { role: 'user', content: 'New project' } },
      { type: 'assistant', timestamp: '2026-09-03T21:16:00.000Z', message: { model: 'claude-sonnet-4-6', usage: PARENT_USAGE } },
    ]);
    writeJsonl(path.join(folderPath, 'mirror.jsonl'), [
      { type: 'assistant', timestamp: '2026-09-03T21:16:00.000Z', message: { model: 'claude-sonnet-4-6', usage: PARENT_USAGE } },
      { type: 'user', cwd: projectPath, timestamp: '2026-09-05T22:15:00.000Z', message: { role: 'user', content: 'continue please' } },
      { type: 'assistant', timestamp: '2026-09-05T22:15:05.000Z', message: { model: 'claude-sonnet-4-6', usage: MIRROR_NEW_USAGE } },
      { type: 'bridge-session', sessionId: 'mirror', bridgeSessionId: 'cse_1', lastSequenceNum: 7481 },
    ]);
    writeJsonl(path.join(folderPath, 'independent.jsonl'), [
      { type: 'bridge-session', sessionId: 'independent', bridgeSessionId: 'cse_2', lastSequenceNum: 0 },
      { type: 'user', cwd: projectPath, timestamp: '2026-09-06T18:02:54.000Z', message: { role: 'user', content: 'unrelated work' } },
      { type: 'assistant', timestamp: '2026-09-06T18:03:00.000Z', message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 7, output_tokens: 3 } } },
    ]);

    const { db } = makeFakeDb();
    sessionCache.init({ PROJECTS_DIR: projectsDir, activeSessions: new Map(), getMainWindow: () => null, log: console, db });

    const { sessions } = sessionCache.readFolderFromFilesystem(folder);
    const ids = sessions.map(s => s.sessionId).sort();
    assert.deepEqual(ids, ['independent', 'mirror', 'parent'], 'every file keeps a row -- nothing dropped, nothing extra');

    const parentRow = sessions.find(s => s.sessionId === 'parent');
    const mirrorRow = sessions.find(s => s.sessionId === 'mirror');
    assert.equal(mirrorRow.mergedIntoSessionId, 'parent');

    const parentTokens = parentRow.dailyMetrics.reduce((sum, m) => sum + m.inputTokens, 0);
    const mirrorTokens = mirrorRow.dailyMetrics.reduce((sum, m) => sum + m.inputTokens, 0);
    assert.equal(parentTokens, PARENT_USAGE.input_tokens);
    assert.equal(mirrorTokens, MIRROR_NEW_USAGE.input_tokens, 'mirror contributes only its post-cutoff tokens -- the union, not a duplicate');
    assert.equal(parentTokens + mirrorTokens, PARENT_USAGE.input_tokens + MIRROR_NEW_USAGE.input_tokens,
      'combined, the group\'s total tokens equal parent + mirror\'s genuinely new activity -- nothing lost, nothing doubled');
  } finally {
    cleanup(projectsDir);
  }
});
