// Coverage for the capped subagent lists — see
// .ai/contexts/subagent-observability.md (capped subagent lists).
//
// Both subagent lists (a parent's children under the "N subagents" caret, and
// the project-level orphan bucket) render, by default, the union of the active
// subagents and the SUBAGENT_PREVIEW_COUNT (10) most recent ones. The rest is
// not merely hidden: its DOM is never built until the user clicks
// "+ N more". The load-bearing assertions below are the ones checking that a
// capped-out item has NO element in the document at all.

const test = require('node:test');
const assert = require('node:assert/strict');

const { setupSidebarDom } = require('./dom-setup');

const BASE = Date.parse('2026-05-22T10:00:00Z');
const at = (offsetMs) => new Date(BASE + offsetMs).toISOString();

// Real subagent sessionId convention (read-session-file.js:subagentSessionId),
// so the id sidebar.js rebuilds from an IPC payload matches the rendered item.
const subId = (parentId, agentId) => `sub:${parentId}:${agentId}`;

// n subagents under `parentId`, agent-0 newest … agent-(n-1) oldest.
function subagents(parentId, n) {
  const list = [];
  for (let i = 0; i < n; i++) {
    list.push({
      sessionId: subId(parentId, 'agent-' + i),
      parentSessionId: parentId,
      agentId: 'agent-' + i,
      subagentType: 'explore',
      description: 'child ' + i,
      modified: at(-1000 * (i + 1)),
      messageCount: 1,
    });
  }
  return list;
}

function projectWithChildren(n = 15) {
  return {
    projectPath: '/home/dev/capped',
    sessions: [
      { sessionId: 's-top-1', name: 'main', summary: 'main', modified: at(0), archived: 0 },
      ...subagents('s-top-1', n),
    ],
  };
}

function projectWithOrphans(n = 15) {
  return {
    projectPath: '/home/dev/capped-orphans',
    sessions: [
      { sessionId: 's-top-1', name: 'main', summary: 'main', modified: at(0), archived: 0 },
      ...subagents('s-ghost-parent', n),
    ],
  };
}

const itemsIn = (el) => el.querySelectorAll('.sidebar-subagent').length;

// ---------------------------------------------------------------------------
// Children under a parent caret
// ---------------------------------------------------------------------------

test('children: only the 10 most recent are built — the 11th has no DOM node at all', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.sidebar.renderProjects([projectWithChildren(15)], true);

    const container = ctx.document.getElementById('subc-s-top-1');
    assert.ok(container, 'children container must exist');
    assert.equal(itemsIn(container), 10, 'exactly SUBAGENT_PREVIEW_COUNT children rendered');

    for (let i = 0; i < 10; i++) {
      assert.ok(ctx.document.getElementById('si-' + subId('s-top-1', 'agent-' + i)),
        `agent-${i} is among the 10 most recent and must be rendered`);
    }
    for (let i = 10; i < 15; i++) {
      assert.equal(ctx.document.getElementById('si-' + subId('s-top-1', 'agent-' + i)), null,
        `agent-${i} is capped out — its node must NOT be built (lazy, not just hidden)`);
    }
  } finally {
    ctx.destroy();
  }
});

test('children: the caret still announces the full child count', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.sidebar.renderProjects([projectWithChildren(15)], true);
    const caret = ctx.document.getElementById('sub-caret-s-top-1');
    assert.ok(caret, 'caret must exist');
    assert.match(caret.textContent, /15 subagents/,
      'the caret counts every child, not only the rendered ones');
  } finally {
    ctx.destroy();
  }
});

test('children: an active but old subagent stays visible on top of the 10 most recent', () => {
  const ctx = setupSidebarDom();
  try {
    const project = projectWithChildren(15);
    ctx.sidebar.renderProjects([project], true);

    // agent-14 is the oldest — capped out on the first pass.
    assert.equal(ctx.document.getElementById('si-' + subId('s-top-1', 'agent-14')), null,
      'precondition: the oldest child is capped out while idle');

    ctx.emitSubagentSpawned({ parentSessionId: 's-top-1', agentId: 'agent-14', subagentType: 'explore' });
    ctx.sidebar.renderProjects([project], false);

    const item = ctx.document.getElementById('si-' + subId('s-top-1', 'agent-14'));
    assert.ok(item, 'a running subagent must be rendered however old its transcript is');
    assert.ok(item.classList.contains('running'), 'and it must carry the running indicator');

    const container = ctx.document.getElementById('subc-s-top-1');
    assert.equal(itemsIn(container), 11, '10 most recent + 1 active = 11 rendered children');
  } finally {
    ctx.destroy();
  }
});

test('children: the "+ N more" toggle counts the unbuilt remainder', () => {
  const ctx = setupSidebarDom();
  try {
    const project = projectWithChildren(15);
    ctx.sidebar.renderProjects([project], true);

    const toggle = ctx.document.getElementById('submore-s-top-1');
    assert.ok(toggle, 'a "+ N more" toggle must be emitted when children are capped out');
    assert.equal(toggle.textContent, '+ 5 more');

    ctx.emitSubagentSpawned({ parentSessionId: 's-top-1', agentId: 'agent-14', subagentType: 'explore' });
    ctx.sidebar.renderProjects([project], false);
    assert.equal(ctx.document.getElementById('submore-s-top-1').textContent, '+ 4 more',
      'promoting an active subagent shrinks the remainder');
  } finally {
    ctx.destroy();
  }
});

test('children: no "+ N more" toggle when the list fits under the cap', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.sidebar.renderProjects([projectWithChildren(10)], true);
    assert.equal(ctx.document.getElementById('submore-s-top-1'), null,
      'a list of exactly 10 must not grow a toggle');
    assert.equal(itemsIn(ctx.document.getElementById('subc-s-top-1')), 10);
  } finally {
    ctx.destroy();
  }
});

test('children: clicking "+ N more" builds the remainder', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.sidebar.renderProjects([projectWithChildren(15)], true);

    ctx.document.getElementById('submore-s-top-1').click();

    const container = ctx.document.getElementById('subc-s-top-1');
    assert.equal(itemsIn(container), 15, 'every child is rendered after the click');
    for (let i = 10; i < 15; i++) {
      assert.ok(ctx.document.getElementById('si-' + subId('s-top-1', 'agent-' + i)),
        `agent-${i} must be built by the click`);
    }
    assert.equal(ctx.document.getElementById('submore-s-top-1'), null,
      'the toggle removes itself once the remainder is built');
  } finally {
    ctx.destroy();
  }
});

test('children: the expanded remainder survives a re-render', () => {
  const ctx = setupSidebarDom();
  try {
    const project = projectWithChildren(15);
    ctx.sidebar.renderProjects([project], true);
    ctx.document.getElementById('submore-s-top-1').click();

    ctx.sidebar.renderProjects([project], false);

    const container = ctx.document.getElementById('subc-s-top-1');
    assert.equal(itemsIn(container), 15,
      'a re-render must not collapse a remainder the user expanded');
    assert.ok(ctx.document.getElementById('si-' + subId('s-top-1', 'agent-14')),
      'the oldest child must still be in the DOM after the re-render');
    assert.equal(ctx.document.getElementById('submore-s-top-1'), null,
      'and the toggle must not come back');
  } finally {
    ctx.destroy();
  }
});

// ---------------------------------------------------------------------------
// Project-level orphan bucket
// ---------------------------------------------------------------------------

test('orphans: only the 10 most recent are built — the 11th has no DOM node at all', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.sidebar.renderProjects([projectWithOrphans(15)], true);

    const group = ctx.document.querySelector('.sidebar-orphan-subagents');
    assert.ok(group, 'orphan bucket must exist');
    assert.equal(itemsIn(group), 10, 'exactly SUBAGENT_PREVIEW_COUNT orphans rendered');
    assert.equal(group.querySelector('.orphan-count').textContent, '15',
      'the label still counts every orphan');

    for (let i = 10; i < 15; i++) {
      assert.equal(ctx.document.getElementById('si-' + subId('s-ghost-parent', 'agent-' + i)), null,
        `orphan agent-${i} is capped out — its node must NOT be built`);
    }
  } finally {
    ctx.destroy();
  }
});

test('orphans: an active but old orphan stays visible', () => {
  const ctx = setupSidebarDom();
  try {
    const project = projectWithOrphans(15);
    ctx.sidebar.renderProjects([project], true);
    assert.equal(ctx.document.getElementById('si-' + subId('s-ghost-parent', 'agent-14')), null,
      'precondition: the oldest orphan is capped out while idle');

    ctx.emitSubagentSpawned({ parentSessionId: 's-ghost-parent', agentId: 'agent-14', subagentType: 'explore' });
    ctx.sidebar.renderProjects([project], false);

    assert.ok(ctx.document.getElementById('si-' + subId('s-ghost-parent', 'agent-14')),
      'a running orphan must be rendered however old its transcript is');
    assert.equal(itemsIn(ctx.document.querySelector('.sidebar-orphan-subagents')), 11);
  } finally {
    ctx.destroy();
  }
});

test('orphans: clicking "+ N more" builds the remainder and it survives a re-render', () => {
  const ctx = setupSidebarDom();
  try {
    const project = projectWithOrphans(15);
    ctx.sidebar.renderProjects([project], true);

    const fId = ctx.sidebar.folderId(project.projectPath);
    const toggle = ctx.document.getElementById('submore-' + fId);
    assert.ok(toggle, 'orphan bucket must emit a "+ N more" toggle');
    assert.equal(toggle.textContent, '+ 5 more');

    toggle.click();
    assert.equal(itemsIn(ctx.document.querySelector('.sidebar-orphan-subagents')), 15,
      'every orphan is rendered after the click');

    ctx.sidebar.renderProjects([project], false);
    assert.equal(itemsIn(ctx.document.querySelector('.sidebar-orphan-subagents')), 15,
      'a re-render must not collapse a remainder the user expanded');
    assert.equal(ctx.document.getElementById('submore-' + fId), null,
      'and the toggle must not come back');
  } finally {
    ctx.destroy();
  }
});

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

test('search: an active search bypasses the cap so no hit is hidden behind a click', () => {
  const ctx = setupSidebarDom();
  try {
    const project = projectWithOrphans(15);
    ctx.window.searchMatchIds = new Set(project.sessions.map(s => s.sessionId));
    ctx.sidebar.renderProjects([project], true);

    assert.equal(itemsIn(ctx.document.querySelector('.sidebar-orphan-subagents')), 15,
      'every matched orphan must be rendered during a search');
    assert.equal(ctx.document.getElementById('submore-' + ctx.sidebar.folderId(project.projectPath)), null,
      'no "+ N more" toggle during a search');
  } finally {
    ctx.destroy();
  }
});
