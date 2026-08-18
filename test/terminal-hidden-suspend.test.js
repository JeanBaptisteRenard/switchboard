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
  skipLoneLowSurrogate,
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

// Regression (review finding F2): DCS/APC/PM are string-type sequences with
// an arbitrary-length payload, just like OSC — sixel image data arrives as a
// DCS payload. The old fallback treated ESC P as a generic 2-byte escape,
// ending 2 chars in even though the real terminator (ST) was far later.
test('findEscapeSequenceEnd: DCS (ESC P) with a long sixel-shaped payload is terminated by ST, not treated as a 2-byte escape', () => {
  const payload = 'q#0;2;0;0;0'.repeat(50);
  const str = '\x1bP' + payload + '\x1b\\TAIL_AFTER_DCS';
  const st = str.indexOf('\x1b\\');
  assert.strictEqual(findEscapeSequenceEnd(str, 0), st + 2,
    'scans all the way to the real ST terminator, not 2 chars in');
});

test('findEscapeSequenceEnd: APC (ESC _) and PM (ESC ^) are also ST-terminated, and do NOT accept a bare BEL (unlike OSC)', () => {
  const apc = '\x1b_apc payload with a stray \x07 BEL inside\x1b\\rest';
  const apcSt = apc.indexOf('\x1b\\');
  assert.strictEqual(findEscapeSequenceEnd(apc, 0), apcSt + 2, 'BEL inside an APC payload is not a terminator');

  const pm = '\x1b^pm payload\x1b\\rest';
  const pmSt = pm.indexOf('\x1b\\');
  assert.strictEqual(findEscapeSequenceEnd(pm, 0), pmSt + 2);
});

test('findEscapeSequenceEnd: unterminated DCS returns -1', () => {
  const str = '\x1bP' + 'q#0;2;0;0;0'.repeat(50); // no ST anywhere
  assert.strictEqual(findEscapeSequenceEnd(str, 0), -1);
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

// Regression (review finding F2): a naive cut landing inside a DCS/sixel
// payload used to be returned unchanged (mis-scoped as a 2-byte escape).
test('advanceToAnsiSafeBoundary: index inside a DCS (sixel-shaped) payload advances past its real ST terminator', () => {
  const payload = 'q#0;2;0;0;0'.repeat(50);
  const str = '\x1bP' + payload + '\x1b\\TAIL';
  const dcsEnd = str.indexOf('\x1b\\') + 2;
  const cutInsidePayload = 30; // well inside the repeated payload, far before the real ST
  assert.ok(cutInsidePayload > str.indexOf('\x1b') && cutInsidePayload < dcsEnd,
    'sanity: the chosen index really does land inside the DCS payload');
  assert.strictEqual(advanceToAnsiSafeBoundary(str, cutInsidePayload), dcsEnd);
});

// Regression (review finding F3): a naive cut landing between a high and low
// UTF-16 surrogate used to be returned unchanged, producing a tail starting
// with an unpaired low surrogate.
test('skipLoneLowSurrogate: advances past a lone low surrogate, leaves everything else unchanged', () => {
  const emoji = '\u{1F600}'; // high surrogate 0xD83D, low surrogate 0xDE00
  const highIdx = 3;
  const lowIdx = highIdx + 1;
  const str = 'abc' + emoji + 'def';
  assert.strictEqual(str.charCodeAt(lowIdx) >= 0xdc00 && str.charCodeAt(lowIdx) <= 0xdfff, true, 'sanity: lowIdx is really a low surrogate');
  assert.strictEqual(skipLoneLowSurrogate(str, lowIdx), lowIdx + 1, 'steps past the lone low surrogate');
  assert.strictEqual(skipLoneLowSurrogate(str, highIdx), highIdx, 'a high surrogate is left alone — it is not a lone low surrogate');
  assert.strictEqual(skipLoneLowSurrogate(str, 0), 0, 'plain ASCII is unaffected');
  assert.strictEqual(skipLoneLowSurrogate(str, str.length), str.length, 'end-of-string index is left as-is');
});

test('advanceToAnsiSafeBoundary: never returns an index that starts with a lone low surrogate', () => {
  const emoji = '\u{1F600}';
  const str = 'AA' + emoji + 'BB'; // no escape sequences at all — pure surrogate-safety path
  const lowSurrogateIdx = str.indexOf(emoji) + 1;
  assert.strictEqual(advanceToAnsiSafeBoundary(str, lowSurrogateIdx), lowSurrogateIdx + 1);
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

// Regression (review finding F2): with no safe redraw marker present, a long
// DCS/sixel payload used to let the naive cut land mid-payload because the
// boundary scanner mis-scoped ESC P as a 2-byte escape.
test('trimHiddenBuffer: never cuts inside a DCS (sixel-shaped) payload in the no-marker fallback', () => {
  const payload = 'q#0;2;0;0;0'.repeat(50);
  const raw = 'z'.repeat(30) + '\x1bP' + payload + '\x1b\\TAIL';
  const dcsEnd = raw.indexOf('\x1b\\') + 2;
  const maxLen = raw.length - 40; // naive cut lands inside the DCS payload
  const naiveStart = raw.length - maxLen;
  assert.ok(naiveStart > raw.indexOf('\x1bP') && naiveStart < dcsEnd,
    'sanity: the naive cut really does land inside the DCS payload');
  const result = trimHiddenBuffer(raw, maxLen);
  assert.strictEqual(result.reset, true);
  assert.ok(result.data === 'TAIL' || result.data.startsWith('\x1bP'),
    'kept tail starts either right after the DCS sequence, or at its untouched start — never mid-payload');
});

// Regression (review finding F3): the no-marker fallback used to be able to
// split a UTF-16 surrogate pair (e.g. an emoji) straddling the cut point.
test('trimHiddenBuffer: never splits a surrogate pair (emoji) in the no-marker fallback', () => {
  const emoji = '\u{1F600}';
  const raw = 'z'.repeat(30) + emoji + 'TAIL_AFTER_EMOJI';
  const maxLen = raw.length - 31; // naive cut lands exactly between the emoji's two surrogates
  const naiveStart = raw.length - maxLen;
  assert.strictEqual(naiveStart, raw.indexOf(emoji) + 1, 'sanity: the naive cut lands between the two surrogate halves');
  const result = trimHiddenBuffer(raw, maxLen);
  assert.strictEqual(result.reset, true);
  const firstCode = result.data.charCodeAt(0);
  assert.ok(firstCode < 0xdc00 || firstCode > 0xdfff, 'kept tail never starts with a lone low surrogate');
  assert.strictEqual(result.data, 'TAIL_AFTER_EMOJI', 'the whole (unpaired) emoji is dropped, tail starts clean');
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

// Regression (review finding F1, CRITICAL): a session that becomes hidden
// while it still has a pending terminalWriteBuffers entry (an ordinary
// <=33ms flush, or — as here — a sync block whose 500ms SYNC_BUFFER_TIMEOUT
// safety timer is still armed) used to leave that leftover buffer as a
// second, independently-scheduled queue. Switching back before the old
// timer fired made replayHiddenBuffer paint the NEWER accumulated content
// first, then the leftover flush painted OLDER content after it —
// inverting visible order. Fixed by draining the leftover buffer into the
// hidden accumulator (order preserved) the moment new data needs to reach
// it while hidden.
test('regression (F1): a leftover pending live-buffer flush is drained into the hidden accumulator, preserving chronological order', () => {
  const { window, spies, inCtx, destroy } = setupTerminalDom();
  try {
    window.createTerminalEntry({ sessionId: 'a' });
    window.createTerminalEntry({ sessionId: 'b' });
    window.activeSessionId = 'a';
    window.gridViewActive = false;

    // 'a' is active and opens a sync block — lands in terminalWriteBuffers,
    // with its SYNC_BUFFER_TIMEOUT safety timer armed (syncDepth stays > 0).
    window.handleTerminalData('a', '\x1b[?2026hC1_OLD');
    assert.strictEqual(inCtx(`terminalWriteBuffers.get('a').syncDepth`), 1);
    assert.ok(inCtx(`terminalWriteBuffers.get('a').timerId`) !== 0, 'sync safety timer armed while still active');

    // The user switches away — 'a' becomes hidden. setActiveSession is
    // stubbed as a no-op in this harness, so activeSessionId is flipped by
    // hand to mirror what production's real setActiveSession would do.
    window.showSession('b');
    window.activeSessionId = 'b';

    window.handleTerminalData('a', 'C2_NEW'); // newer data, arrives while hidden

    assert.strictEqual(inCtx(`terminalWriteBuffers.has('a')`), false,
      'leftover buffer drained and removed — no independent queue left armed');
    assert.strictEqual(spies.write, 0, 'nothing painted yet — still accumulating');

    // Switch back to 'a' well before the old 500ms timer would ever fire.
    window.showSession('a');
    window.activeSessionId = 'a';

    assert.strictEqual(spies.write, 1, 'exactly one replay write');
    assert.strictEqual(spies.writes[0], '\x1b[?2026hC1_OLDC2_NEW',
      'older content replays BEFORE newer content — chronological order preserved');

    // Had the old timer survived, it would call this directly — confirm
    // it's a safe no-op now (already drained), not a second, out-of-order
    // write landing after the reveal.
    assert.doesNotThrow(() => window.flushTerminalBuffer('a'));
    assert.strictEqual(spies.write, 1, 'no additional out-of-order write from the old timer');
  } finally {
    destroy();
  }
});

// Regression (review finding F4, WARNING) — the no-new-data variant of F1:
// drainLiveBufferIntoHiddenAccumulator only ran from handleTerminalData's
// hidden branch, so a session hidden with a pending leftover live buffer
// that receives NO further data before being shown again got a reveal that
// painted nothing until the leftover's own timer/rAF eventually fired —
// possibly after the container was already visible. Fixed by also draining
// from replayHiddenBuffer itself, the single choke point both showSession
// and wrapInGridCard go through.
test('regression (F4): showSession drains a leftover live buffer immediately on reveal, even with no new data while hidden (plain switch)', () => {
  const { window, spies, inCtx, destroy } = setupTerminalDom();
  try {
    window.createTerminalEntry({ sessionId: 'a' });
    window.createTerminalEntry({ sessionId: 'b' });
    window.activeSessionId = 'a';
    window.gridViewActive = false;

    // 'a' is active and opens a sync block — lands in terminalWriteBuffers,
    // with its SYNC_BUFFER_TIMEOUT safety timer armed.
    window.handleTerminalData('a', '\x1b[?2026hC1_OLD');
    assert.ok(inCtx(`terminalWriteBuffers.get('a').timerId`) !== 0, 'sync safety timer armed while still active');

    // Switch away and immediately back — 'a' becomes hidden and is shown
    // again with NO handleTerminalData call for it in between, so the
    // hidden branch's drain never ran.
    window.showSession('b');
    window.activeSessionId = 'b';
    window.showSession('a');
    window.activeSessionId = 'a';

    assert.strictEqual(spies.write, 1, 'the leftover buffer is painted immediately on reveal, not left for its own timer');
    assert.strictEqual(spies.writes[0], '\x1b[?2026hC1_OLD');
    assert.strictEqual(inCtx(`terminalWriteBuffers.has('a')`), false, 'leftover buffer drained and removed on reveal');
  } finally {
    destroy();
  }
});

test('regression (F4): hideGridView -> showSession drains the revealed session\'s leftover live buffer (grid close, no new data)', () => {
  const { window, spies, inCtx, destroy } = setupTerminalDom();
  try {
    window.createTerminalEntry({ sessionId: 'a' });
    window.createTerminalEntry({ sessionId: 'b' });
    window.activeSessionId = 'a';
    window.gridViewActive = true;

    // Both sessions accumulate an ordinary pending flush while the grid is
    // open (fast cadence — terminalWriteBuffers, never the hidden
    // accumulator, since no session is "hidden" while gridViewActive).
    window.handleTerminalData('a', 'A_PENDING');
    window.handleTerminalData('b', 'B_PENDING');
    assert.ok(inCtx(`terminalWriteBuffers.has('a')`));
    assert.ok(inCtx(`terminalWriteBuffers.has('b')`));

    window.hideGridView();
    window.showSession('a'); // 'a' becomes the single-view active session; 'b' stays hidden

    assert.strictEqual(spies.write, 1, 'a\'s leftover buffer is painted immediately on reveal');
    assert.strictEqual(spies.writes[0], 'A_PENDING');
    assert.strictEqual(inCtx(`terminalWriteBuffers.has('a')`), false, 'a\'s leftover drained and removed on reveal');
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
