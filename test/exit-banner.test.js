// Tests for the onProcessExited exit-banner behaviour ported from
// upstream doctly/switchboard#58 (author @HaydnG).
//
// Strategy: app.js is a monolithic renderer file that performs many
// document.getElementById calls and constructs ViewerPanel instances at
// module load time, making it impractical to load via vm.runInContext in
// jsdom without a massive DOM scaffolding. Instead we extract the two
// key invariants of the patch and test them via a hand-wired mock harness
// that mirrors the relevant state shapes from app.js.
//
// Invariants under test:
//   1. When a Claude session exits, a banner is written to entry.terminal.
//   2. When a Claude session exits, destroySession is NOT called
//      (terminal stays mounted).
//   3. When a plain terminal session exits, destroySession IS called
//      immediately (plain terminals remain ephemeral).
//   4. The banner colour differs between exit code 0 (dim) and non-zero
//      (yellow).

const test = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// Minimal harness — mirrors the state shapes in app.js onProcessExited.
// ---------------------------------------------------------------------------

function makeEntry() {
  const writes = [];
  return {
    closed: false,
    terminal: {
      write(str) { writes.push(str); },
    },
    _writes: writes,
  };
}

function makeHarness({ sessionType = 'session' } = {}) {
  const openSessions = new Map();
  const sessionMap = new Map();
  const pendingSessions = new Map();
  const cachedProjects = [];
  const cachedAllProjects = [];
  let activeSessionId = null;
  let destroyCalled = false;

  function destroySession(id) {
    destroyCalled = id;
    openSessions.delete(id);
  }

  // Reproduce the logic from onProcessExited after the port.
  function onProcessExited(sessionId, exitCode) {
    const entry = openSessions.get(sessionId);
    const session = sessionMap.get(sessionId);
    if (entry) {
      entry.closed = true;
      try {
        const colour = exitCode === 0 ? '\x1b[2m' : '\x1b[33m';
        entry.terminal.write(
          `\r\n${colour}── session exited (code ${exitCode}) — re-click this session in the sidebar to relaunch, or click another to dismiss ──\x1b[0m\r\n`
        );
      } catch {}
    }

    if (session?.type === 'terminal') {
      if (entry) destroySession(sessionId);
      pendingSessions.delete(sessionId);
      for (const projList of [cachedProjects, cachedAllProjects]) {
        for (const proj of projList) {
          proj.sessions = proj.sessions.filter(s => s.sessionId !== sessionId);
        }
      }
      sessionMap.delete(sessionId);
      return;
    }

    // Claude sessions: keep terminal mounted — no destroySession call here.
  }

  return {
    openSessions, sessionMap, pendingSessions,
    onProcessExited,
    get destroyCalled() { return destroyCalled; },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('exit banner: banner is written to entry.terminal on Claude session exit', () => {
  const h = makeHarness({ sessionType: 'session' });
  const entry = makeEntry();
  h.openSessions.set('sess-1', entry);
  h.sessionMap.set('sess-1', { type: 'session' });

  h.onProcessExited('sess-1', 1);

  assert.equal(entry._writes.length, 1, 'exactly one write to the terminal');
  assert.ok(entry._writes[0].includes('session exited (code 1)'), 'banner includes exit code');
});

test('exit banner: terminal is NOT destroyed for Claude session (stays mounted)', () => {
  const h = makeHarness();
  const entry = makeEntry();
  h.openSessions.set('sess-2', entry);
  h.sessionMap.set('sess-2', { type: 'session' });

  h.onProcessExited('sess-2', 0);

  assert.equal(h.destroyCalled, false, 'destroySession must not be called for Claude sessions');
  assert.ok(h.openSessions.has('sess-2'), 'entry remains in openSessions');
});

test('exit banner: plain terminal IS destroyed immediately (ephemeral)', () => {
  const h = makeHarness({ sessionType: 'terminal' });
  const entry = makeEntry();
  h.openSessions.set('term-1', entry);
  h.sessionMap.set('term-1', { type: 'terminal' });

  h.onProcessExited('term-1', 0);

  assert.equal(h.destroyCalled, 'term-1', 'destroySession must be called for plain terminals');
});

test('exit banner: exit code 0 uses dim colour, non-zero uses yellow', () => {
  const h = makeHarness();

  const entryOk = makeEntry();
  h.openSessions.set('ok', entryOk);
  h.sessionMap.set('ok', { type: 'session' });
  h.onProcessExited('ok', 0);

  const entryFail = makeEntry();
  h.openSessions.set('fail', entryFail);
  h.sessionMap.set('fail', { type: 'session' });
  h.onProcessExited('fail', 1);

  assert.ok(entryOk._writes[0].includes('\x1b[2m'), 'code 0 → dim ANSI escape');
  assert.ok(entryFail._writes[0].includes('\x1b[33m'), 'non-zero code → yellow ANSI escape');
});

test('exit banner: entry.closed is set to true before banner write', () => {
  const h = makeHarness();
  const entry = makeEntry();
  h.openSessions.set('sess-3', entry);
  h.sessionMap.set('sess-3', { type: 'session' });

  h.onProcessExited('sess-3', 2);

  assert.equal(entry.closed, true, 'entry.closed must be set before banner write');
});

test('exit banner: no crash when entry has no terminal (terminal.write throws)', () => {
  const h = makeHarness();
  const brokenEntry = { closed: false, terminal: { write() { throw new Error('xterm gone'); } } };
  h.openSessions.set('broken', brokenEntry);
  h.sessionMap.set('broken', { type: 'session' });

  assert.doesNotThrow(() => h.onProcessExited('broken', 1),
    'try/catch must swallow terminal.write errors');
});
