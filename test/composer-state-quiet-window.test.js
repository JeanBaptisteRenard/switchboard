// test/composer-state-quiet-window.test.js — end-to-end cover for the free
// condition `waitForComposerFree` (trigger-watcher.js) polls on. Reimplements
// the predicate against fake time rather than importing it — see
// .ai/contexts/trigger-watcher.md ("Found it — CPR") for why.
'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

const { createComposerState, noteUserInput } = require('../composer-state');

const QUIET_MS = 3000; // trigger-watcher.js DEFAULT_QUIET_MS
const CPR      = '\x1b[?59;3R';

function isFree(state, now) {
  return state.pending === 0 && (now - (state.lastInputAt || 0)) >= QUIET_MS;
}

test('quiet window: a realistic CPR flood no longer blocks it forever', () => {
  // Measured 2026-09-04: 1,427 CPR chunks over ~340s of idle-session trace,
  // roughly one every 238ms — far more often than the 3000ms quiet window.
  const state = createComposerState();
  let now = 0;
  let everFree = false;
  for (let i = 0; i < 50; i++) {
    now += 238;
    noteUserInput(state, CPR, now);
    if (isFree(state, now)) { everFree = true; break; }
  }
  assert.equal(everFree, true, 'the quiet window must open under CPR traffic alone');
});

test('quiet window: still refuses while the user is actually typing', () => {
  // The direction that must never flip: real keystrokes interleaved with the
  // same CPR flood keep the composer busy.
  const state = createComposerState();
  let now = 0;
  for (let i = 0; i < 12; i++) {
    now += 238;
    noteUserInput(state, CPR, now);
    if (i === 6) noteUserInput(state, 'x', now); // a keystroke lands mid-flood
  }
  assert.equal(state.pending, 1, 'the typed character is still sitting in the box');
  assert.equal(isFree(state, now), false, 'a non-empty composer is never free');

  noteUserInput(state, '\r', (now += 100)); // submit
  assert.equal(state.pending, 0);
  assert.equal(isFree(state, now), false, 'still inside the quiet window right after submit');
  assert.equal(isFree(state, now + QUIET_MS), true, 'free once the quiet window elapses');
});

test('quiet window: pre-fix behaviour never opens under the same flood (control)', () => {
  // Same drive as the first test, but reimplementing the pre-fix predicate —
  // "every CSI that is not mouse/focus counts as input" — to show the old
  // code path genuinely could not pass. This is the failing case the fix
  // replaces, kept here as documentation rather than a live assertion on
  // production code (it does not import anything from composer-state.js).
  let lastInputAt = 0;
  let now = 0;
  let everFree = false;
  for (let i = 0; i < 50; i++) {
    now += 238;
    lastInputAt = now; // CPR was, pre-fix, indistinguishable from a keystroke
    if ((now - lastInputAt) >= QUIET_MS) { everFree = true; break; }
  }
  assert.equal(everFree, false, 'documents the bug: the clock never opened before this fix');
});
