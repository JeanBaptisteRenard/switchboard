// trigger-watcher.js — File-based input injection for harness scripts.
//
// Drop a JSON trigger file into SWITCHBOARD_TRIGGERS_DIR (default
// ~/.switchboard/triggers/<uuid>.json) and this module writes the command into
// the matching PTY session's stdin.  The result is written to
// SWITCHBOARD_TRIGGERS_DIR/processed/<uuid>.result.json; the trigger file is
// then deleted.
//
// Exports: start(ctx) where ctx = { getPtyForSession, isSessionBusy, log }
'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const DEFAULT_TRIGGERS_DIR   = path.join(os.homedir(), '.switchboard', 'triggers');
const DEFAULT_IDLE_TIMEOUT   = 30_000; // ms
const IDLE_POLL_INTERVAL     = 100;   // ms

function getTriggersDir() {
  return process.env.SWITCHBOARD_TRIGGERS_DIR || DEFAULT_TRIGGERS_DIR;
}

function getIdleTimeout() {
  const v = process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
  return v ? parseInt(v, 10) : DEFAULT_IDLE_TIMEOUT;
}

/**
 * Poll until isSessionBusy(sessionId) returns false, or the timeout expires.
 * Returns { timedOut: boolean, waited_ms: number }.
 */
function waitForIdle(sessionId, ctx) {
  return new Promise((resolve) => {
    const timeout  = getIdleTimeout();
    const start    = Date.now();

    function check() {
      const waited_ms = Date.now() - start;
      if (!ctx.isSessionBusy(sessionId)) {
        return resolve({ timedOut: false, waited_ms });
      }
      if (waited_ms >= timeout) {
        return resolve({ timedOut: true, waited_ms });
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

  async function writeResult(result) {
    try {
      fs.writeFileSync(resultPath, JSON.stringify(result) + '\n', 'utf8');
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

  // ── 1. Read + parse ───────────────────────────────────────────────────────
  let trigger;
  try {
    const raw = fs.readFileSync(triggerPath, 'utf8');
    trigger   = JSON.parse(raw);
  } catch (err) {
    ctx.log.warn('[trigger-watcher] Unreadable/unparseable trigger:', name, err.message);
    await writeResult({ ok: false, error: 'invalid JSON: ' + err.message });
    return;
  }

  // ── 2. Validate shape ─────────────────────────────────────────────────────
  const { sessionId, command, wait = 'none' } = trigger;

  if (typeof sessionId !== 'string' || !sessionId) {
    await writeResult({ ok: false, error: 'missing required field: sessionId', sessionId: sessionId || null });
    return;
  }
  if (typeof command !== 'string' || !command) {
    await writeResult({ ok: false, error: 'missing required field: command', sessionId });
    return;
  }

  // ── 3. Look up session ────────────────────────────────────────────────────
  const sessionEntry = ctx.getPtyForSession(sessionId);
  if (!sessionEntry) {
    ctx.log.warn('[trigger-watcher] Session not found:', sessionId);
    await writeResult({ ok: false, error: 'session not found', sessionId });
    return;
  }

  const { ptyProcess } = sessionEntry;

  // ── 4. Idle wait ──────────────────────────────────────────────────────────
  let waited_ms = 0;
  if (wait === 'idle') {
    const result = await waitForIdle(sessionId, ctx);
    waited_ms    = result.waited_ms;
    if (result.timedOut) {
      ctx.log.warn('[trigger-watcher] Idle timeout for session:', sessionId);
      await writeResult({ ok: false, error: 'timeout waiting for idle', sessionId, waited_ms });
      return;
    }
  }

  // ── 5. Write to PTY ───────────────────────────────────────────────────────
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

  // Track in-flight processing to avoid double-processing on noisy fs events
  const inFlight = new Set();

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

      inFlight.add(filename);
      processTriggerFile(filename, ctx, triggersDir, processedDir).finally(() => {
        inFlight.delete(filename);
      });
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
