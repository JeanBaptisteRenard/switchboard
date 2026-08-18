// Full-suspend hidden-terminal rendering: a session that is neither the
// active single-view terminal nor part of an open grid gets ZERO of its PTY
// output handed to xterm — no parse, no DOM/WebGL render — until it is shown
// again, at which point the accumulated buffer replays in one atomic write.
//
// Supersedes an earlier ~1fps flush-throttle design (still parsed on every
// flush); see terminal-manager.js's isHiddenSingleViewSession comment for the
// measured residual that motivated going further. WebGL context suspend on
// switch (a separate, still-unchanged mechanism) is covered in
// test/terminal-hidden-rendering.test.js.
//
// Two layers under test:
//   1. Pure string helpers (findLastSafeRedrawMarker, findEscapeSequenceEnd,
//      advanceToAnsiSafeBoundary, trimHiddenBuffer) — exported directly from
//      public/terminal-manager.js, no DOM needed.
//   2. The accumulate/replay integration, via the shared jsdom harness.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  findLastSafeRedrawMarker, findEscapeSequenceEnd, advanceToAnsiSafeBoundary, trimHiddenBuffer,
} = require('../public/terminal-manager');
const { setupTerminalDom } = require('./terminal-manager-harness');

// --- Pure helpers ---

test('findLastSafeRedrawMarker: finds the LAST occurrence among several marker types', () => {
  const str = 'garbage\x1b[2Jscreen1\x1b[?1049hscreen2';
  assert.strictEqual(findLastSafeRedrawMarker(str), str.lastIndexOf('\x1b[?1049h'));
});

test('findLastSafeRedrawMarker: returns -1 when no marker is present', () => {
  assert.strictEqual(findLastSafeRedrawMarker('just plain streaming text, no redraw'), -1);
});

test('findLastSafeRedrawMarker: a marker embedded inside an unrelated longer CSI sequence is not a false negative source — exact literal match still found', () => {
  // \x1b[42J (CSI with a different numeric parameter) must not be confused
  // with \x1b[2J — this asserts the real marker is still found when both are
  // present, i.e. the scan isn't accidentally skipping the whole string.
  const str = 'before\x1b[42Jnotamarker\x1b[2Jafter';
  const idx = findLastSafeRedrawMarker(str);
  assert.strictEqual(str.slice(idx, idx + 4), '\x1b[2J');
});

test('findEscapeSequenceEnd: CSI sequence with parameters and intermediates', () => {
  const str = '\x1b[1;2Krest';
  // ESC [ 1 ; 2 K -> final byte 'K' at index 5, end = 6
  assert.strictEqual(findEscapeSequenceEnd(str, 0), 6);
});

test('findEscapeSequenceEnd: unterminated CSI at end of string returns -1', () => {
  const str = 'abc\x1b[1;2';
  assert.strictEqual(findEscapeSequenceEnd(str, 3), -1);
});

test('findEscapeSequenceEnd: OSC terminated by BEL', () => {
  const str = '\x1b]0;title\x07rest';
  const bel = str.indexOf('\x07');
  assert.strictEqual(findEscapeSequenceEnd(str, 0), bel + 1);
});

test('findEscapeSequenceEnd: OSC terminated by ST (ESC \\\\)', () => {
  const str = '\x1b]8;;http://x\x1b\\rest';
  const st = str.indexOf('\x1b\\', 1);
  assert.strictEqual(findEscapeSequenceEnd(str, 0), st + 2);
});

test('findEscapeSequenceEnd: unterminated OSC returns -1', () => {
  const str = '\x1b]0;no terminator here';
  assert.strictEqual(findEscapeSequenceEnd(str, 0), -1);
});

test('findEscapeSequenceEnd: generic 2-byte escape', () => {
  const str = '\x1b7rest'; // save cursor
  assert.strictEqual(findEscapeSequenceEnd(str, 0), 2);
});

test('findEscapeSequenceEnd: bare ESC as the last character returns -1', () => {
  assert.strictEqual(findEscapeSequenceEnd('abc\x1b', 3), -1);
});

test('advanceToAnsiSafeBoundary: index already at a clean boundary is returned unchanged', () => {
  const str = 'plain text \x1b[2Jmore';
  assert.strictEqual(advanceToAnsiSafeBoundary(str, 5), 5);
});

test('advanceToAnsiSafeBoundary: index inside a CSI sequence advances past it', () => {
  const str = 'AA\x1b[12;34mBB'; // CSI spans indices [2, 10)
  const csiEnd = str.indexOf('m') + 1;
  assert.strictEqual(advanceToAnsiSafeBoundary(str, 5), csiEnd, 'never splits the CSI sequence');
});

test('advanceToAnsiSafeBoundary: index inside an OSC sequence advances past it', () => {
  const str = 'AA\x1b]0;hello\x07BB';
  const oscEnd = str.indexOf('\x07') + 1;
  assert.strictEqual(advanceToAnsiSafeBoundary(str, 5), oscEnd);
});

test('advanceToAnsiSafeBoundary: clamps out-of-range indices', () => {
  assert.strictEqual(advanceToAnsiSafeBoundary('abc', -5), 0);
  assert.strictEqual(advanceToAnsiSafeBoundary('abc', 999), 3);
});

test('trimHiddenBuffer: no-op when already under budget', () => {
  const result = trimHiddenBuffer('short', 100);
  assert.deepStrictEqual(result, { data: 'short', reset: false });
});

test('trimHiddenBuffer: cuts at the last safe redraw marker when it fits the budget', () => {
  const raw = 'x'.repeat(50) + '\x1b[2J' + 'y'.repeat(10);
  const result = trimHiddenBuffer(raw, 20);
  assert.strictEqual(result.data, '\x1b[2J' + 'y'.repeat(10));
  assert.strictEqual(result.reset, false, 'a safe marker cut never needs a reset');
});

test('trimHiddenBuffer: never cuts mid-escape-sequence even in the no-marker fallback', () => {
  // No safe marker anywhere; the naive byte-budget cut would land inside the
  // trailing CSI sequence — the boundary must advance past it.
  const raw = 'z'.repeat(30) + '\x1b[12;34mtail';
  const naiveStart = raw.length - 10; // lands inside "\x1b[12;34m"
  assert.ok(naiveStart > raw.indexOf('\x1b') && naiveStart < raw.indexOf('m') + 1,
    'sanity: the naive cut really does land inside the CSI sequence');
  const result = trimHiddenBuffer(raw, 10);
  assert.strictEqual(result.reset, true, 'no usable marker — falls back to reset+tail');
  assert.ok(!result.data.startsWith(';34mtail') && !result.data.startsWith('34mtail'),
    'kept tail does not start mid-sequence');
  assert.ok(result.data === 'tail' || result.data.startsWith('\x1b[12;34mtail'),
    'kept tail starts either after the whole sequence, or at its untouched start');
});

test('trimHiddenBuffer: falls back to reset+tail when the last marker still does not fit the budget', () => {
  const raw = '\x1b[2J' + 'y'.repeat(100); // marker present, but slice from it is still 104 chars
  const result = trimHiddenBuffer(raw, 20);
  assert.strictEqual(result.reset, true);
  assert.strictEqual(result.data.length, 20);
  assert.ok(result.data.endsWith('y'), 'kept the newest bytes');
});

// --- Accumulate-while-hidden / replay-on-show integration ---

test('a hidden session never calls terminal.write() while receiving data', () => {
  const { window, spies, destroy } = setupTerminalDom();
  try {
    window.createTerminalEntry({ sessionId: 'active' });
    window.createTerminalEntry({ sessionId: 'hidden' });
    window.activeSessionId = 'active';
    window.gridViewActive = false;

    window.handleTerminalData('hidden', 'chunk1');
    window.handleTerminalData('hidden', 'chunk2');
    window.handleTerminalData('hidden', 'chunk3');

    assert.strictEqual(spies.write, 0, 'no write() while the session stays hidden');
  } finally {
    destroy();
  }
});

test('showing a hidden session replays its accumulated buffer exactly once, in order, before becoming visible', () => {
  const { window, spies, destroy } = setupTerminalDom();
  try {
    const entry = window.createTerminalEntry({ sessionId: 'hidden' });
    window.createTerminalEntry({ sessionId: 'active' });
    window.activeSessionId = 'active';
    window.gridViewActive = false;

    window.handleTerminalData('hidden', 'chunk1-');
    window.handleTerminalData('hidden', 'chunk2-');
    window.handleTerminalData('hidden', 'chunk3');
    assert.strictEqual(spies.write, 0);

    window.showSession('hidden');

    assert.strictEqual(spies.write, 1, 'exactly one write for the whole accumulated buffer');
    assert.strictEqual(spies.writes[0], 'chunk1-chunk2-chunk3', 'chunks replayed in arrival order');
    assert.ok(entry.element.classList.contains('visible'), 'reveal happens after the replay was issued');
  } finally {
    destroy();
  }
});

test('a session with nothing accumulated is a no-op on show (no spurious write)', () => {
  const { window, spies, destroy } = setupTerminalDom();
  try {
    window.createTerminalEntry({ sessionId: 's1' });
    window.showSession('s1');
    assert.strictEqual(spies.write, 0);
  } finally {
    destroy();
  }
});

test('overflow cuts at the last safe redraw marker (alt-screen) and never mid-escape', () => {
  const { window, spies, destroy } = setupTerminalDom();
  try {
    window.createTerminalEntry({ sessionId: 'hidden' });
    window.createTerminalEntry({ sessionId: 'active' });
    window.activeSessionId = 'active';
    window.gridViewActive = false;

    // Push past HIDDEN_BUFFER_MAX_LEN (2 MB) with junk, then a real alt-screen
    // redraw near the end — the kept buffer should start at that marker.
    window.handleTerminalData('hidden', 'x'.repeat(2 * 1024 * 1024 + 100));
    const tail = '\x1b[?1049hALT-SCREEN-CONTENT';
    window.handleTerminalData('hidden', tail);

    window.showSession('hidden');

    assert.strictEqual(spies.write, 1);
    assert.strictEqual(spies.writes[0], tail, 'replay starts exactly at the alt-screen marker, junk dropped');
  } finally {
    destroy();
  }
});

test('no-safe-point overflow resets the terminal before replaying the tail', () => {
  const { window, spies, destroy } = setupTerminalDom();
  try {
    window.createTerminalEntry({ sessionId: 'hidden' });
    window.createTerminalEntry({ sessionId: 'active' });
    window.activeSessionId = 'active';
    window.gridViewActive = false;

    // Pure streaming text, no redraw marker anywhere, well past the cap.
    window.handleTerminalData('hidden', 'y'.repeat(2 * 1024 * 1024 + 500));

    window.showSession('hidden');

    assert.strictEqual(spies.reset, 1, 'terminal.reset() called before the tail replay');
    assert.strictEqual(spies.write, 1);
    assert.ok(spies.writes[0].length <= 2 * 1024 * 1024, 'kept tail respects the cap');
  } finally {
    destroy();
  }
});

test('rapid hide/show/hide/show (A -> B -> A) replays each accumulation independently, no duplication or loss', () => {
  const { window, spies, destroy } = setupTerminalDom();
  try {
    const a = window.createTerminalEntry({ sessionId: 'a' });
    window.createTerminalEntry({ sessionId: 'b' });
    window.activeSessionId = 'a';
    window.gridViewActive = false;

    window.showSession('a'); // a becomes active/visible, nothing accumulated yet
    assert.strictEqual(spies.write, 0);

    window.activeSessionId = 'a';
    window.showSession('b'); // a is now hidden; b active
    // setActiveSession is stubbed as a no-op in this harness (see
    // terminal-manager-harness.js) — showSession's own suspend logic already
    // captured 'a' as the outgoing session above, but classification for the
    // handleTerminalData calls below needs activeSessionId flipped by hand.
    window.activeSessionId = 'b';
    window.handleTerminalData('a', 'while-hidden-1');
    window.handleTerminalData('a', 'while-hidden-2');
    assert.strictEqual(spies.write, 0, 'a accumulates silently while hidden behind b');

    window.activeSessionId = 'b';
    window.showSession('a'); // back to a — must replay exactly the accumulated content once

    assert.strictEqual(spies.write, 1);
    assert.strictEqual(spies.writes[0], 'while-hidden-1while-hidden-2');
    assert.ok(a.element.classList.contains('visible'));

    // Showing it again immediately must not replay anything a second time.
    window.activeSessionId = 'a';
    window.showSession('a');
    assert.strictEqual(spies.write, 1, 'no duplicate replay on a redundant show');
  } finally {
    destroy();
  }
});

test('destroySession with a pending hidden buffer is a safe no-op (no write to a disposed terminal, no leak)', () => {
  const { window, spies, inCtx, destroy } = setupTerminalDom();
  try {
    window.createTerminalEntry({ sessionId: 'hidden' });
    window.createTerminalEntry({ sessionId: 'active' });
    window.activeSessionId = 'active';
    window.gridViewActive = false;

    window.handleTerminalData('hidden', 'never shown');

    assert.doesNotThrow(() => window.destroySession('hidden'));
    assert.strictEqual(spies.write, 0, 'destroyed before ever being shown — no write happened');
    assert.strictEqual(inCtx(`hiddenAccumulators.has('hidden')`), false, 'accumulator cleared, nothing to leak');
  } finally {
    destroy();
  }
});

test('grid open (wrapInGridCard) force-materializes a hidden accumulator before the card becomes visible', () => {
  const { window, spies, destroy } = setupTerminalDom();
  try {
    window.sessionMap.set('s1', { sessionId: 's1', name: 's1', projectPath: '/p' });
    window.createTerminalEntry({ sessionId: 's1' });
    window.createTerminalEntry({ sessionId: 'active' });
    window.activeSessionId = 'active';
    window.gridViewActive = false; // s1 is genuinely hidden in single view first

    window.handleTerminalData('s1', 'buffered-before-grid-opened');
    assert.strictEqual(spies.write, 0);

    // gridViewActive stays false here — this exercises wrapInGridCard's own
    // force-materialize call directly (matching the plain-append DOM path);
    // showGridView's full sortedOrder/cachedProjects grouping is exercised
    // elsewhere and isn't needed to prove the replay happens.
    window.wrapInGridCard('s1');

    assert.strictEqual(spies.write, 1, 'accumulated buffer materialized into the grid card');
    assert.strictEqual(spies.writes[0], 'buffered-before-grid-opened');
  } finally {
    destroy();
  }
});

test('sync-block interplay: a full ESC[?2026h/l pair embedded in hidden data replays intact, in one write', () => {
  const { window, spies, destroy } = setupTerminalDom();
  try {
    window.createTerminalEntry({ sessionId: 'hidden' });
    window.createTerminalEntry({ sessionId: 'active' });
    window.activeSessionId = 'active';
    window.gridViewActive = false;

    const redraw = '\x1b[?2026hredraw-body\x1b[?2026l';
    window.handleTerminalData('hidden', 'before-');
    window.handleTerminalData('hidden', redraw);
    window.handleTerminalData('hidden', '-after');
    assert.strictEqual(spies.write, 0, 'no write at all while hidden, sync block or not');

    window.showSession('hidden');

    assert.strictEqual(spies.write, 1, 'the whole thing — including the sync block — replays as one write');
    assert.strictEqual(spies.writes[0], 'before-' + redraw + '-after');
  } finally {
    destroy();
  }
});

test('the active session is unaffected: still buffered via terminalWriteBuffers and flushed at the 30fps cadence, not accumulated', () => {
  const { window, inCtx, destroy } = setupTerminalDom();
  try {
    window.createTerminalEntry({ sessionId: 'active' });
    window.activeSessionId = 'active';
    window.gridViewActive = false;

    window.handleTerminalData('active', 'live data');

    assert.strictEqual(inCtx(`hiddenAccumulators.has('active')`), false, 'active session bypasses the hidden accumulator entirely');
    const buf = inCtx(`terminalWriteBuffers.get('active')`);
    assert.ok(buf, 'active session still uses the normal write-buffer path');
    assert.ok(buf.rafId !== 0 || buf.timerId !== 0, 'a flush is scheduled — 30fps cadence unchanged');
  } finally {
    destroy();
  }
});

test('a grid session (open grid, not hidden) also bypasses the hidden accumulator', () => {
  const { window, inCtx, destroy } = setupTerminalDom();
  try {
    window.createTerminalEntry({ sessionId: 'other' });
    window.activeSessionId = 'active-elsewhere';
    window.gridViewActive = true;

    window.handleTerminalData('other', 'grid data');

    assert.strictEqual(inCtx(`hiddenAccumulators.has('other')`), false);
    assert.ok(inCtx(`terminalWriteBuffers.has('other')`), 'grid sessions keep the normal write-buffer path');
  } finally {
    destroy();
  }
});
