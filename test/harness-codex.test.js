const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const codex = require('../harnesses/codex');

// A rollout in the shape codex actually writes. Both event families are present
// because real transcripts carry both: `response_item` messages hold the text,
// and older codex versions ALSO emit `event_msg` copies of the same turns.
function rollout({ id, cwd, turns, meta }) {
  const lines = [
    { timestamp: '2026-08-26T10:00:00.000Z', type: 'session_meta',
      payload: { session_id: 'lineage-root', id: 'lineage-root', cwd, cli_version: '0.149.1', ...meta } },
    { timestamp: '2026-08-26T10:00:00.100Z', type: 'event_msg',
      payload: { type: 'task_started', turn_id: 't1' } },
    { timestamp: '2026-08-26T10:00:01.000Z', type: 'response_item',
      payload: { type: 'message', role: 'developer', content: [{ type: 'text', text: '<skills_instructions>…' }] } },
    { timestamp: '2026-08-26T10:00:01.100Z', type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'text', text: '<environment_context>\n  <cwd>' + cwd + '</cwd>\n</environment_context>' }] } },
  ];
  let t = 2;
  for (const [role, text] of turns) {
    lines.push({ timestamp: `2026-08-26T10:00:${String(t++).padStart(2, '0')}.000Z`,
      type: 'response_item', payload: { type: 'message', role, content: [{ type: 'text', text }] } });
    // The duplicate event_msg copy that must NOT be double-counted.
    lines.push({ timestamp: `2026-08-26T10:00:${String(t++).padStart(2, '0')}.000Z`,
      type: 'event_msg',
      payload: { type: role === 'user' ? 'user_message' : 'agent_message', message: text } });
  }
  return lines.map(l => JSON.stringify(l)).join('\n') + '\n';
}

function withFixture(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-fixture-'));
  try {
    for (const [name, body] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), body, 'utf8');
    }
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const ID = '01a03f6c-fdf9-7c83-86e3-c388f81d765c';
const NAME = `rollout-2026-08-26T11-55-02-${ID}.jsonl`;

test('parses a rollout into the shape the cache expects', () => {
  withFixture({ [NAME]: rollout({
    cwd: '/Users/me/proj',
    turns: [['user', 'fix the parser'], ['assistant', 'done'], ['user', 'thanks']],
  }) }, (dir) => {
    const s = codex.readSessionFile(path.join(dir, NAME), 'codex/2026/08/26');
    assert.equal(s.sessionId, ID);
    assert.equal(s.projectPath, '/Users/me/proj');
    assert.equal(s.runtime, 'codex');
    assert.equal(s.summary, 'fix the parser');
    assert.equal(s.sessionFile, path.join(dir, NAME));
    assert.equal(s.folder, 'codex/2026/08/26');
    // 3 real turns. The developer message and the <environment_context> user
    // message are scaffolding, and the event_msg copies are duplicates.
    assert.equal(s.messageCount, 3);
    assert.ok(s.textContent.includes('fix the parser'));
    assert.ok(!s.textContent.includes('skills_instructions'));
  });
});

test('the session id comes from the file name, not session_meta', () => {
  // session_meta.session_id is the lineage root and is repeated across every
  // resume of a conversation — using it would collide on the primary key.
  withFixture({ [NAME]: rollout({ cwd: '/p', turns: [['user', 'hi']] }) }, (dir) => {
    const s = codex.readSessionFile(path.join(dir, NAME), 'f');
    assert.equal(s.sessionId, ID);
    assert.notEqual(s.sessionId, 'lineage-root');
  });
});

test('injected user turns never become the summary', () => {
  for (const tag of ['environment_context', 'recommended_plugins', 'turn_aborted', 'transcript']) {
    withFixture({ [NAME]: rollout({ cwd: '/p', turns: [
      ['user', `<${tag}>\nnoise\n</${tag}>`], ['user', 'the real question'],
    ] }) }, (dir) => {
      const s = codex.readSessionFile(path.join(dir, NAME), 'f');
      assert.equal(s.summary, 'the real question', tag);
      assert.equal(s.messageCount, 1, tag);
    });
  }
});

test('a session with no user turn is skipped', () => {
  // Launched, then abandoned before saying anything — nothing to show.
  withFixture({ [NAME]: rollout({ cwd: '/p', turns: [] }) }, (dir) => {
    assert.equal(codex.readSessionFile(path.join(dir, NAME), 'f'), null);
  });
});

test('a rollout with no cwd is skipped — there is no project to file it under', () => {
  const body = JSON.stringify({ timestamp: '2026-08-26T10:00:00Z', type: 'session_meta', payload: { session_id: 'x' } }) + '\n'
    + JSON.stringify({ timestamp: '2026-08-26T10:00:01Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'text', text: 'hi' }] } }) + '\n';
  withFixture({ [NAME]: body }, (dir) => {
    assert.equal(codex.readSessionFile(path.join(dir, NAME), 'f'), null);
  });
});

test('a truncated or corrupt line does not lose the rest of the session', () => {
  const good = rollout({ cwd: '/p', turns: [['user', 'first'], ['assistant', 'ok']] });
  const body = good.trimEnd() + '\n{"type":"response_item","payload":{"type":"mess\n';
  withFixture({ [NAME]: body }, (dir) => {
    const s = codex.readSessionFile(path.join(dir, NAME), 'f');
    assert.equal(s.summary, 'first');
    assert.equal(s.messageCount, 2);
  });
});

test('created and modified come from the transcript, not the file', () => {
  withFixture({ [NAME]: rollout({ cwd: '/p', turns: [['user', 'a'], ['assistant', 'b']] }) }, (dir) => {
    const s = codex.readSessionFile(path.join(dir, NAME), 'f');
    assert.equal(s.created, '2026-08-26T10:00:00.000Z');
    assert.ok(s.modified > s.created);
    assert.ok(s.fileMtime, 'fileMtime is the cache invalidation key and must be set');
  });
});

test('only rollout files are listed, and ids are read without opening them', () => {
  withFixture({
    [NAME]: 'ignored',
    'notes.jsonl': 'ignored',
    'rollout-broken.jsonl': 'ignored',
  }, (dir) => {
    const found = codex.listTranscripts(dir);
    assert.deepEqual(found.map(f => path.basename(f)), [NAME]);
    assert.equal(codex.sessionIdFromPath(found[0]), ID);
    assert.equal(codex.sessionIdFromPath('/x/notes.jsonl'), null);
  });
});

test('a codex transcript can only be found through sessionFile', () => {
  // The path carries a timestamp and a date directory, so unlike Claude it
  // cannot be rebuilt from the session id.
  assert.equal(codex.transcriptPath({ sessionId: ID, sessionFile: '/a/b.jsonl' }), '/a/b.jsonl');
  assert.equal(codex.transcriptPath({ sessionId: ID }), null);
});

test('folder keys are date paths under the codex prefix', () => {
  assert.equal(codex.folderPrefix, 'codex/');
  assert.equal(codex.groupsByProject, false);
  assert.equal(codex.deriveProjectPath('/anything'), null);
  assert.ok(codex.folderPath('2026/08/26').endsWith(path.join('sessions', '2026', '08', '26')));
});

test('CODEX_HOME relocates the sessions root', () => {
  const prev = process.env.CODEX_HOME;
  try {
    process.env.CODEX_HOME = '/tmp/elsewhere';
    assert.equal(codex.sessionsRoot(), path.join('/tmp/elsewhere', 'sessions'));
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
  }
});

// --- launch ---

test('resuming names the session id as a subcommand argument', () => {
  assert.deepEqual(
    codex.buildLaunchArgs({ sessionId: ID, isNew: false, options: {} }),
    ['resume', ID]
  );
});

test('forking uses the fork subcommand against the source session', () => {
  assert.deepEqual(
    codex.buildLaunchArgs({ sessionId: 'new', isNew: true, options: { forkFrom: ID } }),
    ['fork', ID]
  );
});

test('a new session passes no id — codex will not accept a pre-assigned one', () => {
  assert.deepEqual(codex.buildLaunchArgs({ sessionId: ID, isNew: true, options: {} }), []);
});

test("Claude-only options are ignored, not translated", () => {
  // These reach every harness because the renderer sends one options bag. codex
  // has no equivalent flags, and an unknown flag would fail the launch outright.
  const args = codex.buildLaunchArgs({
    sessionId: ID, isNew: false,
    options: { permissionMode: 'plan', worktree: true, worktreeName: 'wt', chrome: true,
      appendSystemPrompt: 'hi', mcpEmulation: true },
  });
  assert.deepEqual(args, ['resume', ID]);
});

test('enumerated options are validated against what the CLI accepts', () => {
  // Stored settings outlive the codex version that understood them, and they
  // reach a shell command line — neither a stale nor a hostile value may pass.
  for (const bad of ['--dangerously-bypass-approvals-and-sandbox', 'full-access', '', null, 'x; rm -rf /']) {
    assert.deepEqual(
      codex.buildLaunchArgs({ sessionId: ID, isNew: false, options: { codexSandbox: bad, codexApproval: bad } }),
      ['resume', ID], String(bad)
    );
  }
  assert.deepEqual(
    codex.buildLaunchArgs({ sessionId: ID, isNew: false,
      options: { codexSandbox: 'workspace-write', codexApproval: 'never' } }),
    ['resume', ID, '--sandbox', 'workspace-write', '--ask-for-approval', 'never']
  );
});

test('skipping permissions replaces the sandbox and approval flags', () => {
  // Passing both a bypass and a sandbox policy is contradictory.
  const args = codex.buildLaunchArgs({
    sessionId: ID, isNew: false,
    options: { dangerouslySkipPermissions: true, codexSandbox: 'read-only', codexApproval: 'never' },
  });
  assert.deepEqual(args, ['resume', ID, '--dangerously-bypass-approvals-and-sandbox']);
});

test('addDirs splits and trims the same way Claude does', () => {
  assert.deepEqual(
    codex.buildLaunchArgs({ sessionId: ID, isNew: false, options: { addDirs: ' /one , , /two ' } }),
    ['resume', ID, '--add-dir', '/one', '--add-dir', '/two']
  );
});

test('every flag codex is launched with is one the CLI declares', () => {
  // Guards against a flag being invented here that codex does not have.
  const KNOWN = new Set(['--sandbox', '--ask-for-approval', '--model', '--add-dir',
    '--dangerously-bypass-approvals-and-sandbox']);
  const args = codex.buildLaunchArgs({
    sessionId: ID, isNew: false,
    options: { codexSandbox: 'read-only', codexApproval: 'on-request', codexModel: 'gpt-5', addDirs: '/x' },
  });
  for (const a of args) {
    if (a.startsWith('--')) assert.ok(KNOWN.has(a), `unknown flag ${a}`);
  }
});

// --- sub-agent threads ---
//
// codex records sub-agent threads as ordinary rollouts, but refuses to resume
// one: "cannot resume an unloaded multi-agent v2 sub-agent through its parent".
// Indexing them would put rows in the sidebar whose only action always fails.

test('a sub-agent rollout is not indexed, however it is marked', () => {
  const markers = [
    { thread_source: 'subagent' },
    { parent_thread_id: '01a03d4c-b489-7181-b611-9e3f161866a0' },
    { agent_path: '/root/researcher' },
    { agent_nickname: 'Feynman' },
  ];
  for (const meta of markers) {
    withFixture({ [NAME]: rollout({ cwd: '/p', turns: [['user', 'hi']], meta }) }, (dir) => {
      assert.equal(codex.readSessionFile(path.join(dir, NAME), 'f'), null, JSON.stringify(meta));
    });
  }
});

test('a top-level session is still indexed when the markers are absent', () => {
  // thread_source is missing entirely on older rollouts, and 'user' on new ones.
  for (const meta of [{}, { thread_source: 'user' }]) {
    withFixture({ [NAME]: rollout({ cwd: '/p', turns: [['user', 'hi']], meta }) }, (dir) => {
      const s = codex.readSessionFile(path.join(dir, NAME), 'f');
      assert.ok(s, JSON.stringify(meta));
      assert.equal(s.sessionId, ID);
    });
  }
});

test('a fork is a real session — forked_from_id alone is not a sub-agent marker', () => {
  withFixture({ [NAME]: rollout({
    cwd: '/p', turns: [['user', 'hi']], meta: { forked_from_id: 'some-parent' },
  }) }, (dir) => {
    assert.ok(codex.readSessionFile(path.join(dir, NAME), 'f'));
  });
});
