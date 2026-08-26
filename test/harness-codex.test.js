const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const codex = require('../harnesses/codex');

// A rollout in the shape codex actually writes. Both event families are present
// because real transcripts carry both: `response_item` messages hold the text,
// and older codex versions ALSO emit `event_msg` copies of the same turns.
function rollout({ id, cwd, turns }) {
  const lines = [
    { timestamp: '2026-08-26T10:00:00.000Z', type: 'session_meta',
      payload: { session_id: 'lineage-root', id: 'lineage-root', cwd, cli_version: '0.149.1' } },
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
