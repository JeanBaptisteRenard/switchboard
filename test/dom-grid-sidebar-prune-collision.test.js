// see .ai/contexts/subagent-observability.md

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function evalInWindow(dom, file) {
  const src = fs.readFileSync(file, 'utf8');
  vm.runInContext(src, dom.getInternalVMContext(), { filename: file });
}

function setupCombinedDom() {
  const dom = new JSDOM(
    '<!DOCTYPE html><html><body><div id="sidebar-content"></div><div id="stats-content"></div>' +
    '<div id="memory-content"></div><div id="placeholder"></div><div id="terminals"></div></body></html>',
    { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true }
  );
  const { window } = dom;

  const spawnedCbs = [];
  const completedCbs = [];
  const apiTarget = {
    platform: 'linux',
    onSubagentSpawned: (cb) => { spawnedCbs.push(cb); },
    onSubagentCompleted: (cb) => { completedCbs.push(cb); },
  };
  window.api = new Proxy(apiTarget, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return () => Promise.resolve({ ok: true });
    },
  });

  const stubGlobals = {
    openSessions: new Map(),
    activeSessionId: null,
    sessionMap: new Map(),
    activePtyIds: new Set(),
    sortedOrder: [],
    cachedProjects: [],
    confirmAndStopSession: () => {},
    showSession: () => {},

    sidebarContent: window.document.getElementById('sidebar-content'),
    terminalsEl: window.document.getElementById('terminals'),
    gridViewActive: false,
    isMac: false,
    replayHiddenBuffer: () => {},
    updateRunningIndicators: () => {},
    fitAndScroll: () => {},

    statsContent: window.document.getElementById('stats-content'),
    memoryContent: window.document.getElementById('memory-content'),
    pendingSessions: new Map(),
    lastActivityTime: new Map(),
    searchMatchIds: null,
    searchMatchProjectPaths: null,
    showStarredOnly: false,
    showRunningOnly: false,
    showTodayOnly: false,
    visibleSessionCount: 10,
    sessionMaxAgeDays: 3650,
    attentionSessions: new Set(),
    responseReadySessions: new Set(),
    sessionBusyState: new Map(),
    cachedAllProjects: [],
    pollActiveSessions: () => {},
    showNewSessionPopover: () => {},
    openSettingsViewer: () => {},
    showResumeSessionDialog: () => {},
    showJsonlViewer: () => {},
    forkSession: () => {},
    openSession: () => {},
    loadProjects: () => {},
    launchScheduleCreator: () => {},
    getExpandedSlugs: () => new Set(),
    saveExpandedSlugs: () => {},
  };

  for (const [k, v] of Object.entries(stubGlobals)) {
    Object.defineProperty(window, k, { value: v, writable: true, configurable: true });
  }

  const MORPHDOM_PATH = path.join(__dirname, '..', 'node_modules', 'morphdom', 'dist', 'morphdom-umd.js');
  vm.runInContext(fs.readFileSync(MORPHDOM_PATH, 'utf8'), dom.getInternalVMContext(), { filename: 'morphdom-umd.js' });

  for (const file of ['utils.js', 'icons.js', 'shortcuts.js', 'grid-view.js', 'sidebar.js']) {
    evalInWindow(dom, path.join(PUBLIC_DIR, file));
  }

  return {
    window,
    document: window.document,
    emitSubagentSpawned(payload) { for (const cb of spawnedCbs) cb(payload); },
    emitSubagentCompleted(payload) { for (const cb of completedCbs) cb(payload); },
    destroy() { window.close(); },
  };
}

function openSession(ctx, sessionId) {
  const element = ctx.document.createElement('div');
  ctx.window.openSessions.set(sessionId, { closed: false, element, terminal: { focus: () => {} } });
  ctx.window.sessionMap.set(sessionId, {
    sessionId,
    name: 'parent session',
    projectPath: '/home/dev/proj',
    modified: '2026-05-22T10:00:00.000Z',
  });
}

test('grid-view.js and sidebar.js declare no colliding top-level prune name', () => {
  const gridSrc = fs.readFileSync(path.join(PUBLIC_DIR, 'grid-view.js'), 'utf8');
  const sidebarSrc = fs.readFileSync(path.join(PUBLIC_DIR, 'sidebar.js'), 'utf8');
  const declared = (src) => [...src.matchAll(/^function\s+([A-Za-z0-9_$]+)\s*\(/gm)].map((m) => m[1]);
  const shared = declared(gridSrc).filter((name) => declared(sidebarSrc).includes(name));
  assert.deepEqual(shared, [], 'renderer files share one global scope; sidebar.js loads last and would shadow these');
});

test('a stale grid subagent is pruned by TTL when grid-view.js and sidebar.js load in index.html order', () => {
  const ctx = setupCombinedDom();
  try {
    openSession(ctx, 'parent-1');
    ctx.window.wrapInGridCard('parent-1');
    ctx.emitSubagentSpawned({ parentSessionId: 'parent-1', agentId: 'agent-1', subagentType: 'explore' });

    const cardsBefore = ctx.document.querySelectorAll('.grid-card[data-session-id="parent-1"]');
    assert.equal(cardsBefore[cardsBefore.length - 1].querySelectorAll('.grid-subagent-pill').length, 1,
      'pill renders right after spawn');

    const t0 = ctx.window.Date.now();
    ctx.window.Date.now = () => t0 + 61000;

    ctx.window.wrapInGridCard('parent-1');

    const cardsAfter = ctx.document.querySelectorAll('.grid-card[data-session-id="parent-1"]');
    const latestCard = cardsAfter[cardsAfter.length - 1];
    assert.equal(latestCard.querySelectorAll('.grid-subagent-pill').length, 0,
      'stale subagent must be pruned from the grid\'s own map');
  } finally {
    ctx.destroy();
  }
});
