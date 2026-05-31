// test/trigger-watcher.test.js — node:test suite for trigger-watcher.js
//
// Strategy: real fs in a mkdtemp sandbox, env vars override dirs + timeouts.
// No mocks — ctx provides a concrete in-memory PTY stand-in.
'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

// ── Helpers ───────────────────────────────────────────────────────────────────

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sw-trigger-'));
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
 */
function makeCtx(sessionId, isBusyFn = () => false) {
  const written = [];
  const ptyProcess = {
    write(data) { written.push(data); },
  };

  return {
    log: silentLog,
    getPtyForSession(id) {
      return id === sessionId ? { ptyProcess } : null;
    },
    isSessionBusy(id) {
      return id === sessionId ? isBusyFn() : false;
    },
    _written: written,
    _ptyProcess: ptyProcess,
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
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '200';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-happy-' + Date.now();
    const ctx        = makeCtx(SESSION_ID);
    const watcher    = start(ctx);

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

    // pty.write called with command + \r
    assert.deepEqual(ctx._written, ['/compact\r'], 'pty.write called with command + \\r');

    // Trigger file deleted
    assert.equal(fs.existsSync(triggerPath), false, 'trigger file should be deleted');

    watcher.close();
  } finally {
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

test('unknown sessionId: result ok:false with session not found, no PTY write', async () => {
  const tmp = mkTmp();
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '200';

    const { start } = require('../trigger-watcher');
    const ctx        = makeCtx('real-session');
    const watcher    = start(ctx);

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

    watcher.close();
  } finally {
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

test('malformed JSON: result ok:false with error, trigger deleted, no PTY write', async () => {
  const tmp = mkTmp();
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '200';

    const { start } = require('../trigger-watcher');
    const ctx        = makeCtx('any-session');
    const watcher    = start(ctx);

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

    watcher.close();
  } finally {
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

test('missing required field (no command): result ok:false, no PTY write', async () => {
  const tmp = mkTmp();
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '200';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-nocommand-' + Date.now();
    const ctx        = makeCtx(SESSION_ID);
    const watcher    = start(ctx);

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

    watcher.close();
  } finally {
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

test('wait:idle while busy → flips to idle after 150ms → write happens, waited_ms >= 150', async () => {
  const tmp = mkTmp();
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '2000'; // generous timeout

    const { start } = require('../trigger-watcher');
    let busy = true;
    const SESSION_ID = 'sess-idle-' + Date.now();
    const ctx = makeCtx(SESSION_ID, () => busy);
    const watcher = start(ctx);

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
    assert.deepEqual(ctx._written, ['/compact\r'], 'PTY write should happen after idle');

    watcher.close();
  } finally {
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

test('wait:idle timeout: busy stays true → ok:false, error contains "timeout", no PTY write', async () => {
  const tmp = mkTmp();
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '200'; // short timeout for test

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-timeout-' + Date.now();
    const ctx = makeCtx(SESSION_ID, () => true); // always busy
    const watcher = start(ctx);

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
    assert.match(result.error, /timeout/i);

    assert.deepEqual(ctx._written, [], 'no PTY write on idle timeout');

    watcher.close();
  } finally {
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});
