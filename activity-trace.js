'use strict';

// Opt-in activity trace, off unless SWITCHBOARD_ACTIVITY_TRACE is set.
// See docs/activity-trace.md and .ai/contexts/ipc-bridge.md "Activity trace".

const fs = require('fs');
const path = require('path');

const ENV_VAR = 'SWITCHBOARD_ACTIVITY_TRACE';
const MAX_MB_VAR = 'SWITCHBOARD_ACTIVITY_TRACE_MAX_MB';

const DEFAULT_MAX_MB = 64;
const DEFAULT_SEGMENTS = 4;

// Envelope keys; a payload field of the same name gets a `_` prefix instead.
const RESERVED = new Set(['seq', 't', 'wall', 'src', 'cat', 'sid']);

function envEnabled(env) {
  const raw = env && env[ENV_VAR];
  if (typeof raw !== 'string') return false;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function envMaxBytes(env) {
  const raw = env && env[MAX_MB_VAR];
  const mb = raw === undefined ? NaN : Number(raw);
  const effective = Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_MAX_MB;
  return Math.ceil((effective * 1024 * 1024) / DEFAULT_SEGMENTS);
}

// "◐ claude" → "U+25D0 U+0020 U+0063".
function codePoints(str, count = 3) {
  if (typeof str !== 'string' || str.length === 0) return '';
  const out = [];
  for (const ch of str) {
    out.push('U+' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0'));
    if (out.length >= count) break;
  }
  return out.join(' ');
}

// Mirrors the OSC 0 branch in main.js — see .ai/contexts/ipc-bridge.md.
function busyDecision(isBusy, isIdle, wasBusy) {
  if (isBusy && !wasBusy) return 'emit:busy';
  if (isIdle && wasBusy) return 'emit:idle';
  if (isBusy) return 'suppressed:already-busy';
  if (isIdle) return 'suppressed:already-idle';
  return 'ignored:no-match';
}

// Mirrors the OSC 9;4 branch in main.js.
function progressDecision(level, wasBusy) {
  if (level === '1' || level === '2' || level === '3') {
    return wasBusy ? 'suppressed:already-busy' : 'emit:busy';
  }
  if (level === '0') return 'ignored:clear';
  return 'ignored:no-match';
}

function formatEntry(envelope, fields) {
  const entry = {
    seq: envelope.seq,
    t: envelope.t,
    wall: envelope.wall,
    src: envelope.src,
    cat: envelope.cat,
    sid: envelope.sid === undefined ? null : envelope.sid,
  };
  if (fields && typeof fields === 'object') {
    for (const key of Object.keys(fields)) {
      const value = fields[key];
      if (value === undefined || typeof value === 'function') continue;
      entry[RESERVED.has(key) ? '_' + key : key] = value;
    }
  }
  try {
    return JSON.stringify(entry) + '\n';
  } catch (err) {
    return JSON.stringify({
      seq: entry.seq, t: entry.t, wall: entry.wall, src: entry.src, cat: entry.cat, sid: entry.sid,
      _traceError: String((err && err.message) || err),
    }) + '\n';
  }
}

function timestampSlug(date) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return date.getFullYear() + p(date.getMonth() + 1) + p(date.getDate())
    + '-' + p(date.getHours()) + p(date.getMinutes()) + p(date.getSeconds());
}

function createActivityTrace(options = {}) {
  const enabled = !!options.enabled;
  const maxSegmentBytes = options.maxSegmentBytes || envMaxBytes(process.env);
  const maxSegments = options.maxSegments || DEFAULT_SEGMENTS;
  const nowMs = options.nowMs || (() => Date.now());
  const write = typeof options.write === 'function' ? options.write : null;
  const unlink = options.unlink || fs.unlinkSync;

  const origin = process.hrtime.bigint();
  let seq = 0;
  let stream = null;
  let bytes = 0;
  let segment = 0;
  let dir = null;
  let baseName = null;
  let warning = false;
  const segments = [];
  const unlinkFailures = new Set();

  function segmentPath(index) {
    return path.join(dir, index === 0 ? baseName + '.jsonl' : baseName + '.' + String(index + 1).padStart(3, '0') + '.jsonl');
  }

  // A stale segment stays queued until it is actually gone: a locked file (a
  // tail or an editor open on it mid-investigation) is retried at the next
  // rotation rather than dropped off the ceiling and forgotten.
  function pruneSegments() {
    while (segments.length > maxSegments) {
      const stale = segments[0];
      try {
        unlink(stale);
      } catch (err) {
        if (!unlinkFailures.has(stale)) {
          unlinkFailures.add(stale);
          warning = true; // this write must not trigger a nested rotation
          try {
            trace('trace.prune-failed', null, {
              file: path.basename(stale),
              error: String((err && err.code) || (err && err.message) || err),
              retained: segments.length,
            });
          } finally { warning = false; }
        }
        return;
      }
      segments.shift();
      unlinkFailures.delete(stale);
    }
  }

  function openSegment() {
    const file = segmentPath(segment);
    // createWriteStream is lazy; pruning must not race a file that has no inode yet.
    fs.writeFileSync(file, '', { flag: 'a' });
    stream = fs.createWriteStream(file, { flags: 'a' });
    stream.on('error', () => { stream = null; });
    bytes = 0;
    segments.push(file);
  }

  function rotate() {
    if (warning) return; // the prune-failure line must not re-enter rotation
    const old = stream;
    stream = null;
    segment += 1;
    try { openSegment(); } catch { stream = null; }
    // Windows refuses to unlink a handle that is still open.
    if (old) old.end(pruneSegments); else pruneSegments();
  }

  function init(dataDir) {
    if (!enabled || write || stream || !dataDir) return null;
    dir = dataDir;
    baseName = 'activity-trace-' + timestampSlug(new Date(nowMs()));
    try {
      fs.mkdirSync(dir, { recursive: true });
      openSegment();
    } catch {
      stream = null;
    }
    return stream ? segments[segments.length - 1] : null;
  }

  function trace(cat, sid, fields, src) {
    if (!enabled) return;
    if (!stream && !write) return;
    seq += 1;
    const line = formatEntry({
      seq,
      t: Math.round(Number(process.hrtime.bigint() - origin) / 1e3) / 1e3,
      wall: new Date(nowMs()).toISOString(),
      src: src || 'main',
      cat,
      sid,
    }, fields);
    if (write) { write(line); return; }
    bytes += Buffer.byteLength(line);
    try { stream.write(line); } catch {}
    if (bytes >= maxSegmentBytes) rotate();
  }

  function close() {
    const old = stream;
    stream = null;
    if (old) old.end();
  }

  return {
    enabled,
    init,
    trace,
    close,
    get sequence() { return seq; },
    get files() { return segments.slice(); },
    get currentFile() { return segments.length ? segments[segments.length - 1] : null; },
  };
}

const singleton = createActivityTrace({ enabled: envEnabled(process.env) });

module.exports = {
  enabled: singleton.enabled,
  init: singleton.init,
  trace: singleton.trace,
  close: singleton.close,
  currentFile: () => singleton.currentFile,
  createActivityTrace,
  formatEntry,
  codePoints,
  busyDecision,
  progressDecision,
  envEnabled,
};
