// The probe sites in main.js must cost nothing while the trace is off.
//
// The runtime tests below do not describe the guard, they run it: each probe
// statement is lifted verbatim out of main.js and evaluated in a sandbox where
// every helper it could call and every value it could read explodes on contact.
// With the guard intact and the state off, nothing detonates. The control case
// flips the same state on and requires every one of them to detonate, so a
// green off-case cannot be an inert rig.

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const lines = mainSrc.split('\n');

// Naming the categories rather than counting them: a probe silently deleted in
// a refactor is the failure this guards against, and a bare count would let one
// vanish as long as another appeared.
const EXPECTED_PROBES = [
  'app.quit', 'busy.emit', 'busy.emit', 'busy.emit', 'osc.notify',
  'osc.progress', 'osc.title', 'poll.snapshot', 'pty.exit', 'pty.input',
];

// The forwarder behind the `activity-trace` IPC channel is deliberately
// unguarded: it must stay registered so a runtime enable needs no new
// listener, and trace() drops the line itself while the trace is off.
const UNGUARDED_FORWARDER = /trace\(typeof cat === 'string'/;

function probeStatements() {
  const inline = [];
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*if \(TRACE\.on\) trace\(/.test(line)) {
      inline.push({ line: i + 1, code: line.trim() });
      continue;
    }
    if (/^\s*if \(TRACE\.on\) \{\s*$/.test(line)) {
      const indent = line.match(/^\s*/)[0];
      let end = -1;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j] === indent + '}') { end = j; break; }
      }
      assert.notEqual(end, -1, `unclosed TRACE.on block at main.js:${i + 1}`);
      const body = lines.slice(i, end + 1).join('\n');
      if (/(?<![.\w])trace\(/.test(body)) blocks.push({ line: i + 1, code: body });
    }
  }
  return [...inline, ...blocks];
}

function unguardedTraceCalls() {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/(?<![.\w])trace\(/.test(line)) continue;
    if (/^\s*(\/\/|\*)/.test(line)) continue;
    if (/^\s*if \(TRACE\.on\) trace\(/.test(line)) continue;
    // Inside a `if (TRACE.on) {` block: an open guard above, not yet closed.
    let inBlock = false;
    for (let j = i - 1; j >= 0 && j > i - 12; j--) {
      if (/^\s*if \(TRACE\.on\) \{\s*$/.test(lines[j])) { inBlock = true; break; }
      if (/^\s*\}/.test(lines[j])) break;
    }
    if (inBlock) continue;
    out.push({ line: i + 1, code: line.trim() });
  }
  return out;
}

// A value that cannot be touched without saying so.
function landmine(label) {
  return new Proxy({}, {
    get(_t, key) {
      if (key === Symbol.toPrimitive || key === 'then') return undefined;
      throw new Error(`${label}.${String(key)} was read while the trace was off`);
    },
  });
}

function sandboxFor(state, calls) {
  const boom = (name) => () => {
    calls.push(name);
    throw new Error(`${name}() was called while the trace was off`);
  };
  return {
    TRACE: state,
    trace: boom('trace'),
    codePoints: boom('codePoints'),
    controlOffset: boom('controlOffset'),
    busyDecision: boom('busyDecision'),
    progressDecision: boom('progressDecision'),
    // Every free value the probe statements can reach.
    active: landmine('active'),
    currentId: landmine('currentId'),
    payload: landmine('payload'),
    session: landmine('session'),
    mainWindow: landmine('mainWindow'),
    isBusy: landmine('isBusy'),
    isIdle: landmine('isIdle'),
    via: landmine('via'),
    level: landmine('level'),
    realId: landmine('realId'),
    sessionId: landmine('sessionId'),
    exitCode: landmine('exitCode'),
    data: landmine('data'),
  };
}

test('main.js binds TRACE to the live state object, not a boolean snapshot', () => {
  assert.match(
    mainSrc,
    /const \{ state: TRACE, trace, codePoints, controlOffset, busyDecision, progressDecision \} = activityTrace;/,
    'TRACE must be the mutable state object — destructuring `enabled` would freeze the flag at require time and kill the runtime toggle',
  );
  assert.doesNotMatch(
    mainSrc, /enabled: TRACE\s*[,;)]/,
    'main.js must not snapshot activityTrace.enabled into TRACE',
  );
});

test('main.js still carries every guarded probe site, by category', () => {
  const found = [];
  for (const probe of probeStatements()) {
    const m = probe.code.match(/trace\('([^']+)'/);
    assert.ok(m, `main.js:${probe.line} guards something that is not a trace() call`);
    found.push(m[1]);
  }
  assert.deepEqual(found.sort(), EXPECTED_PROBES);
});

test('every trace() call in main.js is guarded, except the IPC forwarder', () => {
  const loose = unguardedTraceCalls();
  for (const call of loose) {
    assert.match(
      call.code, UNGUARDED_FORWARDER,
      `main.js:${call.line} calls trace() outside an if (TRACE.on) guard: ${call.code}`,
    );
  }
  assert.equal(loose.length, 1, 'the renderer forwarder is the only unguarded call');
});

test('with the trace off, no probe statement calls a helper or reads a payload value', () => {
  const probes = probeStatements();
  assert.equal(probes.length, EXPECTED_PROBES.length);
  const calls = [];
  const sandbox = sandboxFor({ on: false }, calls);
  vm.createContext(sandbox);
  for (const probe of probes) {
    assert.doesNotThrow(
      () => vm.runInContext(probe.code, sandbox, { filename: `main.js:${probe.line}` }),
      `main.js:${probe.line} did work while the trace was off`,
    );
  }
  assert.deepEqual(calls, [], 'no trace helper ran while the trace was off');
});

test('control: with the trace on, every one of those statements detonates', () => {
  // Without this, the test above would pass just as well against a rig that
  // cannot observe anything at all.
  const probes = probeStatements();
  const calls = [];
  const sandbox = sandboxFor({ on: true }, calls);
  vm.createContext(sandbox);
  for (const probe of probes) {
    assert.throws(
      () => vm.runInContext(probe.code, sandbox, { filename: `main.js:${probe.line}` }),
      `main.js:${probe.line} evaluated to nothing with the trace on — it is not a live probe`,
    );
  }
});

test('the renderer half keeps its flag mutable and follows the main process', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'activity-trace.js'), 'utf8');
  assert.match(
    src, /api\.onActivityTraceState\(/,
    'the renderer must follow runtime state changes pushed by main',
  );
  assert.match(
    src, /window\.ATRACE = !!enabled;/,
    'the pushed state must land on window.ATRACE, the flag every renderer probe reads',
  );
  assert.match(
    src, /window\.atrace = wired/,
    'atrace must forward whenever the bridge exists — gating it on the startup flag would freeze the renderer off',
  );
});
