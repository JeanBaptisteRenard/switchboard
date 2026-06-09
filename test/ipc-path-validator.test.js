// test/ipc-path-validator.test.js — unit tests for the IPC path validation helper
//
// Tests the pure path-validation logic extracted from main.js.
// No Electron, no fs I/O beyond what the module itself does.
'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const os     = require('os');
const path   = require('path');

const { isSensitivePath, isAllowedMemoryPath } = require('../ipc-path-validator');

const HOME       = os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');

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
  const projectPath = '/home/user/project';
  assert.equal(
    isAllowedMemoryPath(path.join(projectPath, 'CLAUDE.md'), [projectPath]),
    true,
  );
});

test('isAllowedMemoryPath: allows .work-files under active project', () => {
  const projectPath = '/home/user/project';
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
  const projectA = '/home/user/projectA';
  const projectB = '/home/user/projectB';
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
