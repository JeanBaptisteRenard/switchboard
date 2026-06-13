// Tests for Q9: updateRunningIndicators() pty-set gating.
//
// app.js cannot be loaded in jsdom (line 198 calls window.api.onTerminalData at
// module scope, which fires before our stubs are in place). Instead we test the
// gating logic in isolation: build a minimal DOM, replicate the function from
// public/app.js, and assert that:
//
//   a) When activePtyIds is unchanged between calls, the two sidebar
//      querySelectorAll scans are skipped entirely.
//   b) When activePtyIds changes, the scans run and classes are updated.
//   c) The gridCards loop runs on every call (not gated) because sessionBusyState
//      can change independently of the pty-set.

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

// ---------------------------------------------------------------------------
// Minimal DOM setup
// ---------------------------------------------------------------------------

function buildDom() {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>
    <div id="sidebar-content">
      <div class="slug-group" id="sg1">
        <div class="slug-group-dot"></div>
        <div class="session-item" data-session-id="s1">
          <div class="session-status-dot"></div>
        </div>
        <div class="session-item" data-session-id="s2">
          <div class="session-status-dot"></div>
        </div>
      </div>
    </div>
  </body></html>`, { url: 'http://localhost/' });
  return dom;
}

// Build the updateRunningIndicators function as it exists in public/app.js
// (post-Q9 patch). We instantiate it inline rather than eval-ing app.js because
// app.js registers IPC listeners at module-scope that require a preload bridge
// we can't stub cleanly in jsdom.
function makeIndicatorFn(doc, state) {
  // Mirrors the module-level var added by Q9.
  let lastPtySignature = '';

  return function updateRunningIndicators() {
    const sig = Array.from(state.activePtyIds).sort().join(',');
    const ptySetChanged = sig !== lastPtySignature;
    lastPtySignature = sig;

    if (ptySetChanged) {
      doc.querySelectorAll('.session-item').forEach(item => {
        const id = item.dataset.sessionId;
        const running = state.activePtyIds.has(id);
        item.classList.toggle('has-running-pty', running);
        if (!running) {
          item.classList.remove('needs-attention', 'response-ready', 'cli-busy');
          state.attentionSessions.delete(id);
          state.responseReadySessions.delete(id);
          state.sessionBusyState.delete(id);
        }
        const dot = item.querySelector('.session-status-dot');
        if (dot) dot.classList.toggle('running', running);
      });
      doc.querySelectorAll('.slug-group').forEach(group => {
        const hasRunning = group.querySelector('.session-item.has-running-pty') !== null;
        const dot = group.querySelector('.slug-group-dot');
        if (dot) dot.classList.toggle('running', hasRunning);
      });
    }

    for (const [sid, card] of state.gridCards) {
      const running = state.activePtyIds.has(sid);
      const busy = state.sessionBusyState.get(sid) || false;
      const dot = card.querySelector('.grid-card-dot');
      if (dot) dot.className = 'grid-card-dot ' + (busy ? 'busy' : (running ? 'running' : 'stopped'));
      const footer = card.querySelector('.grid-card-footer');
      if (footer) footer.children[0].textContent = running ? 'Running' : 'Stopped';
      const stopBtn = card.querySelector('.grid-card-stop-btn');
      if (stopBtn) stopBtn.style.display = running ? '' : 'none';
    }
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('updateRunningIndicators: unchanged pty-set — sidebar querySelectorAll skipped', () => {
  const dom = buildDom();
  const { window } = dom;
  const { document } = window;

  // Spy on querySelectorAll to count sidebar scans.
  let qsaCallCount = 0;
  const origQsa = document.querySelectorAll.bind(document);
  document.querySelectorAll = (...args) => {
    // Only count the selector patterns updateRunningIndicators uses for sidebar
    // scans; not the internal DOM reads like slug-group-dot lookups (which are
    // called on elements, not document).
    if (args[0] === '.session-item' || args[0] === '.slug-group') qsaCallCount++;
    return origQsa(...args);
  };

  const state = {
    activePtyIds: new Set(['s1']),
    attentionSessions: new Set(),
    responseReadySessions: new Set(),
    sessionBusyState: new Map(),
    gridCards: new Map(),
  };
  const update = makeIndicatorFn(document, state);

  // First call — pty-set changed from '' → 's1'; sidebar scan MUST run.
  update();
  assert.equal(qsaCallCount, 2, 'first call: both .session-item and .slug-group scanned');
  const item1 = document.querySelector('[data-session-id="s1"]');
  assert.ok(item1.classList.contains('has-running-pty'), 's1 has-running-pty set on first call');

  // Second call — same activePtyIds; sidebar scan must be SKIPPED.
  qsaCallCount = 0;
  update();
  assert.equal(qsaCallCount, 0, 'second call with same pty-set: sidebar querySelectorAll NOT called');

  window.close();
});

test('updateRunningIndicators: changed pty-set — sidebar scans run, classes updated', () => {
  const dom = buildDom();
  const { window } = dom;
  const { document } = window;

  const state = {
    activePtyIds: new Set(['s1']),
    attentionSessions: new Set(),
    responseReadySessions: new Set(),
    sessionBusyState: new Map(),
    gridCards: new Map(),
  };
  const update = makeIndicatorFn(document, state);

  // First call: s1 running.
  update();
  const item1 = document.querySelector('[data-session-id="s1"]');
  const item2 = document.querySelector('[data-session-id="s2"]');
  assert.ok(item1.classList.contains('has-running-pty'), 's1 running after first call');
  assert.ok(!item2.classList.contains('has-running-pty'), 's2 not running');

  // Change the pty-set: now s2 running, s1 stopped.
  state.activePtyIds = new Set(['s2']);
  update();
  assert.ok(!item1.classList.contains('has-running-pty'), 's1 no longer running after set change');
  assert.ok(item2.classList.contains('has-running-pty'), 's2 now running');

  // Slug group dot should reflect at least one running session.
  const groupDot = document.querySelector('.slug-group-dot');
  assert.ok(groupDot.classList.contains('running'), 'slug-group-dot running when s2 is running');

  window.close();
});

test('updateRunningIndicators: stale attention/response-ready/cli-busy cleared when pty stops', () => {
  const dom = buildDom();
  const { window } = dom;
  const { document } = window;

  const attentionSessions = new Set(['s1']);
  const responseReadySessions = new Set(['s1']);
  const sessionBusyState = new Map([['s1', true]]);
  const state = {
    activePtyIds: new Set(['s1']),
    attentionSessions,
    responseReadySessions,
    sessionBusyState,
    gridCards: new Map(),
  };
  const update = makeIndicatorFn(document, state);

  // First call: s1 running — no cleanup.
  update();
  assert.ok(state.attentionSessions.has('s1'), 's1 attention preserved while running');

  // s1 stops.
  state.activePtyIds = new Set();
  const item1 = document.querySelector('[data-session-id="s1"]');
  item1.classList.add('needs-attention', 'response-ready', 'cli-busy');
  update();

  assert.ok(!state.attentionSessions.has('s1'), 'attentionSessions cleared when pty stops');
  assert.ok(!state.responseReadySessions.has('s1'), 'responseReadySessions cleared');
  assert.ok(!state.sessionBusyState.has('s1'), 'sessionBusyState cleared');
  assert.ok(!item1.classList.contains('needs-attention'), '.needs-attention removed');
  assert.ok(!item1.classList.contains('response-ready'), '.response-ready removed');
  assert.ok(!item1.classList.contains('cli-busy'), '.cli-busy removed');

  window.close();
});

test('updateRunningIndicators: gridCards loop runs on every call, not gated by pty-set', () => {
  const dom = buildDom();
  const { window } = dom;
  const { document } = window;

  // Build a fake grid card with the expected structure.
  const makeCard = (doc) => {
    const card = doc.createElement('div');
    card.innerHTML = `
      <div class="grid-card-dot"></div>
      <div class="grid-card-footer"><span>Stopped</span></div>
      <button class="grid-card-stop-btn" style="display:none"></button>
    `;
    return card;
  };

  const card = makeCard(document);
  const state = {
    activePtyIds: new Set(['s1']),
    attentionSessions: new Set(),
    responseReadySessions: new Set(),
    sessionBusyState: new Map([['s1', false]]),
    gridCards: new Map([['s1', card]]),
  };
  const update = makeIndicatorFn(document, state);

  // First call: s1 running, not busy.
  update();
  assert.equal(card.querySelector('.grid-card-dot').className, 'grid-card-dot running',
    'grid card dot is running');
  assert.equal(card.querySelector('.grid-card-footer').children[0].textContent, 'Running',
    'grid card footer shows Running');
  assert.equal(card.querySelector('.grid-card-stop-btn').style.display, '',
    'stop button visible');

  // Second call: pty-set UNCHANGED, but sessionBusyState changed to busy.
  // The gridCards loop must still run (not gated).
  state.sessionBusyState.set('s1', true);
  update();
  assert.equal(card.querySelector('.grid-card-dot').className, 'grid-card-dot busy',
    'grid card dot updated to busy on second call even though pty-set unchanged');

  window.close();
});

test('updateRunningIndicators: empty pty-set — all sessions marked stopped', () => {
  const dom = buildDom();
  const { window } = dom;
  const { document } = window;

  const state = {
    activePtyIds: new Set(),
    attentionSessions: new Set(),
    responseReadySessions: new Set(),
    sessionBusyState: new Map(),
    gridCards: new Map(),
  };
  const update = makeIndicatorFn(document, state);

  // Prime: first call with empty set.
  update();

  const items = document.querySelectorAll('.session-item');
  for (const item of items) {
    assert.ok(!item.classList.contains('has-running-pty'),
      `${item.dataset.sessionId} must not have has-running-pty when idle`);
  }

  window.close();
});
