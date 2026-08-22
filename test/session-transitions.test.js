const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sessionTransitions = require('../session-transitions');
const { detectSubagentTransitions, init } = sessionTransitions;

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-st-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Build a mock mainWindow that records every webContents.send call. */
function makeMockWindow() {
  const events = [];
  return {
    isDestroyed: () => false,
    webContents: {
      send: (channel, payload) => events.push({ channel, payload }),
    },
    _events: events,
  };
}

/** Initialize the module with mocks. Returns the recorded-events array. */
function setupModule() {
  const win = makeMockWindow();
  init({
    PROJECTS_DIR: '/unused',
    activeSessions: new Map(),
    getMainWindow: () => win,
    log: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
    rekeyMcpServer: () => {},
  });
  return win._events;
}

/** Create N agent jsonl files under <folder>/<sessionId>/subagents/ and
 *  set their mtimes to (now - ageMs). Returns the subagents dir. */
function seedAgents(folder, sessionId, agents) {
  const subDir = path.join(folder, sessionId, 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  for (const { id, ageMs = 0, content = '' } of agents) {
    const filePath = path.join(subDir, `agent-${id}.jsonl`);
    fs.writeFileSync(filePath, content, 'utf8');
    if (ageMs) {
      const t = (Date.now() - ageMs) / 1000;
      fs.utimesSync(filePath, t, t);
    }
  }
  return subDir;
}

test('bootstrap call with 5 pre-existing subagents: old agents silent, fresh agents get synthetic spawn', () => {
  // Updated for Fix 2: looksAlive bootstrap files now emit subagent-spawned
  // with _bootstrap:true so the renderer can track their lifecycle. Old
  // agents (>60s) stay silent to avoid flooding on startup.
  const events = setupModule();
  const tmp = mkTmp();
  try {
    const sessionId = 'parent-session';
    // 3 fresh (looksAlive) + 2 old (completed-at-boot)
    seedAgents(tmp, sessionId, [
      { id: 'a1', ageMs: 120_000 }, // 2 min old — silent
      { id: 'a2', ageMs: 120_000 }, // 2 min old — silent
      { id: 'a3', ageMs: 5_000 },   // fresh — gets synthetic spawn
      { id: 'a4', ageMs: 5_000 },   // fresh — gets synthetic spawn
      { id: 'a5', ageMs: 5_000 },   // fresh — gets synthetic spawn
    ]);

    const session = {}; // knownSubagents undefined → bootstrap
    detectSubagentTransitions(sessionId, session, tmp);

    assert.equal(events.length, 3, 'exactly 3 synthetic spawns for fresh bootstrap agents');
    for (const ev of events) {
      assert.equal(ev.channel, 'subagent-spawned');
      assert.equal(ev.payload._bootstrap, true, 'bootstrap spawn must carry _bootstrap flag');
    }
    assert.ok(session.knownSubagents instanceof Map);
    assert.equal(session.knownSubagents.size, 5);
  } finally {
    cleanup(tmp);
  }
});

test('bootstrap marks an old-mtime agent (>60s) as completed: true', () => {
  const events = setupModule();
  const tmp = mkTmp();
  try {
    const sessionId = 'parent';
    seedAgents(tmp, sessionId, [{ id: 'oldie', ageMs: 120_000 }]); // 2 minutes old

    const session = {};
    detectSubagentTransitions(sessionId, session, tmp);

    assert.equal(events.length, 0);
    const entry = session.knownSubagents.get('oldie');
    assert.ok(entry, 'expected an entry for oldie');
    assert.equal(entry.completed, true);
    assert.ok(entry._completedAt, 'expected _completedAt to be stamped');
  } finally {
    cleanup(tmp);
  }
});

test('bootstrap marks a fresh-mtime agent as completed: false and emits synthetic spawn', () => {
  // Fix 2: fresh bootstrap files now emit subagent-spawned with _bootstrap:true.
  const events = setupModule();
  const tmp = mkTmp();
  try {
    const sessionId = 'parent';
    seedAgents(tmp, sessionId, [{ id: 'fresh', ageMs: 5_000 }]); // 5s old, well under 60s

    const session = {};
    detectSubagentTransitions(sessionId, session, tmp);

    assert.equal(events.length, 1, 'bootstrap emits exactly 1 synthetic spawn for fresh agent');
    assert.equal(events[0].channel, 'subagent-spawned');
    assert.equal(events[0].payload._bootstrap, true);
    assert.equal(events[0].payload.agentId, 'fresh');
    const entry = session.knownSubagents.get('fresh');
    assert.ok(entry);
    assert.equal(entry.completed, false);
    assert.equal(entry._completedAt, null);
  } finally {
    cleanup(tmp);
  }
});

test('post-bootstrap: a brand-new agent file emits exactly one subagent-spawned event', () => {
  const events = setupModule();
  const tmp = mkTmp();
  try {
    const sessionId = 'parent';
    // First, bootstrap with empty subagents dir
    fs.mkdirSync(path.join(tmp, sessionId, 'subagents'), { recursive: true });
    const session = {};
    detectSubagentTransitions(sessionId, session, tmp);
    assert.equal(events.length, 0);
    assert.equal(session.knownSubagents.size, 0);

    // Now drop in a new agent file and re-run
    seedAgents(tmp, sessionId, [{ id: 'newcomer' }]);
    detectSubagentTransitions(sessionId, session, tmp);

    assert.equal(events.length, 1, `expected 1 event, got ${events.length}`);
    assert.equal(events[0].channel, 'subagent-spawned');
    assert.equal(events[0].payload.parentSessionId, sessionId);
    assert.equal(events[0].payload.agentId, 'newcomer');
    assert.equal(session.knownSubagents.get('newcomer').completed, false);
  } finally {
    cleanup(tmp);
  }
});

test('post-bootstrap with no new agents emits no additional events (IPC-flood regression)', () => {
  // Fix 2: bootstrap for fresh (ageMs:0) agents now emits synthetic spawns.
  // The regression guard is that *subsequent* flushes with no new files must
  // not re-emit — the event count must not increase after the first call.
  const events = setupModule();
  const tmp = mkTmp();
  try {
    const sessionId = 'parent';
    // Use old agents (ageMs > 60s) so bootstrap stays silent — keeps the
    // test focused purely on the "no subsequent events" regression.
    seedAgents(tmp, sessionId, [
      { id: 'a', ageMs: 120_000 },
      { id: 'b', ageMs: 120_000 },
      { id: 'c', ageMs: 120_000 },
    ]);

    const session = {};
    // Bootstrap absorbs all three silently (all old → no synthetic spawns)
    detectSubagentTransitions(sessionId, session, tmp);
    assert.equal(events.length, 0, 'old-agent bootstrap must be silent');

    // Subsequent flushes with no new files must stay silent
    detectSubagentTransitions(sessionId, session, tmp);
    detectSubagentTransitions(sessionId, session, tmp);
    detectSubagentTransitions(sessionId, session, tmp);

    assert.equal(events.length, 0, 'no events should fire when nothing changed');
  } finally {
    cleanup(tmp);
  }
});

test('completion: agent with stable mtime for >30s emits subagent-completed (driven via fake Date clock)', (t) => {
  const events = setupModule();
  const tmp = mkTmp();
  try {
    const sessionId = 'parent';
    // Create the agent file aged >60s so bootstrap records it as not-yet-completed
    // (i.e. looksAlive=false path is too old — we want an agent that is first spotted
    // post-bootstrap so its full lifecycle plays out).
    // Seed with ageMs=0 so looksAlive=true; bootstrap will emit synthetic spawn.
    const subDir = seedAgents(tmp, sessionId, [{ id: 'slow', ageMs: 0 }]);
    const filePath = path.join(subDir, 'agent-slow.jsonl');

    // Call 1: bootstrap — knownSubagents is created, synthetic spawn emitted,
    //         agent entry stored with completed:false and no _stableStart yet.
    const session = {};
    // Enable fake Date with now=realNow so _stableStart gets a non-zero truthy value
    // (the stability timer check uses !known._stableStart which would be truthy for 0/epoch).
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });

    detectSubagentTransitions(sessionId, session, tmp);
    // Bootstrap emits one synthetic spawn for this fresh agent
    assert.equal(events.filter(e => e.channel === 'subagent-spawned').length, 1);
    assert.equal(session.knownSubagents.get('slow').completed, false);

    // Call 2: mtime unchanged from call 1 → _stableStart is set to "now"
    detectSubagentTransitions(sessionId, session, tmp);
    assert.equal(session.knownSubagents.get('slow').completed, false);

    // Advance the fake clock 31 seconds — well past the 30s STABLE_MS threshold
    t.mock.timers.tick(31_000);

    // Call 3: mtime still unchanged, _stableStart was set 31s ago → completion fires
    detectSubagentTransitions(sessionId, session, tmp);

    const completions = events.filter(e => e.channel === 'subagent-completed');
    assert.equal(completions.length, 1, `expected 1 completion event, got ${events.length}: ${JSON.stringify(events)}`);
    assert.equal(completions[0].channel, 'subagent-completed');
    assert.equal(completions[0].payload.parentSessionId, sessionId);
    assert.equal(completions[0].payload.agentId, 'slow');
    assert.equal(session.knownSubagents.get('slow').completed, true);
  } finally {
    t.mock.timers.reset();
    cleanup(tmp);
  }
});

test('heartbeat: a subagent whose file keeps growing re-emits subagent-spawned (throttled to 20s), so the renderer TTL never evicts a live agent', (t) => {
  // The renderer keeps a 60s liveness TTL per agent (sidebar.js
  // pruneStaleSubagents). Before the heartbeat, that timestamp was only ever
  // set at spawn — any agent running longer than a minute was evicted and
  // the parent's has-busy-agents indicator went dark while the agent still
  // worked. Now every mtime advance re-emits an idempotent subagent-spawned
  // (payload._heartbeat) at most every HEARTBEAT_MS (20s), which the
  // renderer's existing spawn handler turns into a fresh last-seen stamp.
  const events = setupModule();
  const tmp = mkTmp();
  try {
    const sessionId = 'parent';
    const subDir = seedAgents(tmp, sessionId, [{ id: 'longrun', ageMs: 0 }]);
    const filePath = path.join(subDir, 'agent-longrun.jsonl');
    const realBaseMs = fs.statSync(filePath).mtimeMs;
    let bump = 0;
    const bumpMtime = () => {
      bump += 1;
      const d = new Date(realBaseMs + bump * 2000);
      fs.utimesSync(filePath, d, d);
    };
    const heartbeats = () => events.filter(e => e.channel === 'subagent-spawned' && e.payload._heartbeat);

    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });

    // Call 1: bootstrap — synthetic spawn, heartbeat clock starts.
    const session = {};
    detectSubagentTransitions(sessionId, session, tmp);
    assert.equal(heartbeats().length, 0, 'no heartbeat at bootstrap');

    // 25s later the file has grown → past the 20s throttle → heartbeat.
    t.mock.timers.tick(25_000);
    bumpMtime();
    detectSubagentTransitions(sessionId, session, tmp);
    assert.equal(heartbeats().length, 1, 'file grew 25s after spawn — one heartbeat');
    assert.equal(heartbeats()[0].payload.parentSessionId, sessionId);
    assert.equal(heartbeats()[0].payload.agentId, 'longrun');

    // Only 5s later, another write — still inside the 20s throttle window.
    t.mock.timers.tick(5_000);
    bumpMtime();
    detectSubagentTransitions(sessionId, session, tmp);
    assert.equal(heartbeats().length, 1, 'writes within 20s of the last heartbeat are throttled');

    // 20s more → next write heartbeats again.
    t.mock.timers.tick(20_000);
    bumpMtime();
    detectSubagentTransitions(sessionId, session, tmp);
    assert.equal(heartbeats().length, 2, 'throttle window elapsed — second heartbeat');

    // File stops growing: NO heartbeat on the stable path (the orphan safety
    // net is unchanged — silence leads to completion or renderer TTL prune).
    detectSubagentTransitions(sessionId, session, tmp); // stable call — arms _stableStart
    t.mock.timers.tick(31_000);
    detectSubagentTransitions(sessionId, session, tmp); // stability elapsed — completes
    assert.equal(heartbeats().length, 2, 'a stable (non-growing) file must not heartbeat');
    const completions = events.filter(e => e.channel === 'subagent-completed');
    assert.equal(completions.length, 1, 'the normal 30s-stability completion still fires');
    assert.equal(session.knownSubagents.get('longrun').completed, true);
  } finally {
    t.mock.timers.reset();
    cleanup(tmp);
  }
});

// BT6 — concurrent session monitoring: 2 sessions no cross-contamination
test('concurrent monitoring: detectSubagentTransitions for 2 distinct sessions emits independent events with no cross-contamination', () => {
  const events = setupModule();
  const tmp = mkTmp();
  try {
    const sessionA = 'session-alpha';
    const sessionB = 'session-beta';

    // Seed session A with 2 agents, session B with 1 agent (different ids)
    seedAgents(tmp, sessionA, [{ id: 'a-worker-1' }, { id: 'a-worker-2' }]);
    seedAgents(tmp, sessionB, [{ id: 'b-worker-1' }]);

    const sessA = {};
    const sessB = {};

    // Bootstrap both sessions
    detectSubagentTransitions(sessionA, sessA, tmp);
    detectSubagentTransitions(sessionB, sessB, tmp);

    // Both sessions should have their own independent knownSubagents maps
    assert.ok(sessA.knownSubagents instanceof Map, 'sessA must have knownSubagents');
    assert.ok(sessB.knownSubagents instanceof Map, 'sessB must have knownSubagents');

    assert.equal(sessA.knownSubagents.size, 2, 'sessA should know 2 agents');
    assert.equal(sessB.knownSubagents.size, 1, 'sessB should know 1 agent');

    // No cross-contamination: sessA has no knowledge of B's agent, and vice-versa
    assert.ok(!sessA.knownSubagents.has('b-worker-1'), 'sessA must not know about b-worker-1');
    assert.ok(!sessB.knownSubagents.has('a-worker-1'), 'sessB must not know about a-worker-1');
    assert.ok(!sessB.knownSubagents.has('a-worker-2'), 'sessB must not know about a-worker-2');

    // Add a new agent to session A only — should NOT appear in session B.
    // Busy-wait a few ms to ensure the filesystem mtime of the subagents dir
    // advances past the value cached during bootstrap, so dirChanged=true.
    const waitUntil = Date.now() + 5;
    while (Date.now() < waitUntil) { /* spin */ }
    seedAgents(tmp, sessionA, [{ id: 'a-worker-new' }]);
    detectSubagentTransitions(sessionA, sessA, tmp);
    detectSubagentTransitions(sessionB, sessB, tmp);

    const spawnedForA = events.filter(
      e => e.channel === 'subagent-spawned' && e.payload.parentSessionId === sessionA
    );
    const spawnedForB = events.filter(
      e => e.channel === 'subagent-spawned' && e.payload.parentSessionId === sessionB
    );

    // The new a-worker-new event must carry sessionA's parentSessionId
    const newWorkerEvent = spawnedForA.find(e => e.payload.agentId === 'a-worker-new');
    assert.ok(newWorkerEvent, 'expected subagent-spawned for a-worker-new under sessionA');
    assert.equal(newWorkerEvent.payload.parentSessionId, sessionA);

    // Session B should not have been notified about a-worker-new
    const bHasNewWorker = spawnedForB.some(e => e.payload.agentId === 'a-worker-new');
    assert.ok(!bHasNewWorker, 'sessB must not receive spawn events for sessA agents');

    // Fresh workers from bootstrap emit with _bootstrap:true; the new post-bootstrap
    // agent for sessA must NOT carry _bootstrap:true
    assert.ok(!newWorkerEvent.payload._bootstrap, 'post-bootstrap spawn must not carry _bootstrap flag');
  } finally {
    cleanup(tmp);
  }
});

/** Init the module with a capturing log and a caller-owned activeSessions map. */
function setupForkDetection(projectsDir) {
  const win = makeMockWindow();
  const activeSessions = new Map();
  const logLines = [];
  const capture = (...args) => logLines.push(args.join(' '));
  init({
    PROJECTS_DIR: projectsDir,
    activeSessions,
    getMainWindow: () => win,
    log: { info: capture, debug: capture, warn: capture, error: capture },
    rekeyMcpServer: () => {},
  });
  return { events: win._events, activeSessions, logLines };
}

function makePtySession(folder, overrides = {}) {
  return {
    exited: false, isPlainTerminal: false, projectFolder: folder,
    knownJsonlFiles: new Set(), forkFrom: null, realSessionId: null,
    ...overrides,
  };
}

test('fork detection: new jsonl with matching forkedFrom re-keys the session and notifies the renderer', () => {
  const tmp = mkTmp();
  try {
    const folder = 'proj';
    fs.mkdirSync(path.join(tmp, folder), { recursive: true });
    const { events, activeSessions } = setupForkDetection(tmp);
    activeSessions.set('old-id', makePtySession(folder));

    fs.writeFileSync(
      path.join(tmp, folder, 'new-id.jsonl'),
      JSON.stringify({ forkedFrom: { sessionId: 'old-id' }, type: 'user' }) + '\n',
      'utf8'
    );
    sessionTransitions.detectSessionTransitions(folder);

    assert.ok(!activeSessions.has('old-id'), 'old key removed after re-key');
    const session = activeSessions.get('new-id');
    assert.ok(session, 'session re-keyed under the new jsonl id');
    assert.equal(session.realSessionId, 'new-id');
    assert.ok(session.knownJsonlFiles.has('new-id.jsonl'), 'known files updated to current set');
    const forked = events.find(e => e.channel === 'session-forked');
    assert.equal(forked.payload, 'old-id', 'renderer notified with the original id');
  } finally {
    cleanup(tmp);
  }
});

test('fork detection: forkFrom session logs NO MATCH for an unrelated new jsonl and is not re-keyed', () => {
  const tmp = mkTmp();
  try {
    const folder = 'proj';
    fs.mkdirSync(path.join(tmp, folder), { recursive: true });
    const { activeSessions, logLines } = setupForkDetection(tmp);
    activeSessions.set('pty-id', makePtySession(folder, { forkFrom: 'source-id' }));

    fs.writeFileSync(
      path.join(tmp, folder, 'other.jsonl'),
      JSON.stringify({ sessionId: 'unrelated', type: 'user' }) + '\n',
      'utf8'
    );
    sessionTransitions.detectSessionTransitions(folder);

    assert.ok(activeSessions.has('pty-id'), 'session keeps its original key');
    assert.equal(activeSessions.get('pty-id').realSessionId, null);
    assert.ok(logLines.some(l => l.includes('NO MATCH')), 'the no-match path was taken and logged');
  } finally {
    cleanup(tmp);
  }
});

test('fork detection: an unreadable .jsonl entry is treated as signal-less and rechecked next cycle', () => {
  const tmp = mkTmp();
  try {
    const folder = 'proj';
    fs.mkdirSync(path.join(tmp, folder), { recursive: true });
    const { activeSessions } = setupForkDetection(tmp);
    activeSessions.set('pty-id', makePtySession(folder));

    // A directory named *.jsonl makes readNewSessionSignals hit its catch path
    fs.mkdirSync(path.join(tmp, folder, 'weird.jsonl'));
    sessionTransitions.detectSessionTransitions(folder);

    assert.ok(activeSessions.has('pty-id'), 'session untouched');
    assert.ok(
      !activeSessions.get('pty-id').knownJsonlFiles.has('weird.jsonl'),
      'signal-less file excluded from known set so it is rechecked next cycle'
    );
  } finally {
    cleanup(tmp);
  }
});
