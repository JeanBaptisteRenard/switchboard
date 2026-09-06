/**
 * Compaction-mirror union merge (issue #197). See .ai/contexts/session-cache.md.
 *
 * A manual /compact leaves a second transcript ("mirror") for the same
 * session. Both transcripts carry a `{"type":"bridge-session", bridgeSessionId}`
 * record with the SAME bridgeSessionId -- that's the field these tests exist
 * to protect. Measured against the real pair on disk (issue #197): the
 * mirror's own bridge-session record sits near the END of its file (byte
 * ~3.08 MB of a 3.08 MB file), not near the head, and a substring search for
 * "bridgeSessionId" also matches unrelated pasted text inside a tool_result
 * in that same real mirror -- both are covered below.
 *
 * The mirror duplicates the parent's tail verbatim (same timestamps) up to
 * the compaction point, then the CLI keeps writing genuinely new content to
 * the mirror, not the parent (also measured on the real pair: the parent's
 * last line is a `continued-in` marker after which it goes quiet, while the
 * mirror keeps receiving later-timestamped lines). Neither file is ever
 * discarded: the merge keeps ONE session_cache row (the earliest-created
 * member) visible, but recomputes every other member's own contribution
 * excluding anything at or before its immediate predecessor's `modified` --
 * exactly the recopied overlap, no more.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { readSessionFile, readSessionDisplayHeader, extractDailyMetrics, mergeBridgeGroups } = require('../read-session-file');

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-bridge-'));
}
function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}
function writeJsonl(filePath, lines) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, lines.map(l => JSON.stringify(l)).join('\n') + '\n', 'utf8');
}

test('readSessionFile extracts bridgeSessionId from a bridge-session record', () => {
  const dir = mkTmp();
  try {
    const filePath = path.join(dir, 's1.jsonl');
    writeJsonl(filePath, [
      { type: 'bridge-session', sessionId: 's1', bridgeSessionId: 'cse_abc123', lastSequenceNum: 0 },
      { type: 'user', cwd: dir, timestamp: '2026-09-03T10:00:00.000Z', message: { role: 'user', content: 'hello world' } },
    ]);
    const s = readSessionFile(filePath, 'folder', dir, {});
    assert.equal(s.bridgeSessionId, 'cse_abc123');
  } finally {
    cleanup(dir);
  }
});

test('readSessionFile does not mistake a pasted bridgeSessionId substring for the real bookkeeping field', () => {
  // Regression: the real mirror fixture (issue #197) has a tool_result line
  // that pastes debug output containing the literal text
  // "bridgeSessionId = 'session_...'" -- an unrelated identifier, not this
  // file's own bridge-session record. A naive substring/regex scan would pick
  // it up; the type==='bridge-session' check must not.
  const dir = mkTmp();
  try {
    const filePath = path.join(dir, 's1.jsonl');
    writeJsonl(filePath, [
      { type: 'user', cwd: dir, timestamp: '2026-09-03T10:00:00.000Z', message: { role: 'user', content: 'hello world' } },
      {
        type: 'user', cwd: dir, timestamp: '2026-09-03T10:00:01.000Z',
        message: { role: 'user', content: [{ type: 'tool_result', content: "bridgeSessionId = 'session_01LVj81215CXXdc16pFcrERX'" }] },
      },
    ]);
    const s = readSessionFile(filePath, 'folder', dir, {});
    assert.equal(s.bridgeSessionId, null, 'pasted text must not be read as this file\'s bridgeSessionId');
  } finally {
    cleanup(dir);
  }
});

test('readSessionDisplayHeader never returns bridgeSessionId (full-read-only field)', () => {
  const dir = mkTmp();
  try {
    const filePath = path.join(dir, 's1.jsonl');
    // bridge-session record placed at line 1, well within the header's 256KB/
    // 500-line cap -- even so, the header path must not surface the field, so
    // an incremental (header-only) refresh never silently disagrees with the
    // full read on this value.
    writeJsonl(filePath, [
      { type: 'bridge-session', sessionId: 's1', bridgeSessionId: 'cse_abc123', lastSequenceNum: 0 },
      { type: 'user', cwd: dir, timestamp: '2026-09-03T10:00:00.000Z', message: { role: 'user', content: 'hello world' } },
    ]);
    const h = readSessionDisplayHeader(filePath, {});
    assert.ok(h);
    assert.equal(h.bridgeSessionId, undefined);
  } finally {
    cleanup(dir);
  }
});

test('readSessionFile with dedupeSinceTimestamp excludes messageCount/textContent/dailyMetrics at or before the cutoff, but not created/modified/bridgeSessionId', () => {
  const dir = mkTmp();
  try {
    const filePath = path.join(dir, 'mirror.jsonl');
    writeJsonl(filePath, [
      { type: 'bridge-session', sessionId: 'mirror', bridgeSessionId: 'cse_1', lastSequenceNum: 1 },
      // Recopied (duplicate) tail -- timestamp equals the cutoff exactly.
      { type: 'user', cwd: dir, timestamp: '2026-09-03T21:16:00.000Z', message: { role: 'user', content: 'New project' } },
      { type: 'assistant', timestamp: '2026-09-03T21:16:00.000Z', message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 100, output_tokens: 50 } } },
      // Genuinely new content, after the cutoff.
      { type: 'user', cwd: dir, timestamp: '2026-09-05T22:15:00.000Z', message: { role: 'user', content: 'continue please' } },
      { type: 'assistant', timestamp: '2026-09-05T22:15:05.000Z', message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 9, output_tokens: 4 } } },
    ]);
    const s = readSessionFile(filePath, 'folder', dir, { dedupeSinceTimestamp: '2026-09-03T21:16:00.000Z' });
    assert.ok(s);
    assert.equal(s.bridgeSessionId, 'cse_1', 'bridgeSessionId is never cutoff-filtered');
    assert.equal(s.modified, '2026-09-05T22:15:05.000Z', 'modified reflects the file\'s true last event, unfiltered');
    assert.equal(s.messageCount, 2, 'only the 2 post-cutoff entries count, not the 2 duplicated ones');
    const totalInput = s.dailyMetrics.reduce((sum, m) => sum + m.inputTokens, 0);
    assert.equal(totalInput, 9, 'dailyMetrics excludes the duplicated assistant turn\'s tokens');
  } finally {
    cleanup(dir);
  }
});

test('extractDailyMetrics sinceTimestampExclusive drops entries at or before the cutoff', () => {
  const lines = [
    JSON.stringify({ type: 'assistant', timestamp: '2026-06-01T10:00:00.000Z', message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 100, output_tokens: 50 } } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-06-01T10:00:00.000Z', message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 999, output_tokens: 999 } } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-06-01T10:00:01.000Z', message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 5, output_tokens: 2 } } }),
  ];
  const rows = extractDailyMetrics(lines, '2026-06-01', '2026-06-01T10:00:00.000Z');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].inputTokens, 5, 'entries at exactly the cutoff are excluded, not just strictly-before ones');
});

test('mergeBridgeGroups: no bridgeSessionId anywhere never groups rows', () => {
  const fresh = [
    { sessionId: 'a', created: '2026-01-01T00:00:00.000Z', modified: '2026-01-01T00:00:00.000Z', bridgeSessionId: null },
    { sessionId: 'b', created: '2026-01-02T00:00:00.000Z', modified: '2026-01-02T00:00:00.000Z', bridgeSessionId: null },
  ];
  const { toUpsert, toTouch } = mergeBridgeGroups([], fresh, () => { throw new Error('reread must not be called'); });
  assert.deepEqual(toUpsert, fresh);
  assert.deepEqual(toTouch, []);
});

test('mergeBridgeGroups: within one fresh batch, the earlier member is untouched and the later one is re-derived with the earlier\'s modified as cutoff', () => {
  const parent = { sessionId: 'parent', created: '2026-09-03T21:15:40.535Z', modified: '2026-09-03T21:16:00.000Z', bridgeSessionId: 'cse_1' };
  const mirror = { sessionId: 'mirror', created: '2026-09-05T22:14:52.000Z', modified: '2026-09-05T22:15:05.000Z', bridgeSessionId: 'cse_1' };
  const independent = { sessionId: 'independent', created: '2026-09-04T00:00:00.000Z', modified: '2026-09-04T00:00:00.000Z', bridgeSessionId: 'cse_2' };
  const rereadCalls = [];
  const reread = (sessionId, cutoff) => {
    rereadCalls.push({ sessionId, cutoff });
    return { sessionId, created: mirror.created, modified: mirror.modified, bridgeSessionId: 'cse_1', messageCount: 2, dailyMetrics: [] };
  };
  const { toUpsert, toTouch } = mergeBridgeGroups([], [parent, mirror, independent], reread);
  assert.deepEqual(rereadCalls, [{ sessionId: 'mirror', cutoff: parent.modified }],
    'reread is called exactly once, for the later member, with the earlier member\'s modified as cutoff');
  assert.deepEqual(toUpsert.map(s => s.sessionId).sort(), ['independent', 'mirror', 'parent'],
    'every member keeps its own row -- nothing is dropped');
  const upsertedMirror = toUpsert.find(s => s.sessionId === 'mirror');
  assert.equal(upsertedMirror.mergedIntoSessionId, 'parent');
  assert.equal(upsertedMirror.messageCount, 2, 'the upserted mirror is the re-derived (cutoff-filtered) object, not the original raw read');
  const upsertedParent = toUpsert.find(s => s.sessionId === 'parent');
  assert.equal(upsertedParent.mergedIntoSessionId, undefined, 'the winner never gets mergedIntoSessionId set');
  assert.deepEqual(toTouch, []);
});

test('mergeBridgeGroups: a mirror whose re-derivation has nothing new since its predecessor is dropped, not upserted with stale duplicate content', () => {
  const parent = { sessionId: 'parent', created: '2026-09-03T21:15:40.535Z', modified: '2026-09-06T18:13:27.122Z', bridgeSessionId: 'cse_1' };
  const mirror = { sessionId: 'mirror', created: '2026-09-05T22:14:52.000Z', modified: '2026-09-06T18:13:34.167Z', bridgeSessionId: 'cse_1' };
  // Real fixture shape: post-cutoff content in the mirror was only cost-state
  // heartbeats (no timestamped message), so the cutoff-filtered re-derivation
  // has no summary/messageCount and readSessionFile would return null.
  const reread = () => null;
  const { toUpsert } = mergeBridgeGroups([], [parent, mirror], reread);
  assert.deepEqual(toUpsert.map(s => s.sessionId), ['parent'], 'mirror contributes nothing this pass and is not upserted at all');
});

test('mergeBridgeGroups: a mirror matching an already-cached parent is re-derived against the cached parent\'s modified, without rereading the parent', () => {
  const existing = [
    { sessionId: 'parent', created: '2026-09-03T21:15:40.535Z', modified: '2026-09-06T18:13:27.122Z', bridgeSessionId: 'cse_1', parentSessionId: null },
  ];
  const fresh = [
    { sessionId: 'mirror', created: '2026-09-05T22:14:52.000Z', modified: '2026-09-06T18:13:34.167Z', bridgeSessionId: 'cse_1' },
  ];
  const rereadCalls = [];
  const reread = (sessionId, cutoff) => {
    rereadCalls.push({ sessionId, cutoff });
    return { sessionId, created: fresh[0].created, modified: fresh[0].modified, bridgeSessionId: 'cse_1', messageCount: 3, dailyMetrics: [] };
  };
  const { toUpsert, toTouch } = mergeBridgeGroups(existing, fresh, reread);
  assert.deepEqual(rereadCalls, [{ sessionId: 'mirror', cutoff: existing[0].modified }],
    'the ALREADY-CACHED parent is never re-read -- only its stored modified is used as the cutoff');
  assert.equal(toUpsert.length, 1);
  assert.equal(toUpsert[0].sessionId, 'mirror');
  assert.equal(toUpsert[0].mergedIntoSessionId, 'parent');
  assert.deepEqual(toTouch, []);
});

test('mergeBridgeGroups: a freshly-discovered EARLIER file re-parents an already-cached later row without rereading it (out-of-order discovery)', () => {
  const existing = [
    { sessionId: 'was-cached-as-parent', created: '2026-09-05T22:14:52.000Z', modified: '2026-09-06T18:13:34.167Z', bridgeSessionId: 'cse_1', parentSessionId: null, mergedIntoSessionId: null },
  ];
  const fresh = [
    { sessionId: 'true-parent', created: '2026-09-03T21:15:40.535Z', modified: '2026-09-03T21:16:00.000Z', bridgeSessionId: 'cse_1' },
  ];
  const reread = () => { throw new Error('reread must not be called for the winner itself'); };
  const { toUpsert, toTouch } = mergeBridgeGroups(existing, fresh, reread);
  assert.deepEqual(toUpsert.map(s => s.sessionId), ['true-parent'], 'the genuinely earlier file becomes the winner, upserted as-is');
  assert.equal(toTouch.length, 1);
  assert.equal(toTouch[0].sessionId, 'was-cached-as-parent');
  assert.equal(toTouch[0].mergedIntoSessionId, 'true-parent',
    'the previously-cached row is re-parented via a lightweight touch, not re-read or deleted');
});

test('mergeBridgeGroups: subagents (parentSessionId set) are never grouped even with a shared bridgeSessionId', () => {
  const fresh = [
    { sessionId: 'top-level', created: '2026-01-01T00:00:00.000Z', modified: '2026-01-01T00:00:00.000Z', bridgeSessionId: 'cse_1', parentSessionId: null },
    { sessionId: 'sub:top-level:agent1', created: '2026-01-01T00:00:01.000Z', modified: '2026-01-01T00:00:01.000Z', bridgeSessionId: 'cse_1', parentSessionId: 'top-level' },
  ];
  const reread = () => { throw new Error('reread must not be called'); };
  const { toUpsert, toTouch } = mergeBridgeGroups([], fresh, reread);
  assert.deepEqual(toUpsert.map(s => s.sessionId).sort(), ['sub:top-level:agent1', 'top-level'],
    'a subagent transcript never competes with its parent for the same bridgeSessionId group');
  assert.deepEqual(toTouch, []);
});
