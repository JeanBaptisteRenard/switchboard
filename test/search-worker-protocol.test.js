'use strict';

// Behavioral tests for the search-worker-client protocol.
//
// Uses a mock Worker (postMessage/on('message') stub) so no native module
// (better-sqlite3, node-pty, Electron) is needed.
//
// Covers:
//   1. searchViaWorker registers a pending entry; mock worker replies → Promise
//      resolves with those results.
//   2. Worker reply with { id, error } → Promise resolves with [] (not null/throw).
//   3. Not-ready fallback → calls searchByType synchronously and returns its result.
//   4. exit event drains pending promises (they resolve with [], do not hang).

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSearchWorkerClient } = require('../search-worker-client');

// ---------------------------------------------------------------------------
// Mock Worker factory
// ---------------------------------------------------------------------------

/**
 * Creates a minimal Worker-like object.
 * Captures listeners so tests can fire events directly.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.goOnlineImmediately=true]  emit 'online' synchronously
 * @returns {{ mock, listeners }}
 */
function makeMockWorker(opts = {}) {
  const { goOnlineImmediately = true } = opts;
  const listeners = {};

  const mock = {
    postMessage: () => {},           // spy target in individual tests
    removeAllListeners: (event) => { delete listeners[event]; },
    terminate: () => {},
    on(event, fn) {
      listeners[event] = fn;
      // Fire 'online' synchronously so workerReady is true before test asserts.
      if (event === 'online' && goOnlineImmediately) fn();
      return this;
    },
  };

  return { mock, listeners };
}

// Convenience: build a client with a single mock worker instance.
function makeClient(opts = {}) {
  const {
    goOnlineImmediately = true,
    searchByType = () => [],
    maxRestarts = 5,
  } = opts;

  let createdMock = null;
  let createdListeners = null;

  const client = createSearchWorkerClient({
    workerFactory: () => {
      const { mock, listeners } = makeMockWorker({ goOnlineImmediately });
      createdMock = mock;
      createdListeners = listeners;
      return mock;
    },
    searchByType,
    log: { warn: () => {}, error: () => {} },
    dbPath: '/fake/db.sqlite',
    maxRestarts,
    restartWindowMs: 1000000, // effectively infinite for test purposes
  });

  client.startWorker();

  return {
    client,
    getMock: () => createdMock,
    getListeners: () => createdListeners,
    // Simulate the worker posting a message back (reply from worker).
    replyWith: (msg) => createdListeners['message'](msg),
    // Simulate the worker emitting 'exit'.
    fireExit: (code) => createdListeners['exit'](code),
    // Simulate the worker emitting 'error'.
    fireError: (err) => createdListeners['error'](err),
  };
}

// ---------------------------------------------------------------------------
// 1. searchViaWorker registers a pending entry; mock worker replies with
//    results → Promise resolves with those results.
// ---------------------------------------------------------------------------

test('searchViaWorker: resolves with worker results on successful reply', async () => {
  const { client, getMock, replyWith } = makeClient();
  const mock = getMock();

  let capturedMsg = null;
  mock.postMessage = (msg) => { capturedMsg = msg; };

  const resultPromise = client.searchViaWorker('session', 'spec.md', false);

  // Worker should have received a message with a correlation ID.
  assert.ok(capturedMsg, 'postMessage should have been called');
  assert.ok(capturedMsg.id, 'message must include a correlation id');
  assert.equal(capturedMsg.type, 'session');
  assert.equal(capturedMsg.query, 'spec.md');
  assert.equal(capturedMsg.titleOnly, false);

  const fakeResults = [{ id: 1, snippet: 'spec.md snippet' }];
  // Simulate the worker replying.
  replyWith({ id: capturedMsg.id, results: fakeResults });

  const results = await resultPromise;
  assert.deepEqual(results, fakeResults, 'Promise should resolve with the worker results');
});

// ---------------------------------------------------------------------------
// 2. Worker reply with { id, error } → Promise resolves with [] (not null/throw)
// ---------------------------------------------------------------------------

test('searchViaWorker: resolves with [] when worker replies with an error', async () => {
  const { client, getMock, replyWith } = makeClient();
  const mock = getMock();

  let capturedMsg = null;
  mock.postMessage = (msg) => { capturedMsg = msg; };

  const resultPromise = client.searchViaWorker('session', 'bad query', false);

  assert.ok(capturedMsg, 'postMessage should have been called');

  // Simulate the worker reporting an error.
  replyWith({ id: capturedMsg.id, error: 'SQLITE_ERROR: fts5: syntax error' });

  const results = await resultPromise;
  assert.deepEqual(results, [], 'error reply should resolve with [] not throw');
});

// ---------------------------------------------------------------------------
// 3. Not-ready fallback → calls searchByType synchronously and returns its result
// ---------------------------------------------------------------------------

test('searchViaWorker: falls back to searchByType when worker is not ready', async () => {
  const syncResults = [{ id: 42, snippet: 'fallback result' }];
  let syncCallArgs = null;
  const searchByType = (type, query, limit, titleOnly) => {
    syncCallArgs = { type, query, limit, titleOnly };
    return syncResults;
  };

  // goOnlineImmediately: false → workerReady stays false
  const { client } = makeClient({ goOnlineImmediately: false, searchByType });

  const results = await client.searchViaWorker('session', 'hello', true);

  assert.deepEqual(results, syncResults, 'fallback should return searchByType result');
  assert.ok(syncCallArgs, 'searchByType should have been called');
  assert.equal(syncCallArgs.type, 'session');
  assert.equal(syncCallArgs.query, 'hello');
  assert.equal(syncCallArgs.titleOnly, true);
});

// ---------------------------------------------------------------------------
// 4. exit event drains pending promises (resolve with [], do not hang);
//    circuit-breaker open → subsequent searchViaWorker routes to sync fallback
// ---------------------------------------------------------------------------

test('exit event drains in-flight promises with [] before restarting', async () => {
  // Use maxRestarts=0 so the circuit-breaker trips on the first failure.
  const syncResults = [{ id: 99, snippet: 'sync-fallback result' }];
  let syncCallCount = 0;
  const searchByType = (type, query, limit, titleOnly) => {
    syncCallCount++;
    return syncResults;
  };

  const { client, getMock, fireExit } = makeClient({ maxRestarts: 0, searchByType });
  const mock = getMock();

  // Queue two in-flight searches without the worker replying.
  const messages = [];
  mock.postMessage = (msg) => messages.push(msg);

  const p1 = client.searchViaWorker('session', 'query-1', false);
  const p2 = client.searchViaWorker('session', 'query-2', false);

  assert.equal(messages.length, 2, 'two messages should be queued');

  // Fire exit without a prior 'error' event (native crash path).
  fireExit(11); // SIGSEGV-like exit code

  // Both promises must resolve (not hang).
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.deepEqual(r1, [], 'first pending promise should resolve with []');
  assert.deepEqual(r2, [], 'second pending promise should resolve with []');

  // Circuit-breaker is now open (failureCount=1 >= maxRestarts=0).
  // Subsequent searches must route to the synchronous fallback.
  const r3 = await client.searchViaWorker('session', 'post-breaker', false);
  assert.deepEqual(r3, syncResults, 'post-breaker search should use sync fallback');
  assert.equal(syncCallCount, 1, 'searchByType should have been called once for post-breaker query');
});

// ---------------------------------------------------------------------------
// 5. drainPending clears the map (no double-resolve if exit fires after error)
// ---------------------------------------------------------------------------

test('drainPending is idempotent: double-drain does not throw', () => {
  const { client, getMock } = makeClient();
  const mock = getMock();

  let capturedMsg = null;
  mock.postMessage = (msg) => { capturedMsg = msg; };

  // Queue one search without resolving it.
  client.searchViaWorker('session', 'hi', false);
  assert.ok(capturedMsg, 'message should be queued');

  // Drain once (error handler path).
  client.drainPending();
  // Drain again (exit handler path) — should be a no-op, no throw.
  assert.doesNotThrow(() => client.drainPending());
});

// ---------------------------------------------------------------------------
// 6. shutdown() while backoff timer is armed — no worker spawned afterward
// ---------------------------------------------------------------------------

test('shutdown() while backoff is armed cancels restart, no worker spawned after', async () => {
  // Use maxRestarts=2 so the first failure arms backoff (failureCount=1 < 2).
  // We need to track worker creation attempts after shutdown.
  let workerCreateCount = 0;
  let createdMock = null;
  let createdListeners = null;

  const client = createSearchWorkerClient({
    workerFactory: () => {
      workerCreateCount++;
      const { mock, listeners } = makeMockWorker({ goOnlineImmediately: true });
      createdMock = mock;
      createdListeners = listeners;
      return mock;
    },
    searchByType: () => [],
    log: { warn: () => {}, error: () => {} },
    dbPath: '/fake/db.sqlite',
    maxRestarts: 2,
    restartWindowMs: 1000000,
    // Use a very short backoff delay so the timer would fire quickly if not cancelled.
    // We cannot override delay directly, but we can use failureCount=1, delay=250ms.
  });

  client.startWorker();
  assert.equal(workerCreateCount, 1, 'worker created once on startWorker()');

  // Trigger a failure (non-zero exit) to arm the backoff timer.
  // failureCount becomes 1 (< maxRestarts=2) → restartTimer is armed.
  createdListeners['exit'](1);

  // Immediately shut down — restartTimer must be cleared.
  client.shutdown();

  // Wait longer than the backoff delay (250ms for failureCount=1) to confirm
  // the timer does not fire and no new worker is created.
  await new Promise((resolve) => setTimeout(resolve, 400));

  assert.equal(workerCreateCount, 1, 'no additional worker should be created after shutdown()');
});

// ---------------------------------------------------------------------------
// 7. shutdown() drains in-flight promises — a search awaited across app quit
//    resolves with [] instead of hanging forever
// ---------------------------------------------------------------------------

test('shutdown() drains pending promises (in-flight search resolves with [])', async () => {
  let createdMock = null;
  const client = createSearchWorkerClient({
    workerFactory: () => {
      const { mock } = makeMockWorker({ goOnlineImmediately: true });
      createdMock = mock;
      return mock;
    },
    searchByType: () => { throw new Error('fallback must not be used here'); },
    log: { warn: () => {}, error: () => {} },
    dbPath: '/fake/db.sqlite',
  });

  client.startWorker();
  assert.ok(createdMock, 'worker created');

  // In-flight query: the mock worker never replies.
  const inFlight = client.searchViaWorker('session', 'query', false);

  client.shutdown();

  const results = await inFlight;
  assert.deepEqual(results, [], 'in-flight promise must resolve with [] on shutdown');
});
