# Switchboard — Notes for Claude (and other AI agents)

This is JB's fork (`JeanBaptisteRenard/switchboard`) of `doctly/switchboard`. The fork carries features not (yet) upstream — read this before editing anything.

## Quick orientation

| You want to… | Read first |
|---|---|
| Run / build the app | [README.md "Tooling"](README.md) (task commands) |
| Change Electron main / IPC | `main.js`, `preload.js` |
| Change the renderer (sidebar, tabs, terminal) | `public/*.js` — entry is `app.js` |
| Change the SQLite cache | `db.js`, `session-cache.js` |
| Change a viewer panel (plans, memory, .work-files) | `public/viewer-panel.js` + `public/viewer-toolbar.js` |
| Write a test | `test/*.test.js` — node:test + jsdom for renderer files |

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

### 2. Building does NOT kill the running instance

`npm run build:linux` writes to `dist/`. Replacing `~/Applications/Switchboard.AppImage` with `cp dist/*.AppImage ~/Applications/...` is safe because the running process already extracted the AppImage to `/tmp/.mount_*/` at launch — it doesn't need the file on disk anymore.

The new code takes effect on **next launch only** (after the user fully quits). Until then, the running process is on the old code.

### 3. Use worktree isolation for parallel agents

Two agents in the same git checkout will race on branch checkouts and the working tree. Symptom: file edits from one agent leak into the other's commits. Use `isolation: "worktree"` when spawning subagents that touch overlapping files.

After the agent completes, **remove the worktree manually** — `git worktree remove --force .claude/worktrees/agent-<id>`. The harness does not auto-clean.

### 4. `.work-files/` is gitignored scratch space

Skaleet workspace convention. Use it for session notes, proposals, plans, scratch JSONLs. It's enumerated by the Work Files sidebar tab — files appear there automatically.

### 5. No `Co-Authored-By` trailers in commits

Workspace-level rule (`~/workspace/CLAUDE.md`). Applies to commits and MR/PR descriptions.

## Fork-specific features (not in upstream)

These exist on `JeanBaptisteRenard/switchboard` main but not on `doctly/switchboard` main. If an agent claims a feature is "upstream", verify with `git log upstream/main -- <file>`:

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

1. `task check` (lint + test). 0 errors. Pre-existing warnings are fine.
2. Squash to clear commits. No `Co-Authored-By`. Imperative subject, brief why-body.
3. `gh pr create` against `JeanBaptisteRenard/switchboard:main` (the fork's main, not upstream's). Title format: `(area): short imperative`.
4. If the change is a port of an upstream PR, **credit the upstream author** in the body with a link. We want abasiri to see we're not stealing.

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
