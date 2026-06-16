// Tests for public/terminal-context-menu.js.
//
// Two harnesses:
//   1. require() the module for the pure helpers (fileUriToPath /
//      classifyLinkUri / buildTerminalMenuItems) — no DOM needed.
//   2. jsdom + vm.runInContext (mirrors terminal-manager-lifecycle.test.js) to
//      exercise the DOM/action functions: showTerminalContextMenu,
//      runTerminalMenuAction (via button clicks), closeTerminalContextMenu* and
//      setupTerminalContextMenu's mode dispatch.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MENU_SRC = path.join(PUBLIC_DIR, 'terminal-context-menu.js');

// require() the real module so c8 instruments it (vm.runInContext-loaded code is
// not attributed to the source file). The DOM functions reference the bare
// globals `document`/`window`/`openFileInPanel`; we point those at a jsdom
// instance in setupMenuDom before driving them.
const menu = require(MENU_SRC);
const { fileUriToPath, classifyLinkUri, buildTerminalMenuItems } = menu;

// ── Pure helpers ─────────────────────────────────────────────────────

test('fileUriToPath decodes a file:// URI to a path', () => {
  assert.strictEqual(fileUriToPath('file:///home/u/My%20Project/a.js'), '/home/u/My Project/a.js');
});

test('fileUriToPath returns null for non-file URIs', () => {
  assert.strictEqual(fileUriToPath('https://example.com'), null);
  assert.strictEqual(fileUriToPath('/plain/path'), null);
  assert.strictEqual(fileUriToPath(null), null);
});

test('classifyLinkUri distinguishes file, url, and neither', () => {
  assert.deepStrictEqual(classifyLinkUri('file:///etc/hosts'), { kind: 'file', path: '/etc/hosts' });
  assert.deepStrictEqual(classifyLinkUri('https://x.dev/p'), { kind: 'url', url: 'https://x.dev/p' });
  assert.deepStrictEqual(classifyLinkUri('ftp://x'), { kind: null });
  assert.deepStrictEqual(classifyLinkUri(''), { kind: null });
  assert.deepStrictEqual(classifyLinkUri(undefined), { kind: null });
});

test('menu over a file link offers file actions then a separator then generic', () => {
  const items = buildTerminalMenuItems({ linkUri: 'file:///a/b.ts', hasSelection: true });
  const ids = items.map((i) => (i === null ? '---' : i.id));
  assert.deepStrictEqual(ids, ['open-panel', 'open-system', 'copy-path', '---', 'copy', 'paste', 'select-all']);
});

test('menu over a url link offers browser/copy-link', () => {
  const ids = buildTerminalMenuItems({ linkUri: 'https://x.dev', hasSelection: false })
    .map((i) => (i === null ? '---' : i.id));
  assert.deepStrictEqual(ids, ['open-browser', 'copy-link', '---', 'paste', 'select-all']);
});

test('menu with no link and no selection: no separator, no copy', () => {
  const items = buildTerminalMenuItems({ linkUri: null, hasSelection: false });
  const ids = items.map((i) => (i === null ? '---' : i.id));
  assert.deepStrictEqual(ids, ['paste', 'select-all']);
  assert.ok(!ids.includes('---'));
});

test('Copy only appears when there is a selection', () => {
  const withSel = buildTerminalMenuItems({ linkUri: null, hasSelection: true }).map((i) => i.id);
  assert.ok(withSel.includes('copy'));
  const noSel = buildTerminalMenuItems({ linkUri: null, hasSelection: false }).map((i) => i.id);
  assert.ok(!noSel.includes('copy'));
});

// ── DOM / action functions (jsdom + vm) ──────────────────────────────

function setupMenuDom() {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  });
  const { window } = dom;

  const calls = {
    openFileInPanel: [], openPath: [], writeClipboard: [], openExternal: [],
    readClipboard: 0, paste: [], selectAll: 0,
  };

  window.api = {
    openExternal: (u) => { calls.openExternal.push(u); },
    openPath: (p) => { calls.openPath.push(p); },
    writeClipboard: (t) => { calls.writeClipboard.push(t); },
    readClipboard: () => { calls.readClipboard++; return Promise.resolve('CLIP'); },
  };

  // Point the module's bare globals at this jsdom instance.
  const realSetTimeout = global.setTimeout;
  const saved = {
    window: global.window, document: global.document,
    openFileInPanel: global.openFileInPanel, MouseEvent: global.MouseEvent,
    KeyboardEvent: global.KeyboardEvent,
  };
  global.window = window;
  global.document = window.document;
  global.MouseEvent = window.MouseEvent;
  global.KeyboardEvent = window.KeyboardEvent;
  global.openFileInPanel = (sid, p) => { calls.openFileInPanel.push([sid, p]); };

  menu._setTerminalRightClickMode('menu');

  const flush = () => new Promise((r) => setImmediate(r));

  // A minimal xterm stub; selection toggled per-test.
  const terminal = {
    _sel: false,
    hasSelection() { return this._sel; },
    getSelection() { return 'SELECTED'; },
    paste(t) { calls.paste.push(t); },
    selectAll() { calls.selectAll++; },
  };

  // showTerminalContextMenu defers its document-level listener registration via
  // setTimeout(0); let that fire (globals still pointed at jsdom) before we
  // close the menu and restore the globals — otherwise the late callback hits a
  // restored/undefined document.
  const destroy = async () => {
    await new Promise((r) => realSetTimeout(r, 5));
    menu.closeTerminalContextMenu();
    window.close();
    Object.assign(global, saved);
  };

  return { window, flush, calls, terminal, destroy };
}

function buttonByLabel(window, label) {
  return [...window.document.querySelectorAll('.terminal-context-menu .popover-option')]
    .find((b) => b.textContent === label);
}

test('showTerminalContextMenu renders file-link actions and clicking opens the panel', async () => {
  const h = setupMenuDom();
  try {
    menu.showTerminalContextMenu(
      { clientX: 10, clientY: 10 },
      { terminal: h.terminal, sessionId: 's1', linkUri: 'file:///a/b.ts' },
    );
    const labels = [...h.window.document.querySelectorAll('.terminal-context-menu .popover-option')]
      .map((b) => b.textContent);
    assert.deepStrictEqual(labels, ['Open in panel', 'Open in system editor', 'Copy path', 'Paste', 'Select all']);
    assert.strictEqual(h.window.document.querySelectorAll('.popover-separator').length, 1);

    buttonByLabel(h.window, 'Open in panel').click();
    assert.deepStrictEqual(h.calls.openFileInPanel, [['s1', '/a/b.ts']]);
    // Clicking closes the menu.
    assert.strictEqual(h.window.document.querySelector('.terminal-context-menu'), null);
  } finally { await h.destroy(); }
});

test('file-link actions: open-system and copy-path route to the right IPC', async () => {
  const h = setupMenuDom();
  try {
    menu.showTerminalContextMenu({ clientX: 0, clientY: 0 }, { terminal: h.terminal, sessionId: 's1', linkUri: 'file:///x/y.js' });
    buttonByLabel(h.window, 'Open in system editor').click();
    assert.deepStrictEqual(h.calls.openPath, ['/x/y.js']);

    menu.showTerminalContextMenu({ clientX: 0, clientY: 0 }, { terminal: h.terminal, sessionId: 's1', linkUri: 'file:///x/y.js' });
    buttonByLabel(h.window, 'Copy path').click();
    assert.deepStrictEqual(h.calls.writeClipboard, ['/x/y.js']);
  } finally { await h.destroy(); }
});

test('url-link actions: open-browser and copy-link', async () => {
  const h = setupMenuDom();
  try {
    menu.showTerminalContextMenu({ clientX: 0, clientY: 0 }, { terminal: h.terminal, sessionId: 's1', linkUri: 'https://x.dev/p' });
    buttonByLabel(h.window, 'Open in browser').click();
    assert.deepStrictEqual(h.calls.openExternal, ['https://x.dev/p']);

    menu.showTerminalContextMenu({ clientX: 0, clientY: 0 }, { terminal: h.terminal, sessionId: 's1', linkUri: 'https://x.dev/p' });
    buttonByLabel(h.window, 'Copy link').click();
    assert.deepStrictEqual(h.calls.writeClipboard, ['https://x.dev/p']);
  } finally { await h.destroy(); }
});

test('generic actions: copy uses the selection, paste reads clipboard, select-all', async () => {
  const h = setupMenuDom();
  try {
    h.terminal._sel = true;
    menu.showTerminalContextMenu({ clientX: 0, clientY: 0 }, { terminal: h.terminal, sessionId: 's1', linkUri: null });
    buttonByLabel(h.window, 'Copy').click();
    assert.deepStrictEqual(h.calls.writeClipboard, ['SELECTED']);

    menu.showTerminalContextMenu({ clientX: 0, clientY: 0 }, { terminal: h.terminal, sessionId: 's1', linkUri: null });
    buttonByLabel(h.window, 'Paste').click();
    await h.flush();
    assert.strictEqual(h.calls.readClipboard, 1);
    assert.deepStrictEqual(h.calls.paste, ['CLIP']);

    menu.showTerminalContextMenu({ clientX: 0, clientY: 0 }, { terminal: h.terminal, sessionId: 's1', linkUri: null });
    buttonByLabel(h.window, 'Select all').click();
    assert.strictEqual(h.calls.selectAll, 1);
  } finally { await h.destroy(); }
});

test('Escape closes the menu', async () => {
  const h = setupMenuDom();
  try {
    menu.showTerminalContextMenu({ clientX: 0, clientY: 0 }, { terminal: h.terminal, sessionId: 's1', linkUri: null });
    assert.ok(h.window.document.querySelector('.terminal-context-menu'));
    // The keydown listener is registered on a setTimeout(0); wait for it, then Escape closes the menu.
    await h.flush();
    await new Promise((r) => setTimeout(r, 5));
    h.window.document.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape' }));
    assert.strictEqual(h.window.document.querySelector('.terminal-context-menu'), null);
  } finally { await h.destroy(); }
});

test('closeTerminalContextMenuForSession closes only the matching session', async () => {
  const h = setupMenuDom();
  try {
    menu.showTerminalContextMenu({ clientX: 0, clientY: 0 }, { terminal: h.terminal, sessionId: 's1', linkUri: null });
    menu.closeTerminalContextMenuForSession('other');
    assert.ok(h.window.document.querySelector('.terminal-context-menu'), 'non-matching session leaves menu open');
    menu.closeTerminalContextMenuForSession('s1');
    assert.strictEqual(h.window.document.querySelector('.terminal-context-menu'), null, 'matching session closes menu');
  } finally { await h.destroy(); }
});

test('setupTerminalContextMenu: default mode lets xterm handle it (no preventDefault, no menu)', async () => {
  const h = setupMenuDom();
  try {
    menu._setTerminalRightClickMode('default');
    const container = h.window.document.createElement('div');
    h.window.document.body.appendChild(container);
    menu.setupTerminalContextMenu(container, h.terminal, () => 's1', () => null);
    const ev = new h.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
    container.dispatchEvent(ev);
    assert.strictEqual(ev.defaultPrevented, false);
    assert.strictEqual(h.window.document.querySelector('.terminal-context-menu'), null);
  } finally { await h.destroy(); }
});

test('setupTerminalContextMenu: none mode suppresses the default and shows no menu', async () => {
  const h = setupMenuDom();
  try {
    menu._setTerminalRightClickMode('none');
    const container = h.window.document.createElement('div');
    h.window.document.body.appendChild(container);
    menu.setupTerminalContextMenu(container, h.terminal, () => 's1', () => null);
    const ev = new h.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
    container.dispatchEvent(ev);
    assert.strictEqual(ev.defaultPrevented, true);
    assert.strictEqual(h.window.document.querySelector('.terminal-context-menu'), null);
  } finally { await h.destroy(); }
});

test('setupTerminalContextMenu: paste mode reads clipboard and pastes', async () => {
  const h = setupMenuDom();
  try {
    menu._setTerminalRightClickMode('paste');
    const container = h.window.document.createElement('div');
    h.window.document.body.appendChild(container);
    menu.setupTerminalContextMenu(container, h.terminal, () => 's1', () => null);
    container.dispatchEvent(new h.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
    await h.flush();
    assert.strictEqual(h.calls.readClipboard, 1);
    assert.deepStrictEqual(h.calls.paste, ['CLIP']);
  } finally { await h.destroy(); }
});

test('setupTerminalContextMenu: menu mode shows the context menu with the hovered link', async () => {
  const h = setupMenuDom();
  try {
    menu._setTerminalRightClickMode('menu');
    const container = h.window.document.createElement('div');
    h.window.document.body.appendChild(container);
    menu.setupTerminalContextMenu(container, h.terminal, () => 's1', () => 'file:///z/a.ts');
    container.dispatchEvent(new h.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 5, clientY: 5 }));
    const labels = [...h.window.document.querySelectorAll('.terminal-context-menu .popover-option')].map((b) => b.textContent);
    assert.ok(labels.includes('Open in panel'));
    assert.ok(labels.includes('Copy path'));
  } finally { await h.destroy(); }
});
