// Shared jsdom harness for public/terminal-manager.js tests.
//
// Extracted from terminal-manager-lifecycle.test.js so the resize-sync suite
// can reuse the same stub set. Mirrors the dom-setup.js pattern (jsdom +
// vm.runInContext) but with a dedicated stub set: terminal-manager.js needs
// xterm constructors and the grid-view/app.js cross-file globals, not the
// sidebar fixtures.
//
// Note: `terminalWriteBuffers` (and other module-level `const`s) live in the
// context's shared lexical scope (like sibling <script> tags), NOT on window —
// so assertions read them via the returned inCtx() helper.

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
      this.cols = 80;
      this.rows = 24;
      this._onResize = null;
    }
    loadAddon() {}
    open() {}
    dispose() { spies.dispose++; }
    write(d, cb) { spies.write++; spies.writes.push(d); if (cb) cb(); }
    reset() { spies.reset++; }
    focus() {}
    // Mirrors xterm: resizing to the current size is a no-op and fires nothing.
    resize(cols, rows) {
      spies.resize.push({ cols, rows });
      if (cols === this.cols && rows === this.rows) return;
      this.cols = cols;
      this.rows = rows;
      if (this._onResize) this._onResize({ cols, rows });
    }
    scrollToBottom() {}
    scrollLines() {}
    refresh() {}
    hasSelection() { return false; }
    getSelection() { return ''; }
    attachCustomKeyEventHandler(cb) { this._customKeyHandler = cb; }
    onData() {}
    onResize(cb) { this._onResize = cb; }
    onTitleChange() {}
    onBell() {}
  };
}

// Minimal ResizeObserver stub: jsdom does not implement one. Records every
// live instance so tests can fire callbacks and assert disconnection.
function makeResizeObserverStub(spies) {
  return class ResizeObserverStub {
    constructor(cb) {
      this.cb = cb;
      this.targets = [];
      this.disconnected = false;
      spies.resizeObservers.push(this);
    }
    observe(el) { this.targets.push(el); }
    unobserve(el) { this.targets = this.targets.filter((t) => t !== el); }
    disconnect() { this.disconnected = true; spies.resizeObserverDisconnects++; }
    // Test-only: simulate the browser reporting a geometry change.
    trigger() { this.cb([{ target: this.targets[0] }], this); }
  };
}

// opts.proposeDimensions: (fitAddonInstance) => {cols, rows} | undefined
function setupTerminalDom(opts = {}) {
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="terminals"></div></body></html>', {
    url: 'http://localhost/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const spies = {
    dispose: 0,
    write: 0,
    writes: [],
    reset: 0,
    closeTerminal: 0,
    resize: [],
    resizeTerminal: [],
    resizeObservers: [],
    resizeObserverDisconnects: 0,
    fitCalls: 0,
  };

  window.api = new Proxy({ platform: 'linux' }, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === 'closeTerminal') return () => { spies.closeTerminal++; };
      if (prop === 'resizeTerminal') return (id, cols, rows) => { spies.resizeTerminal.push({ id, cols, rows }); };
      return () => Promise.resolve({ ok: true });
    },
  });

  spies.webglDispose = 0;
  const noopClass = class { dispose() {} onContextLoss() {} };
  const propose = opts.proposeDimensions || (() => undefined);
  const stubGlobals = {
    Terminal: makeTerminalStub(spies),
    FitAddon: {
      FitAddon: class {
        proposeDimensions() { return propose(); }
        fit() { spies.fitCalls++; }
      },
    },
    WebLinksAddon: { WebLinksAddon: noopClass },
    SearchAddon: { SearchAddon: class { clearDecorations() {} findNext() {} findPrevious() {} } },
    UnicodeGraphemesAddon: { UnicodeGraphemesAddon: noopClass },
    WebglAddon: { WebglAddon: class { dispose() { spies.webglDispose++; } onContextLoss() {} onChangeTextureAtlas() {} onAddTextureAtlasCanvas() {} clearTextureAtlas() {} } },
    ResizeObserver: makeResizeObserverStub(spies),

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
    hideAllViewers: () => {},
    showTerminalHeader: () => {},
    updateRunningIndicators: () => {},
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
  for (const file of ['utils.js', 'shortcuts.js', 'subagent-timing.js', 'terminal-context-menu.js', 'terminal-manager.js', 'grid-view.js']) {
    const src = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');
    vm.runInContext(src, ctx, { filename: file });
  }

  const inCtx = (code) => vm.runInContext(code, ctx);
  return { window, spies, inCtx, destroy: () => window.close() };
}

module.exports = { setupTerminalDom, PUBLIC_DIR };
