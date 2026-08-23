// Regression coverage for the project-level "Archive all sessions" button.
// See .ai/contexts/subagent-observability.md.

const test = require('node:test');
const assert = require('node:assert/strict');

const { setupSidebarDom, makeSampleProject } = require('./dom-setup');

function installRecordingApi(ctx) {
  const calls = [];
  ctx.window.api = new Proxy({}, {
    get(_target, prop) {
      return (...args) => {
        calls.push({ method: String(prop), args });
        return Promise.resolve({ ok: true });
      };
    },
  });
  return calls;
}

function archiveButtonFor(ctx, project) {
  const header = ctx.document.getElementById('ph-' + ctx.sidebar.folderId(project.projectPath));
  assert.ok(header, 'project header must render');
  const btn = header.querySelector('.project-archive-btn');
  assert.ok(btn, 'project archive button must render');
  return btn;
}

test('project archive-all: confirmation counts only top-level sessions', async () => {
  const ctx = setupSidebarDom();
  try {
    const project = makeSampleProject();
    const calls = installRecordingApi(ctx);
    let prompt = null;
    ctx.window.confirm = (message) => { prompt = message; return false; };

    ctx.sidebar.renderProjects([project], true);
    await archiveButtonFor(ctx, project).onclick(new ctx.window.MouseEvent('click'));

    assert.match(prompt, /Archive all 1 session in /,
      `confirmation must count 1 top-level session, got: ${prompt}`);
    assert.deepEqual(calls, [], 'declining the confirmation must archive nothing');
  } finally {
    ctx.destroy();
  }
});

test('project archive-all: subagents are neither archived nor stopped', async () => {
  const ctx = setupSidebarDom();
  try {
    const project = makeSampleProject();
    const calls = installRecordingApi(ctx);
    ctx.window.confirm = () => true;
    for (const id of ['s-top-1', 's-sub-1', 's-sub-2', 's-sub-orphan']) ctx.window.activePtyIds.add(id);

    ctx.sidebar.renderProjects([project], true);
    await archiveButtonFor(ctx, project).onclick(new ctx.window.MouseEvent('click'));

    const archived = calls.filter(c => c.method === 'archiveSession').map(c => c.args[0]);
    assert.deepEqual(archived, ['s-top-1'], 'only the unarchived top-level session may be archived');

    const stopped = calls.filter(c => c.method === 'stopSession').map(c => c.args[0]);
    assert.deepEqual(stopped, ['s-top-1'], 'stopSession must not reach subagent ids');

    const subagents = project.sessions.filter(s => s.parentSessionId);
    assert.ok(subagents.every(s => !s.archived), 'subagent objects must keep archived falsy');
  } finally {
    ctx.destroy();
  }
});

test('project archive-all: project survives the re-render with only subagents left', async () => {
  const ctx = setupSidebarDom();
  try {
    const project = makeSampleProject();
    installRecordingApi(ctx);
    ctx.window.confirm = () => true;

    ctx.sidebar.renderProjects([project], true);
    await archiveButtonFor(ctx, project).onclick(new ctx.window.MouseEvent('click'));

    const surviving = project.sessions.filter(s => !s.archived);
    assert.ok(surviving.length > 0 && surviving.every(s => s.parentSessionId),
      'precondition: only unarchived subagents remain after the click');

    const reloaded = { ...project, sessions: surviving };
    ctx.sidebar.renderProjects([reloaded], true);

    const header = ctx.document.getElementById('ph-' + ctx.sidebar.folderId(project.projectPath));
    assert.ok(header, 'project header must survive when unarchived subagents remain');

    const orphanGroup = ctx.document.querySelector('.sidebar-orphan-subagents');
    assert.ok(orphanGroup, 'remaining subagents must render in the orphan bucket');
    assert.equal(orphanGroup.querySelectorAll('[data-subagent]').length, surviving.length,
      'every surviving subagent must be rendered');
  } finally {
    ctx.destroy();
  }
});

test('project archive-all: guard still hides a project whose top-level sessions are filtered out', () => {
  const ctx = setupSidebarDom();
  try {
    const project = makeSampleProject();
    ctx.window.showStarredOnly = true;
    ctx.window.sessionMap.set('s-top-1', project.sessions[0]);
    project.sessions[0].starred = false;

    ctx.sidebar.renderProjects([project], true);

    assert.equal(ctx.document.getElementById('ph-' + ctx.sidebar.folderId(project.projectPath)), null,
      'an active filter with no matching top-level session must still hide the project');
  } finally {
    ctx.destroy();
  }
});

test('project archive-all: guard still renders an empty project', () => {
  const ctx = setupSidebarDom();
  try {
    const project = makeSampleProject({ sessions: [] });

    ctx.sidebar.renderProjects([project], true);

    assert.ok(ctx.document.getElementById('ph-' + ctx.sidebar.folderId(project.projectPath)),
      'a project directory with no sessions at all must keep rendering');
  } finally {
    ctx.destroy();
  }
});
