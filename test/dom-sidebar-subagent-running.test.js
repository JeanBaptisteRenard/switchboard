// Regression coverage for issue #129 — sidebar subagent rows never showed a
// "running" indicator. buildSubagentItem() used to derive it from
// activePtyIds.has(session.sessionId), which is structurally always false
// for a subagent (it runs inside its parent's process, no PTY of its own).
// The real signal is the subagent-spawned/subagent-completed IPC pair
// (session-transitions.js:detectSubagentTransitions()) — this suite drives
// that pair via the dom-setup.js test harness and checks:
//
//   1. spawn → .running on the item + its dot
//   2. complete → .running removed
//   3. a full renderProjects() re-render while a spawn is still active keeps
//      .running (state lives in activeSubagentsByParent, not just the
//      one-off DOM toggle)
//   4. a collapsed parent's caret gets a has-running-child badge while a
//      child is active, and loses it on completion

const test = require('node:test');
const assert = require('node:assert/strict');

const { setupSidebarDom, makeSampleProject } = require('./dom-setup');

// A dedicated fixture using the real subagent sessionId convention
// (`sub:<parentSessionId>:<agentId>` — read-session-file.js:subagentSessionId)
// so the id sidebar.js reconstructs from the IPC payload
// (parentSessionId + agentId) actually matches the rendered element's id.
function projectWithLiveSubagent(overrides = {}) {
  return makeSampleProject({
    sessions: [
      {
        sessionId: 's-top-1',
        name: 'main session',
        summary: 'top level 1',
        modified: '2026-05-22T10:00:00.000Z',
        starred: false,
        archived: 0,
        messageCount: 1,
      },
      {
        sessionId: 'sub:s-top-1:agent-1',
        parentSessionId: 's-top-1',
        agentId: 'agent-1',
        subagentType: 'explore',
        description: 'explore subagent',
        modified: '2026-05-22T09:59:00.000Z',
        messageCount: 1,
      },
    ],
    ...overrides,
  });
}

test('subagent-spawned: .running lands on the subagent item + its dot', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.sidebar.renderProjects([projectWithLiveSubagent()], true);
    const item = ctx.document.getElementById('si-sub:s-top-1:agent-1');
    assert.ok(item, 'subagent item must be rendered');
    assert.ok(!item.classList.contains('running'), 'not running before spawn event');

    ctx.emitSubagentSpawned({ parentSessionId: 's-top-1', agentId: 'agent-1', subagentType: 'explore' });

    assert.ok(item.classList.contains('running'), '.running set on the subagent item after spawn');
    const dot = item.querySelector('.session-status-dot');
    assert.ok(dot.classList.contains('running'), '.running set on the dot after spawn');
  } finally {
    ctx.destroy();
  }
});

test('subagent-completed: .running is removed again', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.sidebar.renderProjects([projectWithLiveSubagent()], true);
    const item = ctx.document.getElementById('si-sub:s-top-1:agent-1');

    ctx.emitSubagentSpawned({ parentSessionId: 's-top-1', agentId: 'agent-1', subagentType: 'explore' });
    assert.ok(item.classList.contains('running'), 'running after spawn');

    ctx.emitSubagentCompleted({ parentSessionId: 's-top-1', agentId: 'agent-1' });
    assert.ok(!item.classList.contains('running'), '.running removed after completed');
    assert.ok(!item.querySelector('.session-status-dot').classList.contains('running'), 'dot no longer running');
  } finally {
    ctx.destroy();
  }
});

test('a full sidebar re-render while a subagent is still active keeps .running (state, not just the DOM toggle)', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.sidebar.renderProjects([projectWithLiveSubagent()], true);
    ctx.emitSubagentSpawned({ parentSessionId: 's-top-1', agentId: 'agent-1', subagentType: 'explore' });

    const before = ctx.document.getElementById('si-sub:s-top-1:agent-1');
    assert.ok(before.classList.contains('running'), 'running before re-render');

    // Full rebuild — morphdom reconciles against a freshly-built tree.
    // buildSubagentItem must re-derive .running from activeSubagentsByParent,
    // not rely on the one-off classList.toggle from the spawn event.
    ctx.sidebar.renderProjects([projectWithLiveSubagent()], false);

    const after = ctx.document.getElementById('si-sub:s-top-1:agent-1');
    assert.ok(after, 'subagent item still present after re-render');
    assert.ok(after.classList.contains('running'), '.running survives a full renderProjects() re-render');
  } finally {
    ctx.destroy();
  }
});

test('collapsed parent: caret gets has-running-child while a child subagent is active, loses it on completion', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.sidebar.renderProjects([projectWithLiveSubagent()], true);
    const caret = ctx.document.getElementById('sub-caret-s-top-1');
    assert.ok(caret, 'caret for s-top-1 must exist');
    // Default state: collapsed (sidebar.js:38-43 default), no running children yet.
    assert.ok(!caret.classList.contains('expanded'), 'caret starts collapsed by default');
    assert.ok(!caret.classList.contains('has-running-child'), 'no badge before spawn');

    ctx.emitSubagentSpawned({ parentSessionId: 's-top-1', agentId: 'agent-1', subagentType: 'explore' });
    assert.ok(caret.classList.contains('has-running-child'), 'caret gets has-running-child badge while collapsed and a child is active');

    ctx.emitSubagentCompleted({ parentSessionId: 's-top-1', agentId: 'agent-1' });
    assert.ok(!caret.classList.contains('has-running-child'), 'badge removed once the child completes');
  } finally {
    ctx.destroy();
  }
});

test('caret badge also survives a full re-render, not just the event-driven DOM toggle', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.sidebar.renderProjects([projectWithLiveSubagent()], true);
    ctx.emitSubagentSpawned({ parentSessionId: 's-top-1', agentId: 'agent-1', subagentType: 'explore' });

    ctx.sidebar.renderProjects([projectWithLiveSubagent()], false);

    const caret = ctx.document.getElementById('sub-caret-s-top-1');
    assert.ok(caret.classList.contains('has-running-child'), 'has-running-child survives a full renderProjects() re-render');
  } finally {
    ctx.destroy();
  }
});

// --- pruneStaleSubagents() (review finding W1) ---
// A parent PTY can exit before its subagent's transcript goes 30s quiet
// (session-transitions.js's stability window) — detectSubagentTransitions()
// stops polling !exited-only sessions, so no subagent-completed event ever
// arrives for that agentId. Without a TTL, activeSubagentsByParent would keep
// it "running" forever. renderProjects() calls pruneStaleSubagents() on every
// render, so we drive the TTL by moving the jsdom realm's Date.now() forward
// (sidebar.js runs inside that realm via vm.runInContext, so this affects the
// module's own Date.now() calls) and forcing a re-render.

test('pruneStaleSubagents: a subagent with no subagent-completed for 60s+ is evicted on the next render', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.sidebar.renderProjects([projectWithLiveSubagent()], true);
    ctx.emitSubagentSpawned({ parentSessionId: 's-top-1', agentId: 'agent-1', subagentType: 'explore' });

    const caretBefore = ctx.document.getElementById('sub-caret-s-top-1');
    assert.ok(caretBefore.classList.contains('has-running-child'), 'badge set right after spawn');

    const t0 = ctx.window.Date.now();
    ctx.window.Date.now = () => t0 + 61000; // 61s later — past the 60s TTL, no completed event ever arrived

    ctx.sidebar.renderProjects([projectWithLiveSubagent()], false);

    const caretAfter = ctx.document.getElementById('sub-caret-s-top-1');
    assert.ok(!caretAfter.classList.contains('has-running-child'), 'stale entry pruned — badge cleared after TTL');
    const itemAfter = ctx.document.getElementById('si-sub:s-top-1:agent-1');
    assert.ok(!itemAfter.classList.contains('running'), 'stale subagent item no longer marked .running after TTL');
  } finally {
    ctx.destroy();
  }
});

test('pruneStaleSubagents: a subagent spawned within the last 60s is NOT evicted', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.sidebar.renderProjects([projectWithLiveSubagent()], true);
    ctx.emitSubagentSpawned({ parentSessionId: 's-top-1', agentId: 'agent-1', subagentType: 'explore' });

    const t0 = ctx.window.Date.now();
    ctx.window.Date.now = () => t0 + 30000; // 30s later — still inside the 60s TTL

    ctx.sidebar.renderProjects([projectWithLiveSubagent()], false);

    const caret = ctx.document.getElementById('sub-caret-s-top-1');
    assert.ok(caret.classList.contains('has-running-child'), 'still within TTL — badge must survive the render-time prune');
  } finally {
    ctx.destroy();
  }
});
