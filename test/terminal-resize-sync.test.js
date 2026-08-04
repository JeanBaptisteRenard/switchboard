// Tests for the terminal-size resynchronisation in public/terminal-manager.js.
//
// The bug being closed: xterm.js and the PTY end up disagreeing on the column
// count, so output already wrapped for one width is re-wrapped against another
// and a TUI's cursor lands a line off. Three mechanisms are covered here:
//
//   1. the size is measured BEFORE the PTY spawn (entry.initialSize), instead
//      of the PTY being born at a hard-coded 120x30;
//   2. a resize is only sent to the PTY when the geometry actually changed;
//   3. the container ResizeObserver is wired on create and torn down on
//      destroy — a leaked observer would itself be a standing cost.

const test = require('node:test');
const assert = require('node:assert');
const { setupTerminalDom } = require('./terminal-manager-harness');

// clientHeight is 0 under jsdom, so clampRowsToContentBox short-circuits
// (cellHeight <= 0 → proposed rows returned unchanged). Whatever the FitAddon
// stub proposes is therefore what proposeFittedDimensions returns.
function withDims(cols, rows) {
  return { proposeDimensions: () => ({ cols, rows }) };
}

// entry.initialSize / entry.lastPtySize are built inside the vm context, so
// they carry that realm's Object.prototype and deepStrictEqual would reject
// them on prototype identity alone. Compare the fields.
function sizeOf(o) {
  return o === null || o === undefined ? o : { cols: o.cols, rows: o.rows };
}

test('createTerminalEntry measures the container before the PTY spawn', () => {
  const { window, spies, destroy } = setupTerminalDom(withDims(213, 57));
  try {
    const entry = window.createTerminalEntry({ sessionId: 's1' });

    assert.deepStrictEqual(sizeOf(entry.initialSize), { cols: 213, rows: 57 },
      'measured size is exposed for the open-terminal call');
    assert.strictEqual(entry.terminal.cols, 213, 'xterm adopts the measured width immediately');
    assert.strictEqual(entry.terminal.rows, 57, 'xterm adopts the measured height immediately');
    assert.deepStrictEqual(sizeOf(entry.lastPtySize), { cols: 213, rows: 57 });

    // The initial adoption must not generate IPC: no PTY exists yet, and the
    // dimensions are being carried to the spawn instead.
    assert.deepStrictEqual(spies.resizeTerminal, [],
      'no terminal-resize IPC before the PTY is opened');
  } finally {
    destroy();
  }
});

test('createTerminalEntry leaves initialSize null when the container cannot be measured', () => {
  // Default harness: proposeDimensions() returns undefined, as it does for a
  // display:none container. main.js then falls back to 120x30.
  const { window, destroy } = setupTerminalDom();
  try {
    const entry = window.createTerminalEntry({ sessionId: 's1' });
    assert.strictEqual(entry.initialSize, null);
    assert.strictEqual(entry.lastPtySize, null);
  } finally {
    destroy();
  }
});

test('the .measuring class never outlives createTerminalEntry', () => {
  for (const opts of [withDims(100, 40), {}]) {
    const { window, destroy } = setupTerminalDom(opts);
    try {
      const entry = window.createTerminalEntry({ sessionId: 's1' });
      assert.strictEqual(entry.element.classList.contains('measuring'), false,
        'the transient layout class is removed even when measuring fails');
    } finally {
      destroy();
    }
  }
});

test('syncPtySizeAfterOpen sends exactly one resize, arming the main-process nudge', () => {
  const { window, spies, destroy } = setupTerminalDom(withDims(213, 57));
  try {
    const entry = window.createTerminalEntry({ sessionId: 's1' });
    window.syncPtySizeAfterOpen(entry);

    assert.deepStrictEqual(spies.resizeTerminal, [{ id: 's1', cols: 213, rows: 57 }],
      'one unconditional resize even though the size equals the spawn size');
  } finally {
    destroy();
  }
});

test('a refit that finds the same geometry sends no IPC at all', () => {
  const { window, spies, destroy } = setupTerminalDom(withDims(213, 57));
  try {
    const entry = window.createTerminalEntry({ sessionId: 's1' });
    window.syncPtySizeAfterOpen(entry);
    const after = spies.resizeTerminal.length;

    // Ten refits with an unchanged container — the realistic case for the
    // visibilitychange / focus / ResizeObserver hooks.
    for (let i = 0; i < 10; i++) window.safeFit(entry);

    assert.strictEqual(spies.resizeTerminal.length, after,
      'idempotent refits produce zero terminal-resize IPC');
  } finally {
    destroy();
  }
});

test('the dedup guard holds even if xterm re-emits onResize for an unchanged size', () => {
  // xterm's own Terminal.resize() early-returns on identical dimensions, so the
  // stub does too. The guard in the onResize handler makes the "no IPC unless
  // the size moved" contract independent of that internal behaviour: drive the
  // emitter directly and nothing must reach the PTY.
  const { window, spies, destroy } = setupTerminalDom(withDims(213, 57));
  try {
    const entry = window.createTerminalEntry({ sessionId: 's1' });
    window.syncPtySizeAfterOpen(entry);
    spies.resizeTerminal.length = 0;

    entry.terminal._onResize({ cols: 213, rows: 57 });
    entry.terminal._onResize({ cols: 213, rows: 57 });
    assert.deepStrictEqual(spies.resizeTerminal, [], 'repeated identical events are swallowed');

    entry.terminal._onResize({ cols: 214, rows: 57 });
    assert.deepStrictEqual(spies.resizeTerminal, [{ id: 's1', cols: 214, rows: 57 }],
      'the first genuinely different size does get through');
  } finally {
    destroy();
  }
});

test('a refit that finds a different geometry does send one resize', () => {
  let dims = { cols: 213, rows: 57 };
  const { window, spies, destroy } = setupTerminalDom({ proposeDimensions: () => dims });
  try {
    const entry = window.createTerminalEntry({ sessionId: 's1' });
    window.syncPtySizeAfterOpen(entry);
    spies.resizeTerminal.length = 0;

    dims = { cols: 180, rows: 57 }; // window narrowed
    window.safeFit(entry);

    assert.deepStrictEqual(spies.resizeTerminal, [{ id: 's1', cols: 180, rows: 57 }]);

    // …and re-fitting at the new size is again free.
    window.safeFit(entry);
    assert.strictEqual(spies.resizeTerminal.length, 1);
  } finally {
    destroy();
  }
});

test('a ResizeObserver is attached to the container and fires a debounced refit', async () => {
  let dims = { cols: 213, rows: 57 };
  const { window, spies, destroy } = setupTerminalDom({ proposeDimensions: () => dims });
  try {
    const entry = window.createTerminalEntry({ sessionId: 's1' });
    window.syncPtySizeAfterOpen(entry);
    spies.resizeTerminal.length = 0;

    assert.strictEqual(spies.resizeObservers.length, 1, 'one observer per session');
    const observer = spies.resizeObservers[0];
    assert.deepStrictEqual(observer.targets, [entry.element], 'observing the terminal container');

    // The observer's guard reads clientHeight; jsdom reports 0, which stands
    // for a hidden container — make it non-zero for this test.
    Object.defineProperty(entry.element, 'clientHeight', { get: () => 800, configurable: true });

    dims = { cols: 150, rows: 57 };
    // A drag fires the observer on every frame; the debounce must collapse
    // that into a single refit.
    for (let i = 0; i < 5; i++) observer.trigger();
    assert.strictEqual(spies.resizeTerminal.length, 0, 'nothing sent before the debounce elapses');

    await new Promise((r) => setTimeout(r, 150));
    assert.deepStrictEqual(spies.resizeTerminal, [{ id: 's1', cols: 150, rows: 57 }],
      'a burst of observer callbacks yields one resize');
  } finally {
    destroy();
  }
});

test('the observer never refits a hidden container', async () => {
  let dims = { cols: 213, rows: 57 };
  const { window, spies, destroy } = setupTerminalDom({ proposeDimensions: () => dims });
  try {
    const entry = window.createTerminalEntry({ sessionId: 's1' });
    window.syncPtySizeAfterOpen(entry);
    spies.resizeTerminal.length = 0;
    const fitsBefore = spies.resize.length;

    dims = { cols: 150, rows: 57 };
    spies.resizeObservers[0].trigger(); // clientHeight stays 0 → hidden
    await new Promise((r) => setTimeout(r, 150));

    assert.strictEqual(spies.resize.length, fitsBefore, 'no measuring work while hidden');
    assert.strictEqual(spies.resizeTerminal.length, 0);
  } finally {
    destroy();
  }
});

test('destroySession disconnects the observer and drops its pending debounce', async () => {
  let dims = { cols: 213, rows: 57 };
  const { window, spies, destroy } = setupTerminalDom({ proposeDimensions: () => dims });
  try {
    const entry = window.createTerminalEntry({ sessionId: 's1' });
    Object.defineProperty(entry.element, 'clientHeight', { get: () => 800, configurable: true });
    const observer = spies.resizeObservers[0];

    dims = { cols: 150, rows: 57 };
    observer.trigger();          // debounce armed…
    window.destroySession('s1'); // …and the session goes away before it fires

    assert.strictEqual(observer.disconnected, true, 'observer disconnected');
    assert.strictEqual(spies.resizeObserverDisconnects, 1);

    await new Promise((r) => setTimeout(r, 150));
    assert.strictEqual(spies.resizeTerminal.length, 0,
      'the pending debounce did not fire on a disposed terminal');
  } finally {
    destroy();
  }
});

test('refitOpenTerminals refits only the active terminal in single view', () => {
  let dims = { cols: 213, rows: 57 };
  const { window, spies, destroy } = setupTerminalDom({ proposeDimensions: () => dims });
  try {
    const active = window.createTerminalEntry({ sessionId: 'active' });
    window.createTerminalEntry({ sessionId: 'background' });
    window.syncPtySizeAfterOpen(active);
    window.activeSessionId = 'active';
    spies.resizeTerminal.length = 0;

    dims = { cols: 150, rows: 57 };
    window.refitOpenTerminals();

    assert.deepStrictEqual(spies.resizeTerminal, [{ id: 'active', cols: 150, rows: 57 }],
      'the hidden background session is not measured');
  } finally {
    destroy();
  }
});
