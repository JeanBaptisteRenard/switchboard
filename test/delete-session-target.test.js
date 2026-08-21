// Executing tests for the guards on session deletion.
//
// The previous suite regex-matched main.js, which the review showed was no
// guarantee at all: neutering the containment check while leaving the matched
// substring in place kept every test green. These call the real functions
// against real directories, real files and real symlinks.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { isValidSessionId, isInsideDir, resolveDeletionTargets } = require('../delete-session-target');

const ID = '57cf3347-04e1-485f-8063-4d8700785fba';

function rig() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-del-')));
  const projects = path.join(root, 'projects');
  const folder = path.join(projects, '-home-u-proj');
  fs.mkdirSync(folder, { recursive: true });
  return { root, projects, folder, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

// --- isValidSessionId ---

test('isValidSessionId accepts a real session id and rejects anything path-like', () => {
  assert.equal(isValidSessionId(ID), true);
  for (const bad of ['../../etc/passwd', 'a/b', 'a\\b', '.', '..', '', 'a b', 'a;rm -rf /', null, undefined, 42]) {
    assert.equal(isValidSessionId(bad), false, `must reject ${JSON.stringify(bad)}`);
  }
});

// --- isInsideDir ---

test('isInsideDir accepts the directory itself and its descendants', () => {
  assert.equal(isInsideDir('/a/b', '/a/b'), true);
  assert.equal(isInsideDir('/a/b/c/d.jsonl', '/a/b'), true);
});

test('isInsideDir rejects a sibling that merely shares the prefix', () => {
  // The bug this pins: a plain startsWith would accept /a/projects-evil
  // as being inside /a/projects.
  assert.equal(isInsideDir('/a/projects-evil/x', '/a/projects'), false);
  assert.equal(isInsideDir('/a', '/a/b'), false);
  assert.equal(isInsideDir('', '/a'), false);
  assert.equal(isInsideDir('/a', ''), false);
});

// --- resolveDeletionTargets ---

test('resolves the transcript and the sibling subagent directory together', () => {
  const r = rig();
  try {
    const jsonl = path.join(r.folder, ID + '.jsonl');
    const subdir = path.join(r.folder, ID, 'subagents');
    fs.writeFileSync(jsonl, '{}\n');
    fs.mkdirSync(subdir, { recursive: true });
    fs.writeFileSync(path.join(subdir, 'agent-x.jsonl'), '{}\n');

    const out = resolveDeletionTargets(r.projects, ID);
    assert.equal(out.ok, true);
    assert.deepEqual(out.targets.sort(), [jsonl, path.join(r.folder, ID)].sort(),
      'both the transcript and its subagent directory belong to the same conversation');
    assert.deepEqual(out.refused, []);
  } finally { r.cleanup(); }
});

test('refuses a target whose symlink escapes the projects directory', () => {
  const r = rig();
  try {
    const outside = path.join(r.root, 'secret.jsonl');
    fs.writeFileSync(outside, 'do not delete me\n');
    fs.symlinkSync(outside, path.join(r.folder, ID + '.jsonl'));

    const out = resolveDeletionTargets(r.projects, ID);
    assert.equal(out.ok, true);
    assert.deepEqual(out.targets, [], 'nothing inside the projects dir, so nothing to delete');
    assert.equal(out.refused.length, 1, 'the escaping link must be reported, not silently skipped');
    assert.equal(out.refused[0].real, outside);
    assert.ok(fs.existsSync(outside), 'and the target outside must still be there');
  } finally { r.cleanup(); }
});

test('refuses a symlinked DIRECTORY that escapes, not just a file', () => {
  const r = rig();
  try {
    const outside = path.join(r.root, 'elsewhere');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'x');
    fs.symlinkSync(outside, path.join(r.folder, ID));

    const out = resolveDeletionTargets(r.projects, ID);
    assert.deepEqual(out.targets, []);
    assert.equal(out.refused.length, 1);
    assert.ok(fs.existsSync(path.join(outside, 'keep.txt')));
  } finally { r.cleanup(); }
});

test('a symlink that stays inside the projects directory is allowed', () => {
  const r = rig();
  try {
    const real = path.join(r.folder, 'real.jsonl');
    fs.writeFileSync(real, '{}\n');
    fs.symlinkSync(real, path.join(r.folder, ID + '.jsonl'));

    const out = resolveDeletionTargets(r.projects, ID);
    assert.deepEqual(out.targets, [real], 'containment is the rule, not "no symlinks"');
    assert.deepEqual(out.refused, []);
  } finally { r.cleanup(); }
});

test('an invalid id resolves nothing at all', () => {
  const r = rig();
  try {
    for (const bad of ['../../etc/passwd', 'a/b', '..']) {
      const out = resolveDeletionTargets(r.projects, bad);
      assert.equal(out.ok, false, `${bad} must be refused outright`);
      assert.deepEqual(out.targets, []);
    }
  } finally { r.cleanup(); }
});

test('a placeholder session with nothing on disk resolves to no targets, not an error', () => {
  const r = rig();
  try {
    const out = resolveDeletionTargets(r.projects, ID);
    assert.equal(out.ok, true, 'a card with no transcript must still be dismissable');
    assert.deepEqual(out.targets, []);
  } finally { r.cleanup(); }
});

test('preferredFolder short-circuits the scan but still finds the targets', () => {
  const r = rig();
  try {
    const jsonl = path.join(r.folder, ID + '.jsonl');
    fs.writeFileSync(jsonl, '{}\n');
    // A second folder that must not be visited when the cached folder is known.
    const other = path.join(r.projects, '-home-u-other');
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, ID + '.jsonl'), '{}\n');

    const scoped = resolveDeletionTargets(r.projects, ID, '-home-u-proj');
    assert.deepEqual(scoped.targets, [jsonl], 'only the cached folder is consulted');

    const scanned = resolveDeletionTargets(r.projects, ID);
    assert.equal(scanned.targets.length, 2, 'without a hint every folder is scanned');
  } finally { r.cleanup(); }
});

test('an unreadable projects directory is an error, not a throw', () => {
  const out = resolveDeletionTargets('/nonexistent-projects-dir', ID);
  assert.equal(out.ok, false);
  assert.match(out.error, /cannot read projects directory/);
});
