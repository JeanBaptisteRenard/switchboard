// Grid view: the "Group by project" display toggle.
//
// Pins the default (grouped, so an upgrade changes nobody's layout), the flat
// layout, persistence through localStorage, and the live re-layout the toggle
// performs while the grid stays open.

const test = require('node:test');
const assert = require('node:assert/strict');

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const SESSIONS = [
  { id: 's1', projectPath: '/home/jb/alpha', name: 'alpha work' },
  { id: 's2', projectPath: '/home/jb/beta', name: 'beta work' },
  { id: 's3', projectPath: '/home/jb/gamma', name: 'gamma work' },
];

function setupGridDom({ stored = null } = {}) {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>
    <div id="sidebar-content"></div>
    <div id="grid-viewer" style="display:none;">
      <div id="grid-viewer-header">
        <span id="grid-viewer-count"></span>
        <button id="grid-group-toggle-btn" type="button" aria-pressed="true">Group by project</button>
      </div>
    </div>
    <div id="terminals"></div>
  </body></html>`, {
    url: 'http://localhost/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window, window: { document } } = dom;

  // jsdom implements no layout, so focusGridCard's scrollIntoView would throw
  // and abort the tail of every focus path under test.
  window.Element.prototype.scrollIntoView = function () {};

  window.localStorage.clear();
  if (stored !== null) window.localStorage.setItem('gridGroupByProject', stored);

  window.api = new Proxy({ platform: 'linux' }, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return () => Promise.resolve({ ok: true });
    },
  });

  const sidebarContent = document.getElementById('sidebar-content');
  const terminalsEl = document.getElementById('terminals');
  const openSessions = new Map();
  const sessionMap = new Map();

  for (const s of SESSIONS) {
    sessionMap.set(s.id, { ...s, modified: Date.now() });

    const item = document.createElement('div');
    item.className = 'session-item';
    item.dataset.sessionId = s.id;
    sidebarContent.appendChild(item);

    const element = document.createElement('div');
    element.className = 'terminal-container';
    terminalsEl.appendChild(element);

    openSessions.set(s.id, {
      closed: false,
      element,
      session: sessionMap.get(s.id),
      terminal: { options: {}, focus: () => {} },
    });
  }

  const noop = () => {};
  const stubGlobals = {
    sidebarContent,
    terminalsEl,
    openSessions,
    sessionMap,
    activePtyIds: new Set(),
    activeSessionId: null,
    gridViewActive: false,
    sortedOrder: [],
    cachedProjects: [],
    isMac: false,
    placeholder: document.createElement('div'),
    terminalHeader: document.createElement('div'),
    statsViewer: document.createElement('div'),
    memoryViewer: document.createElement('div'),
    settingsViewer: document.createElement('div'),
    jsonlViewer: document.createElement('div'),
    terminalArea: document.createElement('div'),
    gridViewer: document.getElementById('grid-viewer'),
    gridViewerCount: document.getElementById('grid-viewer-count'),
    SCROLLBACK_GRID: 1000,
    SCROLLBACK_SINGLE: 10000,
    replayHiddenBuffer: noop,
    fitAndScroll: noop,
    showSession: noop,
    setActiveSession: noop,
    clearNotifications: noop,
    lruTouch: noop,
    updateRunningIndicators: noop,
    confirmAndStopSession: noop,
    suspendTerminalWebgl: noop,
    restoreTerminalWebgl: noop,
    formatDate: () => '',
  };
  for (const [k, v] of Object.entries(stubGlobals)) {
    Object.defineProperty(window, k, { value: v, writable: true, configurable: true });
  }

  const ctx = dom.getInternalVMContext();
  for (const file of ['utils.js', 'shortcuts.js', 'subagent-timing.js', 'grid-view.js']) {
    // The absolute path is what lets c8 attribute coverage to the real file.
    const full = path.join(PUBLIC_DIR, file);
    vm.runInContext(fs.readFileSync(full, 'utf8'), ctx, { filename: full });
  }
  const inCtx = (code) => vm.runInContext(code, ctx);
  inCtx('initGridGroupToggle();');

  return {
    window,
    document,
    inCtx,
    terminalsEl,
    toggleBtn: document.getElementById('grid-group-toggle-btn'),
    headings: () => [...terminalsEl.querySelectorAll('.grid-project-heading')],
    cards: () => [...terminalsEl.querySelectorAll('.grid-card')],
    destroy: () => window.close(),
  };
}

test('an unset preference groups the grid by project, as it always did', () => {
  const ctx = setupGridDom({ stored: null });
  try {
    ctx.inCtx('showGridView();');

    assert.equal(ctx.cards().length, 3);
    assert.deepEqual(
      ctx.headings().map(h => h.dataset.projectPath),
      ['/home/jb/alpha', '/home/jb/beta', '/home/jb/gamma'],
      'no stored preference must mean grouped — an upgrade changes nobody\'s layout',
    );
  } finally {
    ctx.destroy();
  }
});

test('the stored flat preference lays the grid out with no project headings', () => {
  const ctx = setupGridDom({ stored: '0' });
  try {
    ctx.inCtx('showGridView();');

    assert.equal(ctx.cards().length, 3, 'every open session still gets a card');
    assert.equal(ctx.headings().length, 0, 'flat mode emits no project heading');
  } finally {
    ctx.destroy();
  }
});

test('every card carries its project name, so the flat layout keeps project membership visible', () => {
  const ctx = setupGridDom({ stored: '0' });
  try {
    ctx.inCtx('showGridView();');

    const labels = ctx.cards().map(c => c.querySelector('.grid-card-project').textContent);
    assert.deepEqual(labels, ['jb/alpha', 'jb/beta', 'jb/gamma']);
  } finally {
    ctx.destroy();
  }
});

test('toggling to flat re-lays the open grid out immediately and persists the choice', () => {
  const ctx = setupGridDom({ stored: null });
  try {
    ctx.inCtx('showGridView();');
    assert.equal(ctx.headings().length, 3);

    ctx.toggleBtn.dispatchEvent(new ctx.window.MouseEvent('click', { bubbles: true }));

    assert.equal(ctx.headings().length, 0, 'the open grid re-lays out without a reopen');
    assert.equal(ctx.cards().length, 3, 'the cards survive the re-layout');
    assert.equal(ctx.window.localStorage.getItem('gridGroupByProject'), '0',
      'the choice must persist across restarts');
    assert.equal(ctx.toggleBtn.getAttribute('aria-pressed'), 'false');
    assert.equal(ctx.toggleBtn.classList.contains('active'), false);
  } finally {
    ctx.destroy();
  }
});

test('toggling back to grouped restores the project headings and the stored flag', () => {
  const ctx = setupGridDom({ stored: '0' });
  try {
    ctx.inCtx('showGridView();');
    assert.equal(ctx.headings().length, 0);

    ctx.toggleBtn.dispatchEvent(new ctx.window.MouseEvent('click', { bubbles: true }));

    assert.equal(ctx.headings().length, 3);
    assert.equal(ctx.cards().length, 3);
    assert.equal(ctx.window.localStorage.getItem('gridGroupByProject'), '1');
    assert.equal(ctx.toggleBtn.getAttribute('aria-pressed'), 'true');
    assert.equal(ctx.toggleBtn.classList.contains('active'), true);
  } finally {
    ctx.destroy();
  }
});

test('a session opened into an already-flat grid gets no project heading', () => {
  const ctx = setupGridDom({ stored: '0' });
  try {
    ctx.inCtx('showGridView();');

    ctx.inCtx(`
      const el = document.createElement('div');
      el.className = 'terminal-container';
      terminalsEl.appendChild(el);
      sessionMap.set('s4', { id: 's4', projectPath: '/home/jb/delta', name: 'delta work', modified: Date.now() });
      openSessions.set('s4', { closed: false, element: el, session: sessionMap.get('s4'), terminal: { options: {}, focus: () => {} } });
      wrapInGridCard('s4');
    `);

    assert.equal(ctx.cards().length, 4, 'the new session is carded');
    assert.equal(ctx.headings().length, 0,
      'wrapInGridCard must not create a project heading while the grid is flat');
  } finally {
    ctx.destroy();
  }
});

test('a session opened into a grouped grid still lands under its project heading', () => {
  const ctx = setupGridDom({ stored: '1' });
  try {
    ctx.inCtx('showGridView();');

    ctx.inCtx(`
      const el = document.createElement('div');
      el.className = 'terminal-container';
      terminalsEl.appendChild(el);
      sessionMap.set('s4', { id: 's4', projectPath: '/home/jb/alpha', name: 'more alpha', modified: Date.now() });
      openSessions.set('s4', { closed: false, element: el, session: sessionMap.get('s4'), terminal: { options: {}, focus: () => {} } });
      wrapInGridCard('s4');
    `);

    assert.equal(ctx.headings().length, 3, 'the existing alpha heading is reused, not duplicated');
    const alphaHeading = ctx.headings()[0];
    assert.equal(alphaHeading.nextSibling.dataset.sessionId, 's1');
    assert.equal(alphaHeading.nextSibling.nextSibling.dataset.sessionId, 's4',
      'the new card sits inside the alpha group');
  } finally {
    ctx.destroy();
  }
});
