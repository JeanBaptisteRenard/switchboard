// Unit coverage for the re-bindable keyboard-shortcut matcher (public/shortcuts.js).
//
// The headline regression this guards: bare Ctrl+Arrow must NOT be a session-nav
// shortcut, so the terminal keeps Ctrl+Left/Right word-jump. Session nav now
// defaults to Ctrl/Cmd+Shift+Arrow (Shift, not Alt — Ctrl+Alt+Arrow is a common
// Linux workspace-switch binding).

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_SHORTCUTS,
  SHORTCUT_DEFS,
  normalizeShortcuts,
  matchShortcut,
  isSessionNavShortcut,
  formatBinding,
  captureBinding,
} = require('../public/shortcuts');

// Build a fake KeyboardEvent. `mods` is a string like 'ctrl+alt'.
function ev(key, mods = '', code) {
  const set = new Set(mods.split('+').filter(Boolean));
  return {
    key,
    code: code || key,
    ctrlKey: set.has('ctrl'),
    altKey: set.has('alt'),
    shiftKey: set.has('shift'),
    metaKey: set.has('meta'),
  };
}

const D = normalizeShortcuts(null); // defaults

test('defaults: session arrow nav requires Shift — bare Ctrl+Arrow is NOT a nav key', () => {
  // The whole point: Ctrl+Left/Right stays free for terminal word-jump.
  assert.equal(matchShortcut('sessionNavArrows', ev('ArrowLeft', 'ctrl'), false, D), false);
  assert.equal(matchShortcut('sessionNavArrows', ev('ArrowRight', 'ctrl'), false, D), false);
  assert.equal(isSessionNavShortcut(ev('ArrowLeft', 'ctrl'), false, D), false,
    'bare Ctrl+Arrow must not be blocked by the terminal');
  // Ctrl+Alt+Arrow is NOT the default (it clashes with Linux workspace switching).
  assert.equal(matchShortcut('sessionNavArrows', ev('ArrowLeft', 'ctrl+alt'), false, D), false);
});

test('defaults: Ctrl+Shift+Arrow matches session arrow nav (Linux/Windows)', () => {
  for (const k of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
    assert.equal(matchShortcut('sessionNavArrows', ev(k, 'ctrl+shift'), false, D), true, k);
  }
  assert.equal(isSessionNavShortcut(ev('ArrowUp', 'ctrl+shift'), false, D), true);
});

test('defaults: Ctrl+Shift+[ / ] matches bracket nav via e.code (Shift-agnostic key)', () => {
  // On macOS Shift mutates e.key to { / }, so matching must use e.code.
  assert.equal(matchShortcut('sessionNavBrackets', ev('{', 'ctrl+shift', 'BracketLeft'), false, D), true);
  assert.equal(matchShortcut('sessionNavBrackets', ev('}', 'ctrl+shift', 'BracketRight'), false, D), true);
  // Without Shift it must not match.
  assert.equal(matchShortcut('sessionNavBrackets', ev('[', 'ctrl', 'BracketLeft'), false, D), false);
});

test('defaults: grid toggle is Ctrl+Shift+G (G case-insensitive)', () => {
  assert.equal(matchShortcut('gridToggle', ev('G', 'ctrl+shift', 'KeyG'), false, D), true);
  assert.equal(matchShortcut('gridToggle', ev('g', 'ctrl+shift', 'KeyG'), false, D), true);
  assert.equal(matchShortcut('gridToggle', ev('g', 'ctrl', 'KeyG'), false, D), false);
});

test('macOS: primary modifier is Cmd; holding Ctrl as well blocks the match', () => {
  // Cmd+Shift+Arrow on mac
  assert.equal(matchShortcut('sessionNavArrows', ev('ArrowLeft', 'meta+shift'), true, D), true);
  // Ctrl+Shift+Arrow on mac (no Cmd) must NOT match — primary is Cmd on mac.
  assert.equal(matchShortcut('sessionNavArrows', ev('ArrowLeft', 'ctrl+shift'), true, D), false);
  // Cmd+Ctrl+Shift+Arrow — cross modifier (Ctrl) held → rejected.
  assert.equal(matchShortcut('sessionNavArrows', ev('ArrowLeft', 'meta+ctrl+shift'), true, D), false);
});

test('rebinding: a custom binding (plain Alt+Arrow) matches and the default no longer does', () => {
  const custom = normalizeShortcuts({ sessionNavArrows: { primary: false, alt: true, shift: false } });
  assert.equal(matchShortcut('sessionNavArrows', ev('ArrowLeft', 'alt'), false, custom), true);
  assert.equal(matchShortcut('sessionNavArrows', ev('ArrowLeft', 'ctrl+shift'), false, custom), false);
});

test('normalizeShortcuts: merges partial input over defaults and ignores garbage', () => {
  const n = normalizeShortcuts({ sessionNavArrows: { alt: true }, bogusKey: { primary: true }, gridToggle: { key: 'k' } });
  // alt overridden to true, primary/shift fall back to default (true/true).
  assert.deepEqual(n.sessionNavArrows, { primary: true, alt: true, shift: true });
  // unrelated keys dropped.
  assert.equal('bogusKey' in n, false);
  // gridToggle key honoured.
  assert.equal(n.gridToggle.key, 'k');
  // every known def is present.
  for (const def of SHORTCUT_DEFS) assert.ok(n[def.id], def.id);
});

test('normalizeShortcuts: rejects non-single-char grid key, falls back to default', () => {
  const n = normalizeShortcuts({ gridToggle: { key: 'gg' } });
  assert.equal(n.gridToggle.key, DEFAULT_SHORTCUTS.gridToggle.key);
});

test('formatBinding: human-readable labels per platform', () => {
  assert.equal(formatBinding('sessionNavArrows', false, D), 'Ctrl+Shift+←/→/↑/↓');
  assert.equal(formatBinding('sessionNavArrows', true, D), 'Cmd+Shift+←/→/↑/↓');
  assert.equal(formatBinding('sessionNavBrackets', false, D), 'Ctrl+Shift+[ / ]');
  assert.equal(formatBinding('gridToggle', false, D), 'Ctrl+Shift+G');
});

test('captureBinding: needs a modifier + real key; rejects bare/modifier-only presses', () => {
  const arrowsDef = SHORTCUT_DEFS.find(d => d.id === 'sessionNavArrows');
  const keyDef = SHORTCUT_DEFS.find(d => d.id === 'gridToggle');
  // modifier-only keydown → incomplete
  assert.equal(captureBinding(ev('Control', 'ctrl'), arrowsDef, false), null);
  // bare arrow (no modifier) → rejected so we never shadow plain arrows
  assert.equal(captureBinding(ev('ArrowLeft'), arrowsDef, false), null);
  // Ctrl+Alt+Arrow → captured (arrows family ignores the specific key)
  assert.deepEqual(captureBinding(ev('ArrowRight', 'ctrl+alt'), arrowsDef, false),
    { primary: true, alt: true, shift: false });
  // key family without a literal char → incomplete
  assert.equal(captureBinding(ev('ArrowLeft', 'ctrl'), keyDef, false), null);
  // key family with a char → captured incl. key
  assert.deepEqual(captureBinding(ev('K', 'ctrl+shift', 'KeyK'), keyDef, false),
    { primary: true, alt: false, shift: true, key: 'k' });
  // cross-modifier held (Meta on Linux) → rejected: would be an unmatchable binding
  assert.equal(captureBinding(ev('ArrowRight', 'ctrl+meta+alt'), arrowsDef, false), null);
  // on macOS the cross-modifier is Ctrl
  assert.equal(captureBinding(ev('ArrowRight', 'meta+ctrl+shift'), arrowsDef, true), null);
});
