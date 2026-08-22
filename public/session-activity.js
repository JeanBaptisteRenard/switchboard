// Session activity state — busy / response-ready / attention.
// See .ai/contexts/ipc-bridge.md "Busy-state reconciliation".

const attentionSessions = new Set(); // sessions needing user action (OSC 9)
const responseReadySessions = new Set(); // Claude finished, user hasn't looked (terminal state)
const sessionBusyState = new Map(); // sessionId → boolean (currently active)

// Monotonic transition counter, plus its value at each session's last change.
let activitySeq = 0;
const activitySeqBySession = new Map();

function currentActivitySeq() {
  return activitySeq;
}

// Called from updateRunningIndicators() when a session leaves activePtyIds,
// next to the purge of the three collections above.
function forgetActivitySeq(sessionId) {
  activitySeqBySession.delete(sessionId);
}

function sessionItemEl(sessionId) {
  return document.querySelector(`.session-item[data-session-id="${sessionId}"]`);
}

// The only writer of .cli-busy and .response-ready — they are mutually exclusive.
function applyActivityClasses(sessionId) {
  const item = sessionItemEl(sessionId);
  if (!item) return;
  const ready = responseReadySessions.has(sessionId);
  item.classList.toggle('response-ready', ready);
  item.classList.toggle('cli-busy', !ready && sessionBusyState.get(sessionId) === true);
}

// Central activity dispatcher
function setActivity(sessionId, active) {
  if (active) {
    responseReadySessions.delete(sessionId);
  } else if (responseReadySessions.has(sessionId)) {
    return;
  }

  const wasActive = sessionBusyState.get(sessionId) || false;
  sessionBusyState.set(sessionId, active);
  activitySeq += 1;
  activitySeqBySession.set(sessionId, activitySeq);

  if (wasActive && !active && sessionId !== activeSessionId) {
    responseReadySessions.add(sessionId);
  }

  applyActivityClasses(sessionId);
}

function clearUnread(sessionId) {
  responseReadySessions.delete(sessionId);
  applyActivityClasses(sessionId);
}

// Carry the activity state across a session-detected / session-forked re-key.
function rekeyActivityState(oldId, newId) {
  if (oldId === newId) return;
  const oldItem = sessionItemEl(oldId);
  if (oldItem) oldItem.classList.remove('cli-busy', 'response-ready', 'needs-attention');

  if (sessionBusyState.has(oldId)) {
    sessionBusyState.set(newId, sessionBusyState.get(oldId));
    sessionBusyState.delete(oldId);
  }
  if (responseReadySessions.delete(oldId)) responseReadySessions.add(newId);
  if (attentionSessions.delete(oldId)) {
    attentionSessions.add(newId);
    const newItem = sessionItemEl(newId);
    if (newItem) newItem.classList.add('needs-attention');
  }
  const seq = activitySeqBySession.get(oldId);
  if (seq !== undefined) {
    activitySeqBySession.delete(oldId);
    activitySeqBySession.set(newId, seq);
  }

  applyActivityClasses(newId);
}

// Realign against the backend snapshot from get-active-sessions.
// `sinceSeq` is currentActivitySeq() as read before the IPC call.
function reconcileBusyState(entries, sinceSeq) {
  if (!Array.isArray(entries)) return;
  for (const entry of entries) {
    if (!entry || typeof entry.sessionId !== 'string') continue;
    const { sessionId } = entry;
    if (typeof sinceSeq === 'number' && (activitySeqBySession.get(sessionId) || 0) > sinceSeq) continue;
    if (entry.busy === true) {
      if (sessionBusyState.get(sessionId) !== true || responseReadySessions.has(sessionId)) {
        setActivity(sessionId, true);
      }
    } else if (sessionBusyState.get(sessionId) === true) {
      setActivity(sessionId, false);
    }
  }
}
