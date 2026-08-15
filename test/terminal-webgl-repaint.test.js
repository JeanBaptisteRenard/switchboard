// Regression tests for the stale WebGL glyph-atlas fix: revealing a terminal
// must clear the texture atlas and repaint every row, and atlas
// rebuild/extension events must repaint visible rows. Without this, a terminal
// revealed at an unchanged size redraws from a stale atlas and shows ghosted
// or vertically misplaced glyphs.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { setupTerminalDom } = require('./terminal-manager-harness');

test('forceRepaint clears the WebGL texture atlas and refreshes all rows', () => {
  const { window, destroy } = setupTerminalDom();
  try {
    const entry = window.createTerminalEntry({ sessionId: 's1' });
    let atlasClears = 0;
    let refreshes = [];
    entry.webglAddon = { clearTextureAtlas() { atlasClears++; } };
    entry.terminal.refresh = (start, end) => { refreshes.push([start, end]); };
    entry.terminal.rows = 40;

    window.forceRepaint(entry);

    assert.strictEqual(atlasClears, 1);
    assert.deepStrictEqual(refreshes, [[0, 39]]);
  } finally {
    destroy();
  }
});

test('forceRepaint still refreshes rows when the WebGL addon is absent (DOM renderer)', () => {
  const { window, destroy } = setupTerminalDom();
  try {
    const entry = window.createTerminalEntry({ sessionId: 's1' });
    let refreshes = 0;
    entry.webglAddon = null;
    entry.terminal.refresh = () => { refreshes++; };

    window.forceRepaint(entry);

    assert.strictEqual(refreshes, 1);
  } finally {
    destroy();
  }
});

test('forceRepaint survives a clearTextureAtlas throw from a disposed addon', () => {
  const { window, destroy } = setupTerminalDom();
  try {
    const entry = window.createTerminalEntry({ sessionId: 's1' });
    let refreshes = 0;
    entry.webglAddon = { clearTextureAtlas() { throw new Error('disposed'); } };
    entry.terminal.refresh = () => { refreshes++; };

    assert.doesNotThrow(() => window.forceRepaint(entry));
    assert.strictEqual(refreshes, 1);
  } finally {
    destroy();
  }
});

test('fitAndScroll repaints after the deferred fit', async () => {
  const { window, destroy } = setupTerminalDom();
  try {
    const entry = window.createTerminalEntry({ sessionId: 's1' });
    let refreshes = 0;
    entry.terminal.refresh = () => { refreshes++; };

    window.fitAndScroll(entry);
    assert.strictEqual(refreshes, 0); // deferred to the next animation frame
    await new Promise((resolve) => window.requestAnimationFrame(() => resolve()));

    assert.strictEqual(refreshes, 1);
  } finally {
    destroy();
  }
});

test('loadTerminalWebgl repaints visible rows when the texture atlas changes or grows', () => {
  const { window, destroy } = setupTerminalDom();
  try {
    const atlasCallbacks = [];
    window.WebglAddon = {
      WebglAddon: class {
        dispose() {}
        onContextLoss() {}
        onChangeTextureAtlas(cb) { atlasCallbacks.push(cb); }
        onAddTextureAtlasCanvas(cb) { atlasCallbacks.push(cb); }
        clearTextureAtlas() {}
      },
    };
    const entry = window.createTerminalEntry({ sessionId: 's1' });
    assert.strictEqual(atlasCallbacks.length, 2); // both atlas events are wired

    let refreshes = 0;
    entry.terminal.refresh = () => { refreshes++; };
    for (const cb of atlasCallbacks) cb();

    assert.strictEqual(refreshes, 2);
  } finally {
    destroy();
  }
});
