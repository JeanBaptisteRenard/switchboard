// terminal-input.js — see docs/automation.md ("Politeness")
'use strict';

const { noteUserInput } = require('./composer-state');
const { writePty } = require('./pty-ops');

/**
 * Handle one chunk of renderer keystrokes for `sessionId`.
 *
 * @param {Map} activeSessions
 * @param {string} sessionId
 * @param {string|Buffer} data
 * @param {number} now  epoch ms
 */
function handleTerminalInput(activeSessions, sessionId, data, now) {
  const session = activeSessions.get(sessionId);
  if (session && !session.exited) {
    if (session.composerState) noteUserInput(session.composerState, data, now);
    writePty(session, data, sessionId);
  }
}

module.exports = { handleTerminalInput };
