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
//   • Coalescing runs BEFORE front-trim.  This is critical: if trim ran first,
//     it could coalesce N entries into one large spine, then the next trim call
//     would atomically shift that entire spine (e.g. 193 KB dropped in one
//     call), reducing steady-state retained history to ~64 KB instead of ~256 KB.
//     With coalesce-first, the single coalesced entry is handled by the
//     line-boundary byte-slice (step 3) rather than a whole-entry shift.
//   • When after coalescing we end up with a single string that is still
//     larger than MAX_BUFFER_SIZE we must trim it.  We cannot shift it
//     (that would zero the buffer).  Instead we slice off the tail
//     (MAX_BUFFER_SIZE bytes from the end), then advance past the first '\n'
//     so the buffer always starts on a line boundary — ensuring replay never
//     starts mid-ANSI-escape-sequence or mid-UTF-8-codepoint.
//
// Step order (critical for correctness):
//   1. push
//   2. coalesce-on-threshold (before trim — see note above)
//   3. whole-entry front-trim (only fires when length > 1, i.e. not after coalesce)
//   4. single-entry byte-slice at line boundary (fires when coalesced entry > max,
//      or when a single chunk larger than max is pushed directly)
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
// No-newline fallback (known limitation):
//   When the 256 K tail contains no '\n' (e.g. dense \r-based progress bars or
//   full-screen renders), the byte-slice falls back to the raw tail without
//   advancing to a line boundary.  This can place the replay start mid-ANSI-
//   escape or mid-UTF-8 codepoint for pathological \r-only output.  In practice
//   almost all interactive terminal sessions have at least one '\n' in any
//   256 KB window, so this is an accepted trade-off documented here rather than
//   fixed (same implicit risk the original whole-chunk trim had).
//
// Constants (exported for tests):
//   COALESCE_THRESHOLD = 64         — collapse when array grows beyond this length
//   MAX_BUFFER_SIZE    = 256 * 1024 — maximum retained UTF-16 code units
//                                     (≈ 256 KB for ASCII output)
//
// ---------------------------------------------------------------------------

const COALESCE_THRESHOLD = 64;
const MAX_BUFFER_SIZE = 256 * 1024;

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
 * @param {number} max  Maximum retained UTF-16 code units (normally MAX_BUFFER_SIZE)
 */
function appendToOutputBuffer(state, data, max) {
  if (!data) return;

  state.outputBuffer.push(data);
  state.outputBufferSize += data.length;

  // --- Step 1: coalesce-on-threshold (BEFORE trim) -------------------------
  // Collapse the array into a single string in two situations:
  //   (a) the entry count exceeds COALESCE_THRESHOLD — caps per-session slot
  //       pressure (the primary perf goal of this helper).
  //   (b) the buffer is over budget with more than one entry — this happens
  //       after step 3 previously trimmed a spine to ~max bytes (the line-boundary
  //       slice leaves a spine of up to max-1 bytes) and one or more small new
  //       chunks were pushed on top.  Without this coalesce, step 2's `length > 1`
  //       guard would shift the ~max spine in one call, atomically dropping nearly
  //       the entire history.  Coalescing first means step 3 can do a byte-accurate
  //       front-trim instead.  We deliberately do NOT gate on `outputBuffer[0].length
  //       >= max`: the nl=0 case in step 3 produces a spine of exactly max-1 bytes,
  //       which would slip under that guard and reintroduce the atomic-drop bug.
  if (
    state.outputBuffer.length > COALESCE_THRESHOLD ||
    (state.outputBufferSize > max && state.outputBuffer.length > 1)
  ) {
    const joined = state.outputBuffer.join('');
    state.outputBuffer = [joined];
    state.outputBufferSize = joined.length; // recompute — join doesn't change bytes
  }

  // --- Step 2: whole-entry front-trim --------------------------------------
  // Drop entire leading chunks until we are within the byte budget.
  // Guard `length > 1` skips a single entry (whether a coalesced spine or a
  // single huge push); that case is handled by the byte-slice in step 3.
  while (state.outputBufferSize > max && state.outputBuffer.length > 1) {
    state.outputBufferSize -= state.outputBuffer.shift().length;
  }

  // --- Step 3: single-entry overflow trim (line-boundary-safe) -------------
  // Reachable when the buffer contains exactly one entry that exceeds `max`.
  // This happens in two cases:
  //   (a) after step 1 coalesced entries into a spine larger than max, or
  //   (b) a single push of a chunk that is itself larger than max.
  // In both cases, trim from the front to `max` bytes, then advance past the
  // first '\n' so replay starts on a line boundary.
  //
  // No-newline fallback: if the tail contains no '\n', the raw tail is kept
  // as-is.  See module-level comment "No-newline fallback" for the trade-off.
  if (state.outputBuffer.length === 1 && state.outputBufferSize > max) {
    const s = state.outputBuffer[0];
    // Keep the LAST `max` code units (newest content).
    const tail = s.slice(s.length - max);
    // Advance past the first newline so we start on a line boundary.
    const nl = tail.indexOf('\n');
    const trimmed = nl >= 0 ? tail.slice(nl + 1) : tail;
    state.outputBuffer = [trimmed];
    state.outputBufferSize = trimmed.length;
  }
}

module.exports = { appendToOutputBuffer, COALESCE_THRESHOLD, MAX_BUFFER_SIZE };
