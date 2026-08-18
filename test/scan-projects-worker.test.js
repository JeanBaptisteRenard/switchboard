'use strict';

// Cold-start indexing UX fix: workers/scan-projects.js used to buffer every
// folder's parsed sessions into one `results` array and post a single message
// once the ENTIRE ~/.claude/projects/ tree had been read — on a large history
// (1GB+, witnessed live) that meant the main thread (and therefore the
// renderer's get-projects call) had nothing to act on for many minutes.
//
// The worker now streams one `{type:'folder', ...}` message per folder as
// soon as it's read, so session-cache.js can write it to the DB and push a
// sidebar update immediately instead of waiting for the full tree.
//
// No native modules on this path (fs/path + pure-JS derive/read helpers), so
// spinning the REAL worker is safe under plain node:test — same pattern as
// test/search-worker-db-failure.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');

function writeSession(folderPath, cwd) {
  fs.mkdirSync(folderPath, { recursive: true });
  const line = JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: 'hello' } });
  fs.writeFileSync(path.join(folderPath, 'session.jsonl'), line + '\n', 'utf8');
}

function runWorker(projectsDir) {
  return new Promise((resolve, reject) => {
    const messages = [];
    const worker = new Worker(path.join(__dirname, '..', 'workers', 'scan-projects.js'), {
      workerData: { projectsDir },
    });
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error('worker did not finish within 10s'));
    }, 10000);
    worker.on('message', (msg) => {
      messages.push(msg);
      if (msg.type === 'done') {
        clearTimeout(timer);
        resolve(messages);
      }
    });
    worker.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

test('scan-projects worker streams one folder message per folder, then a final done message', async () => {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-scan-'));
  try {
    writeSession(path.join(projectsDir, 'proj-a'), '/tmp/proj-a');
    writeSession(path.join(projectsDir, 'proj-b'), '/tmp/proj-b');
    writeSession(path.join(projectsDir, 'proj-c'), '/tmp/proj-c');

    const messages = await runWorker(projectsDir);

    const folderMsgs = messages.filter(m => m.type === 'folder');
    const doneMsgs = messages.filter(m => m.type === 'done');

    assert.equal(folderMsgs.length, 3, 'one folder message per on-disk project folder');
    assert.equal(doneMsgs.length, 1, 'exactly one final done message');
    assert.equal(doneMsgs[0].ok, true);
    assert.equal(doneMsgs[0].total, 3);

    // Each folder message must carry its own result plus progress counters,
    // so the caller can write it to the DB and report progress without
    // waiting for the rest of the tree.
    for (const msg of folderMsgs) {
      assert.equal(msg.total, 3);
      assert.ok(msg.current >= 1 && msg.current <= 3);
      assert.ok(msg.result, 'folder message must carry a parsed result');
      assert.equal(msg.result.sessions.length, 1);
    }

    const folders = folderMsgs.map(m => m.result.folder).sort();
    assert.deepEqual(folders, ['proj-a', 'proj-b', 'proj-c']);
  } finally {
    fs.rmSync(projectsDir, { recursive: true, force: true });
  }
});

test('scan-projects worker reports done:ok even for an empty projects dir', async () => {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-scan-empty-'));
  try {
    const messages = await runWorker(projectsDir);
    assert.equal(messages.filter(m => m.type === 'folder').length, 0);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].type, 'done');
    assert.equal(messages[0].ok, true);
    assert.equal(messages[0].total, 0);
  } finally {
    fs.rmSync(projectsDir, { recursive: true, force: true });
  }
});
