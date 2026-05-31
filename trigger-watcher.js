// trigger-watcher.js — File-based input injection for harness scripts.
//
// Drop a JSON trigger file into SWITCHBOARD_TRIGGERS_DIR (default
// ~/.switchboard/triggers/<uuid>.json) and this module writes the command into
// the matching PTY session's stdin.  The result is written to
// SWITCHBOARD_TRIGGERS_DIR/processed/<uuid>.result.json; the trigger file is
// then deleted.
//
// Exports: start(ctx) where ctx = { getPtyForSession, isSessionBusy, log }
//
// Security limits (defense-in-depth):
//   - Max trigger file size: 64 KB (C1)
//   - Symlinks rejected via lstat (C2)
//   - Max command length: 4 KB (W2)
//   - Forbidden control chars in command: \r \n \0 \x1b (W3)
//   - Max concurrent in-flight triggers: 8 (W4)
//   - Per-trigger timeout_ms capped at 600 000 ms (W6)
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
// Control chars forbidden in command: CR, LF, NUL, ESC (W3)
const FORBIDDEN_COMMAND_RE = /[\r\n\0\x1b]/;

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
  return new Promise((resolve) => {
    const timeout  = (timeoutMs !== undefined) ? timeoutMs : getIdleTimeout();
    const start    = Date.now();

    function check() {
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
      setTimeout(check, IDLE_POLL_INTERVAL);
    }

    check();
  });
}

/**
 * Process a single trigger file (by basename, e.g. "abc-123.json").
 * Never throws — all errors land in the result file.
 */
async function processTriggerFile(name, ctx, triggersDir, processedDir) {
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
    try {
      fs.writeFileSync(resultTmp, JSON.stringify(result) + '\n', 'utf8');
      fs.renameSync(resultTmp, resultPath);
    } catch (err) {
      ctx.log.error('[trigger-watcher] Failed to write result file:', err.message);
    }
    try {
      fs.unlinkSync(triggerPath);
    } catch {
      // Trigger may already be gone (race between two watcher events for the
      // same file). Silently ignore.
    }
  }

  // ── 1. lstat + size guard (C1 + C2) ──────────────────────────────────────
  let stat;
  try {
    stat = fs.lstatSync(triggerPath); // C2: lstat does NOT follow symlinks
  } catch {
    // File gone between access check and here — skip silently
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
  const { sessionId, command, wait = 'none', timeout_ms } = trigger;

  if (typeof sessionId !== 'string' || !sessionId) {
    await writeResult({ ok: false, error: 'missing required field: sessionId', sessionId: sessionId || null });
    return;
  }
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

  // W6: validate optional per-trigger timeout_ms
  // Precedence: timeout_ms (per-trigger) > SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS (env) > default.
  // Must be a positive integer not exceeding MAX_TRIGGER_TIMEOUT (600 000 ms).
  // Reject and release semaphore immediately on invalid value — do NOT inject.
  let resolvedTimeoutMs;
  if (timeout_ms !== undefined) {
    if (
      typeof timeout_ms !== 'number' ||
      !Number.isInteger(timeout_ms) ||
      timeout_ms <= 0 ||
      timeout_ms > MAX_TRIGGER_TIMEOUT
    ) {
      await writeResult({ ok: false, error: 'invalid timeout_ms', sessionId });
      return;
    }
    resolvedTimeoutMs = timeout_ms;
  }
  // When timeout_ms is absent, resolvedTimeoutMs stays undefined and waitForIdle
  // falls back to getIdleTimeout() (env var → compiled default).

  // ── 4. Look up session ────────────────────────────────────────────────────
  const sessionEntry = ctx.getPtyForSession(sessionId);
  if (!sessionEntry) {
    ctx.log.warn('[trigger-watcher] Session not found:', sessionId);
    await writeResult({ ok: false, error: 'session not found', sessionId });
    return;
  }

  const { ptyProcess } = sessionEntry;

  // ── 5. Idle wait ──────────────────────────────────────────────────────────
  let waited_ms = 0;
  if (wait === 'idle') {
    const result = await waitForIdle(sessionId, ctx, resolvedTimeoutMs);
    waited_ms    = result.waited_ms;

    // W5: session exited during wait
    if (result.sessionExited) {
      ctx.log.warn('[trigger-watcher] Session exited during wait:', sessionId);
      await writeResult({ ok: false, error: 'session exited during wait', sessionId, waited_ms });
      return;
    }

    if (result.timedOut) {
      ctx.log.warn('[trigger-watcher] Idle timeout for session:', sessionId);
      await writeResult({ ok: false, error: 'timeout waiting for idle', sessionId, waited_ms });
      return;
    }
  }

  // ── 6. Write to PTY ───────────────────────────────────────────────────────
  try {
    ptyProcess.write(command + '\r');
  } catch (err) {
    ctx.log.error('[trigger-watcher] PTY write failed:', err.message);
    await writeResult({ ok: false, error: 'pty write failed: ' + err.message, sessionId });
    return;
  }

  ctx.log.info(`[trigger-watcher] Sent command to ${sessionId}: ${command}`);

  await writeResult({
    ok:        true,
    sessionId,
    command,
    sent_at:   new Date().toISOString(),
    waited_ms,
  });
}

/**
 * Start the trigger watcher.
 *
 * @param {object} ctx
 * @param {function} ctx.getPtyForSession  (sessionId: string) => { ptyProcess } | null
 * @param {function} ctx.isSessionBusy     (sessionId: string) => boolean
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

  function scheduleNext() {
    while (waitQueue.length > 0 && inFlight.size < MAX_INFLIGHT) {
      const filename = waitQueue.shift();
      // Dedup: may have been enqueued twice before a slot opened
      if (inFlight.has(filename)) continue;
      dispatch(filename);
    }
  }

  function dispatch(filename) {
    inFlight.add(filename);
    processTriggerFile(filename, ctx, triggersDir, processedDir).finally(() => {
      inFlight.delete(filename);
      scheduleNext();
    });
  }

  let watcher;
  try {
    watcher = fs.watch(triggersDir, { persistent: true }, (eventType, filename) => {
      if (eventType !== 'rename') return;
      if (!filename || !filename.endsWith('.json')) return;
      // Ignore files inside subdirectories (e.g. processed/) — fs.watch on
      // Linux only reports the basename for non-recursive watches, but be
      // defensive: skip anything that looks like a path separator.
      if (filename.includes('/') || filename.includes(path.sep)) return;
      if (inFlight.has(filename)) return;

      // Confirm the file still exists (the rename event fires on delete too)
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
    });

    watcher.on('error', (err) => {
      ctx.log.error('[trigger-watcher] Watcher error:', err.message);
    });
  } catch (err) {
    ctx.log.error('[trigger-watcher] Failed to start watcher:', err.message);
    return { close() {} };
  }

  return {
    close() {
      try { watcher.close(); } catch {}
    },
  };
}

module.exports = { start };
