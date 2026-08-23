// Regression coverage: a search hit that lives only inside a subagent
// transcript used to vanish entirely from the sidebar. See
// .ai/contexts/subagent-observability.md for the full trace of how the hit
// reaches searchMatchIds and where it used to get dropped at render time
// (sidebar.js processProjectSessions()'s keepForOrphanSubagents guard, and
// the orphan-bucket default-collapsed state).

const test = require('node:test');
const assert = require('node:assert/strict');

const { setupSidebarDom, makeSampleProject } = require('./dom-setup');

// Mirrors what app.js's refreshSidebar() produces when only a subagent
// session matched the search: `sessions` is reduced to just the matching
// subagent, the parent top-level session is filtered out entirely.
function projectWithOnlySubagentHit() {
  return makeSampleProject({
    sessions: [
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
  });
}

test('search hit that is only a subagent: project renders and the subagent is visible unfolded', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.window.searchMatchIds = new Set(['sub:s-top-1:agent-1']);

    ctx.sidebar.renderProjects([projectWithOnlySubagentHit()], true);

    const projectGroup = ctx.document.getElementById(ctx.sidebar.folderId('/home/dev/myproj'));
    assert.ok(projectGroup, 'project group must still be rendered when its only match is a subagent');

    const subagentItem = ctx.document.getElementById('si-sub:s-top-1:agent-1');
    assert.ok(subagentItem, 'the matching subagent item must be rendered');

    const orphanGroup = projectGroup.querySelector('.sidebar-orphan-subagents');
    assert.ok(orphanGroup, 'orphan subagent bucket must be rendered');
    assert.ok(!orphanGroup.classList.contains('collapsed'), 'orphan bucket must be expanded during an active search, not hidden behind a click');
  } finally {
    ctx.destroy();
  }
});

test('regression: showStarredOnly still hides a project whose only sessions are an unstarred top-level plus a subagent', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.window.showStarredOnly = true;

    const project = makeSampleProject({
      sessions: [
        {
          sessionId: 's-top-1',
          name: 'main session',
          summary: 'top level 1',
          modified: '2026-05-22T10:00:00.000Z',
          starred: false,
          archived: 0,
          messageCount: 12,
        },
        {
          sessionId: 's-sub-1',
          parentSessionId: 's-top-1',
          subagentType: 'explore',
          description: 'explore subagent',
          modified: '2026-05-22T09:59:00.000Z',
          messageCount: 3,
        },
      ],
    });

    ctx.sidebar.renderProjects([project], true);

    const projectGroup = ctx.document.getElementById(ctx.sidebar.folderId('/home/dev/myproj'));
    assert.equal(projectGroup, null, 'a subagent must never keep a project alive under showStarredOnly — subagents are never starred');
  } finally {
    ctx.destroy();
  }
});
