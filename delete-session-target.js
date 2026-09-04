// delete-session-target.js — validation and target resolution for session deletion.
//
// Extracted from the delete-session IPC handler so the guards on the only
// data-destroying action in the app can be executed by tests against real
// paths and real symlinks, rather than asserted by regex-matching main.js.
// Same rationale and shape as ipc-path-validator.js.
//
// Two guards, both of which must hold before anything is removed:
//   1. isValidSessionId  — the id is used as a filename component under
//      PROJECTS_DIR and nowhere else, so it must not be able to carry a path,
//      a separator, or a dot segment.
//   2. isInsideDir       — every target is realpath'd (via resolveOnDisk, see
//      resolve-path-on-disk.js) and required to remain inside PROJECTS_DIR,
//      so a symlinked transcript cannot be used to make this delete something
//      elsewhere on disk.

'use strict';

const fs = require('fs');
const path = require('path');
const { resolveOnDisk, isInsideDir } = require('./resolve-path-on-disk');

/** A session id may only be a plain filename component. */
function isValidSessionId(id) {
  if (typeof id !== 'string' || id === '') return false;
  if (id === '.' || id === '..') return false;
  return /^[A-Za-z0-9._-]+$/.test(id);
}

/**
 * Resolve what deleting `sessionId` should remove.
 *
 * Looks for `<folder>/<id>.jsonl` (the transcript) and `<folder>/<id>/` (the
 * sibling directory holding subagent transcripts, which belong to the same
 * conversation). `preferredFolder` short-circuits the directory scan — the
 * caller passes the cached folder so the common case is O(1) rather than a
 * readdir of every project.
 *
 * Returns realpath'd targets that are confined to `projectsDir`, plus any that
 * resolved outside it so the caller can log a refusal instead of silently
 * skipping.
 */
function resolveDeletionTargets(projectsDir, sessionId, preferredFolder = null) {
  if (!isValidSessionId(sessionId)) {
    return { ok: false, error: 'invalid session id', targets: [], refused: [] };
  }

  let root;
  try {
    root = fs.realpathSync(projectsDir);
  } catch (err) {
    return { ok: false, error: `cannot read projects directory: ${err.message}`, targets: [], refused: [] };
  }

  let folders;
  if (preferredFolder) {
    folders = [preferredFolder];
  } else {
    try {
      folders = fs.readdirSync(projectsDir);
    } catch (err) {
      return { ok: false, error: `cannot read projects directory: ${err.message}`, targets: [], refused: [] };
    }
  }

  const targets = [];
  const refused = [];
  for (const folder of folders) {
    const base = path.join(projectsDir, folder);
    for (const candidate of [path.join(base, sessionId + '.jsonl'), path.join(base, sessionId)]) {
      if (!fs.existsSync(candidate)) continue;
      const real = resolveOnDisk(candidate);
      if (!real) continue;
      if (!isInsideDir(real, root)) {
        refused.push({ path: candidate, real, reason: 'resolves outside the projects directory' });
        continue;
      }
      if (!targets.includes(real)) targets.push(real);
    }
  }

  return { ok: true, targets, refused };
}

module.exports = { isValidSessionId, isInsideDir, resolveDeletionTargets };
