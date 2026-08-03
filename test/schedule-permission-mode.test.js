// test/schedule-permission-mode.test.js — default permission mode for headless
// scheduled runs.
//
// Scheduled tasks used to hardcode `acceptEdits`. The default is now `auto`,
// matching SETTING_DEFAULTS.permissionMode in main.js: Claude classifies each
// action, allows routine work and stops for risky ones, which suits an
// unattended run better than blanket edit approval.
//
// The important invariant is that this is only a FALLBACK. A schedule whose
// frontmatter names a mode must keep that mode verbatim — including
// 'acceptEdits', so existing schedules that spelled the old default out loud
// are not silently re-pointed at 'auto'.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildScheduleCommand, parseFrontmatter } = require('../schedule-runner');

/** Pull the value following --permission-mode out of an argv array. */
function permissionModeOf(claudeArgs) {
  const i = claudeArgs.indexOf('--permission-mode');
  assert.notEqual(i, -1, 'argv must carry a --permission-mode flag');
  return claudeArgs[i + 1];
}

test('buildScheduleCommand: no configured mode resolves to auto', () => {
  const { claudeArgs } = buildScheduleCommand('sess-1', {
    cli: { 'allowed-tools': 'Read,Glob' },
    prompt: 'nightly report',
  });
  assert.equal(permissionModeOf(claudeArgs), 'auto');
});

test('buildScheduleCommand: a schedule with no cli block at all resolves to auto', () => {
  const { claudeArgs } = buildScheduleCommand('sess-2', { prompt: 'no cli key' });
  assert.equal(permissionModeOf(claudeArgs), 'auto');
});

test('buildScheduleCommand: an explicitly configured mode wins over the default', () => {
  for (const mode of ['plan', 'dontAsk', 'bypassPermissions', 'manual']) {
    const { claudeArgs } = buildScheduleCommand('sess-3', {
      cli: { 'permission-mode': mode },
      prompt: 'explicit mode',
    });
    assert.equal(permissionModeOf(claudeArgs), mode, `explicit ${mode} must be preserved`);
  }
});

test('buildScheduleCommand: an explicit acceptEdits is preserved, not rewritten to auto', () => {
  // The regression that matters: acceptEdits used to BE the default, so a
  // schedule that spelled it out is indistinguishable from one that relied on
  // the default unless the explicit value is honoured. Those schedules must
  // keep acceptEdits.
  const { claudeArgs } = buildScheduleCommand('sess-4', {
    cli: { 'permission-mode': 'acceptEdits' },
    prompt: 'legacy explicit default',
  });
  assert.equal(permissionModeOf(claudeArgs), 'acceptEdits');
});

test('buildScheduleCommand: a blank permission-mode falls back to auto rather than emitting an empty flag', () => {
  // `permission-mode:` with nothing after it parses to '' — passing that
  // through would hand claude an empty --permission-mode value, which it
  // rejects. Treat it as "not configured".
  for (const blank of ['', '   ']) {
    const { claudeArgs } = buildScheduleCommand('sess-5', {
      cli: { 'permission-mode': blank },
      prompt: 'blank mode',
    });
    assert.equal(permissionModeOf(claudeArgs), 'auto');
  }
});

test('buildScheduleCommand: mode survives the real frontmatter parser (absent vs configured)', () => {
  // End-to-end through parseFrontmatter, so the absent/configured distinction is
  // covered at the shape the runner actually receives — not just a hand-built
  // object literal.
  const withMode = parseFrontmatter([
    '---',
    'name: With Mode',
    'cron: 0 9 * * *',
    'cli:',
    '  permission-mode: plan',
    '  allowed-tools: Read,Glob',
    '---',
    'body prompt',
  ].join('\n'));
  assert.equal(
    permissionModeOf(buildScheduleCommand('s', { cli: withMode.meta.cli }).claudeArgs),
    'plan',
  );

  const withoutMode = parseFrontmatter([
    '---',
    'name: Without Mode',
    'cron: 0 9 * * *',
    'cli:',
    '  allowed-tools: Read,Glob',
    '---',
    'body prompt',
  ].join('\n'));
  assert.equal(withoutMode.meta.cli['permission-mode'], undefined,
    'parser must leave an omitted permission-mode undefined');
  assert.equal(
    permissionModeOf(buildScheduleCommand('s', { cli: withoutMode.meta.cli }).claudeArgs),
    'auto',
  );
});

test('schedule-ipc: the task-creator template tells Claude to write auto', () => {
  // The generator prompt ships the frontmatter example new schedules are built
  // from. If it still says acceptEdits, every newly created task pins the old
  // default explicitly and never picks up this change.
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'schedule-ipc.js'), 'utf8');
  assert.match(src, /permission-mode:\s*auto/,
    'the frontmatter template must default to auto');
  assert.doesNotMatch(src, /permission-mode:\s*acceptEdits/,
    'the template must not still emit acceptEdits');
});
