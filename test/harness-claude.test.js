const { test } = require('node:test');
const assert = require('node:assert/strict');

const claude = require('../harnesses/claude');
const { getHarness, DEFAULT_HARNESS, availableHarnesses } = require('../harnesses');

// buildLaunchArgs was lifted out of main.js's open-terminal handler. These pin
// the exact argv it used to build, so the move stays a move.

test('a new session pre-assigns its id', () => {
  assert.deepEqual(
    claude.buildLaunchArgs({ sessionId: 'abc', isNew: true, options: {} }),
    ['--session-id', 'abc']
  );
});

test('an existing session resumes', () => {
  assert.deepEqual(
    claude.buildLaunchArgs({ sessionId: 'abc', isNew: false, options: {} }),
    ['--resume', 'abc']
  );
});

test('forkFrom wins over both, and forks the source not the new id', () => {
  assert.deepEqual(
    claude.buildLaunchArgs({ sessionId: 'new', isNew: true, options: { forkFrom: 'src' } }),
    ['--resume', 'src', '--fork-session']
  );
});

test('dangerouslySkipPermissions suppresses permissionMode', () => {
  // Both set is a real state — the dialog can carry a stale mode alongside the
  // skip toggle — and passing both to claude is an error.
  const args = claude.buildLaunchArgs({
    sessionId: 'a', isNew: true,
    options: { dangerouslySkipPermissions: true, permissionMode: 'plan' },
  });
  assert.ok(args.includes('--dangerously-skip-permissions'));
  assert.ok(!args.includes('--permission-mode'));
});

test('--worktree is dropped on resume, kept on a new session', () => {
  // Resuming must reuse the session's existing directory; spinning up a fresh
  // worktree makes the attach fail.
  const resumed = claude.buildLaunchArgs({
    sessionId: 'a', isNew: false, options: { worktree: true, worktreeName: 'wt' },
  });
  assert.ok(!resumed.includes('--worktree'));

  const fresh = claude.buildLaunchArgs({
    sessionId: 'a', isNew: true, options: { worktree: true, worktreeName: 'wt' },
  });
  assert.deepEqual(fresh, ['--session-id', 'a', '--worktree', 'wt']);
});

test('addDirs splits on commas and trims, skipping empties', () => {
  const args = claude.buildLaunchArgs({
    sessionId: 'a', isNew: true, options: { addDirs: ' /one , , /two ' },
  });
  assert.deepEqual(args, ['--session-id', 'a', '--add-dir', '/one', '--add-dir', '/two']);
});

test('appendSystemPrompt goes last', () => {
  const args = claude.buildLaunchArgs({
    sessionId: 'a', isNew: true, options: { chrome: true, appendSystemPrompt: 'hi' },
  });
  assert.deepEqual(args.slice(-2), ['--append-system-prompt', 'hi']);
});

test('no options at all still produces a launchable argv', () => {
  assert.deepEqual(
    claude.buildLaunchArgs({ sessionId: 'a', isNew: true }),
    ['--session-id', 'a']
  );
});

// --- registry ---

test('an unknown or missing harness id falls back to Claude', () => {
  // Rows written before the harness column existed read back as null/undefined.
  assert.equal(getHarness(undefined).id, 'claude');
  assert.equal(getHarness(null).id, 'claude');
  assert.equal(getHarness('codex-from-the-future').id, 'claude');
  assert.equal(DEFAULT_HARNESS, 'claude');
});

test('transcriptPath prefers a stored sessionFile over reconstructing one', () => {
  // Claude names its files <sessionId>.jsonl, so the reconstruction is exact —
  // but codex does not, which is why the column exists.
  assert.equal(
    claude.transcriptPath({ sessionId: 'a', folder: 'f', sessionFile: '/stored/x.jsonl' }),
    '/stored/x.jsonl'
  );
  assert.ok(
    claude.transcriptPath({ sessionId: 'a', folder: 'f' }).endsWith('/f/a.jsonl')
  );
});

test('every registered harness implements the full shape', () => {
  const required = ['id', 'label', 'binary', 'available', 'sessionsRoot', 'listFolders',
    'folderPath', 'folderForProject', 'listTranscripts', 'transcriptPath',
    'readSessionFile', 'buildLaunchArgs'];
  for (const h of require('../harnesses').allHarnesses()) {
    for (const key of required) {
      assert.ok(h[key] !== undefined, `${h.id} is missing ${key}`);
    }
  }
});
