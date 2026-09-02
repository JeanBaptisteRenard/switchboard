// test/trigger-context.test.js — the ctx object main.js hands to trigger-watcher.
'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

const { createTriggerContext } = require('../trigger-context');
const { createComposerState, noteUserInput } = require('../composer-state');

const silentLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function makeSession(overrides = {}) {
  return {
    pty: { pid: process.pid, write() {} },
    exited: false,
    _cliBusy: false,
    composerState: createComposerState(),
    ...overrides,
  };
}

function ctxWith(sessions) {
  return createTriggerContext({ activeSessions: new Map(sessions), log: silentLog });
}

test('getComposerState returns { pending, lastInputAt } for a live session', () => {
  const session = makeSession();
  noteUserInput(session.composerState, 'half a sentence', 4242);
  const ctx = ctxWith([['s1', session]]);

  assert.deepEqual(ctx.getComposerState('s1'), { pending: 15, lastInputAt: 4242 });
});

test('getComposerState returns null for an unknown session', () => {
  const ctx = ctxWith([['s1', makeSession()]]);
  assert.equal(ctx.getComposerState('nope'), null);
});

test('getComposerState returns null for an exited session', () => {
  const ctx = ctxWith([['s1', makeSession({ exited: true })]]);
  assert.equal(ctx.getComposerState('s1'), null);
});

test('getComposerState returns null for a session carrying no composerState', () => {
  const ctx = ctxWith([['s1', makeSession({ composerState: undefined })]]);
  assert.equal(ctx.getComposerState('s1'), null);
});

test('getPtyForSession exposes the pty of a live session and null otherwise', () => {
  const live   = makeSession();
  const exited = makeSession({ exited: true });
  const ctx    = ctxWith([['live', live], ['exited', exited]]);

  assert.equal(ctx.getPtyForSession('live').ptyProcess, live.pty);
  assert.equal(ctx.getPtyForSession('exited'), null);
  assert.equal(ctx.getPtyForSession('nope'), null);
});

test('isSessionBusy reads _cliBusy and is false for an unknown session', () => {
  const ctx = ctxWith([
    ['busy', makeSession({ _cliBusy: true })],
    ['idle', makeSession()],
  ]);

  assert.equal(ctx.isSessionBusy('busy'), true);
  assert.equal(ctx.isSessionBusy('idle'), false);
  assert.equal(ctx.isSessionBusy('nope'), false);
});

test('log is forwarded, and isPtyAlive is only present when supplied', () => {
  const plain = createTriggerContext({ activeSessions: new Map(), log: silentLog });
  assert.equal(plain.log, silentLog);
  assert.equal('isPtyAlive' in plain, false);

  const probe = () => true;
  const withProbe = createTriggerContext({
    activeSessions: new Map(), log: silentLog, isPtyAlive: probe,
  });
  assert.equal(withProbe.isPtyAlive, probe);
});
