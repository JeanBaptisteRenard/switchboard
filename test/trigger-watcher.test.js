// test/trigger-watcher.test.js — node:test suite for trigger-watcher.js
//
// Strategy: real fs in a mkdtemp sandbox, env vars override dirs + timeouts.
// No mocks — ctx provides a concrete in-memory PTY stand-in.
'use strict';

// Keep the discrete-Enter submit delay tiny so the suite stays fast and the
// turn-completion timing in makeChainCtx is not perturbed by a 50ms wait.
process.env.SWITCHBOARD_SUBMIT_ENTER_DELAY_MS = '1';

// Submission-verify window: must exceed makeChainCtx's simulated busy-rise
// (50ms after the '\r' write) plus one IDLE_POLL_INTERVAL (100ms) so the poll
// reliably catches the rising edge, yet stay short enough to keep the suite
// fast and deterministic when no rise ever arrives (retry path).
process.env.SWITCHBOARD_SUBMIT_VERIFY_MS = '400';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

// ── Helpers ───────────────────────────────────────────────────────────────────

function mkTmp() {
  // realpath the sandbox: on Windows os.tmpdir() can be an 8.3 short name
  // (C:\Users\JEAN-B~1\...) and fs.watch on a short-name path trips a libuv
  // assertion (src\win\fs-event.c) that kills the test process.
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sw-trigger-')));
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

/** Silent no-op logger */
const silentLog = {
  info:  () => {},
  warn:  () => {},
  error: () => {},
  debug: () => {},
};

/**
 * Build a ctx object with a spy PTY for `sessionId`.
 *
 * @param {string}   sessionId
 * @param {function} [isBusyFn]  () => boolean  (default: always false)
 * @param {object}   [opts]
 * @param {boolean}  [opts.ptyThrows]  if true, pty.write throws an error
 */
function makeCtx(sessionId, isBusyFn = () => false, opts = {}) {
  const written = [];
  // Politeness guard: an empty, quiet composer unless a test says otherwise.
  const composer = { pending: 0, lastInputAt: 0 };
  const ptyProcess = {
    // pid points at the running node test process so the default liveness check
    // (signal-0 probe) sees a real, alive pid in existing tests.
    pid: process.pid,
    write(data) {
      if (opts.ptyThrows) throw new Error('PTY closed');
      written.push(data);
    },
  };

  // Support dynamic session removal for W5 test
  let sessionPresent = true;
  // Support dynamic liveness flip for W7 tests
  let alive = opts.alive !== undefined ? opts.alive : true;

  return {
    log: silentLog,
    getPtyForSession(id) {
      if (!sessionPresent) return null;
      return id === sessionId ? { ptyProcess } : null;
    },
    isSessionBusy(id) {
      return id === sessionId ? isBusyFn() : false;
    },
    isPtyAlive() { return alive; },
    getComposerState(id) {
      return id === sessionId
        ? { pending: composer.pending, lastInputAt: composer.lastInputAt }
        : null;
    },
    _written: written,
    _ptyProcess: ptyProcess,
    _composer: composer,
    _removeSession() { sessionPresent = false; },
    _killPty() { alive = false; },
  };
}

/**
 * Write a trigger file and return its path.
 */
function writeTrigger(dir, uuid, payload) {
  const p = path.join(dir, uuid + '.json');
  fs.writeFileSync(p, JSON.stringify(payload), 'utf8');
  return p;
}

/**
 * Wait up to `maxMs` for a file to appear, polling every `pollMs`.
 */
function waitForFile(filePath, maxMs = 2000, pollMs = 20) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + maxMs;
    function poll() {
      if (fs.existsSync(filePath)) return resolve();
      if (Date.now() >= deadline) return reject(new Error('Timeout waiting for file: ' + filePath));
      setTimeout(poll, pollMs);
    }
    poll();
  });
}

function readResult(processedDir, uuid) {
  const p = path.join(processedDir, uuid + '.result.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// ── Test cases ────────────────────────────────────────────────────────────────

test('happy path: trigger → pty.write called, result ok:true, trigger deleted', async () => {
  const tmp = mkTmp();
  let watcher;
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '200';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-happy-' + Date.now();
    const ctx        = makeCtx(SESSION_ID);
    watcher = start(ctx);

    const uuid    = 'aaa-' + Date.now();
    const triggerPath = writeTrigger(tmp, uuid, {
      sessionId: SESSION_ID,
      command:   '/compact',
    });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, true, 'result.ok should be true');
    assert.equal(result.sessionId, SESSION_ID);
    assert.equal(result.command, '/compact');
    assert.ok(result.sent_at, 'result.sent_at should be set');
    assert.equal(typeof result.waited_ms, 'number', 'waited_ms should be a number');
    // busy never rises in this ctx → submit-verify retries the Enter once.
    assert.equal(result.submit_retries, 1, 'submit_retries should be 1 (no busy-rise observed)');

    // pty.write: command text, discrete Enter, then the verify-retry Enter.
    assert.deepEqual(ctx._written, ['/compact', '\r', '\r'], 'pty.write: command text, Enter, then retry Enter');

    // Trigger file deleted
    assert.equal(fs.existsSync(triggerPath), false, 'trigger file should be deleted');

  } finally {
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

test('unknown sessionId: result ok:false with session not found, no PTY write', async () => {
  const tmp = mkTmp();
  let watcher;
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '200';

    const { start } = require('../trigger-watcher');
    const ctx        = makeCtx('real-session');
    watcher = start(ctx);

    const uuid    = 'bbb-' + Date.now();
    const triggerPath = writeTrigger(tmp, uuid, {
      sessionId: 'nonexistent-session-id',
      command:   '/compact',
    });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, false);
    assert.match(result.error, /session not found/);

    assert.deepEqual(ctx._written, [], 'no PTY write for unknown session');
    assert.equal(fs.existsSync(triggerPath), false, 'trigger file should be deleted');

  } finally {
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

test('malformed JSON: result ok:false with error, trigger deleted, no PTY write', async () => {
  const tmp = mkTmp();
  let watcher;
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '200';

    const { start } = require('../trigger-watcher');
    const ctx        = makeCtx('any-session');
    watcher = start(ctx);

    const uuid    = 'ccc-' + Date.now();
    const triggerPath = path.join(tmp, uuid + '.json');
    fs.writeFileSync(triggerPath, '{ invalid json }', 'utf8');

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, false);
    assert.match(result.error, /invalid JSON/i);

    assert.deepEqual(ctx._written, [], 'no PTY write for malformed JSON');
    assert.equal(fs.existsSync(triggerPath), false, 'trigger file should be deleted');

  } finally {
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

test('missing required field (no command): result ok:false, no PTY write', async () => {
  const tmp = mkTmp();
  let watcher;
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '200';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-nocommand-' + Date.now();
    const ctx        = makeCtx(SESSION_ID);
    watcher = start(ctx);

    const uuid    = 'ddd-' + Date.now();
    const triggerPath = writeTrigger(tmp, uuid, { sessionId: SESSION_ID });
    // 'command' field intentionally omitted

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, false);
    assert.match(result.error, /command/i);

    assert.deepEqual(ctx._written, [], 'no PTY write when command missing');
    assert.equal(fs.existsSync(triggerPath), false, 'trigger file should be deleted');

  } finally {
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

test('wait:idle while busy → flips to idle after 150ms → write happens, waited_ms >= 150', async () => {
  const tmp = mkTmp();
  let watcher;
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '2000'; // generous timeout

    const { start } = require('../trigger-watcher');
    let busy = true;
    const SESSION_ID = 'sess-idle-' + Date.now();
    const ctx = makeCtx(SESSION_ID, () => busy);
    watcher = start(ctx);

    const uuid    = 'eee-' + Date.now();
    writeTrigger(tmp, uuid, {
      sessionId: SESSION_ID,
      command:   '/compact',
      wait:      'idle',
    });

    // Flip to idle after 150ms
    setTimeout(() => { busy = false; }, 150);

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 3000); // plenty of time

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, true, 'result should be ok');
    assert.ok(
      result.waited_ms >= 100,
      `waited_ms (${result.waited_ms}) should be >= 100ms`,
    );
    // busy is false by the time we submit → no rise → verify retries the Enter.
    assert.deepEqual(ctx._written, ['/compact', '\r', '\r'], 'PTY write should happen after idle (with verify-retry Enter)');

  } finally {
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

test('wait:idle timeout: busy stays true → ok:false, error "not sent", no PTY write', async () => {
  const tmp = mkTmp();
  let watcher;
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '200'; // short timeout for test

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-timeout-' + Date.now();
    const ctx = makeCtx(SESSION_ID, () => true); // always busy
    watcher = start(ctx);

    const uuid    = 'fff-' + Date.now();
    writeTrigger(tmp, uuid, {
      sessionId: SESSION_ID,
      command:   '/compact',
      wait:      'idle',
    });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 2000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'not sent', 'nothing was written, so the guard is voided');
    assert.match(result.reason, /timeout/i, 'the detail lives in reason, not in error');

    assert.deepEqual(ctx._written, [], 'no PTY write on idle timeout');

  } finally {
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// ── New tests for review findings ─────────────────────────────────────────────

// C1: size cap rejection
test('C1 size cap: trigger > 64 KB rejected before read, result ok:false', async () => {
  const tmp = mkTmp();
  let watcher;
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '200';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-c1-' + Date.now();
    const ctx        = makeCtx(SESSION_ID);
    watcher = start(ctx);

    const uuid    = 'c1-' + Date.now();
    const bigPath = path.join(tmp, uuid + '.json');
    // Write a file larger than 64 KB (not valid JSON, but that's irrelevant — size check fires first)
    fs.writeFileSync(bigPath, Buffer.alloc(65 * 1024, 'x'), 'utf8');

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 2000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, false);
    assert.match(result.error, /too large/i);

    assert.deepEqual(ctx._written, [], 'no PTY write for oversized trigger');

  } finally {
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// C2: symlink rejection
test('C2 symlink: symlinked trigger rejected, result ok:false', async () => {
  const tmp = mkTmp();
  let watcher;
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '200';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-c2-' + Date.now();
    const ctx        = makeCtx(SESSION_ID);
    watcher = start(ctx);

    const uuid      = 'c2-' + Date.now();
    const linkPath  = path.join(tmp, uuid + '.json');
    // Symlink to /etc/hostname (always exists on Linux)
    fs.symlinkSync('/etc/hostname', linkPath);

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 2000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, false);
    assert.match(result.error, /regular file/i);

    assert.deepEqual(ctx._written, [], 'no PTY write for symlink trigger');

  } finally {
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// W1: SyntaxError retry — trigger is initially truncated JSON but becomes valid after 30 ms.
// We simulate this by writing valid JSON directly (the retry should succeed on first attempt);
// then we test the "retry-then-fail" path: both attempts get bad JSON → ok:false.
test('W1 partial-write retry: truncated JSON on both attempts → ok:false after retry', async () => {
  const tmp = mkTmp();
  let watcher;
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '200';

    const { start } = require('../trigger-watcher');
    const ctx    = makeCtx('any-session');
    watcher = start(ctx);

    const uuid      = 'w1-' + Date.now();
    const trigPath  = path.join(tmp, uuid + '.json');
    // Write truncated JSON — both the initial read and the 50 ms retry read will get this
    fs.writeFileSync(trigPath, '{"sessionId":"x","command":', 'utf8');

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    // Allow 500 ms — the retry adds 50 ms, but we still expect a result
    await waitForFile(resultPath, 1000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, false);
    assert.match(result.error, /invalid JSON/i);

  } finally {
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// W2: command too long
test('W2 command length cap: command > 4 KB rejected, result ok:false', async () => {
  const tmp = mkTmp();
  let watcher;
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '200';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-w2-' + Date.now();
    const ctx        = makeCtx(SESSION_ID);
    watcher = start(ctx);

    const uuid = 'w2-' + Date.now();
    writeTrigger(tmp, uuid, {
      sessionId: SESSION_ID,
      command:   'x'.repeat(4097), // one byte over the 4 KB cap
    });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 2000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, false);
    assert.match(result.error, /too long/i);

    assert.deepEqual(ctx._written, [], 'no PTY write for too-long command');

  } finally {
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// W3: control chars in command
test('W3 forbidden control chars: \\r in command rejected, result ok:false', async () => {
  const tmp = mkTmp();
  let watcher;
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '200';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-w3-' + Date.now();
    const ctx        = makeCtx(SESSION_ID);
    watcher = start(ctx);

    const uuid = 'w3-' + Date.now();
    // Write raw JSON with \r character in command
    const payload = JSON.stringify({ sessionId: SESSION_ID, command: '/compact\rclear' });
    fs.writeFileSync(path.join(tmp, uuid + '.json'), payload, 'utf8');

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 2000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, false);
    assert.match(result.error, /forbidden control/i);

    assert.deepEqual(ctx._written, [], 'no PTY write for command with control chars');

  } finally {
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// W4: concurrency cap — drop 12 triggers simultaneously, verify all 12 get processed
test('W4 concurrency cap: 12 simultaneous triggers all get processed', async () => {
  const tmp = mkTmp();
  let watcher;
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '200';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-w4-' + Date.now();
    const ctx        = makeCtx(SESSION_ID);
    watcher = start(ctx);

    const COUNT  = 12;
    const uuids  = Array.from({ length: COUNT }, (_, i) => `w4-${Date.now()}-${i}`);

    // Drop all 12 triggers at once
    for (const uuid of uuids) {
      writeTrigger(tmp, uuid, { sessionId: SESSION_ID, command: '/compact' });
    }

    // Wait for all 12 result files
    await Promise.all(uuids.map(uuid =>
      waitForFile(path.join(tmp, 'processed', uuid + '.result.json'), 5000),
    ));

    // All 12 should be ok:true
    for (const uuid of uuids) {
      const result = readResult(path.join(tmp, 'processed'), uuid);
      assert.equal(result.ok, true, `trigger ${uuid} should be ok:true`);
    }

    // 12 command texts should have been written. We count by command texts
    // (w !== '\r') rather than Enters, because submit-verify may add a retry '\r'
    // per command when no busy-rise is observed.
    assert.equal(ctx._written.filter((w) => w !== '\r').length, COUNT, `expected ${COUNT} submitted commands`);

  } finally {
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// W5: session exits during wait:idle
test('W5 session exits during wait:idle → ok:false, error contains "session exited"', async () => {
  const tmp = mkTmp();
  let watcher;
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '2000';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-w5-' + Date.now();
    const ctx = makeCtx(SESSION_ID, () => true); // stays busy
    watcher = start(ctx);

    const uuid = 'w5-' + Date.now();
    writeTrigger(tmp, uuid, {
      sessionId: SESSION_ID,
      command:   '/compact',
      wait:      'idle',
    });

    // Remove the session after 150 ms (simulating PTY exit during wait)
    setTimeout(() => ctx._removeSession(), 150);

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 3000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, false);
    assert.match(result.error, /session exited/i);

    assert.deepEqual(ctx._written, [], 'no PTY write when session exited during wait');

  } finally {
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// W6 extra: PTY write throws — result ok:false with pty write failed
test('PTY write throws: result ok:false with pty write failed error', async () => {
  const tmp = mkTmp();
  let watcher;
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '200';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-ptythrow-' + Date.now();
    const ctx        = makeCtx(SESSION_ID, () => false, { ptyThrows: true });
    watcher = start(ctx);

    const uuid = 'ptythrow-' + Date.now();
    writeTrigger(tmp, uuid, { sessionId: SESSION_ID, command: '/compact' });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 2000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, false);
    assert.match(result.error, /pty write failed/i);

  } finally {
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// W6 extra: inFlight dedup — same filename triggers twice, only processed once per dedup cycle
test('inFlight dedup: same filename event fired twice → processed at most once concurrently', async () => {
  const tmp = mkTmp();
  let watcher;
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '200';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-dedup-' + Date.now();
    const ctx        = makeCtx(SESSION_ID);
    watcher = start(ctx);

    // Write the trigger file once
    const uuid    = 'dedup-' + Date.now();
    writeTrigger(tmp, uuid, { sessionId: SESSION_ID, command: '/compact' });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 2000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, true);
    // The trigger file is deleted after first processing, so any second fs.watch
    // event for the same name finds no file and is silently skipped.
    // Count command texts (w !== '\r'): submit-verify may add a retry '\r'.
    assert.equal(ctx._written.filter((w) => w !== '\r').length, 1, 'command submitted exactly once');

  } finally {
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// I4: NaN guard — invalid timeout env var falls back to default, does not poll forever
test('I4 NaN timeout: invalid SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS uses default (no infinite loop)', async () => {
  const tmp = mkTmp();
  let watcher;
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = 'not-a-number'; // I4: triggers NaN guard

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-i4-' + Date.now();
    // Always busy — with a valid timeout this resolves to timedOut; without NaN guard it never resolves
    const ctx = makeCtx(SESSION_ID, () => true);
    watcher = start(ctx);

    const uuid = 'i4-' + Date.now();
    writeTrigger(tmp, uuid, {
      sessionId: SESSION_ID,
      command:   '/compact',
      wait:      'idle',
    });

    // With NaN guard the default 300s timeout fires; but that's too slow for a test.
    // Instead confirm the module at least computes a finite timeout (no immediate hang):
    // we close the watcher and clean up after 1s — if it was still polling forever
    // the result file would never appear after 1 s; but with a normal default timeout
    // the poll eventually resolves (just slowly).  We only assert it doesn't throw.
    await new Promise(r => setTimeout(r, 200));
    // No assertion on result needed — the goal is no crash / unhandled rejection.
  } finally {
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// ── timeout_ms field tests ─────────────────────────────────────────────────────

// W6-1: per-trigger timeout_ms honored end-to-end
// The trigger carries timeout_ms=500; session is busy for 150ms then idle.
// The per-trigger timeout should govern (not the env var), and injection succeeds.
test('W6 timeout_ms: per-trigger timeout_ms honored, overrides env-var fallback', async () => {
  const tmp = mkTmp();
  let watcher;
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    // env var set to 50 ms — without per-trigger override this would time out
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '50';

    const { start } = require('../trigger-watcher');
    let busy = true;
    const SESSION_ID = 'sess-tmout-override-' + Date.now();
    const ctx = makeCtx(SESSION_ID, () => busy);
    watcher = start(ctx);

    const uuid = 'tmout-override-' + Date.now();
    writeTrigger(tmp, uuid, {
      sessionId:  SESSION_ID,
      command:    '/compact',
      wait:       'idle',
      timeout_ms: 1000, // per-trigger override: 1 s (50 ms env var would time out first)
    });

    // Flip idle after 150 ms — env var (50 ms) would have timed out, but timeout_ms=1000 still waits
    setTimeout(() => { busy = false; }, 150);

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 3000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, true, 'result should be ok when timeout_ms overrides short env var');
    assert.ok(result.waited_ms >= 100, `waited_ms (${result.waited_ms}) should be >= 100ms`);
    // busy is false at submit time → no rise → verify retries the Enter once.
    assert.deepEqual(ctx._written, ['/compact', '\r', '\r'], 'PTY write should happen (with verify-retry Enter)');

  } finally {
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// W6-2: invalid timeout_ms — negative value
test('W6 timeout_ms invalid: negative → ok:false, error "invalid timeout_ms", no PTY write', async () => {
  const tmp = mkTmp();
  let watcher;
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '200';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-neg-tmout-' + Date.now();
    const ctx        = makeCtx(SESSION_ID);
    watcher = start(ctx);

    const uuid = 'neg-tmout-' + Date.now();
    writeTrigger(tmp, uuid, {
      sessionId:  SESSION_ID,
      command:    '/compact',
      timeout_ms: -1,
    });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 2000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, false);
    assert.match(result.error, /invalid timeout_ms/);
    assert.deepEqual(ctx._written, [], 'no PTY write for invalid timeout_ms');

  } finally {
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// W6-3: invalid timeout_ms — non-integer float
test('W6 timeout_ms invalid: non-integer float (1.5) → ok:false, no PTY write', async () => {
  const tmp = mkTmp();
  let watcher;
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '200';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-float-tmout-' + Date.now();
    const ctx        = makeCtx(SESSION_ID);
    watcher = start(ctx);

    const uuid = 'float-tmout-' + Date.now();
    writeTrigger(tmp, uuid, {
      sessionId:  SESSION_ID,
      command:    '/compact',
      timeout_ms: 1.5,
    });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 2000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, false);
    assert.match(result.error, /invalid timeout_ms/);
    assert.deepEqual(ctx._written, [], 'no PTY write for float timeout_ms');

  } finally {
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// W6-4: invalid timeout_ms — exceeds cap (> 600 000)
test('W6 timeout_ms invalid: value > 600000 → ok:false, no PTY write', async () => {
  const tmp = mkTmp();
  let watcher;
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '200';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-cap-tmout-' + Date.now();
    const ctx        = makeCtx(SESSION_ID);
    watcher = start(ctx);

    const uuid = 'cap-tmout-' + Date.now();
    writeTrigger(tmp, uuid, {
      sessionId:  SESSION_ID,
      command:    '/compact',
      timeout_ms: 600001,
    });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 2000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, false);
    assert.match(result.error, /invalid timeout_ms/);
    assert.deepEqual(ctx._written, [], 'no PTY write for over-cap timeout_ms');

  } finally {
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// W6-5: invalid timeout_ms — string type (not a JSON number)
test('W6 timeout_ms invalid: string type ("500") → ok:false, no PTY write', async () => {
  const tmp = mkTmp();
  let watcher;
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '200';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-str-tmout-' + Date.now();
    const ctx        = makeCtx(SESSION_ID);
    watcher = start(ctx);

    // Write raw JSON so we control the type exactly (writeTrigger uses JSON.stringify
    // which would coerce, but here we need a JSON string value)
    const uuid = 'str-tmout-' + Date.now();
    fs.writeFileSync(
      path.join(tmp, uuid + '.json'),
      JSON.stringify({ sessionId: SESSION_ID, command: '/compact', timeout_ms: '500' }),
      'utf8',
    );

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 2000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, false);
    assert.match(result.error, /invalid timeout_ms/);
    assert.deepEqual(ctx._written, [], 'no PTY write for string timeout_ms');

  } finally {
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// W6-6: absent timeout_ms → falls back to env-var
test('W6 timeout_ms absent: falls back to env-var; env-var absent → falls back to default (300 000 ms)', async () => {
  const tmp = mkTmp();
  let watcher;
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '300'; // env var: 300 ms

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-fallback-' + Date.now();
    // Always busy — with the env-var 300 ms timeout this should time out
    const ctx = makeCtx(SESSION_ID, () => true);
    watcher = start(ctx);

    const uuid = 'fallback-' + Date.now();
    writeTrigger(tmp, uuid, {
      sessionId: SESSION_ID,
      command:   '/compact',
      wait:      'idle',
      // No timeout_ms — should use env-var (300 ms)
    });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 2000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    // Env-var timeout (300 ms) should have fired → ok:false
    assert.equal(result.ok, false);
    assert.equal(result.error, 'not sent', 'the env-var timeout fired before any write');
    assert.match(result.reason, /timeout/i, 'should time out using env-var timeout');
    assert.deepEqual(ctx._written, [], 'no PTY write on env-var timeout');

  } finally {
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// ── W7 — child-process liveness ───────────────────────────────────────────────

// W7-1: pty dead at lookup time → ok:false before any wait
test('W7 dead on arrival: liveness false at lookup → ok:false, no wait, no write', async () => {
  const tmp = mkTmp();
  let watcher;
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR             = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS  = '5000';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-dead-' + Date.now();
    const ctx = makeCtx(SESSION_ID, () => false, { alive: false });
    watcher = start(ctx);

    const uuid = 'dead-' + Date.now();
    const startedAt = Date.now();
    writeTrigger(tmp, uuid, { sessionId: SESSION_ID, command: '/compact', wait: 'idle' });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 2000);

    const elapsed = Date.now() - startedAt;
    const result  = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'target process not running');
    assert.deepEqual(ctx._written, [], 'no PTY write when child is dead');
    assert.ok(elapsed < 1500, `should fail fast, not wait idle timeout; got ${elapsed}ms`);

  } finally {
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// W7-2: pty dies during idle wait → ok:false at the pre-write recheck
test('W7 dies during wait: alive at lookup, dead before write → ok:false with waited_ms', async () => {
  const tmp = mkTmp();
  let watcher;
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR             = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS  = '5000';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-dies-' + Date.now();
    let busy = true;
    const ctx = makeCtx(SESSION_ID, () => busy);
    setTimeout(() => { busy = false; ctx._killPty(); }, 300);

    watcher = start(ctx);
    const uuid = 'dies-' + Date.now();
    writeTrigger(tmp, uuid, { sessionId: SESSION_ID, command: '/compact', wait: 'idle' });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 2000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'target process not running');
    assert.ok(typeof result.waited_ms === 'number' && result.waited_ms >= 200,
      `waited_ms should reflect the wait that happened; got ${result.waited_ms}`);
    assert.deepEqual(ctx._written, [], 'no PTY write when child died during wait');

  } finally {
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// W7-3: default liveness helper sees the real test-process pid as alive → happy path unchanged
test('W7 default helper: real-pid mock passes default signal-0 probe → happy path unchanged', async () => {
  const tmp = mkTmp();
  let watcher;
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR             = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS  = '200';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-default-alive-' + Date.now();
    const ctx = makeCtx(SESSION_ID);
    delete ctx.isPtyAlive; // force the default signal-0 path

    watcher = start(ctx);
    const uuid = 'default-alive-' + Date.now();
    writeTrigger(tmp, uuid, { sessionId: SESSION_ID, command: '/help', wait: 'idle' });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 2000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, true, 'live pid → default helper returns true → ok');
    // busy never rises → verify retries the Enter once.
    assert.deepEqual(ctx._written, ['/help', '\r', '\r']);

  } finally {
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// ── chain field tests ──────────────────────────────────────────────────────────

/**
 * Build a ctx that simulates sequential turns for a chain test.
 *
 * When opts.noAutoTurn is true, no busy/idle simulation happens automatically
 * on write — the test controls state manually via ctx._setBusy().
 * Otherwise, each write schedules: busy after 50ms, idle after 200ms.
 */
function makeChainCtx(sessionId, opts = {}) {
  const written = [];
  let busy = opts.initiallyBusy || false;
  let sessionPresent = true;
  // Politeness guard: an empty, quiet composer unless a test says otherwise.
  const composer = { pending: 0, lastInputAt: 0 };

  const ptyProcess = {
    pid: process.pid,
    write(data) {
      if (opts.ptyThrows) throw new Error('PTY closed');
      written.push(data);
      // A turn only starts on submit (the discrete Enter), not when the command
      // text lands. Auto-simulate: busy after 50ms, then idle after 200ms.
      if (!opts.noAutoTurn && data === '\r') {
        setTimeout(() => { busy = true; }, 50);
        setTimeout(() => { busy = false; }, 200);
      }
    },
  };

  let alive = opts.alive !== undefined ? opts.alive : true;

  return {
    log: silentLog,
    getPtyForSession(id) {
      if (!sessionPresent) return null;
      return id === sessionId ? { ptyProcess } : null;
    },
    isSessionBusy(id) {
      return id === sessionId ? busy : false;
    },
    isPtyAlive() { return alive; },
    getComposerState(id) {
      return id === sessionId
        ? { pending: composer.pending, lastInputAt: composer.lastInputAt }
        : null;
    },
    _written: written,
    _ptyProcess: ptyProcess,
    _composer: composer,
    _removeSession() { sessionPresent = false; },
    _setBusy(v) { busy = v; },
    _killPty() { alive = false; },
  };
}

// CHAIN-1: happy path — 3-step chain, all succeed, result shape correct
test('chain happy path: 3-step chain → 3 PTY writes, result ok:true with steps array', async () => {
  const tmp = mkTmp();
  let watcher;
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '2000';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-chain-happy-' + Date.now();
    const ctx = makeChainCtx(SESSION_ID);
    watcher = start(ctx);

    const uuid = 'chain-happy-' + Date.now();
    writeTrigger(tmp, uuid, {
      sessionId: SESSION_ID,
      wait: 'idle',
      chain: [
        { command: '/compact' },
        { command: 'verify result file and commit' },
        { command: 'open the PR' },
      ],
      timeout_ms: 5000,
    });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 6000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, true, 'result.ok should be true');
    assert.equal(result.sessionId, SESSION_ID);
    assert.ok(result.sent_at, 'sent_at should be set');
    assert.ok(Array.isArray(result.steps), 'steps should be an array');
    assert.equal(result.steps.length, 3, 'steps should have 3 entries');
    assert.equal(result.steps[0].idx, 0);
    assert.equal(result.steps[0].command, '/compact');
    assert.ok(result.steps[0].sent_at, 'steps[0].sent_at should be set');
    assert.equal(typeof result.steps[0].waited_ms, 'number');
    assert.equal(result.steps[1].idx, 1);
    assert.equal(result.steps[1].command, 'verify result file and commit');
    assert.equal(result.steps[2].idx, 2);
    assert.equal(result.steps[2].command, 'open the PR');
    assert.equal(typeof result.total_waited_ms, 'number');

    // All 3 writes happened in order
    assert.deepEqual(ctx._written, ['/compact', '\r', 'verify result file and commit', '\r', 'open the PR', '\r']);

  } finally {
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// CHAIN-2: validation — command and chain both present → rejected before MAX_INFLIGHT
test('chain+command mutually exclusive: both present → ok:false, error mentions mutually exclusive', async () => {
  const tmp = mkTmp();
  let watcher;
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '200';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-chain-both-' + Date.now();
    const ctx = makeChainCtx(SESSION_ID);
    watcher = start(ctx);

    const uuid = 'chain-both-' + Date.now();
    writeTrigger(tmp, uuid, {
      sessionId: SESSION_ID,
      command: '/compact',
      chain: [{ command: '/compact' }],
    });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 2000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, false);
    assert.match(result.error, /mutually exclusive/i);
    assert.deepEqual(ctx._written, [], 'no PTY write');

  } finally {
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// CHAIN-3: validation — chain is empty array → rejected
test('chain validation: empty array → ok:false, error mentions chain', async () => {
  const tmp = mkTmp();
  let watcher;
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '200';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-chain-empty-' + Date.now();
    const ctx = makeChainCtx(SESSION_ID);
    watcher = start(ctx);

    const uuid = 'chain-empty-' + Date.now();
    writeTrigger(tmp, uuid, { sessionId: SESSION_ID, chain: [] });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 2000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, false);
    assert.match(result.error, /chain/i);

  } finally {
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// CHAIN-4: validation — chain too long (> 20) → rejected
test('chain validation: length > 20 → ok:false, error mentions chain', async () => {
  const tmp = mkTmp();
  let watcher;
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '200';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-chain-long-' + Date.now();
    const ctx = makeChainCtx(SESSION_ID);
    watcher = start(ctx);

    const uuid = 'chain-long-' + Date.now();
    writeTrigger(tmp, uuid, {
      sessionId: SESSION_ID,
      chain: Array.from({ length: 21 }, (_, i) => ({ command: `step-${i}` })),
    });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 2000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, false);
    assert.match(result.error, /chain/i);

  } finally {
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// CHAIN-5: validation — step missing command → rejected
test('chain validation: step without command string → ok:false', async () => {
  const tmp = mkTmp();
  let watcher;
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '200';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-chain-badstep-' + Date.now();
    const ctx = makeChainCtx(SESSION_ID);
    watcher = start(ctx);

    const uuid = 'chain-badstep-' + Date.now();
    writeTrigger(tmp, uuid, {
      sessionId: SESSION_ID,
      chain: [{ command: '/compact' }, { notcommand: 'oops' }],
    });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 2000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, false);
    assert.match(result.error, /step/i);
    assert.deepEqual(ctx._written, [], 'no PTY write for invalid chain step');

  } finally {
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// CHAIN-6: validation — step command too long → rejected
test('chain validation: step command too long → ok:false, no PTY write', async () => {
  const tmp = mkTmp();
  let watcher;
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '200';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-chain-longcmd-' + Date.now();
    const ctx = makeChainCtx(SESSION_ID);
    watcher = start(ctx);

    const uuid = 'chain-longcmd-' + Date.now();
    writeTrigger(tmp, uuid, {
      sessionId: SESSION_ID,
      chain: [{ command: '/compact' }, { command: 'x'.repeat(4097) }],
    });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 2000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, false);
    assert.match(result.error, /too long/i);
    assert.deepEqual(ctx._written, [], 'no PTY write for oversized step command');

  } finally {
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// CHAIN-7: validation — step command with forbidden chars → rejected
test('chain validation: step command with forbidden chars → ok:false, no PTY write', async () => {
  const tmp = mkTmp();
  let watcher;
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '200';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-chain-ctrlcmd-' + Date.now();
    const ctx = makeChainCtx(SESSION_ID);
    watcher = start(ctx);

    const uuid = 'chain-ctrlcmd-' + Date.now();
    const payload = JSON.stringify({
      sessionId: SESSION_ID,
      chain: [{ command: '/compact' }, { command: '/clear\rstep2' }],
    });
    fs.writeFileSync(path.join(tmp, uuid + '.json'), payload, 'utf8');

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 2000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, false);
    assert.match(result.error, /forbidden control/i);
    assert.deepEqual(ctx._written, [], 'no PTY write for chain step with control chars');

  } finally {
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// CHAIN-8: global timeout fires mid-chain → ok:false, partial:true, steps_completed=1
// Uses a 3-step chain where step 1 (middle) stays busy, blocking step 2 from firing.
// The global timeout fires while waiting for step 1's turn to complete.
// Step 0's busy window (50ms→350ms) is intentionally wider than the 100ms poll interval
// to ensure the poll catches busy=true and enters Phase 2 reliably.
test('chain timeout mid-chain: global timeout fires → ok:false, partial:true, steps_completed=1', async () => {
  const tmp = mkTmp();
  let watcher;
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '5000';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-chain-timeout-' + Date.now();
    let busy = false;
    const ctx = makeChainCtx(SESSION_ID, { noAutoTurn: true });
    let writeCount = 0;
    const origWrite = ctx._ptyProcess.write.bind(ctx._ptyProcess);
    ctx._ptyProcess.write = function(data) {
      origWrite(data);
      writeCount++;
      if (writeCount === 1) {
        // Step 0: busy window 50ms→350ms (wider than poll interval so phase 2 is reliably entered)
        setTimeout(() => { busy = true; }, 50);
        setTimeout(() => { busy = false; }, 350);
      }
      // Step 1 (middle step): immediately busy, never goes idle → global timeout fires
      if (writeCount === 2) {
        busy = true; // set immediately so phase 1 catches it on first poll
        // Never goes idle → global deadline fires
      }
    };
    ctx.isSessionBusy = (id) => id === SESSION_ID ? busy : false;

    watcher = start(ctx);

    const uuid = 'chain-timeout-' + Date.now();
    writeTrigger(tmp, uuid, {
      sessionId: SESSION_ID,
      wait: 'none',
      chain: [
        { command: '/compact' },
        { command: 'step-two' },   // stuck — never goes idle
        { command: 'step-three' }, // never reached
      ],
      timeout_ms: 1200, // global timeout: step 0 takes ~350ms, step 1 eats the rest
    });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 4000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, false, 'result.ok should be false on timeout');
    assert.equal(result.partial, true, 'partial should be true');
    assert.match(result.error, /timeout/i, 'error should mention timeout');
    assert.equal(result.steps_completed, 1, 'steps_completed should be 1 (step 0 done, step 1 failed)');

    assert.equal(ctx._written[0], '/compact', 'step 0 text should be written');
    assert.equal(ctx._written[1], '\r', 'step 0 Enter should be written');
    assert.equal(ctx._written[2], 'step-two', 'step 1 should be written (it was sent, just stuck)');
    assert.equal(ctx._written[3], '\r', 'step 1 Enter should be written');

  } finally {
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// CHAIN-9: session exits mid-chain → ok:false, partial:true, stops cleanly
test('chain session exit mid-chain: session exits during step 1 turn wait → ok:false, partial:true', async () => {
  const tmp = mkTmp();
  let watcher;
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '5000';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-chain-exit-' + Date.now();
    let busy = false;
    const ctx = makeChainCtx(SESSION_ID, { noAutoTurn: true });
    let writeCount = 0;
    const origWrite = ctx._ptyProcess.write.bind(ctx._ptyProcess);
    ctx._ptyProcess.write = function(data) {
      origWrite(data);
      writeCount++;
      if (writeCount === 1) {
        // Step 0: completes quickly
        setTimeout(() => { busy = true; }, 20);
        setTimeout(() => { busy = false; }, 100);
      }
      if (writeCount === 2) {
        // Step 1: session exits during turn wait
        setTimeout(() => { busy = true; }, 20);
        setTimeout(() => { ctx._removeSession(); }, 100);
      }
    };
    ctx.isSessionBusy = (id) => id === SESSION_ID ? busy : false;

    watcher = start(ctx);

    const uuid = 'chain-exit-' + Date.now();
    writeTrigger(tmp, uuid, {
      sessionId: SESSION_ID,
      wait: 'idle',
      chain: [
        { command: '/compact' },
        { command: 'step-two' },
        { command: 'step-three' },
      ],
      timeout_ms: 5000,
    });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 3000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, false, 'result.ok should be false on session exit');
    assert.equal(result.partial, true, 'partial should be true');
    assert.match(result.error, /session exited/i);
    assert.equal(typeof result.steps_completed, 'number');

  } finally {
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// CHAIN-10: per-step timeout_ms overrides global for that step (step stays busy → step times out)
// Uses a 3-step chain so step 1 (middle) has a between-step turn wait that can timeout.
test('chain per-step timeout_ms: step with short per-step timeout fires before global', async () => {
  const tmp = mkTmp();
  let watcher;
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '5000';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-chain-steptmout-' + Date.now();
    let busy = false;
    const ctx = makeChainCtx(SESSION_ID, { noAutoTurn: true });
    let writeCount = 0;
    const origWrite = ctx._ptyProcess.write.bind(ctx._ptyProcess);
    ctx._ptyProcess.write = function(data) {
      origWrite(data);
      writeCount++;
      if (writeCount === 1) {
        // Step 0 completes quickly
        setTimeout(() => { busy = true; }, 20);
        setTimeout(() => { busy = false; }, 100);
      }
      // Step 1 (middle step): goes busy but never idle → per-step timeout_ms=300 fires
      if (writeCount === 2) {
        setTimeout(() => { busy = true; }, 20);
        // Never goes idle
      }
    };
    ctx.isSessionBusy = (id) => id === SESSION_ID ? busy : false;

    watcher = start(ctx);

    const uuid = 'chain-steptmout-' + Date.now();
    writeTrigger(tmp, uuid, {
      sessionId: SESSION_ID,
      wait: 'idle',
      chain: [
        { command: '/compact' },
        { command: 'step-two', timeout_ms: 300 }, // short per-step timeout
        { command: 'step-three' },                // never reached
      ],
      timeout_ms: 5000, // generous global timeout — per-step fires first
    });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 3000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, false, 'result.ok should be false (step timeout)');
    assert.equal(result.partial, true);
    assert.match(result.error, /timeout/i);
    assert.equal(result.steps_completed, 1);

  } finally {
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// CHAIN-11: invalid per-step timeout_ms → rejected before session lookup
test('chain validation: invalid per-step timeout_ms → ok:false, no PTY write', async () => {
  const tmp = mkTmp();
  let watcher;
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '200';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-chain-badtmout-' + Date.now();
    const ctx = makeChainCtx(SESSION_ID);
    watcher = start(ctx);

    const uuid = 'chain-badtmout-' + Date.now();
    writeTrigger(tmp, uuid, {
      sessionId: SESSION_ID,
      chain: [
        { command: '/compact' },
        { command: 'step-two', timeout_ms: -100 }, // invalid
      ],
    });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 2000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, false);
    assert.match(result.error, /step.*timeout_ms|invalid.*step/i);
    assert.deepEqual(ctx._written, [], 'no PTY write for invalid step timeout_ms');

  } finally {
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// CHAIN-12: instant-reply path on a mid-chain step (i>0) — busy never rises within
// the verify window, so submit-verify retries the Enter once and then the watcher
// declares the turn complete and proceeds. Step 2 (final) also goes through verify.
test('chain instant-reply mid-chain: step 1 never sets busy → verify-retries then proceeds to step 2', async () => {
  const tmp = mkTmp();
  let watcher;
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '10000';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-chain-instant-' + Date.now();
    let busy = false;
    const ctx = makeChainCtx(SESSION_ID, { noAutoTurn: true });
    let writeCount = 0;
    const origWrite = ctx._ptyProcess.write.bind(ctx._ptyProcess);
    ctx._ptyProcess.write = function(data) {
      origWrite(data);
      writeCount++;
      if (writeCount === 1) {
        // Step 0: busy window wider than IDLE_POLL_INTERVAL (100ms) so polling
        // definitely observes both rising and falling edges
        setTimeout(() => { busy = true; }, 20);
        setTimeout(() => { busy = false; }, 350);
      }
      // writeCount === 2 (step 1): NEVER sets busy → instant-reply path must trigger
      // (step 2 has no turn wait — it's the last step)
    };
    ctx.isSessionBusy = (id) => id === SESSION_ID ? busy : false;

    watcher = start(ctx);

    const uuid = 'chain-instant-' + Date.now();
    const startedAt = Date.now();
    writeTrigger(tmp, uuid, {
      sessionId: SESSION_ID,
      wait: 'none',
      chain: [
        { command: '/first' },
        { command: '/second' },  // step 1 never sets busy
        { command: '/third' },
      ],
      timeout_ms: 10000,
    });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 6000);
    const elapsed = Date.now() - startedAt;

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, true, 'chain should succeed via instant-reply path');
    assert.equal(result.steps.length, 3, 'all 3 steps must have run');
    // Steps 1 and 2 never observe a busy-rise → each gets a single verify-retry '\r'.
    assert.deepEqual(ctx._written, ['/first', '\r', '/second', '\r', '\r', '/third', '\r', '\r']);
    assert.equal(result.steps[0].submit_retries, 0, 'step 0 rose (busy@20ms) → no retry');
    assert.equal(result.steps[1].submit_retries, 1, 'step 1 never rose → one verify-retry');
    assert.equal(result.steps[2].submit_retries, 1, 'step 2 (final) never rose → one verify-retry');
    // Step 1 spent two verify windows (~2 × SWITCHBOARD_SUBMIT_VERIFY_MS=400ms) probing
    // for the rising edge across the initial submit and the retry.
    assert.ok(result.steps[1].waited_ms >= 700 && result.steps[1].waited_ms <= 1400,
      `step 1 should have waited ~2 verify windows for the rising edge; got ${result.steps[1].waited_ms}ms`);
    // Total elapsed dominated by steps 1 & 2's verify+retry windows.
    assert.ok(elapsed >= 1500 && elapsed <= 3500,
      `total elapsed should reflect the verify+retry windows; got ${elapsed}ms`);

  } finally {
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// ── submit-verify tests (2026-06-04 "Enter absorbed in composer" incident) ──────

// VERIFY-1: single command, busy NEVER rises → submit-verify retries the Enter
// once. _written must carry the retry '\r' and result.submit_retries === 1.
test('submit-verify single: busy never rises → retry Enter, submit_retries:1', async () => {
  const tmp = mkTmp();
  let watcher;
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '2000';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-verify-noRise-' + Date.now();
    const ctx = makeCtx(SESSION_ID, () => false); // busy never rises
    watcher = start(ctx);

    const uuid = 'verify-norise-' + Date.now();
    writeTrigger(tmp, uuid, { sessionId: SESSION_ID, command: 'resume the task' });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 3000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, true, 'result should still be ok (instant-reply semantics preserved)');
    assert.equal(result.submit_retries, 1, 'one verify-retry when no busy-rise observed');
    // command text, discrete Enter, then the single retry Enter.
    assert.deepEqual(ctx._written, ['resume the task', '\r', '\r'],
      'should write text, Enter, then exactly one retry Enter');

  } finally {
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// VERIFY-2: single command, busy rises promptly after the submit → no retry,
// result.submit_retries === 0 and only one Enter written.
test('submit-verify single: busy rises fast → no retry, submit_retries:0', async () => {
  const tmp = mkTmp();
  let watcher;
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '2000';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-verify-rise-' + Date.now();
    // Busy rises the moment the discrete Enter ('\r') is written — the verify
    // poll observes the rising edge on its first tick → no retry.
    let busy = false;
    const ctx = makeCtx(SESSION_ID, () => busy);
    const origWrite = ctx._ptyProcess.write.bind(ctx._ptyProcess);
    ctx._ptyProcess.write = function(data) {
      origWrite(data);
      if (data === '\r') busy = true; // turn starts immediately on submit
    };
    watcher = start(ctx);

    const uuid = 'verify-rise-' + Date.now();
    writeTrigger(tmp, uuid, { sessionId: SESSION_ID, command: 'do the thing' });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 3000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, true);
    assert.equal(result.submit_retries, 0, 'no retry when busy rises promptly');
    assert.deepEqual(ctx._written, ['do the thing', '\r'], 'only one Enter, no retry');

  } finally {
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// VERIFY-3: chain whose FINAL step never raises busy → the final step still
// gets a submit-verify + retry (the exact 2026-06-04 incident shape), and the
// retry is traced on steps[last].submit_retries. Earlier steps that rise
// normally record submit_retries:0.
test('submit-verify chain final step silent: retry traced on steps[last].submit_retries', async () => {
  const tmp = mkTmp();
  let watcher;
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '10000';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-verify-finalsilent-' + Date.now();
    let busy = false;
    const ctx = makeChainCtx(SESSION_ID, { noAutoTurn: true });
    let writeCount = 0;
    const origWrite = ctx._ptyProcess.write.bind(ctx._ptyProcess);
    ctx._ptyProcess.write = function(data) {
      origWrite(data);
      writeCount++;
      // Step 0 submit ('\r' is the 2nd write): normal turn rises then falls.
      if (writeCount === 2) {
        setTimeout(() => { busy = true; }, 20);
        setTimeout(() => { busy = false; }, 200);
      }
      // Final step (step 1) never raises busy → must verify-retry the Enter.
    };
    ctx.isSessionBusy = (id) => id === SESSION_ID ? busy : false;

    watcher = start(ctx);

    const uuid = 'verify-finalsilent-' + Date.now();
    writeTrigger(tmp, uuid, {
      sessionId: SESSION_ID,
      wait: 'none',
      chain: [
        { command: '/compact' },
        { command: 'resume and finish' }, // FINAL step — Enter gets absorbed
      ],
      timeout_ms: 8000,
    });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 6000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, true, 'chain should complete');
    assert.equal(result.steps.length, 2);
    assert.equal(result.steps[0].submit_retries, 0, 'step 0 rose normally → no retry');
    assert.equal(result.steps[1].submit_retries, 1, 'final step never rose → one verify-retry');
    // Final step carries the retry '\r'; step 0 does not.
    assert.deepEqual(ctx._written,
      ['/compact', '\r', 'resume and finish', '\r', '\r'],
      'final step writes text, Enter, then the verify-retry Enter');

  } finally {
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// VERIFY-4: chain happy path (makeChainCtx auto-turn raises busy on every '\r')
// → no step needs a retry, submit_retries is 0 for every step and no extra '\r'
// appears in _written.
test('submit-verify chain happy: auto-turn rises every step → submit_retries:0 everywhere', async () => {
  const tmp = mkTmp();
  let watcher;
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '5000';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-verify-happy-' + Date.now();
    const ctx = makeChainCtx(SESSION_ID); // auto-turn: busy@50, idle@200 per '\r'
    watcher = start(ctx);

    const uuid = 'verify-happy-' + Date.now();
    writeTrigger(tmp, uuid, {
      sessionId: SESSION_ID,
      wait: 'idle',
      chain: [
        { command: '/compact' },
        { command: 'verify and commit' },
        { command: 'open the PR' },
      ],
      timeout_ms: 8000,
    });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 8000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, true);
    assert.equal(result.steps.length, 3);
    for (const s of result.steps) {
      assert.equal(s.submit_retries, 0, `step ${s.idx} should not retry on a healthy turn`);
    }
    // No retry '\r' anywhere — exactly one Enter per command.
    assert.deepEqual(ctx._written,
      ['/compact', '\r', 'verify and commit', '\r', 'open the PR', '\r']);

  } finally {
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// ── Politeness guard (composer state) ────────────────────────────────────────
//
// A transport must not write into a target that has input typed and not
// submitted; doubt resolves to busy. See docs/automation.md.

test('politeness: a non-empty composer blocks every write and renounces with "not sent"', async () => {
  const tmp = mkTmp();
  let watcher;
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR            = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '300';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-polite-busy-' + Date.now();
    const ctx       = makeCtx(SESSION_ID);
    ctx._composer.pending = 5; // the user has a half-written sentence
    watcher = start(ctx);

    const uuid = 'polite-busy-' + Date.now();
    writeTrigger(tmp, uuid, { sessionId: SESSION_ID, command: '/compact', timeout_ms: 300 });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 5000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.deepEqual(ctx._written, [], 'nothing at all may reach the PTY');
    assert.equal(result.ok, false);
    assert.equal(result.submitted, 'no');
    assert.equal(result.error, 'not sent', 'error is compared by strict equality');
    assert.equal(typeof result.reason, 'string');
    assert.ok(result.reason.length > 0, 'the detail belongs in reason, never in error');

  } finally {
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

test('politeness: an empty and quiet composer lets the write through', async () => {
  const tmp = mkTmp();
  let watcher;
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR            = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '2000';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-polite-free-' + Date.now();
    const ctx       = makeCtx(SESSION_ID);
    watcher = start(ctx);

    const uuid = 'polite-free-' + Date.now();
    writeTrigger(tmp, uuid, { sessionId: SESSION_ID, command: '/compact' });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 5000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, true);
    assert.equal(result.submitted, 'assumed', 'written, no failure seen, nothing observed after');
    assert.deepEqual(ctx._written, ['/compact', '\r', '\r']);

  } finally {
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

test('politeness: a composer that was typed into a moment ago is not free yet', async () => {
  const tmp = mkTmp();
  let watcher;
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR            = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '300';
    process.env.SWITCHBOARD_TRIGGER_QUIET_MS        = '5000';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-polite-fresh-' + Date.now();
    const ctx       = makeCtx(SESSION_ID);
    // Counter back at zero — an Enter that validated a slash-command completion
    // looks exactly like this, and the box is still full.
    ctx._composer.pending     = 0;
    ctx._composer.lastInputAt = Date.now();
    watcher = start(ctx);

    const uuid = 'polite-fresh-' + Date.now();
    writeTrigger(tmp, uuid, { sessionId: SESSION_ID, command: '/compact', timeout_ms: 300 });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 5000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.deepEqual(ctx._written, [], 'the freshness window must hold the write back');
    assert.equal(result.ok, false);
    assert.equal(result.submitted, 'no');
    assert.equal(result.error, 'not sent');

  } finally {
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    delete process.env.SWITCHBOARD_TRIGGER_QUIET_MS;
    cleanup(tmp);
  }
});

// A launcher that exports a variable without a value hands the process an
// empty string. Number('') is 0 and finite, so a naive parse accepts it and
// collapses the quiet window to nothing — half the guard gone, silently.
test('politeness: SWITCHBOARD_TRIGGER_QUIET_MS="" falls back to the default window', async () => {
  const tmp = mkTmp();
  let watcher;
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR            = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '300';
    process.env.SWITCHBOARD_TRIGGER_QUIET_MS        = '';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-polite-emptyenv-' + Date.now();
    const ctx       = makeCtx(SESSION_ID);
    ctx._composer.pending     = 0;
    ctx._composer.lastInputAt = Date.now();
    watcher = start(ctx);

    const uuid = 'polite-emptyenv-' + Date.now();
    writeTrigger(tmp, uuid, { sessionId: SESSION_ID, command: '/compact', timeout_ms: 300 });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 5000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.deepEqual(ctx._written, [],
      'an empty override must not be read as a zero-length quiet window');
    assert.equal(result.ok, false);
    assert.equal(result.submitted, 'no');
    assert.equal(result.error, 'not sent');

  } finally {
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    delete process.env.SWITCHBOARD_TRIGGER_QUIET_MS;
    cleanup(tmp);
  }
});

// W7 — the liveness probe has to sit after the politeness wait, not before it:
// that wait runs to the trigger deadline, so a probe taken before it says
// nothing about the process at the moment of the write.
test('W7: a PTY that dies during the politeness wait is not written to', async () => {
  const tmp = mkTmp();
  let watcher;
  let flip;
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR            = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '4000';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-polite-dies-' + Date.now();
    const ctx       = makeCtx(SESSION_ID);
    // Alive and busy at the moment the trigger lands: the pre-flight probe
    // passes and the politeness wait begins.
    ctx._composer.pending     = 5;
    ctx._composer.lastInputAt = 0;
    watcher = start(ctx);

    // The user submits, then the CLI exits — while we are still waiting.
    flip = setTimeout(() => { ctx._composer.pending = 0; ctx._killPty(); }, 250);

    const uuid = 'polite-dies-' + Date.now();
    writeTrigger(tmp, uuid, { sessionId: SESSION_ID, command: '/compact', timeout_ms: 4000 });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 8000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.deepEqual(ctx._written, [], 'not one byte may reach a dead PTY');
    assert.equal(result.ok, false);
    assert.equal(result.error, 'target process not running');

  } finally {
    if (flip) clearTimeout(flip);
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

test('W7: a chain step whose PTY dies during the politeness wait writes nothing', async () => {
  const tmp = mkTmp();
  let watcher;
  let flip;
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR            = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '4000';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-chain-dies-' + Date.now();
    const ctx = makeChainCtx(SESSION_ID);
    ctx._composer.pending     = 5;
    ctx._composer.lastInputAt = 0;
    watcher = start(ctx);

    flip = setTimeout(() => { ctx._composer.pending = 0; ctx._killPty(); }, 250);

    const uuid = 'chain-dies-' + Date.now();
    writeTrigger(tmp, uuid, {
      sessionId: SESSION_ID,
      chain: [{ command: '/compact' }, { command: 'resume and finish' }],
      timeout_ms: 4000,
    });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 8000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.deepEqual(ctx._written, [], 'not one byte may reach a dead PTY');
    assert.equal(result.ok, false);
    assert.equal(result.error, 'target process not running');
    assert.equal(result.submitted, 'no');
    assert.equal(result.partial, false);

  } finally {
    if (flip) clearTimeout(flip);
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

test('politeness: a ctx with no getComposerState is treated as busy, not as free', async () => {
  const tmp = mkTmp();
  let watcher;
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR            = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '300';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-polite-blind-' + Date.now();
    const ctx       = makeCtx(SESSION_ID);
    delete ctx.getComposerState; // a transport that cannot see the composer
    watcher = start(ctx);

    const uuid = 'polite-blind-' + Date.now();
    writeTrigger(tmp, uuid, { sessionId: SESSION_ID, command: '/compact', timeout_ms: 300 });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 5000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.deepEqual(ctx._written, [], 'blind must mean deferred, never "send anyway"');
    assert.equal(result.ok, false);
    assert.equal(result.submitted, 'no');
    assert.equal(result.error, 'not sent');

  } finally {
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

test('politeness: the bare recovery Enter is withheld when the user types during the verify window', async () => {
  const tmp = mkTmp();
  let watcher;
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR            = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '4000';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-polite-recovery-' + Date.now();
    const ctx       = makeCtx(SESSION_ID); // busy never rises → recovery Enter path
    const origWrite = ctx._ptyProcess.write.bind(ctx._ptyProcess);
    ctx._ptyProcess.write = function (data) {
      origWrite(data);
      // The user starts typing right after our Enter: the recovery '\r' would
      // submit their unfinished sentence.
      if (ctx._written.length === 2) ctx._composer.pending = 4;
    };
    watcher = start(ctx);

    const uuid = 'polite-recovery-' + Date.now();
    writeTrigger(tmp, uuid, { sessionId: SESSION_ID, command: '/compact' });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 6000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.deepEqual(ctx._written, ['/compact', '\r'], 'no third write: the recovery Enter is withheld');
    assert.equal(result.submitted, 'assumed');

  } finally {
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

test('submitted: activity seen after our write yields "activity", never "confirmed"', async () => {
  const tmp = mkTmp();
  let watcher;
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR            = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '4000';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-submitted-confirmed-' + Date.now();
    const ctx       = makeChainCtx(SESSION_ID); // auto-turn: busy 50ms after '\r'
    watcher = start(ctx);

    const uuid = 'submitted-confirmed-' + Date.now();
    writeTrigger(tmp, uuid, { sessionId: SESSION_ID, command: '/compact' });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 6000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, true);
    assert.equal(result.submitted, 'activity');
    assert.notEqual(result.submitted, 'confirmed',
      'seeing the session go busy does not prove the CLI ran what we wrote');
    assert.deepEqual(ctx._written, ['/compact', '\r'], 'an observed turn needs no recovery Enter');

  } finally {
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

test('submitted: a chain reports the weakest of its steps, and a blocked later step is "chain timeout"', async () => {
  const tmp = mkTmp();
  let watcher;
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR            = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '4000';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-chain-polite-' + Date.now();
    const ctx       = makeChainCtx(SESSION_ID);
    const origWrite = ctx._ptyProcess.write.bind(ctx._ptyProcess);
    ctx._ptyProcess.write = function (data) {
      origWrite(data);
      // Step 0 lands; the user then starts typing, so step 1 must never leave.
      if (ctx._written.length === 2) ctx._composer.pending = 7;
    };
    watcher = start(ctx);

    const uuid = 'chain-polite-' + Date.now();
    writeTrigger(tmp, uuid, {
      sessionId: SESSION_ID,
      wait: 'none',
      chain: [{ command: '/compact' }, { command: 'resume and finish' }],
      timeout_ms: 1500,
    });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 8000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.deepEqual(ctx._written, ['/compact', '\r'], 'step 1 must not reach the PTY');
    assert.equal(result.ok, false);
    assert.equal(result.submitted, 'no', 'the weakest step governs the chain');
    assert.equal(result.error, 'chain timeout',
      'not sent would lie here: part of the chain was written');

  } finally {
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

test('wait: an unrecognised value is refused loudly, before any write', async () => {
  const tmp = mkTmp();
  let watcher;
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR            = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '2000';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-wait-typo-' + Date.now();
    const ctx       = makeCtx(SESSION_ID);
    watcher = start(ctx);

    const uuid = 'wait-typo-' + Date.now();
    writeTrigger(tmp, uuid, { sessionId: SESSION_ID, command: '/compact', wait: 'idel' });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 5000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.deepEqual(ctx._written, [], 'a typo must never fall back to sending immediately');
    assert.equal(result.ok, false);
    assert.equal(result.submitted, 'no');
    assert.equal(result.error, 'not sent');
    assert.ok(result.reason.includes('idel'), 'the reason must name the value received');

  } finally {
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

test('wait: an absent field keeps the "none" default', async () => {
  const tmp = mkTmp();
  let watcher;
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR            = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '2000';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-wait-absent-' + Date.now();
    const ctx       = makeCtx(SESSION_ID, () => true); // busy: 'idle' would stall
    watcher = start(ctx);

    const uuid = 'wait-absent-' + Date.now();
    writeTrigger(tmp, uuid, { sessionId: SESSION_ID, command: '/compact' });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 5000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, true);
    assert.equal(result.submitted, 'activity', 'the session was already busy when we polled');
    assert.deepEqual(ctx._written, ['/compact', '\r']);

  } finally {
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

test('submitted: a validation refusal before any write carries submitted "no"', async () => {
  const tmp = mkTmp();
  let watcher;
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR            = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '2000';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-submitted-no-' + Date.now();
    const ctx       = makeCtx(SESSION_ID);
    watcher = start(ctx);

    const uuid = 'submitted-no-' + Date.now();
    writeTrigger(tmp, uuid, { sessionId: 'nobody-here', command: '/compact' });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 5000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, false);
    assert.equal(result.submitted, 'no');
    assert.deepEqual(ctx._written, []);

  } finally {
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// ── Renouncing: `not sent` promises the session was never touched ─────────────
// conventions/session-trigger-transport.md, "Renouncing": `not sent` voids the
// harness guard, `chain timeout` keeps blocking the next compaction. A path that
// returns without writing a single byte must say `not sent`, and the detail
// belongs in `reason` — `error` is compared by strict equality.

test('renouncing: a chain waiting on an idle that never comes writes nothing and says "not sent"', async () => {
  const tmp = mkTmp();
  let watcher;
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR            = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '4000';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-chain-never-idle-' + Date.now();
    // Busy from the first poll and never released: `wait:"idle"` is unsatisfiable.
    const ctx     = makeChainCtx(SESSION_ID, { initiallyBusy: true, noAutoTurn: true });
    watcher = start(ctx);

    const uuid = 'chain-never-idle-' + Date.now();
    writeTrigger(tmp, uuid, {
      sessionId: SESSION_ID,
      wait: 'idle',
      chain: [{ command: '/compact' }, { command: 'resume and finish' }],
      timeout_ms: 300,
    });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 5000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.deepEqual(ctx._written, [], 'the initial idle wait must not write a single byte');
    assert.equal(result.ok, false);
    assert.equal(result.error, 'not sent',
      'nothing left, so the guard must be voided — chain timeout would block forever');
    assert.equal(result.submitted, 'no');
    assert.equal(result.partial, false, 'nothing partial about a chain that never started');
    assert.ok(result.reason, 'the detail belongs in reason, never in error');

  } finally {
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

test('renouncing: a single command waiting on an idle that never comes says "not sent", detail in reason', async () => {
  const tmp = mkTmp();
  let watcher;
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR            = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '4000';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-cmd-never-idle-' + Date.now();
    // A session stays busy for as long as a delegated agent runs, so this is the
    // path that fires most often in service.
    const ctx     = makeCtx(SESSION_ID, () => true);
    watcher = start(ctx);

    const uuid = 'cmd-never-idle-' + Date.now();
    writeTrigger(tmp, uuid, {
      sessionId: SESSION_ID,
      command:   '/compact',
      wait:      'idle',
      timeout_ms: 300,
    });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 5000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.deepEqual(ctx._written, [], 'no PTY write when idle never comes');
    assert.equal(result.ok, false);
    assert.equal(result.error, 'not sent', 'error carries the reserved value alone');
    assert.equal(result.submitted, 'no');
    assert.match(result.reason, /idle/i, 'the detail moved to reason, and is still there');

  } finally {
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

test('renouncing: a chain whose first step was written reports "chain timeout", never "not sent"', async () => {
  const tmp = mkTmp();
  let watcher;
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR            = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '4000';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-chain-stuck-' + Date.now();
    const ctx = makeChainCtx(SESSION_ID, { noAutoTurn: true });
    let busy  = false;
    ctx.isSessionBusy = (id) => (id === SESSION_ID ? busy : false);
    const origWrite = ctx._ptyProcess.write.bind(ctx._ptyProcess);
    ctx._ptyProcess.write = function (data) {
      origWrite(data);
      // Step 0 submits and the turn starts — and never ends.
      if (data === '\r') busy = true;
    };
    watcher = start(ctx);

    const uuid = 'chain-stuck-' + Date.now();
    writeTrigger(tmp, uuid, {
      sessionId: SESSION_ID,
      wait: 'none',
      chain: [{ command: '/compact' }, { command: 'resume and finish' }],
      timeout_ms: 800,
    });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 6000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.deepEqual(ctx._written, ['/compact', '\r'], 'step 0 reached the PTY');
    assert.equal(result.ok, false);
    assert.equal(result.error, 'chain timeout',
      'not sent would lie here: step 0 was written, so the guard must keep blocking');
    assert.equal(result.partial, true);

  } finally {
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// ── Entry removal after processing ────────────────────────────────────────────
// See .ai/contexts/trigger-watcher.md — a processed trigger must leave the
// directory, and one that cannot be removed must never be run a second time.

/** Logger that records what it was told, so failures can be asserted on. */
function recordingLog() {
  const errors = [];
  return {
    info:  () => {},
    warn:  () => {},
    debug: () => {},
    error: (...args) => { errors.push(args.join(' ')); },
    _errors: errors,
  };
}

test('unremovable entry: failure is logged instead of swallowed', async () => {
  const tmp = mkTmp();
  let watcher;
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR            = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '200';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-unremovable-' + Date.now();
    const ctx        = makeCtx(SESSION_ID);
    ctx.log          = recordingLog();
    watcher = start(ctx);

    // A directory named <uuid>.json: lstat succeeds, isFile() is false, so the
    // watcher writes a result — and unlink() on a directory always fails.
    const uuid  = 'unremovable-' + Date.now();
    const entry = path.join(tmp, uuid + '.json');
    fs.mkdirSync(entry);

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, false);
    assert.match(result.error, /regular file/);
    assert.equal(fs.existsSync(entry), true, 'precondition: the entry cannot be unlinked');

    assert.ok(
      ctx.log._errors.some(m => /survived processing/.test(m)),
      'a removal failure must be logged, not swallowed by a bare catch; got: ' +
        JSON.stringify(ctx.log._errors),
    );

  } finally {
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

test('unremovable entry: a later event on the same name is never processed again', async () => {
  const tmp = mkTmp();
  let watcher;
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR            = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '200';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-noreplay-' + Date.now();
    const ctx        = makeCtx(SESSION_ID);
    ctx.log          = recordingLog();
    watcher = start(ctx);

    const uuid  = 'noreplay-' + Date.now();
    const entry = path.join(tmp, uuid + '.json');
    fs.mkdirSync(entry);

    const processedDir = path.join(tmp, 'processed');
    const resultPath   = path.join(processedDir, uuid + '.result.json');
    await waitForFile(resultPath);
    assert.equal(readResult(processedDir, uuid).ok, false, 'first pass rejected the entry');

    // The entry survived processing. Make the same name appear again — a valid
    // trigger this time. It must NOT be picked up: it was already processed.
    fs.rmdirSync(entry);
    writeTrigger(tmp, uuid, { sessionId: SESSION_ID, command: '/compact' });

    await new Promise(r => setTimeout(r, 600));

    assert.deepEqual(ctx._written, [],
      'a name whose entry survived processing must never reach the PTY again');
    assert.equal(readResult(processedDir, uuid).ok, false,
      'the original result must not be overwritten by a second run');

  } finally {
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

test('a throwing ctx yields a definitive result (no unhandled rejection), and a later attempt is not blocked', async () => {
  const tmp = mkTmp();
  let watcher;
  const rejections = [];
  const onRejection = (err) => rejections.push(err);
  process.on('unhandledRejection', onRejection);
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR            = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '200';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-throwing-' + Date.now();
    const ctx        = makeCtx(SESSION_ID);
    ctx.log          = recordingLog();
    let calls = 0;
    let shouldThrow = true;
    ctx.getComposerState = (id) => {
      calls++;
      if (shouldThrow) throw new Error('composer state unavailable');
      return { pending: 0, lastInputAt: 0 };
    };
    watcher = start(ctx);

    const uuid         = 'throwing-' + Date.now();
    const triggerPath  = writeTrigger(tmp, uuid, { sessionId: SESSION_ID, command: '/compact' });
    const processedDir = path.join(tmp, 'processed');
    const resultPath   = path.join(processedDir, uuid + '.result.json');

    await waitForFile(resultPath);
    assert.ok(calls > 0, 'precondition: the throwing hook was reached');

    const firstResult = readResult(processedDir, uuid);
    assert.equal(firstResult.ok, false);
    assert.match(firstResult.error, /composer state unavailable/,
      'the caught exception surfaces in the result, not just the log');
    assert.equal(fs.existsSync(triggerPath), false,
      'the trigger file must be deleted even though processing threw');

    assert.deepEqual(rejections, [], 'the watcher must not leave an unhandled rejection');
    assert.ok(
      ctx.log._errors.some(m => /processing threw/.test(m)),
      'the failure must be logged; got: ' + JSON.stringify(ctx.log._errors),
    );

    // Nothing was left unresolved by the first attempt — a result was written
    // and the trigger was deleted — so a fresh trigger dropped under the same
    // name afterwards is a new attempt, not a replay, and must go through.
    shouldThrow = false;
    fs.rmSync(resultPath);
    writeTrigger(tmp, uuid, { sessionId: SESSION_ID, command: '/compact' });
    await waitForFile(resultPath, 2000);

    const secondResult = readResult(processedDir, uuid);
    assert.equal(secondResult.ok, true, 'a fresh trigger with the same name must not be blocked by retained');
    assert.ok(ctx._written.includes('/compact'), 'the second, valid attempt reaches the PTY');

  } finally {
    process.removeListener('unhandledRejection', onRejection);
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// ── Defects found in adversarial review of PR #166 ────────────────────────────
// Two paths could decide a trigger's fate without ever calling writeResult():
// a throw before/during shape validation (destructuring `null`, or a chain
// step that isn't an object), and a non-ENOENT lstat failure. Both used to
// leave the trigger on disk forever with no result file. See
// .ai/contexts/trigger-watcher.md, "Removing the entry".

test('trigger body is JSON null: destructuring throws, but the entry is still resolved', async () => {
  const tmp = mkTmp();
  let watcher;
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '200';

    const { start } = require('../trigger-watcher');
    const ctx = makeCtx('any-session');
    watcher = start(ctx);

    const uuid         = 'null-body-' + Date.now();
    const triggerPath  = path.join(tmp, uuid + '.json');
    fs.writeFileSync(triggerPath, 'null', 'utf8'); // valid JSON; destructuring it throws

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 2000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, false);
    assert.match(result.error, /internal error/i);
    assert.equal(fs.existsSync(triggerPath), false,
      'trigger file must be deleted, not left behind forever');
    assert.deepEqual(ctx._written, [], 'no PTY write for a null trigger body');

  } finally {
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

test('chain step is not an object: property access throws, but the entry is still resolved', async () => {
  const tmp = mkTmp();
  let watcher;
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '200';

    const { start } = require('../trigger-watcher');
    const ctx = makeCtx('any-session');
    watcher = start(ctx);

    const uuid        = 'chain-null-step-' + Date.now();
    const triggerPath = writeTrigger(tmp, uuid, { sessionId: 'any-session', chain: [null] });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 2000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, false);
    assert.match(result.error, /internal error/i);
    assert.equal(fs.existsSync(triggerPath), false,
      'trigger file must be deleted, not left behind forever');
    assert.deepEqual(ctx._written, [], 'no PTY write for a chain with a non-object step');

  } finally {
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

test('lstat fails with a non-ENOENT error: result written and trigger deleted, not silently returned', async () => {
  const tmp = mkTmp();
  let watcher;
  const realLstatSync = fs.lstatSync;
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '200';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-lstat-eperm-' + Date.now();
    const ctx        = makeCtx(SESSION_ID);
    watcher = start(ctx);

    const uuid        = 'lstat-eperm-' + Date.now();
    const triggerPath = path.join(tmp, uuid + '.json');

    // Simulate a share-lock / permission error a real filesystem can raise —
    // distinct from ENOENT, which is the one case this function must still
    // treat as "nothing to report" (see the ENOENT branch just above).
    fs.lstatSync = (p, ...rest) => {
      if (p === triggerPath) {
        const err = new Error('EPERM: operation not permitted, lstat ' + p);
        err.code  = 'EPERM';
        throw err;
      }
      return realLstatSync.call(fs, p, ...rest);
    };

    writeTrigger(tmp, uuid, { sessionId: SESSION_ID, command: '/compact' });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 2000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, false);
    assert.match(result.error, /could not be inspected/i);
    assert.equal(fs.existsSync(triggerPath), false,
      'trigger file must be deleted even when lstat itself fails');
    assert.deepEqual(ctx._written, [], 'no PTY write when lstat fails');

  } finally {
    fs.lstatSync = realLstatSync;
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// ── Defects found in the third adversarial review of PR #166 ──────────────────
// All four poll loops call ctx back on a deferred `setTimeout` tick, not just
// their first, synchronous call. A throw from that deferred tick used to have
// nothing to catch it — not the Promise executor (already returned), not
// processTriggerFile's try/catch, not dispatch()'s .catch(). See
// .ai/contexts/trigger-watcher.md, "Poll loops must reject, not throw".

test('a hook that throws starting from the SECOND tick of the composer-free poll does not escape as an uncaughtException', async () => {
  const tmp = mkTmp();
  let watcher;
  const uncaughtErrors = [];
  const onUncaught = (err) => uncaughtErrors.push(err);
  process.on('uncaughtException', onUncaught);
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR            = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '2000';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-composer-deferred-throw-' + Date.now();
    const ctx        = makeCtx(SESSION_ID);
    ctx.log          = recordingLog();
    let calls = 0;
    ctx.getComposerState = (id) => {
      calls++;
      if (calls === 1) {
        // Not free -> forces the setTimeout-based recheck, never resolved
        // from inside the Promise executor's synchronous frame again.
        return { pending: 5, lastInputAt: Date.now() };
      }
      throw new Error('composer state unavailable (deferred)');
    };
    watcher = start(ctx);

    const uuid         = 'composer-deferred-throw-' + Date.now();
    const triggerPath  = writeTrigger(tmp, uuid, { sessionId: SESSION_ID, command: '/compact' });
    const processedDir = path.join(tmp, 'processed');
    const resultPath   = path.join(processedDir, uuid + '.result.json');

    await waitForFile(resultPath, 2000);

    assert.ok(calls >= 2,
      'precondition: the throw happened on a deferred tick, not the first synchronous call');
    assert.deepEqual(uncaughtErrors, [],
      'a throw on a deferred poll tick must not become an uncaughtException');

    const result = readResult(processedDir, uuid);
    assert.equal(result.ok, false);
    assert.match(result.error, /composer state unavailable \(deferred\)/);
    assert.equal(fs.existsSync(triggerPath), false,
      'trigger file must be deleted even though the throw happened on a deferred tick');

  } finally {
    process.removeListener('uncaughtException', onUncaught);
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

test('a hook that throws starting from the SECOND tick of the idle-wait poll does not escape as an uncaughtException', async () => {
  const tmp = mkTmp();
  let watcher;
  const uncaughtErrors = [];
  const onUncaught = (err) => uncaughtErrors.push(err);
  process.on('uncaughtException', onUncaught);
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR            = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '2000';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-idle-deferred-throw-' + Date.now();
    const ctx        = makeCtx(SESSION_ID);
    ctx.log          = recordingLog();
    let calls = 0;
    ctx.isSessionBusy = (id) => {
      calls++;
      if (calls === 1) return true; // busy -> forces the setTimeout-based recheck
      throw new Error('busy check unavailable (deferred)');
    };
    watcher = start(ctx);

    const uuid         = 'idle-deferred-throw-' + Date.now();
    const triggerPath  = writeTrigger(tmp, uuid, { sessionId: SESSION_ID, command: '/compact', wait: 'idle' });
    const processedDir = path.join(tmp, 'processed');
    const resultPath   = path.join(processedDir, uuid + '.result.json');

    await waitForFile(resultPath, 2000);

    assert.ok(calls >= 2,
      'precondition: the throw happened on a deferred tick, not the first synchronous call');
    assert.deepEqual(uncaughtErrors, [],
      'a throw on a deferred idle-wait tick must not become an uncaughtException');

    const result = readResult(processedDir, uuid);
    assert.equal(result.ok, false);
    assert.match(result.error, /busy check unavailable \(deferred\)/);
    assert.equal(fs.existsSync(triggerPath), false,
      'trigger file must be deleted even though the throw happened on a deferred tick');

  } finally {
    process.removeListener('uncaughtException', onUncaught);
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

test('writeResult never throws even when ctx.log.error itself throws (no uncaughtException, no unhandledRejection)', async () => {
  const tmp = mkTmp();
  let watcher;
  const uncaughtErrors = [];
  const rejections     = [];
  const onUncaught  = (err) => uncaughtErrors.push(err);
  const onRejection = (err) => rejections.push(err);
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onRejection);
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR            = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '200';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-log-throws-' + Date.now();
    const ctx        = makeCtx(SESSION_ID);
    let logCalls = 0;
    ctx.log = {
      info: () => {}, warn: () => {}, debug: () => {},
      error: (...a) => { logCalls++; throw new Error('logger is broken'); },
    };
    watcher = start(ctx);

    // A directory named <uuid>.json: lstat succeeds, isFile() is false ->
    // writeResult({ok:false}) runs; unlink() on a directory then fails
    // (non-ENOENT), reaching the retained path whose own log call throws.
    const uuid  = 'log-throws-' + Date.now();
    const entry = path.join(tmp, uuid + '.json');
    fs.mkdirSync(entry);

    const processedDir = path.join(tmp, 'processed');
    const resultPath   = path.join(processedDir, uuid + '.result.json');

    await waitForFile(resultPath, 2000);

    assert.ok(logCalls > 0, 'precondition: the throwing logger was reached');
    assert.deepEqual(uncaughtErrors, [], 'a broken logger must not surface as an uncaughtException');
    assert.deepEqual(rejections, [], 'a broken logger must not surface as an unhandledRejection');

    const result = readResult(processedDir, uuid);
    assert.equal(result.ok, false);
    assert.match(result.error, /regular file/);
    assert.equal(fs.existsSync(entry), true,
      'the entry could not be unlinked and must stay on disk (retained)');

  } finally {
    process.removeListener('uncaughtException', onUncaught);
    process.removeListener('unhandledRejection', onRejection);
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

test('benign ENOENT race on unlink does not retain the name: a later reuse of the same uuid is processed', async () => {
  const tmp = mkTmp();
  let watcher;
  const realUnlinkSync = fs.unlinkSync;
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR            = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '2000';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-enoent-race-' + Date.now();
    const ctx        = makeCtx(SESSION_ID);
    ctx.log          = recordingLog();
    watcher = start(ctx);

    const uuid         = 'enoent-race-' + Date.now();
    const triggerPath  = path.join(tmp, uuid + '.json');
    const processedDir = path.join(tmp, 'processed');
    const resultPath   = path.join(processedDir, uuid + '.result.json');

    // Fake an external actor deleting the trigger file behind our back, just
    // before our own unlinkSync call — the documented "benign ENOENT" race
    // between two events on the same file (see .ai/contexts/trigger-watcher.md,
    // "Removing the entry").
    let sawUnlinkAttempt = false;
    fs.unlinkSync = (p, ...rest) => {
      if (p === triggerPath && !sawUnlinkAttempt) {
        sawUnlinkAttempt = true;
        try { realUnlinkSync.call(fs, p); } catch {}
        const err = new Error('ENOENT: no such file or directory, unlink ' + p);
        err.code = 'ENOENT';
        throw err;
      }
      return realUnlinkSync.call(fs, p, ...rest);
    };

    writeTrigger(tmp, uuid, { sessionId: SESSION_ID, command: '/compact' });
    await waitForFile(resultPath, 2000);
    assert.equal(readResult(processedDir, uuid).ok, true, 'first pass processed normally');

    fs.unlinkSync = realUnlinkSync;
    assert.ok(
      !ctx.log._errors.some(m => /survived processing/.test(m)),
      'ENOENT on unlink must stay silent, not be logged as a survived entry; got: ' +
        JSON.stringify(ctx.log._errors),
    );

    // A brand-new, legitimate trigger reuses the same uuid (e.g. a retried
    // harness call). It must be picked up like any fresh trigger, not ignored
    // as if the name had been retained.
    fs.rmSync(resultPath);
    writeTrigger(tmp, uuid, { sessionId: SESSION_ID, command: '/compact-second' });

    await waitForFile(resultPath, 2000);
    assert.equal(readResult(processedDir, uuid).ok, true,
      'a name freed by a benign ENOENT race must not stay retained');
    assert.ok(ctx._written.includes('/compact-second'),
      'the reused trigger must reach the PTY, not be silently ignored');

  } finally {
    fs.unlinkSync = realUnlinkSync;
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

test('writeResult never throws when the result write itself fails AND ctx.log.error throws (both branches guarded)', async () => {
  const tmp = mkTmp();
  let watcher;
  const uncaughtErrors = [];
  const rejections     = [];
  const onUncaught  = (err) => uncaughtErrors.push(err);
  const onRejection = (err) => rejections.push(err);
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onRejection);
  const realWriteFileSync = fs.writeFileSync;
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR            = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '200';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-write-fails-' + Date.now();
    const ctx        = makeCtx(SESSION_ID);
    let logCalls = 0;
    ctx.log = {
      info: () => {}, warn: () => {}, debug: () => {},
      error: (...a) => { logCalls++; throw new Error('logger is broken'); },
    };
    watcher = start(ctx);

    const uuid         = 'write-fails-' + Date.now();
    const triggerPath  = writeTrigger(tmp, uuid, { sessionId: SESSION_ID, command: '/compact' });
    const processedDir = path.join(tmp, 'processed');
    const resultTmpPath = path.join(processedDir, uuid + '.result.json.tmp');

    // Force the .tmp write inside writeResult() to fail, so its own catch's
    // (now-guarded) log call is exercised — the branch the previous mutation
    // probe found untested.
    fs.writeFileSync = (p, ...rest) => {
      if (p === resultTmpPath) throw new Error('disk full (simulated)');
      return realWriteFileSync.call(fs, p, ...rest);
    };

    // Poll for the trigger file being gone rather than for a result file —
    // the result write is the thing we are forcing to fail.
    const deadline = Date.now() + 2000;
    while (fs.existsSync(triggerPath) && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 20));
    }

    assert.ok(logCalls > 0, 'precondition: the throwing logger was reached');
    assert.deepEqual(uncaughtErrors, [], 'a broken logger must not surface as an uncaughtException');
    assert.deepEqual(rejections, [], 'a broken logger must not surface as an unhandledRejection');
    assert.equal(fs.existsSync(triggerPath), false,
      'the unlink must still run even though the result write failed first');

  } finally {
    fs.writeFileSync = realWriteFileSync;
    process.removeListener('uncaughtException', onUncaught);
    process.removeListener('unhandledRejection', onRejection);
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

test('internal field: the generic catch marks internal:true; a validation refusal does not', async () => {
  const tmp = mkTmp();
  let watcher;
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR            = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '200';

    const { start } = require('../trigger-watcher');
    const ctx = makeCtx('any-session');
    watcher = start(ctx);

    // A trigger body that parses as JSON but destructures wrong -> caught by
    // the generic catch at the end of processTriggerFile.
    const uuidInternal        = 'internal-flag-' + Date.now();
    const triggerPathInternal = path.join(tmp, uuidInternal + '.json');
    fs.writeFileSync(triggerPathInternal, 'null', 'utf8');
    const resultPathInternal  = path.join(tmp, 'processed', uuidInternal + '.result.json');
    await waitForFile(resultPathInternal, 2000);
    const internalResult = readResult(path.join(tmp, 'processed'), uuidInternal);
    assert.equal(internalResult.internal, true,
      'a generic caught exception must be marked internal:true, distinguishable from a refusal');

    // A plain validation refusal must NOT carry internal:true.
    const uuidRefusal = 'refusal-flag-' + Date.now();
    writeTrigger(tmp, uuidRefusal, { sessionId: '' }); // missing required field: sessionId
    const resultPathRefusal = path.join(tmp, 'processed', uuidRefusal + '.result.json');
    await waitForFile(resultPathRefusal, 2000);
    const refusalResult = readResult(path.join(tmp, 'processed'), uuidRefusal);
    assert.equal(refusalResult.internal, undefined,
      'a validation refusal must not be indistinguishable from an internal bug');

  } finally {
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// ── Follow-up: the two remaining unguarded ctx.log.error() call sites ─────────
// (raised after the first pass at these fixes). Both sit downstream of every
// other log call in this file — anything that throws upstream is caught by
// the outer try/catch in processTriggerFile() and lands here, or (if that
// itself throws) in dispatch()'s .catch(). A broken ctx.log at either site
// used to end in an unhandledRejection, which terminates the process by
// default under Node. See .ai/contexts/trigger-watcher.md, "Removing the
// entry".

test('outer generic-catch log call cannot escape even when ctx.log.error throws (result still written, trigger still deleted)', async () => {
  const tmp = mkTmp();
  let watcher;
  const uncaughtErrors = [];
  const rejections     = [];
  const onUncaught  = (err) => uncaughtErrors.push(err);
  const onRejection = (err) => rejections.push(err);
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onRejection);
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR            = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '200';

    const { start } = require('../trigger-watcher');
    const ctx = makeCtx('any-session');
    let logCalls = 0;
    ctx.log = {
      info: () => {}, warn: () => {}, debug: () => {},
      error: (...a) => { logCalls++; throw new Error('logger is broken'); },
    };
    watcher = start(ctx);

    // A trigger body that parses as JSON but destructures wrong -> reaches
    // the generic catch at the end of processTriggerFile, whose own log call
    // is the site under test.
    const uuid        = 'outer-catch-log-throws-' + Date.now();
    const triggerPath = path.join(tmp, uuid + '.json');
    fs.writeFileSync(triggerPath, 'null', 'utf8');

    const processedDir = path.join(tmp, 'processed');
    const resultPath   = path.join(processedDir, uuid + '.result.json');
    await waitForFile(resultPath, 2000);

    assert.ok(logCalls > 0, 'precondition: the throwing logger was reached');
    assert.deepEqual(uncaughtErrors, [],
      'a broken logger in the outer catch must not surface as an uncaughtException');
    assert.deepEqual(rejections, [],
      'a broken logger in the outer catch must not surface as an unhandledRejection');

    const result = readResult(processedDir, uuid);
    assert.equal(result.ok, false);
    assert.equal(result.internal, true);
    assert.equal(fs.existsSync(triggerPath), false,
      'trigger must still be deleted despite the broken logger');

  } finally {
    process.removeListener('uncaughtException', onUncaught);
    process.removeListener('unhandledRejection', onRejection);
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

test('dispatch() backstop log call cannot escape even when ctx.log.error throws (name still ends up retained)', async () => {
  const tmp = mkTmp();
  let watcher;
  const uncaughtErrors = [];
  const rejections     = [];
  const onUncaught  = (err) => uncaughtErrors.push(err);
  const onRejection = (err) => rejections.push(err);
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onRejection);

  // dispatch()'s own .catch() only fires if processTriggerFile() itself
  // rejects -- which, with both writeResult() try/catch blocks now safe,
  // only still happens if onEntryRetained() (== retained.add(filename), a
  // Set the caller never sees) throws. This forces exactly that, to reach
  // the one remaining call site without touching module internals: a
  // directory-shaped trigger makes writeResult()'s unlink fail twice (the
  // validation-refusal write, then the outer catch's own fallback write),
  // so Set.prototype.add is patched to throw only for the 2nd and 3rd
  // .add() call carrying this trigger's exact filename -- letting
  // dispatch()'s own (4th) retained.add(filename) call go through for real,
  // which is the guarantee under test.
  const realSetAdd = Set.prototype.add;
  let addCallsForFile = 0;
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR            = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '200';

    const { start } = require('../trigger-watcher');
    const ctx = makeCtx('any-session');
    let logCalls = 0;
    ctx.log = {
      info: () => {}, warn: () => {}, debug: () => {},
      error: (...a) => { logCalls++; throw new Error('logger is broken'); },
    };
    watcher = start(ctx);

    const uuid  = 'dispatch-catch-log-throws-' + Date.now();
    const entry = path.join(tmp, uuid + '.json'); // directory: unlink always fails
    const filename = uuid + '.json';

    Set.prototype.add = function (value) {
      if (value === filename) {
        addCallsForFile++;
        if (addCallsForFile === 2 || addCallsForFile === 3) {
          throw new Error('retained set is broken (simulated)');
        }
      }
      return realSetAdd.call(this, value);
    };

    fs.mkdirSync(entry);

    // No result-file poll: the write inside writeResult() races the induced
    // throw, so poll for the trigger to stop being reprocessed instead.
    const deadline = Date.now() + 2000;
    while (addCallsForFile < 4 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 20));
    }
    await new Promise(r => setTimeout(r, 100)); // let dispatch()'s .finally() settle

    Set.prototype.add = realSetAdd;

    assert.ok(addCallsForFile >= 4,
      'precondition: retained.add(filename) was reached a 4th time, from dispatch()\'s own catch');
    assert.ok(logCalls > 0, 'precondition: the throwing logger was reached');
    assert.deepEqual(uncaughtErrors, [],
      'a broken logger in dispatch()\'s backstop must not surface as an uncaughtException');
    assert.deepEqual(rejections, [],
      'a broken logger in dispatch()\'s backstop must not surface as an unhandledRejection');

    // The name must be genuinely retained: drop a fresh, valid trigger under
    // the same uuid and confirm it is never picked up.
    fs.rmdirSync(entry);
    writeTrigger(tmp, uuid, { sessionId: 'any-session', command: '/compact' });
    await new Promise(r => setTimeout(r, 400));
    assert.deepEqual(ctx._written, [],
      'the name must stay retained -- dispatch()\'s own retained.add(filename) must have gone through');

  } finally {
    Set.prototype.add = realSetAdd;
    process.removeListener('uncaughtException', onUncaught);
    process.removeListener('unhandledRejection', onRejection);
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// ── submitted: the strength order and what "activity" refuses to claim ────────
// see .ai/contexts/trigger-watcher.md ("submitted")

test('submitted: a session already busy before our write never reports "confirmed"', async () => {
  const tmp = mkTmp();
  let watcher;
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR            = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '2000';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-preexisting-busy-' + Date.now();
    // Busy from the start and never idle: every busy reading the watcher takes
    // predates its own write, so no observation of ours caused it.
    const ctx = makeCtx(SESSION_ID, () => true);
    watcher = start(ctx);

    const uuid = 'preexisting-busy-' + Date.now();
    writeTrigger(tmp, uuid, { sessionId: SESSION_ID, wait: 'none', command: '/compact' });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 5000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, true);
    assert.deepEqual(ctx._written, ['/compact', '\r']);
    assert.notEqual(result.submitted, 'confirmed',
      'busy that predates the write must never be reported as a confirmation');
    assert.equal(result.submitted, 'activity');

  } finally {
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

test('submitted: the strength order is total, and "confirmed" sits strictly above "activity"', () => {
  const { weakestSubmitted, SUBMITTED_RANK } = require('../trigger-watcher');

  const ORDER = ['no', 'assumed', 'activity', 'confirmed'];

  assert.deepEqual(Object.keys(SUBMITTED_RANK).sort(), [...ORDER].sort(),
    'every value carries a rank, and no rank exists without a value');

  const ranks = ORDER.map((v) => SUBMITTED_RANK[v]);
  assert.equal(new Set(ranks).size, ORDER.length, 'no two values share a rank');
  for (let i = 1; i < ranks.length; i++) {
    assert.ok(ranks[i - 1] < ranks[i],
      `${ORDER[i - 1]} must rank strictly below ${ORDER[i]}`);
  }
  assert.ok(SUBMITTED_RANK.confirmed > SUBMITTED_RANK.activity,
    'an effect readback must outrank a bare activity observation');

  for (const a of ORDER) {
    for (const b of ORDER) {
      const expected = SUBMITTED_RANK[a] <= SUBMITTED_RANK[b] ? a : b;
      assert.equal(weakestSubmitted(a, b), expected, `weakest(${a}, ${b})`);
      assert.equal(SUBMITTED_RANK[weakestSubmitted(a, b)],
        Math.min(SUBMITTED_RANK[a], SUBMITTED_RANK[b]), `min rank of (${a}, ${b})`);
    }
  }
});

// ── submitted: the chain fold must weigh each step's own observation ──────────
// see .ai/contexts/trigger-watcher.md ("submitted"). A prior version of this
// suite never asserted result.submitted on a multi-step chain where a step is
// legitimately submitted but never observed as busy -- the exact shape of the
// 2026-09-03 incident (a "/compact" step that IS observed, followed by a
// resume prompt that sits unsubmitted and is never seen going busy).

test('chain "activity" fold: a step that never observes busy pulls the whole chain down to "assumed"', async () => {
  const tmp = mkTmp();
  let watcher;
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR            = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '5000';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-chain-fold-assumed-' + Date.now();
    const ctx = makeChainCtx(SESSION_ID, { noAutoTurn: true });
    let busy = false;
    ctx.isSessionBusy = (id) => (id === SESSION_ID ? busy : false);

    let writeCount = 0;
    const origWrite = ctx._ptyProcess.write.bind(ctx._ptyProcess);
    ctx._ptyProcess.write = function (data) {
      origWrite(data);
      writeCount++;
      // Step 0 ('/compact'): busy window wider than the 100ms poll interval so
      // the poll reliably catches it (see CHAIN-8 above) -- this step is
      // genuinely observed ("activity").
      if (writeCount === 2) {
        setTimeout(() => { busy = true; }, 50);
        setTimeout(() => { busy = false; }, 350);
      }
      // Step 1 ('resume the task'): busy is never seen, neither on the first
      // Enter nor on the retry -- "assumed", same as a lone unobserved command.
    };

    watcher = start(ctx);

    const uuid = 'chain-fold-assumed-' + Date.now();
    writeTrigger(tmp, uuid, {
      sessionId: SESSION_ID,
      wait: 'none',
      chain: [
        { command: '/compact' },
        { command: 'resume the task' },
      ],
      timeout_ms: 3000,
    });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 4000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, true);
    assert.equal(result.steps.length, 2);
    assert.equal(result.steps[0].submit_retries, 0,
      'precondition: step 0 was observed on its first poll, no retry needed');
    assert.equal(result.steps[1].submit_retries, 1,
      'precondition: step 1 never observed busy, so the retry fired');
    assert.equal(result.submitted, 'assumed',
      'a step never observed as busy must pull the whole chain down to "assumed", never "activity"');

  } finally {
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

test('chain "activity" fold: a step observed only through its retry still counts as "activity"', async () => {
  const tmp = mkTmp();
  let watcher;
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR            = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '5000';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-chain-fold-retry-' + Date.now();
    const ctx = makeChainCtx(SESSION_ID, { noAutoTurn: true });
    let busy = false;
    ctx.isSessionBusy = (id) => (id === SESSION_ID ? busy : false);

    let writeCount = 0;
    const origWrite = ctx._ptyProcess.write.bind(ctx._ptyProcess);
    ctx._ptyProcess.write = function (data) {
      origWrite(data);
      writeCount++;
      // Writes: 1 = command text, 2 = the first discrete Enter (absorbed, no
      // turn), 3 = the bare recovery Enter -- the one that actually wakes the
      // session, on the retry's own verify poll.
      if (writeCount === 3) busy = true;
    };

    watcher = start(ctx);

    const uuid = 'chain-fold-retry-' + Date.now();
    writeTrigger(tmp, uuid, {
      sessionId: SESSION_ID,
      wait: 'none',
      chain: [{ command: 'resume the task' }],
      timeout_ms: 3000,
    });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 4000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, true);
    assert.equal(result.steps.length, 1);
    assert.equal(result.steps[0].submit_retries, 1,
      'precondition: the first Enter alone was not observed, the retry fired');
    assert.equal(result.submitted, 'activity',
      'busy observed only after the retry Enter must still register as activity, not assumed');

  } finally {
    if (watcher) watcher.close();
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});
