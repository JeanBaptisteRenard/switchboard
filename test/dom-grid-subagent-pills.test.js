// Grid-view subagent pills: handler arity regression.
//
// preload.js exposes onSubagentSpawned/onSubagentCompleted as
// `cb => ipcRenderer.on(channel, (_e, payload) => cb(payload))` — the callback
// receives the payload as its FIRST and only argument. grid-view.js registered
// `(event, data) => …`, so `data` was always undefined, the guard returned
// immediately, and the grid card pills never appeared. sidebar.js has the
// correct arity; this suite pins it for grid-view too.

const test = require('node:test');
const assert = require('node:assert/strict');

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function setupGridDom() {
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="terminals"></div></body></html>', {
    url: 'http://localhost/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;

  // Capture the listeners grid-view.js registers at eval time, exactly the way
  // preload.js would call them back: one argument, the payload.
  const apiTarget = {
    platform: 'linux',
    onSubagentSpawned: (cb) => { apiTarget._spawnedCb = cb; },
    onSubagentCompleted: (cb) => { apiTarget._completedCb = cb; },
  };
  window.api = new Proxy(apiTarget, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return () => Promise.resolve({ ok: true });
    },
  });

  const stubGlobals = {
    terminalsEl: window.document.getElementById('terminals'),
    openSessions: new Map(),
    sessionMap: new Map(),
    activePtyIds: new Set(),
    activeSessionId: null,
    sortedOrder: [],
    cachedProjects: [],
    isMac: false,
    showSession: () => {},
    fitAndScroll: () => {},
    cleanDisplayName: (s) => s,
    formatDate: () => '',
  };
  for (const [k, v] of Object.entries(stubGlobals)) {
    Object.defineProperty(window, k, { value: v, writable: true, configurable: true });
  }

  const ctx = dom.getInternalVMContext();
  for (const file of ['utils.js', 'shortcuts.js', 'grid-view.js']) {
    vm.runInContext(fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8'), ctx, { filename: file });
  }

  const inCtx = (code) => vm.runInContext(code, ctx);

  // Seed a grid card for the parent so updateGridSubagentPills has somewhere
  // to render. `gridCards` is a grid-view.js lexical binding, not a window
  // property, so it must be reached through the context.
  const card = window.document.createElement('div');
  card.className = 'grid-card';
  window.document.getElementById('terminals').appendChild(card);
  inCtx('globalThis.__seedCard = (el, id) => gridCards.set(id, el);');
  window.__seedCard(card, 'parent-1');

  return {
    window,
    card,
    inCtx,
    emitSpawned: (payload) => apiTarget._spawnedCb(payload),
    emitCompleted: (payload) => apiTarget._completedCb(payload),
    hasSpawnedCb: () => typeof apiTarget._spawnedCb === 'function',
    destroy: () => window.close(),
  };
}

test('subagent-spawned: grid-view reads the payload from its first argument and renders a pill', () => {
  const ctx = setupGridDom();
  try {
    assert.ok(ctx.hasSpawnedCb(), 'grid-view registered a subagent-spawned listener');

    // preload.js calls back with the payload alone — no leading event object.
    ctx.emitSpawned({ parentSessionId: 'parent-1', agentId: 'agent-1', subagentType: 'explore' });

    assert.equal(ctx.inCtx('activeSubagents.get("parent-1")?.size ?? 0'), 1,
      'the spawn must be tracked — a handler declared (event, data) sees data === undefined and bails');
    const pills = ctx.card.querySelectorAll('.grid-subagent-pills .grid-subagent-pill');
    assert.equal(pills.length, 1, 'one pill rendered on the parent card');
  } finally {
    ctx.destroy();
  }
});

test('subagent-completed: grid-view reads the payload from its first argument and drops the pill', () => {
  const ctx = setupGridDom();
  try {
    ctx.emitSpawned({ parentSessionId: 'parent-1', agentId: 'agent-1', subagentType: 'explore' });
    assert.equal(ctx.inCtx('activeSubagents.get("parent-1")?.size ?? 0'), 1);

    ctx.emitCompleted({ parentSessionId: 'parent-1', agentId: 'agent-1' });

    assert.equal(ctx.inCtx('activeSubagents.has("parent-1")'), false, 'completion clears the parent entry');
    assert.equal(ctx.card.querySelector('.grid-subagent-pills'), null, 'the pill row is removed');
  } finally {
    ctx.destroy();
  }
});

test('a heartbeat for an untracked agent does not create a grid pill', () => {
  const ctx = setupGridDom();
  try {
    ctx.emitSpawned({ parentSessionId: 'parent-1', agentId: 'agent-1', subagentType: 'explore', _heartbeat: true });

    assert.equal(ctx.inCtx('activeSubagents.has("parent-1")'), false,
      'a heartbeat means "still alive", never "started"');
    assert.equal(ctx.card.querySelector('.grid-subagent-pills'), null);
  } finally {
    ctx.destroy();
  }
});

test('a heartbeat for a tracked agent refreshes its liveness stamp', () => {
  const ctx = setupGridDom();
  try {
    ctx.emitSpawned({ parentSessionId: 'parent-1', agentId: 'agent-1', subagentType: 'explore' });
    const first = ctx.inCtx('activeSubagents.get("parent-1").get("agent-1").spawnedAt');

    ctx.window.Date.now = () => first + 40000;
    ctx.emitSpawned({ parentSessionId: 'parent-1', agentId: 'agent-1', subagentType: 'explore', _heartbeat: true });

    const after = ctx.inCtx('activeSubagents.get("parent-1").get("agent-1").spawnedAt');
    assert.ok(after > first, 'the heartbeat refreshed the stamp the 60s prune reads');
  } finally {
    ctx.destroy();
  }
});
