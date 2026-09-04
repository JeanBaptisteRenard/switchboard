# Context: subagent-observability

**Purpose**: Surface Claude's subagent runs (child tasks spawned via the `Agent` tool) in the Switchboard sidebar with parent→child grouping, live status badges, and a read-only transcript viewer. Avoid the original mistake of treating subagents as resumable sessions — they're ephemeral and re-resuming corrupts their context.

This is the **#1 fork-specific feature** (upstream PR #47 still pending). It pervades many files rather than living in a single module.

## Key files (by layer)

### Indexing (main → DB)

| File | Role |
|---|---|
| `session-cache.js` | `enumerateSessionFiles(folderPath)` walks `<folder>/*.jsonl` AND `<folder>/<parentSessionId>/subagents/*.jsonl` (+ legacy `<folder>/<parentSessionId>/*.jsonl`). Sets `subagentType` from JSONL metadata. |
| `db.js` | `session_cache` row has `parentSessionId`, `agentId`, `subagentType` columns. `getCachedByParent(parentSessionId)` returns all children. |
| `read-session-file.js` | `readSessionDisplayHeader()` extracts `agentId` + `isSidechain` flags from the first 256 KB. |

### IPC bridge (main ↔ renderer)

| IPC | What it does |
|---|---|
| `read-subagent-jsonl(parentSessionId, agentId)` | Returns parsed JSONL entries for the transcript view |
| `list-subagents(parentSessionId)` | Returns all subagent rows for a parent (used by the sidebar nesting) |
| `start-subagent-watch(parentSessionId, agentId)` | Begin tailing the subagent's JSONL; emits `subagent-watch-event` per change |
| `stop-subagent-watch(watchId)` | Tear down the watch |
| Events (main → renderer): `subagent-spawned`, `subagent-completed`, `subagent-watch-event` | Live status changes |

### UI

| File | Role |
|---|---|
| `public/sidebar.js` | Renders the "Orphan subagents" collapsible group; nests subagents under their parent in worktree/session groups; click handler routes subagent items to the transcript view. |
| `public/jsonl-viewer.js` | `showSubagentTranscript(session)` — read-only render of the subagent's JSONL with `mergeLocalCommandEntries` + `renderJsonlEntry` + a "Resume in terminal anyway" escape banner. |

## Public surface (for code that wants to integrate)

- From renderer code: `window.api.readSubagentJsonl`, `window.api.listSubagents`, `window.api.startSubagentWatch`, `window.api.stopSubagentWatch`, listeners `window.api.onSubagentSpawned/Completed/WatchEvent`
- From renderer JS: `showSubagentTranscript(session)` (cross-file global, declared in `eslint.config.js` rendererCrossFileGlobals)
- From sidebar UI: subagent rows carry `dataset.subagent = true` and `dataset.parentId = parentSessionId` for downstream wiring

## Invariants

- **A subagent click MUST NOT spawn `claude --resume`.** The opener routing in `sidebar.js` checks `item.dataset.subagent && session.parentSessionId` and dispatches to `showSubagentTranscript` instead of `openSession`. **If you add a new sidebar opener path, replicate this discriminator.**
- **`subagentType` is the canonical "is-subagent" signal**: non-null/non-empty string. The agent type itself (e.g. `'frontend-implementer'`, `'researcher'`) is human-meaningful but the *presence* of the value is what matters for routing.
- **Subagent JSONLs are at `<folder>/<parentSessionId>/subagents/<agentId>.jsonl`**, NOT at `<folder>/<agentId>.jsonl`. There's also a legacy layout `<folder>/<parentSessionId>/<agentId>.jsonl`. **Always use `enumerateSessionFiles()` to walk both layouts.**
- **Watchers are scoped per `(parentSessionId, agentId)`**: don't share a watcher across subagents — `start-subagent-watch` returns a `watchId` that's unique per call.
- **Watch cleanup is mandatory** when the transcript view is closed. `drainViewerWatches()` (in `jsonl-viewer.js`) walks `activeViewerWatches` and calls `stopSubagentWatch` for each. Forgetting this leaks `fs.watch` handles.

## Non-obvious behaviors

- **The parent JSONL doesn't contain the subagent's text** — it just records a `subagent-spawn` event. The actual conversation lives in the child JSONL. The viewer pieces them together via `mergeLocalCommandEntries`.
- **Orphan subagents** (no findable parent in cache) are surfaced in a dedicated `.orphan-subagents` group in the sidebar, **collapsed by default**. State is persisted per-project in `localStorage['orphanExpanded:' + projectPath]`.
- **Subagent status badges**: derived from the most recent JSONL line — `isSidechain: true` means active, completion is inferred from mtime stability (see PR #48 observability follow-up).
- **The "Resume in terminal anyway" button** in the transcript view bypasses the routing and calls the original `openSession` opener. This is intentional — for the rare debugging case where a user genuinely wants to re-enter the subagent's session.

## Live "running" indicator in the sidebar (PR #130, fixes #129)

- **Why `activePtyIds` can't work for subagents**: a subagent runs inside its
  parent's process and never owns a PTY, so `activePtyIds.has(sessionId)` is
  structurally always false for it. The real liveness signal is the
  `subagent-spawned` / `subagent-completed` IPC pair emitted by
  `session-transitions.js:detectSubagentTransitions()` (also consumed by
  `grid-view.js` and `jsonl-viewer.js`).
- **State**: `activeSubagentsByParent` in `public/sidebar.js` —
  `parentSessionId → Map<agentId, spawnedAt(ms)>` of spawned-but-not-completed
  subagents. `buildSubagentItem()` / `appendSubagentChildren()` re-derive
  `.running` from this Map on every render, so the state survives a full
  sidebar rebuild; the IPC handlers only fast-path the visual toggle between
  rebuilds (`reflectSubagentRunningState`).
- **Why a TTL** (`SUBAGENT_LIVE_TTL_MS` = 60s, shared with grid-view — see
  "One TTL, one definition" below):
  `detectSubagentTransitions()` only polls subagents of `!exited` sessions —
  if the parent's PTY dies before a subagent goes 30s quiet, the matching
  `subagent-completed` never fires and the entry would be stuck forever.
  `pruneStaleSubagents()` runs at the top of every `renderProjects()` — a
  render-time prune, not a standalone timer (ADR 0002: no added steady-state
  cost).
- **Collapsed parents**: a running child's own dot is hidden inside the
  collapsed `childrenContainer`, so `appendSubagentChildren` also toggles
  `has-running-child` on the caret row (`.caret-running-dot` in style.css) to
  surface liveness at the caret level.
- **The `updateRunningIndicators` guard** (`public/app.js`): the periodic PTY
  poll must skip `dataset.subagent` items, or it would clear the `.running`
  state within one cycle of the IPC setting it.
- **`subagentDomId()`** mirrors `subagentSessionId()` in
  `read-session-file.js` — that file is main-process and not `require()`-able
  from the renderer (sidebar.js loads as a plain script), hence the local copy.
- **Grid view keeps its own parallel tracking** (`activeSubagents` +
  `pruneStaleGridSubagents()` in `grid-view.js`, pruned from `wrapInGridCard()`
  rather than on a timer). Renderer files are plain non-module `<script>`s
  sharing one global scope and `sidebar.js` loads *after* `grid-view.js`
  (`index.html:135` then `:139`), so a top-level function declared under the
  same name in both is silently shadowed — that is what froze the grid's TTL
  prune until PR #137. Keep cross-file names distinct;
  `test/dom-grid-sidebar-prune-collision.test.js` pins the pair.

## Not resurrecting finished subagents

A subagent's `agent-<id>.jsonl` is never deleted, so **every directory rescan
re-sees the entire history of the session**. `detectSubagentTransitions()` only
rescans when the `subagents/` dir mtime moves — which is exactly what happens
when a *new* subagent starts. Two rules keep that rescan quiet:

- **Bootstrap never announces anything.** Every file present at a session's
  first scan is recorded silently as `completed: true`, whatever its mtime.
  Switchboard owns the PTYs its subagents run in — one set per Electron
  process — so they all died with the previous process, and a restored session
  gets a brand-new PTY whose agents write *after* bootstrap and are picked up
  by the normal path. Nothing on disk at that moment can be live. The silence
  is unconditional; the *verdict* is not (next bullet).
- **After bootstrap, a first sighting is only a spawn if the file is fresh.**
  An unknown file whose mtime is already older than `FRESH_SIGHTING_MS` (60 s)
  is recorded silently as `completed: true`, with no `readSubagentMeta()` and
  no IPC.
- **That verdict is an assumption, and it is reversible.** A stale first
  sighting is *not* proof the agent finished. `detectSubagentTransitions()`
  runs only from `flushChanges()`, whose debounce (`main.js`) is shared across
  the whole of `PROJECTS_DIR`, has no `maxWait` and no fallback poll — a burst
  of parallel subagents can push the first flush past 60 s, and a live agent is
  then seen late. So post-bootstrap such an entry keeps a `_recheckStart`
  window: it is still `statSync`'d on each flush, and **if its mtime advances
  it is rehabilitated** — `completed` returns to false and the withheld
  `subagent-spawned` is emitted (logged `[subagent-spawn-late]`). The window
  closes once the file has been seen motionless for a full `STABLE_MS`, after
  which the entry is frozen and costs nothing. **At bootstrap the window is
  opened only for files whose mtime is fresh** — the handful that could
  conceivably still be running. Everything older is frozen outright: a window
  over the whole history would cost one `statSync` per historical file per
  flush, exactly what the dir-mtime cache exists to avoid, and a file minutes
  old cannot be the agent in question anyway. The narrow window is what keeps
  the startup rule falsifiable: if the PTY-ownership argument above is ever
  wrong (an orphaned process surviving a hard kill and still writing), the
  agent is announced late instead of staying invisible for the whole session.
  Silence at startup must not become a permanent blind spot — a visible late
  spawn beats a silent disappearance.
- **`knownSubagents` forgets an agent only when its file leaves the disk.** The
  earlier GC dropped completed entries after 5 minutes; because the file stayed,
  the next rescan rediscovered it as unknown and announced a spawn. That was the
  observed bug: starting one subagent lit the running dot on *every* historical
  subagent except the one that had just finished (still in the map, still
  flagged completed). Dropping the entry was never a saving either — the rescan
  re-added it, at the cost of a `statSync` and a `readSubagentMeta()` each.
  The map is now bounded by the directory's own file count.

The settle tick reopens this question, because the predicate that arms it counts
completed-but-still-falsifiable entries — which is exactly what bootstrap leaves
behind for a *recent* file. So the periodic sweep now rescans the very entries
PR #147 was about, with no watcher event involved. It does not wake the ghost:
those entries are recorded `completed: true`, and the rehabilitation branch fires
only on an mtime that actually moved. That is pinned by execution, not by
reading — `test/subagent-settle-tick.test.js` drives the tick past the close of
the window on a bootstrap file and asserts no IPC is ever emitted, and a sibling
test grows the file mid-window to check the late spawn is still emitted, once.
Neutralising the mtime-growth condition makes the first test report
`the tick must never announce a bootstrap file, got
["subagent-spawned","subagent-completed","subagent-spawned"]` — the ghost, now
oscillating on a clock.

Renderer side, `subagent-spawned` doubles as the still-alive heartbeat
(`payload._heartbeat`). **A heartbeat refreshes an agent already tracked; it
never creates an entry** — in `public/sidebar.js` and `public/grid-view.js`
alike. Without that, a stray heartbeat could revive an agent that had completed,
been TTL-pruned, or been dropped by `clearActiveSubagentsFor()`.

A fork/resume re-key (`detectSessionTransitions`) switches `realSessionId`, and
subagent scanning follows it into a *different* directory — so the re-key also
clears `knownSubagents`, `_prevDirMtime` and `_subFileList`, letting the new
directory bootstrap instead of being read through the old one's cache.

### What is guaranteed, and what is not

Guaranteed: a static historical file never produces a spawn (it does not move,
so it never enters the rehabilitation branch), and an agent still writing is
always picked up — late at worst, never lost.

Also guaranteed since 2026-08-22: **a restart is quiet**. Bootstrap used to
treat any file younger than 60 s as a live agent and emit a synthetic
`subagent-spawned` (`payload._bootstrap`). An agent that finished less than a
minute before the app was restarted therefore came back as a ghost — purple
activity glyph on the parent, green dot on the subagent group header — until
the 30 s stability window declared it complete. Observed 2026-08-22; the
synthetic bootstrap spawn is gone and `_bootstrap` is no longer emitted (the
renderer still tolerates the field). What replaced it is silence plus a
recheck window on recent files, not an irreversible verdict.

Not guaranteed: an agent that goes quiet for longer than `STABLE_MS` mid-run —
a long tool call, say — can be declared finished while it is still alive. That
is not new and not specific to the age filter: the 30 s stability window has
always been the module's only completion signal, and it applies identically to
an agent tracked from its first line. The renderer's 60 s TTL has the same
shape. Anything that needs true liveness would have to come from the parent
process, not from mtime.

## The liveness signal needs a clock of its own (measured 2026-08-23/24)

`detectSubagentTransitions()` owns three signals — spawn, heartbeat, completion —
and until now it ran from exactly one place: the projects watcher's debounced
flush (`main.js:startProjectsWatcher`, `setTimeout(flushChanges, 500)` re-armed
on every `fs.watch` event over `PROJECTS_DIR`). A function that only runs when a
file changes cannot detect that a file **stopped** changing. Three symptoms,
all measured in `~/AppData/Roaming/switchboard/logs/main.log`:

- **Completion arrives minutes late.** Agent `a9be19fb0a7e0e504`: last transcript
  write 23:42:18, `[subagent-complete]` logged **23:52:55** — 10 min 37 s for a
  30 s stability window. The parent was `waiting for your input` (OSC 9 at
  23:43:35), so nothing wrote in the folder and no flush ran. The event fired at
  the moment activity resumed, which is what the user saw as "the indicators
  went dark when the parent came back".
- **Completion also arrives *wrongly*.** Agents `a8e8c25f42a65b026` and
  `a19dcbbb23270de85` were declared complete at 23:56:53 and 00:00:27 while
  still writing at 00:02:00 and 00:01:45. A tool call longer than `STABLE_MS`
  is indistinguishable from a finished agent — a documented limitation, but the
  verdict was **irreversible**: the completion branch set `completed = true`
  without a `_recheckStart`, so the entry hit the
  `if (known.completed && !known._recheckStart) continue` fast path forever and
  the agent could never light up again. `LIVE_RECHECK_MS` (5 min) now keeps a
  stability completion falsifiable exactly like an assumed-finished one; renewed
  growth rehabilitates it and re-emits the spawn (`[subagent-spawn-late]`).
  This is load-bearing for the tick below: giving the stability clock a clock
  makes false completions *more* frequent, not less, so reversibility is the
  half that makes the pair safe.

  **The window widens on each rehabilitation** — `STABLE_LADDER_MS`
  (30 s -> 2 min -> `MAX_STABLE_MS` = 5 min, capped by name, carried on the
  entry as `_stableMs`). An agent that has already gone quiet for longer than
  its window is an agent whose silences are long; widening converges instead of
  letting it oscillate complete -> rehabilitated -> complete, one visible blink
  per cycle. The widening is deliberately **not** applied to the other
  rehabilitation case: an *assumed*-finished entry (bootstrap, or a stale first
  sighting) was never declared finished by the stability timer and carries no
  evidence of long silences, so widening it would slow the normal case for
  nothing. `_recheckMs` is the discriminator — it is set only on a stability
  completion. Getting that wrong is caught by the two pre-existing bootstrap
  reversibility tests.

  **Widening required one companion change.** A wider window means an agent can
  stay silent past the renderer's 60 s TTL without being completed — and the
  renderer refuses a heartbeat for an agent it no longer tracks, by design. On
  its own the widening would therefore have traded a blink for a permanent
  blackout: exactly the bug being fixed, since before this branch the
  completion/rehabilitation pair was the *only* path that re-lit a TTL-pruned
  entry. So when the growth branch finds the agent unseen for at least
  `SUBAGENT_LIVE_TTL_MS` it emits a **real spawn instead of a heartbeat**. That is
  safe in all three cases the no-resurrect guard defends against: a completed
  entry never reaches the growth branch, a TTL-pruned one is precisely what we
  want to revive on fresh evidence of growth, and a dead parent never gets
  scanned at all (`detectSubagentTransitions` runs only for `!exited`
  sessions).
- **Heartbeats stop too**, and the renderer's 60 s TTL then evicts a live agent.
  Combined with "a heartbeat never resurrects an untracked agent", that eviction
  is permanent as well.

The settle tick (`SETTLE_TICK_MS`, `armSubagentSettleTick`) re-runs the scan for
sessions that still hold a non-completed entry, independent of the watcher. It
arms only when something is unsettled, re-arms from its own sweep, and stops on
its own once every tracked agent has both completed **and** closed its recheck
window — no idle cost when no subagent is running. `unref()` keeps it out of the
way of process shutdown and of tests.

A completed-but-still-falsifiable entry counts as unsettled on purpose: without
that, in a silent folder its window could only ever close on a write to some
*other* file in the same folder, so the "generous but bounded" promise above
would not hold. Note that arming is guarded in two places — in
`armSubagentSettleTick` and again in the sweep — so a test that only drains
timers cannot tell the two apart; `test/subagent-settle-tick.test.js` scans a
settled session directly and asserts nothing gets armed.

**Refuted, so it does not get fixed here**: the debounce being *starved* by a
flood of writes (re-armed faster than 500 ms while several transcripts append).
The log disproves it — completions were emitted at 23:56:53 and 00:00:27 while
three transcripts were being written, so the flush was running normally under
load. No `maxWait` was added.

### One TTL, one definition

The main process and both renderer views must agree on the liveness TTL, and
the failure is silent and one-directional: shorten the renderer's TTL alone and
there is a band of durations in which the renderer has already pruned the entry
while the main process is still sending heartbeats the renderer refuses — the
permanent blackout this branch exists to fix, reintroduced with nothing to
catch it. (Diverging the other way is harmless.)

It used to be three independent `60000` literals held together by a comment.
`public/subagent-timing.js` is now the single definition, following the
dual-mode pattern already used by `public/shortcuts.js` and
`public/terminal-manager.js`: a classic `<script>` for the renderer plus a
`typeof module !== 'undefined'` export footer for `require()`. Three consumption
contexts, all of which have to keep working:

- **main process** — `require('./public/subagent-timing')` from
  `session-transitions.js`. Root-to-`public/` is a new direction for this repo
  but the directory is already in electron-builder's `files`, so it ships.
- **renderer** — `<script src="subagent-timing.js">` in `index.html`, placed
  before `grid-view.js` and `sidebar.js`. A top-level `const` lands in the
  global *lexical* scope, not on `window`: sibling scripts resolve the bare
  identifier, but `window.SUBAGENT_LIVE_TTL_MS` is `undefined`. Don't "verify"
  the wiring by reading it off `window`.
- **jsdom harness** — every harness that evaluates `sidebar.js` or
  `grid-view.js` must evaluate `subagent-timing.js` first or they die on
  `no-undef`/ReferenceError. Seven of them do (`test/dom-setup.js` plus six
  test files with their own file lists); a new harness has to remember.

`eslint.config.js` carries the constant in `rendererCrossFileGlobals` for the
consumers, and gives the *producing* file its own block that switches that
global `off` — otherwise `no-redeclare` flags the single definition, which is
what the eight standing warnings on `shortcuts.js` are.

### The renderer safety nets had no clock either

`pruneStaleGridSubagents()` was called only from `wrapInGridCard()` and
`pruneStaleSubagents()` only from `renderProjects()` — both render-driven, so a
stale entry survived exactly in the idle case the TTL exists to cover. Each view
now arms its own one-shot timer (`scheduleGridSubagentTtlTick` /
`scheduleSubagentTtlTick`, names kept distinct per the shadowing rule above),
scheduled **at the oldest entry's deadline** rather than on a polling interval:
one wakeup per TTL period while agents are tracked, none at all when the map is
empty, and a targeted refresh (`updateGridSubagentPills` /
`reflectSubagentRunningState`) only for the entries the prune actually removed.
That satisfies ADR 0002 — no steady-state cost, no render on an empty tick.

The deadline arithmetic is `Math.max(1, oldest + TTL + 1 - now)`, and the tests
assert on the armed `delay`, not just on the eviction — a constant interval or
an inverted sign is otherwise invisible, which is precisely the property ADR
0002 exists to protect. Note that the `Math.max` is unreachable: the prune
deletes on a strict `spawnedAt < now - TTL`, so any entry that survives it
satisfies `oldest + TTL >= now` and the expression is already `>= 1`. The `+1`
is the part that keeps a boundary tick off `setTimeout(0)`. Both are kept, and
the test pins the invariant (`delay >= 1`) rather than either guard, so it still
holds if the prune's comparison is ever loosened to `<=`.

These nets are a **backstop, not the fix**: with the main-process signal
repaired they should almost never fire. `test/subagent-settle-tick.test.js` and
`test/dom-subagent-ttl-tick.test.js` pin both halves; the DOM one substitutes
`window.setTimeout` so the tick is driven by its own condition, never by a wall
clock wait (see `docs/activity-trace.md`, "Testing the async prune path").

### Still open

The grid was reported showing two live pills while the sidebar showed one, at a
moment when the log says one of the two had already been (falsely) completed.
`onSubagentCompleted` removes the grid entry and calls
`updateGridSubagentPills`, which is a no-op when `gridCards` has no card for
that parent id — a plausible explanation, **not verified**: it needs the live
DOM, which was not available.

## Subagent children inside a slug group (issue #128 ask 4, rehab-plan.md A3)

- **The bug**: `buildSlugGroup()` used to append its sessions via the raw
  `buildSessionItem(session)`, never through `appendSubagentChildren()` — only
  the ungrouped/top-level render path (`buildSessionsList`) called that
  helper. Any session rendered inside a slug group (i.e. any second-or-later
  rerun of a schedule sharing a slug — the only real producer, see
  `schedule-runner.js:createScheduleSession()`) silently lost its subagent
  caret/children.
- **The fix**: `appendSubagentChildren()` was hoisted from a closure inside
  `renderProjects()` to module scope (it never captured any of that
  function's locals) so `buildSlugGroup(slug, sessions, subagentIndex)` can
  call it directly for each session it renders, exactly like
  `buildSessionsList` does for ungrouped sessions.
- **The knock-on bug this caused**: a slug-group `<div>` carries no
  `dataset.sessionId` of its own, so the "orphan subagents" pass in
  `buildSessionsList` — which built `allTopLevelIds` from
  `item.element.dataset.sessionId` — never counted the sessions grouped
  inside it as accounted-for. Their subagents were treated as parentless and
  duplicated into the project's "Orphan subagents" bucket even after the fix
  above attached them correctly inside the group. `collectTopLevelSessionIds(el)`
  fixes this by walking into `el` for nested `[data-session-id]` session-items
  (excluding subagent ones) when `el` itself isn't a session item.
- **Coverage**: `test/dom-slug-group-subagent-nesting.test.js` seeds two
  schedule-rerun-shaped sessions sharing a slug plus a subagent parented to
  one of them, and pins both the caret-attachment fix and the
  no-duplicate-orphan fix (failed on both before the fix, confirmed by
  reverting it locally during development).
- **A second knock-on bug (PR #134 review F1)**: nesting the subagent's
  caret/children as DOM siblings inside the group means every DOM query
  scoped to `.slug-group` that matches on `.session-item` alone now also
  matches the nested subagent item (`buildSubagentItem` includes
  `session-item` in its className for shared styling). The "Archive all
  sessions in group" handler (`rebindSidebarEvents`, `.slug-group-archive-btn`)
  had exactly this query and, unguarded, called `archiveSession`/`stopSession`
  on the subagent's id. Fixed with the same `:not([data-subagent])` guard
  already used elsewhere in this file (e.g. the per-item click wiring). Any
  *new* query scoped to a slug-group's subtree must apply this guard too —
  it's not automatic.

## `project.sessions` carries subagents

`buildProjectsFromCache` (`session-cache.js`) groups **every** `session_cache`
row by `projectPath`, subagent rows included — they are indexed from
`<folder>/<parent>/subagents/agent-*.jsonl` with the same `folder` and
`projectPath` as their parent, and the row keeps `parentSessionId` set. So the
`project.sessions` array the renderer receives is a flat list of parents *and*
children.

Every consumer must therefore drop `s.parentSessionId` rows itself before
treating the array as "the project's sessions". `processProjectSessions`
(`public/sidebar.js`) does exactly that (`allSessions.filter(s => !s.parentSessionId)`)
after handing the full list to `buildSubagentIndex`; the DB side does the same
in `getTotalCounts` (`db.js`), which counts `WHERE parentSessionId IS NULL`.

Two consumers had missed it and were fixed together:

- the project-level **Archive all sessions** button — it counted subagents in
  its confirmation prompt ("Archive all 87 sessions…" on a project with a
  handful of real ones), archived each subagent transcript so it vanished from
  under its parent, and called `stopSession` on any subagent id that happened
  to be in `activePtyIds`;
- the status bar's `N sessions` total (`renderDefaultStatus`, `public/app.js`),
  which disagreed with the stats panel's own total for the same reason.

Covered by `test/dom-project-archive-all.test.js`.

### The knock-on: the project vanished instead

Not archiving the children exposed a latent hole in `processProjectSessions`'s
skip guard. After an archive-all, `buildProjectsFromCache(false)` drops the
now-archived parent rows but keeps the unarchived subagent rows, so
`project.sessions.length > 0` while `filtered` (top-level only) is empty — the
guard returned `null`, the render loop hit `continue`, and the project vanished
from the default view entirely: no header, and no orphan bucket either, because
that bucket lives inside `buildSessionsList`, past the `continue`. No data was
lost (Show Archived brought it back), but the old behaviour hid this by
accident: archiving the children too really did empty `project.sessions`, so
the disappearance was legitimate.

The guard now carries `keepForOrphanSubagents = subagentIndex.size > 0 &&
!showStarredOnly && !showRunningOnly && !showTodayOnly`. When `filtered` is
empty, every indexed subagent is by definition an orphan (`allTopLevelIds` is
built from the rendered items, which are none), so the existing orphan bucket
renders them under a surviving header. The three named filters are
load-bearing: without excluding them, `showStarredOnly` / `showRunningOnly` /
`showTodayOnly` would resurrect every project that merely owns a subagent,
since subagents never satisfy those filters. Search is deliberately **not** in
that exclusion list: `refreshSidebar` (`public/app.js`) has already dropped any
project with zero matching sessions before `processProjectSessions` ever runs,
so by the time this guard is reached under an active search, `subagentIndex`
being non-empty means a subagent transcript is the match — keeping the project
alive surfaces it instead of losing it. The orphan bucket's default-collapsed
state is overridden the same way (`expanded = searchMatchIds !== null || ...`)
so the matching subagent doesn't require an extra click to see. The other
cases the guard protects are untouched — an empty project directory still
renders (`subagentIndex.size === 0`), a filtered-out project still hides, and
`_projectMatchedOnly` still short-circuits ahead of it.

## Capped subagent lists

Both subagent lists used to build every row on every render, and both then
hid most of what they had just built:

- `appendSubagentChildren` filled `.sidebar-subagents-container` with all of a
  parent's children and set `display:none` on the container unless the caret
  was expanded;
- the project-level orphan bucket in `buildSessionsList` appended every orphan
  and let `.sidebar-orphan-subagents.collapsed > :not(.sidebar-orphan-label)`
  hide them in CSS.

`buildSubagentItem` produces 7 elements per row, so a project with 1300
children and 1300 orphans built 18 200 elements per render — measured on the
jsdom harness (`test/dom-setup.js`), 18 275 elements total in the sidebar,
of which 18 200 were subagent rows nobody was looking at. Neither `+ N older`
nor the collapsed-group CSS helps here: they save screen space, not
construction.

Each list now renders, by default, the **union** of

- every subagent for which `isSubagentActive(parentSessionId, agentId)` holds, and
- the `SUBAGENT_PREVIEW_COUNT` (10) most recent by `modified`

(`splitSubagentsForPreview`), and the remainder is **not built at all** — only
a `+ N more` toggle is emitted (`appendSubagentRestToggle`). Same fixture after
the change: 217 elements in the sidebar, 20 subagent rows. The union is
deliberate, not a truncated sort: a long-running subagent whose transcript
stopped growing hours ago must keep its `.running` dot, which a
recency-only cut would silently extinguish — the exact class of bug PR #130
was about. Row order inside each list is unchanged; only membership is.

Clicking the toggle builds the remainder there and then, removes the toggle,
and records the list in the `expandedSubagentRest` localStorage set
(`p:<parentSessionId>` for a parent's children, `o:<projectPath>` for a
project's orphan bucket). The next render reads that set *before* splitting
and builds the whole list, so what the user expanded survives morphdom —
same mechanism as `expandedSubagents` and `orphanExpanded:<projectPath>`,
including the one-shot GC that drops `p:` entries whose session is gone from
`sessionMap`.

Two details that are easy to get wrong:

- **The toggle's payload cannot live in its closure.** morphdom keeps the
  *old* element whenever ids match (`getNodeKey`), so a listener bound at
  build time keeps forever the data of the render that created it. The
  remainder is therefore held in the module-level `pendingSubagentRest` map,
  keyed by the toggle's id, cleared at the top of `renderProjects` and
  repopulated by each build — the kept listener always reads current data.
- **An active search bypasses the cap** (`searchMatchIds !== null`), for the
  same reason the orphan bucket auto-expands during a search: `refreshSidebar`
  has already narrowed `project.sessions` to the matches, so every remaining
  row is a hit and hiding one behind a click would lose it.

Not addressed, and worth knowing: a *collapsed* caret still builds its 10
preview rows, and the "active" criterion is `isSubagentActive` alone.
`attentionSessions` / `responseReadySessions` / `sessionBusyState` are keyed
by PTY-owning sessions and never hold a subagent id on this fork (subagent
click opens a read-only transcript, fork PR #9), so no other indicator can be
capped out of view — but that is a property of the current wiring, not an
invariant enforced anywhere.

## If you change this, also check

- `eslint.config.js` `rendererCrossFileGlobals` — must list any new renderer-global functions (e.g. `showSubagentTranscript`, `drainViewerWatches`) or lint fails on `no-undef`
- `test/dom-subagent-list-cap.test.js` — pins the union criterion, the "+ N more" lazy build, and the survival of an expanded remainder across a re-render
- `test/dom-subagent-transcript.test.js` — 4 tests covering the routing branch + transcript render
- `test/dom-sidebar.test.js` — covers orphan group rendering
- `test/dom-project-archive-all.test.js` — pins the project archive-all filter
- `test/dom-sidebar-search-subagent-hits.test.js` — pins the search-only-hits-a-subagent case and the showStarredOnly regression, one test per guard clause
- `test/session-transitions.test.js` — spawn/complete/heartbeat lifecycle plus
  the resurrection guards above
- `test/dom-grid-subagent-pills.test.js` — pins the grid-view IPC handler arity
  (`preload.js` passes the payload as the callback's only argument)
- `public/sidebar.js:1082` (the routing branch) — the one-line decision that makes the whole feature work
- IPC handler security: `read-subagent-jsonl` MUST validate that `agentId` and `parentSessionId` are filename-safe (see `resolveJsonlPath` calls in main.js — fixed in PR #8 hardening)

## History

- Upstream PR #47: original subagent indexing + search (still open upstream, merged on fork)
- Upstream PR #48: live transitions, status badges
- Fork PR #9: subagent click → transcript view (replaces resume-in-terminal default)
- Fork PR #8: security hardening on subagent IPCs + watch drain on viewer close
