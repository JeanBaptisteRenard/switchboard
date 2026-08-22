// Regression coverage for the `auto` permission mode.
//
// Two halves, with different owners:
//
//   1. The three pickers (New Session dialog, Resume Session dialog, Settings
//      panel <select>) offering `auto` from the shared PERMISSION_MODES list.
//      That is UPSTREAM's implementation (doctly/switchboard a7698f4), which
//      shipped without tests. These assertions are ours and guard against a
//      future sync quietly dropping `auto` or re-duplicating the mode list.
//
//   2. main.js's default-selection semantics — SETTING_DEFAULTS.permissionMode
//      and the null-vs-undefined distinction in get-effective-settings. That
//      part is this branch's actual change and upstream does not have it.
//
// Claude Code's CLI recognizes `auto` as a `--permission-mode` value (the
// 2.1.220 binary's choice list is default/auto/acceptEdits/plan/dontAsk/
// bypassPermissions) and treats it as its own default mode.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const ROOT = path.join(__dirname, '..');

function evalInWindow(dom, file) {
  const src = fs.readFileSync(file, 'utf8');
  vm.runInContext(src, dom.getInternalVMContext(), { filename: file });
}

// --- Harness for dialogs.js (New/Resume Session dialogs) ---
function setupDialogsDom() {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'http://localhost/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;

  let launchedProject = null;
  let launchedOptions = null;

  window.api = {
    getEffectiveSettings: async () => window.__effectiveSettings,
  };

  const stubGlobals = {
    launchNewSession: (project, options) => { launchedProject = project; launchedOptions = options; },
    openSession: (session, options) => { launchedProject = session; launchedOptions = options; },
    cachedProjects: [],
    cachedAllProjects: [],
    sessionMap: new Map(),
    pendingSessions: new Map(),
    openSessions: new Map(),
    activePtyIds: new Set(),
    refreshSidebar: () => {},
    pollActiveSessions: () => {},
  };
  for (const [k, v] of Object.entries(stubGlobals)) {
    Object.defineProperty(window, k, { value: v, writable: true, configurable: true });
  }

  evalInWindow(dom, path.join(PUBLIC_DIR, 'utils.js'));
  evalInWindow(dom, path.join(PUBLIC_DIR, 'dialogs.js'));
  // utils.js declares PERMISSION_MODES as a top-level `const`, which — like
  // any script-level let/const — is a global *lexical* binding, not a
  // property of `window`. dialogs.js/settings-panel.js can reference it
  // unqualified (same realm, same global scope record), but the test harness
  // needs an explicit assignment to read it back out as ctx.window.<name>.
  vm.runInContext('window.__PERMISSION_MODES = PERMISSION_MODES;', dom.getInternalVMContext());

  return {
    window,
    document: window.document,
    setEffectiveSettings(s) { window.__effectiveSettings = s; },
    getLaunched() { return { project: launchedProject, options: launchedOptions }; },
    destroy() { window.close(); },
  };
}

test('PERMISSION_MODES (utils.js): includes auto with a description distinct from acceptEdits', () => {
  const ctx = setupDialogsDom();
  try {
    const auto = ctx.window.__PERMISSION_MODES.find(m => m.value === 'auto');
    assert.ok(auto, 'PERMISSION_MODES must include an "auto" entry');
    assert.equal(auto.label, 'Auto');
    const acceptEdits = ctx.window.__PERMISSION_MODES.find(m => m.value === 'acceptEdits');
    assert.notEqual(auto.desc, acceptEdits.desc, 'auto must not copy acceptEdits\' description');
  } finally {
    ctx.destroy();
  }
});

test('showNewSessionDialog: offers auto in the mode grid and pre-selects it when effective settings say so', async () => {
  const ctx = setupDialogsDom();
  try {
    ctx.setEffectiveSettings({ permissionMode: 'auto' });
    await ctx.window.showNewSessionDialog({ projectPath: '/home/dev/proj' });

    const grid = ctx.document.querySelector('#nsd-mode-grid');
    assert.ok(grid, 'mode grid must render');
    const autoBtn = grid.querySelector('[data-mode="auto"]');
    assert.ok(autoBtn, 'auto must be an offered permission-mode button');
    assert.ok(autoBtn.classList.contains('selected'), 'auto must be pre-selected when it is the effective mode');
  } finally {
    ctx.destroy();
  }
});

test('showNewSessionDialog: auto survives the round-trip into the launched session options (spawn command input)', async () => {
  const ctx = setupDialogsDom();
  try {
    ctx.setEffectiveSettings({ permissionMode: 'auto' });
    await ctx.window.showNewSessionDialog({ projectPath: '/home/dev/proj' });

    // Don't touch the mode grid — accept the pre-selected default and start.
    ctx.document.querySelector('.new-session-start-btn').click();

    const { options } = ctx.getLaunched();
    assert.ok(options, 'launchNewSession must have been called');
    assert.equal(options.permissionMode, 'auto', 'permissionMode must survive into the options main.js turns into --permission-mode "auto"');
  } finally {
    ctx.destroy();
  }
});

test('showResumeSessionDialog: also offers auto in its mode grid (second dialogs.js copy)', async () => {
  const ctx = setupDialogsDom();
  try {
    ctx.setEffectiveSettings({});
    const session = { sessionId: 'abc12345', projectPath: '/home/dev/proj' };
    await ctx.window.showResumeSessionDialog(session);

    const grid = ctx.document.querySelector('#rsd-mode-grid');
    assert.ok(grid, 'resume dialog mode grid must render');
    assert.ok(grid.querySelector('[data-mode="auto"]'), 'auto must be offered in the Resume Session dialog too');
  } finally {
    ctx.destroy();
  }
});

test('dialogs.js: New and Resume dialogs share one PERMISSION_MODES list (no re-duplicated literal array)', () => {
  const src = fs.readFileSync(path.join(PUBLIC_DIR, 'dialogs.js'), 'utf8');
  const modeListRefs = src.match(/const modes = PERMISSION_MODES;/g) || [];
  assert.equal(modeListRefs.length, 2, 'both showNewSessionDialog and showResumeSessionDialog must reference the shared PERMISSION_MODES constant');
  // Regression guard: no literal mode array (the pre-fix duplication) left in dialogs.js.
  assert.doesNotMatch(src, /const modes = \[/, 'dialogs.js must not re-introduce a literal, divergence-prone modes array');
});

// --- Harness for settings-panel.js (project-scope Settings panel) ---
function setupSettingsPanelDom() {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>
    <div id="settings-viewer"></div>
    <div id="settings-viewer-title"></div>
    <div id="settings-viewer-body"></div>
    <div id="terminal-area"></div>
    <div id="terminal-header"></div>
    <div id="placeholder"></div>
    <div id="stats-viewer"></div>
    <div id="memory-viewer"></div>
    <div id="jsonl-viewer"></div>
  </body></html>`, {
    url: 'http://localhost/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;

  window.api = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'getSetting') return async (key) => window.__settings[key] || {};
      if (prop === 'getShellProfiles') return async () => [];
      if (prop === 'getAppVersion') return async () => '0.0.0';
      if (prop === 'onUpdaterEvent') return () => {};
      return () => Promise.resolve({ ok: true });
    },
  });

  evalInWindow(dom, path.join(PUBLIC_DIR, 'utils.js'));
  evalInWindow(dom, path.join(PUBLIC_DIR, 'shortcuts.js'));
  evalInWindow(dom, path.join(PUBLIC_DIR, 'settings-panel.js'));

  return {
    window,
    document: window.document,
    setSettings(byKey) { window.__settings = byKey; },
    destroy() { window.close(); },
  };
}

test('Settings panel: project-scope Permission Mode select offers auto', async () => {
  const ctx = setupSettingsPanelDom();
  try {
    ctx.setSettings({ 'project:/home/dev/proj': {}, global: {} });
    await ctx.window.openSettingsViewer('project', '/home/dev/proj');

    const select = ctx.document.querySelector('#sv-perm-mode');
    assert.ok(select, 'permission mode select must render');
    const autoOption = select.querySelector('option[value="auto"]');
    assert.ok(autoOption, 'the settings-panel select must offer an auto option');
    assert.equal(autoOption.textContent, 'Auto');
  } finally {
    ctx.destroy();
  }
});

test('Settings panel: select is built from the shared PERMISSION_MODES list, not a hand-duplicated one', () => {
  const src = fs.readFileSync(path.join(PUBLIC_DIR, 'settings-panel.js'), 'utf8');
  assert.match(src, /PERMISSION_MODES\.map/, 'settings-panel.js must build its <select> options from the shared PERMISSION_MODES constant');
});

// --- Regression guard: main.js default-selection semantics (static, since main.js
// can't be require()'d directly under plain node:test — native pty/electron deps). ---
test('main.js: permissionMode SETTING_DEFAULTS is auto, and an explicit null override is never conflated with "unset"', () => {
  const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');

  const defaultsStart = src.indexOf('const SETTING_DEFAULTS = {');
  assert.ok(defaultsStart !== -1, 'main.js must define SETTING_DEFAULTS');
  const defaultsEnd = src.indexOf('};', defaultsStart);
  const defaultsBody = src.slice(defaultsStart, defaultsEnd);
  assert.match(defaultsBody, /permissionMode:\s*'auto'/, 'permissionMode default must be auto — the whole point of this change');

  const handlerStart = src.indexOf("ipcMain.handle('get-effective-settings'");
  assert.ok(handlerStart !== -1, 'main.js must define the get-effective-settings IPC handler');
  const handlerEnd = src.indexOf('});', handlerStart);
  const handlerBody = src.slice(handlerStart, handlerEnd);

  // Regression guard for the null/undefined conflation: if the merge loop
  // ever again skips overriding on an explicit null value (in addition to
  // undefined), a user's explicitly-saved "Default" permissionMode would be
  // silently promoted to the new 'auto' default the next time this handler
  // runs — exactly the bug this change was written to avoid.
  assert.doesNotMatch(handlerBody, /\[key\]\s*!==\s*null/, 'get-effective-settings must only skip on undefined, not on explicit null (else "Default" gets silently rewritten to auto)');
  assert.match(handlerBody, /global\[key\] !== undefined/, 'global override check must remain undefined-only');
  assert.match(handlerBody, /project\[key\] !== undefined/, 'project override check must remain undefined-only');
});
