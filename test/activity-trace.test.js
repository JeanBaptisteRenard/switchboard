// Tests for activity-trace.js — the opt-in diagnostic trace.
//
// Two things matter and are covered here: the line format (a trace nobody can
// parse is worthless) and the off-path (a diagnostic that costs anything when
// disabled would not survive review — see docs/decisions/0002).

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  createActivityTrace, formatEntry, codePoints, controlOffset, busyDecision, progressDecision,
  envEnabled, envState, initialEnabled, resolveTraceFilePath, readTraceTail,
} = require('../activity-trace');

function capture(options = {}) {
  const lines = [];
  const t = createActivityTrace({
    enabled: true,
    write: (line) => lines.push(line),
    nowMs: () => Date.parse('2026-08-22T09:15:00.000Z'),
    ...options,
  });
  return { trace: t, lines, parsed: () => lines.map(l => JSON.parse(l)) };
}

// --- codePoints: the whole reason the trace exists -------------------------

test('codePoints renders the leading code points as padded hex', () => {
  assert.equal(codePoints('◐ claude', 1), 'U+25D0');
  assert.equal(codePoints('◐ c', 3), 'U+25D0 U+0020 U+0063');
  assert.equal(codePoints('✳ idle', 1), 'U+2733');
  assert.equal(codePoints('⠋', 1), 'U+280B');
});

test('codePoints iterates by code point, not UTF-16 unit', () => {
  assert.equal(codePoints('\u{1F600}x', 2), 'U+1F600 U+0078');
});

test('codePoints tolerates empty and non-string payloads', () => {
  assert.equal(codePoints(''), '');
  assert.equal(codePoints(undefined), '');
  assert.equal(codePoints(null), '');
});

// --- controlOffset: what keeps pty.input from transcribing keystrokes ------

test('controlOffset returns -1 when the chunk is printable text', () => {
  assert.equal(controlOffset('hello'), -1);
  assert.equal(controlOffset('◐ claude'), -1);
  assert.equal(controlOffset(''), -1);
  assert.equal(controlOffset(undefined), -1);
});

test('controlOffset finds the first C0 control or DEL', () => {
  assert.equal(controlOffset('\x1b[24;80R'), 0);
  assert.equal(controlOffset('abc\r'), 3);
  assert.equal(controlOffset('abc\x7f'), 3);
  assert.equal(controlOffset('ab\x1bc\r'), 2);
});

test('controlOffset slices a typed chunk down to nothing renderable', () => {
  const typed = 'the password is hunter2';
  assert.equal(controlOffset(typed), -1);
  // -1 is the signal to record no `cp` at all; the length still gets through.
  const submitted = typed + '\r';
  assert.equal(codePoints(submitted.slice(controlOffset(submitted)), 10), 'U+000D');
});

// --- decision helpers mirror the main.js branches --------------------------

test('busyDecision distinguishes emission from suppression', () => {
  assert.equal(busyDecision(true, false, false), 'emit:busy');
  assert.equal(busyDecision(true, false, true), 'suppressed:already-busy');
  assert.equal(busyDecision(false, true, true), 'emit:idle');
  assert.equal(busyDecision(false, true, false), 'suppressed:already-idle');
  assert.equal(busyDecision(false, false, false), 'ignored:no-match');
  assert.equal(busyDecision(false, false, true), 'ignored:no-match');
});

test('progressDecision covers the OSC 9;4 levels', () => {
  assert.equal(progressDecision('1', false), 'emit:busy');
  assert.equal(progressDecision('3', false), 'emit:busy');
  assert.equal(progressDecision('2', true), 'suppressed:already-busy');
  assert.equal(progressDecision('0', false), 'ignored:clear');
  assert.equal(progressDecision(undefined, false), 'ignored:no-match');
});

// --- line format -----------------------------------------------------------

test('formatEntry emits one JSON object per line with the envelope first', () => {
  const line = formatEntry(
    { seq: 7, t: 1234.5, wall: '2026-08-22T09:15:00.000Z', src: 'main', cat: 'osc.title', sid: 's-1' },
    { cp: 'U+25D0', busy: false }
  );
  assert.ok(line.endsWith('\n'));
  assert.equal(line.indexOf('\n'), line.length - 1, 'exactly one newline, at the end');
  assert.deepEqual(Object.keys(JSON.parse(line)), ['seq', 't', 'wall', 'src', 'cat', 'sid', 'cp', 'busy']);
});

test('formatEntry never lets a payload field shadow an envelope key', () => {
  const entry = JSON.parse(formatEntry(
    { seq: 1, t: 0, wall: 'w', src: 'renderer', cat: 'c', sid: null },
    { seq: 999, cat: 'nope', ok: true }
  ));
  assert.equal(entry.seq, 1);
  assert.equal(entry.cat, 'c');
  assert.equal(entry._seq, 999);
  assert.equal(entry._cat, 'nope');
  assert.equal(entry.ok, true);
});

test('formatEntry drops undefined and function fields, keeps null and false', () => {
  const entry = JSON.parse(formatEntry(
    { seq: 1, t: 0, wall: 'w', src: 'main', cat: 'c', sid: undefined },
    { gone: undefined, fn: () => {}, kept: null, flag: false }
  ));
  assert.equal('gone' in entry, false);
  assert.equal('fn' in entry, false);
  assert.equal(entry.kept, null);
  assert.equal(entry.flag, false);
  assert.equal(entry.sid, null, 'a missing sessionId is explicit null, not absent');
});

test('formatEntry survives an unserialisable payload instead of throwing', () => {
  const circular = {};
  circular.self = circular;
  const entry = JSON.parse(formatEntry(
    { seq: 3, t: 0, wall: 'w', src: 'main', cat: 'c', sid: 's' }, circular
  ));
  assert.equal(entry.seq, 3);
  assert.ok(entry._traceError);
});

test('escaped control characters keep the file one-object-per-line', () => {
  const line = formatEntry(
    { seq: 1, t: 0, wall: 'w', src: 'main', cat: 'osc.title', sid: 's' },
    { title: '\x1b]0;x\x07\nsecond' }
  );
  assert.equal(line.indexOf('\n'), line.length - 1);
  assert.equal(JSON.parse(line).title, '\x1b]0;x\x07\nsecond');
});

// --- sequencing / ordering -------------------------------------------------

test('the sequence is monotonic across both origins — main is the only writer', () => {
  const { trace, parsed } = capture();
  trace.trace('osc.title', 's1', { busy: true });
  trace.trace('recv.cli-busy-state', 's1', { busy: true }, 'renderer');
  trace.trace('busy.emit', 's1', { busy: true });
  const rows = parsed();
  assert.deepEqual(rows.map(r => r.seq), [1, 2, 3]);
  assert.deepEqual(rows.map(r => r.src), ['main', 'renderer', 'main']);
});

test('every entry carries a monotonic and a wall-clock timestamp', () => {
  const { trace, parsed } = capture();
  trace.trace('a', 's1', {});
  trace.trace('b', 's1', {});
  const [first, second] = parsed();
  assert.ok(typeof first.t === 'number' && first.t >= 0);
  assert.ok(second.t >= first.t, 'monotonic clock never goes backwards');
  assert.equal(first.wall, '2026-08-22T09:15:00.000Z');
});

// --- the off-path: no work, no allocation, no write ------------------------

test('a disabled trace writes nothing and never touches the payload', () => {
  const lines = [];
  const t = createActivityTrace({ enabled: false, write: (l) => lines.push(l) });
  let touched = false;
  const payload = { get busy() { touched = true; return true; } };

  t.trace('osc.title', 's1', payload);
  t.trace('busy.emit', 's1', payload, 'renderer');

  assert.equal(lines.length, 0, 'no line written');
  assert.equal(touched, false, 'the payload was never serialised');
  assert.equal(t.sequence, 0, 'the sequence counter never advanced');
});

test('a disabled trace opens no file even when asked to init', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-trace-off-'));
  const t = createActivityTrace({ enabled: false });
  assert.equal(t.init(dir), null);
  assert.deepEqual(fs.readdirSync(dir), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('envEnabled defaults to off and only accepts explicit opt-in values', () => {
  assert.equal(envEnabled({}), false);
  assert.equal(envEnabled({ SWITCHBOARD_ACTIVITY_TRACE: '' }), false);
  assert.equal(envEnabled({ SWITCHBOARD_ACTIVITY_TRACE: '0' }), false);
  assert.equal(envEnabled({ SWITCHBOARD_ACTIVITY_TRACE: 'no' }), false);
  assert.equal(envEnabled({ SWITCHBOARD_ACTIVITY_TRACE: '1' }), true);
  assert.equal(envEnabled({ SWITCHBOARD_ACTIVITY_TRACE: ' TRUE ' }), true);
  assert.equal(envEnabled({ SWITCHBOARD_ACTIVITY_TRACE: 'on' }), true);
  // Absent and blank must reach the same verdict: the child-process test below
  // removes the variable rather than emptying it, and the two must agree.
  assert.equal(envEnabled({}), envEnabled({ SWITCHBOARD_ACTIVITY_TRACE: '' }));
});

// The singleton reads the ambient environment at require() time, so asserting
// on it from inside this process would only describe the shell that launched
// the suite — and would turn red exactly when someone enables the trace to
// investigate something. Both directions are checked in a child process whose
// environment is built explicitly.
function enabledInChildEnv(overrides) {
  const env = { ...process.env };
  // Case-insensitively: Windows reports env keys with whatever case they were
  // set in, and a spread copy deletes case-sensitively.
  for (const k of Object.keys(env)) {
    if (k.toUpperCase() === 'SWITCHBOARD_ACTIVITY_TRACE') delete env[k];
  }
  Object.assign(env, overrides);
  const modulePath = path.join(__dirname, '..', 'activity-trace.js');
  const r = spawnSync(
    process.execPath,
    ['-e', `process.stdout.write(String(require(${JSON.stringify(modulePath)}).enabled))`],
    { env, encoding: 'utf8' }
  );
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

test('the module singleton is off in a process whose environment does not opt in', () => {
  // The variable is removed from the child env, not blanked — the shipped
  // default must hold whatever the parent shell carries.
  assert.equal(enabledInChildEnv({}), 'false');
  assert.equal(enabledInChildEnv({ SWITCHBOARD_ACTIVITY_TRACE: '' }), 'false');
  assert.equal(enabledInChildEnv({ SWITCHBOARD_ACTIVITY_TRACE: '0' }), 'false');
});

test('the module singleton arms itself when the environment opts in', () => {
  // Control for the test above: proves the rig can see the difference at all.
  assert.equal(enabledInChildEnv({ SWITCHBOARD_ACTIVITY_TRACE: '1' }), 'true');
});

test('an enabled trace that was never init()ed still writes nothing', () => {
  const t = createActivityTrace({ enabled: true });
  t.trace('osc.title', 's1', { busy: true });
  assert.equal(t.sequence, 0);
  assert.equal(t.currentFile, null);
});

// Pruning runs on the retired stream's close callback — see docs/activity-trace.md
// "Testing the async prune path" for why these wait on the condition, not the clock.
async function waitUntil(check, { tries = 500, intervalMs = 20 } = {}) {
  for (let i = 0; i < tries; i++) {
    if (check()) return true;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return check();
}

function readEntries(files) {
  const out = [];
  for (const f of files) {
    let content;
    try { content = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of content.split('\n')) {
      if (!line) continue;
      try { out.push(JSON.parse(line)); } catch { /* mid-flush line, next poll picks it up */ }
    }
  }
  return out;
}

// --- bounding: rotation with a fixed number of retained segments -----------

test('the trace rotates segments and retains a bounded number of them', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-trace-rot-'));
  const t = createActivityTrace({ enabled: true, maxSegmentBytes: 200, maxSegments: 2 });
  t.init(dir);
  for (let i = 0; i < 60; i++) t.trace('fill', 's1', { i, pad: 'xxxxxxxxxxxxxxxxxxxx' });
  assert.ok(t.files.length > 2, 'the run produced more segments than it retains');
  t.close();

  let files = [];
  await waitUntil(() => {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
    return files.length <= 2;
  });
  assert.equal(files.length, 2, 'older segments are unlinked, disk use stays bounded');
  assert.ok(files.every(f => f.startsWith('activity-trace-')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a segment that cannot be unlinked stays queued and is retried, not forgotten', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-trace-lock-'));
  let locked = true;
  const attempts = [];
  const t = createActivityTrace({
    enabled: true, maxSegmentBytes: 200, maxSegments: 2,
    // Stands in for a tail or an editor holding the file open mid-investigation.
    unlink: (f) => {
      attempts.push(f);
      if (locked) { const e = new Error('busy'); e.code = 'EBUSY'; throw e; }
      fs.unlinkSync(f);
    },
  });
  t.init(dir);
  for (let i = 0; i < 60; i++) t.trace('fill', 's1', { i, pad: 'xxxxxxxxxxxxxxxxxxxx' });
  await waitUntil(() => attempts.length > 1);

  const stale = t.files[0];
  assert.ok(attempts.length > 1, 'the locked segment is retried at each rotation');
  assert.ok(t.files.length > 2, 'it stays queued instead of dropping off the ceiling');
  assert.ok(attempts.every(f => f === stale), 'every retry targets the same oldest segment');

  locked = false;
  for (let i = 0; i < 40; i++) t.trace('fill', 's1', { i, pad: 'xxxxxxxxxxxxxxxxxxxx' });
  await waitUntil(() => t.files.length === 2);
  assert.equal(t.files.length, 2, 'the backlog drains back to the ceiling once the lock clears');
  assert.equal(t.files.includes(stale), false);
  t.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a failed prune is reported in the trace itself, once per file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-trace-warn-'));
  const t = createActivityTrace({
    enabled: true, maxSegmentBytes: 200, maxSegments: 2,
    unlink: () => { const e = new Error('busy'); e.code = 'EBUSY'; throw e; },
  });
  t.init(dir);
  for (let i = 0; i < 60; i++) t.trace('fill', 's1', { i, pad: 'xxxxxxxxxxxxxxxxxxxx' });
  const files = t.files.slice();

  // Order matters here — see docs/activity-trace.md "Testing the async prune path".
  let warnings = [];
  await waitUntil(() => {
    warnings = readEntries(files).filter(e => e.cat === 'trace.prune-failed');
    return warnings.length >= 1;
  });
  t.close();

  assert.ok(warnings.length >= 1, 'exceeding the announced ceiling is not silent');
  assert.equal(warnings[0].error, 'EBUSY');
  assert.equal(new Set(warnings.map(w => w.file)).size, warnings.length,
    'one warning per stale file, not one per rotation');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the trace file is timestamped so a new run never overwrites the last', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-trace-name-'));
  const t = createActivityTrace({ enabled: true, nowMs: () => Date.parse('2026-08-22T09:15:00') });
  const file = t.init(dir);
  t.trace('osc.title', 's1', { cp: codePoints('◐', 1) });
  t.close();

  assert.match(path.basename(file), /^activity-trace-\d{8}-\d{6}\.jsonl$/);
  await new Promise(r => setTimeout(r, 30));
  const written = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(written.length, 1);
  assert.equal(JSON.parse(written[0]).cp, 'U+25D0');
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- runtime toggling: arming the trace without losing the state under study --

function tmpTraceDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sb-trace-' + tag + '-'));
}

function jsonlIn(dir) {
  return fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort();
}

test('envState separates an unset variable from an explicit off', () => {
  assert.equal(envState({}), null);
  assert.equal(envState({ SWITCHBOARD_ACTIVITY_TRACE: '' }), null);
  assert.equal(envState({ SWITCHBOARD_ACTIVITY_TRACE: '   ' }), null);
  assert.equal(envState({ SWITCHBOARD_ACTIVITY_TRACE: '0' }), false);
  assert.equal(envState({ SWITCHBOARD_ACTIVITY_TRACE: 'no' }), false);
  assert.equal(envState({ SWITCHBOARD_ACTIVITY_TRACE: '1' }), true);
  assert.equal(envState({ SWITCHBOARD_ACTIVITY_TRACE: ' ON ' }), true);
});

test('the environment decides the startup state, the preference decides when it is unset', () => {
  // Unset: the stored preference is the whole answer.
  assert.equal(initialEnabled({}, true), true);
  assert.equal(initialEnabled({}, false), false);
  assert.equal(initialEnabled({}, undefined), false);
  // Set: it wins over the preference, in both directions.
  assert.equal(initialEnabled({ SWITCHBOARD_ACTIVITY_TRACE: '1' }, false), true);
  assert.equal(initialEnabled({ SWITCHBOARD_ACTIVITY_TRACE: '0' }, true), false);
});

test('a trace armed at runtime starts writing where it wrote nothing before', async () => {
  const dir = tmpTraceDir('arm');
  const t = createActivityTrace({ enabled: false });

  assert.equal(t.init(dir), null, 'init on a disabled trace opens no file');
  t.trace('osc.title', 's1', { busy: true });
  assert.equal(t.sequence, 0, 'nothing was written while off');
  assert.deepEqual(jsonlIn(dir), [], 'no segment on disk while off');

  const file = t.setEnabled(true);
  assert.ok(file, 'enabling opened a segment');
  t.trace('osc.title', 's1', { busy: true });
  assert.equal(t.sequence, 1);

  await new Promise(r => t.close(r));
  assert.deepEqual(readEntries([file]).map(e => e.cat), ['osc.title']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('disabling flushes what was already written and then stops writing', async () => {
  const dir = tmpTraceDir('flush');
  const t = createActivityTrace({ enabled: true });
  const file = t.init(dir);

  // Well past the stream's 16 KB high-water mark, so a plain `stream = null`
  // without an end() would strand the tail in the buffer.
  for (let i = 0; i < 4000; i++) t.trace('fill', 's1', { i, pad: 'yyyyyyyyyyyyyyyyyyyyyyyyyyyyyy' });
  const written = t.sequence;
  assert.equal(written, 4000);

  await new Promise(r => t.setEnabled(false, r));
  assert.equal(readEntries([file]).length, written, 'every line written before the toggle reached disk');

  t.trace('osc.title', 's1', { busy: true });
  assert.equal(t.sequence, written, 'the sequence did not advance after disabling');
  assert.equal(readEntries([file]).length, written, 'nothing was appended after disabling');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('disabling never touches the payload of a later probe', () => {
  const lines = [];
  const t = createActivityTrace({ enabled: true, write: (l) => lines.push(l) });
  t.setEnabled(false);
  let touched = false;
  t.trace('osc.title', 's1', { get busy() { touched = true; return true; } });
  assert.equal(touched, false);
  assert.equal(lines.length, 0);
});

test('re-enabling opens a fresh segment instead of appending to the closed one', async () => {
  const dir = tmpTraceDir('resume');
  let now = Date.parse('2026-08-22T09:15:00.000Z');
  const t = createActivityTrace({ enabled: true, nowMs: () => now });

  const first = t.init(dir);
  t.trace('first.window', null, {});
  await new Promise(r => t.setEnabled(false, r));

  now += 65_000;
  const second = t.setEnabled(true);
  assert.notEqual(second, first, 'the second window has its own timestamped file');
  t.trace('second.window', null, {});
  await new Promise(r => t.setEnabled(false, r));

  assert.deepEqual(readEntries([first]).map(e => e.cat), ['first.window']);
  assert.deepEqual(readEntries([second]).map(e => e.cat), ['second.window']);
  // The sequence is process-wide: it is what orders the two halves of a session.
  assert.deepEqual(readEntries([first, second]).map(e => e.seq), [1, 2]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rotation still bounds the disk when the trace was armed at runtime', async () => {
  const dir = tmpTraceDir('armrot');
  const t = createActivityTrace({ enabled: false, maxSegmentBytes: 200, maxSegments: 2 });
  t.init(dir);
  t.setEnabled(true);

  for (let i = 0; i < 60; i++) t.trace('fill', 's1', { i, pad: 'xxxxxxxxxxxxxxxxxxxx' });
  assert.ok(t.files.length > 2, 'the run produced more segments than it retains');
  await new Promise(r => t.close(r));

  let files = [];
  await waitUntil(() => { files = jsonlIn(dir); return files.length <= 2; });
  assert.equal(files.length, 2, 'older segments are unlinked, disk use stays bounded');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the segment ceiling holds across repeated toggles, not just within one window', async () => {
  const dir = tmpTraceDir('toggle-cap');
  let now = Date.parse('2026-08-22T09:15:00.000Z');
  const t = createActivityTrace({ enabled: false, maxSegments: 2, nowMs: () => now });
  t.init(dir);

  for (let i = 0; i < 4; i++) {
    now += 60_000;
    t.setEnabled(true);
    t.trace('window', null, { i });
    await new Promise(r => t.setEnabled(false, r));
  }

  let files = [];
  await waitUntil(() => { files = jsonlIn(dir); return files.length <= 2; });
  assert.equal(files.length, 2, 'four observation windows still leave only the retained segments');
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- the queue and the live segment ----------------------------------------
//
// segments[] and pruneSegments() were written for a startSegment() called once
// per process. Toggling calls it repeatedly, and the panel's Delete button
// removes files behind their back; these pin both.

test('two activations inside the same second never queue the same file twice', async () => {
  const dir = tmpTraceDir('same-second');
  const now = Date.parse('2026-09-03T09:15:00.000Z');
  const t = createActivityTrace({ enabled: true, maxSegments: 4, nowMs: () => now });
  t.init(dir);

  for (let i = 0; i < 5; i++) {
    await new Promise(r => t.setEnabled(false, r));
    t.setEnabled(true);
  }

  assert.equal(t.files.length, new Set(t.files).size, 'no path is queued twice');
  assert.equal(jsonlIn(dir).length, 1, 'one second, one file');
  await new Promise(r => t.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('pruning never unlinks the segment the trace is writing to', async () => {
  const dir = tmpTraceDir('live-segment');
  const now = Date.parse('2026-09-03T09:15:00.000Z');
  // A ceiling of one is the sharpest version: every prune has the live file
  // within reach of the queue head.
  const t = createActivityTrace({ enabled: true, maxSegments: 1, nowMs: () => now });
  t.init(dir);
  t.trace('first', null, {});

  for (let i = 0; i < 5; i++) {
    await new Promise(r => t.setEnabled(false, r));
    t.setEnabled(true);
  }

  const live = t.currentFile;
  assert.ok(live, 'the trace still has a segment');
  assert.equal(fs.existsSync(live), true, 'the live segment was not deleted under it');

  t.trace('after.cycles', null, {});
  await new Promise(r => t.setEnabled(false, r));
  const cats = readEntries([live]).map(e => e.cat);
  assert.deepEqual(cats, ['first', 'after.cycles'], 'both lines survived the cycling');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a segment already gone drains the queue instead of jamming it', async () => {
  // A file the panel's Delete button removed is not a retryable failure: the
  // queue head can never succeed, so retrying it forever voids the ceiling.
  const dir = tmpTraceDir('enoent');
  const attempts = [];
  const t = createActivityTrace({
    enabled: true, maxSegmentBytes: 300, maxSegments: 2,
    unlink: (file) => {
      attempts.push(path.basename(file));
      const err = new Error('no such file or directory');
      err.code = 'ENOENT';
      throw err;
    },
  });
  t.init(dir);

  for (let i = 0; i < 40; i++) t.trace('fill', 's1', { pad: 'x'.repeat(250) });
  await new Promise(r => t.close(r));
  await waitUntil(() => t.files.length <= 2);

  assert.ok(t.files.length <= 2, `the queue drained past the missing files, holding ${t.files.length}`);
  assert.ok(attempts.length >= 3, 'the retired segments were actually attempted');
  assert.equal(new Set(attempts).size, attempts.length, 'no missing file was attempted twice');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('currentFile follows the stream, not the queue', async () => {
  const dir = tmpTraceDir('current');
  const t = createActivityTrace({ enabled: true });
  const file = t.init(dir);
  assert.equal(t.currentFile, file);

  await new Promise(r => t.setEnabled(false, r));
  assert.equal(t.currentFile, null, 'nothing is being written once the trace is off');
  assert.ok(t.files.includes(file), 'the file is still tracked for the ceiling');

  t.setEnabled(true);
  assert.equal(t.currentFile, t.files[t.files.length - 1]);
  await new Promise(r => t.close(r));
  assert.equal(t.currentFile, null, 'close() clears it too');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('setEnabled calls back on every path, including the no-ops', { timeout: 10000 }, async () => {
  // main.js awaits this callback before answering the IPC; a path that never
  // calls it leaves the settings toggle disabled for the rest of the session.
  const dir = tmpTraceDir('callback');
  const t = createActivityTrace({ enabled: false });
  t.init(dir);
  const seen = [];

  await new Promise(r => t.setEnabled(true, () => { seen.push('enable'); r(); }));
  await new Promise(r => t.setEnabled(true, () => { seen.push('enable-noop'); r(); }));
  await new Promise(r => t.setEnabled(false, () => { seen.push('disable'); r(); }));
  await new Promise(r => t.setEnabled(false, () => { seen.push('disable-noop'); r(); }));
  await new Promise(r => t.close(() => { seen.push('close-noop'); r(); }));

  assert.deepEqual(seen, ['enable', 'enable-noop', 'disable', 'disable-noop', 'close-noop']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an enable whose open failed is retried instead of latching on', () => {
  const base = tmpTraceDir('failed-open');
  const blocked = path.join(base, 'not-a-directory');
  fs.writeFileSync(blocked, 'x');

  const t = createActivityTrace({ enabled: false });
  t.init(blocked);
  assert.equal(t.setEnabled(true), null, 'the open could not succeed');
  assert.equal(t.enabled, true);
  assert.equal(t.currentFile, null, 'the state says on but nothing is open');

  fs.rmSync(blocked);
  fs.mkdirSync(blocked);
  const file = t.setEnabled(true);
  assert.ok(file, 'a second enable retried rather than short-circuiting as a no-op');
  t.trace('recovered', null, {});
  assert.equal(t.sequence, 1);
  t.close();
  fs.rmSync(base, { recursive: true, force: true });
});

test('an error on a rotated-out stream does not kill the live one', async () => {
  const dir = tmpTraceDir('stale-error');
  const realCreate = fs.createWriteStream;
  const made = [];
  fs.createWriteStream = (...args) => { const s = realCreate.apply(fs, args); made.push(s); return s; };
  try {
    const t = createActivityTrace({ enabled: true, maxSegmentBytes: 300, maxSegments: 4 });
    t.init(dir);
    t.trace('fill', 's1', { pad: 'x'.repeat(400) }); // forces a rotation
    await waitUntil(() => made.length >= 2);
    const live = t.currentFile;

    made[0].emit('error', new Error('late error on the retired stream'));

    assert.equal(t.currentFile, live, 'the live segment is untouched');
    t.trace('after.stale.error', null, {});
    await new Promise(r => t.close(r));
    const cats = readEntries([live]).map(e => e.cat);
    assert.ok(cats.includes('after.stale.error'), 'the trace kept writing after the stale error');
  } finally {
    fs.createWriteStream = realCreate;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- the panel's file handlers ---------------------------------------------

test('resolveTraceFilePath accepts only trace segments in the trace directory', () => {
  const dir = path.join(os.tmpdir(), 'sb-trace-allow');
  const ok = path.join(dir, 'activity-trace-20260903-101500.jsonl');
  const okRotated = path.join(dir, 'activity-trace-20260903-101500.002.jsonl');

  assert.equal(resolveTraceFilePath(dir, ok), path.resolve(ok));
  assert.equal(resolveTraceFilePath(dir, okRotated), path.resolve(okRotated));

  // Wrong directory, including a sibling whose name merely starts the same.
  assert.equal(resolveTraceFilePath(dir, path.join(dir, 'sub', 'activity-trace-20260903-101500.jsonl')), null);
  assert.equal(resolveTraceFilePath(dir, path.join(dir + '-evil', 'activity-trace-20260903-101500.jsonl')), null);
  // Traversal that lands back outside.
  assert.equal(resolveTraceFilePath(dir, path.join(dir, '..', 'activity-trace-20260903-101500.jsonl')), null);
  // Right directory, wrong name.
  assert.equal(resolveTraceFilePath(dir, path.join(dir, 'switchboard.db')), null);
  assert.equal(resolveTraceFilePath(dir, path.join(dir, 'activity-trace-nope.jsonl')), null);
  // Nothing usable at all: these must answer null, not throw, or the IPC
  // handler rejects instead of returning { ok: false } and the button dies.
  for (const bad of [undefined, null, 0, {}, [], '', Buffer.from('x')]) {
    assert.equal(resolveTraceFilePath(dir, bad), null, `rejected ${String(bad)}`);
  }
  assert.equal(resolveTraceFilePath(undefined, ok), null);
});

test('readTraceTail returns a whole small file and a line-aligned tail of a big one', () => {
  const dir = tmpTraceDir('tail');
  const file = path.join(dir, 'activity-trace-20260903-101500.jsonl');
  const lines = [];
  for (let i = 0; i < 400; i++) lines.push(JSON.stringify({ seq: i, pad: 'a'.repeat(100) }));
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const size = fs.statSync(file).size;

  const whole = readTraceTail(file, size + 10);
  assert.equal(whole.truncated, false);
  assert.equal(whole.content.split('\n').filter(Boolean).length, 400);

  const tail = readTraceTail(file, 2000);
  assert.equal(tail.truncated, true);
  assert.equal(tail.size, size);
  assert.ok(tail.shown <= 2000);
  // Every line must still parse: a raw byte cut would leave a broken first one.
  for (const line of tail.content.split('\n').filter(Boolean)) JSON.parse(line);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readTraceTail never pads with NULs when the file shrinks under it', () => {
  // A rotation, or a delete-and-recreate, between the stat and the read. The
  // buffer is cap-sized; returning all of it would hand the viewer megabytes
  // of NUL and call it trace content.
  const dir = tmpTraceDir('shrink');
  const file = path.join(dir, 'activity-trace-20260903-101500.jsonl');
  const line = JSON.stringify({ seq: 1, pad: 'a'.repeat(200) }) + '\n';
  fs.writeFileSync(file, line.repeat(3000));
  const cap = 4096;

  const realStat = fs.statSync;
  let result;
  try {
    fs.statSync = (p, ...rest) => {
      const stat = realStat.call(fs, p, ...rest);
      if (p === file) fs.truncateSync(file, 512);
      return stat;
    };
    result = readTraceTail(file, cap);
  } finally {
    fs.statSync = realStat;
  }

  assert.equal(result.content.indexOf('\u0000'), -1, 'not one NUL reached the caller');
  assert.ok(result.shown <= 512, `shown must report what was read, got ${result.shown}`);
  assert.ok(result.content.length <= 512);
  fs.rmSync(dir, { recursive: true, force: true });
});
