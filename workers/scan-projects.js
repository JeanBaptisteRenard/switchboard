const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const { getFolderIndexMtimeMs } = require('../folder-index-state');
const { deriveProjectPath } = require('../derive-project-path');
const { readSessionFile, enumerateSessionFiles } = require('../read-session-file');

const PROJECTS_DIR = workerData.projectsDir;

function readFolderFromFilesystem(folder) {
  const folderPath = path.join(PROJECTS_DIR, folder);
  const projectPath = deriveProjectPath(folderPath, folder);
  if (!projectPath) return null;
  const sessions = [];
  const indexMtimeMs = getFolderIndexMtimeMs(folderPath);

  for (const { filePath, parentSessionId } of enumerateSessionFiles(folderPath)) {
    try {
      const s = readSessionFile(filePath, folder, projectPath, { parentSessionId });
      if (s) sessions.push(s);
    } catch {}
  }

  return { folder, projectPath, sessions, indexMtimeMs };
}

// Scan all folders, streaming one message per folder as soon as it's read
// instead of buffering every folder into one `results` array and posting a
// single message at the very end. A large ~/.claude/projects/ (1GB+,
// witnessed live) took many minutes to fully scan, during which the caller
// (session-cache.js) had nothing to write to the DB or push to the renderer
// \u2014 the sidebar showed a bare "Loading\u2026" the whole time. Streaming lets the
// caller write + notify after every folder instead.
try {
  const folders = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name !== '.git')
    .map(d => d.name);

  for (let i = 0; i < folders.length; i++) {
    const result = readFolderFromFilesystem(folders[i]);
    parentPort.postMessage({ type: 'folder', result, current: i + 1, total: folders.length });
  }
  parentPort.postMessage({ type: 'done', ok: true, total: folders.length });
} catch (err) {
  parentPort.postMessage({ type: 'done', ok: false, error: err.message });
}
