// Tests for the background-write optimisation in public/terminal-manager.js.
//
// Stage B: non-visible sessions use a slow flush cadence (BACKGROUND_FLUSH_INTERVAL_MS)
//          instead of MIN_FLUSH_INTERVAL_MS (~30 fps) so parse CPU is reduced.
// Stage A: non-visible sessions skip terminal.write() entirely; raw PTY chunks
//          accumulate in a rawReplayBuffers Map and are drained on (re)visibility.
//
// isSessionVisible(sessionId) is true when entry.element has the 'visible' CSS class —
// this covers both single view (.visible) and grid mode (.visible.grid-mode) without
// gating on activeSessionId (which would break grid cards).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function makeTerminalStub(spies) {
  return class TerminalStub {
    constructor(opts) {
      this.options = { ...opts };
      this.buffer = { active: { viewportY: 0, baseY: 0 } };
      this.parser = { registerOscHandler: () => {} };
      this.unicode = { activeVersion: '' };
    }
    loadAddon() {}
    open() {}
    dispose() { spies.dispose++; }
    write(_d, cb) { spies.write++; spies.lastWriteData = _d; if (cb) cb(); }
    focus() {}
    resize() {}
    scrollToBottom() {}
    scrollLines() {}
    hasSelection() { return false; }
    getSelection() { return ''; }
    attachCustomKeyEventHandler() {}
    onData() {}
    onResize() {}
    onTitleChange() {}
    onBell() {}
  };
}

function setupDom() {
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="terminals"></div></body></html>', {
    url: 'http://localhost/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const spies = { dispose: 0, write: 0, closeTerminal: 0, lastWriteData: null };

  window.api = new Proxy({ platform: 'linux' }, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === 'closeTerminal') return () => { spies.closeTerminal++; };
      return () => Promise.resolve({ ok: true });
    },
  });

  spies.webglDispose = 0;
  const noopClass = class { dispose() {} onContextLoss() {} };
  const stubGlobals = {
    Terminal: makeTerminalStub(spies),
    FitAddon: { FitAddon: class { proposeDimensions() { return null; } fit() {} } },
    WebLinksAddon: { WebLinksAddon: noopClass },
    SearchAddon: { SearchAddon: class { clearDecorations() {} findNext() {} findPrevious() {} } },
    UnicodeGraphemesAddon: { UnicodeGraphemesAddon: noopClass },
    WebglAddon: { WebglAddon: class { dispose() { spies.webglDispose++; } onContextLoss() {} } },

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
  };

  for (const [k, v] of Object.entries(stubGlobals)) {
    Object.defineProperty(window, k, { value: v, writable: true, configurable: true });
  }

  const ctx = dom.getInternalVMContext();
  for (const file of ['utils.js', 'shortcuts.js', 'terminal-context-menu.js', 'terminal-manager.js', 'grid-view.js']) {
    const src = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');
    vm.runInContext(src, ctx, { filename: file });
  }

  const inCtx = (code) => vm.runInContext(code, ctx);
  return { window, spies, inCtx, destroy: () => window.close() };
}

// ---------------------------------------------------------------------------
// isSessionVisible predicate
// ---------------------------------------------------------------------------

test('isSessionVisible: returns false for a session without the visible class', () => {
  const { window, destroy } = setupDom();
  try {
    window.createTerminalEntry({ sessionId: 's1' });
    // element starts without 'visible' (not yet shown)
    assert.strictEqual(window.isSessionVisible('s1'), false);
  } finally {
    destroy();
  }
});

test('isSessionVisible: returns true when entry.element has the visible class (single view)', () => {
  const { window, destroy } = setupDom();
  try {
    window.createTerminalEntry({ sessionId: 's1' });
    const entry = window.openSessions.get('s1');
    entry.element.classList.add('visible');
    assert.strictEqual(window.isSessionVisible('s1'), true);
  } finally {
    destroy();
  }
});

test('isSessionVisible: returns true for a grid card (visible + grid-mode classes)', () => {
  const { window, destroy } = setupDom();
  try {
    window.createTerminalEntry({ sessionId: 's1' });
    const entry = window.openSessions.get('s1');
    entry.element.classList.add('visible', 'grid-mode');
    assert.strictEqual(window.isSessionVisible('s1'), true);
  } finally {
    destroy();
  }
});

test('isSessionVisible: returns false for unknown session', () => {
  const { window, destroy } = setupDom();
  try {
    assert.strictEqual(window.isSessionVisible('no-such-session'), false);
  } finally {
    destroy();
  }
});

// ---------------------------------------------------------------------------
// Stage B — throttle: non-visible sessions use slow cadence
// ---------------------------------------------------------------------------

test('Stage B: flushTerminalBuffer uses background interval for non-visible sessions', () => {
  // A non-visible session that just had a flush should schedule with the slow
  // background timer, not the fast 33ms RAF path.
  const { window, inCtx, destroy } = setupDom();
  try {
    window.createTerminalEntry({ sessionId: 's1' });
    // entry.element has no 'visible' class → non-visible

    // Stamp lastFlushAt as just-now so scheduleFlush sees elapsed < MIN_FLUSH_INTERVAL_MS
    inCtx(`lastFlushAt.set('s1', performance.now())`);
    inCtx(`terminalWriteBuffers.set('s1', { chunks: ['x'], syncDepth: 0, rafId: 0, timerId: 0 })`);
    inCtx(`scheduleFlush('s1', terminalWriteBuffers.get('s1'))`);

    const buf = inCtx(`terminalWriteBuffers.get('s1')`);
    // The timer delay for a non-visible session must be >= BACKGROUND_FLUSH_INTERVAL_MS (1500 ms)
    // We can only verify a timer was set (not the value directly), but we can check
    // that BACKGROUND_FLUSH_INTERVAL_MS is defined and > MIN_FLUSH_INTERVAL_MS.
    assert.ok(buf.timerId !== 0, 'a timer is scheduled (not immediate RAF)');
    assert.ok(inCtx('BACKGROUND_FLUSH_INTERVAL_MS') > inCtx('MIN_FLUSH_INTERVAL_MS'),
      'BACKGROUND_FLUSH_INTERVAL_MS must be greater than MIN_FLUSH_INTERVAL_MS');
    assert.ok(inCtx('BACKGROUND_FLUSH_INTERVAL_MS') >= 1500,
      'background interval is at least 1500 ms');
  } finally {
    destroy();
  }
});

test('Stage B: visible session uses the fast 33ms cadence (no regression)', () => {
  const { window, inCtx, destroy } = setupDom();
  try {
    window.createTerminalEntry({ sessionId: 's1' });
    const entry = window.openSessions.get('s1');
    entry.element.classList.add('visible'); // mark as visible

    // No prior flush → elapsed is infinite → must take rAF path immediately
    inCtx(`terminalWriteBuffers.set('s1', { chunks: ['y'], syncDepth: 0, rafId: 0, timerId: 0 })`);
    inCtx(`scheduleFlush('s1', terminalWriteBuffers.get('s1'))`);

    const buf = inCtx(`terminalWriteBuffers.get('s1')`);
    assert.ok(buf.rafId !== 0, 'rAF scheduled for visible session (fast path)');
    assert.strictEqual(buf.timerId, 0, 'no slow timer for visible session');
  } finally {
    destroy();
  }
});

// ---------------------------------------------------------------------------
// Stage A — skip write / buffer / replay
// ---------------------------------------------------------------------------

test('Stage A: flushTerminalBuffer does NOT call write() for a non-visible session', () => {
  const { window, spies, inCtx, destroy } = setupDom();
  try {
    window.createTerminalEntry({ sessionId: 's1' });
    // No 'visible' class → non-visible

    inCtx(`terminalWriteBuffers.set('s1', { chunks: ['data'], syncDepth: 0, rafId: 0, timerId: 0 })`);
    window.flushTerminalBuffer('s1');

    assert.strictEqual(spies.write, 0, 'write() must not be called for a non-visible session');
  } finally {
    destroy();
  }
});

test('Stage A: flushTerminalBuffer accumulates raw chunks in rawReplayBuffers for non-visible session', () => {
  const { window, inCtx, destroy } = setupDom();
  try {
    window.createTerminalEntry({ sessionId: 's1' });

    inCtx(`terminalWriteBuffers.set('s1', { chunks: ['hello'], syncDepth: 0, rafId: 0, timerId: 0 })`);
    window.flushTerminalBuffer('s1');

    inCtx(`terminalWriteBuffers.set('s1', { chunks: [' world'], syncDepth: 0, rafId: 0, timerId: 0 })`);
    window.flushTerminalBuffer('s1');

    const replayArr = inCtx(`rawReplayBuffers.get('s1')`);
    assert.ok(Array.isArray(replayArr), 'rawReplayBuffers has an array for s1');
    assert.ok(replayArr.length >= 1, 'at least one chunk stored');
    // The combined data should contain both pieces
    const combined = replayArr.join('');
    assert.ok(combined.includes('hello'), 'first chunk accumulated');
    assert.ok(combined.includes(' world'), 'second chunk accumulated');
  } finally {
    destroy();
  }
});

test('Stage A: flushTerminalBuffer calls write() for a visible session (no regression)', () => {
  const { window, spies, inCtx, destroy } = setupDom();
  try {
    window.createTerminalEntry({ sessionId: 's1' });
    const entry = window.openSessions.get('s1');
    entry.element.classList.add('visible');

    inCtx(`terminalWriteBuffers.set('s1', { chunks: ['data'], syncDepth: 0, rafId: 0, timerId: 0 })`);
    window.flushTerminalBuffer('s1');

    assert.strictEqual(spies.write, 1, 'write() called for visible session');
  } finally {
    destroy();
  }
});

test('Stage A: showSession drains rawReplayBuffer via a single write() and clears it', () => {
  const { window, spies, inCtx, destroy } = setupDom();
  try {
    window.createTerminalEntry({ sessionId: 's1' });

    // Simulate two background flushes accumulating data in replay buffer
    inCtx(`terminalWriteBuffers.set('s1', { chunks: ['first'], syncDepth: 0, rafId: 0, timerId: 0 })`);
    window.flushTerminalBuffer('s1');
    inCtx(`terminalWriteBuffers.set('s1', { chunks: ['second'], syncDepth: 0, rafId: 0, timerId: 0 })`);
    window.flushTerminalBuffer('s1');

    assert.strictEqual(spies.write, 0, 'no writes during background');

    const replayBefore = inCtx(`rawReplayBuffers.get('s1')`);
    assert.ok(Array.isArray(replayBefore) && replayBefore.length > 0, 'replay buffer has data');

    // Now make it visible (single view)
    window.showSession('s1');

    // Should have written (at least once to drain replay)
    assert.ok(spies.write >= 1, 'write() called during showSession drain');

    // Replay buffer must be cleared
    const replayAfter = inCtx(`rawReplayBuffers.get('s1')`);
    const isEmpty = replayAfter === undefined || (Array.isArray(replayAfter) && replayAfter.length === 0);
    assert.ok(isEmpty, 'rawReplayBuffers cleared after drain');
  } finally {
    destroy();
  }
});

test('Stage A: raw replay buffer cap drops oldest chunks when exceeded', () => {
  const { window, inCtx, destroy } = setupDom();
  try {
    window.createTerminalEntry({ sessionId: 's1' });

    const capBytes = inCtx('RAW_REPLAY_BUFFER_CAP_BYTES');
    assert.ok(typeof capBytes === 'number' && capBytes >= 1_000_000,
      'RAW_REPLAY_BUFFER_CAP_BYTES should be at least 1 MB');

    // Inject directly into rawReplayBuffers to bypass the write buffer path
    inCtx(`rawReplayBuffers.set('s1', [])`);
    // Call the internal accumulation function with an oversized payload
    inCtx(`
      (function() {
        const arr = rawReplayBuffers.get('s1');
        const sentinel = 'SENTINEL_START';
        arr.push(sentinel);
        const big = 'B'.repeat(${capBytes} + 100);
        arr.push(big);
        // Trigger cap enforcement by calling the helper used in flushTerminalBuffer
        enforceReplayBufferCap('s1');
      })()
    `);

    const arr = inCtx(`rawReplayBuffers.get('s1')`);
    const total = arr.reduce((s, c) => s + c.length, 0);
    assert.ok(total <= capBytes, 'total bytes after cap enforcement must be within cap');
    // The sentinel (pushed first) should have been dropped (oldest)
    const combined = arr.join('');
    assert.ok(!combined.includes('SENTINEL_START'), 'oldest chunk dropped when cap exceeded');
  } finally {
    destroy();
  }
});

test('Stage A: grid card (visible + grid-mode) still receives writes — activeSessionId trap does not regress', () => {
  const { window, spies, inCtx, destroy } = setupDom();
  try {
    window.createTerminalEntry({ sessionId: 'grid-card-session' });
    const entry = window.openSessions.get('grid-card-session');
    // A grid card has BOTH visible and grid-mode classes — it IS visible.
    entry.element.classList.add('visible', 'grid-mode');

    // Even though it is NOT the activeSessionId, it should receive writes.
    window.activeSessionId = 'some-other-session';

    inCtx(`terminalWriteBuffers.set('grid-card-session', { chunks: ['grid data'], syncDepth: 0, rafId: 0, timerId: 0 })`);
    window.flushTerminalBuffer('grid-card-session');

    assert.strictEqual(spies.write, 1,
      'grid card (visible+grid-mode) must receive write() even when not the activeSessionId');
    assert.strictEqual(inCtx(`rawReplayBuffers.get('grid-card-session') === undefined || rawReplayBuffers.get('grid-card-session').length === 0`),
      true, 'no data buffered for visible grid card');
  } finally {
    destroy();
  }
});

test('Stage A: destroySession clears rawReplayBuffers entry', () => {
  const { window, inCtx, destroy } = setupDom();
  try {
    window.createTerminalEntry({ sessionId: 's1' });

    // Accumulate some data
    inCtx(`terminalWriteBuffers.set('s1', { chunks: ['data'], syncDepth: 0, rafId: 0, timerId: 0 })`);
    window.flushTerminalBuffer('s1');

    assert.ok(inCtx(`(rawReplayBuffers.get('s1') || []).length > 0`), 'replay buffer has data before destroy');

    window.destroySession('s1');

    assert.ok(!inCtx(`rawReplayBuffers.has('s1')`), 'rawReplayBuffers entry cleared on destroySession');
  } finally {
    destroy();
  }
});

test('Stage A: sync-block buffering in handleTerminalData is unaffected by the write skip', () => {
  // The frozen-terminal fix relies on syncDepth being tracked in terminalWriteBuffers
  // even for background sessions. The skip must live in flushTerminalBuffer, not
  // handleTerminalData.
  const { window, inCtx, destroy } = setupDom();
  try {
    window.createTerminalEntry({ sessionId: 's1' });
    // session is NOT visible

    // A sync-block sequence
    window.handleTerminalData('s1', '\x1b[?2026hredraw');
    const buf = inCtx(`terminalWriteBuffers.get('s1')`);
    assert.strictEqual(buf.syncDepth, 1, 'syncDepth tracked even for non-visible session');
    assert.ok(buf.timerId !== 0, 'safety timer armed inside sync block');

    // Close the sync block
    window.handleTerminalData('s1', 'rest\x1b[?2026l');
    const buf2 = inCtx(`terminalWriteBuffers.get('s1')`);
    assert.strictEqual(buf2.syncDepth, 0, 'syncDepth unwound correctly');
    assert.ok(buf2.rafId !== 0 || buf2.timerId !== 0, 'flush scheduled after sync block closes');
  } finally {
    destroy();
  }
});
