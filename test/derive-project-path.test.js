const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { deriveProjectPath, resolveWorktreePath } = require('../derive-project-path');

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-dpp-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test('resolveWorktreePath collapses /<repo>/.claude/worktrees/<name> back to <repo> when parent exists', () => {
  const tmp = mkTmp();
  try {
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    const worktree = path.join(repo, '.claude', 'worktrees', 'agent-abc');
    assert.equal(resolveWorktreePath(worktree), repo);
  } finally {
    cleanup(tmp);
  }
});

test('resolveWorktreePath collapses /<repo>/.claude-worktrees/<name> back to <repo>', () => {
  const tmp = mkTmp();
  try {
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    const worktree = path.join(repo, '.claude-worktrees', 'foo');
    assert.equal(resolveWorktreePath(worktree), repo);
  } finally {
    cleanup(tmp);
  }
});

test('resolveWorktreePath collapses /<repo>/.worktrees/<name> back to <repo>', () => {
  const tmp = mkTmp();
  try {
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    const worktree = path.join(repo, '.worktrees', 'bar');
    assert.equal(resolveWorktreePath(worktree), repo);
  } finally {
    cleanup(tmp);
  }
});

test('resolveWorktreePath handles trailing-slash variant', () => {
  const tmp = mkTmp();
  try {
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    const worktreeWithSlash = path.join(repo, '.worktrees', 'bar') + '/';
    assert.equal(resolveWorktreePath(worktreeWithSlash), repo);
  } finally {
    cleanup(tmp);
  }
});

test('resolveWorktreePath returns input unchanged when the parent dir does not exist on disk', () => {
  // /nonexistent-xyzzy-12345/.claude/worktrees/agent-foo — regex matches, but parent dir absent
  const fake = '/nonexistent-xyzzy-12345/.claude/worktrees/agent-foo';
  assert.equal(resolveWorktreePath(fake), fake);
});

test('resolveWorktreePath returns input unchanged when the path does not match the worktree pattern', () => {
  assert.equal(resolveWorktreePath('/repo/src/foo'), '/repo/src/foo');
  assert.equal(resolveWorktreePath('/repo/.claude/agents/foo'), '/repo/.claude/agents/foo');
  // Worktrees segment but two extra components (nested under worktree) — must not match
  assert.equal(resolveWorktreePath('/repo/.worktrees/foo/bar'), '/repo/.worktrees/foo/bar');
});

test('resolveWorktreePath passes falsy input through unchanged without throwing', () => {
  assert.equal(resolveWorktreePath(null), null);
  assert.equal(resolveWorktreePath(undefined), undefined);
  assert.equal(resolveWorktreePath(''), '');
});

test('deriveProjectPath end-to-end: jsonl with worktree cwd resolves to parent repo', () => {
  const tmp = mkTmp();
  try {
    // Real on-disk repo so existsSync returns true
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    const worktreeCwd = path.join(repo, '.claude', 'worktrees', 'agent-x');
    // worktreeCwd itself doesn't need to exist; only its derived parent does

    // The folder we feed deriveProjectPath is a "projects/foo" style dir
    // containing a single jsonl whose first cwd line points at the worktree.
    const folder = path.join(tmp, 'project-folder');
    fs.mkdirSync(folder);
    fs.writeFileSync(
      path.join(folder, 'session-1.jsonl'),
      JSON.stringify({ type: 'user', cwd: worktreeCwd }) + '\n',
      'utf8'
    );

    assert.equal(deriveProjectPath(folder), repo);
  } finally {
    cleanup(tmp);
  }
});

// ---------------------------------------------------------------------------
// Bounded 256 KB scan window tests
// extractCwdFromJsonl only reads the first 256 KB of a file to avoid
// reading giant live-session JSONLs on every watcher flush (witnessed
// 2026-06-11: 338 MB file, main thread ~65% CPU, UI freezes).
// ---------------------------------------------------------------------------

const CWD_SCAN_BYTES = 256 * 1024;

test('extractCwdFromJsonl: finds cwd on line 1 of a small file (< scan window)', () => {
  const tmp = mkTmp();
  try {
    const folder = path.join(tmp, 'folder');
    fs.mkdirSync(folder);
    const cwd = path.join(tmp, 'myproject');
    // Small file: one header line with cwd, then a few regular lines
    const lines = [
      JSON.stringify({ type: 'summary', cwd }),
      JSON.stringify({ type: 'user', message: 'hello' }),
      JSON.stringify({ type: 'assistant', message: 'hi' }),
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(folder, 'session.jsonl'), lines, 'utf8');
    assert.equal(deriveProjectPath(folder), cwd);
  } finally {
    cleanup(tmp);
  }
});

test('extractCwdFromJsonl: finds cwd when file is larger than 256 KB and cwd is on line 1', () => {
  const tmp = mkTmp();
  try {
    const folder = path.join(tmp, 'folder');
    fs.mkdirSync(folder);
    const cwd = path.join(tmp, 'bigproject');
    // First line: the header with cwd
    const header = JSON.stringify({ type: 'summary', cwd }) + '\n';
    // Filler lines to push the file well beyond the 256 KB scan window (~300 KB total).
    // Each filler line is ~100 chars; we need ~(300*1024 - header.length)/100 lines.
    const fillerLine = JSON.stringify({ type: 'assistant', message: 'x'.repeat(80) }) + '\n';
    const fillerCount = Math.ceil((300 * 1024 - header.length) / fillerLine.length) + 10;
    const filePath = path.join(folder, 'big-session.jsonl');
    // Write header first, then stream filler to avoid allocating a 300 KB string in memory
    fs.writeFileSync(filePath, header, 'utf8');
    const fd = fs.openSync(filePath, 'a');
    for (let i = 0; i < fillerCount; i++) {
      fs.writeSync(fd, fillerLine);
    }
    fs.closeSync(fd);
    assert.ok(fs.statSync(filePath).size > CWD_SCAN_BYTES, 'precondition: file must exceed scan window');
    assert.equal(deriveProjectPath(folder), cwd);
  } finally {
    cleanup(tmp);
  }
});

test('extractCwdFromJsonl: returns null when cwd only appears beyond the 256 KB scan window', () => {
  // Documented accepted trade-off: real Claude Code transcripts always carry
  // `cwd` on the very first JSONL line (the session-start summary record), so
  // a cwd that lives only past the scan window indicates a malformed or exotic
  // file that we deliberately do not support to avoid the re-read hot-loop.
  const tmp = mkTmp();
  try {
    const folder = path.join(tmp, 'folder');
    fs.mkdirSync(folder);
    const cwd = path.join(tmp, 'hidden-project');
    // Fill more than 256 KB with lines that have NO cwd field, then append
    // the one line that has cwd — it lands beyond the scan window.
    const noHeader = JSON.stringify({ type: 'assistant', message: 'x'.repeat(80) }) + '\n';
    const filePath = path.join(folder, 'late-cwd.jsonl');
    const fillerCount = Math.ceil((CWD_SCAN_BYTES + 1024) / noHeader.length) + 10;
    const fd = fs.openSync(filePath, 'w');
    for (let i = 0; i < fillerCount; i++) {
      fs.writeSync(fd, noHeader);
    }
    // cwd line is appended after the scan window
    fs.writeSync(fd, JSON.stringify({ type: 'summary', cwd }) + '\n');
    fs.closeSync(fd);
    assert.ok(fs.statSync(filePath).size > CWD_SCAN_BYTES, 'precondition: file must exceed scan window');
    assert.equal(deriveProjectPath(folder), null);
  } finally {
    cleanup(tmp);
  }
});

test('extractCwdFromJsonl: does not throw when the 256 KB boundary cuts a line mid-JSON', () => {
  // The scan reads exactly CWD_SCAN_BYTES and then drops the last (truncated)
  // line before parsing. This test verifies no exception leaks out even when
  // the cut produces a partial UTF-8 / partial JSON fragment.
  const tmp = mkTmp();
  try {
    const folder = path.join(tmp, 'folder');
    fs.mkdirSync(folder);
    const cwd = path.join(tmp, 'trunctest');
    // First line has a cwd so we get a real return value; the truncation
    // happens somewhere in the middle of a later line.
    const header = JSON.stringify({ type: 'summary', cwd }) + '\n';
    // Pack the file so the 256 KB boundary falls right inside a JSON object.
    // Use lines of known length so we can be precise: we want the total
    // written before the boundary to be CWD_SCAN_BYTES - 50, then a line that
    // is 200 chars long — the boundary slices it at byte 50.
    const body = 'x'.repeat(Math.max(0, CWD_SCAN_BYTES - header.length - 50));
    const almostFull = header + JSON.stringify({ type: 'filler', data: body }) + '\n';
    const longLine = JSON.stringify({ type: 'cut', data: 'y'.repeat(300) }) + '\n';
    fs.writeFileSync(path.join(folder, 'trunc.jsonl'), almostFull + longLine, 'utf8');
    // Must not throw; cwd on line 1 is within the window and should be returned
    let result;
    assert.doesNotThrow(() => { result = deriveProjectPath(folder); });
    assert.equal(result, cwd);
  } finally {
    cleanup(tmp);
  }
});
