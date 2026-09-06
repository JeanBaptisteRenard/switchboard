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
 * discarded: every member of a bridgeSessionId group keeps its own
 * session_cache row, but every member except the earliest-created has its
 * own contribution recomputed excluding anything at or before its immediate
 * predecessor's `modified` -- exactly the recopied overlap, no more.
 *
 * A row already being cached is NOT proof its contribution is already
 * deduplicated: a mirror can be indexed (and given a real session_cache row)
 * before its parent is known at all, in which case it is read with no
 * cutoff. `mergeBridgeGroups` re-derives ANY non-winner group member whose
 * recorded `mergedIntoSessionId` disagrees with the winner just computed --
 * fresh or already-cached -- which is exactly what closes that gap; see the
 * "already cached WITHOUT a cutoff" tests below.
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
  const { toUpsert, toDelete } = mergeBridgeGroups([], fresh, () => { throw new Error('reread must not be called'); });
  assert.deepEqual(toUpsert, fresh);
  assert.deepEqual(toDelete, []);
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
  const { toUpsert, toDelete } = mergeBridgeGroups([], [parent, mirror, independent], reread);
  assert.deepEqual(rereadCalls, [{ sessionId: 'mirror', cutoff: parent.modified }],
    'reread is called exactly once, for the later member, with the earlier member\'s modified as cutoff');
  assert.deepEqual(toUpsert.map(s => s.sessionId).sort(), ['independent', 'mirror', 'parent'],
    'every member keeps its own row -- nothing is dropped');
  const upsertedMirror = toUpsert.find(s => s.sessionId === 'mirror');
  assert.equal(upsertedMirror.mergedIntoSessionId, 'parent');
  assert.equal(upsertedMirror.messageCount, 2, 'the upserted mirror is the re-derived (cutoff-filtered) object, not the original raw read');
  const upsertedParent = toUpsert.find(s => s.sessionId === 'parent');
  assert.equal(upsertedParent.mergedIntoSessionId, undefined, 'the winner never gets mergedIntoSessionId set');
  assert.deepEqual(toDelete, []);
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
  const { toUpsert, toDelete } = mergeBridgeGroups(existing, fresh, reread);
  assert.deepEqual(rereadCalls, [{ sessionId: 'mirror', cutoff: existing[0].modified }],
    'the ALREADY-CACHED parent is never re-read -- only its stored modified is used as the cutoff');
  assert.equal(toUpsert.length, 1);
  assert.equal(toUpsert[0].sessionId, 'mirror');
  assert.equal(toUpsert[0].mergedIntoSessionId, 'parent');
  assert.deepEqual(toDelete, []);
});

test('mergeBridgeGroups: a mirror already cached WITHOUT a cutoff (indexed before its parent was known) is re-derived, not merely stamped with mergedIntoSessionId', () => {
  // The exact bug caught in review: the mirror was discovered and fully
  // indexed (mergedIntoSessionId=null, full uncut messageCount) before its
  // parent ever entered the cache -- reachable via refreshFolder's targeted
  // path when the watcher's dirty-file batch names only the mirror (e.g. a
  // brand-new project folder whose cold-start scan hasn't reached it yet).
  // Once the parent is later discovered, a mere mergedIntoSessionId patch
  // would leave the mirror's stale, never-deduplicated messageCount/
  // session_metrics in place -- the exact double-count this fix exists to
  // close, just reached from the other file.
  const existing = [
    {
      sessionId: 'mirror', created: '2026-09-05T22:14:52.000Z', modified: '2026-09-06T18:13:34.167Z',
      bridgeSessionId: 'cse_1', parentSessionId: null, mergedIntoSessionId: null,
      messageCount: 4, // stale: includes the recopied prefix, never cutoff-filtered
    },
  ];
  const fresh = [
    { sessionId: 'parent', created: '2026-09-03T21:15:40.535Z', modified: '2026-09-03T21:16:00.000Z', bridgeSessionId: 'cse_1' },
  ];
  const rereadCalls = [];
  const reread = (sessionId, cutoff) => {
    rereadCalls.push({ sessionId, cutoff });
    return { sessionId: 'mirror', created: existing[0].created, modified: existing[0].modified, bridgeSessionId: 'cse_1', messageCount: 2, dailyMetrics: [] };
  };
  const { toUpsert, toDelete } = mergeBridgeGroups(existing, fresh, reread);
  assert.deepEqual(rereadCalls, [{ sessionId: 'mirror', cutoff: fresh[0].modified }],
    'the mirror IS re-read -- its cached mergedIntoSessionId (null) disagrees with the computed winner (parent)');
  const upsertedMirror = toUpsert.find(s => s.sessionId === 'mirror');
  assert.ok(upsertedMirror, 'the mirror is re-upserted with corrected content');
  assert.equal(upsertedMirror.messageCount, 2, 'its stale, never-deduplicated messageCount (4) is replaced by the cutoff-filtered re-derivation (2)');
  assert.equal(upsertedMirror.mergedIntoSessionId, 'parent');
  assert.deepEqual(toDelete, []);
});

test('mergeBridgeGroups: a mirror already cached without a cutoff, whose re-derivation finds nothing new, is deleted rather than left stale', () => {
  const existing = [
    {
      sessionId: 'mirror', created: '2026-09-05T22:14:52.000Z', modified: '2026-09-06T18:13:34.167Z',
      bridgeSessionId: 'cse_1', parentSessionId: null, mergedIntoSessionId: null, messageCount: 4,
    },
  ];
  const fresh = [
    { sessionId: 'parent', created: '2026-09-03T21:15:40.535Z', modified: '2026-09-06T18:13:34.167Z', bridgeSessionId: 'cse_1' },
  ];
  const reread = () => null; // nothing survives once the correct cutoff is applied
  const { toUpsert, toDelete } = mergeBridgeGroups(existing, fresh, reread);
  assert.ok(!toUpsert.some(s => s.sessionId === 'mirror'), 'the mirror is not re-upserted with stale content');
  assert.deepEqual(toDelete, ['mirror'], 'the stale row is actively removed, not left with its pre-cutoff messageCount');
});

test('mergeBridgeGroups: a mirror whose stored mergedIntoSessionId already matches the computed winner is left untouched (no repeat reread on routine passes)', () => {
  const existing = [
    { sessionId: 'parent', created: '2026-09-03T21:15:40.535Z', modified: '2026-09-03T21:16:00.000Z', bridgeSessionId: 'cse_1', parentSessionId: null, mergedIntoSessionId: null },
    { sessionId: 'mirror', created: '2026-09-05T22:14:52.000Z', modified: '2026-09-05T22:15:05.000Z', bridgeSessionId: 'cse_1', parentSessionId: null, mergedIntoSessionId: 'parent' },
  ];
  // Neither file changed this pass -- freshRows is unrelated to this group.
  const fresh = [
    { sessionId: 'unrelated', created: '2026-01-01T00:00:00.000Z', modified: '2026-01-01T00:00:00.000Z', bridgeSessionId: null },
  ];
  const reread = () => { throw new Error('reread must not be called -- the mirror is already correctly derived against this exact winner'); };
  const { toUpsert, toDelete } = mergeBridgeGroups(existing, fresh, reread);
  assert.deepEqual(toUpsert.map(s => s.sessionId), ['unrelated']);
  assert.deepEqual(toDelete, []);
});

test('mergeBridgeGroups: a freshly-discovered EARLIER file demotes an already-cached later row, which is re-derived (not merely re-labelled) against the new winner', () => {
  const existing = [
    {
      sessionId: 'was-cached-as-parent', created: '2026-09-05T22:14:52.000Z', modified: '2026-09-06T18:13:34.167Z',
      bridgeSessionId: 'cse_1', parentSessionId: null, mergedIntoSessionId: null, messageCount: 5, // was winner: never had a cutoff
    },
  ];
  const fresh = [
    { sessionId: 'true-parent', created: '2026-09-03T21:15:40.535Z', modified: '2026-09-03T21:16:00.000Z', bridgeSessionId: 'cse_1' },
  ];
  const rereadCalls = [];
  const reread = (sessionId, cutoff) => {
    rereadCalls.push({ sessionId, cutoff });
    return { sessionId: 'was-cached-as-parent', created: existing[0].created, modified: existing[0].modified, bridgeSessionId: 'cse_1', messageCount: 3, dailyMetrics: [] };
  };
  const { toUpsert, toDelete } = mergeBridgeGroups(existing, fresh, reread);
  assert.deepEqual(toUpsert.map(s => s.sessionId).sort(), ['true-parent', 'was-cached-as-parent'],
    'the genuinely earlier file becomes the winner; the demoted row keeps its own row too');
  assert.deepEqual(rereadCalls, [{ sessionId: 'was-cached-as-parent', cutoff: fresh[0].modified }],
    'the demoted row is re-read with the new winner\'s modified as cutoff -- it never had one applied while it was itself the winner');
  const demoted = toUpsert.find(s => s.sessionId === 'was-cached-as-parent');
  assert.equal(demoted.messageCount, 3, 'its stale, never-deduplicated messageCount (5) is replaced, not merely re-labelled');
  assert.equal(demoted.mergedIntoSessionId, 'true-parent');
  assert.deepEqual(toDelete, []);
});

test('mergeBridgeGroups: a former child promoted to winner (its earlier sibling\'s file was deleted) is re-read in full, its stale mergedIntoSessionId cleared', () => {
  // Reachable via session deletion: 'was-parent' (the group's earliest file)
  // is removed from disk and its session_cache row deleted by the "file no
  // longer exists" cleanup elsewhere in refreshFolder, in the SAME pass this
  // group is re-evaluated. 'promoted' -- previously its cutoff-filtered
  // child -- is now the earliest remaining member, but its stored
  // messageCount (2, excluding what used to be 'was-parent`'s territory) is
  // an under-count now that nothing precedes it.
  const existing = [
    {
      sessionId: 'promoted', created: '2026-09-05T22:14:52.000Z', modified: '2026-09-05T22:15:05.000Z',
      bridgeSessionId: 'cse_1', parentSessionId: null, mergedIntoSessionId: 'was-parent', messageCount: 2,
    },
  ];
  const rereadCalls = [];
  const reread = (sessionId, cutoff) => {
    rereadCalls.push({ sessionId, cutoff });
    return { sessionId: 'promoted', created: existing[0].created, modified: existing[0].modified, bridgeSessionId: 'cse_1', messageCount: 4, dailyMetrics: [] };
  };
  const { toUpsert, toDelete } = mergeBridgeGroups(existing, [], reread);
  assert.deepEqual(rereadCalls, [{ sessionId: 'promoted', cutoff: null }],
    'the promoted winner is re-read with no cutoff at all -- nothing precedes it anymore');
  const upsertedPromoted = toUpsert.find(s => s.sessionId === 'promoted');
  assert.ok(upsertedPromoted);
  assert.equal(upsertedPromoted.messageCount, 4, 'its under-counted stored contribution (2) is replaced by the full re-read (4)');
  assert.equal(upsertedPromoted.mergedIntoSessionId, null, 'no longer merged into anything -- it is the winner now');
  assert.deepEqual(toDelete, []);
});

test('mergeBridgeGroups: a winner with no mergedIntoSessionId is left untouched even when it is the sole existing row this pass (no reread on a routine call)', () => {
  const existing = [
    { sessionId: 'parent', created: '2026-09-03T21:15:40.535Z', modified: '2026-09-03T21:16:00.000Z', bridgeSessionId: 'cse_1', parentSessionId: null, mergedIntoSessionId: null },
    { sessionId: 'mirror', created: '2026-09-05T22:14:52.000Z', modified: '2026-09-05T22:15:05.000Z', bridgeSessionId: 'cse_1', parentSessionId: null, mergedIntoSessionId: 'parent' },
  ];
  const reread = () => { throw new Error('reread must not be called -- nothing about this settled group changed'); };
  const { toUpsert, toDelete } = mergeBridgeGroups(existing, [], reread);
  assert.deepEqual(toUpsert, []);
  assert.deepEqual(toDelete, []);
});

test('mergeBridgeGroups: subagents (parentSessionId set) are never grouped even with a shared bridgeSessionId', () => {
  const fresh = [
    { sessionId: 'top-level', created: '2026-01-01T00:00:00.000Z', modified: '2026-01-01T00:00:00.000Z', bridgeSessionId: 'cse_1', parentSessionId: null },
    { sessionId: 'sub:top-level:agent1', created: '2026-01-01T00:00:01.000Z', modified: '2026-01-01T00:00:01.000Z', bridgeSessionId: 'cse_1', parentSessionId: 'top-level' },
  ];
  const reread = () => { throw new Error('reread must not be called'); };
  const { toUpsert, toDelete } = mergeBridgeGroups([], fresh, reread);
  assert.deepEqual(toUpsert.map(s => s.sessionId).sort(), ['sub:top-level:agent1', 'top-level'],
    'a subagent transcript never competes with its parent for the same bridgeSessionId group');
  assert.deepEqual(toDelete, []);
});
