// Mirror Claude CLI's project-folder naming so Switchboard-created folders
// match the ones the CLI writes for the same project path.
// Reverse-engineered from claude CLI 2.1.126.
function encodeProjectPath(projectPath) {
  const sanitized = projectPath.replace(/[^a-zA-Z0-9]/g, '-');
  if (sanitized.length <= 200) return sanitized;
  let h = 0;
  for (let i = 0; i < projectPath.length; i++) {
    h = (h << 5) - h + projectPath.charCodeAt(i) | 0;
  }
  return sanitized.slice(0, 200) + '-' + Math.abs(h).toString(36);
}

// Best-effort inverse of encodeProjectPath, for DISPLAY ONLY while the
// initial scan is still running and cache_meta has no real projectPath for a
// folder yet. The encoding is lossy (every non-alphanumeric became '-'), so
// this cannot distinguish a path separator from a dash, dot or underscore in
// the original path — '-home-jb-my-repo' decodes to '/home/jb/my/repo' even
// if the project was really /home/jb/my-repo. That approximation is
// acceptable: the sidebar entry is corrected as soon as the scan worker
// indexes the folder (per-folder projects-changed refresh). Callers must
// NEVER persist this guess (e.g. into cache_meta) — it would shadow the real
// derived path.
function decodeProjectFolderBestEffort(folder) {
  return folder.replace(/-/g, '/');
}

module.exports = { encodeProjectPath, decodeProjectFolderBestEffort };
