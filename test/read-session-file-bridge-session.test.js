/**
 * Compaction-mirror dedup key (issue #197). See .ai/contexts/session-cache.md.
 *
 * A manual /compact leaves a second transcript ("mirror") for the same
 * session. Both transcripts carry a `{"type":"bridge-session", bridgeSessionId}`
 * record with the SAME bridgeSessionId -- that's the field these tests exist
 * to protect. Measured against the real pair on disk (issue #197): the
 * mirror's own bridge-session record sits near the END of its file (byte
 * ~3.08 MB of a 3.08 MB file), not near the head, and a substring search for
 * "bridgeSessionId" also matches unrelated pasted text inside a tool_result
 * in that same real mirror -- both are covered below.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { readSessionFile, readSessionDisplayHeader, resolveBridgeSessionWinners } = require('../read-session-file');

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

test('resolveBridgeSessionWinners: no bridgeSessionId anywhere never collapses rows', () => {
  const fresh = [
    { sessionId: 'a', created: '2026-01-01T00:00:00.000Z', bridgeSessionId: null },
    { sessionId: 'b', created: '2026-01-02T00:00:00.000Z', bridgeSessionId: null },
  ];
  const { toUpsert, toEvict } = resolveBridgeSessionWinners([], fresh);
  assert.deepEqual(toUpsert.map(s => s.sessionId).sort(), ['a', 'b']);
  assert.deepEqual(toEvict, []);
});

test('resolveBridgeSessionWinners: within one fresh batch, earliest created wins, later dropped', () => {
  const fresh = [
    { sessionId: 'mirror', created: '2026-09-05T22:14:52.000Z', bridgeSessionId: 'cse_1' },
    { sessionId: 'parent', created: '2026-09-03T21:15:40.535Z', bridgeSessionId: 'cse_1' },
    { sessionId: 'independent', created: '2026-09-04T00:00:00.000Z', bridgeSessionId: 'cse_2' },
  ];
  const { toUpsert, toEvict } = resolveBridgeSessionWinners([], fresh);
  assert.deepEqual(toUpsert.map(s => s.sessionId).sort(), ['independent', 'parent'],
    'mirror is dropped, parent (earliest created) and the differently-bridged session both survive');
  assert.deepEqual(toEvict, []);
});

test('resolveBridgeSessionWinners: a fresh mirror matching an already-cached parent is dropped, not upserted', () => {
  const existing = [
    { sessionId: 'parent', created: '2026-09-03T21:15:40.535Z', bridgeSessionId: 'cse_1', parentSessionId: null },
  ];
  const fresh = [
    { sessionId: 'mirror', created: '2026-09-05T22:14:52.000Z', bridgeSessionId: 'cse_1' },
  ];
  const { toUpsert, toEvict } = resolveBridgeSessionWinners(existing, fresh);
  assert.deepEqual(toUpsert, [], 'mirror never gets upserted');
  assert.deepEqual(toEvict, [], 'the existing parent row is untouched');
});

test('resolveBridgeSessionWinners: a freshly-discovered EARLIER file evicts an already-cached later row', () => {
  // Out-of-order discovery: the row already in the cache under this
  // bridgeSessionId turns out not to be the true parent once an earlier file
  // is read. Decided on `created`, not on which file was seen first.
  const existing = [
    { sessionId: 'was-cached-as-mirror', created: '2026-09-05T22:14:52.000Z', bridgeSessionId: 'cse_1', parentSessionId: null },
  ];
  const fresh = [
    { sessionId: 'true-parent', created: '2026-09-03T21:15:40.535Z', bridgeSessionId: 'cse_1' },
  ];
  const { toUpsert, toEvict } = resolveBridgeSessionWinners(existing, fresh);
  assert.deepEqual(toUpsert.map(s => s.sessionId), ['true-parent']);
  assert.deepEqual(toEvict, ['was-cached-as-mirror']);
});

test('resolveBridgeSessionWinners: subagents (parentSessionId set) are never grouped even with a shared bridgeSessionId', () => {
  const fresh = [
    { sessionId: 'top-level', created: '2026-01-01T00:00:00.000Z', bridgeSessionId: 'cse_1', parentSessionId: null },
    { sessionId: 'sub:top-level:agent1', created: '2026-01-01T00:00:01.000Z', bridgeSessionId: 'cse_1', parentSessionId: 'top-level' },
  ];
  const { toUpsert, toEvict } = resolveBridgeSessionWinners([], fresh);
  assert.deepEqual(toUpsert.map(s => s.sessionId).sort(), ['sub:top-level:agent1', 'top-level'],
    'a subagent transcript never competes with its parent for the same bridgeSessionId group');
  assert.deepEqual(toEvict, []);
});
