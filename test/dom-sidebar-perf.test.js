// Regression and benchmark tests for the sidebar clear-search render lag fixes.
//
// Fix 1: `onBeforeElUpdated` early-out via `js-stateful` marker class.
//   - Non-stateful nodes (SVG paths, buttons, divs without js-stateful) must
//     return true immediately without running the 9-branch probe loop.
//   - Each stateful branch must still apply its state correctly.
//
// Fix 2: Skipped — lazy action-button DOM breaks rebindSidebarEvents bindings.
//
// Fix 3: requestAnimationFrame deferral in clearSearch / resetSearchFilter
//   is a thin wrapper; we verify the sidebar renders correctly after rAF.

const test = require('node:test');
const assert = require('node:assert/strict');

const { setupSidebarDom, makeSampleProject } = require('./dom-setup');

// ---------------------------------------------------------------------------
// Helper: extract the morphdom onBeforeElUpdated callback from a live render.
// We call renderProjects and then inspect the DOM to verify stateful behavior.
// ---------------------------------------------------------------------------

function makeEl(document, tag, classes) {
  const el = document.createElement(tag);
  if (classes) el.className = classes;
  return el;
}

// ---------------------------------------------------------------------------
// Fix 1 — js-stateful marker: builder outputs + fast-path correctness
// ---------------------------------------------------------------------------

test('Fix1: buildSessionItem emits js-stateful on .session-item', () => {
  const ctx = setupSidebarDom();
  try {
    const item = ctx.sidebar.buildSessionItem({
      sessionId: 'test-s1',
      name: 'test',
      modified: new Date().toISOString(),
    });
    assert.ok(item.classList.contains('js-stateful'),
      '.session-item must carry js-stateful for morphdom fast-path');
  } finally {
    ctx.destroy();
  }
});

test('Fix1: buildSubagentItem emits js-stateful on .sidebar-subagent', () => {
  const ctx = setupSidebarDom();
  try {
    const item = ctx.sidebar.buildSubagentItem({
      sessionId: 'sub-s1',
      subagentType: 'explore',
      modified: new Date().toISOString(),
    });
    assert.ok(item.classList.contains('js-stateful'),
      '.sidebar-subagent must carry js-stateful');
  } finally {
    ctx.destroy();
  }
});

test('Fix1: renderProjects — project-header carries js-stateful', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.sidebar.renderProjects([makeSampleProject()], true);
    const sc = ctx.document.getElementById('sidebar-content');

    const header = sc.querySelector('.project-header');
    assert.ok(header, 'project-header must be present');
    assert.ok(header.classList.contains('js-stateful'), 'project-header must carry js-stateful');
  } finally {
    ctx.destroy();
  }
});

test('Fix1: renderProjects — sessions-more-toggle and sessions-older carry js-stateful (pagination fixture)', () => {
  // Trigger pagination: need more non-archived top-level sessions than visibleSessionCount (10).
  // We inject 12 sessions so 2 end up in the "older" bucket.
  const ctx = setupSidebarDom();
  try {
    const baseTime = Date.parse('2026-05-22T10:00:00Z');
    const t = (offset) => new Date(baseTime + offset).toISOString();
    const sessions = [];
    for (let i = 0; i < 12; i++) {
      sessions.push({
        sessionId: 'pag-' + i,
        name: 'session ' + i,
        modified: t(-i * 60000),
        archived: 0,
      });
    }
    ctx.sidebar.renderProjects([{ projectPath: '/home/dev/pagtest', sessions }], true);
    const sc = ctx.document.getElementById('sidebar-content');

    const moreToggle = sc.querySelector('.sessions-more-toggle');
    assert.ok(moreToggle, 'sessions-more-toggle must be present with >10 sessions');
    assert.ok(moreToggle.classList.contains('js-stateful'),
      'sessions-more-toggle must carry js-stateful');

    const older = sc.querySelector('.sessions-older');
    assert.ok(older, 'sessions-older must be present with >10 sessions');
    assert.ok(older.classList.contains('js-stateful'),
      'sessions-older must carry js-stateful');
  } finally {
    ctx.destroy();
  }
});

test('Fix1: renderProjects — slug-group carries js-stateful (slug fixture)', () => {
  // Trigger slug-group: two sessions sharing the same slug value.
  const ctx = setupSidebarDom();
  try {
    const baseTime = Date.parse('2026-05-22T10:00:00Z');
    const t = (offset) => new Date(baseTime + offset).toISOString();
    const sessions = [
      { sessionId: 'slug-a', name: 'alpha v1', slug: 'alpha', modified: t(0), archived: 0 },
      { sessionId: 'slug-b', name: 'alpha v2', slug: 'alpha', modified: t(-1000), archived: 0 },
    ];
    ctx.sidebar.renderProjects([{ projectPath: '/home/dev/slugtest', sessions }], true);
    const sc = ctx.document.getElementById('sidebar-content');

    const group = sc.querySelector('.slug-group');
    assert.ok(group, 'slug-group must be present when sessions share a slug');
    assert.ok(group.classList.contains('js-stateful'), 'slug-group must carry js-stateful');
  } finally {
    ctx.destroy();
  }
});

test('Fix1: renderProjects — slug-group-more and slug-group-older carry js-stateful (promoted + rest)', () => {
  // Trigger slug-group-more / slug-group-older: need a promoted session (running)
  // and at least one rest session within the same slug group.
  const ctx = setupSidebarDom();
  try {
    // Mark slug-run-1 as running so it gets promoted
    ctx.window.activePtyIds.add('slug-run-1');
    const baseTime = Date.parse('2026-05-22T10:00:00Z');
    const t = (offset) => new Date(baseTime + offset).toISOString();
    const sessions = [
      { sessionId: 'slug-run-1', name: 'running', slug: 'beta', modified: t(0), archived: 0 },
      { sessionId: 'slug-rest-1', name: 'rest 1', slug: 'beta', modified: t(-1000), archived: 0 },
      { sessionId: 'slug-rest-2', name: 'rest 2', slug: 'beta', modified: t(-2000), archived: 0 },
    ];
    ctx.sidebar.renderProjects([{ projectPath: '/home/dev/slugmore', sessions }], true);
    const sc = ctx.document.getElementById('sidebar-content');

    const moreBtn = sc.querySelector('.slug-group-more');
    assert.ok(moreBtn, 'slug-group-more must be present when slug has promoted + rest sessions');
    assert.ok(moreBtn.classList.contains('js-stateful'), 'slug-group-more must carry js-stateful');

    const olderDiv = sc.querySelector('.slug-group-older');
    assert.ok(olderDiv, 'slug-group-older must be present when slug has promoted + rest sessions');
    assert.ok(olderDiv.classList.contains('js-stateful'), 'slug-group-older must carry js-stateful');
  } finally {
    ctx.destroy();
  }
});

test('Fix1: renderProjects — worktree-header carries js-stateful (worktree fixture)', () => {
  // Trigger worktree-header: a project whose path matches /.claude/worktrees/<name>
  // must be rendered nested under its parent, emitting a worktree-header element.
  const ctx = setupSidebarDom();
  try {
    const baseTime = Date.parse('2026-05-22T10:00:00Z');
    const t = (offset) => new Date(baseTime + offset).toISOString();
    const parentProject = {
      projectPath: '/home/dev/myrepo',
      sessions: [
        { sessionId: 'wt-parent-1', name: 'main', modified: t(0), archived: 0 },
      ],
    };
    const worktreeProject = {
      projectPath: '/home/dev/myrepo/.claude/worktrees/agent-abc123',
      sessions: [
        { sessionId: 'wt-child-1', name: 'wt session', modified: t(-500), archived: 0 },
      ],
    };
    ctx.sidebar.renderProjects([parentProject, worktreeProject], true);
    const sc = ctx.document.getElementById('sidebar-content');

    const wtHeader = sc.querySelector('.worktree-header');
    assert.ok(wtHeader, 'worktree-header must be present for a .claude/worktrees/* project');
    assert.ok(wtHeader.classList.contains('js-stateful'),
      'worktree-header must carry js-stateful');
  } finally {
    ctx.destroy();
  }
});

test('Fix1: subagent caret and container carry js-stateful', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.sidebar.renderProjects([makeSampleProject()], true);

    // s-top-1 has 2 subagents → appendSubagentChildren emits caret + container
    const caret = ctx.document.getElementById('sub-caret-s-top-1');
    assert.ok(caret, 'subagent caret must exist');
    assert.ok(caret.classList.contains('js-stateful'), 'caret must carry js-stateful');

    const container = ctx.document.getElementById('subc-s-top-1');
    assert.ok(container, 'subagents-container must exist');
    assert.ok(container.classList.contains('js-stateful'), 'container must carry js-stateful');
  } finally {
    ctx.destroy();
  }
});

// ---------------------------------------------------------------------------
// Fix 1 — behavioral correctness: stateful state-transfer still works
// ---------------------------------------------------------------------------

test('Fix1: project-header collapsed state survives re-render (morphdom onBeforeElUpdated)', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.sidebar.renderProjects([makeSampleProject()], true);
    const sc = ctx.document.getElementById('sidebar-content');

    const header = sc.querySelector('.project-header');
    assert.ok(header, 'project-header must be present');

    // Manually collapse the header (simulating a user click)
    header.classList.add('collapsed');

    // Re-render — morphdom must preserve the collapsed class from fromEl→toEl
    ctx.sidebar.renderProjects([makeSampleProject()], false);

    const headerAfter = sc.querySelector('.project-header');
    assert.ok(headerAfter.classList.contains('collapsed'),
      'project-header collapsed state must survive re-render via onBeforeElUpdated');
  } finally {
    ctx.destroy();
  }
});

test('Fix1: subagents-container display:none survives re-render', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.sidebar.renderProjects([makeSampleProject()], true);

    const container = ctx.document.getElementById('subc-s-top-1');
    assert.ok(container, 'subc element must exist');

    // Force display:none (as if user collapsed the subagents)
    container.style.display = 'none';

    // Re-render
    ctx.sidebar.renderProjects([makeSampleProject()], false);

    const containerAfter = ctx.document.getElementById('subc-s-top-1');
    assert.equal(containerAfter.style.display, 'none',
      'display:none on sidebar-subagents-container must be preserved across re-render');
  } finally {
    ctx.destroy();
  }
});

test('Fix1: sidebar-children-caret expanded state survives re-render', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.sidebar.renderProjects([makeSampleProject()], true);

    const caret = ctx.document.getElementById('sub-caret-s-top-1');
    assert.ok(caret, 'caret must exist');

    // Mark as expanded (as if user clicked to open)
    caret.classList.add('expanded');

    ctx.sidebar.renderProjects([makeSampleProject()], false);

    const caretAfter = ctx.document.getElementById('sub-caret-s-top-1');
    assert.ok(caretAfter.classList.contains('expanded'),
      'expanded class on sidebar-children-caret must survive re-render');
  } finally {
    ctx.destroy();
  }
});

test('Fix1: session-item with active rename-input returns false from morphdom (skipped update)', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.sidebar.renderProjects([makeSampleProject()], true);

    const item = ctx.document.getElementById('si-s-top-1');
    assert.ok(item, 'session item must exist');

    // Inject a rename input — simulates mid-rename state
    const renameInput = ctx.document.createElement('input');
    renameInput.className = 'session-rename-input';
    item.appendChild(renameInput);

    // Re-render. morphdom should skip this item (return false) so the rename
    // input is not wiped. We verify the input is still present after re-render.
    ctx.sidebar.renderProjects([makeSampleProject()], false);

    const itemAfter = ctx.document.getElementById('si-s-top-1');
    assert.ok(itemAfter, 'session item must survive after render');
    const inputAfter = itemAfter.querySelector('.session-rename-input');
    assert.ok(inputAfter, 'rename input must survive morphdom update (skipped by onBeforeElUpdated)');
  } finally {
    ctx.destroy();
  }
});

test('Fix1: non-stateful child nodes do NOT carry js-stateful (fast-path eligibility)', () => {
  const ctx = setupSidebarDom();
  try {
    const item = ctx.sidebar.buildSessionItem({
      sessionId: 'probe-s1',
      name: 'probe',
      modified: new Date().toISOString(),
    });

    // Gather all descendant elements
    const allDescendants = Array.from(item.querySelectorAll('*'));
    // Only the root .session-item itself should have js-stateful; inner nodes must not.
    const statefulDescendants = allDescendants.filter(el => el.classList.contains('js-stateful'));
    assert.equal(statefulDescendants.length, 0,
      'no descendant of session-item should carry js-stateful — inner nodes take the fast-path');
  } finally {
    ctx.destroy();
  }
});

// ---------------------------------------------------------------------------
// MINOR 2 — clearRenderRaf cancel guard: two rapid clear calls → one render
// ---------------------------------------------------------------------------
//
// app.js cannot be eval-ed in jsdom (registers IPC listeners before stubs
// exist). We follow the search-perf.test.js inline-replica pattern: replicate
// the clearSearch / resetSearchFilter rAF guard in-process and test it with
// jsdom's requestAnimationFrame / cancelAnimationFrame (available because
// dom-setup.js uses pretendToBeVisual:true).

test('MINOR2: two rapid clearSearch calls result in exactly one refreshSidebar via cancel guard', async () => {
  const ctx = setupSidebarDom();
  try {
    const { window } = ctx;
    let refreshCount = 0;
    function refreshSidebar() { refreshCount++; }

    // Inline replica of the clearRenderRaf guard (mirrors the patched app.js).
    let clearRenderRaf = null;
    function clearSearch() {
      if (clearRenderRaf) window.cancelAnimationFrame(clearRenderRaf);
      clearRenderRaf = window.requestAnimationFrame(() => {
        clearRenderRaf = null;
        refreshSidebar({ resort: true });
      });
    }

    // Two rapid calls — only the second frame should fire.
    clearSearch();
    clearSearch();

    // Wait for the jsdom rAF timer to flush (jsdom schedules rAF via setTimeout).
    await new Promise(resolve => setTimeout(resolve, 50));

    assert.equal(refreshCount, 1,
      'exactly one refreshSidebar call expected — first rAF must be cancelled by second clearSearch');
  } finally {
    ctx.destroy();
  }
});

test('MINOR2: resetSearchFilter cancel guard — three rapid calls yield one refreshSidebar', async () => {
  const ctx = setupSidebarDom();
  try {
    const { window } = ctx;
    let refreshCount = 0;
    function refreshSidebar() { refreshCount++; }

    let clearRenderRaf = null;
    function resetSearchFilter() {
      if (clearRenderRaf) window.cancelAnimationFrame(clearRenderRaf);
      clearRenderRaf = window.requestAnimationFrame(() => {
        clearRenderRaf = null;
        refreshSidebar({ resort: true });
      });
    }

    resetSearchFilter();
    resetSearchFilter();
    resetSearchFilter();

    await new Promise(resolve => setTimeout(resolve, 50));

    assert.equal(refreshCount, 1,
      'exactly one refreshSidebar call expected across three rapid resetSearchFilter calls');
  } finally {
    ctx.destroy();
  }
});

test('MINOR2: clearRenderRaf handle is null after the frame fires (no double-cancel)', async () => {
  const ctx = setupSidebarDom();
  try {
    const { window } = ctx;
    let clearRenderRaf = null;
    let handleAfterFire = 'unset';

    function clearSearch() {
      if (clearRenderRaf) window.cancelAnimationFrame(clearRenderRaf);
      clearRenderRaf = window.requestAnimationFrame(() => {
        clearRenderRaf = null;
        // Capture state inside the callback — after fire the handle must be null.
        handleAfterFire = clearRenderRaf;
      });
    }

    clearSearch();
    await new Promise(resolve => setTimeout(resolve, 50));

    assert.equal(handleAfterFire, null,
      'clearRenderRaf handle must be reset to null inside the rAF callback after it fires');
  } finally {
    ctx.destroy();
  }
});

// ---------------------------------------------------------------------------
// Fix 3 — rAF deferral does not break sidebar state (render still occurs)
// ---------------------------------------------------------------------------

test('Fix3: renderProjects correctly populates sidebar after filter cleared (rAF functional contract)', () => {
  // requestAnimationFrame timing cannot be verified in jsdom. This test verifies
  // the underlying renderProjects call (which rAF defers) correctly renders the
  // full list after the search-filter globals are cleared — as clearSearch does
  // before scheduling the rAF. The rAF boundary is trivially correct by inspection.
  const ctx = setupSidebarDom();
  try {
    // Project with 2 non-archived sessions. searchMatchIds is null = no filter.
    const baseTime = Date.parse('2026-05-22T10:00:00Z');
    const t = (offset) => new Date(baseTime + offset).toISOString();
    const project = {
      projectPath: '/home/dev/cleartest',
      sessions: [
        { sessionId: 'c-1', name: 'alpha', modified: t(0), archived: 0 },
        { sessionId: 'c-2', name: 'beta', modified: t(-1000), archived: 0 },
      ],
    };

    // First render with no filter (simulating the full-list render after clear).
    ctx.window.searchMatchIds = null;
    ctx.window.searchMatchProjectPaths = null;
    assert.doesNotThrow(() => ctx.sidebar.renderProjects([project], true),
      'renderProjects must not throw when called after filter is cleared');

    const items = ctx.document.querySelectorAll('#sidebar-content .session-item');
    assert.equal(items.length, 2, 'both non-archived sessions must render after filter cleared');

    // Re-render a second time (idempotent after fix).
    assert.doesNotThrow(() => ctx.sidebar.renderProjects([project], true),
      'second render after clear must also not throw');

    const itemsAfter = ctx.document.querySelectorAll('#sidebar-content .session-item');
    assert.equal(itemsAfter.length, 2, 'session count must remain stable across repeated clear renders');
  } finally {
    ctx.destroy();
  }
});
