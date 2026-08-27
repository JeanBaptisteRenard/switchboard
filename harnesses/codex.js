// OpenAI Codex harness.
//
// Codex stores sessions very differently from Claude, and most of this file
// exists to absorb those differences:
//
//   - transcripts live at $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl,
//     so a folder is a DATE, not a project, and one folder holds sessions from
//     many projects. Each transcript carries its own cwd, hence groupsByProject.
//   - the file name is not the session id, hence sessionFile in session_cache.
//   - the transcript is only written on the first turn, so a launched-but-unused
//     session leaves nothing on disk at all.

const fs = require('fs');
const os = require('os');
const path = require('path');

const id = 'codex';
const label = 'Codex';
const binary = 'codex';

// Folder keys are date paths ('2026/08/26') under this prefix. encodeProjectPath
// emits [a-zA-Z0-9-] only, so a key containing '/' can never be a Claude one.
const folderPrefix = 'codex/';

// A codex folder is a date, so its sessions belong to different projects and the
// project has to be read per transcript. Claude's folder IS the project.
const groupsByProject = false;

const ROLLOUT_RE = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

// --- Layout ---

function codexHome() {
  return process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(os.homedir(), '.codex');
}

function sessionsRoot() {
  return path.join(codexHome(), 'sessions');
}

function available() {
  return fs.existsSync(sessionsRoot());
}

function subdirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch {
    return [];
  }
}

/**
 * Every YYYY/MM/DD folder, as the prefixed keys stored in session_cache.folder.
 *
 * Old date folders never change, so the caller's mtime gate skips them for the
 * cost of one stat each — which is what keeps this cheap as history piles up.
 */
function listFolders() {
  const root = sessionsRoot();
  const folders = [];
  for (const y of subdirs(root)) {
    if (!/^\d{4}$/.test(y)) continue;
    for (const m of subdirs(path.join(root, y))) {
      if (!/^\d{2}$/.test(m)) continue;
      for (const d of subdirs(path.join(root, y, m))) {
        if (!/^\d{2}$/.test(d)) continue;
        // Always '/' — this is a stored key, not a filesystem path.
        folders.push(`${folderPrefix}${y}/${m}/${d}`);
      }
    }
  }
  return folders;
}

/** Takes the key with folderPrefix already stripped, e.g. '2026/08/26'. */
function folderPath(folder) {
  return path.join(sessionsRoot(), ...String(folder).split('/'));
}

/** Codex has no per-project directory, so a project cannot be created here. */
function folderForProject() {
  return null;
}

/** A codex folder spans projects, so there is no folder-level project path. */
function deriveProjectPath() {
  return null;
}

function listTranscripts(dir) {
  try {
    return fs.readdirSync(dir)
      .filter(f => ROLLOUT_RE.test(f))
      .map(f => path.join(dir, f));
  } catch {
    return [];
  }
}

/**
 * The session id is the uuid suffix of the file name.
 *
 * Deliberately NOT session_meta.session_id: that field is the lineage root, and
 * every resume or fork of a conversation repeats it, so six rollout files on
 * disk here share one value. The file name's uuid is unique per rollout, is
 * what `codex resume <id>` accepts (verified), and is what codex's own
 * session_index.jsonl keys on. Reading it costs no file access.
 */
function sessionIdFromPath(filePath) {
  const m = ROLLOUT_RE.exec(path.basename(filePath));
  return m ? m[1] : null;
}

function transcriptPath({ sessionFile }) {
  // Unlike Claude, a codex path cannot be rebuilt from the session id: the file
  // name carries a timestamp and sits in a date directory. sessionFile is the
  // only way back to it, and is written for every codex row.
  return sessionFile || null;
}

// --- Transcript parsing ---

// Codex injects context into the conversation as user-role messages wrapped in
// a tag — <environment_context>, <recommended_plugins>, <turn_aborted>,
// <transcript>. Across every rollout on disk, no genuine user prompt starts
// with one, so this is the line between what the user said and what the CLI
// said on their behalf.
const INJECTED_RE = /^\s*<[a-z_]+>/;

/**
 * Is this rollout a sub-agent thread rather than a conversation the user had?
 *
 * Any one of these is conclusive; they do not all appear together, and older
 * rollouts carry none of them (correctly, since multi-agent postdates them).
 */
function isSubagentMeta(payload) {
  return payload.thread_source === 'subagent'
    || !!payload.parent_thread_id
    || !!payload.agent_path
    || !!payload.agent_nickname;
}

function messageText(payload) {
  const content = payload?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(c => (c && typeof c.text === 'string' ? c.text : '')).join('');
}

/**
 * Parse one rollout into the same session shape Claude's parser returns.
 *
 * Only `response_item` message records are counted. Older codex versions ALSO
 * emit event_msg user_message/agent_message records carrying the same text, so
 * counting both would double every message; response_item is the one present in
 * every rollout on disk, event_msg is not.
 */
function readSessionFile(filePath, folder) {
  try {
    const stat = fs.statSync(filePath);
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');

    const sessionId = sessionIdFromPath(filePath);
    if (!sessionId) return null;

    let projectPath = null;
    let summary = '';
    let messageCount = 0;
    let textContent = '';
    let firstTimestamp = null;
    let lastTimestamp = null;

    for (const line of lines) {
      if (!line) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }

      const ts = entry.timestamp;
      if (ts) {
        // ISO-8601 UTC strings — lexicographic comparison is chronological
        if (!firstTimestamp || ts < firstTimestamp) firstTimestamp = ts;
        if (!lastTimestamp || ts > lastTimestamp) lastTimestamp = ts;
      }

      const payload = entry.payload;
      if (!payload) continue;

      if (entry.type === 'session_meta') {
        // Sub-agent threads are recorded as ordinary rollouts, but codex refuses
        // to resume one directly ("cannot resume an unloaded multi-agent v2
        // sub-agent through its parent"). Showing them would mean offering a
        // resume that always fails. Claude's subagent transcripts are already
        // excluded — they live in a subagents/ subdirectory the indexer never
        // scans — so this keeps the two consistent.
        if (isSubagentMeta(payload)) return null;
        projectPath = projectPath || payload.cwd || null;
        continue;
      }

      if (entry.type !== 'response_item' || payload.type !== 'message') continue;

      const role = payload.role;
      if (role !== 'user' && role !== 'assistant') continue; // 'developer' is CLI scaffolding

      const text = messageText(payload);
      if (role === 'user' && INJECTED_RE.test(text)) continue;

      messageCount++;
      if (!summary && role === 'user' && text) summary = text.slice(0, 120);
      if (text && textContent.length < 8000) textContent += text.slice(0, 500) + '\n';
    }

    // No cwd means no project to file it under; no user turn means the session
    // was opened and abandoned. Either way there is nothing to show.
    if (!projectPath) return null;
    if (!summary || messageCount < 1) return null;

    return {
      sessionId, folder, projectPath,
      runtime: id,
      sessionFile: filePath,
      summary, firstPrompt: summary,
      created: firstTimestamp || stat.birthtime.toISOString(),
      modified: lastTimestamp || stat.mtime.toISOString(),
      fileMtime: stat.mtime.toISOString(),
      messageCount, textContent,
      slug: null, customTitle: null, aiTitle: null,
    };
  } catch {
    return null;
  }
}

// --- New-session detection ---
//
// codex will not accept a pre-assigned session id, and writes no transcript at
// all until the first turn. So a new session is launched under a temporary id
// and matched to its rollout afterwards.
//
// The handshake is CODEX_INTERNAL_ORIGINATOR_OVERRIDE, which codex copies
// verbatim into session_meta.originator. That gives an exact match even when
// several codex sessions start in the same directory at once.

/**
 * Env tag identifying a session we launched.
 *
 * Restricted to [a-z0-9_]: the value ends up in an HTTP header, and the binary
 * carries an "ignoring invalid thread originator header value" path. The
 * hyphens of a uuid are stripped rather than risk it.
 */
function originatorTag(tempId) {
  return 'switchboard_' + String(tempId).replace(/[^a-zA-Z0-9]/g, '');
}

function launchEnv(tempId) {
  return { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: originatorTag(tempId) };
}

/**
 * Read just enough of a rollout's first line to decide whether it is ours.
 *
 * Cheap on purpose — this runs for every file the watcher reports, including
 * appends to large transcripts.
 */
function readLaunchSignals(filePath) {
  let head;
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(65536);
      const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
      head = buf.toString('utf8', 0, bytes);
    } finally {
      fs.closeSync(fd);
    }
  } catch { return null; }

  const newline = head.indexOf('\n');
  if (newline === -1) return null; // line 1 still being written
  let entry;
  try { entry = JSON.parse(head.slice(0, newline)); } catch { return null; }
  if (!entry || entry.type !== 'session_meta') return null;

  const payload = entry.payload || {};
  return {
    sessionId: sessionIdFromPath(filePath),
    originator: payload.originator || null,
    cwd: payload.cwd || null,
    startedAt: payload.timestamp || entry.timestamp || null,
    isSubagent: isSubagentMeta(payload),
  };
}

// A rollout created slightly before the spawn timestamp is still plausibly ours:
// clocks and the two timestamps involved are not the same source.
const SPAWN_SKEW_MS = 5000;

/**
 * Does this rollout belong to a session we just launched?
 *
 * The originator match is exact and needs no other evidence. The fallback
 * exists because the override is an internal variable that may stop working:
 * same directory, created after we spawned. It deliberately refuses a rollout
 * tagged for a DIFFERENT switchboard launch, which would otherwise be the one
 * case where two concurrent new sessions could steal each other's transcript.
 */
function matchesLaunch(signals, { tag, projectPath, spawnedAt }) {
  if (!signals || signals.isSubagent || !signals.sessionId) return false;
  if (tag && signals.originator === tag) return true;
  if (signals.originator && /^switchboard_/.test(signals.originator)) return false;
  if (!projectPath || signals.cwd !== projectPath) return false;
  if (!signals.startedAt) return false;
  const started = Date.parse(signals.startedAt);
  return Number.isFinite(started) && started >= spawnedAt - SPAWN_SKEW_MS;
}

// --- Launch ---

const SANDBOX_MODES = new Set(['read-only', 'workspace-write', 'danger-full-access']);
const APPROVAL_POLICIES = new Set(['on-request', 'never']);

/**
 * Argv for the codex binary.
 *
 * `codex resume <id>` accepts the same flags as a fresh launch, so the option
 * mapping is shared. Claude-only keys in the options bag (permissionMode,
 * worktree, chrome, appendSystemPrompt) are ignored rather than translated —
 * codex has no equivalent, and passing an unknown flag fails the launch.
 *
 * Enumerated values are checked against what the CLI accepts instead of being
 * interpolated blind: these come from stored settings, which can outlive the
 * codex version that understood them.
 */
function buildLaunchArgs({ sessionId, isNew, options }) {
  const args = [];
  if (options?.forkFrom) {
    args.push('fork', String(options.forkFrom));
  } else if (!isNew) {
    args.push('resume', String(sessionId));
  }
  // A new session takes no subcommand — and no id, because codex will not let
  // one be pre-assigned. See harnesses/codex.js header and the detection step.

  if (options) {
    if (options.dangerouslySkipPermissions) {
      args.push('--dangerously-bypass-approvals-and-sandbox');
    } else {
      if (SANDBOX_MODES.has(options.codexSandbox)) {
        args.push('--sandbox', options.codexSandbox);
      }
      if (APPROVAL_POLICIES.has(options.codexApproval)) {
        args.push('--ask-for-approval', options.codexApproval);
      }
    }
    if (options.codexModel) {
      args.push('--model', String(options.codexModel));
    }
    if (options.addDirs) {
      const dirs = String(options.addDirs).split(',').map(d => d.trim()).filter(Boolean);
      for (const dir of dirs) {
        args.push('--add-dir', dir);
      }
    }
  }

  return args;
}

module.exports = {
  id, label, binary, folderPrefix, groupsByProject,
  buildLaunchArgs, launchEnv, originatorTag, readLaunchSignals, matchesLaunch,
  available, codexHome, sessionsRoot, listFolders, folderPath, folderForProject,
  listTranscripts, sessionIdFromPath, transcriptPath, isSubagentMeta,
  deriveProjectPath,
  readSessionFile,
};
