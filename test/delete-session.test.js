// Coverage for the Delete Session action.
//
// This is the only action in the app that destroys user history, so the tests
// concentrate on the guards rather than the happy path: what it refuses, and
// that it cannot be steered outside ~/.claude/projects.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

test('delete-session: the IPC handler exists and is exposed to the renderer', () => {
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
  assert.match(main, /ipcMain\.handle\('delete-session'/);
  assert.match(preload, /deleteSession: \(id\) => ipcRenderer\.invoke\('delete-session', id\)/);
});

test('delete-session: refuses ids that are not plain filename components', () => {
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const start = main.indexOf("ipcMain.handle('delete-session'");
  const body = main.slice(start, main.indexOf('\n});', start));

  assert.match(body, /\^\[A-Za-z0-9\._-\]\+\$/, 'id must be validated against a strict character set');
  assert.match(body, /id === '\.'|id === '\.\.'/, 'dot segments must be rejected explicitly');

  // The regex is the real guard — check it rejects traversal and separators.
  const idRe = /^[A-Za-z0-9._-]+$/;
  for (const bad of ['../../etc/passwd', 'a/b', 'a\\b', '', 'a b', 'a;rm -rf /']) {
    assert.equal(idRe.test(bad), false, `must reject ${JSON.stringify(bad)}`);
  }
  assert.equal(idRe.test('57cf3347-04e1-485f-8063-4d8700785fba'), true, 'a real session id must pass');
});

test('delete-session: refuses while the session still has a live PTY', () => {
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const start = main.indexOf("ipcMain.handle('delete-session'");
  const body = main.slice(start, main.indexOf('\n});', start));
  assert.match(body, /activeSessions\.has\(id\)[\s\S]*?exited/,
    'a running session must be refused rather than deleted underneath itself');
  assert.match(body, /still running/, 'the refusal must say why');
});

test('delete-session: resolves symlinks and refuses anything outside PROJECTS_DIR', () => {
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const start = main.indexOf("ipcMain.handle('delete-session'");
  const body = main.slice(start, main.indexOf('\n});', start));
  assert.match(body, /realpathSync/, 'symlinks must be resolved before deleting');
  assert.match(body, /startsWith\(root \+ path\.sep\)/,
    'the resolved path must be confined to the projects directory');
  // The containment check itself, exercised directly.
  const root = '/home/u/.claude/projects';
  const inside = (p) => p === root || p.startsWith(root + path.sep);
  assert.equal(inside('/home/u/.claude/projects/-a/x.jsonl'), true);
  assert.equal(inside('/home/u/.ssh/id_rsa'), false);
  assert.equal(inside('/home/u/.claude/projects-evil/x'), false, 'prefix must not match a sibling directory');
});

test('delete-session: removes subagent transcripts with their parent', () => {
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const start = main.indexOf("ipcMain.handle('delete-session'");
  const body = main.slice(start, main.indexOf('\n});', start));
  assert.match(body, /path\.join\(base, id \+ '\.jsonl'\), path\.join\(base, id\)/,
    'both the transcript and the sibling <id>/ subagent directory must be targeted');
  assert.match(body, /recursive: true/, 'the subagent directory needs a recursive removal');
});

test('delete-session: clears the caches so the row does not reappear', () => {
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const start = main.indexOf("ipcMain.handle('delete-session'");
  const body = main.slice(start, main.indexOf('\n});', start));
  assert.match(body, /deleteCachedSession\(id\)/, 'session cache row must go');
  assert.match(body, /deleteSearchSession\(id\)/, 'search index entry must go');
});

test('delete button: rendered on session cards and confirms before deleting', () => {
  const sidebar = fs.readFileSync(path.join(ROOT, 'public', 'sidebar.js'), 'utf8');
  assert.match(sidebar, /deleteBtn\.className = 'session-delete-btn'/);
  assert.match(sidebar, /actions\.appendChild\(deleteBtn\)/, 'the button must actually be placed on the card');

  const start = sidebar.indexOf("item.querySelector('.session-delete-btn')");
  // Slice to the next handler rather than a fixed length — the block grew and a
  // fixed window silently dropped the assertions off the end.
  const handler = sidebar.slice(start, sidebar.indexOf('const archiveBtn', start));
  assert.match(handler, /window\.confirm\(/, 'an irreversible action must be confirmed');
  assert.match(handler, /cannot be undone/, 'the prompt must state that it is irreversible');
  assert.match(handler, /stopSession/, 'a running session must be stopped before deletion');
  assert.match(handler, /window\.api\.deleteSession/);
  assert.doesNotMatch(handler, /window\.alert\(/,
    'alert() is modal and hard to dismiss — a failure must not block the renderer');
  assert.match(handler, /flashButtonText\(deleteBtn, 'Failed'/, 'a refusal must still surface on the button');
  assert.match(handler, /pendingSessions\.delete\(session\.sessionId\)/,
    'the sidebar re-injects transcript-less sessions, so the pending entry must be forgotten too');

  const css = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
  assert.match(css, /\.session-delete-btn:hover \{/, 'delete should read as danger on hover');
});

test('delete-session: a session with no transcript is dismissed, not refused', () => {
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const start = main.indexOf("ipcMain.handle('delete-session'");
  const body = main.slice(start, main.indexOf('\n});', start));

  // Regression: launchNewSession shows a card before claude starts, so a failed
  // launch leaves a session with nothing on disk. Refusing those made the very
  // cards a user wants gone undeletable ("no transcript found for that session").
  assert.match(body, /if \(!removed\.length\) \{/, 'the empty case must be handled explicitly');
  const empty = body.slice(body.indexOf('if (!removed.length) {'));
  assert.match(empty, /ok: true/, 'a placeholder must be reported as deleted, not as a failure');
  assert.match(empty, /placeholder: true/, 'the caller should be able to tell the two apart');
  assert.match(empty, /deleteCachedSession\(id\)/, 'caches must still be cleared');
});
