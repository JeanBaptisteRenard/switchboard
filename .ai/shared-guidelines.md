# Switchboard — Notes for Claude (and other AI agents)

This is JB's fork (`devsuitup/switchboard`, transferred from `JeanBaptisteRenard/switchboard` on 2026-08-11) of `doctly/switchboard`. The fork carries features not (yet) upstream — read this before editing anything.

Switchboard is an **Electron desktop app**: renderer + main-process, no Domain/Application/Infrastructure layering. Runtimes (npm, node) run directly on the host — nothing here is Dockerised. CI is GitHub Actions (check status via `gh pr checks`); the `gh` CLI is used for PRs, not `glab`. The husky pre-commit hook runs `task check` automatically. Commit style is a loose `feat(scope): ...` / `fix(scope): ...`, with no strict footer rules.

## Quick orientation

| You want to… | Read first |
|---|---|
| Run / build the app | [README.md "Tooling"](../README.md) (task commands) |
| Change Electron main / IPC | [contexts/ipc-bridge.md](contexts/ipc-bridge.md), then `main.js`, `preload.js` |
| Change SQLite, indexing, watcher, FTS, heatmap | [contexts/session-cache.md](contexts/session-cache.md) |
| Change schedule cron / `.md` files / schedule spawn | [contexts/schedule-runner.md](contexts/schedule-runner.md) |
| Change subagent grouping, transcript view, parent→child | [contexts/subagent-observability.md](contexts/subagent-observability.md) |
| Read the Claude CLI's own session state files | [contexts/cli-session-state.md](contexts/cli-session-state.md) |
| Change Memory/.work-files panels (CodeMirror) | [contexts/viewer-panel.md](contexts/viewer-panel.md) |
| Change the renderer (sidebar, terminal, app.js) | `public/*.js` — entry is `app.js` |
| Write a test | `test/*.test.js` — node:test + jsdom for renderer files |
| Working practices for AI agents (HANDOFF format, shell pitfalls, review loop) | [agent-practices.md](agent-practices.md) |

For a guided tour of the codebase architecture, start at [contexts/README.md](contexts/README.md).

## Critical invariants for AI agents

### 1. Don't spawn a second Electron while JB's AppImage is running

The user runs `~/Applications/Switchboard.AppImage` daily. **PR #13 (`requestSingleInstanceLock`) means a second `npx electron .` from your worktree quits immediately and focuses the user's window** — your dev session never starts. Use `SWITCHBOARD_DATA_DIR` isolation if you genuinely need a live process, otherwise stay read-only / unit-test-driven.

```bash
# Dev electron with its own DB so it doesn't fight the AppImage:
SWITCHBOARD_DATA_DIR=~/.switchboard-dev task dev
# Or just:
task dev   # Taskfile already sets SWITCHBOARD_DATA_DIR=~/.switchboard-dev by default
```

The AppImage uses `~/.switchboard/switchboard.db`. The dev electron uses `~/.switchboard-dev/switchboard.db`. They cannot collide.

To test a specific PR live, alongside the running AppImage, use `task test-pr PR=<number>` — it isolates the DB, the automation triggers dir, and warns about the schedule-runner duplicate-fire risk. See [docs/testing-a-pr.md](docs/testing-a-pr.md) for the full procedure; do not improvise the isolation env vars by hand.

### 2. Running `npm run build:linux` CAN kill the running instance — and so can the `cp` to ~/Applications

**Corrected 2026-05-31** — the previous version of this section claimed the build was safe. It isn't.

`npm run build:linux` invokes `electron-builder`, which by default runs `@electron/rebuild` against the native modules (`better-sqlite3`, `node-pty`). Those `.node` files are `dlopen()`-loaded by the running AppImage. If the rebuild replaces them via `truncate+write` (instead of atomic `rename`), the running process loses access to its native binding at the next call → segfault → kernel SIGKILL with no app-level trace in `~/.config/switchboard/logs/main.log`.

**Witnessed 2026-05-31** — running AppImage went silent in main.log between `13:49:42` and `13:58:42` during a background `npm run build:linux`. No SIGTERM logged. User noticed the death and relaunched manually.

**Rules**:
- **NEVER run `npm run build:linux` (or `task build`) while the user's AppImage is running** without explicit confirmation. Ask first. The user may need to quit before you start the build.
- **Building while running IS safe with `--config.npmRebuild=false`** (`npm run bundle:codemirror && electron-builder --linux --config.npmRebuild=false`): electron-builder logs `skipped dependencies rebuild` and never rewrites the `dlopen()`-loaded `.node` files. Field-proven 2026-06-02 (×2) and 2026-06-04 — the live process survived every build.
- The **`cp dist/*.AppImage ~/Applications/Switchboard.AppImage` step is NOT reliably safe** — **corrected 2026-06-04** (the previous claim "verified safe 2026-05-31" held twice on 2026-06-02 then failed). The mmap/paging concern is indeed moot (`/tmp/.mount_*`), but **`appimagelauncherd` watches `~/Applications/`**: on file replacement it re-runs desktop integration ("Cleaning up old desktop integration files", 17:17:33) and the running instance was **cleanly terminated 15 s later** (systemd scope end 17:17:48, no segfault, no kernel trace — user confirmed they did not quit). Non-deterministic: it survived the same swap twice before. **Treat the `cp` as the disruptive step**: do it only when the user is ready to restart, or have them quit first.

The new code takes effect on **next launch only** (after the user fully quits and relaunches).

### 3. Use worktree isolation for parallel agents

Two agents in the same git checkout will race on branch checkouts and the working tree. Symptom: file edits from one agent leak into the other's commits. Use `isolation: "worktree"` when spawning subagents that touch overlapping files.

After the agent completes, **remove the worktree manually** — `git worktree remove --force .claude/worktrees/agent-<id>`. The harness does not auto-clean.

### 4. `.work-files/` is gitignored scratch space

Gitignored scratch space. Use it for session notes, proposals, plans, scratch JSONLs. It's enumerated by the Work Files sidebar tab — files appear there automatically.

### 5. No `Co-Authored-By` trailers in commits

Workspace-level rule (`~/workspace/CLAUDE.md`). Applies to commits and MR/PR descriptions.

### 6. Overnight / unattended work: don't touch the live app while a session is mid-run

If you're working autonomously (overnight, AFK mode) while the user's AppImage is live with an active session open, treat the app as **read-only from the outside** for the duration: no `npm run build:linux` / `task build` without the `--config.npmRebuild=false` flag (§2), no `cp` to `~/Applications/Switchboard.AppImage` (§2 — `appimagelauncherd` can silently kill the running instance), and no second `npx electron .` (§1 — it just quits and steals focus instead of giving you a usable dev process). None of these produce an obvious error at the time you run them; the damage shows up later as a dead session the user didn't ask to lose. If you need a live process to test against, use `SWITCHBOARD_DATA_DIR` isolation (§1) and only do the disruptive steps (uncontrolled rebuild, `cp` swap) once the user is ready to restart.

> This is a Switchboard-specific writeup of a more general pattern — "don't touch shared mutable state a human is actively using" applies to any AI agent working unattended alongside a live app.

## Fork-specific features (not in upstream)

These exist on `devsuitup/switchboard` main but not on `doctly/switchboard` main. If an agent claims a feature is "upstream", verify with `git log upstream/main -- <file>`:

- **Subagent support** — index, search, transcript viewer (PR #47 upstream, merged on fork)
- **Subagent observability** — hierarchy, live transitions, status badges (PR #48 upstream)
- **Worktree delete dialog** with dirty-file status (PR #49 upstream)
- **Test coverage** for determinism + cold-start (PR #50/#52 upstream)
- **Heatmap sourced from SQLite cache** instead of `~/.claude/stats-cache.json` (fork PR #7)
- **Subagent click → read-only transcript** instead of `claude --resume` (fork PR #9)
- **Single-instance-lock** (fork PR #13 → upstream PR #56 open)
- **`.work-files/` sidebar tab** per project, with delete + JSON/JSONL format (fork PR #14, #16, #17)
- **`SWITCHBOARD_DATA_DIR`** env var for DB isolation in dev (fork)
- **Wayland clipboard fix** — main-process IPC + OSC 52 (fork PR #18 = port of upstream PR #55)
- **Missing project remap** — detect + UI + atomic JSONL rewrite (fork PR #20 = port of upstream PR #35, with subagent-aware enum + active-session guard added on top)
- **Trigger watcher** — file-based command injection into open PTYs, single + chained (fork PR #24 and follow-ups); see [contexts/trigger-watcher.md](contexts/trigger-watcher.md)
- **Schedule runner** — in-process cron spawning headless Claude tasks from `schedule-*.md` files; see [contexts/schedule-runner.md](contexts/schedule-runner.md)
- **Session restore** — persist + restore the open working set across restarts (fork PR #80)
- **Perf campaign v0.0.33–41** — 30fps terminal flush cap, WebGL virtualization, LRU xterm cap, targeted refreshes, idle-CPU fixes (fork PRs #55–#70; a second perf wave #73–#76 shipped in v0.0.38)
- **Search off the main thread + bounded FTS query** — worker relay + 48-char cap (fork PR #97, v0.0.44)
- **Debug mode** — Settings → Diagnostics arms the activity trace at runtime, without a restart, and lists/opens/deletes its files; see [docs/activity-trace.md](../docs/activity-trace.md)
- **Resume/fork in real recorded cwd** for worktree sessions (fork PR #96, v0.0.44)

(Not exhaustive — `git log --oneline upstream/main..main` is the ground truth.)

## Patterns to reuse, not reinvent

| Need | Existing helper |
|---|---|
| Walk all JSONLs (parents + subagents + legacy layouts) | `enumerateSessionFiles(folderPath)` in `read-session-file.js` |
| Encode `/path/to/project` → `-path-to-project` folder | `encodeProjectPath()` in `encode-project-path.js` |
| Resolve worktree path back to repo root | `resolveWorktreePath()` in `derive-project-path.js` |
| Escape HTML in renderer | `escapeHtml()` (cross-file global) |
| Open a file in a CodeMirror panel | `new ViewerPanel(container, opts)` |
| Optional toolbar button | `opts.format`, `opts.onDelete`, `opts.onSave`, `opts.onClose` on ViewerPanel |
| Flash button on success | `window.flashButtonText(btn, text, ms)` |

## Testing

- `node:test` runner via `npm test` / `task test`.
- Renderer tests use jsdom via `test/dom-setup.js` + `vm.runInContext` to evaluate `public/*.js` in isolation.
- Pitfall: `installSpies: false` is required when the eval defines functions you also spy on — function declarations from eval overwrite property spies.
- Always test in the **primary checkout** (`~/workspace/switchboard`), not inside `.claude/worktrees/agent-*`. Worktrees may have incomplete `node_modules` and produce false negatives on tests that require native modules (e.g. `morphdom`).

## When you finish work

1. **Comment sweep.** Writing comments while coding is fine, but a second pass
   must remove them before the PR: rationale, measurements, and design notes go
   to context engineering (`.ai/contexts/*.md`) or an ADR (`docs/decisions/`),
   never in the code. What may remain in code: at most a one-line pointer to
   that doc (e.g. `// see .ai/contexts/subagent-observability.md`), and that's
   the ceiling (maintainer rule, PRs #127/#130).
2. `task check` (lint + test). 0 errors. Pre-existing warnings are fine.
3. Squash to clear commits. No `Co-Authored-By`. Imperative subject, brief why-body.
4. `gh pr create` against `devsuitup/switchboard:main` (the fork's main, not upstream's). Title format: `(area): short imperative`.
5. If the change is a port of an upstream PR, **credit the upstream author** in the body with a link. We want abasiri to see we're not stealing.
6. **When the PR is ready to merge** (internal review loop converged to zero findings, or an external PR judged mergeable after review), **request the maintainer account `devsuitup` as reviewer**: `gh api -X POST repos/devsuitup/switchboard/pulls/<n>/requested_reviewers -f 'reviewers[]=devsuitup'`. The maintainer's review queue is the single list of what awaits approval — a ready PR that never requests review sits invisible.

## Upstreaming work

The fork has features upstream maintainers might want. When adapting a fork-only feature for upstream:

1. Branch off `upstream/main` (NOT fork main), name `upstream/<topic>`.
2. Cherry-pick the relevant commit(s). Expect manual merges — our `main.js` is ~1850 LOC vs upstream's ~350; insertion points exist but contexts differ.
3. Strip fork-specific dependencies (subagent groups, work-files IPC, etc.) — keep the patch minimally scoped.
4. PR against `doctly/switchboard:main`. Link the originating fork PR.

Example: fork PR #13 → upstream PR #56 (`upstream/fix-single-instance-lock` branch).

## When in doubt

- Read the [README.md](README.md) for what the app does.
- `git log --oneline upstream/main..main` shows everything the fork carries.
- `.work-files/switchboard/` has session notes from past compaction events.
- Recent merged PRs on the fork are the highest-signal "how do we do things" reference.
