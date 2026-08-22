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

const {
  createActivityTrace, formatEntry, codePoints, busyDecision, progressDecision, envEnabled,
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
  // U+25D0 is the CLI 2.1.239 spinner frame; the busy test in main.js still
  // looks for braille (U+2800..U+28FF). The trace must make that visible.
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

// --- decision helpers mirror the main.js branches --------------------------

test('busyDecision distinguishes emission from suppression', () => {
  assert.equal(busyDecision(true, false, false), 'emit:busy');
  assert.equal(busyDecision(true, false, true), 'suppressed:already-busy');
  assert.equal(busyDecision(false, true, true), 'emit:idle');
  assert.equal(busyDecision(false, true, false), 'suppressed:already-idle');
  // A U+25D0 title matches neither test — the case the trace exists to expose.
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
});

test('the module singleton is off in a plain test process', () => {
  // Guards the shipped default: requiring the module must not arm anything.
  assert.equal(require('../activity-trace').enabled, false);
});

test('an enabled trace that was never init()ed still writes nothing', () => {
  const t = createActivityTrace({ enabled: true });
  t.trace('osc.title', 's1', { busy: true });
  assert.equal(t.sequence, 0);
  assert.equal(t.currentFile, null);
});

// --- bounding: rotation with a fixed number of retained segments -----------

test('the trace rotates segments and retains a bounded number of them', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-trace-rot-'));
  const t = createActivityTrace({ enabled: true, maxSegmentBytes: 200, maxSegments: 2 });
  t.init(dir);
  for (let i = 0; i < 60; i++) t.trace('fill', 's1', { i, pad: 'xxxxxxxxxxxxxxxxxxxx' });
  assert.ok(t.files.length > 2, 'the run produced more segments than it retains');
  t.close();

  // Pruning runs on the retired stream's close callback.
  let files = [];
  for (let i = 0; i < 100; i++) {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
    if (files.length <= 2) break;
    await new Promise(r => setTimeout(r, 10));
  }
  assert.equal(files.length, 2, 'older segments are unlinked, disk use stays bounded');
  assert.ok(files.every(f => f.startsWith('activity-trace-')));
  fs.rmSync(dir, { recursive: true, force: true });
});

// Pruning runs on the retired stream's close callback, so it always lags a
// synchronous burst of writes by at least a tick.
const settle = () => new Promise(r => setTimeout(r, 60));

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
  await settle();

  const stale = t.files[0];
  assert.ok(attempts.length > 1, 'the locked segment is retried at each rotation');
  assert.ok(t.files.length > 2, 'it stays queued instead of dropping off the ceiling');
  assert.ok(attempts.every(f => f === stale), 'every retry targets the same oldest segment');

  locked = false;
  for (let i = 0; i < 40; i++) t.trace('fill', 's1', { i, pad: 'xxxxxxxxxxxxxxxxxxxx' });
  await settle();
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
  await settle();
  const files = t.files.slice();
  t.close();
  await settle();

  const rows = files
    .flatMap(f => fs.readFileSync(f, 'utf8').split('\n'))
    .filter(Boolean).map(l => JSON.parse(l));
  const warnings = rows.filter(e => e.cat === 'trace.prune-failed');
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
