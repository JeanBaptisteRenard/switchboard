// Tests for the first-run cold-start indexing banner.
//
// app.js is a monolithic renderer file that performs many document.getElementById
// calls and kicks off loadProjects() at module load time, making it impractical to
// load via vm.runInContext in jsdom without a massive DOM scaffolding (see
// test/exit-banner.test.js, same codebase precedent). So the thin DOM-toggle wrapper
// (updateIndexingBanner) is exercised via a hand-wired harness that mirrors its body,
// while the actual text-formatting logic — formatIndexingBannerText, a pure function
// that lives in public/utils.js — is loaded and tested for real via dom-setup.js.
//
// Invariants under test:
//   1. formatIndexingBannerText renders "i/N projects, X sessions so far".
//   2. A cold-start progress event (coldStart:true, done:false) shows the banner.
//   3. done:true hides the banner immediately.
//   4. An event without coldStart (shouldn't happen, but defends the gate) is ignored.

const test = require('node:test');
const assert = require('node:assert/strict');
const { setupSidebarDom } = require('./dom-setup');

// ---------------------------------------------------------------------------
// formatIndexingBannerText — real function, loaded via the shared jsdom harness.
// ---------------------------------------------------------------------------

test('formatIndexingBannerText: renders the one-time first-run message with counters', () => {
  const { window, destroy } = setupSidebarDom();
  try {
    const text = window.formatIndexingBannerText({ current: 3, total: 16, sessionsSoFar: 128 });
    assert.equal(text, 'Indexing your Claude Code history — one-time, 3/16 projects, 128 sessions so far');
  } finally {
    destroy();
  }
});

// ---------------------------------------------------------------------------
// updateIndexingBanner — hand-wired harness mirroring app.js's DOM-toggle logic.
// ---------------------------------------------------------------------------

function makeHarness() {
  const banner = { textContent: '', style: { display: 'none' } };

  // Reproduce the logic from app.js's updateIndexingBanner.
  function updateIndexingBanner(payload) {
    if (!payload || !payload.coldStart) return;
    if (payload.done) {
      banner.style.display = 'none';
      return;
    }
    banner.textContent = `Indexing your Claude Code history — one-time, ${payload.current}/${payload.total} projects, ${payload.sessionsSoFar} sessions so far`;
    banner.style.display = '';
  }

  return { banner, updateIndexingBanner };
}

test('updateIndexingBanner: shows the banner with progress text on a cold-start event', () => {
  const { banner, updateIndexingBanner } = makeHarness();
  updateIndexingBanner({ coldStart: true, current: 1, total: 16, sessionsSoFar: 4, done: false });
  assert.equal(banner.style.display, '');
  assert.match(banner.textContent, /1\/16 projects, 4 sessions so far/);
});

test('updateIndexingBanner: hides the banner immediately on done:true', () => {
  const { banner, updateIndexingBanner } = makeHarness();
  updateIndexingBanner({ coldStart: true, current: 5, total: 16, sessionsSoFar: 50, done: false });
  assert.equal(banner.style.display, '');
  updateIndexingBanner({ coldStart: true, current: 16, total: 16, sessionsSoFar: 200, done: true });
  assert.equal(banner.style.display, 'none', 'banner must disappear once indexing completes');
});

test('updateIndexingBanner: ignores events without coldStart (warm-start rebuilds never emit these, but defend the gate)', () => {
  const { banner, updateIndexingBanner } = makeHarness();
  updateIndexingBanner({ coldStart: false, current: 1, total: 5, sessionsSoFar: 1, done: false });
  assert.equal(banner.style.display, 'none', 'no coldStart flag must never show the banner');
});

test('updateIndexingBanner: ignores a null/undefined payload without throwing', () => {
  const { banner, updateIndexingBanner } = makeHarness();
  assert.doesNotThrow(() => updateIndexingBanner(null));
  assert.equal(banner.style.display, 'none');
});
