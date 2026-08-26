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

module.exports = {
  id, label, binary, folderPrefix, groupsByProject,
  available, codexHome, sessionsRoot, listFolders, folderPath, folderForProject,
  listTranscripts, sessionIdFromPath, transcriptPath,
  deriveProjectPath,
  readSessionFile,
};
