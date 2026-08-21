// Regression coverage for issue #128 (ask 4) / rehab-plan.md A3+A4 — subagent
// children rendered inside a slug group used to vanish from the sidebar.
//
// buildSlugGroup() appended its sessions via the raw buildSessionItem(session),
// never through appendSubagentChildren — only the top-level (non-grouped)
// render path called that helper. Any session rendered inside a slug group
// therefore lost its subagent caret/children, and — because the group element
// itself carries no data-session-id — the orphan-subagents pass in
// buildSessionsList() didn't recognize the grouped session as "already
// accounted for" either, so its subagents were duplicated into the project's
// "Orphan subagents" bucket instead.
//
// The fixture below reproduces the one real producer of shared slugs across
// top-level sessions in this app: schedule-runner.js's createScheduleSession()
// writes `slug: schedule.slug` on the JSONL's first line for every rerun of the
// same schedule (schedule-runner.js:176). Two reruns of the same schedule share
// a slug and land in session_cache (session-cache.js:buildProjectsFromCache)
// with identical `slug`, distinct `sessionId`/`modified`, and no
// `parentSessionId` — the shape asserted here.

const test = require('node:test');
const assert = require('node:assert/strict');

const { setupSidebarDom } = require('./dom-setup');

function scheduleRerunProject(overrides = {}) {
  const baseTime = Date.parse('2026-08-20T09:00:00Z');
  const t = (offsetMs) => new Date(baseTime + offsetMs).toISOString();
  // summary as read-session-file.js derives it for a createScheduleSession()
  // JSONL: the first user message is `'Scheduled Task: ' + schedule.prompt`,
  // which doesn't match the <scheduled-task name="..."> tag pattern, so it
  // falls through to text.slice(0, 120).
  const summary = 'Scheduled Task: Check Hacker News for the current top article and any posts related to AI docume';

  return {
    projectPath: '/home/dev/hn-watcher',
    sessions: [
      {
        sessionId: 'sched-run-1',
        slug: 'hn-top-articles',
        summary,
        firstPrompt: summary,
        modified: t(-120000), // an earlier rerun
        messageCount: 1,
        starred: false,
        archived: 0,
      },
      {
        sessionId: 'sched-run-2',
        slug: 'hn-top-articles',
        summary,
        firstPrompt: summary,
        modified: t(0), // the current (running) rerun
        messageCount: 1,
        starred: false,
        archived: 0,
      },
      {
        sessionId: 'sub:sched-run-2:agent-1',
        parentSessionId: 'sched-run-2',
        agentId: 'agent-1',
        subagentType: 'explore',
        description: 'explore subagent',
        modified: t(-1000),
        messageCount: 1,
      },
    ],
    ...overrides,
  };
}

test('a session rendered inside a slug group still gets its subagent children attached', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.window.activePtyIds.add('sched-run-2');
    ctx.sidebar.renderProjects([scheduleRerunProject()], true);

    const group = ctx.document.getElementById('slug-hn-top-articles');
    assert.ok(group, 'the two schedule reruns must be grouped by shared slug');
    assert.ok(group.classList.contains('slug-group'), 'grouped element must carry slug-group');

    const groupedSessionItems = group.querySelectorAll('.session-item:not([data-subagent])');
    assert.equal(groupedSessionItems.length, 2, 'both reruns render as session-items inside the group');

    const caret = ctx.document.getElementById('sub-caret-sched-run-2');
    assert.ok(caret, 'subagent caret for the grouped, running rerun must exist');
    assert.ok(group.contains(caret), 'the caret must be nested inside the slug group, next to its parent session-item');

    const subagentItem = ctx.document.getElementById('si-sub:sched-run-2:agent-1');
    assert.ok(subagentItem, 'the subagent item must be rendered');
    assert.ok(group.contains(subagentItem), 'the subagent item must be nested inside the slug group, not dropped to the orphan bucket');
  } finally {
    ctx.destroy();
  }
});

test('the grouped session\'s subagent is not duplicated into the project\'s orphan-subagents bucket', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.window.activePtyIds.add('sched-run-2');
    ctx.sidebar.renderProjects([scheduleRerunProject()], true);

    const orphanGroup = ctx.document.querySelector('.sidebar-orphan-subagents');
    assert.ok(!orphanGroup, 'a subagent whose parent is a grouped session is not an orphan — no orphan bucket should render');
  } finally {
    ctx.destroy();
  }
});

test('the slug-group dot lights up while one of the grouped, nested sessions has an active PTY', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.window.activePtyIds.add('sched-run-2');
    ctx.sidebar.renderProjects([scheduleRerunProject()], true);

    const dot = ctx.document.querySelector('#slug-hn-top-articles .slug-group-dot');
    assert.ok(dot, 'slug-group-dot must be rendered');
    assert.ok(dot.classList.contains('running'), 'group dot must reflect that sched-run-2 has an active PTY');
  } finally {
    ctx.destroy();
  }
});
