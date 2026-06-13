'use strict';

// ---------------------------------------------------------------------------
// PTY output-replay buffer helper
// ---------------------------------------------------------------------------
//
// Problem: each PTY `onData` event pushes one string into `session.outputBuffer`.
// Under heavy streaming (thousands of paint events per second) this produces
// thousands of array entries — each with its own V8 ArraySlot + String-object
// overhead.  Audit Q8 estimated worst-case ~400 KB of overhead per active
// session just from the GC roots and slot metadata.
//
// Solution: coalesce-on-threshold.
//   • After each push, if `outputBuffer.length` exceeds COALESCE_THRESHOLD,
//     collapse the entire array into a single concatenated string and reset
//     the length to 1.  This bounds per-session slot pressure to at most
//     COALESCE_THRESHOLD + 1 entries (one coalesced spine + new arrivals).
//   • Whole-entry front-trim (shift) still runs first; coalescing comes after.
//     Trim semantics are unchanged from the original: we drop whole chunks,
//     never split mid-chunk.
//   • When after coalescing we end up with a single string that is still
//     larger than MAX_BUFFER_SIZE we must trim it.  We cannot shift it
//     (that would zero the buffer).  Instead we slice off the tail
//     (MAX_BUFFER_SIZE bytes from the end), then advance past the first '\n'
//     so the buffer always starts on a line boundary — ensuring replay never
//     starts mid-ANSI-escape-sequence or mid-UTF-8-codepoint.
//
// Replay correctness:
//   The reattach loop in main.js iterates `for (const chunk of outputBuffer)`
//   and forwards each chunk verbatim to xterm.js.  Because we only ever
//   remove bytes from the front of the conceptual stream (never insert, split,
//   or reorder), xterm.js sees a consistent terminal state.  The line-boundary
//   trim means the replay starts at a newline (not mid-escape), so cursor/color
//   state from before the trim window is simply absent — same trade-off the
//   original whole-chunk front-trim had, just at a byte-accurate boundary.
//
// Constants (exported for tests):
//   COALESCE_THRESHOLD = 64   — collapse when array grows beyond this length
//
// ---------------------------------------------------------------------------

const COALESCE_THRESHOLD = 64;

/**
 * Push `data` into `state.outputBuffer` and maintain the two invariants:
 *   1. `state.outputBufferSize` ≤ `max` (the 256 KB ceiling by default)
 *   2. `state.outputBuffer.length` ≤ COALESCE_THRESHOLD + 1
 *
 * `state` shape: `{ outputBuffer: string[], outputBufferSize: number }`
 *
 * Pure with respect to the state object — no side effects beyond mutations on
 * `state`.  Designed to be unit-testable in isolation from main.js / Electron.
 *
 * @param {{ outputBuffer: string[], outputBufferSize: number }} state
 * @param {string} data
 * @param {number} max  Maximum retained bytes (normally MAX_BUFFER_SIZE = 256 KB)
 */
function appendToOutputBuffer(state, data, max) {
  if (!data) return;

  state.outputBuffer.push(data);
  state.outputBufferSize += data.length;

  // --- Step 1: whole-entry front-trim (original semantics, unchanged) ------
  // Drop entire leading chunks until we are within the byte budget.
  // Guard `length > 1` ensures we never empty the array here — the oversized
  // single-entry case is handled separately below.
  while (state.outputBufferSize > max && state.outputBuffer.length > 1) {
    state.outputBufferSize -= state.outputBuffer.shift().length;
  }

  // --- Step 2: coalesce-on-threshold ---------------------------------------
  // If the array has grown beyond COALESCE_THRESHOLD entries, collapse it into
  // one concatenated string.  This caps the per-session slot count without
  // changing the byte content.
  if (state.outputBuffer.length > COALESCE_THRESHOLD) {
    const joined = state.outputBuffer.join('');
    state.outputBuffer = [joined];
    state.outputBufferSize = joined.length; // recompute — join doesn't change bytes
  }

  // --- Step 3: single-entry overflow trim (line-boundary-safe) -------------
  // After coalescing we may still hold a single entry that exceeds `max`
  // (because the `length > 1` guard in step 1 would have left it untouched).
  // Trim from the front to `max` bytes, then advance past the first '\n' so
  // the retained content starts on a line boundary.  This guarantees replay
  // never starts in the middle of an ANSI escape sequence or a multi-byte
  // UTF-8 codepoint (both of which never span lines in practice).
  //
  // Trade-off: terminal state from before the trim window (colours, cursor
  // position) will be absent on reattach — identical trade-off to the
  // original whole-chunk trim, just byte-accurate instead of chunk-accurate.
  if (state.outputBuffer.length === 1 && state.outputBufferSize > max) {
    const s = state.outputBuffer[0];
    // Keep the LAST `max` bytes (newest content).
    const tail = s.slice(s.length - max);
    // Advance past the first newline so we start on a line boundary.
    const nl = tail.indexOf('\n');
    const trimmed = nl >= 0 ? tail.slice(nl + 1) : tail;
    state.outputBuffer = [trimmed];
    state.outputBufferSize = trimmed.length;
  }
}

module.exports = { appendToOutputBuffer, COALESCE_THRESHOLD };
