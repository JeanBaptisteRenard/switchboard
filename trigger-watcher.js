// trigger-watcher.js — File-based input injection for harness scripts.
//
// Drop a JSON trigger file into SWITCHBOARD_TRIGGERS_DIR (default
// ~/.switchboard/triggers/<uuid>.json) and this module writes the command into
// the matching PTY session's stdin.  The result is written to
// SWITCHBOARD_TRIGGERS_DIR/processed/<uuid>.result.json; the trigger file is
// then deleted.
//
// Exports: start(ctx) where ctx = { getPtyForSession, isSessionBusy,
//                                   getComposerState, log }
//
// Security limits (defense-in-depth):
//   - Max trigger file size: 64 KB (C1)
//   - Symlinks rejected via lstat (C2)
//   - Max command length: 4 KB (W2)
//   - Forbidden control chars in command: \r \n \0 \x1b (W3)
//   - Max concurrent in-flight triggers: 8 (W4)
//   - Per-trigger timeout_ms capped at 600 000 ms (W6)
//   - Child-process liveness check before write (W7)
//   - Max chain length: 20 steps (W8)
//   - No write into a composer holding unsubmitted input (see docs/automation.md)
//   - Optional expectedCwd target guard, fails closed (see .ai/contexts/trigger-watcher.md)
//
// Startup scan: start() also enumerates whatever *.json already sits at the
// root of the triggers dir (never processed/) and feeds it through the same
// path a live fs.watch 'rename' event would — a trigger written while the app
// was closed is otherwise never seen (fs.watch only reports changes after it
// is installed). A trigger older than SWITCHBOARD_TRIGGER_MAX_AGE_MS is
// refused, not run — see .ai/contexts/trigger-watcher.md, "Startup scan".
//
// Platform note: fs.watch is Linux-only reliable (I2). On macOS, inotify
// events may be coalesced or delayed; not blocked but not tested.
'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const DEFAULT_TRIGGERS_DIR   = path.join(os.homedir(), '.switchboard', 'triggers');
// Default idle-wait timeout: 5 minutes.
// Rationale: agentic Claude CLI turns can run 10-20 min between idle states.
// 30 s (the original default) was too short and would time-out healthy long
// turns.  300 000 ms (5 min) is the practical upper bound for a genuine wait;
// anything longer than that without going idle is considered stuck and the
// harness should escalate instead.  The env var and per-trigger timeout_ms
// field both override this default (precedence: timeout_ms > env var > default).
const DEFAULT_IDLE_TIMEOUT   = 300_000; // ms — 5 minutes
const MAX_TRIGGER_TIMEOUT    = 600_000; // ms — hard cap for per-trigger timeout_ms (W6)
const IDLE_POLL_INTERVAL     = 100;   // ms

const MAX_TRIGGER_SIZE  = 64 * 1024;  // 64 KB  (C1)
const MAX_COMMAND_LEN   = 4 * 1024;   // 4 KB   (W2)
const MAX_INFLIGHT      = 8;          // concurrency cap (W4)
const MAX_CHAIN_LENGTH  = 20;         // max steps per chain (W8)
// Max time to spend looking for busy=true after injecting a command.
// see .ai/contexts/trigger-watcher.md ("submitted") for what this does and does
// not prove.
const BUSY_OBSERVE_TIMEOUT_MS = 2000; // ms
// Delay (ms) between writing a command's text and the Enter keypress that
// submits it. The Enter MUST arrive as a discrete PTY read — concatenated onto
// the text in a single write, Claude Code (kitty keyboard protocol) absorbs it
// as a literal newline in the composer and the command never submits. xterm.js
// sends every keypress as its own write, which is why the web terminal submits
// correctly; we mirror that. Reproduced 2026-06-02: free-text trigger commands
// landed in the composer but did not submit; only the short menu-driven
// /compact path submitted. Override via SWITCHBOARD_SUBMIT_ENTER_DELAY_MS.
const DEFAULT_SUBMIT_ENTER_DELAY_MS = 50; // ms
// Control chars forbidden in command: CR, LF, NUL, ESC (W3)
const FORBIDDEN_COMMAND_RE = /[\r\n\0\x1b]/;

// Politeness guard — see docs/automation.md and .ai/contexts/trigger-watcher.md.
const DEFAULT_QUIET_MS = 3000;

// see .ai/contexts/trigger-watcher.md ("submitted") for what each value
// promises and what it does not.
const SUBMITTED_NO        = 'no';
const SUBMITTED_ASSUMED   = 'assumed';
const SUBMITTED_ACTIVITY  = 'activity';
const SUBMITTED_CONFIRMED = 'confirmed';
const SUBMITTED_RANK      = {
  [SUBMITTED_NO]:        0,
  [SUBMITTED_ASSUMED]:   1,
  [SUBMITTED_ACTIVITY]:  2,
  [SUBMITTED_CONFIRMED]: 3,
};

const ERROR_NOT_SENT      = 'not sent';
const ERROR_CHAIN_TIMEOUT = 'chain timeout';

const ACCEPTED_WAITS = ['idle', 'none'];

function weakestSubmitted(a, b) {
  return SUBMITTED_RANK[a] <= SUBMITTED_RANK[b] ? a : b;
}

// Single source of truth for turning a submitWithVerify() result into one of
// the four `submitted` values -- used for the single-command result, the
// per-chain-step field, and the chain's own fold (weakestSubmitted over this).
// Kept as one function so all three read the same classification instead of
// three copies of the same ternary drifting apart.
function classifySubmitted(composerConfirmed, sawBusy) {
  return composerConfirmed ? SUBMITTED_CONFIRMED : (sawBusy ? SUBMITTED_ACTIVITY : SUBMITTED_ASSUMED);
}

// W7 — child-process liveness check.
// node-pty's ptyProcess.write() is silent on a dead child: the bytes land in
// the kernel PTY buffer and are never consumed.  Without this check the watcher
// would happily report ok:true on writes nobody will ever read.  We use
// signal 0 (POSIX no-op probe) — throws ESRCH if the process is gone,
// throws EPERM if it exists but we can't signal it (still alive, treat as alive).
function defaultIsPtyAlive(ptyProcess) {
  if (!ptyProcess || typeof ptyProcess.pid !== 'number') return false;
  try {
    process.kill(ptyProcess.pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// Poll interval (ms) for `delayWithBusyPoll` below. Deliberately finer than
// IDLE_POLL_INTERVAL (100ms): the text->Enter delay this polls across is only
// DEFAULT_SUBMIT_ENTER_DELAY_MS (50ms) long in production, so a 100ms poll
// interval would sample it once at best -- no better than the single sample
// this replaces.
const MID_BUSY_POLL_INTERVAL_MS = 5; // ms

// Poll `ctx.isSessionBusy` at MID_BUSY_POLL_INTERVAL_MS granularity for the
// full `ms` duration, returning true if busy was observed at ANY point in the
// window -- not just at the start or the end of it. Total elapsed time is
// bounded to exactly `ms`, same as a plain `delay(ms)`; this only changes
// what happens during the wait, not how long it lasts.
function delayWithBusyPoll(ms, sessionId, ctx) {
  const deadline = Date.now() + ms;
  return new Promise((resolve) => {
    let sawBusy = false;
    function tick() {
      if (ctx.isSessionBusy(sessionId)) sawBusy = true;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return resolve(sawBusy);
      setTimeout(tick, Math.min(MID_BUSY_POLL_INTERVAL_MS, remaining)).unref();
    }
    tick();
  });
}

// Submit a command to a PTY the way a human terminal does: write the text,
// then send Enter as a SEPARATE write so it is read as a discrete "submit"
// keypress rather than a trailing newline. See DEFAULT_SUBMIT_ENTER_DELAY_MS.
//
// Returns `midBusy`: busy polled continuously between the text write and the
// Enter write, true if observed at any point in that window. A single sample
// -- at the start, or at the end -- can miss a busy that rises and falls
// entirely inside the window, which is a real, reproduced case (see
// .ai/contexts/trigger-watcher.md, "submitted"), not a hypothetical one:
// busy observed anywhere here cannot be attributed to an Enter that had not
// been sent yet. See the "composerConfirmed" gate in submitWithVerify, which
// this narrows.
async function submitToPty(ptyProcess, command, sessionId, ctx) {
  ptyProcess.write(command);
  const envMs = envNumber('SWITCHBOARD_SUBMIT_ENTER_DELAY_MS');
  const delayMs = envMs !== undefined ? envMs : DEFAULT_SUBMIT_ENTER_DELAY_MS;
  const midBusy = await delayWithBusyPoll(delayMs, sessionId, ctx);
  ptyProcess.write('\r');
  return midBusy;
}

// A variable set to the empty string is a launcher artefact, not a value:
// Number('') is 0, which would silently drop the window to nothing.
function envNumber(name) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : undefined;
}

// Normalizes a cwd for the target guard's comparison — see
// .ai/contexts/trigger-watcher.md, "Target guard" for what this does and does not paper over.
function normalizeCwd(p) {
  if (typeof p !== 'string' || !p) return null;
  let n;
  try {
    n = path.normalize(p);
  } catch (_) {
    return null;
  }
  if (process.platform === 'win32') {
    // \\?\UNC\server\share\... -> \\server\share\...
    if (n.toLowerCase().startsWith('\\\\?\\unc\\')) {
      n = '\\\\' + n.slice(8);
    } else if (n.toLowerCase().startsWith('\\\\?\\')) {
      // \\?\C:\foo -> C:\foo
      n = n.slice(4);
    }
    // NTFS/ReFS are case-insensitive; fold so "C:\Foo" === "c:\foo".
    n = n.toLowerCase();
  }
  // Strip one trailing separator, but never collapse a bare root ("C:\", "/").
  // see .ai/contexts/trigger-watcher.md, "Target guard" for why this is an
  // explicit n !== path.sep check rather than a length threshold.
  if (n.endsWith(path.sep) && n !== path.sep &&
      !(process.platform === 'win32' && /^[a-z]:\\$/.test(n))) {
    n = n.slice(0, -1);
  }
  return n;
}

function getQuietMs() {
  const v = envNumber('SWITCHBOARD_TRIGGER_QUIET_MS');
  return v !== undefined ? v : DEFAULT_QUIET_MS;
}

function describeBusyComposer(state, quietMs, now) {
  if (!state) {
    return 'the composer of this session cannot be observed, and doubt resolves to busy';
  }
  if (state.pending > 0) {
    return `${state.pending} byte(s) of input are sitting unsubmitted in the composer`;
  }
  return `the last keystroke landed ${now - (state.lastInputAt || 0)} ms ago, ` +
    `inside the ${quietMs} ms quiet window`;
}

/**
 * Runs `check(resolve, scheduleNext)`, re-invoking it on every recursive
 * `scheduleNext()`; any throw from `check`, on any tick, becomes this
 * promise's rejection. See .ai/contexts/trigger-watcher.md, "Poll loops must
 * reject, not throw".
 */
function pollLoop(check) {
  return new Promise((resolve, reject) => {
    function tick() {
      try {
        // .unref(): an in-flight poll must not keep the process alive alone.
        check(resolve, () => setTimeout(tick, IDLE_POLL_INTERVAL).unref());
      } catch (err) {
        reject(err);
      }
    }
    tick();
  });
}

/**
 * Poll until the target composer is free — empty AND quiet — bounded by the
 * absolute `deadlineMs`.
 *
 * A ctx that cannot answer, or a session it does not know, is NOT free: an
 * unobservable composer is treated exactly like a full one.
 *
 * Returns { free, waited_ms, reason }.
 */
function waitForComposerFree(sessionId, ctx, deadlineMs) {
  const start   = Date.now();
  const quietMs = getQuietMs();
  const limit   = (deadlineMs !== undefined) ? deadlineMs : Infinity;

  return pollLoop((resolve, scheduleNext) => {
    const now = Date.now();
    const state = (typeof ctx.getComposerState === 'function')
      ? ctx.getComposerState(sessionId)
      : null;

    if (state && state.pending === 0 && (now - (state.lastInputAt || 0)) >= quietMs) {
      return resolve({ free: true, waited_ms: now - start, reason: null });
    }
    if (now >= limit) {
      return resolve({
        free: false,
        waited_ms: now - start,
        reason: describeBusyComposer(state, quietMs, now),
      });
    }
    scheduleNext();
  });
}

// Window (ms) to look for busy=true when verifying a submission.
// Defaults to BUSY_OBSERVE_TIMEOUT_MS; override via SWITCHBOARD_SUBMIT_VERIFY_MS.
function getSubmitVerifyMs() {
  const v = envNumber('SWITCHBOARD_SUBMIT_VERIFY_MS');
  return v !== undefined ? v : BUSY_OBSERVE_TIMEOUT_MS;
}

// How long busy must read false, CONTINUOUSLY, before waitForBusyFall treats a
// turn as finished. A single false sample is not enough: a command's own tail
// activity (e.g. /compact still writing its summary after the visible turn
// ends) can produce a brief busy->false->true flicker. Exiting on the first
// false sample lets the very next chain step get written while that flicker
// is still running, and the re-assertion of busy then lands inside THAT
// step's submit-verify window — read as proof the next step's own Enter
// started a turn, when it did not (root cause of the 2026-09-04 "Enter
// inserted a newline instead of submitting" incident: submitted:"confirmed",
// waited_ms:0, on the step written right after a /compact busy-fall).
// Override via SWITCHBOARD_BUSY_FALL_SETTLE_MS.
const DEFAULT_BUSY_FALL_SETTLE_MS = 300; // ms
function getBusyFallSettleMs() {
  const v = envNumber('SWITCHBOARD_BUSY_FALL_SETTLE_MS');
  return v !== undefined ? v : DEFAULT_BUSY_FALL_SETTLE_MS;
}

/**
 * Poll ctx.isSessionBusy(sessionId) for busy=true up to `windowMs`, bounded
 * by the absolute `deadlineMs`. Stops early if the PTY disappears.
 *
 * This is a LEVEL probe, not an edge detector: a session already busy on
 * entry answers on the first tick, and nothing here ties the busy state to
 * our own write. See .ai/contexts/trigger-watcher.md ("submitted").
 *
 * Returns { sawBusy, timedOut, sessionExited, waited_ms }.
 *   - sawBusy:       busy=true was observed at some point in the window
 *   - timedOut:      global deadline fired before any observation
 *   - sessionExited: PTY vanished during the poll
 */
function pollForBusyObserved(sessionId, ctx, windowMs, deadlineMs) {
  const start = Date.now();
  const windowEnd = start + windowMs;

  return pollLoop((resolve, scheduleNext) => {
    const now = Date.now();

    if (now >= deadlineMs) {
      return resolve({ sawBusy: false, timedOut: true, sessionExited: false, waited_ms: now - start });
    }
    if (!ctx.getPtyForSession(sessionId)) {
      return resolve({ sawBusy: false, timedOut: false, sessionExited: true, waited_ms: now - start });
    }
    if (ctx.isSessionBusy(sessionId)) {
      return resolve({ sawBusy: true, timedOut: false, sessionExited: false, waited_ms: now - start });
    }
    if (now >= windowEnd) {
      // Verify window elapsed without seeing busy — caller decides.
      return resolve({ sawBusy: false, timedOut: false, sessionExited: false, waited_ms: now - start });
    }
    scheduleNext();
  });
}

/**
 * Submit a command, then verify it.
 *
 * 1. submitToPty(text + discrete Enter)
 * 2. Read the composer back — unconditionally, never skipped by an activity
 *    sample. See .ai/contexts/trigger-watcher.md ("submitted") for why this
 *    reading alone still cannot be trusted on a session that was already
 *    mid-turn when we wrote.
 * 3. Poll for busy=true within SWITCHBOARD_SUBMIT_VERIFY_MS.
 * 4. Busy observed → done (submit_retries: 0). `composerConfirmed` is set only
 *    when the composer read back empty AND the session was not already busy
 *    the instant we wrote, AND not busy in the gap between the text write and
 *    the Enter write (`midBusy`) — busy observed there cannot be attributed to
 *    an Enter that had not been sent yet. Neither gate proves our Enter caused
 *    the busy the poll later sees; both only rule out cases where it provably
 *    could not have. See .ai/contexts/trigger-watcher.md ("submitted"),
 *    "What confirmed still does not claim" for the causality gap that remains.
 * 5. Nothing observed → write a SINGLE bare '\r' (a no-op on an empty composer, so it is
 *    harmless if the first submit actually worked; if the text is still sitting
 *    in the composer because the first Enter was absorbed, this submits it) and
 *    poll the same window again (submit_retries: 1). A retry never yields
 *    `composerConfirmed` — the first attempt already needed rescuing.
 *
 * The observation IS the equivalent of waitForTurnComplete's Phase 1; callers
 * MUST NOT then wait for busy again — they proceed straight to busy-fall.
 *
 * Returns { submit_retries, sawBusy, composerConfirmed, sessionExited, timedOut, waited_ms }.
 *   - waited_ms is the total time spent polling (both windows + retry).
 *
 * If sessionExited/timedOut fire, the caller short-circuits with the usual
 * error result. If neither poll observes busy (and no deadline),
 * the caller keeps the legacy instant-reply semantics — submit_retries traces
 * that the verification could not confirm a turn started.
 */
async function submitWithVerify(ptyProcess, sessionId, command, ctx, deadlineMs) {
  // Sampled before the write — see .ai/contexts/trigger-watcher.md ("submitted").
  const preBusy = ctx.isSessionBusy(sessionId);

  const midBusy = await submitToPty(ptyProcess, command, sessionId, ctx);

  // Composer read-back: unconditional, immediate, never gated on activity.
  const postWriteState = (typeof ctx.getComposerState === 'function')
    ? ctx.getComposerState(sessionId)
    : null;
  const composerEmptyAfterWrite = !!postWriteState && postWriteState.pending === 0;

  const windowMs = getSubmitVerifyMs();
  // No explicit (global) deadline → the verify window alone governs; the retry
  // must fire on window expiry, so the deadline must NOT coincide with it.
  const effectiveDeadline = (deadlineMs !== undefined) ? deadlineMs : Infinity;

  const first = await pollForBusyObserved(sessionId, ctx, windowMs, effectiveDeadline);
  if (first.sawBusy || first.sessionExited || first.timedOut) {
    return {
      submit_retries: 0,
      sawBusy: first.sawBusy,
      composerConfirmed: first.sawBusy && preBusy === false && midBusy === false && composerEmptyAfterWrite,
      sessionExited: first.sessionExited,
      timedOut: first.timedOut,
      waited_ms: first.waited_ms,
    };
  }

  // Nothing observed in the window — retry the Enter ONCE (bare '\r', never the text),
  // and only into a free composer. See docs/automation.md.
  const recoveryDeadline = Math.min(effectiveDeadline, Date.now() + windowMs);
  const polite = await waitForComposerFree(sessionId, ctx, recoveryDeadline);
  if (!polite.free) {
    return {
      submit_retries: 0,
      sawBusy: false,
      composerConfirmed: false,
      sessionExited: false,
      timedOut: false,
      recoverySkipped: true,
      recoveryReason: polite.reason,
      waited_ms: first.waited_ms + polite.waited_ms,
    };
  }

  try {
    ptyProcess.write('\r');
  } catch (err) {
    // Surface as a sessionExited-like failure; caller maps to an error result.
    return {
      submit_retries: 1,
      sawBusy: false,
      composerConfirmed: false,
      sessionExited: false,
      timedOut: false,
      writeError: err,
      waited_ms: first.waited_ms,
    };
  }

  const second = await pollForBusyObserved(sessionId, ctx, windowMs, effectiveDeadline);
  return {
    submit_retries: 1,
    sawBusy: second.sawBusy,
    composerConfirmed: false,
    sessionExited: second.sessionExited,
    timedOut: second.timedOut,
    waited_ms: first.waited_ms + second.waited_ms,
  };
}

/**
 * Wait only for the busy FALLING edge (busy → false), i.e. the turn finishing.
 * Used after submitWithVerify has already observed (or assumed) the turn.
 *
 * The deadline check runs BEFORE the settle check, deliberately: a settle
 * window in progress when `deadlineMs` arrives resolves as `timedOut`, never
 * as success, even if the turn it was waiting on had genuinely already
 * finished. A turn ending with less than `settleMs` of margin before its own
 * `timeout_ms` now fails where the old single-sample check would have
 * succeeded. Documented trade-off (2026-09-04), not a bug: making the settle
 * window additive to the deadline would silently change what `timeout_ms`
 * means for every caller, including ones already calibrated against the old
 * behavior; see .ai/contexts/trigger-watcher.md ("submitted") for the caller
 * this was weighed against. Proven in `test/trigger-watcher.test.js`, "a turn
 * finishing with too little margin before its own deadline now times out".
 *
 * Returns { timedOut, sessionExited, waited_ms }.
 */
function waitForBusyFall(sessionId, ctx, deadlineMs) {
  const start = Date.now();
  const settleMs = getBusyFallSettleMs();
  // Set the instant busy first reads false; reset to null on every re-assertion.
  let idleSince = null;

  return pollLoop((resolve, scheduleNext) => {
    const now = Date.now();
    if (now >= deadlineMs) {
      return resolve({ timedOut: true, sessionExited: false, waited_ms: now - start });
    }
    if (!ctx.getPtyForSession(sessionId)) {
      return resolve({ timedOut: false, sessionExited: true, waited_ms: now - start });
    }
    if (!ctx.isSessionBusy(sessionId)) {
      if (idleSince === null) idleSince = now;
      if (now - idleSince >= settleMs) {
        return resolve({ timedOut: false, sessionExited: false, waited_ms: now - start });
      }
    } else {
      idleSince = null;
    }
    scheduleNext();
  });
}

function getTriggersDir() {
  return process.env.SWITCHBOARD_TRIGGERS_DIR || DEFAULT_TRIGGERS_DIR;
}

function getIdleTimeout() {
  const v = process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
  if (v !== undefined) {
    const parsed = parseInt(v, 10);
    return Number.isFinite(parsed) ? parsed : DEFAULT_IDLE_TIMEOUT; // I4: NaN guard
  }
  return DEFAULT_IDLE_TIMEOUT;
}

// Default staleness threshold for the startup scan (see .ai/contexts/
// trigger-watcher.md, "Startup scan"). A trigger written more than this long
// ago is refused rather than run: it was written for a session state that may
// no longer exist by the time the app comes back up.
//
// Rationale for 5 minutes: the only two "legitimate wait" durations ever
// measured on this transport are 66s and 102s (chain step 0, five real
// /compact incidents, see .ai/contexts/trigger-watcher.md). 300_000 ms clears
// the larger of those by ~3x, so a trigger that is merely slow to be picked up
// is never mistaken for a stale one — while staying far short of "hours",
// which is the case JB's own example (a /compact issued 6h earlier no longer
// targets the same session) treats as unambiguously stale. It also reuses
// DEFAULT_IDLE_TIMEOUT's already-established number and rationale above
// ("the practical upper bound for a genuine wait") rather than inventing a
// second one. Configurable via SWITCHBOARD_TRIGGER_MAX_AGE_MS.
const DEFAULT_TRIGGER_MAX_AGE_MS = 300_000; // ms — 5 minutes

// Read live, like getIdleTimeout() above — NOT cached at module load. A
// module-load-time constant would miss every env var set after require()
// (the exact trap documented at the top of this file's test suite).
function getTriggerMaxAgeMs() {
  const v = process.env.SWITCHBOARD_TRIGGER_MAX_AGE_MS;
  if (v !== undefined) {
    const parsed = parseInt(v, 10);
    return Number.isFinite(parsed) ? parsed : DEFAULT_TRIGGER_MAX_AGE_MS; // NaN guard
  }
  return DEFAULT_TRIGGER_MAX_AGE_MS;
}

/**
 * Poll until isSessionBusy(sessionId) returns false, or the timeout expires,
 * or the session exits (PTY no longer available).
 *
 * @param {string} sessionId
 * @param {object} ctx
 * @param {number} [timeoutMs]  explicit timeout in ms; falls back to
 *                              getIdleTimeout() (env var → default) when absent.
 * Returns { timedOut: boolean, sessionExited: boolean, waited_ms: number }.
 */
function waitForIdle(sessionId, ctx, timeoutMs) {
  const timeout  = (timeoutMs !== undefined) ? timeoutMs : getIdleTimeout();
  const start    = Date.now();

  return pollLoop((resolve, scheduleNext) => {
    const waited_ms = Date.now() - start;

    // W5: detect PTY closure during wait
    if (!ctx.getPtyForSession(sessionId)) {
      return resolve({ timedOut: false, sessionExited: true, waited_ms });
    }

    if (!ctx.isSessionBusy(sessionId)) {
      return resolve({ timedOut: false, sessionExited: false, waited_ms });
    }
    if (waited_ms >= timeout) {
      return resolve({ timedOut: true, sessionExited: false, waited_ms });
    }
    scheduleNext();
  });
}

// NOTE: the previous combined-phase waiter (waitForTurnComplete: busy-rise then
// busy-fall) was split into submitWithVerify (Phase 1, busy-rise + Enter retry)
// and waitForBusyFall (Phase 2, busy-fall) so the chain path can verify each
// submission and retry the Enter once if the turn never starts (2026-06-04
// "text stuck in composer" incident). The instant-reply semantics are preserved:
// when no rise is confirmed, submitWithVerify still returns and waitForBusyFall
// returns immediately on an already-idle session.

/**
 * Validate a single timeout_ms value (for top-level or per-step).
 * Returns null if valid, or an error string if invalid.
 */
function validateTimeoutMs(value) {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > MAX_TRIGGER_TIMEOUT
  ) {
    return 'invalid timeout_ms';
  }
  return null;
}

// A logger call that cannot throw. See .ai/contexts/trigger-watcher.md,
// "Removing the entry".
function safeLogError(ctx, ...args) {
  try {
    ctx.log.error(...args);
  } catch (_) { /* swallow */ }
}

/**
 * Process a single trigger file (by basename, e.g. "abc-123.json").
 * Never throws — all errors land in the result file.
 *
 * @param {function} [acquireSessionLock] (sessionId) => Promise<releaseFn>;
 *        awaited right after sessionId is known valid, released in the
 *        `finally` below so a second trigger for the same session cannot
 *        touch its PTY/composer until this one is fully done.
 */
async function processTriggerFile(name, ctx, triggersDir, processedDir, onEntryRetained, acquireSessionLock) {
  // Only handle *.json files, ignore the processed/ subdir itself and
  // any stray files.
  if (!name.endsWith('.json')) return;

  const triggerPath = path.join(triggersDir, name);
  const uuid        = name.slice(0, -5); // strip ".json"
  const resultPath  = path.join(processedDir, uuid + '.result.json');
  const resultTmp   = resultPath + '.tmp'; // I1: atomic write temp path

  // I1: atomic result write — write to .tmp then rename so pollers never
  // observe a partial JSON file.
  async function writeResult(result) {
    // Every result carries `submitted`; an unstated one is the safe value.
    if (result.submitted === undefined) result.submitted = SUBMITTED_NO;
    try {
      fs.writeFileSync(resultTmp, JSON.stringify(result) + '\n', 'utf8');
      fs.renameSync(resultTmp, resultPath);
    } catch (err) {
      safeLogError(ctx, '[trigger-watcher] Failed to write result file:', err.message);
    }
    try {
      fs.unlinkSync(triggerPath);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // onEntryRetained() first: the guarantee it records must not depend
        // on whether the log call after it succeeds.
        if (onEntryRetained) onEntryRetained();
        safeLogError(ctx, '[trigger-watcher] Trigger file survived processing, will not be run again:',
          name, err.message);
      }
    }
  }

  let releaseSessionLock;

  try {

  // ── 1. lstat + size guard (C1 + C2) ──────────────────────────────────────
  let stat;
  try {
    stat = fs.lstatSync(triggerPath); // C2: lstat does NOT follow symlinks
  } catch (err) {
    if (err.code === 'ENOENT') return; // gone before we could inspect it
    ctx.log.error('[trigger-watcher] Trigger file could not be inspected:', name, err.message);
    await writeResult({ ok: false, error: 'trigger could not be inspected: ' + err.message });
    return;
  }

  if (!stat.isFile()) {
    // C2: reject symlinks, directories, device nodes, etc.
    ctx.log.warn('[trigger-watcher] Non-regular-file trigger rejected:', name);
    await writeResult({ ok: false, error: 'trigger must be a regular file' });
    return;
  }

  if (stat.size > MAX_TRIGGER_SIZE) {
    // C1: reject oversized files before reading
    ctx.log.warn('[trigger-watcher] Oversized trigger rejected:', name, stat.size);
    await writeResult({ ok: false, error: 'trigger too large (max 64 KB)' });
    return;
  }

  // ── 1b. Staleness guard — see .ai/contexts/trigger-watcher.md, "Startup scan" ──
  // Applies uniformly to every trigger, scan-found or live-arriving: mtime is
  // the file's write time regardless of how this run came to look at it.
  const ageMs    = Date.now() - stat.mtimeMs;
  const maxAgeMs = getTriggerMaxAgeMs();
  if (ageMs > maxAgeMs) {
    ctx.log.warn('[trigger-watcher] Stale trigger refused:', name,
      Math.round(ageMs) + 'ms old, max ' + maxAgeMs + 'ms');
    await writeResult({
      ok:        false,
      submitted: SUBMITTED_NO,
      error:     ERROR_NOT_SENT,
      reason:    `trigger is ${Math.round(ageMs)}ms old, older than the ${maxAgeMs}ms ` +
                 'staleness limit; refused rather than act on a request that may no ' +
                 'longer target the intended session state',
    });
    return;
  }

  // ── 2. Read + parse (with SyntaxError retry for W1 partial-write race) ───
  let trigger;
  let lastParseErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    // W1: on second attempt, wait 50 ms (partial-write window) then retry
    if (attempt === 1) {
      await new Promise(r => setTimeout(r, 50));
    }
    try {
      const raw = fs.readFileSync(triggerPath, 'utf8');
      trigger   = JSON.parse(raw);
      lastParseErr = null;
      break; // success
    } catch (err) {
      lastParseErr = err;
      if (!(err instanceof SyntaxError)) {
        // ENOENT or other I/O error — no retry useful
        break;
      }
      // SyntaxError on attempt 0: retry once after 50 ms (W1)
    }
  }

  if (lastParseErr) {
    ctx.log.warn('[trigger-watcher] Unreadable/unparseable trigger:', name, lastParseErr.message);
    await writeResult({ ok: false, error: 'invalid JSON: ' + lastParseErr.message });
    return;
  }

  // ── 3. Validate shape ─────────────────────────────────────────────────────
  const { sessionId, command, chain, wait = 'none', timeout_ms, expectedCwd } = trigger;

  if (typeof sessionId !== 'string' || !sessionId) {
    await writeResult({ ok: false, error: 'missing required field: sessionId', sessionId: sessionId || null });
    return;
  }

  // see .ai/contexts/trigger-watcher.md, "Session serialization"
  if (acquireSessionLock) {
    releaseSessionLock = await acquireSessionLock(sessionId);
  }

  // An unknown `wait` is refused before anything is written: falling back to
  // 'none' would submit immediately into a session that asked to be waited for.
  if (trigger.wait !== undefined && !ACCEPTED_WAITS.includes(trigger.wait)) {
    await writeResult({
      ok:        false,
      submitted: SUBMITTED_NO,
      error:     ERROR_NOT_SENT,
      reason:    `wait ${JSON.stringify(String(trigger.wait))} is not a value this ` +
                 `transport knows: only "idle" and "none", and an absent field means "none"`,
      sessionId,
    });
    return;
  }

  // Mutual exclusion: command and chain cannot both be present
  if (command !== undefined && chain !== undefined) {
    await writeResult({ ok: false, error: 'command and chain are mutually exclusive', sessionId });
    return;
  }

  // Must have either command or chain
  if (command === undefined && chain === undefined) {
    await writeResult({ ok: false, error: 'missing required field: command or chain', sessionId });
    return;
  }

  // ── 3a. Validate single-command path ─────────────────────────────────────
  if (command !== undefined) {
    if (typeof command !== 'string' || !command) {
      await writeResult({ ok: false, error: 'missing required field: command', sessionId });
      return;
    }

    // W2: command length cap
    if (command.length > MAX_COMMAND_LEN) {
      await writeResult({ ok: false, error: 'command too long (max 4 KB)', sessionId });
      return;
    }

    // W3: reject forbidden control characters
    if (FORBIDDEN_COMMAND_RE.test(command)) {
      await writeResult({ ok: false, error: 'command contains forbidden control characters (\\r \\n \\0 \\x1b)', sessionId });
      return;
    }
  }

  // ── 3b. Validate chain path ───────────────────────────────────────────────
  if (chain !== undefined) {
    // W8: chain must be a non-empty array, length ≤ MAX_CHAIN_LENGTH
    if (!Array.isArray(chain) || chain.length === 0) {
      await writeResult({ ok: false, error: 'chain must be a non-empty array', sessionId });
      return;
    }
    if (chain.length > MAX_CHAIN_LENGTH) {
      await writeResult({ ok: false, error: `chain too long (max ${MAX_CHAIN_LENGTH} steps)`, sessionId });
      return;
    }

    // Validate each step
    for (let i = 0; i < chain.length; i++) {
      const step = chain[i];

      if (typeof step.command !== 'string' || !step.command) {
        await writeResult({ ok: false, error: `step[${i}]: missing required command string`, sessionId });
        return;
      }

      // W2: step command length cap
      if (step.command.length > MAX_COMMAND_LEN) {
        await writeResult({ ok: false, error: `step[${i}]: command too long (max 4 KB)`, sessionId });
        return;
      }

      // W3: reject forbidden control characters in step command
      if (FORBIDDEN_COMMAND_RE.test(step.command)) {
        await writeResult({ ok: false, error: `step[${i}]: command contains forbidden control characters (\\r \\n \\0 \\x1b)`, sessionId });
        return;
      }

      // W6: validate optional per-step timeout_ms
      if (step.timeout_ms !== undefined) {
        const err = validateTimeoutMs(step.timeout_ms);
        if (err) {
          await writeResult({ ok: false, error: `step[${i}]: invalid step timeout_ms`, sessionId });
          return;
        }
      }
    }
  }

  // W6: validate optional top-level timeout_ms
  let resolvedTimeoutMs;
  if (timeout_ms !== undefined) {
    const err = validateTimeoutMs(timeout_ms);
    if (err) {
      await writeResult({ ok: false, error: 'invalid timeout_ms', sessionId });
      return;
    }
    resolvedTimeoutMs = timeout_ms;
  }
  // When timeout_ms is absent, resolvedTimeoutMs stays undefined and waitForIdle
  // falls back to getIdleTimeout() (env var → compiled default).

  // ── 3c. Validate optional expectedCwd — see .ai/contexts/trigger-watcher.md, "Target guard" ──
  if (expectedCwd !== undefined && (typeof expectedCwd !== 'string' || !expectedCwd)) {
    await writeResult({
      ok:        false,
      submitted: SUBMITTED_NO,
      error:     ERROR_NOT_SENT,
      reason:    'expectedCwd must be a non-empty string when present',
      sessionId,
    });
    return;
  }

  // ── 4. Look up session ────────────────────────────────────────────────────
  const sessionEntry = ctx.getPtyForSession(sessionId);
  if (!sessionEntry) {
    ctx.log.warn('[trigger-watcher] Session not found:', sessionId);
    await writeResult({ ok: false, error: 'session not found', sessionId });
    return;
  }

  const { ptyProcess } = sessionEntry;
  const isPtyAlive = ctx.isPtyAlive || defaultIsPtyAlive;

  // W7 — pre-flight liveness check.  main.js may keep a stale entry in its
  // activeSessions map after a Claude process exited "cleanly" (Ctrl+D, /exit)
  // without the Switchboard window closing.  Without this guard we'd wait the
  // full idle-timeout for a busy flag that will never flip, then write into a
  // dead PTY and report ok:true.
  if (!isPtyAlive(ptyProcess)) {
    ctx.log.warn('[trigger-watcher] Target process not running:', sessionId);
    await writeResult({ ok: false, error: 'target process not running', sessionId });
    return;
  }

  // ── Target guard (optional) — see .ai/contexts/trigger-watcher.md, "Target guard" ──
  if (expectedCwd !== undefined) {
    const observedCwd = normalizeCwd(sessionEntry.cwd);
    if (observedCwd === null) {
      ctx.log.warn('[trigger-watcher] Target guard: session cwd could not be determined, refusing:', sessionId);
      await writeResult({
        ok:               false,
        submitted:        SUBMITTED_NO,
        error:            ERROR_NOT_SENT,
        reason:           "this session's cwd could not be determined; refusing rather than risk targeting the wrong session",
        targetCwdUnknown: true,
        expectedCwd,
        observedCwd:      null,
        sessionId,
      });
      return;
    }
    if (normalizeCwd(expectedCwd) !== observedCwd) {
      ctx.log.warn('[trigger-watcher] Target guard: expectedCwd does not match session cwd, refusing:', sessionId);
      await writeResult({
        ok:             false,
        submitted:      SUBMITTED_NO,
        error:          ERROR_NOT_SENT,
        reason:         "expectedCwd does not match this session's actual cwd",
        targetMismatch: true,
        expectedCwd,
        observedCwd:    sessionEntry.cwd,
        sessionId,
      });
      return;
    }
  }

  // ── 5. Single-command path ────────────────────────────────────────────────
  if (command !== undefined) {
    let waited_ms = 0;
    const commandDeadline = Date.now() +
      ((resolvedTimeoutMs !== undefined) ? resolvedTimeoutMs : getIdleTimeout());
    if (wait === 'idle') {
      const result = await waitForIdle(sessionId, ctx, resolvedTimeoutMs);
      waited_ms    = result.waited_ms;

      // Nothing is written yet — see .ai/contexts/trigger-watcher.md.
      // W5: session exited during wait
      if (result.sessionExited) {
        ctx.log.warn('[trigger-watcher] Session exited during wait:', sessionId);
        await writeResult({
          ok: false,
          submitted: SUBMITTED_NO,
          error: 'session exited during wait',
          reason: 'the session exited while waiting for it to go idle; nothing was written',
          sessionId, waited_ms,
        });
        return;
      }

      if (result.timedOut) {
        ctx.log.warn('[trigger-watcher] Idle timeout for session, nothing sent:', sessionId);
        await writeResult({
          ok: false,
          submitted: SUBMITTED_NO,
          error: ERROR_NOT_SENT,
          reason: 'timeout waiting for idle; nothing was written',
          sessionId, waited_ms,
        });
        return;
      }
    }

    // Politeness — never write over input the user typed and did not submit.
    const polite = await waitForComposerFree(sessionId, ctx, commandDeadline);
    waited_ms += polite.waited_ms;
    if (!polite.free) {
      ctx.log.warn('[trigger-watcher] Composer never free, nothing sent:', sessionId, polite.reason);
      await writeResult({
        ok:        false,
        submitted: SUBMITTED_NO,
        error:     ERROR_NOT_SENT,
        reason:    polite.reason,
        sessionId,
        waited_ms,
      });
      return;
    }

    // W7 — re-check liveness right before writing.  The idle wait can be up to
    // 10 min (MAX_TRIGGER_TIMEOUT) and the politeness wait runs to the same
    // deadline; the child may have exited during either while busy-was-true
    // never flipped.  This probe belongs AFTER both waits: run before them it
    // proves nothing about the moment of the write.
    if (!isPtyAlive(ptyProcess)) {
      ctx.log.warn('[trigger-watcher] Target process exited during wait:', sessionId);
      await writeResult({ ok: false, error: 'target process not running', sessionId, waited_ms });
      return;
    }

    // Write to PTY: text, then Enter as a discrete keypress (see submitToPty),
    // then verify the submission actually started a turn — retrying the Enter
    // once if busy is never observed (the 2026-06-04 "text stuck in
    // composer, Enter absorbed" incident).
    let submitRetries = 0;
    let sawBusy = false;
    let composerConfirmed = false;
    let recoverySkipped = false;
    let recoveryReason = null;
    try {
      const v = await submitWithVerify(ptyProcess, sessionId, command, ctx);
      submitRetries     = v.submit_retries;
      sawBusy           = v.sawBusy;
      composerConfirmed = !!v.composerConfirmed;
      recoverySkipped   = !!v.recoverySkipped;
      recoveryReason    = v.recoveryReason || null;
      // The submit-verify poll (and its retry, if any) is time this trigger
      // spent too -- see "waited_ms" in docs/automation.md.
      waited_ms        += v.waited_ms;
      if (v.writeError) throw v.writeError;
    } catch (err) {
      ctx.log.error('[trigger-watcher] PTY write failed:', err.message);
      await writeResult({ ok: false, error: 'pty write failed: ' + err.message, sessionId });
      return;
    }

    if (recoverySkipped) {
      ctx.log.warn('[trigger-watcher] Recovery Enter withheld for ' + sessionId + ': ' + recoveryReason);
    }
    ctx.log.info(`[trigger-watcher] Sent command to ${sessionId}: ${command}` +
      (submitRetries ? ` (submit retried ${submitRetries}x)` : ''));

    await writeResult({
      ok:             true,
      submitted:      classifySubmitted(composerConfirmed, sawBusy),
      sessionId,
      command,
      sent_at:        new Date().toISOString(),
      waited_ms,
      submit_retries: submitRetries,
      ...(recoverySkipped ? { reason: recoveryReason } : {}),
    });
    return;
  }

  // ── 6. Chain path ─────────────────────────────────────────────────────────
  // Global deadline for the whole chain
  const globalTimeout = (resolvedTimeoutMs !== undefined) ? resolvedTimeoutMs : getIdleTimeout();
  const globalDeadline = Date.now() + globalTimeout;

  const steps = [];
  let totalWaitedMs = 0;
  let step0SentAt = null;
  // A chain reports the weakest thing any of its steps achieved. Starts at the
  // top of the order so a chain whose every step is genuinely confirmed can
  // report "confirmed" — one weak step still drags the whole chain down.
  let chainSubmitted = SUBMITTED_CONFIRMED;

  // Step 0: initial wait (respects `wait` field)
  if (wait === 'idle') {
    const remainingMs = globalDeadline - Date.now();
    const result = await waitForIdle(sessionId, ctx, remainingMs);
    totalWaitedMs += result.waited_ms;

    // Nothing is written before step 0 — see .ai/contexts/trigger-watcher.md.
    if (result.sessionExited) {
      ctx.log.warn('[trigger-watcher] Session exited during chain initial wait:', sessionId);
      await writeResult({
        ok: false,
        submitted: SUBMITTED_NO,
        error: 'session exited during wait',
        reason: 'the session exited while waiting for it to go idle; nothing was written',
        partial: false, steps_completed: 0, sessionId, sent_at: step0SentAt, steps,
        total_waited_ms: totalWaitedMs,
      });
      return;
    }

    if (result.timedOut || Date.now() >= globalDeadline) {
      ctx.log.warn('[trigger-watcher] Idle timeout during chain initial wait, nothing sent:', sessionId);
      await writeResult({
        ok: false,
        submitted: SUBMITTED_NO,
        error: ERROR_NOT_SENT,
        reason: 'timed out waiting for the session to go idle; nothing was written',
        partial: false, steps_completed: 0, sessionId, sent_at: step0SentAt, steps,
        total_waited_ms: totalWaitedMs,
      });
      return;
    }
  }

  for (let i = 0; i < chain.length; i++) {
    const step = chain[i];

    // Check deadline before each step
    if (Date.now() >= globalDeadline) {
      ctx.log.warn(`[trigger-watcher] Chain global timeout before step ${i}:`, sessionId);
      await writeResult({ ok: false, submitted: (i > 0) ? chainSubmitted : SUBMITTED_NO, error: (i > 0) ? ERROR_CHAIN_TIMEOUT : ERROR_NOT_SENT, partial: i > 0, steps_completed: i, sessionId, sent_at: step0SentAt, steps, total_waited_ms: totalWaitedMs });
      return;
    }

    // Re-check session still present
    const entry = ctx.getPtyForSession(sessionId);
    if (!entry) {
      ctx.log.warn(`[trigger-watcher] Session exited before chain step ${i}:`, sessionId);
      await writeResult({ ok: false, submitted: (i > 0) ? chainSubmitted : SUBMITTED_NO, error: 'session exited during wait', partial: i > 0, steps_completed: i, sessionId, sent_at: step0SentAt, steps, total_waited_ms: totalWaitedMs });
      return;
    }

    // Inject the step command
    const stepSentAt = new Date().toISOString();
    if (i === 0) step0SentAt = stepSentAt;

    // Per-step timeout_ms (if set) bounds THIS whole step (verify + retry + the
    // busy-fall wait for non-final steps), capped by the remaining global
    // deadline — mirroring the old combined waitForTurnComplete deadline.
    let stepTimeoutMs;
    if (step.timeout_ms !== undefined) {
      stepTimeoutMs = Math.min(step.timeout_ms, globalDeadline - Date.now());
    } else {
      stepTimeoutMs = globalDeadline - Date.now();
    }
    const stepDeadline = Date.now() + stepTimeoutMs;

    // Politeness — never write over input the user typed and did not submit.
    const polite = await waitForComposerFree(sessionId, ctx, stepDeadline);
    totalWaitedMs += polite.waited_ms;
    if (!polite.free) {
      ctx.log.warn(`[trigger-watcher] Composer never free at chain step ${i}:`, sessionId, polite.reason);
      // This step never reached submitToPty -- nothing was written for it, so
      // its own submitted is unconditionally "no", never folded from
      // chainSubmitted the way the top-level field is.
      steps.push({
        idx: i, command: step.command, sent_at: stepSentAt, waited_ms: polite.waited_ms,
        submit_retries: 0, submitted: SUBMITTED_NO,
      });
      await writeResult({
        ok: false,
        submitted: weakestSubmitted(chainSubmitted, SUBMITTED_NO),
        error: (i === 0) ? ERROR_NOT_SENT : ERROR_CHAIN_TIMEOUT,
        reason: polite.reason,
        partial: i > 0, steps_completed: i, sessionId, sent_at: step0SentAt, steps,
        total_waited_ms: totalWaitedMs,
      });
      return;
    }

    // W7 — liveness check before each step's write.  The previous step's turn
    // wait may have spanned several minutes and the politeness wait runs to
    // this step's deadline; the child could have exited during either while
    // main.js still has a stale activeSessions entry.  The probe belongs after
    // both waits.  The remaining liveness→write TOCTOU window is bounded by
    // the try/catch on write.
    if (!isPtyAlive(entry.ptyProcess)) {
      ctx.log.warn(`[trigger-watcher] Target process not running at chain step ${i}:`, sessionId);
      await writeResult({ ok: false, submitted: (i > 0) ? chainSubmitted : SUBMITTED_NO, error: 'target process not running', partial: i > 0, steps_completed: i, sessionId, sent_at: step0SentAt, steps, total_waited_ms: totalWaitedMs });
      return;
    }

    // Submit the step, then look for activity on the session.
    // The verify poll IS this step's Phase 1 — for non-final steps we proceed
    // straight to the busy-FALL wait, never re-observing busy.
    // The verify window is bounded by this step's deadline; if nothing arrives
    // we retry the bare Enter once (harmless no-op if already submitted).
    let submitRetries = 0;
    // Includes this step's own politeness wait (see "total_waited_ms" in
    // docs/automation.md) so steps[i].waited_ms accounts for everything this
    // step spent, not just the submit-verify portion.
    let stepWaitedMs = polite.waited_ms;
    let verify;
    try {
      verify = await submitWithVerify(entry.ptyProcess, sessionId, step.command, ctx, stepDeadline);
    } catch (err) {
      ctx.log.error(`[trigger-watcher] PTY write failed at chain step ${i}:`, err.message);
      await writeResult({ ok: false, error: 'pty write failed: ' + err.message, partial: true, steps_completed: i, sessionId, sent_at: step0SentAt, steps, total_waited_ms: totalWaitedMs });
      return;
    }
    if (verify.writeError) {
      ctx.log.error(`[trigger-watcher] PTY write failed at chain step ${i}:`, verify.writeError.message);
      await writeResult({ ok: false, error: 'pty write failed: ' + verify.writeError.message, partial: true, steps_completed: i, sessionId, sent_at: step0SentAt, steps, total_waited_ms: totalWaitedMs });
      return;
    }
    submitRetries = verify.submit_retries;
    stepWaitedMs += verify.waited_ms;
    totalWaitedMs += verify.waited_ms;
    // This step's own submitted -- same classification the chain fold below
    // uses, attached to the step itself so a consumer can ask "was THIS step
    // (e.g. the last one) confirmed?" instead of only the chain's weakest.
    const stepSubmitted = classifySubmitted(!!verify.composerConfirmed, !!verify.sawBusy);
    chainSubmitted = weakestSubmitted(chainSubmitted, stepSubmitted);

    if (verify.recoverySkipped) {
      ctx.log.warn(`[trigger-watcher] Recovery Enter withheld at chain step ${i} for ` +
        `${sessionId}: ${verify.recoveryReason}`);
    }
    ctx.log.info(`[trigger-watcher] Chain step ${i} sent to ${sessionId}: ${step.command}` +
      (submitRetries ? ` (submit retried ${submitRetries}x)` : ''));

    // Session exited / global timeout observed during verify.
    if (verify.sessionExited) {
      ctx.log.warn(`[trigger-watcher] Session exited during chain step ${i} submit verify:`, sessionId);
      steps.push({ idx: i, command: step.command, sent_at: stepSentAt, waited_ms: stepWaitedMs, submit_retries: submitRetries, submitted: stepSubmitted });
      await writeResult({ ok: false, submitted: chainSubmitted, error: 'session exited during wait', partial: true, steps_completed: i, sessionId, sent_at: step0SentAt, steps, total_waited_ms: totalWaitedMs });
      return;
    }
    if (verify.timedOut) {
      ctx.log.warn(`[trigger-watcher] Chain timeout during step ${i} submit verify:`, sessionId);
      steps.push({ idx: i, command: step.command, sent_at: stepSentAt, waited_ms: stepWaitedMs, submit_retries: submitRetries, submitted: stepSubmitted });
      await writeResult({ ok: false, submitted: chainSubmitted, error: 'chain timeout', partial: true, steps_completed: i, sessionId, sent_at: step0SentAt, steps, total_waited_ms: totalWaitedMs });
      return;
    }

    // For non-final steps, wait for the turn to FINISH (busy falling edge).
    // submitWithVerify already consumed the observation. If busy was never
    // observed (instant-reply / unconfirmed submit), busy is already false,
    // but this now still costs the settle window below (SWITCHBOARD_BUSY_FALL_
    // SETTLE_MS, 300ms default) rather than returning immediately as before
    // that gate existed — submit_retries still records that verification
    // could not confirm a turn.
    if (i < chain.length - 1) {
      // Same per-step deadline as the verify above — bounds the busy-fall wait.
      const result = await waitForBusyFall(sessionId, ctx, stepDeadline);
      stepWaitedMs += result.waited_ms;
      totalWaitedMs += result.waited_ms;

      if (result.sessionExited) {
        ctx.log.warn(`[trigger-watcher] Session exited during chain step ${i} turn wait:`, sessionId);
        steps.push({ idx: i, command: step.command, sent_at: stepSentAt, waited_ms: stepWaitedMs, submit_retries: submitRetries, submitted: stepSubmitted });
        await writeResult({ ok: false, submitted: chainSubmitted, error: 'session exited during wait', partial: true, steps_completed: i, sessionId, sent_at: step0SentAt, steps, total_waited_ms: totalWaitedMs });
        return;
      }

      if (result.timedOut) {
        ctx.log.warn(`[trigger-watcher] Chain timeout at step ${i}:`, sessionId);
        steps.push({ idx: i, command: step.command, sent_at: stepSentAt, waited_ms: stepWaitedMs, submit_retries: submitRetries, submitted: stepSubmitted });
        await writeResult({ ok: false, submitted: chainSubmitted, error: 'chain timeout', partial: true, steps_completed: i, sessionId, sent_at: step0SentAt, steps, total_waited_ms: totalWaitedMs });
        return;
      }
    }

    steps.push({ idx: i, command: step.command, sent_at: stepSentAt, waited_ms: stepWaitedMs, submit_retries: submitRetries, submitted: stepSubmitted });
  }

  await writeResult({
    ok:               true,
    submitted:        chainSubmitted,
    sessionId,
    sent_at:          step0SentAt,
    steps,
    total_waited_ms:  totalWaitedMs,
  });

  } catch (err) {
    // see .ai/contexts/trigger-watcher.md, "Removing the entry"
    safeLogError(ctx, '[trigger-watcher] Trigger processing threw, writing a generic failure result:',
      name, err && err.message);
    await writeResult({ ok: false, error: 'internal error: ' + (err && err.message), internal: true });
  } finally {
    if (releaseSessionLock) releaseSessionLock();
  }
}

/**
 * Start the trigger watcher.
 *
 * Also runs a one-time startup scan of whatever *.json already sits at the
 * root of the triggers dir when this is called, feeding each one through the
 * same handleFile() path a live 'rename' event would (dedup + MAX_INFLIGHT
 * both apply identically). See .ai/contexts/trigger-watcher.md, "Startup scan".
 *
 * @param {object} ctx
 * @param {function} ctx.getPtyForSession  (sessionId: string) => { ptyProcess, cwd } | null;
 *                                          `cwd` feeds the expectedCwd target
 *                                          guard (see .ai/contexts/trigger-watcher.md, "Target guard")
 * @param {function} ctx.isSessionBusy     (sessionId: string) => boolean
 * @param {function} [ctx.getComposerState] (sessionId) => { pending, lastInputAt } | null;
 *                                          absent or null means busy, never free
 * @param {function} [ctx.isPtyAlive]      (ptyProcess) => boolean (default: signal 0 probe)
 * @param {object}   ctx.log               electron-log compatible logger
 * @returns {{ close(): void }}
 */
function start(ctx) {
  const triggersDir  = getTriggersDir();
  const processedDir = path.join(triggersDir, 'processed');

  // Ensure directories exist
  try {
    fs.mkdirSync(triggersDir,  { recursive: true });
    fs.mkdirSync(processedDir, { recursive: true });
  } catch (err) {
    ctx.log.error('[trigger-watcher] Failed to create trigger directories:', err.message);
    return { close() {} };
  }

  ctx.log.info('[trigger-watcher] Watching:', triggersDir);

  // Track in-flight processing to avoid double-processing on noisy fs events.
  // W4: also enforces the MAX_INFLIGHT concurrency cap.
  const inFlight = new Set();
  // W4: queue of filenames awaiting an in-flight slot
  const waitQueue = [];
  // Entries that were processed but stayed in the directory — see
  // .ai/contexts/trigger-watcher.md.
  const retained = new Set();

  // see .ai/contexts/trigger-watcher.md, "Session serialization"
  const sessionLocks = new Map(); // sessionId -> tail Promise of the queue
  function acquireSessionLock(sessionId) {
    const previous = sessionLocks.get(sessionId) || Promise.resolve();
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const tail = previous.then(() => held);
    sessionLocks.set(sessionId, tail);
    return previous.then(() => () => {
      release();
      if (sessionLocks.get(sessionId) === tail) sessionLocks.delete(sessionId);
    });
  }

  function scheduleNext() {
    while (waitQueue.length > 0 && inFlight.size < MAX_INFLIGHT) {
      const filename = waitQueue.shift();
      // Dedup: may have been enqueued twice before a slot opened
      if (inFlight.has(filename) || retained.has(filename)) continue;
      dispatch(filename);
    }
  }

  function dispatch(filename) {
    inFlight.add(filename);
    processTriggerFile(filename, ctx, triggersDir, processedDir, () => retained.add(filename), acquireSessionLock)
      .catch((err) => {
        retained.add(filename);
        safeLogError(ctx, '[trigger-watcher] Trigger processing threw, will not be run again:',
          filename, err && err.message);
      })
      .finally(() => {
        inFlight.delete(filename);
        scheduleNext();
      });
  }

  // Shared by the live fs.watch callback below AND the startup scan
  // (scanExistingTriggers) — same dedup (inFlight/retained) and same
  // MAX_INFLIGHT backpressure (waitQueue) for either origin of a filename.
  // See .ai/contexts/trigger-watcher.md, "Startup scan".
  function handleFile(filename) {
    if (!filename || !filename.endsWith('.json')) return;
    // Ignore files inside subdirectories (e.g. processed/) — fs.watch on
    // Linux only reports the basename for non-recursive watches, but be
    // defensive: skip anything that looks like a path separator. readdirSync
    // on triggersDir never returns a nested path either way, so this guard
    // covers the watch-only case in practice.
    if (filename.includes('/') || filename.includes(path.sep)) return;
    if (inFlight.has(filename) || retained.has(filename)) return;

    // Confirm the file still exists (a 'rename' event fires on delete too;
    // a scanned name can also have been removed between readdir and here).
    const filePath = path.join(triggersDir, filename);
    try {
      fs.accessSync(filePath, fs.constants.R_OK);
    } catch {
      return; // File gone or not readable yet — skip
    }

    if (inFlight.size >= MAX_INFLIGHT) {
      // W4: backpressure — queue for later
      waitQueue.push(filename);
      return;
    }
    dispatch(filename);
  }

  let watcher;
  try {
    watcher = fs.watch(triggersDir, { persistent: true }, (eventType, filename) => {
      if (eventType !== 'rename') return;
      handleFile(filename);
    });

    watcher.on('error', (err) => {
      ctx.log.error('[trigger-watcher] Watcher error:', err.message);
    });
  } catch (err) {
    ctx.log.error('[trigger-watcher] Failed to start watcher:', err.message);
    return { close() {} };
  }

  // Startup scan — see .ai/contexts/trigger-watcher.md, "Startup scan". Runs
  // AFTER the watcher is installed, deliberately: installing it first closes
  // the window where a trigger written between "watcher up" and "scan done"
  // would otherwise be seen by neither. Sub-directories (processed/ in
  // particular) are never descended into — readdirSync on triggersDir itself
  // only ever returns its direct children, and the '.json' filter in
  // handleFile() additionally excludes the 'processed' directory entry itself.
  try {
    const names = fs.readdirSync(triggersDir);
    for (const name of names) handleFile(name);
  } catch (err) {
    ctx.log.error('[trigger-watcher] Startup scan failed:', err.message);
  }

  return {
    close() {
      try { watcher.close(); } catch {}
    },
  };
}

module.exports = { start, weakestSubmitted, SUBMITTED_RANK, normalizeCwd };
