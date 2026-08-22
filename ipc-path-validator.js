// ipc-path-validator.js — path validation helpers for IPC file-access handlers.
//
// Two layers of defense:
//   1. isSensitivePath   — denylist for well-known credential / secret files.
//      Used by the file-panel handlers (read-file-for-panel, save-file-for-panel,
//      watch-file) which intentionally accept arbitrary project paths (OSC 8
//      hyperlinks from terminal output). Blocking a static denylist is lighter
//      than allowlisting because the legitimate surface is unbounded.
//
//   2. isAllowedMemoryPath — strict allowlist for memory handlers
//      (read-memory, save-memory) that should only touch ~/.claude/ or active
//      project directories.
//
// Both helpers resolve the incoming path (path.resolve) before comparing, so
// ../traversal sequences are normalised before any check fires.

'use strict';

const os   = require('os');
const path = require('path');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');

// Patterns matching well-known credential / secret file locations.
// A match on the resolved absolute path blocks the operation.
const SENSITIVE_PATH_PATTERNS = [
  /[/\\]\.ssh[/\\]/i,
  /[/\\]\.gnupg[/\\]/i,
  /[/\\]\.aws[/\\]credentials$/i,
  /[/\\]\.env$/i,
  /[/\\]\.env\.local$/i,
  /[/\\]\.netrc$/i,
  /[/\\]\.docker[/\\]config\.json$/i,
  /[/\\]\.kube[/\\]config$/i,
];

/**
 * Returns true when `filePath` resolves to a sensitive credential location.
 *
 * @param {string} filePath - Absolute or relative path from the renderer.
 * @returns {boolean}
 */
function isSensitivePath(filePath) {
  const resolved = path.resolve(filePath);
  return SENSITIVE_PATH_PATTERNS.some(pattern => pattern.test(resolved));
}

/**
 * Returns true when `filePath` is allowed for memory read-write operations.
 *
 * Allowed roots:
 *   - ~/.claude/  (and ~/.claude itself)
 *   - any path in `activeProjectPaths`
 *
 * @param {string}   filePath           - Absolute or relative path from the renderer.
 * @param {string[]} activeProjectPaths - Array of active project root paths.
 * @returns {boolean}
 */
function isAllowedMemoryPath(filePath, activeProjectPaths) {
  const resolved = path.resolve(filePath);

  // Must start with CLAUDE_DIR + sep, or equal CLAUDE_DIR exactly.
  if (resolved === CLAUDE_DIR || resolved.startsWith(CLAUDE_DIR + path.sep)) {
    return true;
  }

  // Must start with an active project path + sep (strict prefix, not a substring).
  for (const projectPath of activeProjectPaths) {
    if (projectPath && resolved.startsWith(projectPath + path.sep)) {
      return true;
    }
  }

  return false;
}

module.exports = { isSensitivePath, isAllowedMemoryPath };
