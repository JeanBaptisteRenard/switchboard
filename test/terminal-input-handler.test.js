// test/terminal-input-handler.test.js — the IPC handler body for keystrokes,
// exercised as the product function rather than as a copy rewritten here.
'use strict';

process.env.SWITCHBOARD_SUBMIT_ENTER_DELAY_MS = '1';
process.env.SWITCHBOARD_SUBMIT_VERIFY_MS      = '150';
process.env.SWITCHBOARD_TRIGGER_QUIET_MS      = '200';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const { handleTerminalInput } = require('../terminal-input');
const { createTriggerContext } = require('../trigger-context');
const { createComposerState }  = require('../composer-state');

const silentLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function makePty() {
  const written = [];
  return { pid: process.pid, write(d) { written.push(d); }, written };
}

function makeSession(overrides = {}) {
  return {
    pty: makePty(),
    exited: false,
    _cliBusy: false,
    composerState: createComposerState(),
    ...overrides,
  };
}

// ── The handler, on its own ──────────────────────────────────────────────────

test('a keystroke updates the session composer AND reaches the pty', () => {
  const session = makeSession();
  const sessions = new Map([['s1', session]]);

  handleTerminalInput(sessions, 's1', 'hello', 1000);

  assert.equal(session.composerState.pending, 5);
  assert.equal(session.composerState.lastInputAt, 1000);
  assert.deepEqual(session.pty.written, ['hello']);
});

test('an exited session is neither counted nor written to', () => {
  const session = makeSession({ exited: true });
  const sessions = new Map([['s1', session]]);

  handleTerminalInput(sessions, 's1', 'hello', 1000);

  assert.equal(session.composerState.pending, 0);
  assert.equal(session.composerState.lastInputAt, 0);
  assert.deepEqual(session.pty.written, []);
});

test('an unknown session id does not throw', () => {
  const sessions = new Map([['s1', makeSession()]]);
  assert.doesNotThrow(() => handleTerminalInput(sessions, 'ghost', 'hello', 1000));
});

test('a session with no composerState still writes to the pty', () => {
  const session = makeSession({ composerState: undefined });
  const sessions = new Map([['s1', session]]);

  handleTerminalInput(sessions, 's1', 'hello', 1000);

  assert.deepEqual(session.pty.written, ['hello'], 'the guard must not break the terminal');
});

test('Enter clears the pending count and the whole chunk reaches the pty', () => {
  const session = makeSession();
  const sessions = new Map([['s1', session]]);

  handleTerminalInput(sessions, 's1', 'ls -la', 1000);
  handleTerminalInput(sessions, 's1', '\r', 1200);

  assert.equal(session.composerState.pending, 0);
  assert.equal(session.composerState.lastInputAt, 1200);
  assert.deepEqual(session.pty.written, ['ls -la', '\r']);
});

// ── The whole chain: keystrokes → composer → trigger-watcher ─────────────────

function mkTmp() {
  // realpath the sandbox: on Windows os.tmpdir() can be an 8.3 short name and
  // fs.watch on such a path trips a libuv assertion that kills the process.
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sw-tinput-')));
}

function writeTrigger(dir, uuid, payload) {
  fs.writeFileSync(path.join(dir, uuid + '.json'), JSON.stringify(payload), 'utf8');
}

function waitForFile(filePath, maxMs = 8000, pollMs = 20) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + maxMs;
    (function poll() {
      if (fs.existsSync(filePath)) return resolve();
      if (Date.now() >= deadline) return reject(new Error('Timeout waiting for file: ' + filePath));
      setTimeout(poll, pollMs);
    })();
  });
}

function readResult(dir, uuid) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'processed', uuid + '.result.json'), 'utf8'));
}

test('a half-typed sentence refuses the trigger, and a submitted one lets it through', async () => {
  const tmp = mkTmp();
  const previousDir = process.env.SWITCHBOARD_TRIGGERS_DIR;
  process.env.SWITCHBOARD_TRIGGERS_DIR = tmp;

  const SESSION_ID = 'chain-' + Date.now();
  const session    = makeSession();
  const sessions   = new Map([[SESSION_ID, session]]);
  const pty        = session.pty;

  const ctx     = createTriggerContext({
    activeSessions: sessions, log: silentLog, isPtyAlive: () => true,
  });
  const watcher = require('../trigger-watcher').start(ctx);

  try {
    // 1. The user types a sentence and does not submit it.
    handleTerminalInput(sessions, SESSION_ID, 'a plan I am still writing', Date.now());
    assert.ok(session.composerState.pending > 0, 'the sentence must be counted as unsubmitted');
    const afterTyping = pty.written.length;

    const blockedUuid = 'blocked-' + Date.now();
    writeTrigger(tmp, blockedUuid, {
      sessionId: SESSION_ID, command: '/wrap-up', timeout_ms: 400,
    });
    await waitForFile(path.join(tmp, 'processed', blockedUuid + '.result.json'));

    const blocked = readResult(tmp, blockedUuid);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.submitted, 'no');
    assert.equal(blocked.error, 'not sent');
    assert.deepEqual(
      pty.written.slice(afterTyping), [],
      'the watcher must not have written a single byte over the sentence',
    );

    // 2. The user hits Enter; once the quiet window has run out, the trigger passes.
    const enterAt = Date.now();
    handleTerminalInput(sessions, SESSION_ID, '\r', enterAt);
    assert.equal(session.composerState.pending, 0);
    const afterSubmit = pty.written.length;

    const passUuid = 'pass-' + Date.now();
    writeTrigger(tmp, passUuid, {
      sessionId: SESSION_ID, command: '/wrap-up', timeout_ms: 5000,
    });
    await waitForFile(path.join(tmp, 'processed', passUuid + '.result.json'));

    const passed = readResult(tmp, passUuid);
    assert.equal(passed.ok, true, 'a submitted composer is free once the quiet window elapsed');
    assert.notEqual(passed.error, 'not sent');
    assert.deepEqual(
      pty.written.slice(afterSubmit, afterSubmit + 2), ['/wrap-up', '\r'],
      'the command and its discrete Enter reach the pty',
    );
    assert.ok(
      Date.parse(passed.sent_at) - enterAt >= 200,
      'the write landed no sooner than the quiet window after the last keystroke',
    );
  } finally {
    watcher.close();
    if (previousDir === undefined) delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    else process.env.SWITCHBOARD_TRIGGERS_DIR = previousDir;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});
