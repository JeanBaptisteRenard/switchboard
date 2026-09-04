// pre-launch-cmd-guard.js — validation for sessionOptions.preLaunchCmd
// (open-terminal IPC). preLaunchCmd is raw shell by design (e.g. "aws-vault
// exec profile --"), concatenated in front of the claude invocation before
// the whole line is handed to a real shell. An enumerated blacklist of shell
// metacharacters cannot be exhaustive across bash/zsh/fish/nu/cmd.exe/
// PowerShell at once (process substitution <(...) / >(...) was one gap,
// found by execution, not the last one that shape of check could have). An
// allowlist of the character set the documented prefix actually needs closes
// the whole class instead of the one construct that got caught.
// See .ai/contexts/ipc-bridge.md for the per-category rationale.
'use strict';

const ALLOWED_PATTERN = /^[A-Za-z0-9 _\-./\\:=]*$/;

/**
 * @param {string} pre - Raw preLaunchCmd value from sessionOptions.
 * @returns {{ok: true} | {ok: false, error: string}}
 */
function validatePreLaunchCmd(pre) {
  if (!ALLOWED_PATTERN.test(pre)) {
    return {
      ok: false,
      error: 'preLaunchCmd may only contain letters, digits, spaces, and - _ . / \\ : = '
        + '(covers prefixes like "aws-vault exec profile --", "env VAR=val", "doas", or an absolute binary path)',
    };
  }
  return { ok: true };
}

module.exports = { validatePreLaunchCmd };
