// Claude Code harness.
//
// Owns everything that is specific to how the `claude` CLI stores sessions on
// disk and how it is launched:
//
//   - transcript layout: ~/.claude/projects/<encoded-project>/<sessionId>.jsonl
//   - transcript format: one JSON object per line
//   - launch flags: --session-id / --resume / --fork-session / …
//
// Nothing outside this file should assume any of that. See harnesses/index.js
// for the shape every harness implements.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { encodeProjectPath } = require('../encode-project-path');

const id = 'claude';
const label = 'Claude';
const binary = 'claude';

// --- Layout ---

function sessionsRoot() {
  return path.join(os.homedir(), '.claude', 'projects');
}

function available() {
  return fs.existsSync(sessionsRoot());
}

/** Folder keys under sessionsRoot(). For Claude these are encoded project paths. */
function listFolders() {
  try {
    return fs.readdirSync(sessionsRoot(), { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name !== '.git')
      .map(d => d.name);
  } catch {
    return [];
  }
}

function folderPath(folder) {
  return path.join(sessionsRoot(), folder);
}

/** Which folder a project's sessions live in. */
function folderForProject(projectPath) {
  return encodeProjectPath(projectPath);
}

/** Transcript files inside a folder, as absolute paths. */
function listTranscripts(folder) {
  try {
    const dir = folderPath(folder);
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => path.join(dir, f));
  } catch {
    return [];
  }
}

/**
 * Absolute transcript path for a cached row. `sessionFile` is authoritative
 * when present; rows written before that column existed reconstruct the path
 * from folder + sessionId, which is exactly how Claude names its files.
 */
function transcriptPath({ sessionId, folder, sessionFile }) {
  if (sessionFile) return sessionFile;
  return path.join(folderPath(folder), sessionId + '.jsonl');
}

// --- Project path derivation ---

function extractCwdFromJsonl(filePath) {
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    for (const line of lines) {
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.cwd) return parsed.cwd;
      } catch {}
    }
  } catch {}
  return null;
}

function resolveWorktreePath(cwd) {
  if (!cwd) return cwd;
  // Detect worktree paths: <project>/.claude-worktrees/<name>, <project>/.worktrees/<name>, or <project>/.claude/worktrees/<name>
  const worktreeMatch = cwd.match(/^(.+?)\/\.(?:claude\/worktrees|claude-worktrees|worktrees)\/[^/]+\/?$/);
  if (worktreeMatch) {
    const parent = worktreeMatch[1];
    if (fs.existsSync(parent)) return parent;
  }
  return cwd;
}

/** The project a folder belongs to, read out of any transcript it contains. */
function deriveProjectPath(folderPath) {
  try {
    const entries = fs.readdirSync(folderPath, { withFileTypes: true });
    // Check direct .jsonl files first
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.jsonl')) {
        const cwd = extractCwdFromJsonl(path.join(folderPath, e.name));
        if (cwd) return cwd;
      }
    }
    // Check session subdirectories (UUID folders with subagent .jsonl files)
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const subDir = path.join(folderPath, e.name);
      try {
        const subFiles = fs.readdirSync(subDir, { withFileTypes: true });
        for (const sf of subFiles) {
          let jsonlPath;
          if (sf.isFile() && sf.name.endsWith('.jsonl')) {
            jsonlPath = path.join(subDir, sf.name);
          } else if (sf.isDirectory() && sf.name === 'subagents') {
            const agentFiles = fs.readdirSync(path.join(subDir, 'subagents')).filter(f => f.endsWith('.jsonl'));
            if (agentFiles.length > 0) jsonlPath = path.join(subDir, 'subagents', agentFiles[0]);
          }
          if (jsonlPath) {
            const cwd = extractCwdFromJsonl(jsonlPath);
            if (cwd) return cwd;
          }
        }
      } catch {}
    }
  } catch {}
  return null;
}

// --- Transcript parsing ---

/** Parse a single .jsonl file into a session object (or null if invalid) */
function readSessionFile(filePath, folder, projectPath) {
  const sessionId = path.basename(filePath, '.jsonl');
  try {
    const stat = fs.statSync(filePath);
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    let summary = '';
    let messageCount = 0;
    let textContent = '';
    let slug = null;
    let customTitle = null;
    let aiTitle = null;
    // Real conversation time bounds. Resuming a session appends untimestamped
    // bookkeeping records (last-prompt, mode, ai-title, …) which bump the file's
    // mtime without any actual activity, so mtime can't be the displayed time.
    let firstTimestamp = null;
    let lastTimestamp = null;
    for (const line of lines) {
      const entry = JSON.parse(line);
      if (entry.timestamp) {
        // ISO-8601 UTC strings — lexicographic comparison is chronological
        if (!firstTimestamp || entry.timestamp < firstTimestamp) firstTimestamp = entry.timestamp;
        if (!lastTimestamp || entry.timestamp > lastTimestamp) lastTimestamp = entry.timestamp;
      }
      if (entry.slug && !slug) slug = entry.slug;
      if (entry.type === 'custom-title' && entry.customTitle) {
        customTitle = entry.customTitle;
      }
      if (entry.type === 'ai-title' && entry.aiTitle) {
        aiTitle = entry.aiTitle;
      }
      if (entry.type === 'user' || entry.type === 'assistant' ||
          (entry.type === 'message' && (entry.role === 'user' || entry.role === 'assistant'))) {
        messageCount++;
      }
      const msg = entry.message;
      const text = typeof msg === 'string' ? msg :
        (typeof msg?.content === 'string' ? msg.content :
        (msg?.content?.[0]?.text || ''));
      if (!summary && (entry.type === 'user' || (entry.type === 'message' && entry.role === 'user'))) {
        // Skip local command messages (! prefix) — use the next real user message
        if (text && !/<bash-input>|<bash-stdout>|<local-command-caveat>/.test(text)) {
          // Use scheduled task name if present
          const taskMatch = text.match(/<scheduled-task\s+name="([^"]+)"/);
          summary = taskMatch ? 'Scheduled: ' + taskMatch[1] : text.slice(0, 120);
        }
      }
      if (text && textContent.length < 8000) {
        textContent += text.slice(0, 500) + '\n';
      }
    }
    if (!summary || messageCount < 1) return null;
    return {
      sessionId, folder, projectPath,
      harness: id,
      sessionFile: filePath,
      summary, firstPrompt: summary,
      // created/modified are display+sort values from message timestamps;
      // fileMtime is the cache-invalidation key (compared against stat.mtime
      // in refreshFolder). Old transcripts without timestamps fall back to stat.
      created: firstTimestamp || stat.birthtime.toISOString(),
      modified: lastTimestamp || stat.mtime.toISOString(),
      fileMtime: stat.mtime.toISOString(),
      messageCount, textContent, slug, customTitle, aiTitle,
    };
  } catch {
    return null;
  }
}

// --- Launch ---

/**
 * Argv for the claude binary. Returned as an array so the caller can quote it
 * for the target shell rather than building a command string here.
 */
function buildLaunchArgs({ sessionId, isNew, options }) {
  const args = [];
  if (options?.forkFrom) {
    args.push('--resume', String(options.forkFrom), '--fork-session');
  } else if (isNew) {
    args.push('--session-id', String(sessionId));
  } else {
    args.push('--resume', String(sessionId));
  }

  if (options) {
    if (options.dangerouslySkipPermissions) {
      args.push('--dangerously-skip-permissions');
    } else if (options.permissionMode) {
      args.push('--permission-mode', String(options.permissionMode));
    }
    // --worktree only applies when STARTING a session — it creates a fresh
    // isolated git worktree. Resuming (isNew === false) must reuse the
    // session's existing directory, so ignore the worktree option on resume
    // regardless of which call site supplied it (sidebar click, schedule
    // creator, fork, …). Otherwise a resume tries to spin up a new worktree
    // and fails to attach.
    if (isNew && options.worktree) {
      args.push('--worktree');
      if (options.worktreeName) {
        args.push(String(options.worktreeName));
      }
    }
    if (options.chrome) {
      args.push('--chrome');
    }
    if (options.addDirs) {
      const dirs = String(options.addDirs).split(',').map(d => d.trim()).filter(Boolean);
      for (const dir of dirs) {
        args.push('--add-dir', dir);
      }
    }
  }

  if (options?.appendSystemPrompt) {
    args.push('--append-system-prompt', String(options.appendSystemPrompt));
  }

  return args;
}

module.exports = {
  id, label, binary,
  available, sessionsRoot, listFolders, folderPath, folderForProject,
  listTranscripts, transcriptPath,
  deriveProjectPath, resolveWorktreePath,
  readSessionFile,
  buildLaunchArgs,
};
