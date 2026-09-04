// resolve-path-on-disk.js — resolves a path to its real, symlink-free
// location on disk. See .ai/contexts/ipc-bridge.md, "IPC path-guard
// inventory", for why every path guard needs this and not just path.resolve().
'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Resolve `filePath` to its real, symlink-free location on disk.
 *
 * Returns `null` when the path (or any component of it) does not exist
 * (ENOENT), when resolution hits a symlink loop (ELOOP), or on any other
 * filesystem error — callers that must also accept a path which may
 * legitimately not exist yet (e.g. a file about to be created) are expected
 * to fall back to `path.resolve(filePath)` themselves in that case, the same
 * way they did before this primitive existed.
 *
 * @param {string} filePath
 * @returns {string|null}
 */
function resolveOnDisk(filePath) {
  try {
    return fs.realpathSync(path.resolve(filePath));
  } catch {
    return null;
  }
}

/**
 * True when `child` is `parent` itself or lies beneath it.
 *
 * Compares with a trailing separator so a sibling directory sharing a prefix
 * (…/projects-evil next to …/projects) does not satisfy the check. Does not
 * resolve on disk itself — pass already-resolved paths in from `resolveOnDisk`
 * when the containment check needs to survive symlinks.
 *
 * @param {string} child
 * @param {string} parent
 * @returns {boolean}
 */
function isInsideDir(child, parent) {
  if (!child || !parent) return false;
  const c = path.resolve(child);
  const p = path.resolve(parent);
  return c === p || c.startsWith(p + path.sep);
}

module.exports = { resolveOnDisk, isInsideDir };
