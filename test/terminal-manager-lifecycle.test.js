// Lifecycle tests for public/terminal-manager.js — createTerminalEntry /
// destroySession teardown hygiene.
//
// The jsdom + vm.runInContext harness (xterm stubs, cross-file globals) lives
// in test/terminal-manager-harness.js — shared with the resize-sync suite.

const test = require('node:test');
const assert = require('node:assert');
const { JSDOM } = require('jsdom');
const { setupTerminalDom, PUBLIC_DIR } = require('./terminal-manager-harness');

test('destroySession clears maps, pending write buffer, DOM, and disposes the terminal', () => {
  const { window, spies, inCtx, destroy } = setupTerminalDom();
  try {
    window.createTerminalEntry({ sessionId: 's1' });
    assert.strictEqual(window.openSessions.size, 1);
    assert.strictEqual(window.terminalsEl.querySelectorAll('.terminal-container').length, 1);

    // Seed a pending write buffer + a grid card, as app.js / grid-view.js would.
    inCtx(`terminalWriteBuffers.set('s1', { chunks: ['data'], syncDepth: 0, rafId: 1, timerId: 2 })`);
    inCtx(`gridCards.set('s1', document.createElement('div'))`);

    window.destroySession('s1');

    assert.strictEqual(window.openSessions.size, 0, 'openSessions entry removed');
    assert.strictEqual(inCtx('terminalWriteBuffers.size'), 0, 'pending write buffer removed');
    assert.strictEqual(inCtx('gridCards.size'), 0, 'grid card removed');
    assert.strictEqual(spies.dispose, 1, 'terminal.dispose called exactly once');
    assert.strictEqual(spies.closeTerminal, 1, 'closeTerminal IPC sent');
    assert.strictEqual(window.terminalsEl.querySelectorAll('.terminal-container').length, 0, 'container removed from DOM');
  } finally {
    destroy();
  }
});

test('flushTerminalBuffer after destroySession is a safe no-op', () => {
  const { window, spies, inCtx, destroy } = setupTerminalDom();
  try {
    window.createTerminalEntry({ sessionId: 's1' });
    inCtx(`terminalWriteBuffers.set('s1', { chunks: ['late data'], syncDepth: 0, rafId: 0, timerId: 0 })`);
    window.destroySession('s1');
    const writesBefore = spies.write;

    assert.doesNotThrow(() => window.flushTerminalBuffer('s1'));
    assert.strictEqual(spies.write, writesBefore, 'no write on a disposed terminal');
  } finally {
    destroy();
  }
});

test('destroySession on unknown sessionId is a no-op', () => {
  const { window, spies, destroy } = setupTerminalDom();
  try {
    assert.doesNotThrow(() => window.destroySession('nope'));
    assert.strictEqual(spies.closeTerminal, 0);
  } finally {
    destroy();
  }
});

test('scrollback defaults: full budget in single view, thumbnail budget in grid view', () => {
  const { window, destroy } = setupTerminalDom();
  try {
    const single = window.createTerminalEntry({ sessionId: 's-single' });
    assert.strictEqual(single.terminal.options.scrollback, 10000);

    window.gridViewActive = true;
    const grid = window.createTerminalEntry({ sessionId: 's-grid' });
    assert.strictEqual(grid.terminal.options.scrollback, 1000);

    // Explicit option wins over the view-mode default.
    const explicit = window.createTerminalEntry({ sessionId: 's-explicit' }, { scrollback: 500 });
    assert.strictEqual(explicit.terminal.options.scrollback, 500);
  } finally {
    destroy();
  }
});

test('LRU cap: opening a 13th session evicts the least-recently-shown closed one', () => {
  const { window, spies, inCtx, destroy } = setupTerminalDom();
  try {
    for (let i = 1; i <= 12; i++) window.createTerminalEntry({ sessionId: `s${i}` });
    // The three oldest sessions have exited (banner shown, pty gone).
    for (const sid of ['s1', 's2', 's3']) window.openSessions.get(sid).closed = true;

    window.createTerminalEntry({ sessionId: 's13' });

    assert.strictEqual(window.openSessions.has('s1'), false, 'LRU-most closed session evicted');
    assert.strictEqual(window.openSessions.has('s2'), true, 'only one eviction needed');
    assert.strictEqual(window.openSessions.size, 12);
    assert.strictEqual(inCtx('lruOrder.length'), 12);
    assert.strictEqual(spies.dispose, 1);
  } finally {
    destroy();
  }
});

test('LRU cap is soft: running and still-open sessions are never evicted', () => {
  const { window, spies, destroy } = setupTerminalDom();
  try {
    for (let i = 1; i <= 14; i++) {
      window.createTerminalEntry({ sessionId: `s${i}` });
      // Every session is closed but still has a live PTY → all protected.
      window.openSessions.get(`s${i}`).closed = true;
      window.activePtyIds.add(`s${i}`);
    }
    assert.strictEqual(window.openSessions.size, 14, 'no eviction when everything is protected');
    assert.strictEqual(spies.dispose, 0);
  } finally {
    destroy();
  }
});

test('LRU never evicts the active session, even when closed and LRU-most', () => {
  const { window, spies, destroy } = setupTerminalDom();
  try {
    for (let i = 1; i <= 12; i++) {
      window.createTerminalEntry({ sessionId: `s${i}` });
      window.openSessions.get(`s${i}`).closed = true;
    }
    // s1 is both LRU-most AND the active session — must be skipped in favor
    // of the next evictable entry (s2).
    window.activeSessionId = 's1';

    window.createTerminalEntry({ sessionId: 's13' });

    assert.strictEqual(window.openSessions.has('s1'), true, 'active session survives');
    assert.strictEqual(window.openSessions.has('s2'), false, 'next LRU candidate evicted instead');
    assert.strictEqual(spies.dispose, 1);
  } finally {
    destroy();
  }
});

test('destroySession removes the session from the LRU order', () => {
  const { window, inCtx, destroy } = setupTerminalDom();
  try {
    window.createTerminalEntry({ sessionId: 's1' });
    assert.strictEqual(inCtx('lruOrder.length'), 1);
    window.destroySession('s1');
    assert.strictEqual(inCtx('lruOrder.length'), 0);
  } finally {
    destroy();
  }
});

test('showSession restores the full scrollback budget on a grid-trimmed terminal', () => {
  const { window, destroy } = setupTerminalDom();
  try {
    window.gridViewActive = true;
    const entry = window.createTerminalEntry({ sessionId: 's1' });
    assert.strictEqual(entry.terminal.options.scrollback, 1000);

    window.gridViewActive = false;
    window.showSession('s1');
    assert.strictEqual(entry.terminal.options.scrollback, 10000);
  } finally {
    destroy();
  }
});

test('hideGridView restores the full scrollback budget on ALL open sessions, not just the focused one', () => {
  const { window, destroy } = setupTerminalDom();
  try {
    window.gridViewActive = true;
    const a = window.createTerminalEntry({ sessionId: 'sa' });
    const b = window.createTerminalEntry({ sessionId: 'sb' });
    const c = window.createTerminalEntry({ sessionId: 'sc' });
    c.closed = true;
    assert.strictEqual(b.terminal.options.scrollback, 1000);

    window.hideGridView();

    assert.strictEqual(a.terminal.options.scrollback, 10000, 'background session restored');
    assert.strictEqual(b.terminal.options.scrollback, 10000, 'background session restored');
    assert.strictEqual(c.terminal.options.scrollback, 1000, 'closed session untouched');
    assert.strictEqual(window.gridViewActive, false);
  } finally {
    destroy();
  }
});

test('WebGL lifecycle: loaded on create, suspend disposes, restore reloads, showSession restores', () => {
  const { window, spies, destroy } = setupTerminalDom();
  try {
    const entry = window.createTerminalEntry({ sessionId: 's1' });
    assert.ok(entry.webglAddon, 'WebGL addon loaded at creation');

    window.suspendTerminalWebgl('s1');
    assert.strictEqual(entry.webglAddon, null, 'addon reference cleared');
    assert.strictEqual(spies.webglDispose, 1, 'GL context disposed');

    window.suspendTerminalWebgl('s1');
    assert.strictEqual(spies.webglDispose, 1, 'second suspend is a no-op');

    window.restoreTerminalWebgl('s1');
    assert.ok(entry.webglAddon, 'addon reloaded on restore');

    window.restoreTerminalWebgl('s1');
    assert.strictEqual(spies.webglDispose, 1, 'restore on live addon is a no-op');

    window.suspendTerminalWebgl('s1');
    window.showSession('s1');
    assert.ok(entry.webglAddon, 'showSession restores a suspended GL context');

    assert.doesNotThrow(() => window.suspendTerminalWebgl('unknown'));
  } finally {
    destroy();
  }
});

// --- 30 fps flush-cap tests ---

// scheduleFlush routing: the throttle decision is based on `performance.now() - lastFlushAt`.
// jsdom's rAF does not fire reliably in headless test runs, so these tests verify the
// *scheduling decision* (which branch of scheduleFlush is taken) rather than waiting for
// the rAF callback to execute.

test('30fps cap: flushTerminalBuffer records lastFlushAt timestamp when it writes', () => {
  const { window, spies, inCtx, destroy } = setupTerminalDom();
  try {
    window.createTerminalEntry({ sessionId: 's1' });

    assert.strictEqual(inCtx('lastFlushAt.has("s1")'), false, 'no entry before first flush');

    // Seed a buffer and call flushTerminalBuffer directly (bypasses rAF).
    inCtx(`terminalWriteBuffers.set('s1', { chunks: ['data'], syncDepth: 0, rafId: 0, timerId: 0 })`);
    window.flushTerminalBuffer('s1');

    assert.strictEqual(spies.write, 1, 'terminal.write called');
    assert.strictEqual(inCtx('lastFlushAt.has("s1")'), true, 'lastFlushAt populated after flush');
    const ts = inCtx('lastFlushAt.get("s1")');
    assert.ok(typeof ts === 'number' && ts > 0, 'timestamp is a positive number');
  } finally {
    destroy();
  }
});

test('30fps cap: scheduleFlush takes rAF path when interval has elapsed, timerId path when too soon', () => {
  const { window, inCtx, destroy } = setupTerminalDom();
  try {
    window.createTerminalEntry({ sessionId: 's1' });

    // Case 1: no prior flush (lastFlushAt has no entry) → elapsed is infinite → rAF path.
    inCtx(`terminalWriteBuffers.set('s1', { chunks: ['a'], syncDepth: 0, rafId: 0, timerId: 0 })`);
    inCtx(`scheduleFlush('s1', terminalWriteBuffers.get('s1'))`);
    assert.ok(inCtx(`terminalWriteBuffers.get('s1').rafId`) !== 0, 'rAF scheduled when no prior flush');
    assert.strictEqual(inCtx(`terminalWriteBuffers.get('s1').timerId`), 0, 'no timerId on first call');

    // Cancel the pending rAF so we can re-use the entry.
    inCtx(`cancelAnimationFrame(terminalWriteBuffers.get('s1').rafId); terminalWriteBuffers.get('s1').rafId = 0`);

    // Case 2: stamp lastFlushAt as just-now → elapsed < MIN_FLUSH_INTERVAL_MS → timer path.
    inCtx(`lastFlushAt.set('s1', performance.now())`);
    inCtx(`terminalWriteBuffers.set('s1', { chunks: ['b'], syncDepth: 0, rafId: 0, timerId: 0 })`);
    inCtx(`scheduleFlush('s1', terminalWriteBuffers.get('s1'))`);
    assert.ok(inCtx(`terminalWriteBuffers.get('s1').timerId`) !== 0, 'timer scheduled when within throttle window');
    assert.strictEqual(inCtx(`terminalWriteBuffers.get('s1').rafId`), 0, 'no rAF stacked on timerId path');

    // Case 3: stamp lastFlushAt as 100 ms ago → elapsed > MIN_FLUSH_INTERVAL_MS → rAF path.
    inCtx(`lastFlushAt.set('s1', performance.now() - 100)`);
    inCtx(`terminalWriteBuffers.set('s1', { chunks: ['c'], syncDepth: 0, rafId: 0, timerId: 0 })`);
    inCtx(`scheduleFlush('s1', terminalWriteBuffers.get('s1'))`);
    assert.ok(inCtx(`terminalWriteBuffers.get('s1').rafId`) !== 0, 'rAF scheduled when interval has elapsed');
    assert.strictEqual(inCtx(`terminalWriteBuffers.get('s1').timerId`), 0, 'no timerId when rAF path taken');
  } finally {
    destroy();
  }
});

test('30fps cap: destroySession clears lastFlushAt and cancels a pending throttle timer without a late write', async () => {
  const { window, spies, inCtx, destroy } = setupTerminalDom();
  try {
    window.createTerminalEntry({ sessionId: 's1' });

    // Populate lastFlushAt by direct flush.
    inCtx(`terminalWriteBuffers.set('s1', { chunks: ['a'], syncDepth: 0, rafId: 0, timerId: 0 })`);
    window.flushTerminalBuffer('s1');
    assert.strictEqual(spies.write, 1, 'first flush via direct call');
    assert.strictEqual(inCtx('lastFlushAt.has("s1")'), true, 'lastFlushAt populated');

    // Seed a second buffer — stamp lastFlushAt as just-now so scheduleFlush takes timer path.
    inCtx(`lastFlushAt.set('s1', performance.now())`);
    inCtx(`terminalWriteBuffers.set('s1', { chunks: ['b'], syncDepth: 0, rafId: 0, timerId: 0 })`);
    inCtx(`scheduleFlush('s1', terminalWriteBuffers.get('s1'))`);

    // Confirm a timer was set (throttle path).
    assert.ok(inCtx(`terminalWriteBuffers.get('s1').timerId`) !== 0, 'timer pending before destroy');

    // destroySession must cancel the timer and clear lastFlushAt.
    window.destroySession('s1');
    assert.strictEqual(inCtx('lastFlushAt.size'), 0, 'lastFlushAt cleared on destroySession');

    // Wait well past the throttle window — the cancelled timer must not fire.
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.strictEqual(spies.write, 1, 'no late write after destroySession');
  } finally {
    destroy();
  }
});

// Regression: v0.0.35 frozen-terminal bug. The sync branch cancelled a pending
// rAF without zeroing buf.rafId; scheduleFlush's early-return guard (added by
// the 30 fps cap) then treated the stale id as "flush already pending" forever
// — no output ever painted again for that session.
test('sync block arriving while a rAF is pending does not permanently block future flushes', () => {
  const { window, inCtx, destroy } = setupTerminalDom();
  try {
    window.createTerminalEntry({ sessionId: 's1' });

    // 1. Plain chunk on an idle session → rAF armed.
    window.handleTerminalData('s1', 'plain');
    assert.ok(inCtx(`terminalWriteBuffers.get('s1').rafId`) !== 0, 'rAF pending after plain chunk');

    // 2. Sync-start chunk lands before the rAF fires → it cancels the rAF.
    //    rafId MUST be zeroed, otherwise scheduleFlush is blocked forever.
    window.handleTerminalData('s1', '\x1b[?2026hredraw');
    assert.strictEqual(inCtx(`terminalWriteBuffers.get('s1').rafId`), 0,
      'rafId zeroed when the sync branch cancels the pending rAF');
    assert.ok(inCtx(`terminalWriteBuffers.get('s1').timerId`) !== 0, 'sync safety timer armed');

    // 3. Sync-end chunk closes the block → a flush must be schedulable again.
    window.handleTerminalData('s1', 'rest\x1b[?2026l');
    const buf = inCtx(`terminalWriteBuffers.get('s1')`);
    assert.ok(buf.rafId !== 0 || buf.timerId !== 0,
      'a flush is scheduled once the sync block closes (terminal not frozen)');
  } finally {
    destroy();
  }
});

test('handleTerminalData on an idle session schedules a flush (keystroke echo paints)', () => {
  const { window, inCtx, destroy } = setupTerminalDom();
  try {
    window.createTerminalEntry({ sessionId: 's1' });

    // A fully-wrapped sync redraw in one chunk (as ink emits) on an idle
    // session — syncDepth nets to 0, must end with a flush scheduled.
    window.handleTerminalData('s1', '\x1b[?2026hredraw\x1b[?2026l');
    const buf = inCtx(`terminalWriteBuffers.get('s1')`);
    assert.strictEqual(buf.syncDepth, 0, 'sync nesting unwound within the chunk');
    assert.ok(buf.rafId !== 0 || buf.timerId !== 0, 'flush scheduled for the wrapped chunk');
  } finally {
    destroy();
  }
});

test('30fps cap: scheduleFlush does not double-schedule if timerId or rafId already pending', () => {
  const { window, inCtx, destroy } = setupTerminalDom();
  try {
    window.createTerminalEntry({ sessionId: 's1' });

    // Simulate a pending rafId already set (e.g. first call within cap window already scheduled).
    inCtx(`terminalWriteBuffers.set('s1', { chunks: ['x'], syncDepth: 0, rafId: 99, timerId: 0 })`);
    inCtx(`scheduleFlush('s1', terminalWriteBuffers.get('s1'))`);

    // rafId must remain unchanged (guard returned early).
    assert.strictEqual(inCtx(`terminalWriteBuffers.get('s1').rafId`), 99, 'rafId not overwritten when already set');
    assert.strictEqual(inCtx(`terminalWriteBuffers.get('s1').timerId`), 0, 'no timerId stacked on top');

    // Simulate a pending timerId (throttle path already armed).
    inCtx(`terminalWriteBuffers.set('s1', { chunks: ['y'], syncDepth: 0, rafId: 0, timerId: 42 })`);
    inCtx(`scheduleFlush('s1', terminalWriteBuffers.get('s1'))`);

    assert.strictEqual(inCtx(`terminalWriteBuffers.get('s1').timerId`), 42, 'timerId not overwritten when already set');
    assert.strictEqual(inCtx(`terminalWriteBuffers.get('s1').rafId`), 0, 'no rafId stacked on top');
  } finally {
    destroy();
  }
});

// --- clampRowsToContentBox unit tests ---
// Pure helper extracted from safeFit so it can be tested without xterm stubs.
// Measured root cause: FitAddon proposes floor(borderBoxHeight / cellHeight)
// rows, but the container's vertical padding is part of that height, so the
// last 16 px (8 + 8) overflow and are clipped by overflow:hidden.

test('clampRowsToContentBox: clamps rows when border-box + padding would overflow', () => {
  const { inCtx, destroy } = setupTerminalDom();
  try {
    // Mirrors the live measurement: clientHeight=896, padV=16, cellH=14.
    // FitAddon proposes floor(896/14)=64. Content box = 896-16=880, fits 62.
    const result = inCtx('clampRowsToContentBox(64, 896, 16, 14)');
    assert.strictEqual(result, 62, 'clamps 64 → 62 (matches measured live value)');
  } finally {
    destroy();
  }
});

test('clampRowsToContentBox: does not grow rows when proposed fits perfectly', () => {
  const { inCtx, destroy } = setupTerminalDom();
  try {
    // 62 rows * 14 px = 868 < 880 content-box → no clamp needed.
    const result = inCtx('clampRowsToContentBox(62, 896, 16, 14)');
    assert.strictEqual(result, 62, 'rows already within content box — unchanged');
  } finally {
    destroy();
  }
});

test('clampRowsToContentBox: grid mode measurement (height=395, padV=16, cellH=14)', () => {
  const { inCtx, destroy } = setupTerminalDom();
  try {
    // Measured grid values: FitAddon proposes floor(395/14)=28, content box
    // = 395-16=379, fits floor(379/14)=27.
    const result = inCtx('clampRowsToContentBox(28, 395, 16, 14)');
    assert.strictEqual(result, 27, 'clamps 28 → 27 for grid mode');
  } finally {
    destroy();
  }
});

test('clampRowsToContentBox: returns proposedRows unchanged when cellHeight is 0 (unmeasured)', () => {
  const { inCtx, destroy } = setupTerminalDom();
  try {
    const result = inCtx('clampRowsToContentBox(64, 896, 16, 0)');
    assert.strictEqual(result, 64, 'falls back to proposed when cellHeight is 0');
  } finally {
    destroy();
  }
});

test('clampRowsToContentBox: never returns less than 1 even with extreme padding', () => {
  const { inCtx, destroy } = setupTerminalDom();
  try {
    // Padding larger than clientHeight → content box is 0 or negative.
    const result = inCtx('clampRowsToContentBox(5, 10, 100, 14)');
    assert.strictEqual(result, 1, 'floor of negative content box clamped to 1');
  } finally {
    destroy();
  }
});

test('safeFit: clamps rows to content box when cell height is available via _core path', () => {
  // Build a minimal DOM env where FitAddon proposes an overcount (64 rows,
  // 896 px clientHeight, 16 px padding, 14 px cell) and assert that safeFit
  // calls terminal.resize with 62 rows (the correct content-box fit), not 64.
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="terminals"></div></body></html>', {
    url: 'http://localhost/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const resizeCalls = [];

  const noopClass = class { dispose() {} onContextLoss() {} };
  // Terminal stub with the _core private path returning cellHeight=14.
  class TerminalFitStub {
    constructor(opts) {
      this.options = { ...opts };
      this.buffer = { active: { viewportY: 0, baseY: 0 } };
      this.parser = { registerOscHandler: () => {} };
      this.unicode = { activeVersion: '' };
      this._core = { _renderService: { dimensions: { css: { cell: { height: 14 } } } } };
    }
    loadAddon() {}
    open() {}
    dispose() {}
    write(_d, cb) { if (cb) cb(); }
    focus() {}
    resize(cols, rows) { resizeCalls.push({ cols, rows }); }
    scrollToBottom() {}
    scrollLines() {}
    refresh() {}
    hasSelection() { return false; }
    getSelection() { return ''; }
    attachCustomKeyEventHandler() {}
    onData() {}
    onResize() {}
    onTitleChange() {}
    onBell() {}
  }

  // FitAddon stub that proposes 64 rows (the overcounted value).
  class FitAddonStub {
    proposeDimensions() { return { cols: 220, rows: 64 }; }
    fit() {}
  }

  const stubGlobals = {
    Terminal: TerminalFitStub,
    FitAddon: { FitAddon: FitAddonStub },
    WebLinksAddon: { WebLinksAddon: noopClass },
    SearchAddon: { SearchAddon: class { clearDecorations() {} findNext() {} findPrevious() {} } },
    UnicodeGraphemesAddon: { UnicodeGraphemesAddon: noopClass },
    WebglAddon: { WebglAddon: class { dispose() {} onContextLoss() {} onChangeTextureAtlas() {} onAddTextureAtlasCanvas() {} clearTextureAtlas() {} } },
    TERMINAL_THEME: { background: '#000000' },
    terminalsEl: window.document.getElementById('terminals'),
    openSessions: new Map(),
    gridCards: new Map(),
    sessionMap: new Map(),
    activePtyIds: new Set(),
    activeSessionId: null,
    gridViewActive: false,
    toggleGridView: () => {},
    isSessionNavKey: () => false,
    handleSessionNavKey: () => false,
    matchShortcut: () => false,
    appShortcuts: {},
    focusGridCard: () => {},
    wrapInGridCard: () => {},
    showGridView: () => {},
    trackActivity: () => {},
    updatePtyTitle: () => {},
    openFileInPanel: () => {},
    setActiveSession: () => {},
    clearNotifications: () => {},
    hidePlanViewer: () => {},
    showTerminalHeader: () => {},
    placeholder: window.document.createElement('div'),
    terminalHeader: window.document.createElement('div'),
    gridViewer: window.document.createElement('div'),
    gridViewerCount: window.document.createElement('span'),
    api: new Proxy({ platform: 'linux' }, {
      get(target, prop) {
        if (prop in target) return target[prop];
        return () => Promise.resolve({ ok: true });
      },
    }),
  };
  for (const [k, v] of Object.entries(stubGlobals)) {
    Object.defineProperty(window, k, { value: v, writable: true, configurable: true });
  }

  const ctx = dom.getInternalVMContext();
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const vm2 = require('node:vm');
  for (const file of ['utils.js', 'shortcuts.js', 'terminal-context-menu.js', 'terminal-manager.js', 'grid-view.js']) {
    const src = fs2.readFileSync(path2.join(PUBLIC_DIR, file), 'utf8');
    vm2.runInContext(src, ctx, { filename: file });
  }

  try {
    const entry = window.createTerminalEntry({ sessionId: 'fit-test' });

    // Override the container's clientHeight + getComputedStyle to simulate
    // 896 px border-box with 8+8 px padding (the measured live geometry).
    Object.defineProperty(entry.element, 'clientHeight', { get: () => 896, configurable: true });
    const origGetCS = window.getComputedStyle.bind(window);
    window.getComputedStyle = (el) => {
      const real = origGetCS(el);
      if (el === entry.element) {
        return new Proxy(real, {
          get(target, prop) {
            if (prop === 'paddingTop') return '8px';
            if (prop === 'paddingBottom') return '8px';
            return target[prop];
          },
        });
      }
      return real;
    };

    window.safeFit(entry);

    assert.ok(resizeCalls.length >= 1, 'resize was called');
    const last = resizeCalls[resizeCalls.length - 1];
    assert.strictEqual(last.rows, 62,
      'safeFit clamps 64 proposed rows to 62 (content box = 880 px / 14 px cell)');
    assert.strictEqual(last.cols, 220, 'cols unchanged');
  } finally {
    window.close();
  }
});
