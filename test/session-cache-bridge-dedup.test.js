/**
 * Compaction-mirror dedup, exercised through session-cache.js's real entry
 * points (issue #197). See .ai/contexts/session-cache.md for the mechanism
 * and the measurement this fix is built on.
 *
 * Fixture shape mirrors the real pair measured on disk for the issue: two
 * top-level transcripts share a `bridge-session` record's bridgeSessionId,
 * the mirror's `created` (first event) is later than the parent's, and its
 * assistant turn duplicates the parent's token usage (the actual double-count
 * this bug produces in session_metrics). A third, differently-bridged
 * transcript must always keep its own row.
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
// call recording, needed to assert "token totals equal to the parent's alone".
function makeFakeDb(opts = {}) {
  const upserted = [];
  const deleted = [];
  const searchUpserted = [];
  const searchDeleted = [];
  const metricsReplaced = [];
  const folderMeta = new Map(opts.initialFolderMeta || []);
  const sessionMeta = new Map(opts.initialSessionMeta || []);
  const cachedRows = opts.cachedRows || [];

  const db = {
    deleteCachedFolder: () => {},
    getCachedByFolder: () => cachedRows,
    upsertCachedSessions: (sessions) => { for (const s of sessions) upserted.push(s); },
    touchCachedModified: () => {},
    deleteCachedSession: (id) => deleted.push(id),
    replaceSessionMetrics: (sessionId, dailyMetrics) => metricsReplaced.push({ sessionId, dailyMetrics }),
    deleteSearchFolder: () => {},
    deleteSearchSession: (id) => searchDeleted.push(id),
    upsertSearchEntries: (entries) => { for (const e of entries) searchUpserted.push(e); },
    setFolderMeta: (folder, projectPath, mtime) => folderMeta.set(folder, { folder, projectPath, indexMtimeMs: mtime }),
    getAllFolderMeta: () => folderMeta,
    getAllMeta: () => sessionMeta,
    getAllCached: () => [],
    getSetting: () => ({}),
    getMeta: () => null,
    setName: () => {},
  };

  return { db, upserted, deleted, searchUpserted, searchDeleted, metricsReplaced, folderMeta };
}

const USAGE = { input_tokens: 100, output_tokens: 50 };

test('refreshFolder: a compaction mirror discovered as a NEW file is dropped, not double-counted; the parent row and its metrics are untouched', () => {
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
      { type: 'assistant', timestamp: '2026-09-03T21:16:00.000Z', message: { model: 'claude-sonnet-4-6', usage: USAGE } },
    ]);
    // Mirror: same bridgeSessionId, later first event, duplicates the parent's
    // token usage -- exactly the shape that inflates session_metrics pre-fix.
    writeJsonl(mirrorPath, [
      { type: 'custom-title', customTitle: 'supervision-locale (3)', sessionId: '1b1def07' },
      { type: 'user', cwd: projectPath, timestamp: '2026-09-05T22:14:52.000Z', message: { role: 'user', content: 'New project' } },
      { type: 'assistant', timestamp: '2026-09-05T22:15:00.000Z', message: { model: 'claude-sonnet-4-6', usage: USAGE } },
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
        bridgeSessionId: 'cse_1', filePath: parentPath, parentSessionId: null, agentId: null,
      },
    ];

    const { db, upserted, deleted, searchUpserted, metricsReplaced } = makeFakeDb({ cachedRows });
    sessionCache.init({ PROJECTS_DIR: projectsDir, activeSessions: new Map(), getMainWindow: () => null, log: console, db });

    // Watcher-style targeted refresh: only the two brand-new files were seen.
    sessionCache.refreshFolder(folder, { files: new Set(['1b1def07.jsonl', '2932029d.jsonl']) });

    const upsertedIds = upserted.map(s => s.sessionId);
    assert.ok(!upsertedIds.includes('1b1def07'), `mirror must not get its own row; upserted: ${JSON.stringify(upsertedIds)}`);
    assert.ok(upsertedIds.includes('2932029d'), 'the differently-bridged session must keep its own row');
    assert.equal(deleted.length, 0, 'the already-cached parent row is not evicted -- it is the winner');

    const metricIds = metricsReplaced.map(m => m.sessionId);
    assert.ok(!metricIds.includes('1b1def07'), 'mirror tokens must never reach session_metrics');
    // Parent was unchanged (fileMtime matched) so it was not re-read this pass;
    // its existing session_metrics row is therefore untouched -- proving the
    // fix works by exclusion, not by re-summing across both files.
    assert.ok(!metricIds.includes('e4b389ac'), 'parent was not re-read (unchanged mtime); its metrics are left exactly as-is, never doubled');

    const searchIds = searchUpserted.map(e => e.id);
    assert.ok(!searchIds.includes('1b1def07'), 'mirror must not get a search entry either');
  } finally {
    cleanup(projectsDir);
  }
});

test('refreshFolder: an existing row misidentified as parent is evicted once a genuinely earlier file is discovered', () => {
  const projectsDir = mkTmp();
  try {
    const folder = 'proj2';
    const folderPath = path.join(projectsDir, folder);
    const projectPath = projectsDir;

    const truParentPath = path.join(folderPath, 'true-parent.jsonl');
    writeJsonl(truParentPath, [
      { type: 'bridge-session', sessionId: 'true-parent', bridgeSessionId: 'cse_1', lastSequenceNum: 0 },
      { type: 'user', cwd: projectPath, timestamp: '2026-09-03T21:15:40.535Z', message: { role: 'user', content: 'New project' } },
      { type: 'assistant', timestamp: '2026-09-03T21:16:00.000Z', message: { model: 'claude-sonnet-4-6', usage: USAGE } },
    ]);

    // Already cached under a LATER created -- as if it had been indexed first
    // (e.g. discovered by an earlier watcher flush) before true-parent.jsonl
    // was ever read.
    const cachedRows = [
      {
        sessionId: 'was-cached-first', folder, projectPath, fileMtime: '2026-09-05T22:14:52.000Z',
        created: '2026-09-05T22:14:52.000Z', modified: '2026-09-05T22:14:52.000Z',
        bridgeSessionId: 'cse_1', filePath: path.join(folderPath, 'was-cached-first.jsonl'),
        parentSessionId: null, agentId: null,
      },
    ];

    const { db, upserted, deleted } = makeFakeDb({ cachedRows });
    sessionCache.init({ PROJECTS_DIR: projectsDir, activeSessions: new Map(), getMainWindow: () => null, log: console, db });

    sessionCache.refreshFolder(folder, { files: new Set(['true-parent.jsonl']) });

    assert.ok(upserted.some(s => s.sessionId === 'true-parent'), 'the genuinely earlier file becomes the surviving row');
    assert.ok(deleted.includes('was-cached-first'), 'the previously-cached later row is evicted, decided on created, not discovery order');
  } finally {
    cleanup(projectsDir);
  }
});

test('readFolderFromFilesystem: a fresh full-folder scan collapses the mirror in one pass', () => {
  const projectsDir = mkTmp();
  try {
    const folder = 'proj3';
    const folderPath = path.join(projectsDir, folder);
    const projectPath = projectsDir;

    writeJsonl(path.join(folderPath, 'parent.jsonl'), [
      { type: 'bridge-session', sessionId: 'parent', bridgeSessionId: 'cse_1', lastSequenceNum: 0 },
      { type: 'user', cwd: projectPath, timestamp: '2026-09-03T21:15:40.535Z', message: { role: 'user', content: 'New project' } },
      { type: 'assistant', timestamp: '2026-09-03T21:16:00.000Z', message: { model: 'claude-sonnet-4-6', usage: USAGE } },
    ]);
    writeJsonl(path.join(folderPath, 'mirror.jsonl'), [
      { type: 'user', cwd: projectPath, timestamp: '2026-09-05T22:14:52.000Z', message: { role: 'user', content: 'New project' } },
      { type: 'assistant', timestamp: '2026-09-05T22:15:00.000Z', message: { model: 'claude-sonnet-4-6', usage: USAGE } },
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
    assert.deepEqual(ids, ['independent', 'parent'], 'exactly one row per bridgeSessionId group, plus the independent session');

    const parentRow = sessions.find(s => s.sessionId === 'parent');
    const totalInput = parentRow.dailyMetrics.reduce((sum, m) => sum + m.inputTokens, 0);
    const totalOutput = parentRow.dailyMetrics.reduce((sum, m) => sum + m.outputTokens, 0);
    assert.equal(totalInput, USAGE.input_tokens, 'surviving row\'s tokens equal the parent file\'s own usage, not summed with the mirror\'s duplicate');
    assert.equal(totalOutput, USAGE.output_tokens);
  } finally {
    cleanup(projectsDir);
  }
});
