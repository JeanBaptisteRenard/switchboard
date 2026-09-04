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
 * That fallback is a known, accepted gap, not a fixed one: a symlink whose
 * target does not exist yet resolves to `null` here, so a guard built on top
 * of this function falls back to validating the literal (unresolved) string
 * — the same string a symlink could still point outside the allowed root
 * from once something is created at the far end. It is safe in this
 * codebase's current callers only because they separately require the
 * target to already exist (`fs.existsSync`) before reading or writing it,
 * which fails the same way for a dangling link. A future caller that skips
 * that existence check, or that races a concurrent process creating the
 * target between the two calls, would reopen it.
 *
 * Whether or not that fallback fires, the caller MUST perform its eventual
 * read/write on the value a guard built on this function *returns* (its
 * resolved path), never on a path the caller re-derives with its own
 * `path.resolve(filePath)` afterwards. Two independent resolutions of the
 * same literal string are two independent chances for an in-between symlink
 * swap to point them at different places — the classic TOCTOU shape. A
 * single resolution, reused, cannot diverge from itself.
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
