// test/ipc-path-validator.test.js — unit tests for the IPC path validation helper
//
// Tests the pure path-validation logic extracted from main.js.
// No Electron. The symlink-traversal tests below do real fs I/O against a
// temp directory (real symlinks/junctions, not string fixtures) — that class
// of bug does not show up against string paths that were never resolved on
// disk.
'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const os     = require('os');
const path   = require('path');
const fs     = require('fs');

const { isSensitivePath, isAllowedMemoryPath, resolveAllowedMemoryPath, isKnownProjectRoot } = require('../ipc-path-validator');

const HOME       = os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');

/** Temp dir rig for the symlink tests. Not nested under anything the app
 * would ever recursively delete — see .ai/shared-guidelines.md's warning
 * about junctions inside a directory a recursive delete could traverse. */
function symlinkRig() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-path-guard-')));
  const allowedRoot = path.join(root, 'allowed-root');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(allowedRoot, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  return { root, allowedRoot, outside, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** Try `fs.symlinkSync`, falling back to a Windows junction (per the
 * documented pitfall: symlinks can require elevation, junctions usually
 * don't). Returns true when either succeeded. */
function linkDir(target, linkPath) {
  try {
    fs.symlinkSync(target, linkPath, 'dir');
    return true;
  } catch {
    try {
      fs.symlinkSync(target, linkPath, 'junction');
      return true;
    } catch {
      return false;
    }
  }
}

// ── isSensitivePath ───────────────────────────────────────────────────────────

test('isSensitivePath: rejects ~/.ssh/id_rsa', () => {
  assert.equal(isSensitivePath(path.join(HOME, '.ssh', 'id_rsa')), true);
});

test('isSensitivePath: rejects ~/.ssh/ directory', () => {
  assert.equal(isSensitivePath(path.join(HOME, '.ssh', 'config')), true);
});

test('isSensitivePath: rejects ~/.gnupg/secring.gpg', () => {
  assert.equal(isSensitivePath(path.join(HOME, '.gnupg', 'secring.gpg')), true);
});

test('isSensitivePath: rejects ~/.aws/credentials', () => {
  assert.equal(isSensitivePath(path.join(HOME, '.aws', 'credentials')), true);
});

test('isSensitivePath: allows ~/.aws/config (not credentials)', () => {
  assert.equal(isSensitivePath(path.join(HOME, '.aws', 'config')), false);
});

test('isSensitivePath: rejects ~/.env file at home root', () => {
  assert.equal(isSensitivePath(path.join(HOME, '.env')), true);
});

test('isSensitivePath: rejects project .env file', () => {
  assert.equal(isSensitivePath('/home/user/project/.env'), true);
});

test('isSensitivePath: rejects .env.local', () => {
  assert.equal(isSensitivePath('/home/user/project/.env.local'), true);
});

test('isSensitivePath: allows .env.example (not .env or .env.local)', () => {
  assert.equal(isSensitivePath('/home/user/project/.env.example'), false);
});

test('isSensitivePath: rejects ~/.netrc', () => {
  assert.equal(isSensitivePath(path.join(HOME, '.netrc')), true);
});

test('isSensitivePath: rejects ~/.docker/config.json', () => {
  assert.equal(isSensitivePath(path.join(HOME, '.docker', 'config.json')), true);
});

test('isSensitivePath: rejects ~/.kube/config', () => {
  assert.equal(isSensitivePath(path.join(HOME, '.kube', 'config')), true);
});

test('isSensitivePath: allows normal project file', () => {
  assert.equal(isSensitivePath('/home/user/project/src/main.js'), false);
});

test('isSensitivePath: allows ~/.claude/CLAUDE.md', () => {
  assert.equal(isSensitivePath(path.join(CLAUDE_DIR, 'CLAUDE.md')), false);
});

test('isSensitivePath: rejects traversal to .ssh via .claude path', () => {
  // A path like ~/.claude/../.ssh/id_rsa resolves to ~/.ssh/id_rsa
  assert.equal(isSensitivePath(path.join(CLAUDE_DIR, '..', '.ssh', 'id_rsa')), true);
});

// ── isAllowedMemoryPath ───────────────────────────────────────────────────────

test('isAllowedMemoryPath: allows files under ~/.claude/', () => {
  const { isAllowedMemoryPath: allowed } = require('../ipc-path-validator');
  assert.equal(allowed(path.join(CLAUDE_DIR, 'CLAUDE.md'), []), true);
});

test('isAllowedMemoryPath: allows files deep under ~/.claude/', () => {
  assert.equal(isAllowedMemoryPath(path.join(CLAUDE_DIR, 'memory', 'notes.md'), []), true);
});

test('isAllowedMemoryPath: allows ~/.claude itself', () => {
  assert.equal(isAllowedMemoryPath(CLAUDE_DIR, []), true);
});

test('isAllowedMemoryPath: allows file under active project path', () => {
  // path.resolve keeps the entry comparable with the resolved candidate on
  // Windows too (a bare '/home/...' literal would miss the drive letter).
  const projectPath = path.resolve('/home/user/project');
  assert.equal(
    isAllowedMemoryPath(path.join(projectPath, 'CLAUDE.md'), [projectPath]),
    true,
  );
});

test('isAllowedMemoryPath: allows .work-files under active project', () => {
  const projectPath = path.resolve('/home/user/project');
  assert.equal(
    isAllowedMemoryPath(path.join(projectPath, '.work-files', 'notes.md'), [projectPath]),
    true,
  );
});

test('isAllowedMemoryPath: rejects file outside ~/.claude and outside projects', () => {
  assert.equal(
    isAllowedMemoryPath(path.join(HOME, 'Documents', 'secret.md'), []),
    false,
  );
});

test('isAllowedMemoryPath: rejects traversal escape from ~/.claude', () => {
  // ~/.claude/../Documents/secret.md → ~/Documents/secret.md
  assert.equal(
    isAllowedMemoryPath(path.join(CLAUDE_DIR, '..', 'Documents', 'secret.md'), []),
    false,
  );
});

test('isAllowedMemoryPath: rejects file that is a prefix-match but not a subpath', () => {
  // /home/user/.claude-evil/file.md must NOT be allowed just because it starts with the same chars
  const evil = path.join(HOME, '.claude-evil', 'file.md');
  assert.equal(isAllowedMemoryPath(evil, []), false);
});

test('isAllowedMemoryPath: accepts multiple project paths, first matching wins', () => {
  // path.resolve keeps the entries comparable with the resolved candidate on
  // Windows too (a bare '/home/...' literal would miss the drive letter).
  const projectA = path.resolve('/home/user/projectA');
  const projectB = path.resolve('/home/user/projectB');
  assert.equal(
    isAllowedMemoryPath(path.join(projectB, 'plans', 'plan.md'), [projectA, projectB]),
    true,
  );
});

test('isAllowedMemoryPath: rejects when project list is empty and path is outside ~/.claude', () => {
  assert.equal(
    isAllowedMemoryPath('/etc/passwd', []),
    false,
  );
});

// ── symlink traversal (the defect this PR closes) ───────────────────────────
//
// path.resolve() normalises '..' but does not follow symlinks. A directory
// inside the allowed root that is actually a symlink to somewhere else lets
// the *string* look contained while the file the OS opens is not. Measured
// before the fix:
//   isAllowedMemoryPath(allowed-root/cache/secret.md, [allowed-root]) → true
//   isSensitivePath(allowed-root/notes/id_rsa_fake)                   → false

test('isAllowedMemoryPath: a symlinked directory inside the allowed root cannot serve files from outside it', (t) => {
  const r = symlinkRig();
  try {
    fs.writeFileSync(path.join(r.outside, 'secret.md'), 'do not expose me');
    if (!linkDir(r.outside, path.join(r.allowedRoot, 'cache'))) {
      return t.skip('cannot create a symlink or junction on this machine — see .ai/shared-guidelines.md');
    }
    const evil = path.join(r.allowedRoot, 'cache', 'secret.md');
    // Sanity: the file really is reachable through the link.
    assert.equal(fs.readFileSync(evil, 'utf8'), 'do not expose me');
    assert.equal(
      isAllowedMemoryPath(evil, [r.allowedRoot]),
      false,
      'a symlinked directory must not let a file outside the allowed root pass the allowlist',
    );
  } finally {
    r.cleanup();
  }
});

test('resolveAllowedMemoryPath: returns the resolved real path, not the literal one, when a symlinked directory is allowed', (t) => {
  // save-memory/read-memory must operate on this returned value — never on
  // their own path.resolve(filePath) again — or the disk resolution below
  // is discarded before it protects anything. See ipc-path-validator.js and
  // resolve-path-on-disk.js.
  const r = symlinkRig();
  try {
    const realDir = path.join(r.allowedRoot, 'real-storage');
    fs.mkdirSync(realDir);
    fs.writeFileSync(path.join(realDir, 'secret.md'), 'in bounds');
    if (!linkDir(realDir, path.join(r.allowedRoot, 'cache'))) {
      return t.skip('cannot create a symlink or junction on this machine — see .ai/shared-guidelines.md');
    }
    const literal = path.join(r.allowedRoot, 'cache', 'secret.md');
    const resolved = resolveAllowedMemoryPath(literal, [r.allowedRoot]);
    assert.equal(resolved, fs.realpathSync(literal));
    assert.notEqual(resolved, literal, 'sanity: the symlink actually changes the path');
  } finally {
    r.cleanup();
  }
});

test('resolveAllowedMemoryPath: a symlink to a target that does not exist yet is a known, documented gap — not a silent one', (t) => {
  // resolveOnDisk() can only resolve what is already on disk. A symlink
  // pointing outside the allowed root, to a target that has not been
  // created yet, falls back to validating the literal string — which is
  // still inside the allowed root — so this returns non-null even though
  // the eventual target is outside. This is the "known gap" documented in
  // resolve-path-on-disk.js: current callers (read-memory, save-memory)
  // are safe only because they separately require the target to already
  // exist before reading or writing it, which fails the same way for a
  // dangling link. This test exists so that gap is asserted, not silent.
  const r = symlinkRig();
  try {
    const missingTarget = path.join(r.outside, 'does-not-exist-yet', 'secret.md');
    if (!linkDir(path.dirname(missingTarget), path.join(r.allowedRoot, 'cache'))) {
      return t.skip('cannot create a symlink or junction on this machine — see .ai/shared-guidelines.md');
    }
    const literal = path.join(r.allowedRoot, 'cache', 'secret.md');
    assert.equal(fs.existsSync(literal), false, 'sanity: the target really does not exist yet');
    assert.notEqual(
      resolveAllowedMemoryPath(literal, [r.allowedRoot]),
      null,
      'documented gap: a dangling symlink out of the allowed root is not rejected by this function alone',
    );
  } finally {
    r.cleanup();
  }
});

test('save-memory shape: reusing the resolved path survives a symlink swap after validation; reusing the literal path does not (TOCTOU)', (t) => {
  // Reproduces the exact sequence from the PR description: check → swap →
  // act, with two synchronous fs calls standing in for save-memory's
  // existsSync + writeFileSync. Proves both halves — the bug in the literal-
  // path pattern, and that the resolved-path pattern is unaffected by it —
  // in one deterministic (non-racy) sequence.
  const r = symlinkRig();
  try {
    const realStorage = path.join(r.allowedRoot, 'real-storage');
    fs.mkdirSync(realStorage);
    fs.writeFileSync(path.join(realStorage, 'secret.md'), 'original in-bounds content');
    fs.writeFileSync(path.join(r.outside, 'secret.md'), 'pre-existing outside content');
    const cacheLink = path.join(r.allowedRoot, 'cache');
    if (!linkDir(realStorage, cacheLink)) {
      return t.skip('cannot create a symlink or junction on this machine — see .ai/shared-guidelines.md');
    }
    const literal = path.join(cacheLink, 'secret.md');

    // 1. Validate once, as save-memory does.
    const resolved = resolveAllowedMemoryPath(literal, [r.allowedRoot]);
    assert.notEqual(resolved, null, 'sanity: the file is in bounds through the link at validation time');

    // 2. Hostile process wins the race: swap cache -> outside, which already
    //    has a file at the same name, so the following syscalls succeed
    //    against it instead of failing on a missing file.
    fs.rmSync(cacheLink, { recursive: true, force: true });
    if (!linkDir(r.outside, cacheLink)) {
      return t.skip('cannot recreate a symlink or junction on this machine');
    }
    assert.equal(fs.readFileSync(literal, 'utf8'), 'pre-existing outside content', 'sanity: the swap is real');

    // 3a. The fixed pattern: existsSync + writeFileSync on `resolved` (the
    //     guard's own resolved value) never touch `cache` again, so the
    //     swap has no effect on them.
    assert.equal(fs.existsSync(resolved), true);
    fs.writeFileSync(resolved, 'written by the fixed pattern', 'utf8');
    assert.equal(fs.readFileSync(path.join(realStorage, 'secret.md'), 'utf8'), 'written by the fixed pattern');
    assert.equal(fs.readFileSync(path.join(r.outside, 'secret.md'), 'utf8'), 'pre-existing outside content',
      'the fixed pattern must not have touched the file outside the allowed root');

    // 3b. The pattern this replaces: existsSync + writeFileSync on `literal`
    //     re-traverse the (now swapped) symlink and land outside the root.
    assert.equal(fs.existsSync(literal), true);
    fs.writeFileSync(literal, 'written by the vulnerable pattern', 'utf8');
    assert.equal(fs.readFileSync(path.join(r.outside, 'secret.md'), 'utf8'), 'written by the vulnerable pattern',
      'demonstrates the class of bug: re-deriving the literal path after validation writes outside the allowed root');
  } finally {
    r.cleanup();
  }
});

test('isSensitivePath: a symlinked directory that is really .ssh is caught under an innocuous name', (t) => {
  const r = symlinkRig();
  try {
    const sshDir = path.join(r.root, '.ssh');
    fs.mkdirSync(sshDir);
    fs.writeFileSync(path.join(sshDir, 'id_rsa_fake'), 'private key material');
    if (!linkDir(sshDir, path.join(r.root, 'notes'))) {
      return t.skip('cannot create a symlink or junction on this machine — see .ai/shared-guidelines.md');
    }
    const direct = path.join(sshDir, 'id_rsa_fake');
    const viaSymlink = path.join(r.root, 'notes', 'id_rsa_fake');
    assert.equal(isSensitivePath(direct), true, 'sanity: the direct path is already caught');
    assert.equal(
      isSensitivePath(viaSymlink),
      true,
      'the same file reached through a symlinked directory must be caught too',
    );
  } finally {
    r.cleanup();
  }
});

// ── isKnownProjectRoot ───────────────────────────────────────────────────────

test('isKnownProjectRoot: accepts an exact match against a known project path', () => {
  const known = path.resolve('/home/user/project');
  assert.equal(isKnownProjectRoot(known, [known]), true);
});

test('isKnownProjectRoot: rejects a path that is not in the known list', () => {
  const known = path.resolve('/home/user/project');
  const other = path.resolve('/home/user/other-project');
  assert.equal(isKnownProjectRoot(other, [known]), false);
});

test('isKnownProjectRoot: rejects a sub-path of a known project (must be exact, not contained)', () => {
  const known = path.resolve('/home/user/project');
  const sub = path.join(known, 'src');
  assert.equal(isKnownProjectRoot(sub, [known]), false);
});

test('isKnownProjectRoot: empty known list rejects everything', () => {
  assert.equal(isKnownProjectRoot(path.resolve('/home/user/project'), []), false);
});
