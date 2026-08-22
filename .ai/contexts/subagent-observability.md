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
- **Why a TTL** (`SUBAGENT_LIVE_TTL_MS` = 60s, mirroring grid-view's):
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

## If you change this, also check

- `eslint.config.js` `rendererCrossFileGlobals` — must list any new renderer-global functions (e.g. `showSubagentTranscript`, `drainViewerWatches`) or lint fails on `no-undef`
- `test/dom-subagent-transcript.test.js` — 4 tests covering the routing branch + transcript render
- `test/dom-sidebar.test.js` — covers orphan group rendering
- `test/session-transitions.test.js` — spawn/complete/heartbeat lifecycle plus
  the resurrection guards above
- `test/dom-grid-subagent-pills.test.js` — pins the grid-view IPC handler arity
  (`preload.js` passes the payload as the callback's only argument)
- `public/sidebar.js:771` (the routing branch) — the one-line decision that makes the whole feature work
- IPC handler security: `read-subagent-jsonl` MUST validate that `agentId` and `parentSessionId` are filename-safe (see `resolveJsonlPath` calls in main.js — fixed in PR #8 hardening)

## History

- Upstream PR #47: original subagent indexing + search (still open upstream, merged on fork)
- Upstream PR #48: live transitions, status badges
- Fork PR #9: subagent click → transcript view (replaces resume-in-terminal default)
- Fork PR #8: security hardening on subagent IPCs + watch drain on viewer close
