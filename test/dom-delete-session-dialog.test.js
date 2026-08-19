// Behavioural coverage for the Delete Session confirmation flow.
//
// The maintainer asked for a styled dialog rather than window.confirm, on the
// grounds that a native prompt blocks the whole renderer and cannot show what
// is about to be lost. These tests drive the real dialog in jsdom: that it
// reports what will be removed, that cancelling deletes nothing, and that
// confirming deletes and cleans up the renderer's own state.

const test = require('node:test');
const assert = require('node:assert/strict');

const { setupSidebarDom, makeSampleProject } = require('./dom-setup');

const SESSION = {
  sessionId: 's-top-1',
  name: 'A session worth naming',
  projectPath: '/home/u/proj',
  summary: 'summary',
};

function stubApi(window, overrides = {}) {
  const calls = { deleteSession: [], preview: [] };
  window.api = {
    deleteSessionPreview: (id) => { calls.preview.push(id); return Promise.resolve(overrides.preview ?? { ok: true, transcripts: 2, subagents: 3, running: false }); },
    deleteSession: (id) => { calls.deleteSession.push(id); return Promise.resolve(overrides.deleteResult ?? { ok: true, removed: ['x'], subagents: 3 }); },
    stopSession: () => Promise.resolve({ ok: true }),
    archiveSession: () => Promise.resolve({ ok: true }),
    worktreeStatus: () => Promise.resolve({ ok: true, total: 0, dirty: [] }),
  };
  return calls;
}

const tick = () => new Promise(r => setTimeout(r, 0));

test('the dialog names the session, the project, and what will be removed', async () => {
  const ctx = setupSidebarDom();
  try {
    stubApi(ctx.window);
    const p = ctx.sidebar.showDeleteSessionDialog(SESSION);
    await tick();

    const dialog = ctx.document.querySelector('.new-session-dialog');
    assert.ok(dialog, 'a styled dialog must be shown');
    assert.match(dialog.querySelector('h3').textContent, /A session worth naming/);
    assert.match(dialog.textContent, /Archive/, 'must point at the non-destructive alternative');
    assert.match(dialog.textContent, /cannot be undone/);

    const status = ctx.document.getElementById('dss-status');
    assert.match(status.textContent, /\/home\/u\/proj/, 'the project must be stated');
    assert.match(status.textContent, /2 files on disk/);
    assert.match(status.textContent, /3 subagent transcripts/);

    ctx.document.getElementById('dss-cancel').click();
    assert.equal(await p, false);
  } finally { ctx.destroy(); }
});

test('a session that never started is described as having no transcript', async () => {
  const ctx = setupSidebarDom();
  try {
    stubApi(ctx.window, { preview: { ok: true, transcripts: 0, subagents: 0, running: false } });
    const p = ctx.sidebar.showDeleteSessionDialog(SESSION);
    await tick();
    assert.match(ctx.document.getElementById('dss-status').textContent,
      /never started/, 'the placeholder case must be explained, not shown as "0 files"');
    ctx.document.getElementById('dss-cancel').click();
    await p;
  } finally { ctx.destroy(); }
});

test('a running session is flagged in the dialog', async () => {
  const ctx = setupSidebarDom();
  try {
    stubApi(ctx.window, { preview: { ok: true, transcripts: 1, subagents: 0, running: true } });
    const p = ctx.sidebar.showDeleteSessionDialog(SESSION);
    await tick();
    assert.match(ctx.document.getElementById('dss-status').textContent, /still running/);
    ctx.document.getElementById('dss-cancel').click();
    await p;
  } finally { ctx.destroy(); }
});

test('Escape and overlay-click both cancel, like the worktree dialog', async () => {
  for (const how of ['escape', 'overlay']) {
    const ctx = setupSidebarDom();
    try {
      stubApi(ctx.window);
      const p = ctx.sidebar.showDeleteSessionDialog(SESSION);
      await tick();
      if (how === 'escape') {
        ctx.document.dispatchEvent(new ctx.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      } else {
        ctx.document.querySelector('.new-session-overlay').click();
      }
      assert.equal(await p, false, `${how} must cancel`);
      assert.equal(ctx.document.querySelector('.new-session-overlay'), null, 'and close the dialog');
    } finally { ctx.destroy(); }
  }
});

test('confirming resolves true and closes the dialog', async () => {
  const ctx = setupSidebarDom();
  try {
    stubApi(ctx.window);
    const p = ctx.sidebar.showDeleteSessionDialog(SESSION);
    await tick();
    ctx.document.getElementById('dss-confirm').click();
    assert.equal(await p, true);
    assert.equal(ctx.document.querySelector('.new-session-overlay'), null);
  } finally { ctx.destroy(); }
});

test('a failed preview still shows the project rather than breaking the dialog', async () => {
  const ctx = setupSidebarDom();
  try {
    stubApi(ctx.window, { preview: { ok: false, error: 'boom' } });
    const p = ctx.sidebar.showDeleteSessionDialog(SESSION);
    await tick();
    assert.match(ctx.document.getElementById('dss-status').textContent, /\/home\/u\/proj/);
    ctx.document.getElementById('dss-cancel').click();
    await p;
  } finally { ctx.destroy(); }
});

// --- the button on a rendered card ---

test('the card button opens the dialog; cancelling deletes nothing', async () => {
  const ctx = setupSidebarDom();
  try {
    const calls = stubApi(ctx.window);
    // rebindSidebarEvents only wires an item it can resolve via sessionMap
    // (sidebar.js:823), so a card is inert without it — as the real app populates.
    ctx.window.sessionMap.set('s-top-1', SESSION);
    ctx.sidebar.renderProjects([makeSampleProject()], true);
    const item = ctx.document.getElementById('si-s-top-1');
    assert.ok(item, 'the session card must render');
    const btn = item.querySelector('.session-delete-btn');
    assert.ok(btn, 'the card must carry a delete button');

    btn.click();
    await tick();
    assert.ok(ctx.document.querySelector('#dss-confirm'), 'the dialog must open');
    ctx.document.getElementById('dss-cancel').click();
    await tick();
    assert.deepEqual(calls.deleteSession, [], 'cancelling must not delete');
  } finally { ctx.destroy(); }
});

test('confirming from the card deletes and forgets the session in the renderer', async () => {
  const ctx = setupSidebarDom();
  try {
    const calls = stubApi(ctx.window);
    ctx.window.pendingSessions.set('s-top-1', { session: SESSION });
    ctx.window.sessionMap.set('s-top-1', SESSION);

    ctx.sidebar.renderProjects([makeSampleProject()], true);
    ctx.document.getElementById('si-s-top-1').querySelector('.session-delete-btn').click();
    await tick();
    ctx.document.getElementById('dss-confirm').click();
    await tick(); await tick();

    assert.deepEqual(calls.deleteSession, ['s-top-1'], 'the delete must reach the main process');
    // Otherwise the sidebar re-injects the card from pendingSessions on reload.
    assert.equal(ctx.window.pendingSessions.has('s-top-1'), false, 'pending entry must be forgotten');
    assert.equal(ctx.window.sessionMap.has('s-top-1'), false, 'sessionMap entry must be forgotten');
  } finally { ctx.destroy(); }
});
