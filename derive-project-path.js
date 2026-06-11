const fs = require('fs');
const path = require('path');

// Only the head of the file is scanned: every session/subagent transcript
// carries `cwd` on its first JSONL line. Reading the whole file here froze
// the main process — refreshFolder() derives the project path on every
// watcher flush, so a 338 MB host-session JSONL meant a multi-second
// readFileSync per flush, back to back (witnessed 2026-06-11: main thread
// pegged ~65% CPU re-reading the same file in a loop, UI freezes).
const CWD_SCAN_BYTES = 256 * 1024;

function extractCwdFromJsonl(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(CWD_SCAN_BYTES);
    const bytesRead = fs.readSync(fd, buf, 0, CWD_SCAN_BYTES, 0);
    const lines = buf.toString('utf8', 0, bytesRead).split('\n');
    // The last line is truncated mid-entry when the file is bigger than the
    // scan window — drop it instead of feeding garbage to JSON.parse.
    if (bytesRead === CWD_SCAN_BYTES) lines.pop();
    for (const line of lines) {
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.cwd) return parsed.cwd;
      } catch {}
    }
  } catch {} finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
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

function deriveProjectPath(folderPath) {
  try {
    const entries = fs.readdirSync(folderPath, { withFileTypes: true });
    // Check direct .jsonl files first
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.jsonl')) {
        const cwd = extractCwdFromJsonl(path.join(folderPath, e.name));
        if (cwd) return resolveWorktreePath(cwd);
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
            if (cwd) return resolveWorktreePath(cwd);
          }
        }
      } catch {}
    }
  } catch {}
  return null;
}

module.exports = { deriveProjectPath, resolveWorktreePath };
