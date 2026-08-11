'use strict';

// The search-query worker must EXIT (non-zero) when it cannot open the DB,
// rather than staying alive answering every query with empty results — a
// silently-broken worker keeps reporting "online", so the client's
// backoff/circuit-breaker/synchronous-fallback machinery never engages and
// search returns [] forever. Exiting hands control to that machinery.
//
// Spawns the REAL worker (needs better-sqlite3), pointing it at a DB path
// whose file does not exist: readonly open must throw, worker must exit 1.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');

test('search-query worker exits with code 1 when the DB cannot be opened', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-sw-'));
  try {
    const dbPath = path.join(tmp, 'does-not-exist.db');
    const worker = new Worker(
      path.join(__dirname, '..', 'workers', 'search-query.js'),
      { workerData: { dbPath }, stderr: true }
    );
    worker.stderr.resume(); // discard the expected error line

    const exitCode = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => { worker.terminate(); reject(new Error('worker did not exit within 10 s')); },
        10000
      );
      worker.on('exit', (code) => { clearTimeout(timer); resolve(code); });
    });

    assert.equal(exitCode, 1, 'worker must exit(1) on DB-open failure');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
