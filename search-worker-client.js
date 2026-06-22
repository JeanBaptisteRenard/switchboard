'use strict';

// search-worker-client.js
//
// Encapsulates the worker-client protocol for the search query worker:
// correlation-ID round-trip, pending-promise map, drain-on-exit, and the
// restart backoff / circuit-breaker.
//
// Extracted from main.js so the protocol can be unit-tested without
// requiring Electron or better-sqlite3.  main.js passes real dependencies;
// tests inject mocks.
//
// Factory: createSearchWorkerClient(deps) → { startWorker, searchViaWorker }
//
// deps:
//   workerFactory(dbPath)   → Worker-like object with .on() and .postMessage()
//   searchByType(type, q, limit, titleOnly) → Array  (synchronous fallback)
//   log                     → { warn, error } (electron-log or console)
//   dbPath                  → string passed through to workerFactory
//   maxRestarts             → optional; default 5
//   restartWindowMs         → optional; default 10 000

function createSearchWorkerClient(deps) {
  const {
    workerFactory,
    searchByType,
    log,
    dbPath,
    maxRestarts = 5,
    restartWindowMs = 10000,
  } = deps;

  let worker = null;
  let workerReady = false;
  const pending = new Map(); // correlationId → { resolve }
  let counter = 0;

  // Circuit-breaker state
  let failureCount = 0;
  let failureWindowTimer = null;

  /**
   * Resolve all in-flight search promises with [] and clear the map.
   * Called from both `error` and `exit` handlers so neither path orphans
   * a pending IPC call.  A native crash (SIGSEGV) fires only `exit`, so
   * without this the renderer's window.api.search() would hang forever.
   */
  function drainPending() {
    for (const [id, p] of pending) {
      p.resolve([]);
      pending.delete(id);
    }
  }

  function startWorker() {
    worker = workerFactory(dbPath);

    worker.on('online', () => {
      workerReady = true;
      // A clean startup resets the failure-count window.
      clearTimeout(failureWindowTimer);
      // unref() so this housekeeping timer does not prevent process exit in
      // tests (or in a future scenario where the app quits with no open window).
      failureWindowTimer = setTimeout(() => {
        failureCount = 0;
      }, restartWindowMs);
      if (failureWindowTimer.unref) failureWindowTimer.unref();
    });

    worker.on('message', (msg) => {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) {
        // Resolve with empty results — same behaviour as the synchronous
        // searchByType catch branch.
        p.resolve([]);
      } else {
        p.resolve(msg.results);
      }
    });

    worker.on('error', (err) => {
      log.error('[search-worker] error:', err.message);
      // Drain so the renderer is never left hanging.
      drainPending();
      workerReady = false;
      // `exit` will fire next for a JS exception — restart logic lives there.
    });

    worker.on('exit', (code) => {
      workerReady = false;
      worker = null;
      // Drain in case `error` did NOT fire first (native crash / terminate()
      // path: only `exit` fires, so without this drain the renderer awaits
      // indefinitely on unresolved Promises).
      drainPending();

      if (code !== 0) {
        failureCount++;
        clearTimeout(failureWindowTimer);

        if (failureCount >= maxRestarts) {
          // Circuit-breaker open: stop restarting and fall back permanently
          // to synchronous searchByType on the main thread.
          log.error(
            `[search-worker] ${failureCount} consecutive failures — ` +
            'circuit-breaker open; falling back to synchronous search'
          );
          return;
        }

        // Exponential backoff: 250 ms × 2^(failureCount-1), capped at 8 s.
        const delay = Math.min(250 * Math.pow(2, failureCount - 1), 8000);
        log.warn(
          `[search-worker] exited with code ${code} ` +
          `(failure ${failureCount}/${maxRestarts}); ` +
          `restarting in ${delay} ms`
        );
        setTimeout(() => startWorker(), delay);
      }
    });
  }

  /**
   * Send a search query to the worker and return a Promise<results[]>.
   * Falls back to the synchronous searchByType on the main thread if the
   * worker is not yet ready (first-launch race or circuit-breaker open).
   */
  function searchViaWorker(type, query, titleOnly) {
    if (!workerReady || !worker) {
      return Promise.resolve(searchByType(type, query, 50, !!titleOnly));
    }
    return new Promise((resolve) => {
      const id = String(++counter);
      pending.set(id, { resolve });
      worker.postMessage({ id, type, query, limit: 50, titleOnly: !!titleOnly });
    });
  }

  /**
   * Terminate the worker cleanly (called from will-quit before closeDb()).
   * Suppresses the restart logic so the exit handler does not try to respawn
   * after the DB connection has already been closed.
   */
  function shutdown() {
    if (worker) {
      worker.removeAllListeners('exit'); // suppress backoff / restart
      worker.terminate();
      worker = null;
    }
    workerReady = false;
  }

  return { startWorker, searchViaWorker, drainPending, shutdown };
}

module.exports = { createSearchWorkerClient };
