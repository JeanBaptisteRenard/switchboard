'use strict';

// Regression test for PR #124 review finding F1: main.js's get-projects
// handler used to call reconcileCacheFromFilesystem() unconditionally AFTER
// the if/needsPopulate branch, in addition to calling it again inside the
// `else` branch. Once populateCacheViaWorker() became fire-and-forget on a
// cold cache (this feature's own change), that trailing call ran while
// cache_meta was still completely empty, so its stat-gate was true for every
// folder -- triggering a full synchronous refreshFolder() sweep (full JSONL
// parse) of the entire tree on the main thread before get-projects could
// return. That reintroduced the exact multi-minute blocking hang this
// feature set out to fix, via a different call site.
//
// This test extracts the REAL get-projects handler body from main.js's
// source (same brace-matching technique test/main-ctx-db-wiring.test.js
// uses for the ctx.db literal) and executes it against mocked collaborators,
// so it verifies the actual shipped logic rather than a hand-copied
// re-implementation that could silently drift from it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

function extractGetProjectsHandlerBody() {
  const src = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const marker = "ipcMain.handle('get-projects'";
  const start = src.indexOf(marker);
  assert.ok(start !== -1, 'main.js must define the get-projects handler');
  const arrowIdx = src.indexOf('=>', start);
  const bodyOpen = src.indexOf('{', arrowIdx);
  let depth = 0, end = -1;
  for (let i = bodyOpen; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  assert.ok(end !== -1, 'get-projects handler body must be balanced');
  return src.slice(bodyOpen + 1, end);
}

function makeHandler(mocks) {
  const body = extractGetProjectsHandlerBody();
  const fn = new Function(
    'isCachePopulated', 'isSearchIndexPopulated', 'populateCacheViaWorker',
    'reconcileCacheFromFilesystem', 'buildProjectsFromCache', 'showArchived',
    body
  );
  return () => fn(
    mocks.isCachePopulated, mocks.isSearchIndexPopulated, mocks.populateCacheViaWorker,
    mocks.reconcileCacheFromFilesystem, mocks.buildProjectsFromCache, false
  );
}

test('get-projects on a cold cache never runs reconcileCacheFromFilesystem synchronously', () => {
  const calls = [];
  const handler = makeHandler({
    isCachePopulated: () => false, // cold cache: needsPopulate branch
    isSearchIndexPopulated: () => false,
    populateCacheViaWorker: () => { calls.push('populate'); },
    reconcileCacheFromFilesystem: () => { calls.push('reconcile'); },
    buildProjectsFromCache: () => { calls.push('build'); return []; },
  });

  handler();

  assert.ok(!calls.includes('reconcile'),
    'reconcileCacheFromFilesystem must never run in the same synchronous window as a cold-cache ' +
    'get-projects call -- its stat-gate is true for every folder while cache_meta is still empty, ' +
    'causing a full synchronous refreshFolder sweep (the exact multi-minute hang this feature fixed, ' +
    'via a different call site)');
  assert.deepEqual(calls, ['populate', 'build']);
});

test('get-projects on a warm cache still reconciles (stat-gated, cheap when nothing changed)', () => {
  const calls = [];
  const handler = makeHandler({
    isCachePopulated: () => true, // warm cache: else branch
    isSearchIndexPopulated: () => true,
    populateCacheViaWorker: () => { calls.push('populate'); },
    reconcileCacheFromFilesystem: () => { calls.push('reconcile'); },
    buildProjectsFromCache: () => { calls.push('build'); return []; },
  });

  handler();

  assert.ok(!calls.includes('populate'), 'a warm start must not kick off a fresh worker scan');
  assert.deepEqual(calls, ['reconcile', 'build']);
});
