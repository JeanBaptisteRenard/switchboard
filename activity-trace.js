'use strict';

// Opt-in activity trace. The environment variable sets the state at startup;
// it can be toggled at runtime afterwards.
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

// true / false / null, where null means the variable was not set.
function envState(env) {
  const raw = env && env[ENV_VAR];
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  return envEnabled(env);
}

// see docs/activity-trace.md "Turning it on"
function initialEnabled(env, stored) {
  const fromEnv = envState(env);
  return fromEnv === null ? stored === true : fromEnv;
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

// Index of the first C0 control or DEL, or -1 when the string is all printable.
// See docs/activity-trace.md — `pty.input` traces from here, never from 0.
function controlOffset(str) {
  if (typeof str !== 'string') return -1;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return i;
  }
  return -1;
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

const TRACE_FILE_RE = /^activity-trace-\d{8}-\d{6}(\.\d{3})?\.jsonl$/;

// An allowlist of exactly one directory and one name shape — see
// .ai/contexts/ipc-bridge.md "Activity trace".
function resolveTraceFilePath(dir, filePath) {
  if (typeof dir !== 'string' || typeof filePath !== 'string' || filePath === '') return null;
  let resolved;
  try { resolved = path.resolve(filePath); } catch { return null; }
  if (path.dirname(resolved) !== path.resolve(dir)) return null;
  if (!TRACE_FILE_RE.test(path.basename(resolved))) return null;
  return resolved;
}

// The last `cap` bytes, cut at the next line break so the result is still
// one-JSON-object-per-line. A segment is 16 MB by default.
function readTraceTail(filePath, cap) {
  const size = fs.statSync(filePath).size;
  if (size <= cap) {
    return { content: fs.readFileSync(filePath, 'utf8'), size, truncated: false, shown: size };
  }
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(cap);
    // The file can shrink between the stat and the read (a rotation, a delete
    // and recreate): honour what was actually read, never the buffer length.
    const bytesRead = fs.readSync(fd, buf, 0, cap, size - cap);
    if (bytesRead <= 0) return { content: '', size, truncated: true, shown: 0 };
    const text = buf.toString('utf8', 0, bytesRead);
    const firstBreak = text.indexOf('\n');
    return {
      content: firstBreak === -1 ? text : text.slice(firstBreak + 1),
      size, truncated: true, shown: bytesRead,
    };
  } finally {
    fs.closeSync(fd);
  }
}

function timestampSlug(date) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return date.getFullYear() + p(date.getMonth() + 1) + p(date.getDate())
    + '-' + p(date.getHours()) + p(date.getMinutes()) + p(date.getSeconds());
}

function createActivityTrace(options = {}) {
  const state = { on: !!options.enabled };
  const maxSegmentBytes = options.maxSegmentBytes || envMaxBytes(process.env);
  const maxSegments = options.maxSegments || DEFAULT_SEGMENTS;
  const nowMs = options.nowMs || (() => Date.now());
  const write = typeof options.write === 'function' ? options.write : null;
  const unlink = options.unlink || fs.unlinkSync;

  const origin = process.hrtime.bigint();
  let seq = 0;
  let stream = null;
  // The file `stream` writes to, and null the moment there is no live stream.
  // Derived from the stream rather than from the queue — see
  // docs/activity-trace.md "Turning it off, and on again".
  let currentPath = null;
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

  // The queue holds paths, and a path can come back: two activations inside the
  // same second resolve to the same name. Re-queue rather than duplicate, or
  // the ceiling would count one file twice and prune it while it is still live.
  function trackSegment(file) {
    const at = segments.indexOf(file);
    if (at !== -1) segments.splice(at, 1);
    segments.push(file);
  }

  // A stale segment stays queued until it is actually gone: a locked file (a
  // tail or an editor open on it mid-investigation) is retried at the next
  // rotation rather than dropped off the ceiling and forgotten.
  function pruneSegments() {
    while (segments.length > maxSegments) {
      const stale = segments[0];
      // Redundant with trackSegment's de-duplication, kept as a backstop.
      if (stale === currentPath) return;
      try {
        unlink(stale);
      } catch (err) {
        // Already gone — the panel's Delete button, or a hand on the directory.
        // Retrying that forever would jam the queue and void the ceiling.
        if (err && err.code === 'ENOENT') {
          segments.shift();
          unlinkFailures.delete(stale);
          continue;
        }
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
    const opened = fs.createWriteStream(file, { flags: 'a' });
    opened.on('error', () => {
      if (stream === opened) { stream = null; currentPath = null; }
    });
    stream = opened;
    currentPath = file;
    let existing = 0;
    try { existing = fs.statSync(file).size; } catch {}
    bytes = existing;
    trackSegment(file);
  }

  function rotate() {
    if (warning) return; // the prune-failure line must not re-enter rotation
    const old = stream;
    stream = null;
    currentPath = null;
    segment += 1;
    try { openSegment(); } catch { stream = null; currentPath = null; }
    // Windows refuses to unlink a handle that is still open.
    if (old) old.end(pruneSegments); else pruneSegments();
  }

  // see docs/activity-trace.md "Turning it off, and on again"
  function startSegment() {
    baseName = 'activity-trace-' + timestampSlug(new Date(nowMs()));
    segment = 0;
    fs.mkdirSync(dir, { recursive: true });
    openSegment();
  }

  function init(dataDir) {
    if (write || !dataDir) return null;
    dir = dataDir;
    if (!state.on || stream) return null;
    try {
      startSegment();
    } catch {
      stream = null;
      currentPath = null;
    }
    return currentPath;
  }

  function setEnabled(value, done) {
    const next = !!value;
    // An enable whose open failed leaves state.on true with no stream; a plain
    // `next === state.on` no-op would then never retry it.
    const needsOpen = next && !write && !!dir && !stream;
    if (next === state.on && !needsOpen) {
      if (done) done();
      return currentPath;
    }
    if (next) {
      state.on = true;
      if (needsOpen) {
        try {
          startSegment();
          pruneSegments();
        } catch {
          stream = null;
          currentPath = null;
        }
      }
      if (done) done();
      return currentPath;
    }
    state.on = false;
    const old = stream;
    stream = null;
    currentPath = null;
    if (old) old.end(done);
    else if (done) done();
    return null;
  }

  function trace(cat, sid, fields, src) {
    if (!state.on) return;
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

  function close(done) {
    const old = stream;
    stream = null;
    currentPath = null;
    if (old) old.end(done);
    else if (done) done();
  }

  return {
    state,
    get enabled() { return state.on; },
    setEnabled,
    init,
    trace,
    close,
    get sequence() { return seq; },
    get files() { return segments.slice(); },
    get currentFile() { return currentPath; },
  };
}

const singleton = createActivityTrace({ enabled: envEnabled(process.env) });

module.exports = {
  state: singleton.state,
  get enabled() { return singleton.enabled; },
  setEnabled: singleton.setEnabled,
  init: singleton.init,
  trace: singleton.trace,
  close: singleton.close,
  currentFile: () => singleton.currentFile,
  files: () => singleton.files,
  createActivityTrace,
  formatEntry,
  codePoints,
  controlOffset,
  busyDecision,
  progressDecision,
  envEnabled,
  envState,
  initialEnabled,
  resolveTraceFilePath,
  readTraceTail,
  TRACE_FILE_RE,
};
