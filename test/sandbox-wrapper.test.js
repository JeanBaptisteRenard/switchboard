// Behavioural coverage for scripts/claude-sandbox.sh — the bwrap wrapper the
// Sandbox session option launches. Run with a fake $HOME, a fake `claude`, and
// (mostly) a fake `bwrap`, so the assertions hold on machines where
// unprivileged user namespaces are restricted.
//
// The renderer/main.js side of the option lives in dom-sandbox-toggle.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'claude-sandbox.sh');
const LINUX = process.platform === 'linux';

/** Throwaway sandbox rig: fake $HOME, fake claude, project cwd. */
function makeRig({ bwrapExit = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-sandbox-'));
  const bin = path.join(root, 'bin');
  const home = path.join(root, 'home');
  const proj = path.join(root, 'proj');
  fs.mkdirSync(bin);
  fs.mkdirSync(home);
  fs.mkdirSync(proj);

  fs.writeFileSync(path.join(bin, 'claude'), '#!/usr/bin/env bash\necho FAKE-CLAUDE "$@"\n');
  fs.chmodSync(path.join(bin, 'claude'), 0o755);

  if (bwrapExit !== null) {
    // Stand-in bwrap that reproduces the Ubuntu 23.10+ restricted-userns
    // failure. --version is answered so the wrapper's debug probe works.
    fs.writeFileSync(path.join(bin, 'bwrap'), [
      '#!/usr/bin/env bash',
      '[ "${1:-}" = "--version" ] && { echo "bubblewrap 0.9.0"; exit 0; }',
      'echo "bwrap: setting up uid map: Permission denied" >&2',
      `exit ${bwrapExit}`,
    ].join('\n') + '\n');
    fs.chmodSync(path.join(bin, 'bwrap'), 0o755);
  }

  return {
    root, home, proj,
    /** Run the wrapper; returns { status, stdout, stderr }. */
    run(args = ['--version'], env = {}) {
      const res = spawnSync('bash', [SCRIPT, ...args], {
        cwd: proj,
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: home,
          PATH: `${bin}:${process.env.PATH}`,
          SWITCHBOARD_SANDBOX_DEBUG: '0',
          ...env,
        },
      });
      return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
    },
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}

test('sandbox wrapper: refuses to be the first claude launch instead of pre-seeding config', { skip: !LINUX && 'linux only' }, () => {
  const rig = makeRig({ bwrapExit: 1 });
  try {
    const { status, stderr } = rig.run();
    assert.equal(status, 125, 'must fail closed');
    assert.match(stderr, /run claude once outside the sandbox first/);
    assert.deepEqual(fs.readdirSync(rig.home), [], '$HOME must be left completely untouched');
  } finally {
    rig.cleanup();
  }
});

test('sandbox wrapper: a failed bwrap pre-flight leaves no state behind in $HOME', { skip: !LINUX && 'linux only' }, () => {
  const rig = makeRig({ bwrapExit: 1 });
  try {
    fs.mkdirSync(path.join(rig.home, '.claude'));
    const { status, stderr } = rig.run();
    assert.equal(status, 125, 'must fail closed');
    assert.match(stderr, /bwrap failed to set up the sandbox/);

    // The regression this guards: mkdir'ing the state dirs and seeding
    // ~/.claude.json with '{}' before bwrap has proven it can even start.
    assert.deepEqual(fs.readdirSync(rig.home).sort(), ['.claude'],
      'a launch bwrap refused must not create state dirs or seed ~/.claude.json');
  } finally {
    rig.cleanup();
  }
});

test('sandbox wrapper: restricted-userns failure points at the sysctl and AppArmor remedies', { skip: !LINUX && 'linux only' }, () => {
  const rig = makeRig({ bwrapExit: 1 });
  try {
    fs.mkdirSync(path.join(rig.home, '.claude'));
    const { stderr } = rig.run();
    assert.match(stderr, /setting up uid map: Permission denied/, "bwrap's own message must still be shown");
    assert.match(stderr, /apparmor_restrict_unprivileged_userns/, 'must name the sysctl');
    assert.match(stderr, /sysctl --system/, 'must give a persistent fix, not just a runtime one');
    assert.match(stderr, /AppArmor profile with 'userns,'/, 'must offer the profile alternative');
  } finally {
    rig.cleanup();
  }
});

test('sandbox wrapper: extra binds survive a newline in a path and missing ones are reported', { skip: !LINUX && 'linux only' }, () => {
  const rig = makeRig({ bwrapExit: 1 });
  try {
    fs.mkdirSync(path.join(rig.home, '.claude'));
    // 'IFS=: read -a' without -d '' stops at the first newline, silently
    // dropping every bind after it — here that would lose "after".
    const weird = path.join(rig.root, 'we\nird');
    const after = path.join(rig.root, 'after');
    fs.mkdirSync(weird);
    fs.mkdirSync(after);

    const { stderr } = rig.run(['--version'], {
      SWITCHBOARD_SANDBOX_DEBUG: '1',
      SWITCHBOARD_SANDBOX_BINDS: `${weird}:${after}:${path.join(rig.root, 'gone')}`,
    });
    assert.ok(stderr.includes(`rw-bind ${weird}`), 'a path containing a newline must be bound whole');
    assert.ok(stderr.includes(`rw-bind ${after}`), 'binds after a newline-containing one must not be dropped');
    assert.match(stderr, /skipping bind — does not exist/, 'a missing extra bind must be reported, not mkdir\'d');
    assert.ok(!fs.existsSync(path.join(rig.root, 'gone')), 'a missing extra bind must not be created on the host');
  } finally {
    rig.cleanup();
  }
});

test('sandbox wrapper: resolves the real binary when "claude" is also a shell function', { skip: !LINUX && 'linux only' }, () => {
  const rig = makeRig({ bwrapExit: 1 });
  try {
    fs.mkdirSync(path.join(rig.home, '.claude'));
    // Switchboard launches us from `bash -l -i -c`, so the user's profile is in
    // play. `command -v claude` reports a function as the bare word "claude",
    // whose readlink -f is not the binary — that is how an empty program name
    // reached bwrap ("bwrap: execvp : No such file or directory").
    const { stderr } = rig.run(['--version'], { SWITCHBOARD_SANDBOX_DEBUG: '1' });
    const line = stderr.split('\n').find(l => l.startsWith('claude-sandbox: claude:'));
    assert.ok(line, 'the resolved binary must be reported under debug');
    assert.match(line, /-> \S+/, 'the resolution target must never be empty');
    assert.doesNotMatch(line, /-> *$/, 'an empty resolution would be handed to bwrap as argv[0]');
  } finally {
    rig.cleanup();
  }
});

test('sandbox wrapper: refuses to bind $HOME or an ancestor as the project dir', { skip: !LINUX && 'linux only' }, () => {
  const rig = makeRig({ bwrapExit: 1 });
  try {
    fs.mkdirSync(path.join(rig.home, '.claude'));
    fs.writeFileSync(path.join(rig.home, 'private-key'), 'secret');

    // Launched with the wrong cwd, the wrapper would bind all of $HOME — the
    // exact tree it advertises as hidden — and still report success.
    const res = spawnSync('bash', [SCRIPT, '--version'], {
      cwd: rig.home, encoding: 'utf8',
      env: { ...process.env, HOME: rig.home, PATH: `${path.join(rig.root, 'bin')}:${process.env.PATH}` },
    });
    assert.equal(res.status, 125, 'must fail closed');
    assert.match(res.stderr, /refusing to bind/);
    assert.match(res.stderr, /\$HOME itself/);

    // And via an extra bind, not just cwd.
    const res2 = spawnSync('bash', [SCRIPT, '--version'], {
      cwd: rig.proj, encoding: 'utf8',
      env: {
        ...process.env, HOME: rig.home,
        PATH: `${path.join(rig.root, 'bin')}:${process.env.PATH}`,
        SWITCHBOARD_SANDBOX_BINDS: path.dirname(rig.home),
      },
    });
    assert.equal(res2.status, 125, 'a parent of $HOME must be refused too');
    assert.match(res2.stderr, /parent of \$HOME/);
  } finally {
    rig.cleanup();
  }
});

// Needs a working unprivileged userns; skipped where the kernel/AppArmor says
// no (Ubuntu 23.10+ defaults, most CI containers). Same bwrap shape the wrapper
// builds, minus the per-launch binds — the lib symlinks matter, without them
// execve of the payload fails on missing ld.so rather than on the namespace.
const realBwrapWorks = LINUX && spawnSync('bwrap', [
  '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--unshare-all', '--share-net', '--dir', '/var',
  '--ro-bind', '/usr', '/usr', '--ro-bind', '/etc', '/etc',
  '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
  '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/sbin', '/sbin',
  '/bin/true',
], { encoding: 'utf8' }).status === 0;

test('sandbox wrapper: a successful launch creates the state dirs and hides the rest of $HOME',
  { skip: !realBwrapWorks && 'requires a usable unprivileged user namespace' }, () => {
    const rig = makeRig();
    try {
      fs.mkdirSync(path.join(rig.home, '.claude'));
      fs.writeFileSync(path.join(rig.home, 'private-key'), 'secret');

      const { status, stdout } = rig.run(['--print', 'hi']);
      assert.equal(status, 0, 'must launch');
      assert.match(stdout, /FAKE-CLAUDE --print hi/, 'claude args must be passed through');

      // Created only once bwrap proved the sandbox is constructible.
      for (const rel of ['.config/claude', '.cache/claude', '.local/share/claude']) {
        assert.ok(fs.existsSync(path.join(rig.home, rel)), `${rel} must exist after a successful launch`);
      }
      assert.equal(fs.readFileSync(path.join(rig.home, '.claude.json'), 'utf8').trim(), '{}');
      assert.equal(fs.readFileSync(path.join(rig.home, 'private-key'), 'utf8'), 'secret',
        'unrelated $HOME files must be untouched');
    } finally {
      rig.cleanup();
    }
  });
