// test/cli-session-state.test.js — node:test suite for cli-session-state.js
//
// Strategy: real fs.watch in a mkdtemp sandbox, ctx injects the session map,
// the rescan callback and the liveness probe. See
// .ai/contexts/cli-session-state.md
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cliSessionState = require('../cli-session-state');

// Same Windows pitfall as trigger-watcher.test.js: os.tmpdir() can be an 8.3
// short name and fs.watch on one trips a libuv assertion.
function mkTmp() {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sw-cli-state-')));
}

const silentLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

/** Long enough for a watch event plus FLUSH_MS to have gone through. */
const SETTLE_MS = 500;

function writeState(dir, pid, fields) {
  fs.writeFileSync(path.join(dir, `${pid}.json`), JSON.stringify({
    pid,
    sessionId: 'sess-1',
    cwd: dir,
    procStart: '111',
    version: '2.1.241',
    updatedAt: Date.now(),
    statusUpdatedAt: Date.now(),
    ...fields,
  }), 'utf8');
}

function waitFor(fn, maxMs = 4000, pollMs = 20) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    (function poll() {
      if (fn()) return resolve();
      if (Date.now() - start > maxMs) return reject(new Error('timed out waiting for condition'));
      setTimeout(poll, pollMs);
    })();
  });
}

const delay = (ms) => new Promise(r => setTimeout(r, ms));

/** Boot the watcher over `dir` with a spy rescan callback. */
function boot(dir, activeSessions, opts = {}) {
  const rescans = [];
  cliSessionState.init({
    dir,
    activeSessions,
    log: silentLog,
    isProcessAlive: opts.isProcessAlive || (() => true),
    onIdle: (sessionId, session) => rescans.push({ sessionId, session }),
  });
  const attached = cliSessionState.ensureWatching();
  return { rescans, attached };
}

function oneSession(fields = {}) {
  return new Map([['sess-1', { projectFolder: 'folder', ...fields }]]);
}

test.afterEach(() => cliSessionState.stop());

test('a busy → idle transition rescans the matching session immediately', async () => {
  const dir = mkTmp();
  try {
    writeState(dir, 4242, { status: 'busy' });
    const { rescans, attached } = boot(dir, oneSession());
    assert.equal(attached, true, 'the watcher must attach to an existing directory');

    writeState(dir, 4242, { status: 'idle' });
    await waitFor(() => rescans.length === 1);
    assert.equal(rescans[0].sessionId, 'sess-1');
  } finally {
    cliSessionState.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('waiting and shell never rescan — only idle does', async () => {
  // The CLI reports four statuses. Only idle means "the turn is over"; waiting
  // is a permission prompt and shell is a suspended session, both of which can
  // still have live subagents behind them.
  const dir = mkTmp();
  try {
    writeState(dir, 4242, { status: 'busy' });
    const { rescans } = boot(dir, oneSession());

    writeState(dir, 4242, { status: 'waiting' });
    await delay(SETTLE_MS);
    assert.equal(rescans.length, 0, 'waiting must not rescan');

    writeState(dir, 4242, { status: 'shell' });
    await delay(SETTLE_MS);
    assert.equal(rescans.length, 0, 'shell must not rescan');

    // Positive control: the harness is wired, the two silences above were real.
    writeState(dir, 4242, { status: 'idle' });
    await waitFor(() => rescans.length === 1);
  } finally {
    cliSessionState.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a dead pid never rescans', async () => {
  // status is written on change, not on a heartbeat: a killed CLI leaves its
  // last status engraved. Nothing stale may drive a rescan.
  const dir = mkTmp();
  try {
    writeState(dir, 4242, { status: 'busy' });
    const { rescans } = boot(dir, oneSession(), { isProcessAlive: () => false });

    writeState(dir, 4242, { status: 'idle' });
    await delay(SETTLE_MS);
    assert.equal(rescans.length, 0, 'a state file whose process is gone must be inert');
  } finally {
    cliSessionState.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a reused pid is treated as a new process, not as a transition', async () => {
  // <pid>.json is keyed by pid alone. A second CLI landing on the same pid
  // would otherwise read as "the previous process just went idle".
  const dir = mkTmp();
  try {
    writeState(dir, 4242, { status: 'busy', procStart: 'A' });
    const { rescans } = boot(dir, oneSession());

    writeState(dir, 4242, { status: 'idle', procStart: 'B' });
    await delay(SETTLE_MS);
    assert.equal(rescans.length, 0, 'a different procStart is a different process');

    // The new process gets its own baseline, and its own transitions work.
    writeState(dir, 4242, { status: 'busy', procStart: 'B' });
    await delay(SETTLE_MS);
    writeState(dir, 4242, { status: 'idle', procStart: 'B' });
    await waitFor(() => rescans.length === 1);
  } finally {
    cliSessionState.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a truncated or malformed file is ignored without throwing', async () => {
  // The CLI does not write this file atomically, so a read can land mid-write.
  const dir = mkTmp();
  try {
    writeState(dir, 4242, { status: 'busy' });
    const { rescans } = boot(dir, oneSession());

    fs.writeFileSync(path.join(dir, '4242.json'), '{"pid":4242,"status":"id', 'utf8');
    await delay(SETTLE_MS);
    assert.equal(rescans.length, 0, 'a half-written file must not rescan');

    fs.writeFileSync(path.join(dir, '4242.json'), JSON.stringify({ status: 'idle' }), 'utf8');
    await delay(SETTLE_MS);
    assert.equal(rescans.length, 0, 'a file missing pid/sessionId must not rescan');

    writeState(dir, 4242, { status: 'idle' });
    await waitFor(() => rescans.length === 1, 4000);
  } finally {
    cliSessionState.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an unknown status is ignored and does not break the following transition', async () => {
  const dir = mkTmp();
  try {
    writeState(dir, 4242, { status: 'busy' });
    const { rescans } = boot(dir, oneSession());

    writeState(dir, 4242, { status: 'hibernating' });
    await delay(SETTLE_MS);
    assert.equal(rescans.length, 0, 'an unknown status must not rescan');

    writeState(dir, 4242, { status: 'idle' });
    await waitFor(() => rescans.length === 1);
  } finally {
    cliSessionState.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a state file with no matching Switchboard session rescans nothing', async () => {
  const dir = mkTmp();
  try {
    writeState(dir, 4242, { status: 'busy', sessionId: 'somebody-elses-session' });
    const { rescans } = boot(dir, oneSession());

    writeState(dir, 4242, { status: 'idle', sessionId: 'somebody-elses-session' });
    await delay(SETTLE_MS);
    assert.equal(rescans.length, 0, 'an unrelated CLI must not drive our sessions');
  } finally {
    cliSessionState.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a forked session matches on realSessionId, not on its map key', async () => {
  // After a fork the CLI writes the new id while activeSessions is still keyed
  // by the old one — matching on the key alone would silently stop working for
  // every forked or resumed session.
  const dir = mkTmp();
  const activeSessions = new Map([
    ['old-id', { projectFolder: 'folder', realSessionId: 'new-id' }],
  ]);
  try {
    writeState(dir, 4242, { status: 'busy', sessionId: 'new-id' });
    const { rescans } = boot(dir, activeSessions);

    writeState(dir, 4242, { status: 'idle', sessionId: 'new-id' });
    await waitFor(() => rescans.length === 1);
    assert.equal(rescans[0].sessionId, 'new-id',
      'the rescan must target the id the subagent directory is named after');
  } finally {
    cliSessionState.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('exited and plain-terminal sessions are never rescanned', async () => {
  const dir = mkTmp();
  try {
    writeState(dir, 4242, { status: 'busy' });
    const { rescans } = boot(dir, oneSession({ exited: true }));

    writeState(dir, 4242, { status: 'idle' });
    await delay(SETTLE_MS);
    assert.equal(rescans.length, 0, 'an exited session has nothing left to scan');

    cliSessionState.stop();
    const second = boot(dir, oneSession({ isPlainTerminal: true }));
    writeState(dir, 4242, { status: 'busy' });
    await delay(SETTLE_MS);
    writeState(dir, 4242, { status: 'idle' });
    await delay(SETTLE_MS);
    assert.equal(second.rescans.length, 0, 'a plain terminal has no subagents');
  } finally {
    cliSessionState.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing directory attaches nothing and costs nothing', () => {
  const dir = path.join(mkTmp(), 'does-not-exist');
  const { attached } = boot(dir, oneSession());
  assert.equal(attached, false, 'no directory, no watcher, no polling fallback');
  cliSessionState.stop();
});

test('parseState rejects everything that is not a usable state file', () => {
  const { parseState } = cliSessionState;
  assert.equal(parseState('not json'), null);
  assert.equal(parseState('null'), null);
  assert.equal(parseState('[]'), null, 'an array carries none of the fields');
  assert.equal(parseState(JSON.stringify({ sessionId: 'a', status: 'idle' })), null, 'no pid');
  assert.equal(parseState(JSON.stringify({ pid: 1, status: 'idle' })), null, 'no sessionId');
  assert.equal(parseState(JSON.stringify({ pid: 1, sessionId: 'a', status: 'nope' })), null);
  const ok = parseState(JSON.stringify({
    pid: 1, sessionId: 'a', status: 'idle', statusUpdatedAt: 5, procStart: 7,
  }));
  assert.deepEqual(ok, {
    pid: 1, sessionId: 'a', status: 'idle', statusUpdatedAt: 5, procStart: '7',
  });
});
