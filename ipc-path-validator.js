// ipc-path-validator.js — path validation helpers for IPC file-access handlers.
//
// Two layers of defense:
//   1. isSensitivePath   — denylist for well-known credential / secret files.
//      Used by the file-panel handlers (read-file-for-panel, save-file-for-panel,
//      watch-file) which intentionally accept arbitrary project paths (OSC 8
//      hyperlinks from terminal output). Blocking a static denylist is lighter
//      than allowlisting because the legitimate surface is unbounded.
//
//   2. resolveAllowedMemoryPath — strict allowlist for memory handlers
//      (read-memory, save-memory) that should only touch ~/.claude/ or active
//      project directories. Returns the resolved path (or null), not a
//      boolean: the caller's read/write MUST run against that returned
//      value, never against a path it re-derives itself, or the disk
//      resolution this function did is moot. isAllowedMemoryPath is the
//      boolean form, for callers that only need the yes/no answer.
//
//   3. isKnownProjectRoot — exact-match check used by the worktree handlers
//      (delete-worktree, worktree-status), whose regex only validates the
//      *shape* of a path, not that it points at a project this install has
//      ever heard of.
//
// All three also resolve on disk (resolveOnDisk) when the target exists, and
// check that resolved location too — path.resolve() alone does not survive a
// symlink. See .ai/contexts/ipc-bridge.md, "IPC path-guard inventory".

'use strict';

const os   = require('os');
const path = require('path');
const { resolveOnDisk } = require('./resolve-path-on-disk');

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
  if (SENSITIVE_PATH_PATTERNS.some(pattern => pattern.test(resolved))) return true;

  // Also test the on-disk real path: a symlink (e.g. a "notes" directory that
  // is actually a link to ~/.ssh) makes the literal string look harmless
  // while the file it opens is not. Skipped when nothing exists there yet —
  // see the file header.
  const real = resolveOnDisk(resolved);
  if (real && real !== resolved) {
    return SENSITIVE_PATH_PATTERNS.some(pattern => pattern.test(real));
  }
  return false;
}

/**
 * Returns the resolved, allowed path when `filePath` is allowed for memory
 * read-write operations, or `null` when it is not.
 *
 * Allowed roots:
 *   - ~/.claude/  (and ~/.claude itself)
 *   - any path in `activeProjectPaths`
 *
 * The caller MUST perform its filesystem operation on the returned string,
 * not on its own `path.resolve(filePath)` — see the "candidate" comment
 * below and resolve-path-on-disk.js for why re-deriving the path after this
 * check runs reopens the race it closes.
 *
 * @param {string}   filePath           - Absolute or relative path from the renderer.
 * @param {string[]} activeProjectPaths - Array of active project root paths.
 * @returns {string|null}
 */
function resolveAllowedMemoryPath(filePath, activeProjectPaths) {
  const resolved = path.resolve(filePath);
  // Prefer the on-disk real path when the target exists: this is what a
  // symlinked directory inside an allowed root (allowed/cache -> /etc) would
  // otherwise hide. Nothing on disk yet (about to be created, or already
  // deleted) means there is no symlink target to defeat the check with, so
  // fall back to the plain resolved string as before — see the "known gap"
  // note in resolve-path-on-disk.js.
  const candidate = resolveOnDisk(resolved) || resolved;

  if (isWithinRoot(candidate, CLAUDE_DIR)) return candidate;

  for (const projectPath of activeProjectPaths) {
    if (projectPath && isWithinRoot(candidate, projectPath)) return candidate;
  }

  return null;
}

/**
 * Boolean form of `resolveAllowedMemoryPath`, for callers that only need a
 * yes/no answer (e.g. `run-schedule-now`'s `isPathAllowed` predicate, which
 * already re-resolves on disk itself before calling in). Callers that go on
 * to read or write the file must use `resolveAllowedMemoryPath` instead and
 * operate on the path it returns.
 *
 * @param {string}   filePath
 * @param {string[]} activeProjectPaths
 * @returns {boolean}
 */
function isAllowedMemoryPath(filePath, activeProjectPaths) {
  return resolveAllowedMemoryPath(filePath, activeProjectPaths) !== null;
}

/**
 * True when `candidatePath` (already resolved) is `rootPath` itself or lies
 * beneath it. `rootPath` is resolved on disk too — with the same fallback —
 * so a root that is itself reached through a symlinked ancestor (a project
 * living behind a mapped/junctioned directory) still compares like-for-like
 * against an already-resolved candidate, instead of failing a prefix check
 * against its own unresolved string.
 */
function isWithinRoot(candidatePath, rootPath) {
  const root = resolveOnDisk(rootPath) || path.resolve(rootPath);
  return candidatePath === root || candidatePath.startsWith(root + path.sep);
}

/**
 * True when `candidatePath` resolves on disk to the same location as one of
 * `knownProjectPaths` — an exact match, not a containment check: a worktree's
 * parent repo either *is* a project root this install knows about, or it
 * isn't.
 *
 * @param {string}   candidatePath
 * @param {string[]} knownProjectPaths
 * @returns {boolean}
 */
function isKnownProjectRoot(candidatePath, knownProjectPaths) {
  const real = resolveOnDisk(candidatePath) || path.resolve(candidatePath);
  for (const known of knownProjectPaths) {
    if (!known) continue;
    const knownReal = resolveOnDisk(known) || path.resolve(known);
    if (real === knownReal) return true;
  }
  return false;
}

module.exports = { isSensitivePath, isAllowedMemoryPath, resolveAllowedMemoryPath, isKnownProjectRoot };
