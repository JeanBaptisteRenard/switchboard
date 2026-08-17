// Regression/behavior tests for the hidden-terminal render-cost fix.
//
// Two independent mechanisms, both scoped to single view (!gridViewActive) —
// grid view already virtualizes render cost per-card via
// suspendTerminalWebgl/restoreTerminalWebgl + gridCardObserver (grid-view.js):
//
//   1. Flush-cadence throttle (scheduleFlush): a session that is neither the
//      active single-view terminal nor part of an open grid flushes at
//      HIDDEN_FLUSH_INTERVAL_MS (~1fps) instead of MIN_FLUSH_INTERVAL_MS
//      (~30fps). showSession() / wrapInGridCard() force-flush any pending
//      buffer immediately before the session becomes visible, so the
//      throttle never shows stale content.
//   2. WebGL suspend on single-view switch: showSession() suspends the
//      outgoing session's GL context and restores the incoming one, mirroring
//      what grid-view.js already does per-card. hideGridView() suspends every
//      session on the way out of grid mode so single view never inherits more
//      than the one GL context it is about to show.
//
// Uses the shared jsdom + vm.runInContext harness (test/terminal-manager-harness.js).

const test = require('node:test');
const assert = require('node:assert');
const { setupTerminalDom } = require('./terminal-manager-harness');

// --- Mechanism 1: flush-cadence throttle ---

test('scheduleFlush: hidden single-view session throttles to ~1fps while the active session keeps the 30fps cap', () => {
  const { window, inCtx, destroy } = setupTerminalDom();
  try {
    window.createTerminalEntry({ sessionId: 'active' });
    window.createTerminalEntry({ sessionId: 'hidden' });
    window.activeSessionId = 'active';
    window.gridViewActive = false;

    // Both sessions last flushed 100ms ago: past the active session's 33ms
    // cap, but well inside the hidden session's 1000ms window.
    inCtx(`lastFlushAt.set('active', performance.now() - 100)`);
    inCtx(`lastFlushAt.set('hidden', performance.now() - 100)`);

    inCtx(`terminalWriteBuffers.set('active', { chunks: ['a'], syncDepth: 0, rafId: 0, timerId: 0 })`);
    inCtx(`scheduleFlush('active', terminalWriteBuffers.get('active'))`);
    assert.ok(inCtx(`terminalWriteBuffers.get('active').rafId`) !== 0,
      'active session flushes on the next frame — 100ms exceeds its 33ms cap');
    assert.strictEqual(inCtx(`terminalWriteBuffers.get('active').timerId`), 0);

    inCtx(`terminalWriteBuffers.set('hidden', { chunks: ['b'], syncDepth: 0, rafId: 0, timerId: 0 })`);
    inCtx(`scheduleFlush('hidden', terminalWriteBuffers.get('hidden'))`);
    assert.ok(inCtx(`terminalWriteBuffers.get('hidden').timerId`) !== 0,
      'hidden session is still inside its 1000ms throttle window at 100ms elapsed');
    assert.strictEqual(inCtx(`terminalWriteBuffers.get('hidden').rafId`), 0);
  } finally {
    destroy();
  }
});

test('scheduleFlush: an open grid keeps the fast cadence for every session, not just the active one', () => {
  const { window, inCtx, destroy } = setupTerminalDom();
  try {
    window.createTerminalEntry({ sessionId: 'active' });
    window.createTerminalEntry({ sessionId: 'other' });
    window.activeSessionId = 'active';
    window.gridViewActive = true;

    // 100ms elapsed clears the 33ms cap but would still be inside the 1000ms
    // hidden window — proves gridViewActive routes 'other' to the fast cadence.
    inCtx(`lastFlushAt.set('other', performance.now() - 100)`);
    inCtx(`terminalWriteBuffers.set('other', { chunks: ['x'], syncDepth: 0, rafId: 0, timerId: 0 })`);
    inCtx(`scheduleFlush('other', terminalWriteBuffers.get('other'))`);

    assert.ok(inCtx(`terminalWriteBuffers.get('other').rafId`) !== 0,
      'non-active session in an open grid still uses the 30fps cadence');
    assert.strictEqual(inCtx(`terminalWriteBuffers.get('other').timerId`), 0);
  } finally {
    destroy();
  }
});

test('showSession force-flushes a pending buffer before making the session visible', () => {
  const { window, spies, inCtx, destroy } = setupTerminalDom();
  try {
    const entry = window.createTerminalEntry({ sessionId: 's1' });
    inCtx(`terminalWriteBuffers.set('s1', { chunks: ['queued'], syncDepth: 0, rafId: 0, timerId: 5 })`);

    window.showSession('s1');

    assert.strictEqual(spies.write, 1, 'terminal.write ran synchronously, not on a future flush');
    assert.strictEqual(inCtx(`terminalWriteBuffers.has('s1')`), false, 'pending buffer consumed');
    assert.ok(entry.element.classList.contains('visible'));
  } finally {
    destroy();
  }
});

test('wrapInGridCard force-flushes a pending buffer before the card becomes visible', () => {
  const { window, spies, inCtx, destroy } = setupTerminalDom();
  try {
    window.sessionMap.set('s1', { sessionId: 's1', name: 's1', projectPath: '/p' });
    window.gridViewActive = false; // exercise the plain-append path, not the sortedOrder grouping
    window.createTerminalEntry({ sessionId: 's1' });
    inCtx(`terminalWriteBuffers.set('s1', { chunks: ['queued'], syncDepth: 0, rafId: 3, timerId: 0 })`);

    window.wrapInGridCard('s1');

    assert.strictEqual(spies.write, 1, 'buffer flushed when the session is wrapped into a grid card');
    assert.strictEqual(inCtx(`terminalWriteBuffers.has('s1')`), false);
  } finally {
    destroy();
  }
});

test('sync block on a hidden session still arms the 500ms safety timer (sync-block handling unchanged)', () => {
  const { window, inCtx, destroy } = setupTerminalDom();
  try {
    window.createTerminalEntry({ sessionId: 'active' });
    window.createTerminalEntry({ sessionId: 'hidden' });
    window.activeSessionId = 'active';
    window.gridViewActive = false;

    window.handleTerminalData('hidden', '\x1b[?2026hredraw');

    const buf = inCtx(`terminalWriteBuffers.get('hidden')`);
    assert.strictEqual(buf.syncDepth, 1, 'sync-start counted');
    assert.strictEqual(buf.rafId, 0, 'rAF not armed while inside a sync block');
    assert.ok(buf.timerId !== 0, 'sync safety timer armed regardless of hidden/active status');
  } finally {
    destroy();
  }
});

// Hidden-session variant of the v0.0.35 frozen-terminal regression covered in
// terminal-manager-lifecycle.test.js — the hidden cadence must not reintroduce it.
test('regression: sync block on a hidden session does not permanently block future flushes', () => {
  const { window, inCtx, destroy } = setupTerminalDom();
  try {
    window.createTerminalEntry({ sessionId: 'active' });
    window.createTerminalEntry({ sessionId: 'hidden' });
    window.activeSessionId = 'active';
    window.gridViewActive = false;

    // 1. Plain chunk on the hidden session → a flush (rAF or timer) is armed.
    window.handleTerminalData('hidden', 'plain');
    const afterPlain = inCtx(`terminalWriteBuffers.get('hidden')`);
    assert.ok(afterPlain.rafId !== 0 || afterPlain.timerId !== 0, 'flush scheduled after a plain chunk');

    // 2. Sync-start lands before that flush fires → cancels it; rafId must be
    //    zeroed or scheduleFlush's early-return guard blocks every future call.
    window.handleTerminalData('hidden', '\x1b[?2026hredraw');
    assert.strictEqual(inCtx(`terminalWriteBuffers.get('hidden').rafId`), 0,
      'rafId zeroed when the sync branch cancels a pending flush');

    // 3. Sync-end closes the block → a flush must be schedulable again.
    window.handleTerminalData('hidden', 'rest\x1b[?2026l');
    const buf = inCtx(`terminalWriteBuffers.get('hidden')`);
    assert.ok(buf.rafId !== 0 || buf.timerId !== 0,
      'a flush is scheduled once the sync block closes (hidden terminal not frozen)');
  } finally {
    destroy();
  }
});

// --- Mechanism 2: WebGL suspend on single-view switch ---

test('session switch in single view suspends the outgoing session and restores the incoming one', () => {
  const { window, destroy } = setupTerminalDom();
  try {
    const s1 = window.createTerminalEntry({ sessionId: 's1' });
    const s2 = window.createTerminalEntry({ sessionId: 's2' });
    window.activeSessionId = 's1'; // s1 is the session currently shown
    window.gridViewActive = false;

    window.showSession('s2');

    assert.strictEqual(s1.webglAddon, null, 'outgoing session suspended — no longer visible');
    assert.ok(s2.webglAddon, 'incoming session has a live GL context');
  } finally {
    destroy();
  }
});

test('re-showing the already-active session does not suspend or reload its own WebGL', () => {
  const { window, spies, destroy } = setupTerminalDom();
  try {
    const entry = window.createTerminalEntry({ sessionId: 's1' });
    window.activeSessionId = 's1';
    window.gridViewActive = false;

    window.showSession('s1');

    assert.strictEqual(spies.webglDispose, 0, 'no suspend when incoming === outgoing session');
    assert.ok(entry.webglAddon, 'GL context still live');
  } finally {
    destroy();
  }
});

test('opening a new session while one is already shown suspends the previous one (mirrors session-restore reopening several sessions)', () => {
  const { window, destroy } = setupTerminalDom();
  try {
    const s1 = window.createTerminalEntry({ sessionId: 's1' });
    window.activeSessionId = 's1';
    window.gridViewActive = false;
    window.showSession('s1');
    assert.ok(s1.webglAddon, 's1 has a live GL context while shown');

    // A second session opens in the background (as runRestore's staggered
    // openSession() calls do) and is immediately shown, exactly like the real
    // openSession()/showSession() sequence in app.js.
    const s2 = window.createTerminalEntry({ sessionId: 's2' });
    window.activeSessionId = 's1'; // showSession captures the OUTGOING id before switching
    window.showSession('s2');

    assert.strictEqual(s1.webglAddon, null, 's1 suspended once s2 becomes the visible session');
    assert.ok(s2.webglAddon, 's2 has a live GL context');
  } finally {
    destroy();
  }
});

test('grid close suspends every open session; the subsequent showSession restores exactly the one being shown', () => {
  const { window, spies, destroy } = setupTerminalDom();
  try {
    const a = window.createTerminalEntry({ sessionId: 'a' });
    const b = window.createTerminalEntry({ sessionId: 'b' });
    window.activeSessionId = 'a';
    window.gridViewActive = true;

    window.hideGridView();
    assert.strictEqual(a.webglAddon, null, 'a suspended on grid close');
    assert.strictEqual(b.webglAddon, null, 'b suspended on grid close');
    const disposesAfterHide = spies.webglDispose;

    window.showSession('a');

    assert.ok(a.webglAddon, 'a restored — it is the one being shown in single view');
    assert.strictEqual(b.webglAddon, null, 'b stays suspended — hidden in single view');
    assert.strictEqual(spies.webglDispose, disposesAfterHide,
      'no extra dispose calls — restoring a never re-suspends it (no double-suspend)');
  } finally {
    destroy();
  }
});
