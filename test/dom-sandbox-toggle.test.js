// Coverage for the Sandbox session option (bubblewrap wrapper, Linux only).
//
// Three surfaces expose the toggle, all gated on window.api.platform ===
// 'linux': the New Session dialog, the Resume Session dialog (dialogs.js),
// and the Global/Project Settings panel (settings-panel.js). main.js turns
// options.sandbox into a `bash scripts/claude-sandbox.sh <claude args>`
// launch — that side is asserted statically below, like the SETTING_DEFAULTS
// guard in dom-permission-mode-picker.test.js.

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

// --- Harness for dialogs.js ---
function setupDialogsDom(platform) {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'http://localhost/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;

  let launchedProject = null;
  let launchedOptions = null;

  window.api = {
    platform,
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

  return {
    window,
    document: window.document,
    setEffectiveSettings(s) { window.__effectiveSettings = s; },
    getLaunched() { return { project: launchedProject, options: launchedOptions }; },
    destroy() { window.close(); },
  };
}

test('showNewSessionDialog (linux): sandbox toggle renders, follows effective settings, and round-trips into options.sandbox', async () => {
  const ctx = setupDialogsDom('linux');
  try {
    ctx.setEffectiveSettings({ sandbox: true });
    await ctx.window.showNewSessionDialog({ projectPath: '/home/dev/proj' });

    const toggle = ctx.document.querySelector('#nsd-sandbox');
    assert.ok(toggle, 'sandbox toggle must render on linux');
    assert.ok(toggle.checked, 'toggle must be pre-checked when effective settings enable the sandbox');

    ctx.document.querySelector('.new-session-start-btn').click();
    const { options } = ctx.getLaunched();
    assert.ok(options, 'launchNewSession must have been called');
    assert.equal(options.sandbox, true, 'sandbox must survive into the launched session options');
  } finally {
    ctx.destroy();
  }
});

test('showNewSessionDialog (linux): sandbox is off by default and stays out of the options when unchecked', async () => {
  const ctx = setupDialogsDom('linux');
  try {
    ctx.setEffectiveSettings({});
    await ctx.window.showNewSessionDialog({ projectPath: '/home/dev/proj' });

    const toggle = ctx.document.querySelector('#nsd-sandbox');
    assert.ok(toggle, 'sandbox toggle must render on linux');
    assert.equal(toggle.checked, false, 'sandbox must default to off');

    ctx.document.querySelector('.new-session-start-btn').click();
    const { options } = ctx.getLaunched();
    assert.ok(options);
    assert.equal(options.sandbox, undefined, 'options must not carry a sandbox key when the toggle is off');
  } finally {
    ctx.destroy();
  }
});

test('showNewSessionDialog (darwin): sandbox toggle is not rendered and never reaches the options', async () => {
  const ctx = setupDialogsDom('darwin');
  try {
    // Even a (stale) enabled setting must not leak onto a non-Linux platform.
    ctx.setEffectiveSettings({ sandbox: true });
    await ctx.window.showNewSessionDialog({ projectPath: '/home/dev/proj' });

    assert.equal(ctx.document.querySelector('#nsd-sandbox'), null, 'sandbox toggle must not render off-linux');

    ctx.document.querySelector('.new-session-start-btn').click();
    const { options } = ctx.getLaunched();
    assert.ok(options);
    assert.equal(options.sandbox, undefined, 'sandbox must not be set off-linux');
  } finally {
    ctx.destroy();
  }
});

test('showResumeSessionDialog (linux): sandbox toggle round-trips into the resume options', async () => {
  const ctx = setupDialogsDom('linux');
  try {
    ctx.setEffectiveSettings({ sandbox: true });
    await ctx.window.showResumeSessionDialog({ sessionId: 'abc12345', projectPath: '/home/dev/proj' });

    const toggle = ctx.document.querySelector('#rsd-sandbox');
    assert.ok(toggle, 'sandbox toggle must render in the Resume dialog on linux');
    assert.ok(toggle.checked);

    ctx.document.querySelector('.new-session-start-btn').click();
    const { options } = ctx.getLaunched();
    assert.ok(options, 'openSession must have been called');
    assert.equal(options.sandbox, true);
  } finally {
    ctx.destroy();
  }
});

test('resolveDefaultSessionOptions: carries sandbox on linux, drops it elsewhere', async () => {
  const linuxCtx = setupDialogsDom('linux');
  const macCtx = setupDialogsDom('darwin');
  try {
    linuxCtx.setEffectiveSettings({ sandbox: true });
    macCtx.setEffectiveSettings({ sandbox: true });

    const linuxOptions = await linuxCtx.window.resolveDefaultSessionOptions({ projectPath: '/home/dev/proj' });
    assert.equal(linuxOptions.sandbox, true, 'quick-launch (no dialog) must inherit the sandbox setting on linux');

    const macOptions = await macCtx.window.resolveDefaultSessionOptions({ projectPath: '/home/dev/proj' });
    assert.equal(macOptions.sandbox, undefined, 'quick-launch must ignore the sandbox setting off-linux');
  } finally {
    linuxCtx.destroy();
    macCtx.destroy();
  }
});

// --- Harness for settings-panel.js ---
function setupSettingsPanelDom(platform) {
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

  window.__savedSettings = null;
  window.api = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'platform') return platform;
      if (prop === 'getSetting') return async (key) => window.__settings[key] || {};
      if (prop === 'setSetting') return async (key, value) => { window.__savedSettings = { key, value }; return { ok: true }; };
      if (prop === 'getShellProfiles') return async () => [];
      if (prop === 'getAppVersion') return async () => '0.0.0';
      if (prop === 'onUpdaterEvent') return () => {};
      return () => Promise.resolve({ ok: true });
    },
  });

  evalInWindow(dom, path.join(PUBLIC_DIR, 'utils.js'));
  evalInWindow(dom, path.join(PUBLIC_DIR, 'shortcuts.js'));
  // Global scope renders the Application section, which reads TERMINAL_THEMES.
  evalInWindow(dom, path.join(PUBLIC_DIR, 'terminal-themes.js'));
  evalInWindow(dom, path.join(PUBLIC_DIR, 'settings-panel.js'));

  return {
    window,
    document: window.document,
    setSettings(byKey) { window.__settings = byKey; },
    destroy() { window.close(); },
  };
}

test('Settings panel (linux): global sandbox toggle renders and persists into the saved settings', async () => {
  const ctx = setupSettingsPanelDom('linux');
  try {
    ctx.setSettings({ global: {} });
    await ctx.window.openSettingsViewer('global');

    const toggle = ctx.document.querySelector('#sv-sandbox');
    assert.ok(toggle, 'sandbox toggle must render in Global Settings on linux');
    assert.equal(toggle.checked, false, 'sandbox must default to off');

    toggle.checked = true;
    ctx.document.querySelector('#sv-save-btn').click();
    await new Promise(r => setTimeout(r, 0));

    assert.ok(ctx.window.__savedSettings, 'save must go through setSetting');
    assert.equal(ctx.window.__savedSettings.key, 'global');
    assert.equal(ctx.window.__savedSettings.value.sandbox, true, 'enabling the toggle must persist sandbox: true globally');
  } finally {
    ctx.destroy();
  }
});

test('Settings panel (linux): project scope offers sandbox with a use-global checkbox', async () => {
  const ctx = setupSettingsPanelDom('linux');
  try {
    ctx.setSettings({ 'project:/home/dev/proj': {}, global: { sandbox: true } });
    await ctx.window.openSettingsViewer('project', '/home/dev/proj');

    const toggle = ctx.document.querySelector('#sv-sandbox');
    assert.ok(toggle, 'sandbox toggle must render in Project Settings on linux');
    assert.ok(toggle.checked, 'project view must reflect the inherited global value');
    const useGlobal = ctx.document.querySelector('.use-global-cb[data-field="sandbox"]');
    assert.ok(useGlobal, 'sandbox must have a use-global checkbox like the other per-project fields');
    assert.ok(useGlobal.checked, 'an unset project value must default to "use global"');
  } finally {
    ctx.destroy();
  }
});

test('Settings panel (darwin): sandbox toggle is not rendered and save does not invent a sandbox key', async () => {
  const ctx = setupSettingsPanelDom('darwin');
  try {
    ctx.setSettings({ global: {} });
    await ctx.window.openSettingsViewer('global');

    assert.equal(ctx.document.querySelector('#sv-sandbox'), null, 'sandbox toggle must not render off-linux');

    ctx.document.querySelector('#sv-save-btn').click();
    await new Promise(r => setTimeout(r, 0));
    assert.ok(ctx.window.__savedSettings);
    assert.ok(!('sandbox' in ctx.window.__savedSettings.value), 'off-linux saves must not write a sandbox key');
  } finally {
    ctx.destroy();
  }
});

// --- Static guards on main.js (it can't be require()'d under node:test —
// native pty/electron deps), mirroring dom-permission-mode-picker.test.js. ---
test('main.js: sandbox defaults to off and wraps the claude command with the asar-unpacked bwrap script, linux-gated', () => {
  const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');

  const defaultsStart = src.indexOf('const SETTING_DEFAULTS = {');
  assert.ok(defaultsStart !== -1);
  const defaultsBody = src.slice(defaultsStart, src.indexOf('};', defaultsStart));
  assert.match(defaultsBody, /sandbox:\s*false/, 'sandbox must be off by default');

  assert.match(src, /sessionOptions\?\.sandbox/, 'open-terminal must honor the sandbox session option');
  assert.match(src, /process\.platform !== 'linux'/, 'sandbox launches must be rejected off-linux');
  assert.match(src, /claude-sandbox\.sh/, 'the bwrap wrapper script must be what gets launched');
  assert.match(src, /app\.asar\.unpacked\$1/, 'packaged builds must resolve the script outside app.asar with a separator-anchored replace');

  // Bind paths travel in a colon-separated env var — a ':' inside a path
  // would be split into mkdir'd fragments on the host, so it must be dropped.
  assert.match(src, /sandboxBindEnv/, 'extra binds must go through the colon-guarding helper');

  // Additional Directories is parsed once, so the --add-dir args and the
  // sandbox bind list can't disagree about what the user typed.
  assert.match(src, /function parseAddDirs/, 'the shared addDirs parser must exist');
  assert.equal((src.match(/parseAddDirs\(sessionOptions\.addDirs\)/g) || []).length, 2,
    'both the --add-dir args and the sandbox bind list must go through parseAddDirs');

  // Scheduled (headless) runs must honor the effective sandbox setting too,
  // not just interactive sessions — they share the wrapper via the helper.
  const scheduleStart = src.indexOf('function runScheduleCommand');
  assert.ok(scheduleStart !== -1);
  const scheduleBody = src.slice(scheduleStart, src.indexOf('scheduleIpc.init', scheduleStart));
  assert.match(scheduleBody, /sandboxScriptPath\(\)/, 'runScheduleCommand must wrap claude with the sandbox script when the setting is on');
  assert.match(scheduleBody, /projectSettings\.sandbox/, 'runScheduleCommand must resolve the project-level sandbox override');

  // Off-linux a scheduled run must be skipped, not silently downgraded to an
  // unconfined one — nobody is watching the log during an unattended run.
  assert.doesNotMatch(scheduleBody, /sandbox = false/,
    'off-linux must not downgrade a scheduled sandbox run to unconfined');
  const offLinuxStart = scheduleBody.indexOf("process.platform !== 'linux'");
  assert.ok(offLinuxStart !== -1);
  const offLinux = scheduleBody.slice(offLinuxStart, scheduleBody.indexOf('if (sandbox) {', offLinuxStart));
  assert.match(offLinux, /log\.error[\s\S]*?return;/,
    'off-linux must log an error and return before spawning');
});

test('package.json: the sandbox script ships in builds and is asar-unpacked so bash can execute it', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.build.files.includes('scripts/claude-sandbox.sh'), 'script must be included in build.files');
  assert.ok(pkg.build.asarUnpack.includes('scripts/claude-sandbox.sh'), 'script must be listed in asarUnpack');
});

// --- Sandboxed sessions are visually identifiable (lock badge) ---
// Isolation you cannot see is isolation you cannot rely on: the user needs to
// tell at a glance whether the session in front of them is confined.
test('sandbox badge: main.js reports the sandbox state on both open-terminal returns', () => {
  const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');

  const returns = src.match(/return \{ ok: true, reattached: (?:true|false)[^}]*\}/g) || [];
  assert.equal(returns.length, 2, 'open-terminal has exactly two success returns');
  for (const r of returns) {
    assert.match(r, /sandbox:/, `success return must report sandbox state: ${r}`);
  }

  // A reattach has no sessionOptions to consult, so the flag must be recorded
  // on the session record when it is created.
  assert.match(src, /sandbox: !!sessionOptions\?\.sandbox,/, 'session record must persist the sandbox flag');
});

test('sandbox badge: the renderer renders it from the reported state', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert.match(html, /id="terminal-header-sandbox"/, 'header must carry the badge element');
  assert.match(html, /style="display:none;"[^>]*>🔒/, 'badge must start hidden');

  const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  assert.match(app, /sandboxedSessions/, 'renderer must track which sessions are sandboxed');
  assert.match(app, /function setSessionSandboxed/, 'cross-file setter must follow the setSessionMcpActive convention');
  assert.match(app, /terminalHeaderSandbox\.style\.display = sandboxedSessions\.get\(session\.sessionId\) \? '' : 'none'/,
    'the badge must follow the tracked state, not a static value');

  const css = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
  assert.match(css, /#terminal-header-sandbox \{/, 'badge must be styled');
});
