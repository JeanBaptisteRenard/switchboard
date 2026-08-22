// Tests for public/session-activity.js — the busy / response-ready state
// machine behind the sidebar's braille spinner.
//
// Unlike test/running-indicators.test.js, these exercise the SHIPPED file:
// session-activity.js was split out of app.js precisely so it can be evaluated
// in jsdom (app.js builds ViewerPanel/xterm objects at module scope and cannot).
//
// Its top-level `const`/`let` bindings land in the context's global lexical
// scope, which is not reachable as a property of `window` — a second
// runInContext expression in the same context is how we read them back.

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const SRC = path.join(__dirname, '..', 'public', 'session-activity.js');

function setup(sessionIds = ['s1', 's2']) {
  const items = sessionIds
    .map(id => `<div class="session-item" data-session-id="${id}"><div class="session-status-dot"></div></div>`)
    .join('');
  const dom = new JSDOM(`<!DOCTYPE html><html><body><div id="sidebar-content">${items}</div></body></html>`,
    { url: 'http://localhost/', runScripts: 'outside-only' });
  const { window } = dom;

  // app.js declares activeSessionId; session-activity.js only reads it.
  Object.defineProperty(window, 'activeSessionId', { value: null, writable: true, configurable: true });

  const ctx = dom.getInternalVMContext();
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), ctx, { filename: SRC });

  const read = (expr) => vm.runInContext(expr, ctx);
  return {
    window,
    document: window.document,
    item: (id) => window.document.querySelector(`.session-item[data-session-id="${id}"]`),
    setActivity: read('setActivity'),
    clearUnread: read('clearUnread'),
    rekeyActivityState: read('rekeyActivityState'),
    reconcileBusyState: read('reconcileBusyState'),
    currentActivitySeq: read('currentActivitySeq'),
    forgetActivitySeq: read('forgetActivitySeq'),
    responseReadySessions: read('responseReadySessions'),
    sessionBusyState: read('sessionBusyState'),
    attentionSessions: read('attentionSessions'),
    activitySeqBySession: read('activitySeqBySession'),
    destroy: () => window.close(),
  };
}

// ---------------------------------------------------------------------------
// The bug: the response-ready lock swallowed whole turns
// ---------------------------------------------------------------------------

test('busy=true on a response-ready session updates the map, sets .cli-busy and drops the unread marker', () => {
  const t = setup();
  t.window.activeSessionId = 's2'; // s1 is NOT the focused session

  // s1 finishes a turn while the user is looking elsewhere → response-ready.
  t.setActivity('s1', true);
  t.setActivity('s1', false);
  assert.ok(t.responseReadySessions.has('s1'), 'precondition: s1 is response-ready');

  // s1 starts generating again with no click in between (cron, trigger, resume).
  t.setActivity('s1', true);

  assert.equal(t.sessionBusyState.get('s1'), true, 'sessionBusyState updated despite the response-ready lock');
  assert.ok(!t.responseReadySessions.has('s1'), 's1 removed from responseReadySessions — the unread marker is stale');
  assert.ok(t.item('s1').classList.contains('cli-busy'), '.cli-busy set');
  assert.ok(!t.item('s1').classList.contains('response-ready'), '.response-ready removed');

  t.destroy();
});

test('busy → idle (unfocused) → busy: the spinner is back on the second busy', () => {
  const t = setup();
  t.window.activeSessionId = 's2';

  t.setActivity('s1', true);
  assert.ok(t.item('s1').classList.contains('cli-busy'), 'spinner on first busy');

  t.setActivity('s1', false);
  assert.ok(!t.item('s1').classList.contains('cli-busy'), 'spinner off when the turn ends');
  assert.ok(t.item('s1').classList.contains('response-ready'), 'response-ready while unread');

  t.setActivity('s1', true);
  assert.ok(t.item('s1').classList.contains('cli-busy'), 'spinner back on the second busy — this is the reported bug');

  // And a third cycle still behaves.
  t.setActivity('s1', false);
  t.setActivity('s1', true);
  assert.ok(t.item('s1').classList.contains('cli-busy'), 'spinner back on the third busy');

  t.destroy();
});

test('busy=false on a response-ready session does NOT overwrite the unread marker', () => {
  const t = setup();
  t.window.activeSessionId = 's2';

  t.setActivity('s1', true);
  t.setActivity('s1', false);
  const seqAfterMarker = t.currentActivitySeq();
  assert.ok(t.responseReadySessions.has('s1'));

  // A late "waiting for your input" notification, or a duplicate OSC 0 idle.
  t.setActivity('s1', false);

  assert.ok(t.responseReadySessions.has('s1'), 'response-ready preserved');
  assert.ok(t.item('s1').classList.contains('response-ready'), '.response-ready still on the item');
  assert.equal(t.currentActivitySeq(), seqAfterMarker, 'the ignored idle signal is not counted as a transition');

  t.destroy();
});

test('a focused session going idle is not marked response-ready', () => {
  const t = setup();
  t.window.activeSessionId = 's1';

  t.setActivity('s1', true);
  t.setActivity('s1', false);

  assert.ok(!t.responseReadySessions.has('s1'), 'the user is looking at it — nothing unread');
  assert.ok(!t.item('s1').classList.contains('response-ready'));
  assert.ok(!t.item('s1').classList.contains('cli-busy'));

  t.destroy();
});

test('clearUnread re-exposes the spinner when the session is still generating', () => {
  const t = setup();
  t.window.activeSessionId = 's2';

  t.setActivity('s1', true);
  t.setActivity('s1', false);
  t.setActivity('s1', true); // busy again, marker already dropped
  t.responseReadySessions.add('s1'); // force the stale combination
  t.item('s1').classList.add('response-ready');

  t.clearUnread('s1');

  assert.ok(t.item('s1').classList.contains('cli-busy'), 'cli-busy restored from sessionBusyState');
  assert.ok(!t.item('s1').classList.contains('response-ready'));

  t.destroy();
});

// ---------------------------------------------------------------------------
// Fork / session-detected re-keying
// ---------------------------------------------------------------------------

test('rekeyActivityState carries busy state and DOM class from oldId to newId', () => {
  const t = setup(['old', 'new']);
  t.window.activeSessionId = 'other';

  t.setActivity('old', true);
  assert.ok(t.item('old').classList.contains('cli-busy'), 'precondition: old is busy');

  t.rekeyActivityState('old', 'new');

  assert.equal(t.sessionBusyState.get('new'), true, 'busy state moved to newId');
  assert.ok(!t.sessionBusyState.has('old'), 'old key dropped');
  assert.ok(t.item('new').classList.contains('cli-busy'), '.cli-busy follows to the new item');
  assert.ok(!t.item('old').classList.contains('cli-busy'), '.cli-busy removed from the stale item');

  t.destroy();
});

test('rekeyActivityState carries response-ready and needs-attention too', () => {
  const t = setup(['old', 'new']);
  t.window.activeSessionId = 'other';

  t.setActivity('old', true);
  t.setActivity('old', false);
  t.attentionSessions.add('old');
  t.item('old').classList.add('needs-attention');
  assert.ok(t.responseReadySessions.has('old'));

  t.rekeyActivityState('old', 'new');

  assert.ok(t.responseReadySessions.has('new') && !t.responseReadySessions.has('old'));
  assert.ok(t.attentionSessions.has('new') && !t.attentionSessions.has('old'));
  assert.ok(t.item('new').classList.contains('response-ready'));
  assert.ok(t.item('new').classList.contains('needs-attention'));
  assert.ok(!t.item('old').classList.contains('response-ready'));
  assert.ok(!t.item('old').classList.contains('needs-attention'));

  t.destroy();
});

// ---------------------------------------------------------------------------
// Resynchronisation against the backend snapshot
// ---------------------------------------------------------------------------

test('reconcileBusyState marks a session busy with no transition event ever emitted', () => {
  const t = setup();
  assert.equal(t.sessionBusyState.size, 0, 'renderer starts blind (fresh reload)');

  t.reconcileBusyState([{ sessionId: 's1', busy: true }, { sessionId: 's2', busy: false }], t.currentActivitySeq());

  assert.equal(t.sessionBusyState.get('s1'), true, 's1 realigned from the poll snapshot');
  assert.ok(t.item('s1').classList.contains('cli-busy'), '.cli-busy set without any cli-busy-state front');
  assert.ok(!t.item('s2').classList.contains('cli-busy'), 's2 left alone');

  t.destroy();
});

test('reconcileBusyState is not swallowed by the response-ready lock', () => {
  const t = setup();
  t.window.activeSessionId = 's2';

  t.setActivity('s1', true);
  t.setActivity('s1', false);
  assert.ok(t.responseReadySessions.has('s1'));

  // The backend says s1 is generating again; the busy front went missing.
  t.reconcileBusyState([{ sessionId: 's1', busy: true }], t.currentActivitySeq());

  assert.equal(t.sessionBusyState.get('s1'), true);
  assert.ok(!t.responseReadySessions.has('s1'));
  assert.ok(t.item('s1').classList.contains('cli-busy'));

  t.destroy();
});

test('reconcileBusyState turns a stuck spinner off when the backend says idle', () => {
  const t = setup();
  t.window.activeSessionId = 's1'; // focused, so no response-ready marker

  t.setActivity('s1', true);
  t.reconcileBusyState([{ sessionId: 's1', busy: false }], t.currentActivitySeq());

  assert.equal(t.sessionBusyState.get('s1'), false);
  assert.ok(!t.item('s1').classList.contains('cli-busy'));

  t.destroy();
});

test('reconcileBusyState does not overwrite an event that landed while the poll was in flight', () => {
  const t = setup();
  t.window.activeSessionId = 's1';

  const seq = t.currentActivitySeq(); // snapshot taken before the IPC call
  t.setActivity('s1', true);          // fresh event arrives during the round-trip

  // Stale reply computed before the event.
  t.reconcileBusyState([{ sessionId: 's1', busy: false }], seq);

  assert.equal(t.sessionBusyState.get('s1'), true, 'the fresher live event wins');
  assert.ok(t.item('s1').classList.contains('cli-busy'));

  t.destroy();
});

test('forgetActivitySeq drops the per-session counter so a dead session leaks nothing', () => {
  const t = setup();
  t.window.activeSessionId = 's2';

  t.setActivity('s1', true);
  assert.ok(t.activitySeqBySession.has('s1'), 'precondition: the transition was recorded');

  t.forgetActivitySeq('s1');

  assert.ok(!t.activitySeqBySession.has('s1'), 'counter entry removed with the session');
  assert.equal(t.activitySeqBySession.size, 0, 'nothing left behind');

  t.destroy();
});

test('reconcileBusyState ignores malformed payloads', () => {
  const t = setup();
  t.reconcileBusyState(undefined);
  t.reconcileBusyState(null);
  t.reconcileBusyState([null, {}, { sessionId: 42 }, 'nope']);
  assert.equal(t.sessionBusyState.size, 0);
  t.destroy();
});

// ---------------------------------------------------------------------------
// Visual arbitration between busy and response-ready
// ---------------------------------------------------------------------------

test('busy wins over response-ready: the two classes are mutually exclusive by construction', () => {
  // Decision: a session that resumed generating is busy, not "answer waiting".
  // applyActivityClasses is the only writer of both classes and never sets
  // them together, so the CSS cascade is never asked to arbitrate.
  const t = setup();
  t.window.activeSessionId = 's2';

  for (const step of [true, false, true, false, true]) {
    t.setActivity('s1', step);
    const cls = t.item('s1').classList;
    assert.ok(!(cls.contains('cli-busy') && cls.contains('response-ready')),
      'cli-busy and response-ready are never both set');
  }

  t.destroy();
});

test('style.css: even if both classes were set, the cli-busy spinner still wins on the dot', () => {
  // Belt and braces for the mutual exclusion above — jsdom does not resolve
  // ::before content, so this pins the cascade at the source level. The
  // response-ready rule (.session-item.response-ready .session-status-dot)
  // comes LATER in the file, so without !important + the extra :not() class
  // it would repaint the dot over the spinner.
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
  const busyRule = css.match(/\.session-item\.cli-busy:not\(\.needs-attention\) \.session-status-dot,[\s\S]*?\}/);
  assert.ok(busyRule, 'the cli-busy status-dot rule must still exist');
  assert.match(busyRule[0], /background:\s*transparent\s*!important/,
    'the cli-busy dot must clear its background with !important so response-ready cannot repaint over the spinner');
  assert.match(css, /\.session-item\.cli-busy:not\(\.needs-attention\) \.session-status-dot::before/,
    'the braille spinner ::before must still be keyed on cli-busy');
});

// ---------------------------------------------------------------------------
// Source-level pins for the wiring that lives outside session-activity.js
// ---------------------------------------------------------------------------

test('main.js: get-active-sessions reports the busy flag alongside the session id', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const start = src.indexOf("ipcMain.handle('get-active-sessions'");
  assert.notEqual(start, -1, 'the get-active-sessions handler must still exist');
  const body = src.slice(start, start + 400);
  assert.match(body, /\{\s*sessionId,\s*busy:\s*!!session\._cliBusy\s*\}/,
    'the handler must carry _cliBusy so the renderer can realign without a transition event');
});

test('public/app.js: the poll reconciles busy state and re-keys it on fork/detect', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const poll = src.slice(src.indexOf('async function pollActiveSessions'), src.indexOf('async function pollActiveSessions') + 500);
  assert.match(poll, /currentActivitySeq\(\)/, 'the poll must snapshot the activity sequence before the IPC call');
  assert.match(poll, /reconcileBusyState\(entries,\s*seq\)/, 'the poll must reconcile the busy state');
  assert.match(poll, /entries\.map\(e => e\.sessionId\)/, 'activePtyIds must be rebuilt from the new payload shape');

  const forked = src.slice(src.indexOf('window.api.onSessionForked'), src.indexOf('window.api.onProcessExited'));
  assert.match(forked, /rekeyActivityState\(oldId, newId\)/, 'a fork must carry the activity state to the new id');

  const detected = src.slice(src.indexOf('window.api.onSessionDetected'), src.indexOf('window.api.onSessionForked'));
  assert.match(detected, /rekeyActivityState\(tempId, realId\)/, 'session detection must carry the activity state to the real id');
});

test('public/app.js: the pty-stop cleanup also purges the activity counter', () => {
  // activitySeqBySession is the one activity collection updateRunningIndicators
  // cannot see directly; without this call a long-lived window accumulates one
  // entry per session that ever ran.
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const scanStart = src.indexOf("document.querySelectorAll('.session-item').forEach(item => {");
  assert.notEqual(scanStart, -1, 'the .session-item pty-set scan must still exist');
  const body = src.slice(scanStart, scanStart + 1200);
  assert.match(body, /sessionBusyState\.delete\(id\);\s*\n\s*forgetActivitySeq\(id\);/,
    'forgetActivitySeq must sit with the other per-session purges in the !running branch');
});
