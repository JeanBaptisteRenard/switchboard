// trigger-context.js — see .ai/contexts/trigger-watcher.md
'use strict';

/**
 * Build the `ctx` object trigger-watcher's `start(ctx)` expects.
 *
 * @param {object} deps
 * @param {Map} deps.activeSessions
 * @param {object} deps.log  electron-log compatible logger
 * @param {function} [deps.isPtyAlive]  (ptyProcess) => boolean
 * @returns {object} ctx
 */
function createTriggerContext({ activeSessions, log, isPtyAlive }) {
  const ctx = {
    log,
    getPtyForSession(sessionId) {
      const session = activeSessions.get(sessionId);
      if (!session || session.exited) return null;
      return { ptyProcess: session.pty };
    },
    isSessionBusy(sessionId) {
      const session = activeSessions.get(sessionId);
      return session ? !!session._cliBusy : false;
    },
    getComposerState(sessionId) {
      const session = activeSessions.get(sessionId);
      if (!session || session.exited || !session.composerState) return null;
      const { pending, lastInputAt } = session.composerState;
      return { pending, lastInputAt };
    },
  };
  if (isPtyAlive) ctx.isPtyAlive = isPtyAlive;
  return ctx;
}

module.exports = { createTriggerContext };
