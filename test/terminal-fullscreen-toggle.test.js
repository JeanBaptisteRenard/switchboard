// Regression test for the F11 fullscreen toggle: xterm used to consume the
// F11 keydown (writing CSI 23~ to the PTY) and preventDefault it, which
// suppressed the menu's togglefullscreen accelerator — F11 only worked when
// focus was outside the terminal, and fullscreen was inescapable on
// Windows/Linux where the menu bar is hidden. The terminal key handler must
// intercept F11 and route it to the main process instead.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { setupTerminalDom } = require('./terminal-manager-harness');

function f11Event(type, mods = {}) {
  return {
    type,
    key: 'F11',
    ctrlKey: false, altKey: false, metaKey: false, shiftKey: false,
    ...mods,
    preventDefault() {},
  };
}

test('F11 in the terminal toggles window fullscreen and is blocked from xterm', () => {
  const { window, destroy } = setupTerminalDom();
  try {
    let toggles = 0;
    window.api.toggleFullScreen = () => { toggles++; return Promise.resolve(true); };
    const entry = window.createTerminalEntry({ sessionId: 's1' });
    const handler = entry.terminal._customKeyHandler;
    assert.strictEqual(typeof handler, 'function', 'custom key handler attached');

    assert.strictEqual(handler(f11Event('keydown')), false, 'keydown blocked from xterm');
    assert.strictEqual(handler(f11Event('keyup')), false, 'keyup blocked from xterm');
    assert.strictEqual(toggles, 1, 'toggled exactly once (keydown only)');
  } finally {
    destroy();
  }
});

test('modified F11 (e.g. Shift+F11) still reaches xterm', () => {
  const { window, destroy } = setupTerminalDom();
  try {
    let toggles = 0;
    window.api.toggleFullScreen = () => { toggles++; return Promise.resolve(true); };
    const entry = window.createTerminalEntry({ sessionId: 's1' });
    const handler = entry.terminal._customKeyHandler;

    assert.strictEqual(handler(f11Event('keydown', { shiftKey: true })), true);
    assert.strictEqual(toggles, 0);
  } finally {
    destroy();
  }
});
