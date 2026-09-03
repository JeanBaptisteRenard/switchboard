// test/pty-ops.test.js — the guarded PTY operations, exercised against a pty
// that throws the way node-pty throws once its child is gone.
'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

const { setPtyOpLogger, withPty, resizePty, killPty, writePty } = require('../pty-ops');
const { handleTerminalInput } = require('../terminal-input');
const { createComposerState } = require('../composer-state');

/** A pty whose every method throws the real node-pty message. */
function makeDeadPty(message = 'Cannot resize a pty that has already exited') {
  const thrower = () => { throw new Error(message); };
  return { pid: process.pid, resize: thrower, kill: thrower, write: thrower };
}

function makeLivePty() {
  const calls = [];
  return {
    pid: process.pid,
    calls,
    resize(cols, rows) { calls.push(['resize', cols, rows]); },
    kill() { calls.push(['kill']); },
    write(d) { calls.push(['write', d]); },
  };
}

function collectingLogger() {
  const lines = [];
  return { lines, debug: (line) => lines.push(line) };
}

test.afterEach(() => setPtyOpLogger(null));

// ── The live path is untouched ───────────────────────────────────────────────

test('resizePty forwards cols/rows to a live pty and reports success', () => {
  const pty = makeLivePty();
  assert.equal(resizePty({ pty }, 80, 24, 's1'), true);
  assert.deepEqual(pty.calls, [['resize', 80, 24]]);
});

test('killPty and writePty forward to a live pty and report success', () => {
  const pty = makeLivePty();
  assert.equal(killPty({ pty }, 's1'), true);
  assert.equal(writePty({ pty }, 'hi', 's1'), true);
  assert.deepEqual(pty.calls, [['kill'], ['write', 'hi']]);
});

// ── The race the crash came from ─────────────────────────────────────────────

test('resizePty swallows the throw of an already-exited pty', () => {
  const session = { pty: makeDeadPty() };
  assert.doesNotThrow(() => resizePty(session, 80, 24, 's1'));
  assert.equal(resizePty(session, 80, 24, 's1'), false);
});

test('killPty swallows the throw of an already-exited pty', () => {
  const session = { pty: makeDeadPty('Cannot kill a pty that has already exited') };
  assert.doesNotThrow(() => killPty(session, 's1'));
  assert.equal(killPty(session, 's1'), false);
});

test('writePty swallows the throw of an already-exited pty', () => {
  const session = { pty: makeDeadPty('Cannot write to a pty that has already exited') };
  assert.doesNotThrow(() => writePty(session, 'x', 's1'));
  assert.equal(writePty(session, 'x', 's1'), false);
});

test('a missing session or a session without a pty is a no-op, not a throw', () => {
  assert.equal(resizePty(undefined, 80, 24, 's1'), false);
  assert.equal(resizePty(null, 80, 24, 's1'), false);
  assert.equal(killPty({}, 's1'), false);
  assert.equal(writePty({ pty: null }, 'x', 's1'), false);
});

// ── What is swallowed is still reported at debug level ───────────────────────

test('a swallowed error is logged once at debug level, with the op and the session', () => {
  const logger = collectingLogger();
  setPtyOpLogger(logger);

  resizePty({ pty: makeDeadPty() }, 80, 24, 'sess-42');

  assert.equal(logger.lines.length, 1);
  assert.match(logger.lines[0], /^\[pty\] resize skipped session=sess-42 reason=/);
  assert.match(logger.lines[0], /already exited/);
});

test('the successful path logs nothing', () => {
  const logger = collectingLogger();
  setPtyOpLogger(logger);

  resizePty({ pty: makeLivePty() }, 80, 24, 'sess-42');
  writePty({ pty: makeLivePty() }, 'x', 'sess-42');

  assert.deepEqual(logger.lines, []);
});

test('an unknown session id still yields a usable log line', () => {
  const logger = collectingLogger();
  setPtyOpLogger(logger);

  killPty({ pty: makeDeadPty('gone') });

  assert.match(logger.lines[0], /^\[pty\] kill skipped session=\? reason=gone$/);
});

test('setPtyOpLogger(null) silences the sink, and a sink without .debug is refused', () => {
  const logger = collectingLogger();

  setPtyOpLogger(logger);
  setPtyOpLogger(null);
  resizePty({ pty: makeDeadPty() }, 80, 24, 's1');
  assert.deepEqual(logger.lines, []);

  setPtyOpLogger({ info: () => {} });
  assert.doesNotThrow(() => resizePty({ pty: makeDeadPty() }, 80, 24, 's1'));
});

// ── The generic form ─────────────────────────────────────────────────────────

test('withPty reports whether the operation ran', () => {
  assert.equal(withPty({ pty: makeLivePty() }, 'probe', () => {}, 's1'), true);
  assert.equal(withPty({ pty: makeLivePty() }, 'probe', () => { throw new Error('x'); }, 's1'), false);
});

// ── The keystroke path, end to end ───────────────────────────────────────────

test('a keystroke to a pty that exits mid-write does not escape handleTerminalInput', () => {
  const session = {
    pty: makeDeadPty('Cannot write to a pty that has already exited'),
    exited: false,
    composerState: createComposerState(),
  };
  const sessions = new Map([['s1', session]]);

  assert.doesNotThrow(() => handleTerminalInput(sessions, 's1', 'hello', 1000));
  // The composer still saw the keystroke — the guard must not skip the bookkeeping.
  assert.equal(session.composerState.pending, 5);
});
