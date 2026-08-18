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
//   5. Clicking the dismiss button hides the banner immediately, before done:true
//      (PR #124 review finding F2: the banner was documented as "dismissible" but
//      had no actual close control, only an auto-hide-on-done path).
//   6. Once dismissed, further non-done progress events don't re-show the banner.
//   7. A done:true event resets the dismissed flag so a future cold-start run
//      (e.g. after a cache-clearing migration) can show its own banner again.
//   8. A done:true event carrying an error shows the failure in the banner
//      (even past a dismiss) instead of silently hiding it -- the tiny status
//      indicator used to be the only trace of a failed scan.

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
  const banner = { style: { display: 'none' } };
  const bannerText = { textContent: '' };
  let dismissed = false;

  // Reproduce the logic from app.js's updateIndexingBanner + dismiss handler.
  // (formatIndexingBannerText itself is the real function, tested above; the
  // harness inlines its two output shapes.)
  function formatText(payload) {
    if (payload.error) return `Indexing failed: ${payload.error} — it will resume on the next launch.`;
    return `Indexing your Claude Code history — one-time, ${payload.current}/${payload.total} projects, ${payload.sessionsSoFar} sessions so far`;
  }
  function updateIndexingBanner(payload) {
    if (!payload || !payload.coldStart) return;
    if (payload.done) {
      if (payload.error) {
        bannerText.textContent = formatText(payload);
        banner.style.display = '';
        dismissed = false;
        return;
      }
      banner.style.display = 'none';
      dismissed = false; // a future cold-start run gets its own banner
      return;
    }
    if (dismissed) return;
    bannerText.textContent = formatText(payload);
    banner.style.display = '';
  }

  function dismissIndexingBanner() {
    banner.style.display = 'none';
    dismissed = true;
  }

  return { banner, bannerText, updateIndexingBanner, dismissIndexingBanner, isDismissed: () => dismissed };
}

test('updateIndexingBanner: shows the banner with progress text on a cold-start event', () => {
  const { banner, bannerText, updateIndexingBanner } = makeHarness();
  updateIndexingBanner({ coldStart: true, current: 1, total: 16, sessionsSoFar: 4, done: false });
  assert.equal(banner.style.display, '');
  assert.match(bannerText.textContent, /1\/16 projects, 4 sessions so far/);
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

test('dismissIndexingBanner: hides the banner immediately, before done:true', () => {
  const { banner, updateIndexingBanner, dismissIndexingBanner } = makeHarness();
  updateIndexingBanner({ coldStart: true, current: 2, total: 16, sessionsSoFar: 10, done: false });
  assert.equal(banner.style.display, '', 'sanity: banner is showing before dismiss');

  dismissIndexingBanner();

  assert.equal(banner.style.display, 'none', 'dismiss must hide the banner without waiting for done:true');
});

test('dismissIndexingBanner: once dismissed, further non-done progress events do not re-show the banner', () => {
  const { banner, updateIndexingBanner, dismissIndexingBanner } = makeHarness();
  updateIndexingBanner({ coldStart: true, current: 2, total: 16, sessionsSoFar: 10, done: false });
  dismissIndexingBanner();

  updateIndexingBanner({ coldStart: true, current: 3, total: 16, sessionsSoFar: 20, done: false });

  assert.equal(banner.style.display, 'none', 'a dismissed banner must stay hidden until the run completes');
});

test('formatIndexingBannerText: a payload with an error renders the failure message', () => {
  const { window, destroy } = setupSidebarDom();
  try {
    const text = window.formatIndexingBannerText({ current: 3, total: 16, sessionsSoFar: 128, error: 'ENOSPC: no space left on device' });
    assert.equal(text, 'Indexing failed: ENOSPC: no space left on device — it will resume on the next launch.');
  } finally {
    destroy();
  }
});

test('updateIndexingBanner: done:true with an error shows the failure instead of hiding the banner', () => {
  const { banner, bannerText, updateIndexingBanner } = makeHarness();
  updateIndexingBanner({ coldStart: true, current: 2, total: 16, sessionsSoFar: 10, done: false });

  updateIndexingBanner({ coldStart: true, current: 5, total: 16, sessionsSoFar: 40, done: true, error: 'worker exited unexpectedly' });

  assert.equal(banner.style.display, '', 'a failed scan must stay visible, not silently disappear');
  assert.match(bannerText.textContent, /Indexing failed: worker exited unexpectedly/);
});

test('updateIndexingBanner: a failure surfaces even after the user dismissed the progress banner', () => {
  const { banner, bannerText, updateIndexingBanner, dismissIndexingBanner } = makeHarness();
  updateIndexingBanner({ coldStart: true, current: 2, total: 16, sessionsSoFar: 10, done: false });
  dismissIndexingBanner();

  updateIndexingBanner({ coldStart: true, current: 5, total: 16, sessionsSoFar: 40, done: true, error: 'boom' });

  assert.equal(banner.style.display, '',
    '"your history did not finish indexing" is new information, not more of the dismissed progress stream');
  assert.match(bannerText.textContent, /Indexing failed: boom/);
});

test('a done:true event resets the dismissed flag for a future cold-start run', () => {
  const { updateIndexingBanner, dismissIndexingBanner, isDismissed } = makeHarness();
  updateIndexingBanner({ coldStart: true, current: 2, total: 16, sessionsSoFar: 10, done: false });
  dismissIndexingBanner();
  assert.equal(isDismissed(), true);

  updateIndexingBanner({ coldStart: true, current: 16, total: 16, sessionsSoFar: 200, done: true });

  assert.equal(isDismissed(), false, 'done:true must clear the dismissed flag so a later run gets its own banner');
});
