// pre-launch-cmd-guard.js — validation for sessionOptions.preLaunchCmd
// (open-terminal IPC). preLaunchCmd is raw shell by design (e.g. "aws-vault
// exec profile --"); this blocks statement separators and command
// substitution without breaking that case. See PR description for the
// per-character rationale.
'use strict';

// Separators (; & |), command substitution (` and $(), and newlines.
const BLOCKED_PATTERN = /[\r\n;&|`]|\$\(/;

/**
 * @param {string} pre - Raw preLaunchCmd value from sessionOptions.
 * @returns {{ok: true} | {ok: false, error: string}}
 */
function validatePreLaunchCmd(pre) {
  if (BLOCKED_PATTERN.test(pre)) {
    return { ok: false, error: 'preLaunchCmd must not contain command separators (; & |), backticks, or $(...) substitution' };
  }
  return { ok: true };
}

module.exports = { validatePreLaunchCmd };
