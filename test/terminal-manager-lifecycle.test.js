// Lifecycle tests for public/terminal-manager.js — createTerminalEntry /
// destroySession teardown hygiene.
//
// Mirrors the dom-setup.js pattern (jsdom + vm.runInContext) but with a
// dedicated stub set: terminal-manager.js needs xterm constructors and the
// grid-view/app.js cross-file globals, not the sidebar fixtures.
//
// Note: `terminalWriteBuffers` is a top-level `const` in terminal-manager.js.
// It lives in the context's shared lexical scope (like sibling <script> tags),
// NOT on window — so assertions read it via vm.runInContext snippets.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function makeTerminalStub(spies) {
  return class TerminalStub {
    constructor(opts) {
      this.options = { ...opts };
      this.buffer = { active: { viewportY: 0, baseY: 0 } };
      this.parser = { registerOscHandler: () => {} };
      this.unicode = { activeVersion: '' };
    }
    loadAddon() {}
    open() {}
    dispose() { spies.dispose++; }
    write(_d, cb) { spies.write++; if (cb) cb(); }
    focus() {}
    resize() {}
    scrollToBottom() {}
    scrollLines() {}
    hasSelection() { return false; }
    getSelection() { return ''; }
    attachCustomKeyEventHandler() {}
    onData() {}
    onResize() {}
    onTitleChange() {}
    onBell() {}
  };
}

function setupTerminalDom() {
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="terminals"></div></body></html>', {
    url: 'http://localhost/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const spies = { dispose: 0, write: 0, closeTerminal: 0 };

  window.api = new Proxy({ platform: 'linux' }, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === 'closeTerminal') return () => { spies.closeTerminal++; };
      return () => Promise.resolve({ ok: true });
    },
  });

  const noopClass = class { dispose() {} onContextLoss() {} };
  const stubGlobals = {
    Terminal: makeTerminalStub(spies),
    FitAddon: { FitAddon: class { proposeDimensions() { return null; } fit() {} } },
    WebLinksAddon: { WebLinksAddon: noopClass },
    SearchAddon: { SearchAddon: class { clearDecorations() {} findNext() {} findPrevious() {} } },
    UnicodeGraphemesAddon: { UnicodeGraphemesAddon: noopClass },
    WebglAddon: { WebglAddon: noopClass },

    TERMINAL_THEME: { background: '#000000' },
    terminalsEl: window.document.getElementById('terminals'),
    openSessions: new Map(),
    gridCards: new Map(),
    sessionMap: new Map(),
    activePtyIds: new Set(),
    activeSessionId: null,
    gridViewActive: false,

    // Cross-file functions terminal-manager.js calls but tests don't exercise.
    toggleGridView: () => {},
    isSessionNavKey: () => false,
    handleSessionNavKey: () => false,
    matchShortcut: () => false,
    appShortcuts: {},
    focusGridCard: () => {},
    wrapInGridCard: () => {},
    showGridView: () => {},
    trackActivity: () => {},
    updatePtyTitle: () => {},
    openFileInPanel: () => {},
    setActiveSession: () => {},
    clearNotifications: () => {},
    hidePlanViewer: () => {},
    showTerminalHeader: () => {},
    placeholder: window.document.createElement('div'),
    terminalHeader: window.document.createElement('div'),
    gridViewer: window.document.createElement('div'),
    gridViewerCount: window.document.createElement('span'),
  };
  for (const [k, v] of Object.entries(stubGlobals)) {
    Object.defineProperty(window, k, { value: v, writable: true, configurable: true });
  }

  // grid-view.js declares `let gridCards` (and other grid state) in the shared
  // lexical scope — it shadows the window stub, exactly as in production where
  // grid-view.js owns that global. Tests must read grid state via inCtx().
  const ctx = dom.getInternalVMContext();
  for (const file of ['utils.js', 'shortcuts.js', 'terminal-manager.js', 'grid-view.js']) {
    const src = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');
    vm.runInContext(src, ctx, { filename: file });
  }

  const inCtx = (code) => vm.runInContext(code, ctx);
  return { window, spies, inCtx, destroy: () => window.close() };
}

test('destroySession clears maps, pending write buffer, DOM, and disposes the terminal', () => {
  const { window, spies, inCtx, destroy } = setupTerminalDom();
  try {
    window.createTerminalEntry({ sessionId: 's1' });
    assert.strictEqual(window.openSessions.size, 1);
    assert.strictEqual(window.terminalsEl.querySelectorAll('.terminal-container').length, 1);

    // Seed a pending write buffer + a grid card, as app.js / grid-view.js would.
    inCtx(`terminalWriteBuffers.set('s1', { chunks: ['data'], syncDepth: 0, rafId: 1, timerId: 2 })`);
    inCtx(`gridCards.set('s1', document.createElement('div'))`);

    window.destroySession('s1');

    assert.strictEqual(window.openSessions.size, 0, 'openSessions entry removed');
    assert.strictEqual(inCtx('terminalWriteBuffers.size'), 0, 'pending write buffer removed');
    assert.strictEqual(inCtx('gridCards.size'), 0, 'grid card removed');
    assert.strictEqual(spies.dispose, 1, 'terminal.dispose called exactly once');
    assert.strictEqual(spies.closeTerminal, 1, 'closeTerminal IPC sent');
    assert.strictEqual(window.terminalsEl.querySelectorAll('.terminal-container').length, 0, 'container removed from DOM');
  } finally {
    destroy();
  }
});

test('flushTerminalBuffer after destroySession is a safe no-op', () => {
  const { window, spies, inCtx, destroy } = setupTerminalDom();
  try {
    window.createTerminalEntry({ sessionId: 's1' });
    inCtx(`terminalWriteBuffers.set('s1', { chunks: ['late data'], syncDepth: 0, rafId: 0, timerId: 0 })`);
    window.destroySession('s1');
    const writesBefore = spies.write;

    assert.doesNotThrow(() => window.flushTerminalBuffer('s1'));
    assert.strictEqual(spies.write, writesBefore, 'no write on a disposed terminal');
  } finally {
    destroy();
  }
});

test('destroySession on unknown sessionId is a no-op', () => {
  const { window, spies, destroy } = setupTerminalDom();
  try {
    assert.doesNotThrow(() => window.destroySession('nope'));
    assert.strictEqual(spies.closeTerminal, 0);
  } finally {
    destroy();
  }
});

test('scrollback defaults: full budget in single view, thumbnail budget in grid view', () => {
  const { window, destroy } = setupTerminalDom();
  try {
    const single = window.createTerminalEntry({ sessionId: 's-single' });
    assert.strictEqual(single.terminal.options.scrollback, 10000);

    window.gridViewActive = true;
    const grid = window.createTerminalEntry({ sessionId: 's-grid' });
    assert.strictEqual(grid.terminal.options.scrollback, 1000);

    // Explicit option wins over the view-mode default.
    const explicit = window.createTerminalEntry({ sessionId: 's-explicit' }, { scrollback: 500 });
    assert.strictEqual(explicit.terminal.options.scrollback, 500);
  } finally {
    destroy();
  }
});

test('showSession restores the full scrollback budget on a grid-trimmed terminal', () => {
  const { window, destroy } = setupTerminalDom();
  try {
    window.gridViewActive = true;
    const entry = window.createTerminalEntry({ sessionId: 's1' });
    assert.strictEqual(entry.terminal.options.scrollback, 1000);

    window.gridViewActive = false;
    window.showSession('s1');
    assert.strictEqual(entry.terminal.options.scrollback, 10000);
  } finally {
    destroy();
  }
});

test('hideGridView restores the full scrollback budget on ALL open sessions, not just the focused one', () => {
  const { window, destroy } = setupTerminalDom();
  try {
    window.gridViewActive = true;
    const a = window.createTerminalEntry({ sessionId: 'sa' });
    const b = window.createTerminalEntry({ sessionId: 'sb' });
    const c = window.createTerminalEntry({ sessionId: 'sc' });
    c.closed = true;
    assert.strictEqual(b.terminal.options.scrollback, 1000);

    window.hideGridView();

    assert.strictEqual(a.terminal.options.scrollback, 10000, 'background session restored');
    assert.strictEqual(b.terminal.options.scrollback, 10000, 'background session restored');
    assert.strictEqual(c.terminal.options.scrollback, 1000, 'closed session untouched');
    assert.strictEqual(window.gridViewActive, false);
  } finally {
    destroy();
  }
});
