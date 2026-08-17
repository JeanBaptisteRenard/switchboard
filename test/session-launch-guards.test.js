// Guards on the session launch path, both reported from the same failure:
// enabling Worktree globally and opening a session in a non-git folder made
// claude refuse to start, and the placeholder card that failure left behind
// could then never be relaunched.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isGitRepo, sessionTranscriptExists } = require('../derive-project-path');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sb-launch-'));
}

test('isGitRepo: true at a repo root and anywhere beneath it', () => {
  const root = tmpdir();
  fs.mkdirSync(path.join(root, '.git'));
  const deep = path.join(root, 'a', 'b', 'c');
  fs.mkdirSync(deep, { recursive: true });
  assert.equal(isGitRepo(root), true);
  assert.equal(isGitRepo(deep), true, 'a subdirectory is still inside the working tree');
  fs.rmSync(root, { recursive: true, force: true });
});

test('isGitRepo: a .git FILE counts — worktrees and submodules use one', () => {
  const root = tmpdir();
  fs.writeFileSync(path.join(root, '.git'), 'gitdir: /elsewhere/.git/worktrees/wt\n');
  assert.equal(isGitRepo(root), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('isGitRepo: false for a plain directory and for one that does not exist', () => {
  const root = tmpdir();
  assert.equal(isGitRepo(root), false, 'this is the reported case — a non-git project folder');
  assert.equal(isGitRepo(path.join(root, 'missing')), false);
  assert.equal(isGitRepo(''), false);
  assert.equal(isGitRepo(null), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('sessionTranscriptExists: finds a transcript in any project folder', () => {
  const projects = tmpdir();
  fs.mkdirSync(path.join(projects, '-home-u-a'), { recursive: true });
  fs.mkdirSync(path.join(projects, '-home-u-b'), { recursive: true });
  fs.writeFileSync(path.join(projects, '-home-u-b', 'abc.jsonl'), '{}\n');
  assert.equal(sessionTranscriptExists(projects, 'abc'), true, 'scans every folder, not just the expected one');
  fs.rmSync(projects, { recursive: true, force: true });
});

test('sessionTranscriptExists: false for a placeholder session that never started', () => {
  const projects = tmpdir();
  fs.mkdirSync(path.join(projects, '-home-u-a'), { recursive: true });
  // The regression: the sidebar shows a card for this id, but claude exited
  // before writing anything, so resuming it can only ever fail.
  assert.equal(sessionTranscriptExists(projects, 'never-started'), false);
  assert.equal(sessionTranscriptExists(projects, ''), false);
  assert.equal(sessionTranscriptExists('/nonexistent', 'x'), false, 'unreadable dir must not throw');
  fs.rmSync(projects, { recursive: true, force: true });
});

// --- Static guards on main.js (not require()-able under node:test) ---

test('main.js: a session with no transcript is started, not resumed', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(src, /const startsFresh = isNew/, 'launch path must decide start-vs-resume explicitly');
  assert.match(src, /sessionTranscriptExists\(PROJECTS_DIR, sessionId\)/,
    'the decision must be based on the transcript actually existing');
  assert.match(src, /} else if \(startsFresh\) \{\s*\n\s*claudeArgs\.push\('--session-id'/,
    'a fresh start must pass --session-id, reusing the id the sidebar shows');
  // A fork resumes its source by design and must not be diverted.
  assert.match(src, /sessionOptions\?\.forkFrom\) \{\s*\n\s*claudeArgs\.push\('--resume'/,
    'forking must still resume its source');
});

test('main.js: --worktree is dropped in a non-git directory instead of failing the launch', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(src, /sessionOptions\.worktree && !isGitRepo\(spawnCwd\)/,
    'the flag must be gated on the spawn directory being a git repo');
  const idx = src.indexOf('!isGitRepo(spawnCwd)');
  const block = src.slice(idx, idx + 600);
  assert.match(block, /log\.warn/, 'dropping the flag must be recorded, not silent');
  assert.doesNotMatch(block.split('} else if')[0], /claudeArgs\.push\('--worktree'\)/,
    'the non-git branch must not push --worktree');
});
