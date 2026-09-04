// run-schedule-now-target.js — validation and target resolution for the
// run-schedule-now IPC action. Electron-free so it can be tested directly.
// See .ai/contexts/ipc-bridge.md, "IPC path-guard inventory".
'use strict';

const path = require('path');
const { resolveOnDisk } = require('./resolve-path-on-disk');

const SCHEDULE_FILENAME_RE = /^schedule-.*\.md$/i;

/**
 * Resolve and validate the file `run-schedule-now` was asked to run.
 *
 * @param {string}   filePath      - Path from the renderer, unvalidated.
 * @param {function} isPathAllowed - (resolvedPath: string) => boolean
 * @returns {{ok: true, realPath: string, projectPath: string} | {ok: false, error: string}}
 */
function resolveRunNowTarget(filePath, isPathAllowed) {
  if (typeof filePath !== 'string' || !filePath) {
    return { ok: false, error: 'invalid path' };
  }

  const real = resolveOnDisk(filePath);
  if (!real) {
    return { ok: false, error: 'file not found' };
  }

  if (!SCHEDULE_FILENAME_RE.test(path.basename(real))) {
    return { ok: false, error: 'not a schedule file' };
  }

  const commandsDir = path.dirname(real);
  const dotClaudeDir = path.dirname(commandsDir);
  const projectPath = path.dirname(dotClaudeDir);

  if (path.basename(commandsDir) !== 'commands' || path.basename(dotClaudeDir) !== '.claude') {
    return { ok: false, error: 'not inside a project .claude/commands directory' };
  }

  if (typeof isPathAllowed !== 'function' || !isPathAllowed(real)) {
    return { ok: false, error: 'path not allowed' };
  }

  return { ok: true, realPath: real, projectPath };
}

module.exports = { resolveRunNowTarget };
