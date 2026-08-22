# Context: ipc-bridge

**Purpose**: The trust boundary between the Electron main process (Node, full filesystem) and the renderer (Chromium, sandboxed). The renderer can only call what `preload.js` exposes via `contextBridge`; everything else is denied.

This file is the **canonical inventory** of the IPC surface. When you add a new IPC, you change three places — main handler, preload bridge, renderer caller — and every IPC name should appear here.

## Key files

| File | LOC | Role |
|---|---|---|
| `preload.js` | ~130 | The `contextBridge.exposeInMainWorld('api', {...})` block. Every renderer-facing function. |
| `main.js` | ~1850 | The `ipcMain.handle('<name>', ...)` and `ipcMain.on('<name>', ...)` handlers, scattered throughout. |

## Public surface (IPC inventory)

### Sessions (request/response)

| IPC | Args | Returns | Notes |
|---|---|---|---|
| `get-projects` | `(showArchived)` | `Project[]` | Sidebar payload. Reads from cache. |
| `get-active-sessions` | — | `{sessionId, busy}[]` | Currently open PTY sessions plus each one's live `_cliBusy` flag — see "Busy-state reconciliation" below. |
| `get-active-terminals` | — | `Terminal[]` | Active PTY identifiers |
| `open-terminal` | `(id, projectPath, isNew, sessionOptions)` | `{ok, error?, mcpActive}` | Spawn or attach a PTY. |
| `stop-session` | `(id)` | `{ok}` | Kill the PTY for `id`. |
| `toggle-star` | `(id)` | `{ok}` | Star/unstar in session_meta. |
| `rename-session` | `(id, name)` | `{ok}` | Set customTitle. |
| `archive-session` | `(id, archived)` | `{ok}` | Move to archive. |
| `read-session-jsonl` | `(sessionId)` | `Entry[]` | Full transcript. |
| `read-subagent-jsonl` | `(parentSessionId, agentId)` | `Entry[]` | Subagent transcript. |
| `list-subagents` | `(parentSessionId)` | `Subagent[]` | All children of a parent. |
| `start-subagent-watch` | `(parentSessionId, agentId)` | `watchId` | Begin tailing. |
| `stop-subagent-watch` | `(watchId)` | `{ok}` | Tear down watch. |

### Projects + worktrees

| IPC | Args | Notes |
|---|---|---|
| `browse-folder` | — | Native folder picker |
| `add-project` | `(projectPath)` | Register a project (creates folder index) |
| `remove-project` | `(projectPath)` | Hide a project from sidebar |
| `remap-project` | `(oldPath, newPath)` | **Atomic JSONL `cwd` rewrite**, refuses if active sessions exist. See PR #20. |
| `delete-worktree` | `(worktreePath)` | `git worktree remove` |
| `worktree-status` | `(worktreePath)` | Dirty-file count |

### Tabs (Memory / .work-files / Stats)

| IPC | Returns |
|---|---|
| `get-memories` | `{global, projects}` |
| `read-memory` / `save-memory` | content / `{ok}` |
| `get-work-files` | `{projects: WorkFilesProject[]}` — **dedupes by projectPath** since PR #15. Walks `<projectPath>/.work-files/` recursively, capped at 200 files per project. |
| `read-work-file` / `delete-work-file` | content (with `.work-files/` path guard) / `{ok}` |
| `get-stats-from-db` | `{dailyActivity, totalMessages, totalSessions, firstSessionDate, lastComputedDate}` — heatmap source since PR #7 |
| `refresh-stats` | `{stats, usage}` — combined; calls `getDailyActivity` + `fetchAndTransformUsage` |
| `get-usage` | rate-limits payload from Claude `/usage` |
| `get-stats` | `~/.claude/stats-cache.json` raw (legacy; kept for fallback) |

### Search

| IPC | Args | Returns |
|---|---|---|
| `search` | `(type, query, titleOnly)` | FTS5 result rows. `type ∈ {session, subagent, memory, work-file, null}` |
| `rebuild-cache` | — | Force a full re-index (heavy) |

### Settings

| IPC | Notes |
|---|---|
| `get-setting` / `set-setting` / `delete-setting` | Generic key/value over `settings` table |
| `get-effective-settings` | `(projectPath)` — resolves global + project overrides |
| `get-shell-profiles` | Configured shell list |
| `get-schedule-creator-command` / `create-schedule-session` / `run-schedule-now` | Schedule integration |

### File panel (IDE mode)

| IPC | Args |
|---|---|
| `read-file-for-panel` / `save-file-for-panel` | Arbitrary file IO inside the user's projects |
| `watch-file` / `unwatch-file` | fs.watch wrapper, emits `file-changed` event |

### Misc

| IPC | Notes |
|---|---|
| `open-external` | Opens https:// URLs in OS browser |
| `clipboard-write-text` | Main-process clipboard write (Wayland fix, PR #18) |
| `get-app-version` | From package.json |
| `updater-check` / `updater-download` / `updater-install` | electron-updater |

### Send (fire-and-forget, renderer → main)

| IPC | Notes |
|---|---|
| `terminal-input` | Forward keypress to PTY |
| `terminal-resize` | Resize PTY columns/rows |
| `close-terminal` | Renderer signals tab closed |
| `mcp-diff-response` | Diff accept/reject from MCP IDE mode |
| `activity-trace` | Renderer probe → the trace file. Registered **only** when `SWITCHBOARD_ACTIVITY_TRACE` is set (see below) |

### Events (main → renderer)

`terminal-data`, `session-detected`, `process-exited`, `terminal-notification`, `cli-busy-state`, `session-forked`, `subagent-spawned`, `subagent-completed`, `subagent-watch-event`, `projects-changed`, `status-update`, `indexing-progress`, `file-changed`, `mcp-open-diff`, `mcp-open-file`, `mcp-close-all-diffs`, `mcp-close-tab`, `updater-event`

- **`indexing-progress`**: `{coldStart, current, total, sessionsSoFar, done, error?}`. Fired only from `populateCacheViaWorker()` when the `initial_scan_complete` marker was absent at call time (a genuine first launch, a post-migration reset, or the resume of an interrupted first scan) — never on a routine warm-start rebuild. Throttled to ~4 events/s; the first event and the final `done:true` always pass. `done:true` with `error` means the scan failed and the renderer shows the failure in the banner instead of hiding it. Drives the renderer's dismissible first-run banner (`public/app.js`'s `updateIndexingBanner`); see `.ai/contexts/session-cache.md`.

## Invariants

- **No `nodeIntegration` in renderer**. The renderer can only call what's in `window.api`. `contextIsolation: true` is mandatory in BrowserWindow options.
- **Every IPC must validate its arguments** at the main-side handler. The renderer is trusted-ish (single user, single window) but a compromised renderer should not be able to escape the user's working directories.
- **Path-touching IPCs (`read-work-file`, `delete-work-file`, `read-memory`, etc.) MUST guard their paths**. Pattern: `path.resolve(input).includes('/.work-files/')` for the work-files IPC. Audit every new path IPC.
- **Trust boundary is the contextBridge call**. Anything passed across must survive structured-clone serialization. No functions, no DOM nodes, no class instances — only plain JSON.
- **Async handlers return promises**. Renderer uses `await window.api.foo(...)`. Throws cross the boundary as rejected promises; return `{ok, error}` if you want graceful failure handling on the renderer side.

## Non-obvious behaviors

- **`preload.js` is the *single* surface the renderer sees**. If you add `ipcMain.handle('xyz', ...)` but forget to add `xyz: () => ipcRenderer.invoke('xyz')` in preload, the renderer can't call it. Symptom: `window.api.xyz is not a function`.
- **Webcontents `send` events vs `invoke`**: `invoke`/`handle` is request-response (returns a promise). `send`/`on` is fire-and-forget (no return). Pick based on whether the caller needs the result.
- **`webUtils.getPathForFile(file)`** is the only way to get the absolute path of a drag-and-dropped file in Electron 28+. Exposed at `window.api.getPathForFile`.
- **Updater events use a single `onUpdaterEvent(type, data)` callback** for all 5+ event types — different from the per-event onSubagentSpawned/Completed pattern. Inconsistency tax.

### Busy-state reconciliation

`cli-busy-state` is emitted **strictly on transitions** (`main.js` OSC 0 / OSC 9;4 handlers only send when `session._cliBusy` flips). A renderer that misses one — reload, mis-keyed id, a `session-forked` re-key — stays wrong forever, because no further event is coming. That is why `get-active-sessions` carries `busy`: `pollActiveSessions()` (3s while any PTY runs, 30s otherwise) hands the snapshot to `reconcileBusyState()` in `public/session-activity.js`, which realigns `sessionBusyState` and the sidebar classes.

> `session-detected` (tempId → realId) has a preload bridge and an `app.js` listener but **no emitter in main today** — `session-transitions.js:336` only sends `session-forked`. The `rekeyActivityState` call in `onSessionDetected` is therefore unreachable; it is kept so the handler stays correct if the channel comes back, not because it runs.

Three things make that safe:

- **The response-ready lock only blocks idle.** `setActivity(id, true)` always writes, and drops the session from `responseReadySessions` — a session that resumed generating has no unread answer left to announce. `setActivity(id, false)` on a response-ready session is still ignored, so an unread marker survives duplicate idle signals. Before that split, a session that finished a turn off-screen and restarted without a click (cron, trigger-watcher, resume) had *every* subsequent busy event swallowed.
- **`cli-busy` and `response-ready` are mutually exclusive.** `applyActivityClasses()` is the only writer of either class. The cascade would in fact favour the spinner anyway (`.session-item.cli-busy:not(.needs-attention) .session-status-dot` carries `!important` and one more class than the response-ready rule that follows it in `style.css`), but the state, not the cascade, is what decides.
- **A poll reply cannot overwrite a fresher event.** `setActivity` bumps a monotonic counter per session; the poll snapshots it via `currentActivitySeq()` *before* the IPC round-trip and `reconcileBusyState` skips any session that moved in between.

### Activity trace: why the main process is the only writer

`activity-trace.js` + `public/activity-trace.js`, off unless
`SWITCHBOARD_ACTIVITY_TRACE` is set. User-facing docs:
[docs/activity-trace.md](../../docs/activity-trace.md).

The indicators above are produced by two processes with two clocks, and the
bugs in them are **ordering** bugs — a front that was emitted but not received,
a poll reply that overwrote a fresher event, a fork that re-keyed halfway. Two
log files cannot be interleaved after the fact with any confidence, so the
trace has a single writer: the renderer sends probes fire-and-forget over
`activity-trace`, and main stamps the sequence number and both timestamps on
arrival. Renderer entries therefore carry their *arrival* time in main, which
is the correct trade — `seq` is the ordering, `t` is only for eyeballing gaps.

Why not `log.debug`: `main.js` sets the file transport to `info` when packaged,
so the existing OSC 0 debug lines never reach disk in a build the user runs —
which is exactly why the question "what code point does the CLI put in the
title" was unanswerable from a production log and had to be settled by reading
the CLI binary. The trace has its own file and its own level, so it is readable
from a packaged build, and it records the renderer half that `log` never saw.

Two constraints shaped the API:

- **The off path must allocate nothing.** `enabled` is resolved once at require
  time and re-exported, so probes are `if (TRACE) trace(...)` /
  `if (window.ATRACE) window.atrace(...)` — the payload literal is never
  evaluated when the trace is off, and the IPC handler is not registered at
  all. The renderer probes go through `window.*` rather than bare globals so
  `session-activity.js` and `sidebar.js` stay loadable in the jsdom tests,
  which evaluate them without the trace file. This is the same discipline as
  [ADR 0002](../../docs/decisions/0002-discrete-steps-sidebar-animations.md):
  nothing that runs per render may do work.
- **The flag is parsed once.** `activity-trace.js` resolves
  `SWITCHBOARD_ACTIVITY_TRACE`; the preload is sandboxed and cannot require it,
  so main passes `--switchboard-activity-trace` via `additionalArguments` and
  the preload only checks `process.argv`. Re-parsing the env var in the preload
  would let the two halves disagree silently — a trace file with no
  `src:"renderer"` lines and no error. Likewise the output directory is
  `path.dirname(DB_PATH)`, never a second derivation of the env var (`db.js`
  documents that anti-pattern where it exports `DB_PATH`).
- **The probes must stay one line each.** The interesting sites live in files
  that other branches touch (`session-transitions.js`, `public/sidebar.js`),
  so every probe is a single inserted statement and all the logic —
  formatting, code-point rendering, the decision helpers that mirror the OSC
  branches — lives in the trace module where it is unit-tested.

Subagent probes follow the detector's own vocabulary rather than the IPC's: a
transcript first seen already stale produces `subagent.assumed-finished` and no
event at all, and if that assumption is later retracted inside the recheck
window the withheld spawn shows up as `subagent.rehabilitated`. Both are silent
in every other channel — see `.ai/contexts/subagent-observability.md` for the
mechanism they instrument. On the renderer side `recv.subagent-spawned` carries
`applied`, because a heartbeat for an agent the sidebar is not tracking is
dropped on purpose and that non-effect is the diagnostic.

`busyDecision` / `progressDecision` duplicate the conditions in `main.js` on
purpose: the trace also records the emissions themselves, so a divergence
between the predicted verdict and the `busy.emit` that follows shows up in the
file instead of being invisible.

`setActivity(sessionId, active, via)` — the third argument is trace-only
attribution (which caller asked for the write) and is inert when the trace is
off.

## If you change this, also check

- **Three places per new IPC**: handler in `main.js`, bridge entry in `preload.js`, caller in `public/*.js` (and maybe `eslint.config.js` if you expose a new global).
- `eslint.config.js` `rendererCrossFileGlobals` — renderer functions exposed across `<script>` tags must be declared
- Any new event needs both an `ipcRenderer.on` in preload and an `mainWindow.webContents.send` in main
- If you change argument shapes, the renderer callers break silently (no type check) — search for callers before changing signatures

## How to add a new IPC

1. `main.js`: `ipcMain.handle('my-thing', (_event, arg1, arg2) => { /* validate, do, return */ })` — place near related handlers, not at random.
2. `preload.js`: `myThing: (arg1, arg2) => ipcRenderer.invoke('my-thing', arg1, arg2)` — add to the alphabetical-ish block.
3. Renderer: `const result = await window.api.myThing(...)`
4. Test: prefer a unit test for the main-side logic (extract to a pure function the handler calls); jsdom integration tests for renderer side.
5. Document here.
