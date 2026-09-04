# Context: ipc-bridge

**Purpose**: The trust boundary between the Electron main process (Node, full filesystem) and the renderer (Chromium, sandboxed). The renderer can only call what `preload.js` exposes via `contextBridge`; everything else is denied.

This file is the **canonical inventory** of the IPC surface. When you add a new IPC, you change three places — main handler, preload bridge, renderer caller — and every IPC name should appear here.

## Key files

| File | LOC | Role |
|---|---|---|
| `preload.js` | ~150 | The `contextBridge.exposeInMainWorld('api', {...})` block. Every renderer-facing function. |
| `main.js` | ~2600 | The `ipcMain.handle('<name>', ...)` and `ipcMain.on('<name>', ...)` handlers, scattered throughout. |
| `schedule-ipc.js` | ~220 | **Also registers IPC handlers** (`get-schedule-creator-command`, `create-schedule-session`, `run-schedule-now`) — `init()` is called from `main.js`, but a `main.js`-only search for `ipcMain.handle` misses these three. Audit both files. |

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
- **Path-touching IPCs (`read-work-file`, `delete-work-file`, `read-memory`, `run-schedule-now`, `delete-worktree`, etc.) MUST guard their paths, and the guard must resolve on disk, not just `path.resolve()`**. `path.resolve()` normalises `..` but does not follow symlinks — a path can look contained by every string check and still open a file somewhere else through a symlinked directory. The shared primitive is `resolveOnDisk()` in `resolve-path-on-disk.js` (realpath, or `null` when nothing exists there yet); it is called *inside* the guards, not duplicated at each call site:
  - `isSensitivePath` / `isAllowedMemoryPath` / `isKnownProjectRoot` (`ipc-path-validator.js`) — denylist, allowlist, and exact-match-against-known-projects, used by the memory, file-panel and worktree handlers.
  - `resolveDeletionTargets` (`delete-session-target.js`) — session deletion, the first handler to need this and the source the primitive was extracted from.
  - `resolveRunNowTarget` (`run-schedule-now-target.js`) — `run-schedule-now`'s shape + allowlist check, run before any read or spawn.
  Work-files still use the narrower `.includes('/.work-files/')` substring check — same weakness against a symlinked ancestor, not yet migrated (see "IPC path-guard inventory" below). A handler that reads *content* back to the renderer (file panel, memory) and a handler that only decides *whether to run a command* (`run-schedule-now`) both need a guard, and neither one is safe with `path.resolve()` alone.
- **Trust boundary is the contextBridge call**. Anything passed across must survive structured-clone serialization. No functions, no DOM nodes, no class instances — only plain JSON.
- **Async handlers return promises**. Renderer uses `await window.api.foo(...)`. Throws cross the boundary as rejected promises; return `{ok, error}` if you want graceful failure handling on the renderer side.
- **Never call a method on `session.pty` directly.** Go through `pty-ops.js` (`resizePty` / `killPty` / `writePty`, or the generic `withPty`). See "PTY operations race the exit" below.

### IPC path-guard inventory

Every handler that takes a renderer-supplied path or derives a spawn location from one, and what guards it as of this pass:

| IPC | Guard | Kind |
|---|---|---|
| `read-memory` / `save-memory` | `isAllowedMemoryPath` | disk-resolved allowlist |
| `open-path` / `read-file-for-panel` / `save-file-for-panel` / `watch-file` | `isSensitivePath` | disk-resolved denylist |
| `delete-worktree` / `worktree-status` | `WORKTREE_PATH_RE` (shape) + `isKnownProjectRoot` (disk-resolved exact match) | shape + disk-resolved allowlist |
| `delete-session-preview` / `delete-session` | `resolveDeletionTargets` (`delete-session-target.js`) | disk-resolved containment |
| `run-schedule-now` | `resolveRunNowTarget` (`run-schedule-now-target.js`), which composes filename shape + `isAllowedMemoryPath` | disk-resolved allowlist — **the only handler in the app that both reads a file and spawns a process from a renderer-supplied path; had no guard at all before this pass** |
| `read-work-file` / `delete-work-file` | `.includes('/.work-files/')` substring | ad hoc string, **not disk-resolved** — a symlinked ancestor defeats it the same way it defeated `isSensitivePath`/`isAllowedMemoryPath` before they were fixed here. Not migrated in this pass; same fix shape (`resolveOnDisk` + a `.work-files` component check instead of a substring test) would close it |
| `read-activity-trace-file` / `delete-activity-trace-file` | `resolveTraceFilePath` (`activity-trace.js`) | ad hoc string (directory + basename pattern), **not disk-resolved** — narrower surface (one generated file family) lowers the stakes, not migrated |
| `add-project` / `remap-project` | none on the probe (`fs.statSync`/`fs.existsSync`/`fs.lstatSync`); the actual write is confined through `encodeProjectPath` | existence/type oracle only — inherent to the feature (both accept an arbitrary disk location by design), not cheaply fixable without breaking it |
| `open-terminal` (`preLaunchCmd`) | `validatePreLaunchCmd` (`pre-launch-cmd-guard.js`) | not a path guard — a shell-metacharacter denylist on a raw-shell-by-design string; see the invariant above it's filed under |
| `read-session-jsonl` / `read-subagent-jsonl` / `start-subagent-watch` / `create-schedule-session` | none directly — path is derived from a SQLite key or built via `encodeProjectPath`, not taken verbatim from the renderer | out of scope for a path guard; flag if a renderer-controlled string is ever found reaching the derivation unencoded |

### Non-obvious behaviors

- **`preload.js` is the *single* surface the renderer sees**. If you add `ipcMain.handle('xyz', ...)` but forget to add `xyz: () => ipcRenderer.invoke('xyz')` in preload, the renderer can't call it. Symptom: `window.api.xyz is not a function`.
- **Webcontents `send` events vs `invoke`**: `invoke`/`handle` is request-response (returns a promise). `send`/`on` is fire-and-forget (no return). Pick based on whether the caller needs the result.
- **`webUtils.getPathForFile(file)`** is the only way to get the absolute path of a drag-and-dropped file in Electron 28+. Exposed at `window.api.getPathForFile`.
- **Updater events use a single `onUpdaterEvent(type, data)` callback** for all 5+ event types — different from the per-event onSubagentSpawned/Completed pattern. Inconsistency tax.

### PTY operations race the exit

`session.exited` is set from `ptyProcess.onExit`, which fires on a later tick
than the child's actual death. So `if (!session.exited) session.pty.resize(...)`
is a check-then-act: node-pty can still throw `Cannot resize a pty that has
already exited` between the test and the call. In a `ipcMain.on` handler that
throw is fire-and-forget — nothing awaits it, so it surfaces as an uncaught
exception in the main process and Electron pops the "A JavaScript error occurred
in the main process" dialog at the user.

The path that produced it: the user closes a session → the PTY exits → the
renderer re-lays out the remaining terminals and emits one `terminal-resize` per
tile, including for the session that just went away.

`pty-ops.js` is the single place a session PTY is touched. It keeps the liveness
check as a cheap fast path but wraps the call, the way `trigger-watcher.js`
already reasoned about its writes ("an exit between the liveness probe and the
write is bounded by the try/catch on the write"). Callers get a boolean instead
of an exception; the first-resize nudge uses it to skip its follow-up when the
PTY is already gone.

Swallowed errors are not silent: `setPtyOpLogger(log)` in `main.js` routes them
to `log.debug` as `[pty] <op> skipped session=<id> reason=<message>`. Debug level
is deliberate — the file transport is at `info` in packaged builds, so a resize
storm against a dying PTY costs nothing in production, and the line is there in
dev when someone next has to diagnose this.

Not covered by `pty-ops.js`, on purpose: `trigger-watcher.js` writes (already
bounded by their callers' try/catch, plus a `process.kill(pid, 0)` liveness
probe) and the `clear` shim write in `open-terminal`, which happens before a
session object exists.

### Busy-state reconciliation

`cli-busy-state` is emitted **strictly on transitions** (`main.js` OSC 0 / OSC 9;4 handlers only send when `session._cliBusy` flips). A renderer that misses one — reload, mis-keyed id, a `session-forked` re-key — stays wrong forever, because no further event is coming. That is why `get-active-sessions` carries `busy`: `pollActiveSessions()` (3s while any PTY runs, 30s otherwise) hands the snapshot to `reconcileBusyState()` in `public/session-activity.js`, which realigns `sessionBusyState` and the sidebar classes.

> `session-detected` (tempId → realId) has a preload bridge and an `app.js` listener but **no emitter in main today** — `session-transitions.js:427` only sends `session-forked`. The `rekeyActivityState` call in `onSessionDetected` is therefore unreachable; it is kept so the handler stays correct if the channel comes back, not because it runs.

Three things make that safe:

- **The response-ready lock only blocks idle.** `setActivity(id, true)` always writes, and drops the session from `responseReadySessions` — a session that resumed generating has no unread answer left to announce. `setActivity(id, false)` on a response-ready session is still ignored, so an unread marker survives duplicate idle signals. Before that split, a session that finished a turn off-screen and restarted without a click (cron, trigger-watcher, resume) had *every* subsequent busy event swallowed.
- **`cli-busy` and `response-ready` are mutually exclusive.** `applyActivityClasses()` is the only writer of either class. The cascade would in fact favour the spinner anyway (`.session-item.cli-busy:not(.needs-attention) .session-status-dot` carries `!important` and one more class than the response-ready rule that follows it in `style.css`), but the state, not the cascade, is what decides.
- **A poll reply cannot overwrite a fresher event.** `setActivity` bumps a monotonic counter per session; the poll snapshots it via `currentActivitySeq()` *before* the IPC round-trip and `reconcileBusyState` skips any session that moved in between.

### The OSC 0 title is the primary busy channel

Two channels can raise `session._cliBusy`, and they are not interchangeable:

- **The OSC 0 title.** The CLI always sets it, so this is the channel that has
  to work. Classification lives in `classify-title-activity.js`.
- **OSC 9;4 progress.** Only emitted when the CLI's `terminalProgressBarEnabled`
  setting is on. It stays wired as a second opinion; it must never be the only
  one, because a user preference can switch it off and nothing would report it.

`classifyTitleActivity(title, { allowFallback })` looks at the first code point:

| First code point | Verdict | Rule name |
|---|---|---|
| `✳` U+2733 | idle | `idle-glyph` |
| U+2800–U+28FF (braille frames) | busy | `glyph` |
| U+25D0–U+25D3 (`◐◑◒◓`) | busy | `glyph` |
| any other non-ASCII, followed by a space and a non-empty title | busy | `fallback` |
| ASCII, or a bare non-ASCII word | no decision | `null` |

**The glyph list is coupling to a third party's private rendering choice, and it
has already broken once.** Until 2026-08-22 the busy test accepted braille only.
The CLI had moved to half-circle frames, so the title could *clear* the busy
state (`✳` still matched) but never *set* it, and the spinner survived only
because OSC 9;4 happened to be on. The activity trace
`~/.switchboard/activity-trace-20260822-181759.jsonl` is the evidence. Counted
over a fixed window — its first ten minutes, `wall` from `16:18:00Z` to
`16:28:00Z`, because the file keeps growing for as long as the variable stays
set and bare totals would not reproduce — it holds 628 `osc.title` entries: 312
starting U+25D0, 311 U+25D1, 3 `✳`, 2 bare `claude`, and no braille at all. 625
of them were logged `decision: "ignored:no-match"`. Both `busy.emit` lines with
`busy: true` in that window carry `via: "osc9.4"`. Not one busy transition came
from the title.

That is why the closed list has a net under it. The `fallback` rule assumes any
single non-ASCII code point used as a title prefix is a status indicator, which
is what a prefix in that position is for. Weighing the false positives:

- A word starting with an accent or a CJK character (`Éditeur de texte`) does not
  match — the rule needs the first code point to stand alone before a space.
- An emoji-prefixed title from a shell prompt or a task runner *would* match. The
  cost is bounded but real: only a `✳` title clears `_cliBusy`, so a wrong busy
  sticks until the CLI next reports idle — the next turn, for a Claude session.
  `main.js` passes `allowFallback: !session.isPlainTerminal`, so the generic rule
  never fires on a plain terminal in the first place.
- The alternative — a closed list with no net — fails silently and stays broken
  for as long as nobody notices the spinner missing. A stuck spinner is visible;
  a spinner that never lights is not.

**What that guard does not cover.** `allowFallback` gates the `fallback` rule
only; the `glyph` branch runs for every session. A plain terminal whose title
starts with a code point from the ranges above — braille, or one of `◐◑◒◓` — is
marked busy like any other, and since a plain terminal never emits `✳` nothing
on the title path clears it: the state survives until the PTY exits, at which
point `updateRunningIndicators()` in `public/app.js` drops `cli-busy` along with
`has-running-pty`. That is a decision, not an oversight — the ranges are narrow,
the *title* has to carry the glyph (a spinner printed to stdout is not a title),
and the braille half of the exposure predates this change. It is not free
either: U+25D0–U+25D3 is `circleHalves` from the `cli-spinners` package, which
other tools draw from, so widening the ranges widened this too.
`test/classify-title-activity.test.js` pins the behaviour, so whoever tightens
it later knows they are reversing a decision rather than fixing an omission.

To recheck after a CLI upgrade, run a session under `SWITCHBOARD_ACTIVITY_TRACE=1`
(see `docs/activity-trace.md`) and count where busy comes from:

```bash
grep '"cat":"osc.title"' ~/.switchboard/activity-trace-*.jsonl \
  | sed 's/.*"cp":"\([^ ]*\).*/\1/' | sort | uniq -c   # leading code points
grep '"cat":"busy.emit"' ~/.switchboard/activity-trace-*.jsonl \
  | grep '"busy":true' | sed 's/.*"via":"\([^"]*\)".*/\1/' | sort | uniq -c
```

Healthy output has busy emissions attributed to `osc0`, and the `rule` field on
`osc.title` lines reading `glyph` rather than `fallback`. `rule: "fallback"` on
every spinner frame means the CLI changed its glyphs again and the range table
should be extended; `ignored:no-match` on titles that clearly carry a prefix
means the fallback itself has regressed.

**The title says busy; it never says why.** While the CLI waits on background
agents it keeps animating the same spinner and never writes a `✳` title. Same
trace, session `6577a487`: busy at `16:18:51Z` via `osc9.4`, then ◐/◑ frames and
not one idle title for the rest of the ten-minute window — nine minutes in which
"generating" and "waiting for my agents" are the same signal. It does draw the
distinction in its own status line ("✻ Waiting for 1 background agent to
finish") and has a tri-state channel for it (OSC 21337, idle/busy/waiting), but
that channel is disabled in the shipped binary, so nothing reaches us. Switchboard therefore
does not claim the distinction: the sidebar tints the busy spinner violet when
subagents are live, which asserts only that both things are true at once — see
`docs/subagents.md`, "Live status".

### Activity trace: why the main process is the only writer

`activity-trace.js` + `public/activity-trace.js` + `public/activity-trace-panel.js`,
off by default. `SWITCHBOARD_ACTIVITY_TRACE` sets the state at startup; Settings
→ Diagnostics switches it at runtime and stores the choice. User-facing docs:
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

- **The off path must allocate nothing.** The module exports its state as an
  object, `{ on }`, so probes are `if (TRACE.on) trace(...)` /
  `if (window.ATRACE) window.atrace(...)` — one property load, and the payload
  literal is never evaluated when the trace is off. An object rather than a
  boolean because the state is now switchable at runtime: a destructured
  `const { enabled: TRACE }` would freeze the flag at require time and pin
  every probe to the launch environment. The renderer probes go through
  `window.*` rather than bare globals so `session-activity.js` and
  `sidebar.js` stay loadable in the jsdom tests, which evaluate them without
  the trace file. This is the same discipline as
  [ADR 0002](../../docs/decisions/0002-discrete-steps-sidebar-animations.md):
  nothing that runs per render may do work.
- **The switch must not need a restart.** Restarting to arm a diagnostic
  destroys the state it was meant to observe, so `set-activity-trace-enabled`
  flips the module state, opens or flushes-and-closes the file, persists the
  choice into the `global` settings row, and pushes the new state to the
  renderer on `activity-trace-state`. The `activity-trace` handler is
  therefore registered unconditionally — a listener added on demand would not
  exist in the window that was created while the trace was off — and `trace()`
  drops the line itself while off.
- **The flag is parsed once.** `activity-trace.js` resolves
  `SWITCHBOARD_ACTIVITY_TRACE`; the preload is sandboxed and cannot require it,
  so main passes `--switchboard-activity-trace` via `additionalArguments` and
  the preload only checks `process.argv` for the *startup* value. Re-parsing
  the env var in the preload would let the two halves disagree silently — a
  trace file with no `src:"renderer"` lines and no error. The env var stays the
  startup path (it wins over the stored preference when set, in either
  direction) and nothing else reads it. Likewise the output directory is
  `path.dirname(DB_PATH)`, never a second derivation of the env var (`db.js`
  documents that anti-pattern where it exports `DB_PATH`).
- **The control channels are path-narrow.** `list-activity-trace-files`,
  `read-activity-trace-file` and `delete-activity-trace-file` accept only paths
  whose directory is the trace directory and whose basename matches the segment
  name pattern — an allowlist of exactly one directory, tighter than
  `isSensitivePath`, because the legitimate surface here is a single generated
  file family. Both the check (`resolveTraceFilePath`) and the capped read
  (`readTraceTail`) live in `activity-trace.js` rather than inline in the
  handler, for the same reason `fts-match.js` and `terminal-input.js` do:
  a handler body cannot be unit-tested without booting Electron, and these two
  carry the parts worth testing — a non-string path must answer `null` rather
  than throw (a rejected invoke leaves the button dead with no message), and a
  file that shrinks between the `stat` and the `read` must not come back as
  megabytes of NUL presented as trace content. Deleting the segment currently
  being written is refused rather than attempted; `currentFile` follows the
  stream, so switching debug mode off releases it immediately.
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
