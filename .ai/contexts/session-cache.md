# Context: session-cache

**Purpose**: index every Claude session JSONL on disk into a queryable SQLite cache so the sidebar renders without re-scanning `~/.claude/projects/` and so search is full-text. Watches the projects directory for changes and refreshes incrementally.

## Key files

| File | LOC | Role |
|---|---|---|
| `db.js` | ~450 | SQLite (better-sqlite3) schema + prepared statements. Owns `session_cache`, `session_meta`, `cache_meta`, `settings`, `search_fts` (FTS5 + trigram tokenizer). |
| `session-cache.js` | ~525 | Indexer + watcher. Reads `~/.claude/projects/<folder>/*.jsonl` (+ subagents subdir), populates rows, emits projects-changed events. |
| `read-session-file.js` | ~280 | Streaming JSONL reader. `readSessionFile()` (full) + `readSessionDisplayHeader()` (256 KB / 500 lines — cheap header for huge files). |
| `encode-project-path.js` | 14 | `/path/to/project` → `-path-to-project` folder name. Mirrors Claude CLI's encoding. |
| `derive-project-path.js` | 64 | Inverse: read `cwd` field from JSONL, derive original projectPath. **Collapses worktrees back to parent repo** via `resolveWorktreePath`. |

## Public surface

From `db.js`:

- **Sessions**: `getAllCached`, `getCachedByFolder(folder)`, `getCachedByParent(parentSessionId)`, `getCachedSession(sessionId)`, `upsertCachedSessions(rows[])`, `deleteCachedSession`, `deleteCachedFolder`
- **Meta**: `getMeta`, `getAllMeta`, `setName`, `toggleStar`, `setArchived` (session-level user state)
- **Folder meta**: `getFolderMeta`, `setFolderMeta(folder, projectPath, indexMtimeMs)` — tracks index freshness
- **Search**: `searchByType(type, query, limit, titleOnly)`, `upsertSearchEntries`, `deleteSearchType/Session/Folder`
- **Stats**: `getDailyActivity()` — `GROUP BY substr(modified, 1, 10)`, returns `[{date, messageCount, sessionCount}]` (heatmap source)
- **Settings**: `getSetting`, `setSetting`, `deleteSetting`
- **Misc**: `touchCachedModified(sessionId)` — 1-column UPDATE, cheap

From `session-cache.js`:

- `init(ctx)` — wire main process → cache (mainWindow ref for IPC events)
- `refreshFolder(folder, opts)` — opts `{files: Set<string>}` for targeted refresh (watcher payload). Defaults to full folder walk.
- `populateCacheFromFilesystem()` / `populateCacheViaWorker()` — initial scan / re-scan. The worker (`workers/scan-projects.js`) streams one `{type:'folder', result, current, total}` message per on-disk folder (plus a final `{type:'done'}`) instead of buffering the whole tree, so each folder is written to the DB and pushed to the renderer as soon as it's read — a large history no longer leaves the sidebar empty for the entire scan.
- `buildProjectsFromCache(showArchived)` — produces the sidebar payload (sorted, grouped by project, missing flag computed here)
- `notifyRendererProjectsChanged()` — throttled (~1.5s leading-edge) push to renderer
- `sendIndexingProgress()` (internal) — emits the `indexing-progress` IPC event, gated on `coldStart` (captured once at the top of `populateCacheViaWorker()` via `!isInitialScanComplete()`) and throttled to ~4 events/s (the first event and every `done:true` always pass). Feeds the renderer's first-run banner; see `.ai/contexts/ipc-bridge.md`. A `done:true` payload carrying `error` keeps the banner visible with the failure message instead of hiding it.

From `derive-project-path.js`: `deriveProjectPath(folderPath)`, `resolveWorktreePath(cwd)`.

## Invariants

- **`modified` is always ISO8601 string** (`2026-05-22T20:59:33.000Z`). `substr(modified, 1, 10)` is the canonical "day" derivation. Don't switch to epoch ms without migrating.
- **`session_cache.folder` is the encoded form** (`-home-jean-baptiste-workspace`). Use `encodeProjectPath()` to derive it from an absolute path.
- **WAL mode is enabled on SQLite open** — multiple readers OK; serialise writes. Concurrent writers will fail with `SQLITE_BUSY`.
- **`refreshFolder` is idempotent** — calling it twice with the same `opts.files` is safe; the `filePathToDbId` inverted index makes lookups O(1).
- **Header-only refresh** (via `readSessionDisplayHeader`) merges with the cached row to preserve `textContent`, `aiTitle`, etc. Don't overwrite cached fields with `null` from a partial read.
- **FTS entries follow `{id, type, folder, title, body}`** shape. `type` is one of `'session'`, `'subagent'`, `'memory'`, `'work-file'`. Mixing types within one upsert is fine.
- **`get-projects` never awaits the cold-start scan.** `main.js`'s handler fires `populateCacheViaWorker()` without `await` when the cache is empty, returning whatever's cached right now (still non-empty for project *names* — `buildProjectsFromCache` lists on-disk directories synchronously even with zero indexed sessions). Progressive fill-in relies entirely on `notifyRendererProjectsChanged()` firing per folder. Don't reintroduce the `await` — it's what caused the multi-minute blocking "Loading…" on a large `~/.claude/projects/`.
- **"Cache has rows" does not mean "initial scan finished".** The worker streams one DB write per folder, so killing the app mid-first-scan leaves `session_cache` partially populated. The authoritative signal is the `initial_scan_complete` settings key: written by `session-cache.js` only on the worker's final successful `done` message, backfilled once by migration v8 for pre-marker installs (their populated caches could only come from completed batch-write scans), cleared whenever the schema-reconciliation pass wipes the cache. `get-projects` treats "rows present but marker absent" as an interrupted scan: it resumes the background worker (safe — each folder message is delete-then-insert, so re-scanned folders never duplicate) and must NOT run the synchronous `reconcileCacheFromFilesystem()` sweep, which would re-parse every missing folder on the main thread. While the marker is absent, `buildProjectsFromCache`'s empty-dir fallback also skips `deriveProjectPath()` (per-folder readdir + 256 KB read) in favor of a zero-I/O best-effort decode of the folder name (`decodeProjectFolderBestEffort`), never persisted to `cache_meta`.

## Non-obvious behaviors

- **`resolveWorktreePath` collapses `<repo>/.worktrees/<name>` → `<repo>`** when the parent dir exists. Consequence: many `~/.claude/projects/-home-...workspace-myproject--worktrees-X` folders derive to the same projectPath. Callers must dedupe (see `get-work-files` IPC for the pattern).
- **Two-table sidebar payload**: projects are aggregated, but each session row has its own `subagentType` field. A `null`/empty `subagentType` means it's a parent session; anything else (e.g. `'general-purpose'`, `'researcher'`) marks a subagent.
- **`fs.watch` debouncing**: the watcher batches per-folder events in a `pendingChanges = Map<folder, Set<filename> | true>` for ~200 ms before flushing to `refreshFolder`. A `true` value means "full walk needed" (rare path).
- **A session's title comes from its first *real* user turn, and a transcript without one is not indexed.** `classifyUserText()` in `read-session-file.js` sorts each user record into `prompt` / `command` / `skip`. `skip` is local-command bookkeeping (`<bash-input>`, `<bash-stdout>`, `<local-command-caveat>`, `<local-command-stdout>` — the CLI writes a command's own output back as a `user` record too); `command` is a bare slash-command record (`<command-name>/clear</command-name>…`). This matters because **`/clear` and `/model` do not stay in the current transcript — the CLI opens a NEW jsonl and writes only that bookkeeping into it**. Taking a `command` record as the summary therefore (a) titled every session started by `/clear` "`/clear clear </com…`" (the raw tags survive `cleanDisplayName`'s tag strip as a truncated fragment) and (b) indexed the bookkeeping-only transcript as a phantom sidebar session that the user never started. A `command` record is now a *fallback* title, used only when the transcript also holds an assistant turn (`/code-review high` → a real headless-command session); with no assistant turn both readers return `null` and nothing is indexed, matching how a brand-new session stays out of the sidebar until its first prompt. Rows written by the pre-fix parser cannot self-heal — the phantom ones sit on a file that never changes again, and the real ones keep the bad title because the header-only refresh path only overwrites a summary it can re-derive — so `db.js` migration **v9** purges rows whose summary starts with `<command-name>` or `<local-command-stdout>`, plus the `cache_meta` gate of their folders, which makes the next reconcile re-read exactly those files.
- **Stats `firstSessionDate`** is computed from `MIN(modified)`, not `MIN(created)`. Old sessions touched by recent reads keep their original `created` but their `modified` reflects the latest indexing — by design (the heatmap measures activity, not creation).

- **`main.js`'s `ctx.db` is a hand-built allow-list, not a spread of `db.js`.** `main.js` (~line 323) passes `sessionCache.init({ ..., db: { deleteCachedFolder, getCachedByFolder, upsertCachedSessions, ... } })` as an explicit object literal — it does **not** do `db: require('./db')`. If you add a new function to `db.js` and call it from `session-cache.js` via `ctx.db.<name>`, but forget to add it to both this literal *and* the `require('./db')` destructure at the top of `main.js`, `ctx.db.<name>` is `undefined`. The resulting `TypeError` is thrown inside `populateCacheViaWorker`'s `worker.on('message')` handler, which has no `try/catch` — it lands on stderr (not `electron-log`) and silently aborts the cold-start indexing write loop. Symptom: the log shows `Indexing N projects…` but never `Indexed N sessions across …`, and the affected table stays empty. Guarded by `test/main-ctx-db-wiring.test.js` (static source-grep asserting the allow-list ⊇ every `ctx.db.*` dereference in `session-cache.js`) — run it whenever you touch this boundary, but also update the allow-list by hand since the test only catches *missing* entries, not the intent.

- **`search` IPC is routed through a dedicated worker thread, with a bounded query.** Historically `ipcMain.handle('search', ...)` ran the `better-sqlite3` FTS5 `MATCH` query synchronously on the Electron main process — a long pasted string (e.g. a GitLab MR URL) became a ~58-trigram phrase intersect that pinned the main thread for up to ~60 s and froze the whole app (witnessed 2026-06-22). Two guards now exist: (1) `searchByType()` in `db.js` truncates the query to `FTS_QUERY_MAX_CHARS` (48) before building the MATCH expression; (2) the `search` IPC goes through `searchViaWorker` (`search-worker-client.js` + `workers/search-query.js`) so even a slow query can't block IPC dispatch. The client falls back to the synchronous main-thread `searchByType` only when the worker isn't ready (first-launch race, or circuit-breaker open after repeated worker failures) — the length cap makes that fallback safe. Protocol logic (correlation IDs, drain, backoff, restart storm guard) is unit-tested in `test/search-worker-protocol.test.js`; the cap in `test/db-search-query-bound.test.js`.

## If you change this, also check

- `derive-project-path.test.js` — covers the worktree-collapse + cwd extraction paths
- `db-daily-activity.test.js` — covers heatmap aggregation
- `read-session-file.test.js` — covers header parsing
- `read-session-file-slash-command.test.js` — covers the `/clear` bookkeeping transcript and slash-command titles
- `db-purge-command-summaries.test.js` — covers migration v9's surgical purge
- `main-ctx-db-wiring.test.js` — covers the `ctx.db` allow-list ⊇ session-cache.js usage invariant above
- IPC consumers of cached payloads: `get-projects`, `get-active-sessions`, `search`, `get-stats-from-db`, `get-work-files`, `list-subagents`, `read-session-jsonl`
- Renderer: `public/sidebar.js` (consumes `buildProjectsFromCache` output), `public/stats-view.js` (consumes `getDailyActivity`)
- If you add a new `session_cache` column, update the SELECT in `getCachedByFolder` — it's `SELECT *` so additions land automatically, but the renderer needs to know about them.

## Schema reference

```
session_cache(sessionId PK, folder, projectPath, summary, firstPrompt,
              created, modified, messageCount, slug, aiTitle,
              parentSessionId, agentId, subagentType, description)
session_meta(sessionId PK, customTitle, starred, archived)
cache_meta(folder PK, projectPath, indexMtimeMs)
search_fts USING fts5(id, type, folder, title, body, tokenize='trigram')
search_map(id PK, type, folder)   -- backref for FTS delete
settings(key PK, value JSON)
```
