// Wiring checks for the Delete Session action.
//
// The guards themselves — id validation, symlink resolution, containment within
// PROJECTS_DIR, target selection — are EXECUTED against real paths and symlinks
// in test/delete-session-target.test.js. Regex-matching main.js proved nothing:
// the review neutered the containment check while leaving the matched substring
// in place and every assertion here still passed. What remains below is only
// what cannot be reached without electron: that the handler is wired to the
// extracted module, cleans up the rows it owns, and that the UI confirms.

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


test('delete-session: refuses while the session still has a live PTY', () => {
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const start = main.indexOf("ipcMain.handle('delete-session'");
  const body = main.slice(start, main.indexOf('\n});', start));
  assert.match(body, /activeSessions\.has\(id\)[\s\S]*?exited/,
    'a running session must be refused rather than deleted underneath itself');
  assert.match(body, /still running/, 'the refusal must say why');
});



test('delete-session: clears the caches so the row does not reappear', () => {
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const start = main.indexOf("ipcMain.handle('delete-session'");
  const body = main.slice(start, main.indexOf('\n});', start));
  // Cleared for the parent and every subagent in one loop.
  assert.match(body, /deleteCachedSession\(sid\)/, 'session cache rows must go');
  assert.match(body, /deleteSearchSession\(sid\)/, 'search index entries must go');
});

test('delete button: rendered on session cards and confirms before deleting', () => {
  const sidebar = fs.readFileSync(path.join(ROOT, 'public', 'sidebar.js'), 'utf8');
  assert.match(sidebar, /deleteBtn\.className = 'session-delete-btn'/);
  assert.match(sidebar, /actions\.appendChild\(deleteBtn\)/, 'the button must actually be placed on the card');

  const start = sidebar.indexOf("item.querySelector('.session-delete-btn')");
  // Slice to the next handler rather than a fixed length — the block grew and a
  // fixed window silently dropped the assertions off the end.
  const handler = sidebar.slice(start, sidebar.indexOf('const archiveBtn', start));
  assert.match(handler, /await showDeleteSessionDialog\(session\)/,
    'an irreversible action must be confirmed, via the styled dialog');
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
  // The cache clearing happens just above, for the parent and its subagents
  // alike, so it covers the placeholder case without repeating itself.
  assert.match(body, /for \(const sid of \[id, \.\.\.subagentIds\]\)/,
    'caches must still be cleared for a placeholder');
});

test('delete-session: delegates its guards to the executable module', () => {
  const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  assert.match(src, /require\('\.\/delete-session-target'\)/,
    'validation must live in the module the tests can execute, not inline in main.js');
  const start = src.indexOf("ipcMain.handle('delete-session'");
  const body = src.slice(start, src.indexOf('\n});', start));
  assert.match(body, /resolveDeletionTargets\(PROJECTS_DIR, id, folder\)/);
  assert.match(body, /getCachedFolder\(id\)/, 'the cached folder makes the lookup O(1)');
  assert.match(body, /resolved\.refused/, 'a refused target must be logged, not silently dropped');
});

test('delete-session: clears subagent rows, which are indexed under their own ids', () => {
  const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const start = src.indexOf("ipcMain.handle('delete-session'");
  const body = src.slice(start, src.indexOf('\n});', start));

  // Subagent transcripts live inside the parent directory and go with it, but
  // they are cached under `sub:<parent>:<agent>` ids. Left behind, the sidebar
  // renders them as a phantom "Orphan subagents" group and search returns hits
  // for deleted files.
  assert.match(body, /getCachedByParent\(id\)/, 'subagent rows must be collected');
  const collect = body.indexOf('getCachedByParent(id)');
  const remove = body.indexOf('fs.rmSync');
  assert.ok(collect < remove, 'they must be collected BEFORE the files are removed');
  assert.match(body, /for \(const sid of \[id, \.\.\.subagentIds\]\)/,
    'the parent and every subagent row must be cleared');
});

test('delete button: uses the styled dialog, not a renderer-blocking native prompt', () => {
  const sidebar = fs.readFileSync(path.join(ROOT, 'public', 'sidebar.js'), 'utf8');
  assert.match(sidebar, /async function showDeleteSessionDialog/, 'the dialog must exist');
  assert.doesNotMatch(sidebar, /window\.confirm\(/,
    'confirm() blocks the whole renderer, including every other live terminal');

  const start = sidebar.indexOf('async function showDeleteSessionDialog');
  const dlg = sidebar.slice(start, sidebar.indexOf('// --- Delete worktree', start));
  assert.match(dlg, /deleteSessionPreview/, 'it must state what will be lost');
  assert.match(dlg, /Archive/, 'and point at the non-destructive alternative');
  assert.match(dlg, /Escape/, 'Esc must cancel, like the worktree dialog');
});

test('delete button: closes the tab so it cannot point at a deleted transcript', () => {
  const sidebar = fs.readFileSync(path.join(ROOT, 'public', 'sidebar.js'), 'utf8');
  const start = sidebar.indexOf("item.querySelector('.session-delete-btn')");
  const handler = sidebar.slice(start, sidebar.indexOf('const archiveBtn', start));
  assert.match(handler, /destroySession\(session\.sessionId\)/);
});
