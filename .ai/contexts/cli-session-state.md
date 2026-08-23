# Context: cli-session-state

**Purpose**: turn the Claude CLI's own "I just went idle" moment into an
immediate subagent rescan, so a subagent that finished right before its parent's
turn ended is marked complete in seconds instead of waiting for the next
stabilisation tick.

**Files**: `cli-session-state.js`, wired in `main.js` (three call sites),
`test/cli-session-state.test.js`, `test/canary-cli-session-state.test.js`.

## Why it exists

`detectSubagentTransitions()` owns the stability clock that decides a subagent
is finished (see [subagent-observability](subagent-observability.md)). Before
PR #153 that function only ran from the debounced `fs.watch(PROJECTS_DIR)`
flush — and a function driven by file changes cannot notice that a file
*stopped* changing. Measured 2026-08-23: a completion emitted 10 min 37 s after
the last write, because the folder had gone silent.

PR #153 fixed the scheduling defect with a self-arming 5 s settle tick plus
renderer-side TTL nets. **That is the fix; this module is not.** What is added
here is a *sooner and more precise trigger* for the same scan: the residual
lateness after #153 is up to one tick (5 s) plus the remainder of the stability
window, and the CLI publishes an idle edge that lands well before the next tick
would. It is an optimisation on top of a working mechanism, and everything it
does is also done, later, by the tick.

## The external file we read

`~/.claude/sessions/<pid>.json`, written by the Claude CLI itself. Observed
shape (CLI 2.1.241, Windows, 2026-08-23):

```json
{"pid":18176,"sessionId":"6577a487-…","cwd":"C:\\Serveur\\switchboard",
 "startedAt":1787520942563,"procStart":"134319945380279381","version":"2.1.241",
 "kind":"interactive","entrypoint":"cli","name":"switchboard-main",
 "status":"busy","statusUpdatedAt":1787527436145,"updatedAt":1787527436145}
```

**This is not a documented interface.** Nothing obliges the CLI to keep it, keep
its field names, or keep its status vocabulary. Every use of it here is
therefore best-effort, and its absence or corruption must be a no-op — see
"Failure is silence" below. `test/canary-cli-session-state.test.js` exists
precisely so a CLI-side change reads as a CLI-side change.

Facts established by measurement, not by documentation:

- `status ∈ {busy, idle, waiting, shell}`.
- It is written **on change, not as a heartbeat** — hence `statusUpdatedAt`, and
  hence the liveness guards below. A killed CLI leaves its last status engraved
  in the file forever.
- Sampling 295 times at 2 s over 10 min with 2–3 subagents writing, `status`
  stayed `busy` throughout, with no false dip. The parent is `busy` while any
  delegated agent runs (`delegatedActive` in the CLI's own status computation).
- **Unverified reservation**: no permission dialog occurred during that
  measurement, so the `waiting` branch was never observed empirically. We treat
  `waiting` as "not idle" on the strength of the name alone. If that reading is
  wrong, the only consequence is a missed early rescan — the tick still fires.

The `busy` glyph in the terminal title was considered instead and rejected: it
conflates idle, waiting and shell. The state file distinguishes them, which is
why it is preferred here.

## The one invariant

**The idle signal is a trigger, never a verdict.** It calls
`detectSubagentTransitions()` earlier; it never marks anything complete and
never emits `subagent-completed`. The stability clock inside that function
remains the sole judge of what has finished. Grepping `cli-session-state.js`
for any `subagent-` channel must return nothing — if it ever does, the change
has crossed the line this module was built to respect.

The reason is the falsified converse: parent-idle does **not** imply
no-subagent-running in general (the title glyph proved that), and even a correct
idle would say nothing about *which* child finished. Only mtime stability
carries that.

## Guards

**Process liveness.** Because `status` is written on change, a stale file can
say `busy` — or `idle` — indefinitely. Before any rescan the pid is probed with
`process.kill(pid, 0)` (`EPERM` counts as alive).

**PID reuse.** The file is named by pid alone, so a second CLI can inherit the
name. `procStart` is recorded per file; when it changes, the entry is reset as a
new process and the status change that came with it is *not* read as a
transition. This is the guard that actually matters — the liveness probe is a
cheap sanity check for a file mutated by anything other than a live CLI.

**First sighting never triggers.** A status is only a transition against a
previously recorded one for the same `procStart`. At attach time the directory
is seeded once so the first real transition after startup still fires — but the
seed is skipped entirely when the directory holds more than `MAX_SEEDED_FILES`
(200) state files, to bound startup cost. Past that threshold every session
loses its first transition, not merely the ones over the cap, and the settle
tick is the only net left. Benign by construction: the cost is a late rescan,
never a wrong verdict.

**Per-session throttle.** At most one rescan per second per session.

## Matching a state file to a Switchboard session

By `sessionId` only, against `session.realSessionId || <map key>` over
`activeSessions`, skipping `exited`, `isPlainTerminal`, and sessions with no
`projectFolder`. `realSessionId` is what makes forked and resumed sessions work:
after a fork the CLI writes the new id while `activeSessions` is still keyed by
the old one, and it is also the id the subagent directory is named after, so it
is the id the rescan must be given.

The file's `cwd` is deliberately **not** used as a fallback: several sessions
can share a working directory, so it cannot disambiguate.

**When matching fails, nothing happens** (one debug log line). That covers a CLI
the user started outside Switchboard, and the window between a fork being
written by the CLI and being detected by `detectSessionTransitions`. The settle
tick covers the session either way.

## Cost at idle

Zero polling. One `fs.watch` on a directory that holds a handful of tiny files,
with a 150 ms debounce; events only occur when a CLI changes state. No timer is
armed while the module is idle. This is the constraint from
[ADR 0002](../../docs/decisions/0002-discrete-steps-sidebar-animations.md) —
steady-state cost is the thing the repo has repeatedly paid to remove.

If `~/.claude/sessions/` does not exist there is **no** retry timer and no
fallback poll: `ensureWatching()` is simply called again the next time a Claude
PTY is spawned, plus once 15 s after such a spawn while still unattached. That
covers the machine where the directory only appears with the first CLI run.

## Failure is silence

Missing directory, unreadable file, truncated JSON caught mid-write, missing
fields, unknown status: every one of these results in doing nothing, never in a
throw. The CLI does not write this file atomically. Degrading to "the tick
handles it" is always an acceptable outcome, which is what makes depending on an
undocumented file defensible at all.

## Canary tests

`test/canary-*.test.js` is a convention this module introduces. A canary
asserts nothing about our code: it pins an assumption we make about something we
do not own, and **skips itself wherever that thing is absent** so CI and
machines without the dependency stay green. Its failure message must name the
pinned assumption and the observed version of the external thing, so the next
reader knows immediately to look outward rather than hunt a bug in Switchboard.

Add one whenever you build on an undocumented external artefact; do not add one
for an assumption a normal unit test can pin.
