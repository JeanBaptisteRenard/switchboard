// Tests for the renderer half of the activity trace: public/activity-trace.js
// and the probe sites it gates in public/session-activity.js.
//
// The point of these is the OFF path. Probe sites read window.ATRACE before
// building anything, so with the trace disabled no payload literal is
// evaluated and no IPC is sent — see docs/activity-trace.md.

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { setupSidebarDom } = require('./dom-setup');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function setup({ traceEnabled }) {
  const dom = new JSDOM(
    '<!DOCTYPE html><html><body><div id="sidebar-content">'
    + '<div class="session-item" id="si-s1" data-session-id="s1"><div class="session-status-dot"></div></div>'
    + '</div></body></html>',
    { url: 'http://localhost/', runScripts: 'outside-only' }
  );
  const { window } = dom;

  const sent = [];
  let pushState = null;
  Object.defineProperty(window, 'api', {
    value: {
      activityTraceEnabled: traceEnabled,
      traceActivity: (cat, sid, fields) => sent.push({ cat, sid, fields }),
      onActivityTraceState: (cb) => { pushState = cb; },
    },
    writable: true, configurable: true,
  });
  Object.defineProperty(window, 'activeSessionId', { value: null, writable: true, configurable: true });

  const ctx = dom.getInternalVMContext();
  for (const file of ['activity-trace.js', 'session-activity.js']) {
    const full = path.join(PUBLIC_DIR, file);
    vm.runInContext(fs.readFileSync(full, 'utf8'), ctx, { filename: full });
  }
  return {
    window, sent,
    run: (expr) => vm.runInContext(expr, ctx),
    pushTraceState: (on) => {
      assert.ok(pushState, 'the renderer subscribed to state pushes');
      pushState(on);
    },
  };
}

test('the renderer trace is off unless the preload says otherwise', () => {
  const { window, sent, run } = setup({ traceEnabled: false });
  assert.equal(window.ATRACE, false);

  run('setActivity("s1", true, "test")');
  run('setActivity("s1", false, "test")');
  run('clearUnread("s1")');
  run('rekeyActivityState("s1", "s2")');
  run('reconcileBusyState([{ sessionId: "s2", busy: true }], 0)');

  assert.deepEqual(sent, [], 'not one probe fired, so no payload was built');
});

test('a disabled probe site never evaluates its payload expression', () => {
  const { window, run } = setup({ traceEnabled: false });
  // Stand in for the payload literal: if a probe site called through, the
  // guard would have read ATRACE as truthy and this counter would move.
  let reads = 0;
  Object.defineProperty(window, 'atrace', {
    get() { reads += 1; return () => {}; },
    configurable: true,
  });
  run('setActivity("s1", true, "test")');
  run('setActivity("s1", false, "test")');
  assert.equal(reads, 0, 'window.atrace was never even looked up');
});

test('an enabled trace forwards each mutation with its before/after and caller', () => {
  const { window, sent, run } = setup({ traceEnabled: true });
  assert.equal(window.ATRACE, true);

  run('setActivity("s1", true, "onCliBusyState")');
  const busy = sent.find(e => e.cat === 'store.mutate' && e.fields.map === 'sessionBusyState');
  assert.ok(busy);
  assert.equal(busy.sid, 's1');
  assert.equal(busy.fields.from, false);
  assert.equal(busy.fields.to, true);
  assert.equal(busy.fields.fn, 'setActivity');
  assert.equal(busy.fields.via, 'onCliBusyState');

  const cls = sent.find(e => e.cat === 'class.apply');
  assert.equal(cls.fields.el, 'si-s1');
  assert.equal(cls.fields['cli-busy'], true);
});

test('an enabled trace records the response-ready lock that swallows an idle', () => {
  const { sent, run } = setup({ traceEnabled: true });
  run('setActivity("s1", true, "onCliBusyState")');
  run('setActivity("s1", false, "onCliBusyState")'); // unfocused → response-ready
  sent.length = 0;
  run('setActivity("s1", false, "onCliBusyState")'); // swallowed by the lock

  const skip = sent.find(e => e.cat === 'store.skip');
  assert.ok(skip, 'the suppressed write is traced, not silently dropped');
  assert.equal(skip.fields.reason, 'response-ready-holds-idle');
});

test('reconciliation distinguishes applied, raced and no-op entries', () => {
  const { sent, run } = setup({ traceEnabled: true });
  run('setActivity("s1", true, "onCliBusyState")'); // bumps the session seq to 1
  sent.length = 0;

  run('reconcileBusyState([{ sessionId: "s1", busy: false }], 0)'); // poll predates the change
  assert.equal(sent.filter(e => e.cat === 'reconcile.skip')[0].fields.reason, 'raced-since-poll');

  sent.length = 0;
  run('reconcileBusyState([{ sessionId: "s1", busy: true }], 99)');
  assert.equal(sent.filter(e => e.cat === 'reconcile.noop').length, 1);

  sent.length = 0;
  run('reconcileBusyState([{ sessionId: "s1", busy: false }], 99)');
  assert.equal(sent.filter(e => e.cat === 'reconcile.apply').length, 1);
});

test('probe sites survive a context with no preload bridge at all', () => {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'http://localhost/', runScripts: 'outside-only' });
  const ctx = dom.getInternalVMContext();
  Object.defineProperty(dom.window, 'activeSessionId', { value: null, writable: true, configurable: true });
  for (const file of ['activity-trace.js', 'session-activity.js']) {
    const full = path.join(PUBLIC_DIR, file);
    vm.runInContext(fs.readFileSync(full, 'utf8'), ctx, { filename: full });
  }
  assert.equal(dom.window.ATRACE, false);
  assert.doesNotThrow(() => vm.runInContext('setActivity("s1", true)', ctx));
});

// --- sidebar.js probes ------------------------------------------------------
// sidebar.js registers its subagent listeners at eval time, but the probes read
// window.ATRACE when they run, so the trace can be armed after setup.

function armedSidebar() {
  const ctx = setupSidebarDom();
  const sent = [];
  ctx.window.ATRACE = true;
  ctx.window.atrace = (cat, sid, fields) => sent.push({ cat, sid, fields });
  return { ctx, sent };
}

test('a heartbeat for an untracked agent is traced as ignored, not as a spawn', () => {
  const { ctx, sent } = armedSidebar();
  try {
    ctx.emitSubagentSpawned({ parentSessionId: 'p1', agentId: 'a1', _heartbeat: true });

    const probe = sent.find(e => e.cat === 'recv.subagent-spawned');
    assert.ok(probe, 'the rejected heartbeat still leaves a trace line');
    assert.equal(probe.fields.applied, false);
    assert.equal(probe.fields.op, 'ignore');
    assert.equal(probe.fields.reason, 'heartbeat-for-untracked-agent');
    assert.equal(sent.some(e => e.cat === 'class.subagent'), false,
      'nothing was reflected to the DOM, which is the point of the trace line');
  } finally { ctx.destroy(); }
});

test('a spawn is traced as applied, and a following heartbeat refreshes it', () => {
  const { ctx, sent } = armedSidebar();
  try {
    ctx.emitSubagentSpawned({ parentSessionId: 'p1', agentId: 'a1', subagentType: 'explore' });
    const spawn = sent.find(e => e.cat === 'recv.subagent-spawned');
    assert.equal(spawn.fields.applied, true);
    assert.equal(spawn.fields.heartbeat, false);
    assert.equal(spawn.fields.from, null, 'no previous sighting');

    sent.length = 0;
    ctx.emitSubagentSpawned({ parentSessionId: 'p1', agentId: 'a1', _heartbeat: true });
    const beat = sent.find(e => e.cat === 'recv.subagent-spawned');
    assert.equal(beat.fields.applied, true, 'a heartbeat for a tracked agent still refreshes it');
    assert.equal(beat.fields.heartbeat, true);
    assert.equal(typeof beat.fields.from, 'number', 'the previous sighting is reported');
  } finally { ctx.destroy(); }
});

test('a bootstrap spawn is distinguishable from a real one in the trace', () => {
  const { ctx, sent } = armedSidebar();
  try {
    ctx.emitSubagentSpawned({ parentSessionId: 'p1', agentId: 'a1', _bootstrap: true });
    const probe = sent.find(e => e.cat === 'recv.subagent-spawned');
    assert.equal(probe.fields.bootstrap, true);
    assert.equal(probe.fields.applied, true);
  } finally { ctx.destroy(); }
});

// --- runtime toggling, renderer side -----------------------------------------

test('a state push from main arms the renderer without a reload', () => {
  const { window, sent, run, pushTraceState } = setup({ traceEnabled: false });
  assert.equal(window.ATRACE, false);

  run('setActivity("s1", true, "before")');
  assert.deepEqual(sent, [], 'silent while off');

  pushTraceState(true);
  assert.equal(window.ATRACE, true);

  run('setActivity("s1", false, "after")');
  const mutation = sent.find(e => e.cat === 'store.mutate' && e.fields.map === 'sessionBusyState');
  assert.ok(mutation, 'the same probe now forwards');
  assert.equal(mutation.fields.via, 'after');
});

test('a state push from main disarms the renderer again', () => {
  const { window, sent, run, pushTraceState } = setup({ traceEnabled: true });
  run('setActivity("s1", true, "on")');
  const before = sent.length;
  assert.ok(before > 0);

  pushTraceState(false);
  assert.equal(window.ATRACE, false);

  run('setActivity("s1", false, "off")');
  assert.equal(sent.length, before, 'not one probe fired after the push');
});

test('the forwarder survives a startup-off launch, so a later enable can use it', () => {
  // Gating window.atrace itself on the startup flag would leave the renderer
  // permanently mute whatever main later says.
  const { window } = setup({ traceEnabled: false });
  assert.equal(typeof window.atrace, 'function');
  assert.equal(window.atrace.name, 'atrace', 'the real forwarder, not the disabled stub');
});
