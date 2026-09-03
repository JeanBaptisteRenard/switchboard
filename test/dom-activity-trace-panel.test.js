// The Diagnostics section of the settings panel: the debug-mode switch and the
// trace files it produces.
//
// The switch is deliberately NOT part of the Save payload — it takes effect on
// change, because the whole point of the feature is arming the trace without
// destroying the state under investigation. These tests pin that.

'use strict';
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

function setup({ traceState, files = [], readResult, deleteResult = { ok: true } } = {}) {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>
    <div id="settings-viewer"></div>
    <div id="settings-viewer-title"></div>
    <div id="settings-viewer-body"></div>
    <div id="activity-trace-viewer" style="display:none;"></div>
    <div id="terminal-area"></div>
    <div id="terminal-header"></div>
    <div id="placeholder"></div>
    <div id="stats-viewer"></div>
    <div id="memory-viewer"></div>
    <div id="work-files-viewer"></div>
    <div id="jsonl-viewer"></div>
  </body></html>`, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;

  const calls = { setEnabled: [], read: [], deleted: [], listed: 0 };
  let listing = files;
  let state = traceState || { enabled: false, dir: '/home/dev/.switchboard', currentFile: null, fromEnv: false };

  window.__savedSettings = null;
  window.__settings = { global: {} };
  window.api = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'platform') return 'linux';
      if (prop === 'getSetting') return async (key) => window.__settings[key] || {};
      if (prop === 'setSetting') return async (key, value) => { window.__savedSettings = { key, value }; return { ok: true }; };
      if (prop === 'getShellProfiles') return async () => [];
      if (prop === 'getAppVersion') return async () => '0.0.0';
      if (prop === 'onUpdaterEvent') return () => {};
      if (prop === 'getActivityTraceState') return async () => state;
      if (prop === 'setActivityTraceEnabled') return async (on) => {
        calls.setEnabled.push(on);
        state = { ...state, enabled: on };
        return state;
      };
      if (prop === 'listActivityTraceFiles') return async () => { calls.listed += 1; return listing; };
      if (prop === 'readActivityTraceFile') return async (p) => { calls.read.push(p); return readResult; };
      if (prop === 'deleteActivityTraceFile') return async (p) => {
        calls.deleted.push(p);
        if (deleteResult.ok) listing = listing.filter(f => f.filePath !== p);
        return deleteResult;
      };
      return () => Promise.resolve({ ok: true });
    },
  });

  const opened = [];
  const panelOpts = [];
  Object.defineProperty(window, 'ViewerPanel', {
    value: class {
      constructor(_container, opts) { panelOpts.push(opts); }
      open(title, filePath, content) { opened.push({ title, filePath, content }); }
    },
    writable: true, configurable: true,
  });

  const confirms = [];
  const alerts = [];
  window.confirm = (msg) => { confirms.push(msg); return window.__confirmAnswer !== false; };
  window.alert = (msg) => { alerts.push(String(msg)); };

  evalInWindow(dom, path.join(PUBLIC_DIR, 'utils.js'));
  evalInWindow(dom, path.join(PUBLIC_DIR, 'shortcuts.js'));
  evalInWindow(dom, path.join(PUBLIC_DIR, 'terminal-themes.js'));
  evalInWindow(dom, path.join(PUBLIC_DIR, 'settings-panel.js'));
  evalInWindow(dom, path.join(PUBLIC_DIR, 'activity-trace-panel.js'));

  return {
    window, document: window.document, calls, opened, confirms, panelOpts, alerts,
    body: () => window.document.getElementById('settings-viewer-body'),
    destroy() { window.close(); },
  };
}

const SAMPLE_FILES = [
  { name: 'activity-trace-20260903-101500.jsonl', filePath: '/home/dev/.switchboard/activity-trace-20260903-101500.jsonl', size: 2048, modified: '2026-09-03T10:15:00.000Z', current: true },
  { name: 'activity-trace-20260902-090000.jsonl', filePath: '/home/dev/.switchboard/activity-trace-20260902-090000.jsonl', size: 5 * 1024 * 1024, modified: '2026-09-02T09:00:00.000Z', current: false },
];

// Waits for the panel's own async render, which is not awaited by the click.
function settle() {
  return new Promise(r => setTimeout(r, 0));
}

test('the Diagnostics section is global-only and reflects the live trace state', async () => {
  const ctx = setup({ traceState: { enabled: true, dir: '/home/dev/.switchboard', currentFile: null, fromEnv: false } });
  try {
    await ctx.window.openSettingsViewer('global');
    await settle();
    const toggle = ctx.body().querySelector('#sv-activity-trace');
    assert.ok(toggle, 'the debug-mode switch is rendered');
    assert.equal(toggle.checked, true, 'it shows the state the main process reports, not a stored guess');

    await ctx.window.openSettingsViewer('project', '/home/dev/proj');
    assert.equal(ctx.body().querySelector('#sv-activity-trace'), null, 'not offered per project');
  } finally { ctx.destroy(); }
});

test('the panel states what is recorded and what it costs on disk', async () => {
  const ctx = setup();
  try {
    await ctx.window.openSettingsViewer('global');
    await settle();
    const text = ctx.body().textContent;
    // The wording is lifted from docs/activity-trace.md; a paraphrase here is
    // how the guarantee stops being true.
    assert.match(text, /only from the chunk's first control character/);
    assert.match(text, /A chunk of printable text has no control character/);
    assert.match(text, /bracketed paste/);
    assert.match(text, /No chunk of plain text is ever rendered/);
    assert.match(text, /4 rotating segments of 16 MB each/);
    assert.match(text, /64 MB ceiling/);
  } finally { ctx.destroy(); }
});

test('flipping the switch takes effect immediately, without Save', async () => {
  const ctx = setup();
  try {
    await ctx.window.openSettingsViewer('global');
    await settle();
    const toggle = ctx.body().querySelector('#sv-activity-trace');
    toggle.checked = true;
    toggle.dispatchEvent(new ctx.window.Event('change'));
    await settle();

    assert.deepEqual(ctx.calls.setEnabled, [true], 'the main process was told at once');
    assert.equal(ctx.window.__savedSettings, null, 'nothing went through the Save path');
  } finally { ctx.destroy(); }
});

test('the switch stays out of the Save payload, so Save cannot silently revert it', async () => {
  const ctx = setup({ traceState: { enabled: true, dir: '/d', currentFile: null, fromEnv: false } });
  try {
    await ctx.window.openSettingsViewer('global');
    await settle();
    ctx.body().querySelector('#sv-save-btn').click();
    await settle();
    assert.ok(ctx.window.__savedSettings, 'Save ran');
    assert.equal('activityTrace' in ctx.window.__savedSettings.value, false,
      'the settings form must not carry an activityTrace key — main owns that preference');
  } finally { ctx.destroy(); }
});

test('the trace files are listed with their size and date', async () => {
  const ctx = setup({ files: SAMPLE_FILES });
  try {
    await ctx.window.openSettingsViewer('global');
    await settle();
    const rows = ctx.body().querySelectorAll('.activity-trace-file');
    assert.equal(rows.length, 2);
    assert.match(rows[0].textContent, /activity-trace-20260903-101500\.jsonl/);
    assert.match(rows[0].textContent, /2\.0 KB/);
    assert.match(rows[0].textContent, /recording/, 'the file being written is marked');
    assert.match(rows[1].textContent, /5\.0 MB/);
    assert.doesNotMatch(rows[1].textContent, /recording/);
  } finally { ctx.destroy(); }
});

test('an empty directory says so instead of rendering nothing', async () => {
  const ctx = setup({ files: [] });
  try {
    await ctx.window.openSettingsViewer('global');
    await settle();
    assert.match(ctx.body().querySelector('.activity-trace-list').textContent, /No trace files yet/);
  } finally { ctx.destroy(); }
});

test('Open reads the file and hands it to a viewer panel', async () => {
  const ctx = setup({ files: SAMPLE_FILES, readResult: { ok: true, content: '{"seq":1}\n', size: 2048, truncated: false } });
  try {
    await ctx.window.openSettingsViewer('global');
    await settle();
    ctx.body().querySelectorAll('.activity-trace-file')[0].querySelectorAll('button')[0].click();
    await settle();

    assert.deepEqual(ctx.calls.read, [SAMPLE_FILES[0].filePath]);
    assert.equal(ctx.opened.length, 1);
    assert.equal(ctx.opened[0].filePath, SAMPLE_FILES[0].filePath);
    assert.equal(ctx.opened[0].content, '{"seq":1}\n');
    assert.equal(ctx.document.getElementById('activity-trace-viewer').style.display, 'flex');
  } finally { ctx.destroy(); }
});

test('a truncated read says so in the panel title instead of pretending to be whole', async () => {
  const big = 16 * 1024 * 1024;
  const ctx = setup({
    files: SAMPLE_FILES,
    readResult: { ok: true, content: 'tail', size: big, truncated: true, shown: 4 * 1024 * 1024 },
  });
  try {
    await ctx.window.openSettingsViewer('global');
    await settle();
    ctx.body().querySelectorAll('.activity-trace-file')[0].querySelectorAll('button')[0].click();
    await settle();
    assert.match(ctx.opened[0].title, /last 4\.0 MB of 16\.0 MB/);
  } finally { ctx.destroy(); }
});

test('Delete asks first, and a refusal deletes nothing', async () => {
  const ctx = setup({ files: SAMPLE_FILES });
  try {
    ctx.window.__confirmAnswer = false;
    await ctx.window.openSettingsViewer('global');
    await settle();
    ctx.body().querySelectorAll('.activity-trace-file')[1].querySelectorAll('button')[1].click();
    await settle();

    assert.equal(ctx.confirms.length, 1, 'the user was asked');
    assert.match(ctx.confirms[0], /This cannot be undone/);
    assert.deepEqual(ctx.calls.deleted, [], 'nothing was deleted');
  } finally { ctx.destroy(); }
});

test('a confirmed Delete removes the file and re-renders the list', async () => {
  const ctx = setup({ files: SAMPLE_FILES });
  try {
    await ctx.window.openSettingsViewer('global');
    await settle();
    ctx.body().querySelectorAll('.activity-trace-file')[1].querySelectorAll('button')[1].click();
    await settle();

    assert.deepEqual(ctx.calls.deleted, [SAMPLE_FILES[1].filePath]);
    assert.equal(ctx.body().querySelectorAll('.activity-trace-file').length, 1, 'the list was refreshed');
  } finally { ctx.destroy(); }
});

test('a rejected delete leaves the list alone and does not lie about it', async () => {
  const ctx = setup({ files: SAMPLE_FILES, deleteResult: { ok: false, error: 'the trace is writing to this file' } });
  try {
    await ctx.window.openSettingsViewer('global');
    await settle();
    ctx.body().querySelectorAll('.activity-trace-file')[0].querySelectorAll('button')[1].click();
    await settle();
    assert.equal(ctx.body().querySelectorAll('.activity-trace-file').length, 2);
  } finally { ctx.destroy(); }
});

test('a delete made from the viewer toolbar refreshes the list behind it', async () => {
  const ctx = setup({ files: SAMPLE_FILES, readResult: { ok: true, content: '{}', size: 10, truncated: false } });
  try {
    await ctx.window.openSettingsViewer('global');
    await settle();
    // Open a file so the ViewerPanel exists, then delete through its toolbar.
    ctx.body().querySelectorAll('.activity-trace-file')[1].querySelectorAll('button')[0].click();
    await settle();
    assert.equal(ctx.panelOpts.length, 1, 'the viewer panel was constructed');

    const result = await ctx.panelOpts[0].onDelete(SAMPLE_FILES[1].filePath);
    await settle();

    assert.equal(result.ok, true);
    assert.deepEqual(ctx.calls.deleted, [SAMPLE_FILES[1].filePath]);
    assert.equal(ctx.body().querySelectorAll('.activity-trace-file').length, 1,
      'the row deleted from the toolbar is gone from the list too');
  } finally { ctx.destroy(); }
});

test('an IPC rejection is reported instead of leaving a dead button', async () => {
  const ctx = setup({ files: SAMPLE_FILES });
  try {
    await ctx.window.openSettingsViewer('global');
    await settle();
    // A main-process handler that throws rejects the invoke promise.
    ctx.window.api = new Proxy({}, {
      get(_t, prop) {
        if (prop === 'deleteActivityTraceFile') return async () => { throw new Error('handler exploded'); };
        if (prop === 'listActivityTraceFiles') return async () => SAMPLE_FILES;
        return () => Promise.resolve({ ok: true });
      },
    });
    const btn = ctx.body().querySelectorAll('.activity-trace-file')[1].querySelectorAll('button')[1];
    btn.click();
    await settle();

    assert.equal(btn.disabled, false, 'the button is usable again');
    assert.equal(ctx.alerts.length, 1, 'the failure was surfaced');
    assert.match(ctx.alerts[0], /handler exploded/);
  } finally { ctx.destroy(); }
});
