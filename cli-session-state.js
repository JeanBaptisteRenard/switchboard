// see .ai/contexts/cli-session-state.md
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_DIR = path.join(os.homedir(), '.claude', 'sessions');
const STATE_FILE_RE = /^\d+\.json$/;
const KNOWN_STATUSES = new Set(['busy', 'idle', 'waiting', 'shell']);
const RESCAN_STATUS = 'idle';
const FLUSH_MS = 150;
const MIN_RESCAN_INTERVAL_MS = 1000;
const MAX_SEEDED_FILES = 200;

let dir = DEFAULT_DIR;
let activeSessions = null;
let onIdle = null;
let log = null;
let isProcessAlive = defaultIsProcessAlive;

let watcher = null;
let flushTimer = null;
const pending = new Set();
const known = new Map();
const lastRescanAt = new Map();

function defaultIsProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function init(ctx) {
  dir = ctx.dir || DEFAULT_DIR;
  activeSessions = ctx.activeSessions;
  onIdle = ctx.onIdle;
  log = ctx.log || { info() {}, debug() {}, warn() {}, error() {} };
  isProcessAlive = ctx.isProcessAlive || defaultIsProcessAlive;
  stop();
}

function parseState(text) {
  let raw;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!raw || typeof raw !== 'object') return null;
  if (!Number.isInteger(raw.pid) || raw.pid <= 0) return null;
  if (typeof raw.sessionId !== 'string' || !raw.sessionId) return null;
  if (typeof raw.status !== 'string' || !KNOWN_STATUSES.has(raw.status)) return null;
  return {
    pid: raw.pid,
    sessionId: raw.sessionId,
    status: raw.status,
    statusUpdatedAt: Number.isInteger(raw.statusUpdatedAt) ? raw.statusUpdatedAt : null,
    procStart: raw.procStart == null ? null : String(raw.procStart),
  };
}

function findSession(sessionId) {
  if (!activeSessions) return null;
  for (const [key, session] of activeSessions) {
    if (!session || session.exited || session.isPlainTerminal || !session.projectFolder) continue;
    const effectiveId = session.realSessionId || key;
    if (effectiveId === sessionId) return { sessionId: effectiveId, session };
  }
  return null;
}

function handleFile(name) {
  let text;
  try {
    text = fs.readFileSync(path.join(dir, name), 'utf8');
  } catch {
    known.delete(name);
    return;
  }

  const state = parseState(text);
  if (!state) return;

  const prev = known.get(name);
  known.set(name, { procStart: state.procStart, status: state.status });

  const reused = !!prev && prev.procStart !== state.procStart;
  if (!prev || reused) return;
  if (prev.status === state.status) return;
  if (state.status !== RESCAN_STATUS) return;
  if (!isProcessAlive(state.pid)) return;

  const match = findSession(state.sessionId);
  if (!match) {
    log.debug(`[cli-state] no active session for ${state.sessionId} (pid ${state.pid})`);
    return;
  }

  const now = Date.now();
  const last = lastRescanAt.get(match.sessionId) || 0;
  if (now - last < MIN_RESCAN_INTERVAL_MS) return;
  lastRescanAt.set(match.sessionId, now);

  try {
    onIdle(match.sessionId, match.session);
  } catch (err) {
    log.warn(`[cli-state] rescan failed for ${match.sessionId}: ${err.message}`);
  }
}

function flush() {
  flushTimer = null;
  const batch = [...pending];
  pending.clear();
  for (const name of batch) handleFile(name);
}

function seed() {
  let names;
  try { names = fs.readdirSync(dir); } catch { return; }
  const files = names.filter(n => STATE_FILE_RE.test(n));
  if (files.length > MAX_SEEDED_FILES) return;
  for (const name of files) {
    let text;
    try { text = fs.readFileSync(path.join(dir, name), 'utf8'); } catch { continue; }
    const state = parseState(text);
    if (state) known.set(name, { procStart: state.procStart, status: state.status });
  }
}

function ensureWatching() {
  if (watcher) return true;
  if (!onIdle || !activeSessions) return false;
  try {
    if (!fs.statSync(dir).isDirectory()) return false;
  } catch {
    return false;
  }
  seed();
  try {
    watcher = fs.watch(dir, (_eventType, filename) => {
      if (!filename || !STATE_FILE_RE.test(filename)) return;
      pending.add(filename);
      if (flushTimer) return;
      flushTimer = setTimeout(flush, FLUSH_MS);
      if (typeof flushTimer.unref === 'function') flushTimer.unref();
    });
    watcher.on('error', (err) => {
      log.warn(`[cli-state] watcher error: ${err.message}`);
      stop();
    });
  } catch (err) {
    watcher = null;
    log.warn(`[cli-state] cannot watch ${dir}: ${err.message}`);
    return false;
  }
  log.info(`[cli-state] watching ${dir}`);
  return true;
}

function stop() {
  if (watcher) {
    try { watcher.close(); } catch {}
    watcher = null;
  }
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  pending.clear();
  known.clear();
  lastRescanAt.clear();
}

module.exports = {
  init,
  ensureWatching,
  stop,
  parseState,
  KNOWN_STATUSES,
  DEFAULT_DIR,
  FLUSH_MS,
  MIN_RESCAN_INTERVAL_MS,
};
