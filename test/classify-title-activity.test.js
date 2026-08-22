'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { classifyTitleActivity } = require('../classify-title-activity.js');

// Payloads below are verbatim OSC 0 titles from
// ~/.switchboard/activity-trace-20260822-181759.jsonl (2026-08-22).

test('the CLI 2.1.x half-circle spinner frames read as busy', () => {
  assert.deepEqual(classifyTitleActivity('◐ Claude Code'), { busy: true, idle: false, via: 'glyph' });
  assert.deepEqual(classifyTitleActivity('◑ Claude Code'), { busy: true, idle: false, via: 'glyph' });
  assert.deepEqual(classifyTitleActivity('◐ supervision-locale'), { busy: true, idle: false, via: 'glyph' });
  assert.deepEqual(classifyTitleActivity('◑ supervision-locale'), { busy: true, idle: false, via: 'glyph' });
});

test('the unobserved frames of the same animation read as busy too', () => {
  assert.equal(classifyTitleActivity('◒ Claude Code').busy, true);
  assert.equal(classifyTitleActivity('◓ Claude Code').busy, true);
});

test('braille frames still read as busy, with or without a title', () => {
  assert.deepEqual(classifyTitleActivity('⠋ Claude Code'), { busy: true, idle: false, via: 'glyph' });
  assert.deepEqual(classifyTitleActivity('⣾'), { busy: true, idle: false, via: 'glyph' });
});

test('the asterisk glyph reads as idle', () => {
  assert.deepEqual(classifyTitleActivity('✳ Claude Code'), { busy: false, idle: true, via: 'idle-glyph' });
  assert.deepEqual(classifyTitleActivity('✳ supervision-locale'), { busy: false, idle: true, via: 'idle-glyph' });
});

test('an unprefixed ASCII title decides nothing', () => {
  assert.deepEqual(classifyTitleActivity('claude'), { busy: false, idle: false, via: null });
  assert.deepEqual(classifyTitleActivity('npm run dev'), { busy: false, idle: false, via: null });
  assert.deepEqual(classifyTitleActivity('~/workspace/switchboard'), { busy: false, idle: false, via: null });
});

test('an unknown single-code-point prefix falls back to busy', () => {
  assert.deepEqual(classifyTitleActivity('◴ Claude Code'), { busy: true, idle: false, via: 'fallback' });
  assert.deepEqual(classifyTitleActivity('▁ Claude Code'), { busy: true, idle: false, via: 'fallback' });
  assert.deepEqual(classifyTitleActivity('\u{1F300} Claude Code'), { busy: true, idle: false, via: 'fallback' });
});

test('the fallback needs a space and a title after the prefix', () => {
  assert.equal(classifyTitleActivity('Éditeur de texte').via, null);
  assert.equal(classifyTitleActivity('café').via, null);
  assert.equal(classifyTitleActivity('◴').via, null);
  assert.equal(classifyTitleActivity('◴ ').via, null);
});

// Pins a deliberate gap, not an omission — see .ai/contexts/ipc-bridge.md,
// "What that guard does not cover". allowFallback:false is what main.js passes
// for a plain terminal; the known-glyph ranges stay live for it, and a plain
// terminal never emits the idle glyph, so only its PTY exiting clears the
// state. Tightening this reverses a decision.
test('a plain terminal is still called busy by a known glyph', () => {
  const plainTerminal = { allowFallback: false };
  assert.deepEqual(classifyTitleActivity('◐ npm run dev', plainTerminal), { busy: true, idle: false, via: 'glyph' });
  assert.deepEqual(classifyTitleActivity('⠋ webpack', plainTerminal), { busy: true, idle: false, via: 'glyph' });
  // Nothing a plain terminal normally prints can undo it from the title side.
  assert.equal(classifyTitleActivity('npm run dev', plainTerminal).idle, false);
  assert.equal(classifyTitleActivity('~/workspace/switchboard', plainTerminal).idle, false);
});

test('the fallback can be disabled without losing the known glyphs', () => {
  const off = { allowFallback: false };
  assert.equal(classifyTitleActivity('\u{1F300} Claude Code', off).via, null);
  assert.equal(classifyTitleActivity('◐ Claude Code', off).via, 'glyph');
  assert.equal(classifyTitleActivity('✳ Claude Code', off).via, 'idle-glyph');
});

test('empty and non-string payloads decide nothing', () => {
  assert.equal(classifyTitleActivity('').via, null);
  assert.equal(classifyTitleActivity(undefined).via, null);
  assert.equal(classifyTitleActivity(null).via, null);
});
