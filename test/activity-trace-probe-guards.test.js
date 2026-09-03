// The probe sites in main.js must cost nothing while the trace is off.
//
// What protects that property is syntax, and this file says so plainly rather
// than dressing it up. An earlier version of these tests lifted each guarded
// statement into a sandbox of exploding stubs and asserted that nothing
// detonated with the state off. That proved only that `if (false) X` does not
// evaluate `X` — a guarantee of the language, not of this code: work done
// *before* a guard sits on a different line, which such a rig never even
// loads. A realistic faulty probe (`const cp = codePoints(payload, 3);` above
// the guard at the osc.title site) passed it untouched.
//
// So the checks below are source scans, and they are the only thing standing
// between the codebase and an unguarded probe. They are deliberately blunt:
// every call to a trace helper in main.js must sit under `if (TRACE.on)`.

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MAIN_PATH = path.join(__dirname, '..', 'main.js');
const mainSrc = fs.readFileSync(MAIN_PATH, 'utf8');

// Naming the categories rather than counting them: a probe silently deleted in
// a refactor is the failure this guards against, and a bare count would let one
// vanish as long as another appeared.
const EXPECTED_PROBES = [
  'app.quit', 'busy.emit', 'busy.emit', 'busy.emit', 'osc.notify',
  'osc.progress', 'osc.title', 'poll.snapshot', 'pty.exit', 'pty.input',
];

// Everything whose evaluation costs something: the writer and the four payload
// helpers that render code points and mirror the OSC decisions.
const TRACE_HELPERS = ['trace', 'codePoints', 'controlOffset', 'busyDecision', 'progressDecision'];
const HELPER_CALL = new RegExp('(?<![.\\w])(' + TRACE_HELPERS.join('|') + ')\\s*\\(');

// The forwarder behind the `activity-trace` IPC channel is deliberately
// unguarded: it must stay registered so a runtime enable needs no new
// listener, and trace() drops the line itself while the trace is off.
const UNGUARDED_FORWARDER = /trace\(typeof cat === 'string'/;

// Split on either ending: with core.autocrlf=true and no .gitattributes, a
// fresh clone on Windows hands these tests CRLF, and a strict `=== '}'` would
// fail there while CI stays green.
function sourceLines(src) {
  return src.split(/\r?\n/);
}

function isCommentLine(line) {
  return /^\s*(\/\/|\*|\/\*)/.test(line);
}

function collect(src) {
  const lines = sourceLines(src);
  const probes = [];
  const looseTrace = [];
  const looseHelpers = [];

  const openGuardAbove = (i) => {
    for (let j = i - 1; j >= 0 && j > i - 12; j--) {
      if (/^\s*if \(TRACE\.on\) \{\s*$/.test(lines[j])) return true;
      if (/^\s*\}/.test(lines[j])) return false;
    }
    return false;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/^\s*if \(TRACE\.on\) trace\(/.test(line)) {
      probes.push({ line: i + 1, code: line.trim() });
      continue;
    }

    if (/^\s*if \(TRACE\.on\) \{\s*$/.test(line)) {
      const indent = line.match(/^\s*/)[0];
      let end = -1;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trimEnd() === indent + '}') { end = j; break; }
      }
      assert.notEqual(end, -1, `unclosed TRACE.on block at main.js:${i + 1}`);
      const body = lines.slice(i, end + 1).join('\n');
      if (/(?<![.\w])trace\(/.test(body)) probes.push({ line: i + 1, code: body });
      continue;
    }

    if (isCommentLine(line)) continue;
    if (openGuardAbove(i)) continue;

    if (/(?<![.\w])trace\(/.test(line)) looseTrace.push({ line: i + 1, code: line.trim() });
    else if (HELPER_CALL.test(line)) looseHelpers.push({ line: i + 1, code: line.trim() });
  }

  return { probes, looseTrace, looseHelpers };
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
  for (const probe of collect(mainSrc).probes) {
    const m = probe.code.match(/trace\('([^']+)'/);
    assert.ok(m, `main.js:${probe.line} guards something that is not a trace() call`);
    found.push(m[1]);
  }
  assert.deepEqual(found.sort(), EXPECTED_PROBES);
});

test('every trace() call in main.js is guarded, except the IPC forwarder', () => {
  const { looseTrace } = collect(mainSrc);
  for (const call of looseTrace) {
    assert.match(
      call.code, UNGUARDED_FORWARDER,
      `main.js:${call.line} calls trace() outside an if (TRACE.on) guard: ${call.code}`,
    );
  }
  assert.equal(looseTrace.length, 1, 'the renderer forwarder is the only unguarded call');
});

// One call predates the trace: the OSC 0 debug log renders a code point into a
// template literal on every title, whatever the trace is doing. It is a real
// cost on a hot path and it is not this feature's to remove — it came in with
// c07ab13 (2026-03) and is on main. Pinned by its exact text so that it stays
// the *only* exception: anything new fails the assertion below.
const KNOWN_UNGUARDED_HELPERS = [
  'log.debug(`[OSC 0] session=${currentId} cp=${codePoints(payload, 1)} rule=${via} busy=${isBusy} idle=${isIdle} wasBusy=${!!session._cliBusy}`);',
];

test('no trace payload helper is called outside a guard', () => {
  // This is the check the sandbox rig could not make: work done before the
  // guard, on its own line, is exactly how the off-path stops being free.
  const { looseHelpers } = collect(mainSrc);
  assert.deepEqual(
    looseHelpers.map(c => c.code), KNOWN_UNGUARDED_HELPERS,
    'codePoints / controlOffset / busyDecision / progressDecision must only run under if (TRACE.on)',
  );
});

test('the scan reads a CRLF checkout the same way as an LF one', () => {
  // core.autocrlf=true is set on the maintainer's machine and the repo carries
  // no .gitattributes, so a fresh clone gets CRLF while CI stays LF. A scan
  // that only understands one of them is green in CI and red on the desk.
  const lf = collect(mainSrc.replace(/\r\n/g, '\n'));
  const crlf = collect(mainSrc.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'));
  assert.deepEqual(
    crlf.probes.map(p => p.line), lf.probes.map(p => p.line),
    'the probe sites must be found identically under CRLF',
  );
  assert.equal(crlf.probes.length, EXPECTED_PROBES.length);
  assert.deepEqual(crlf.looseTrace.map(c => c.line), lf.looseTrace.map(c => c.line));
  assert.deepEqual(crlf.looseHelpers, lf.looseHelpers);
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
