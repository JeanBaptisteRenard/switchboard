const path = require('path');
const fs = require('fs');
const { readSubagentMeta } = require('./read-session-file');
const { enabled: TRACE, trace } = require('./activity-trace');

/**
 * Fork detection for active PTY sessions.
 * Call init(ctx) once with shared context.
 */
let PROJECTS_DIR, activeSessions, getMainWindow, log, rekeyMcpServer;

function init(ctx) {
  PROJECTS_DIR = ctx.PROJECTS_DIR;
  activeSessions = ctx.activeSessions;
  getMainWindow = ctx.getMainWindow;
  log = ctx.log;
  rekeyMcpServer = ctx.rekeyMcpServer;
}

// --- Subagent spawn / completion detection ---

/** Walk <folder>/<sessionId>/subagents/ and detect new or completed subagent files.
 *  Mutates session.knownSubagents (Map<agentId, { mtimeMs, completed }>).
 *  Emits IPC 'subagent-spawned' and 'subagent-completed' via mainWindow. */
function detectSubagentTransitions(sessionId, session, folderPath) {
  const subagentsDir = path.join(folderPath, sessionId, 'subagents');

  // --- Hot-path cache: avoid readdirSync + N×statSync when dir is quiet ---
  // With 1000+ subagents, the full scan blocks the main thread ~70 ms per
  // flush. We cache the dir's mtime; when it hasn't changed, no new files
  // could have appeared, so we skip readdirSync AND statSync for unknown
  // files. Known-active entries still get statSync for the stability timer.
  //
  // Session-local state:
  //   _prevDirMtime  — subagentsDir mtime at the last readdirSync
  //   _subFileList   — .jsonl file list from that scan
  let dirMtime;
  try {
    dirMtime = fs.statSync(subagentsDir).mtimeMs;
  } catch {
    return; // directory doesn't exist yet — normal
  }

  const isBootstrap = !session.knownSubagents;

  // dirChanged: true when dir mtime moved or we have no prior scan yet.
  // Also true when the prior scan returned 0 files: the dir mtime may not
  // advance within the same filesystem-clock tick on fast writes, so we
  // must rescan until we see at least one file to avoid missing arrivals.
  const prevFileList = session._subFileList;
  const dirChanged = isBootstrap
    || session._prevDirMtime !== dirMtime
    || !prevFileList
    || prevFileList.length === 0;

  let files;
  if (dirChanged) {
    try {
      files = fs.readdirSync(subagentsDir).filter(f => f.endsWith('.jsonl'));
    } catch {
      return;
    }
    session._prevDirMtime = dirMtime;
    session._subFileList = files;
  } else {
    // Dir mtime unchanged and we saw files before — reuse cached list; no
    // new files can have appeared.
    files = prevFileList;
  }

  // First walk for this session: pre-populate knownSubagents with every
  // existing file silently so we don't flood the renderer with spawn/complete
  // events for agents that already finished before Switchboard started watching.
  // No file present at this point can belong to a live agent, whatever its
  // mtime — see .ai/contexts/subagent-observability.md
  if (isBootstrap) {
    session.knownSubagents = new Map();
  }

  const mainWindow = getMainWindow();
  const now = Date.now();
  const STABLE_MS = 30000; // 30 seconds of no mtime advance → completed
  const FRESH_SIGHTING_MS = 60000; // post-bootstrap: first sighting counts as live if newer than this
  // Re-emit subagent-spawned (idempotent on the renderer side — it just
  // refreshes the entry's last-seen timestamp) at most every HEARTBEAT_MS
  // while an agent's file keeps growing. Without this, the renderer's 60s
  // liveness TTL evicts any subagent that runs longer than a minute — the
  // common case — and the parent's indicator goes dark while the agent is
  // still working. A file that stops growing needs no heartbeat: it either
  // completes via the 30s stability timer (subagent-completed) or, if the
  // parent PTY died first, the renderer TTL prunes it — both under 60s of
  // silence, so the orphan behavior is unchanged.
  const HEARTBEAT_MS = 20000;

  for (const file of files) {
    // agent-<agentId>.jsonl
    const m = file.match(/^agent-(.+)\.jsonl$/);
    if (!m) continue;
    const agentId = m[1];
    const filePath = path.join(subagentsDir, file);

    const known = session.knownSubagents.get(agentId);

    // Completed and settled — nothing more to do, skip statSync. An entry
    // still carrying a recheck window is the exception: it was only assumed
    // finished, and growth would disprove that.
    if (known && known.completed && !known._recheckStart) continue;

    // Dir unchanged → no new entries can exist; skip statSync for unknown files.
    if (!known && !dirChanged) continue;

    let stat;
    try { stat = fs.statSync(filePath); } catch { continue; }
    const mtimeMs = stat.mtimeMs;

    if (!known) {
      // A file that cannot be live is recorded as finished, silently. At
      // bootstrap that covers every file: Switchboard owns the PTYs, so
      // nothing it spawned outlived the previous process. Afterwards only a
      // stale mtime says so, and the sighting may simply be late.
      //
      // Either way the verdict stays reversible while the file could
      // conceivably be alive — a recheck window rehabilitates it if it grows.
      // Only a plainly historical file seen at bootstrap is frozen outright,
      // which is what keeps startup free of a per-file statSync.
      // See .ai/contexts/subagent-observability.md
      const isFresh = (now - mtimeMs) < FRESH_SIGHTING_MS;
      const looksAlive = !isBootstrap && isFresh;
      if (!looksAlive) {
        const recheck = !isBootstrap || isFresh;
        session.knownSubagents.set(agentId, {
          mtimeMs,
          completed: true,
          _completedAt: now,
          subagentType: null,
          description: null,
          _lastHeartbeatAt: now,
          _recheckStart: recheck ? now : null,
        });
        if (TRACE) trace('subagent.assumed-finished', sessionId, { agentId, ageMs: now - mtimeMs, bootstrap: isBootstrap, recheck });
        continue;
      }

      // First sighting of a live file — always post-bootstrap, so a genuine spawn.
      const meta = readSubagentMeta(filePath) || {};
      session.knownSubagents.set(agentId, {
        mtimeMs,
        completed: false,
        _completedAt: null,
        subagentType: meta.agentType || null,
        description: meta.description || null,
        _lastHeartbeatAt: now,
      });
      log.info(`[subagent-spawn] parent=${sessionId} agentId=${agentId} type=${meta.agentType || 'unknown'}`);
      if (TRACE) trace('subagent.spawned', sessionId, { agentId, kind: 'spawn', subagentType: meta.agentType || null, ageMs: now - mtimeMs, sent: !!(mainWindow && !mainWindow.isDestroyed()) });
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('subagent-spawned', {
          parentSessionId: sessionId,
          agentId,
          subagentType: meta.agentType || null,
          description: meta.description || null,
        });
      }
    } else if (known.completed) {
      // Inside the recheck window of an assumed-finished entry. A file that
      // grows is alive: undo the assumption and emit the withheld spawn.
      if (mtimeMs !== known.mtimeMs) {
        const meta = readSubagentMeta(filePath) || {};
        if (TRACE) trace('subagent.rehabilitated', sessionId, { agentId, withheldForMs: now - known._recheckStart, subagentType: meta.agentType || null, sent: !!(mainWindow && !mainWindow.isDestroyed()) });
        known.mtimeMs = mtimeMs;
        known.completed = false;
        known._completedAt = null;
        known._recheckStart = null;
        known._stableStart = null;
        known.subagentType = meta.agentType || null;
        known.description = meta.description || null;
        known._lastHeartbeatAt = now;
        log.info(`[subagent-spawn-late] parent=${sessionId} agentId=${agentId} type=${meta.agentType || 'unknown'}`);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('subagent-spawned', {
            parentSessionId: sessionId,
            agentId,
            subagentType: meta.agentType || null,
            description: meta.description || null,
          });
        }
      } else if (now - known._recheckStart >= STABLE_MS) {
        // Observed motionless for a full stability window — settled.
        known._recheckStart = null;
      }
    } else {
      if (mtimeMs !== known.mtimeMs) {
        // File is still being written — update mtime, reset stability clock
        known.mtimeMs = mtimeMs;
        known._stableStart = null;
        // Still-alive heartbeat (throttled) — see HEARTBEAT_MS above.
        if (now - (known._lastHeartbeatAt || 0) >= HEARTBEAT_MS
            && mainWindow && !mainWindow.isDestroyed()) {
          known._lastHeartbeatAt = now;
          if (TRACE) trace('subagent.spawned', sessionId, { agentId, kind: 'heartbeat', subagentType: known.subagentType || null, sent: true });
          mainWindow.webContents.send('subagent-spawned', {
            parentSessionId: sessionId,
            agentId,
            subagentType: known.subagentType || null,
            description: known.description || null,
            _heartbeat: true,
          });
        }
      } else {
        // mtime stable — start or continue stability timer
        if (!known._stableStart) {
          known._stableStart = now;
        } else if (now - known._stableStart >= STABLE_MS) {
          known.completed = true;
          known._completedAt = now;
          log.info(`[subagent-complete] parent=${sessionId} agentId=${agentId}`);
          if (TRACE) trace('subagent.completed', sessionId, { agentId, stableForMs: now - known._stableStart, reason: 'mtime-stable', sent: !!(mainWindow && !mainWindow.isDestroyed()) });
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('subagent-completed', {
              parentSessionId: sessionId,
              agentId,
            });
          }
        }
      }
    }
  }

  // GC: forget an entry only once its file has left the disk, which bounds the
  // map by the directory's own size. See .ai/contexts/subagent-observability.md
  if (dirChanged && session.knownSubagents.size > files.length) {
    const onDisk = new Set();
    for (const file of files) {
      const m = file.match(/^agent-(.+)\.jsonl$/);
      if (m) onDisk.add(m[1]);
    }
    for (const agentId of session.knownSubagents.keys()) {
      if (!onDisk.has(agentId)) session.knownSubagents.delete(agentId);
    }
  }
}

// --- Fork detection ---

/** Read first few lines of a new .jsonl to extract signals.
 *  Skips file-history-snapshot lines which can be very large (tens of KB)
 *  and reads up to 512KB to find the first user/assistant entry. */
function readNewSessionSignals(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(524288);
    const bytesRead = fs.readSync(fd, buf, 0, 524288, 0);
    fs.closeSync(fd);
    const head = buf.toString('utf8', 0, bytesRead);
    const lines = head.split('\n').filter(Boolean);
    let forkedFrom = null;
    let slug = null;
    let parentSessionId = null;
    let hasSnapshots = false;
    for (const line of lines) {
      const entry = JSON.parse(line);
      // Skip snapshot lines — they carry no fork/session signals
      if (entry.type === 'file-history-snapshot') { hasSnapshots = true; continue; }
      if (entry.forkedFrom) forkedFrom = entry.forkedFrom.sessionId;
      if (entry.slug && !slug) slug = entry.slug;
      // --fork-session copies messages with original sessionId
      if (entry.sessionId && !parentSessionId) parentSessionId = entry.sessionId;
      // Stop after finding a user or assistant message
      if (entry.type === 'user' || entry.type === 'assistant') break;
    }
    return { forkedFrom, slug, parentSessionId, hasSnapshots };
  } catch {
    return { forkedFrom: null, slug: null, parentSessionId: null, hasSnapshots: false };
  }
}

/** Detect fork transitions for active PTY sessions in a folder */
function detectSessionTransitions(folder) {
  const folderPath = path.join(PROJECTS_DIR, folder);
  let currentFiles;
  try {
    currentFiles = fs.readdirSync(folderPath).filter(f => f.endsWith('.jsonl'));
  } catch { return; }

  for (const [sessionId, session] of [...activeSessions]) {
    // Run subagent detection for all non-exited, non-terminal sessions in this folder
    if (!session.exited && !session.isPlainTerminal && session.projectFolder === folder) {
      const effectiveSessionId = session.realSessionId || sessionId;
      detectSubagentTransitions(effectiveSessionId, session, folderPath);
    }

    if (session.exited || session.isPlainTerminal || !session.knownJsonlFiles || session.projectFolder !== folder) {
      if (!session.exited && !session.isPlainTerminal && session.forkFrom) {
        log.info(`[fork-detect] skipped session=${sessionId} forkFrom=${session.forkFrom||'none'} reason=${session.exited ? 'exited' : session.isPlainTerminal ? 'terminal' : !session.knownJsonlFiles ? 'noKnown' : 'folderMismatch('+session.projectFolder+' vs '+folder+')'}`);
      }
      continue;
    }

    const newFiles = currentFiles.filter(f => !session.knownJsonlFiles.has(f));

    if (newFiles.length > 0) log.debug(`[detect] session=${sessionId} forkFrom=${session.forkFrom||'none'} folder=${folder} newFiles=${newFiles.length} knownCount=${session.knownJsonlFiles.size} currentCount=${currentFiles.length}`);

    if (newFiles.length === 0) continue;

    const emptyFiles = new Set(); // files with no signals yet (still being written)

    for (const newFile of newFiles) {
      const newFilePath = path.join(folderPath, newFile);
      const newId = path.basename(newFile, '.jsonl');
      const signals = readNewSessionSignals(newFilePath);

      // File exists but has no parseable content yet — skip and retry next cycle
      // But if the file's mtime is older than 1 hour, treat it as stale and archive it
      if (!signals.forkedFrom && !signals.parentSessionId && !signals.slug) {
        // Fork file with only snapshots (no user turn yet) — match immediately
        if (signals.hasSnapshots && session.forkFrom && !session.realSessionId) {
          log.info(`[detect] session=${sessionId} matching snapshot-only fork file=${newId}`);
          // Fall through to matching logic — will match via the fork-snapshot path below
        } else {
          let stale = false;
          try {
            const mtime = fs.statSync(path.join(folderPath, newFile)).mtimeMs;
            if (Date.now() - mtime > 3600000) stale = true;
          } catch {}
          if (stale) {
            log.info(`[detect] session=${sessionId} archiving stale empty file=${newId}`);
          } else {
            emptyFiles.add(newFile);
          }
          continue;
        }
      }

      if (session.forkFrom) {
        log.info(`[detect] session=${sessionId} checking newFile=${newId} signals=${JSON.stringify({forkedFrom: signals.forkedFrom||null, parentSessionId: signals.parentSessionId||null, slug: signals.slug||null})} forkFrom=${session.forkFrom}`);
      } else {
        log.debug(`[detect] session=${sessionId} checking newFile=${newId} signals=${JSON.stringify({forkedFrom: signals.forkedFrom||null, parentSessionId: signals.parentSessionId||null, slug: signals.slug||null})} forkFrom=none`);
      }

      let matched = false;

      // Fork: forkedFrom.sessionId matches this active PTY or the session it was forked from
      if (signals.forkedFrom === sessionId || (session.forkFrom && signals.forkedFrom === session.forkFrom)) {
        matched = true;
      }
      // --fork-session: new file's parentSessionId matches the forkFrom source,
      // and the new file's name (newId) differs from both our PTY id and the source
      if (!matched && session.forkFrom && signals.parentSessionId === session.forkFrom && newId !== session.forkFrom) {
        matched = true;
      }
      // Fork file with only snapshots — no user turn yet, but this session is waiting for a fork
      if (!matched && signals.hasSnapshots && session.forkFrom && !session.realSessionId) {
        matched = true;
      }

      if (session.forkFrom && !matched) {
        log.info(`[detect] session=${sessionId} NO MATCH for newFile=${newId} forkFrom=${session.forkFrom} parentSessionId=${signals.parentSessionId||'null'} forkedFrom=${signals.forkedFrom||'null'}`);
      }

      if (matched) {
        log.info(`[session-transition] ${sessionId} → ${newId} (fork)`);
        session.knownJsonlFiles = new Set(currentFiles);
        session.realSessionId = newId;
        // Subagent scanning follows realSessionId into a different directory —
        // drop the state keyed to the old one so the new one bootstraps.
        session.knownSubagents = null;
        session._prevDirMtime = undefined;
        session._subFileList = null;
        activeSessions.delete(sessionId);
        activeSessions.set(newId, session);
        // Re-key MCP server to match new session ID
        rekeyMcpServer(sessionId, newId);
        const mainWindow = getMainWindow();
        if (TRACE) trace('session.forked', sessionId, { newId, wasBusy: !!session._cliBusy, sent: !!(mainWindow && !mainWindow.isDestroyed()) });
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('session-forked', sessionId, newId);
        }
        break; // Only one transition per session per flush
      }
    }

    // Update known files, but exclude empty ones so they get rechecked next cycle
    const updated = new Set(currentFiles);
    for (const f of emptyFiles) updated.delete(f);
    session.knownJsonlFiles = updated;
  }
}


module.exports = { init, detectSessionTransitions, detectSubagentTransitions };
