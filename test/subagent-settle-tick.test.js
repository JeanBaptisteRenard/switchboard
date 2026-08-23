// see .ai/contexts/subagent-observability.md

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { detectSubagentTransitions, init } = require('../session-transitions');

const STABLE_MS = 30000;
const SETTLE_TICK_MS = 5000;
const LIVE_RECHECK_MS = 300000;
const MAX_STABLE_MS = 300000;
const RENDERER_TTL_MS = 60000;
const STABLE_LADDER = [STABLE_MS, 120000, MAX_STABLE_MS];

// The settle tick is armed with a bare setTimeout, so a spy on the global is
// what makes the *arming* observable — asserting on emitted events alone
// cannot tell a disarmed tick from one that re-arms forever doing nothing.
const scheduled = [];
const realSetTimeout = globalThis.setTimeout;
test.before(() => {
  globalThis.setTimeout = (fn, ms) => { scheduled.push({ fn, ms }); return { unref() {} }; };
});
test.after(() => { globalThis.setTimeout = realSetTimeout; });

/** Run every currently-armed timer once. Callbacks may arm new ones. */
function fireTimers() {
  const due = scheduled.splice(0, scheduled.length);
  for (const { fn } of due) fn();
}

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-tick-'));
}

function setMtime(p, ms) {
  const t = ms / 1000;
  fs.utimesSync(p, t, t);
}

/** Init the module and clear any tick left armed by a previous test — the
 *  timer handle lives in module scope, so a leftover would block arming. */
function setup(activeSessions = new Map()) {
  const events = [];
  init({
    PROJECTS_DIR: '/unused',
    activeSessions,
    getMainWindow: () => ({
      isDestroyed: () => false,
      webContents: { send: (channel, payload) => events.push({ channel, payload, at: Date.now() }) },
    }),
    log: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
    rekeyMcpServer: () => {},
  });
  fireTimers();
  scheduled.length = 0;
  return events;
}

/** Re-init with PROJECTS_DIR pointing at tmp so the tick can resolve folders. */
function setupWithProjectsDir(tmp, activeSessions) {
  const events = [];
  init({
    PROJECTS_DIR: tmp,
    activeSessions,
    getMainWindow: () => ({
      isDestroyed: () => false,
      webContents: { send: (channel, payload) => events.push({ channel, payload, at: Date.now() }) },
    }),
    log: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
    rekeyMcpServer: () => {},
  });
  fireTimers();
  scheduled.length = 0;
  return events;
}

function seedLiveAgent(tmp, sessionId, agentId) {
  const subDir = path.join(tmp, sessionId, 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  const filePath = path.join(subDir, `agent-${agentId}.jsonl`);
  fs.writeFileSync(filePath, '', 'utf8');
  setMtime(filePath, Date.now());
  setMtime(subDir, Date.now());
  return filePath;
}

function grow(filePath) {
  fs.appendFileSync(filePath, 'x\n', 'utf8');
  setMtime(filePath, Date.now());
}

test('a subagent that goes quiet completes without any further watcher flush', (t) => {
  // Measured 2026-08-23: agent a9be19fb0a7e0e504 stopped writing at 23:42:18
  // and subagent-completed was only logged at 23:52:55 — the folder went quiet,
  // so the debounced watcher flush that owns the stability clock never ran.
  const tmp = mkTmp();
  const activeSessions = new Map();
  try {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const events = setupWithProjectsDir(tmp, activeSessions);

    const sessionId = 'parent';
    const session = { projectFolder: '.' };
    activeSessions.set(sessionId, session);
    fs.mkdirSync(path.join(tmp, sessionId, 'subagents'), { recursive: true });

    detectSubagentTransitions(sessionId, session, tmp); // bootstrap on empty dir
    seedLiveAgent(tmp, sessionId, 'quiet');
    detectSubagentTransitions(sessionId, session, tmp);
    assert.equal(events.filter(e => e.channel === 'subagent-spawned').length, 1, 'spawn announced');

    // From here nothing writes in the folder, so the watcher never fires again.
    for (let i = 0; i < 10; i++) { t.mock.timers.tick(SETTLE_TICK_MS); fireTimers(); }

    const completions = events.filter(e => e.channel === 'subagent-completed');
    assert.equal(completions.length, 1,
      `completion must fire from the settle tick alone, got ${JSON.stringify(events.map(e => e.channel))}`);
    assert.equal(completions[0].payload.agentId, 'quiet');
  } finally {
    t.mock.timers.reset();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('the settle tick disarms itself once nothing is left to watch', (t) => {
  // Observing events is not enough: a tick that re-armed forever on a settled
  // session would emit nothing and still be the steady-state cost ADR 0002
  // forbids. Assert on the armed timer itself.
  const tmp = mkTmp();
  const activeSessions = new Map();
  try {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    setupWithProjectsDir(tmp, activeSessions);

    const sessionId = 'parent';
    const session = { projectFolder: '.' };
    activeSessions.set(sessionId, session);
    fs.mkdirSync(path.join(tmp, sessionId, 'subagents'), { recursive: true });

    detectSubagentTransitions(sessionId, session, tmp);
    seedLiveAgent(tmp, sessionId, 'short');
    detectSubagentTransitions(sessionId, session, tmp);
    assert.equal(scheduled.length, 1, 'a live agent arms the tick');

    // Drive past completion AND past the recheck window that follows it.
    for (let i = 0; i < 80; i++) { t.mock.timers.tick(SETTLE_TICK_MS); fireTimers(); }

    const known = session.knownSubagents.get('short');
    assert.equal(known.completed, true, 'the agent must have completed');
    assert.equal(known._recheckStart, null, 'its recheck window must have closed');
    assert.equal(scheduled.length, 0,
      'a fully settled session must leave no timer armed');

    // The sweep has a guard of its own, so draining alone cannot tell whether
    // arming is guarded too. Call the scan directly on the settled session:
    // an unguarded armSubagentSettleTick would arm here.
    detectSubagentTransitions(sessionId, session, tmp);
    assert.equal(scheduled.length, 0,
      'scanning a settled session must not arm the tick');
  } finally {
    t.mock.timers.reset();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('the settle tick closes the recheck window of a completed agent in a silent folder', (t) => {
  // A completed-but-still-falsifiable entry is not settled: if the tick ignored
  // it, the window would only ever close on a write to some other file in the
  // same folder, and in a silent folder it would stay open forever.
  const tmp = mkTmp();
  const activeSessions = new Map();
  try {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    setupWithProjectsDir(tmp, activeSessions);

    const sessionId = 'parent';
    const session = { projectFolder: '.' };
    activeSessions.set(sessionId, session);
    fs.mkdirSync(path.join(tmp, sessionId, 'subagents'), { recursive: true });

    detectSubagentTransitions(sessionId, session, tmp);
    seedLiveAgent(tmp, sessionId, 'quiet');
    detectSubagentTransitions(sessionId, session, tmp);

    // Just past completion: the entry is completed but still falsifiable.
    for (let i = 0; i < 10; i++) { t.mock.timers.tick(SETTLE_TICK_MS); fireTimers(); }
    const known = session.knownSubagents.get('quiet');
    assert.equal(known.completed, true);
    assert.notEqual(known._recheckStart, null, 'the window must be open right after completion');
    assert.equal(scheduled.length, 1, 'an open recheck window must keep the tick armed');

    // No watcher event ever arrives; only the tick can close the window.
    for (let i = 0; i < 70; i++) { t.mock.timers.tick(SETTLE_TICK_MS); fireTimers(); }
    assert.equal(session.knownSubagents.get('quiet')._recheckStart, null,
      'the tick alone must close the recheck window');
  } finally {
    t.mock.timers.reset();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a stability completion stays falsifiable well past STABLE_MS', (t) => {
  // Measured 2026-08-23: agents a8e8c25f42a65b026 and a19dcbbb23270de85 were
  // both declared complete while still alive. Tool calls routinely outlast
  // STABLE_MS, so a 30 s recheck window would freeze the entry before the
  // agent's next write — the window has to be sized to the tool call.
  const tmp = mkTmp();
  const events = setup();
  try {
    const sessionId = 'parent';
    fs.mkdirSync(path.join(tmp, sessionId, 'subagents'), { recursive: true });
    const session = {};

    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    detectSubagentTransitions(sessionId, session, tmp);
    const filePath = seedLiveAgent(tmp, sessionId, 'slow');
    detectSubagentTransitions(sessionId, session, tmp);
    detectSubagentTransitions(sessionId, session, tmp); // arms _stableStart
    t.mock.timers.tick(STABLE_MS + 1000);
    detectSubagentTransitions(sessionId, session, tmp); // completed
    assert.equal(events.filter(e => e.channel === 'subagent-completed').length, 1);

    // A pass this far after the completion would close a STABLE_MS-sized window.
    t.mock.timers.tick(STABLE_MS + 1000);
    detectSubagentTransitions(sessionId, session, tmp);

    // The agent was only running a long tool call: it writes again.
    grow(filePath);
    detectSubagentTransitions(sessionId, session, tmp);

    const spawns = events.filter(e => e.channel === 'subagent-spawned');
    assert.equal(spawns.length, 2,
      `the withheld spawn must be re-emitted, got ${JSON.stringify(events.map(e => e.channel))}`);
    assert.equal(spawns[1].payload._heartbeat, undefined,
      'a re-announcement must be a real spawn, not a heartbeat the renderer would ignore');
    assert.equal(session.knownSubagents.get('slow').completed, false);
  } finally {
    t.mock.timers.reset();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('the recheck window closes after LIVE_RECHECK_MS and the entry freezes', (t) => {
  // The window is generous, not unbounded: past it the entry goes back to the
  // zero-cost fast path and a later write can no longer resurrect it.
  const tmp = mkTmp();
  const events = setup();
  try {
    const sessionId = 'parent';
    fs.mkdirSync(path.join(tmp, sessionId, 'subagents'), { recursive: true });
    const session = {};

    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    detectSubagentTransitions(sessionId, session, tmp);
    const filePath = seedLiveAgent(tmp, sessionId, 'slow');
    detectSubagentTransitions(sessionId, session, tmp);
    detectSubagentTransitions(sessionId, session, tmp);
    t.mock.timers.tick(STABLE_MS + 1000);
    detectSubagentTransitions(sessionId, session, tmp); // completed
    const spawnsAtCompletion = events.filter(e => e.channel === 'subagent-spawned').length;

    t.mock.timers.tick(LIVE_RECHECK_MS + 1000);
    detectSubagentTransitions(sessionId, session, tmp);
    assert.equal(session.knownSubagents.get('slow')._recheckStart, null,
      'the window must close once LIVE_RECHECK_MS has elapsed');

    grow(filePath);
    detectSubagentTransitions(sessionId, session, tmp);
    assert.equal(events.filter(e => e.channel === 'subagent-spawned').length, spawnsAtCompletion,
      'a frozen entry must not be re-announced');
  } finally {
    t.mock.timers.reset();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('an agent that never oscillates keeps the plain STABLE_MS window', (t) => {
  // The escalation must not slow down the normal case: only undoing a stability
  // verdict widens the window.
  const tmp = mkTmp();
  const events = setup();
  try {
    const sessionId = 'parent';
    fs.mkdirSync(path.join(tmp, sessionId, 'subagents'), { recursive: true });
    const session = {};

    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    detectSubagentTransitions(sessionId, session, tmp);
    seedLiveAgent(tmp, sessionId, 'plain');
    detectSubagentTransitions(sessionId, session, tmp);
    detectSubagentTransitions(sessionId, session, tmp); // arms _stableStart

    t.mock.timers.tick(STABLE_MS + 1000);
    detectSubagentTransitions(sessionId, session, tmp);

    assert.equal(events.filter(e => e.channel === 'subagent-completed').length, 1,
      'a first silence of STABLE_MS must still complete the agent');
    assert.ok(!session.knownSubagents.get('plain')._stableMs,
      'an agent that was never rehabilitated must carry no widened window');
  } finally {
    t.mock.timers.reset();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('the stability window widens on each rehabilitation and converges on MAX_STABLE_MS', (t) => {
  // Maintainer's call on the oscillation: an agent that has already gone quiet
  // for a long time is an agent whose silences are long, so widen its window
  // instead of blinking at it. Bounded, and capped by name.
  const tmp = mkTmp();
  const events = setup();
  try {
    const sessionId = 'parent';
    fs.mkdirSync(path.join(tmp, sessionId, 'subagents'), { recursive: true });
    const session = {};

    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    detectSubagentTransitions(sessionId, session, tmp);
    const filePath = seedLiveAgent(tmp, sessionId, 'flaky');
    detectSubagentTransitions(sessionId, session, tmp);

    const known = () => session.knownSubagents.get('flaky');
    const completions = () => events.filter(e => e.channel === 'subagent-completed').length;

    // Cycle 1 — the window is still the plain STABLE_MS.
    detectSubagentTransitions(sessionId, session, tmp);
    t.mock.timers.tick(STABLE_MS + 1000);
    detectSubagentTransitions(sessionId, session, tmp);
    assert.equal(completions(), 1, 'first silence completes at STABLE_MS');
    t.mock.timers.tick(1000);
    grow(filePath);
    detectSubagentTransitions(sessionId, session, tmp);
    assert.equal(known()._stableMs, STABLE_LADDER[1], 'the window widens after the first rehabilitation');

    // Cycle 2 — the same STABLE_MS silence must no longer be enough.
    detectSubagentTransitions(sessionId, session, tmp);
    t.mock.timers.tick(STABLE_MS + 1000);
    detectSubagentTransitions(sessionId, session, tmp);
    assert.equal(completions(), 1, 'a widened window must not complete on a short silence');
    t.mock.timers.tick(STABLE_LADDER[1]);
    detectSubagentTransitions(sessionId, session, tmp);
    assert.equal(completions(), 2, 'it completes once the widened window elapses');
    t.mock.timers.tick(1000);
    grow(filePath);
    detectSubagentTransitions(sessionId, session, tmp);
    assert.equal(known()._stableMs, MAX_STABLE_MS, 'the second rehabilitation reaches the cap');

    // Cycle 3 — the cap holds instead of growing further.
    detectSubagentTransitions(sessionId, session, tmp);
    t.mock.timers.tick(MAX_STABLE_MS + 1000);
    detectSubagentTransitions(sessionId, session, tmp);
    assert.equal(completions(), 3);
    t.mock.timers.tick(1000);
    grow(filePath);
    detectSubagentTransitions(sessionId, session, tmp);
    assert.equal(known()._stableMs, MAX_STABLE_MS, 'the window converges, it does not keep growing');
  } finally {
    t.mock.timers.reset();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a silence longer than the renderer TTL is re-announced, not heartbeaten', (t) => {
  // Companion to the widening: past RENDERER_TTL_MS the renderer has certainly
  // pruned the entry, and it refuses heartbeats for agents it does not track.
  // Without this the widened window would trade a blink for a permanent
  // blackout — the very bug this branch fixes.
  const tmp = mkTmp();
  const events = setup();
  try {
    const sessionId = 'parent';
    fs.mkdirSync(path.join(tmp, sessionId, 'subagents'), { recursive: true });
    const session = {};

    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    detectSubagentTransitions(sessionId, session, tmp);
    const filePath = seedLiveAgent(tmp, sessionId, 'slow');
    detectSubagentTransitions(sessionId, session, tmp);

    // Widen the window once so the agent can stay silent past the renderer TTL
    // without being completed.
    detectSubagentTransitions(sessionId, session, tmp);
    t.mock.timers.tick(STABLE_MS + 1000);
    detectSubagentTransitions(sessionId, session, tmp);
    t.mock.timers.tick(1000);
    grow(filePath);
    detectSubagentTransitions(sessionId, session, tmp);

    const before = events.length;
    t.mock.timers.tick(RENDERER_TTL_MS + 5000);
    grow(filePath);
    detectSubagentTransitions(sessionId, session, tmp);

    const emitted = events.slice(before);
    assert.equal(emitted.length, 1, `expected one emission, got ${JSON.stringify(emitted.map(e => e.channel))}`);
    assert.equal(emitted[0].channel, 'subagent-spawned');
    assert.equal(emitted[0].payload._heartbeat, undefined,
      'past the renderer TTL the emission must be a real spawn the renderer will accept');
  } finally {
    t.mock.timers.reset();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

/** Seed a file that already exists when the session is first scanned, aged by
 *  `ageMs` — the shape PR #147's ghost had: written moments before a restart. */
function seedPreexistingAgent(tmp, sessionId, agentId, ageMs) {
  const subDir = path.join(tmp, sessionId, 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  const filePath = path.join(subDir, `agent-${agentId}.jsonl`);
  fs.writeFileSync(filePath, '', 'utf8');
  setMtime(filePath, Date.now() - ageMs);
  setMtime(subDir, Date.now() - ageMs);
  return filePath;
}

test('the settle tick does not resurrect the bootstrap ghost (PR #147)', (t) => {
  // PR #147: a subagent that finished shortly before a restart used to come back
  // as live. This branch adds a clock that rescans on its own, and the predicate
  // that arms it now counts completed-but-still-falsifiable entries — which is
  // exactly what bootstrap leaves behind for a recent file. Drive the tick past
  // the window and assert the ghost stays buried.
  const tmp = mkTmp();
  const activeSessions = new Map();
  try {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const events = setupWithProjectsDir(tmp, activeSessions);

    const sessionId = 'parent';
    const session = { projectFolder: '.' };
    activeSessions.set(sessionId, session);
    const filePath = seedPreexistingAgent(tmp, sessionId, 'ghost', 5000);

    detectSubagentTransitions(sessionId, session, tmp); // bootstrap
    assert.equal(events.length, 0, 'bootstrap is silent');
    const known = () => session.knownSubagents.get('ghost');
    assert.equal(known().completed, true, 'a pre-existing file is recorded as finished');
    assert.notEqual(known()._recheckStart, null, 'a recent one keeps a recheck window');
    assert.equal(scheduled.length, 1, 'that window is what arms the tick');

    // Let the tick run on its own, past the close of the recheck window.
    for (let i = 0; i < 20; i++) { t.mock.timers.tick(SETTLE_TICK_MS); fireTimers(); }

    assert.deepEqual(events, [],
      `the tick must never announce a bootstrap file, got ${JSON.stringify(events.map(e => e.channel))}`);
    assert.equal(known()._recheckStart, null, 'the window closed');
    assert.equal(known().completed, true, 'and the entry stayed finished');
    assert.equal(scheduled.length, 0, 'a frozen entry leaves no timer armed');

    // Frozen for good: growth after the window can no longer wake it.
    grow(filePath);
    for (let i = 0; i < 10; i++) { t.mock.timers.tick(SETTLE_TICK_MS); fireTimers(); }
    detectSubagentTransitions(sessionId, session, tmp);
    assert.deepEqual(events, [], 'a closed window never reopens');
  } finally {
    t.mock.timers.reset();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('the settle tick still rehabilitates a bootstrap file that grows in its window', (t) => {
  // The silence above must not have been bought by breaking the falsifiability
  // #147 deliberately kept: an orphaned writer that survived a hard kill has to
  // announce itself late rather than stay invisible for the whole session.
  const tmp = mkTmp();
  const activeSessions = new Map();
  try {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const events = setupWithProjectsDir(tmp, activeSessions);

    const sessionId = 'parent';
    const session = { projectFolder: '.' };
    activeSessions.set(sessionId, session);
    const filePath = seedPreexistingAgent(tmp, sessionId, 'survivor', 5000);

    detectSubagentTransitions(sessionId, session, tmp); // bootstrap
    assert.equal(events.length, 0, 'bootstrap is silent');

    // Still inside the recheck window, and it is still being written.
    t.mock.timers.tick(SETTLE_TICK_MS);
    fireTimers();
    grow(filePath);
    t.mock.timers.tick(SETTLE_TICK_MS);
    fireTimers();

    const spawns = events.filter(e => e.channel === 'subagent-spawned');
    assert.equal(spawns.length, 1,
      `the tick must emit the withheld spawn exactly once, got ${JSON.stringify(events.map(e => e.channel))}`);
    assert.equal(spawns[0].payload.agentId, 'survivor');
    assert.equal(spawns[0].payload._heartbeat, undefined, 'it is a spawn, not a heartbeat');
    assert.equal(session.knownSubagents.get('survivor').completed, false, 'the assumption is undone');

    // It goes quiet again — one late spawn, never a repeated one.
    for (let i = 0; i < 20; i++) { t.mock.timers.tick(SETTLE_TICK_MS); fireTimers(); }
    assert.equal(events.filter(e => e.channel === 'subagent-spawned').length, 1,
      'the late spawn is announced once, not on every tick');
  } finally {
    t.mock.timers.reset();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
