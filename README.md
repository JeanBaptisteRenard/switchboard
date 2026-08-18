# Switchboard

Your command center for Claude Code sessions.

Switchboard is a desktop app that gives you a unified view of all your Claude Code sessions across every project. Launch, resume, fork, and monitor sessions from a single window — no more juggling terminal tabs or digging through `~/.claude/projects` to find that one conversation from last week.

![Switchboard](build/screenshot.png)

## About this fork

This repository is a fork of **[doctly/switchboard](https://github.com/doctly/switchboard)** — all credit for the original app goes to its author. The fork tracks upstream (features are ported in both directions when they fit) and is currently ~160 commits ahead. Highlights of what it adds:

- **Subagent support & observability** — subagent transcripts are indexed and searchable, the sidebar shows the parent→child hierarchy with live spawn/completion indicators and status badges, and clicking a subagent opens a read-only transcript viewer instead of re-spawning Claude. See [docs/subagents.md](docs/subagents.md).
- **Session restore** — reopen your whole working set (open sessions, order, active one) after a restart. See [docs/session-restore.md](docs/session-restore.md).
- **Automation** — an in-process scheduler fires Claude tasks from cron-style `schedule-*.md` files, and a file-based trigger API lets external scripts inject commands (single or chained) into open sessions. See [docs/automation.md](docs/automation.md).
- **Performance work** — terminal write-flush capped at ~30 fps, WebGL context virtualization and LRU caps on grid cards, differentiated scrollback, targeted watcher refreshes, header-only reads for cached sessions, idle-CPU fixes. Measured compositor load on a busy grid dropped from 40–60% to 8–10%.
- **Search hardening** — full-text search runs in a dedicated worker thread with bounded query length, so a pasted URL can no longer freeze the app; explicit reindex via Enter or the refresh button.
- **Worktree tools** — sessions started in a git worktree resume and fork in their real recorded cwd; a rich delete dialog shows dirty-file status before removing a worktree from disk.
- **Work Files tab** — browse, format (JSON/JSONL), and delete each project's `.work-files/` scratch space from the sidebar.
- **Robustness** — single-instance lock (no PTY loss when double-launching), `SWITCHBOARD_DATA_DIR` env var to isolate a dev database from the daily driver, missing-project detection + remap UI, Wayland clipboard support (OSC 52).
- **CI** — test coverage with a patch-coverage gate (80% on changed lines).

`git log --oneline upstream/main..main` lists everything the fork carries.

### Key Features

- **Session Browser** — All your Claude Code sessions, organized by project, searchable by content
- **Built-in Terminal** — Connect to running sessions or launch new ones without leaving the app
- **Status Notifications** — In-app alerts when a session is waiting for permission approval or user input
- **Fork & Resume** — Branch off from any point in a session's history
- **Full-Text Search** — Find any session by what was discussed, not just when it happened
- **Sandboxed Sessions** (Linux) — Optionally run Claude inside a [bubblewrap](https://github.com/containers/bubblewrap) sandbox where the rest of `$HOME` is hidden: only the project directory and Claude's own config/state are visible (filesystem isolation — network and environment are shared, see [docs](docs/settings.md#what-the-sandbox-does-and-doesnt-isolate)). Off by default; enable per session, per project, or globally. Needs unprivileged user namespaces, which Ubuntu 23.10+ restricts by default — the wrapper says so and how to fix it
- **IDE Emulation** — Switchboard acts as an IDE for Claude CLI, showing file diffs and opens in a side panel where you can accept, reject, or edit changes before they're applied. Supports both inline and side-by-side diff views. Disable this in Global Settings if you prefer Claude to use your own editor (VS Code, Cursor, etc.)
- **Plans & Memory** — Browse and edit your plan files and CLAUDE.md memory in one place
- **Activity Stats** — Heatmap of your coding activity across all projects
- **Session Names** — Picks up session names from Claude Code's `/rename` command automatically

## Session Grid Overview

Toggle the grid overview from the sidebar for a bird's-eye view of all your open sessions at once, grouped by project.

![Session Grid Overview](build/screenshot-grid.png)

- **Live terminals** — Every open session renders its full terminal in a card, so you can monitor multiple Claude agents simultaneously.
- **Status at a glance** — Each card shows a running/stopped/busy indicator dot and last-activity timestamp.
- **Click to focus, double-click to expand** — Click a card header to focus it; double-click to switch back to single-terminal view for that session.
- **Persistent** — Grid preference is saved across restarts.

## File Preview Side Panel & Claude IDE MCP Emulator

Switchboard can act as an IDE for your Claude Code sessions. When enabled, Claude's file opens and proposed edits appear in a side panel next to the terminal instead of being sent to an external editor.

![IDE Emulation](build/screenshot-ide.png)

- **Diff review** — When Claude proposes a file change, it shows up as a diff in the side panel. You can review the changes and accept or reject them directly.
- **Inline & side-by-side** — Toggle between inline (unified) and side-by-side diff views. Your preference is remembered across sessions.
- **Partial acceptance** — In inline mode, you can accept or reject individual chunks within a diff, then submit the final result.
- **File viewer** — Clickable file links in terminal output (OSC 8 hyperlinks) open in the side panel with syntax highlighting.

To disable IDE emulation entirely (e.g. if you want Claude to use VS Code or Cursor instead), uncheck **IDE Emulation** in **Global Settings**. This stops Switchboard from registering as an IDE, so Claude CLI will discover and connect to your real editor. Changes take effect on new sessions — running sessions are not affected.

## Status Notifications

Switchboard monitors all your sessions in the background and shows status indicators in the sidebar so you can tell at a glance which sessions need attention — even when you're working in a different one.

![Status Notifications](build/screenshot-notifications.png)

- **Waiting for input** — A session that needs your response is highlighted so you don't miss it.
- **Permission approval** — When Claude is blocked waiting for a permission grant, the session badge lets you know immediately.
- **Activity indicators** — See which sessions are actively running, idle, or finished.

## Editor

| Shortcut | Action |
|----------|--------|
| `Cmd+F` / `Ctrl+F` | Find in file (also works in terminal) |
| `Cmd+G` / `Ctrl+G` | Go to line |

## Documentation

Full user-facing documentation lives in [docs/](docs/README.md):

- [Session Browser](docs/session-browser.md) — sidebar, project grouping, full-text search, archive, star, filters
- [Terminal](docs/terminal.md) — built-in terminal, configurable right-click, drag-and-drop, in-terminal find
- [Grid Overview](docs/grid-overview.md) — bird's-eye live grid of all open sessions
- [IDE Emulation](docs/ide-emulation.md) — file diffs in a side panel, inline and side-by-side, partial accept
- [Subagents](docs/subagents.md) — subagent index, hierarchy, live status, read-only transcript viewer
- [Session Restore](docs/session-restore.md) — persist open sessions and restore them on restart
- [Keyboard Shortcuts](docs/keyboard-shortcuts.md) — editor/terminal shortcuts and rebindable session-nav keys
- [Notifications](docs/notifications.md) — sidebar status badges
- [Plans, Memory, and Work Files](docs/plans-memory-workfiles.md) — CodeMirror panels for plan files, CLAUDE.md, and `.work-files/`
- [Activity Stats](docs/activity-stats.md) — coding activity heatmap
- [Settings Reference](docs/settings.md) — every field in Global and Project Settings
- [Automation](docs/automation.md) — scheduled Claude tasks (cron) and the file-based trigger API
- [Customizing Colors](docs/customizing-colors.md) — community guide (in French) to theming via `app.asar`

## Download

Grab the latest release for your platform:

**[Download Switchboard](https://github.com/devsuitup/switchboard/releases/latest)**

- **macOS**: `.dmg` (Apple Silicon & Intel)
- **Windows**: `.exe` installer
- **Linux**: `.AppImage`, `.deb`, or `.pacman` (Arch/Manjaro)

## Prerequisites

- **Node.js** 20+
- **npm** 10+
- Platform build tools for native modules:
  - **macOS**: Xcode Command Line Tools (`xcode-select --install`)
  - **Linux**: `build-essential`, `python3` (`sudo apt install build-essential python3`)
  - **Windows**: Visual Studio Build Tools or `npm install -g windows-build-tools`

## Tooling

[task](https://taskfile.dev) is the preferred entrypoint for all dev operations. Install it once (`brew install go-task` / `snap install task --classic` / see taskfile.dev for other platforms), then:

```bash
task install       # npm install
task dev           # launch Electron (--no-sandbox, required on Linux)
task test          # node --test
task lint          # eslint .
task check         # test + lint  — pre-commit / pre-push gate
task ci            # same as check but sequential, verbose
task build         # npm run build:linux
task test-pr PR=N  # run PR #N from source, isolated, alongside a running AppImage
task clean         # wipe dist/, codemirror bundle, local DB (asks for confirmation)
task db:reset      # wipe ~/.switchboard/switchboard.db only
```

Run `task` (no args) to list all tasks with descriptions.

The npm scripts are still present and work as before; `task` just wraps them as a consistent entrypoint.

## Development Setup

```bash
task install   # install dependencies (runs postinstall automatically)
task dev       # launch Electron
```

Or with npm directly:

```bash
npm install
npm start      # bundles CodeMirror then launches Electron
```

`npm start` bundles CodeMirror and launches Electron. For faster iteration after the first run:

```bash
npm run electron
```

### Working alongside a running AppImage

If your `~/Applications/Switchboard.AppImage` is open while you develop:

- **Dev DB isolation** — `task dev` sets `SWITCHBOARD_DATA_DIR=~/.switchboard-dev` automatically so the dev electron uses its own SQLite database. The AppImage keeps using `~/.switchboard/switchboard.db`. They never collide.
- **Single-instance lock** — if you double-click `Switchboard.AppImage` while it's already open, the second launch quits immediately and focuses the existing window instead of spawning a duplicate process. This was a real data-loss bug (PTYs orphaned) before the fix landed.
- **Rebuilding AND replacing are both risky while the app runs** — `task build` invokes `electron-builder`, which rebuilds native modules (`better-sqlite3`, `node-pty`) by default. Those `.node` files are loaded by your running AppImage; replacing them mid-run can kill the process (witnessed 2026-05-31). Building is safe only with `--config.npmRebuild=false`. Replacing `~/Applications/Switchboard.AppImage` via `cp` is **not reliably safe either**: the live process doesn't need the on-disk file (it runs from `/tmp/.mount_*/`), but `appimagelauncherd` watches `~/Applications/` and its desktop-integration re-run can cleanly terminate the running instance (witnessed 2026-06-04, non-deterministic). Do the `cp` only when you're ready to restart. The new code takes effect only on next launch.
- **Testing a PR before merging** — `task test-pr PR=<number>` runs a PR's code from source in its own isolated instance next to the AppImage, no build required. See [docs/testing-a-pr.md](docs/testing-a-pr.md).

### For AI agents

If you're an AI working in this repo, read [CLAUDE.md](CLAUDE.md) at the project root — it documents the fork-specific features, invariants (no double Electron, no `Co-Authored-By`, worktree isolation pattern), and the helpers worth reusing (`enumerateSessionFiles`, `encodeProjectPath`, `ViewerPanel`).

## Building

All build commands bundle CodeMirror first, then invoke electron-builder.

```bash
task build            # AppImage + deb (Linux)

# npm equivalents:
npm run build:mac     # DMG + zip (arm64 + x64)
npm run build:win     # NSIS installer (x64 + arm64)
npm run build:linux   # AppImage + deb + pacman (x64 + arm64)
```

Output goes to `dist/`.

### Building on Arch / Manjaro

The `deb` and `pacman` targets are built via the `fpm` binary bundled by
electron-builder, which links against `libcrypt.so.1`. Arch ships `libxcrypt`
without that legacy ABI, so install the compat shim once:

```bash
sudo pacman -S libxcrypt-compat
```

`AppImage` builds without it.

The pacman package is published as **`switchboard-doctly`** rather than
`switchboard` because the Arch `extra` repo already ships a package named
`switchboard` (elementary OS's Pantheon Control Center). Renaming avoids the
file-conflict that would block installation alongside it. The app itself is
still called Switchboard everywhere users see it — only the package identity
changes. Uninstall later with `sudo pacman -R switchboard-doctly`.

## Releasing

Releases are driven by git tags:

```bash
git tag v0.1.0
git push origin v0.1.0
```

The GitHub Actions workflow builds for all platforms and publishes to GitHub Releases. You can also release locally:

```bash
npm run release   # builds + publishes to GitHub Releases
```

Set `GH_TOKEN` in your environment (a GitHub personal access token with `repo` scope).

### Fork release-flow gotchas

This fork's `main` is branch-protected and its `main` branch tracks `upstream/main`, both of which trip up the generic release flow above:

- **A bare `git push` (no remote) targets `upstream` (`doctly/switchboard`), not `origin`** — it will fail with a permissions error. Always `git push origin ...` explicitly.
- **Direct pushes to `main` are rejected** ("repository rule violations"). The version-bump commit must land via a PR. The ruleset requires 1 approving review from a different account plus green `test (20)` / `test (22)` checks; arm `gh pr merge --auto` and approve from the other account.
- **The release workflow leaves the release as a draft on purpose** — after all assets are uploaded (19 expected), publish manually: `gh release edit v<X.Y.Z> --draft=false --latest --notes "..."`.
- **Tag the merged commit on `main`, after the PR merges — never the local pre-merge bump commit.** Tagging first and then squash-merging creates a tag that isn't an ancestor of `main`; `git describe --tags` and release-notes generation then skip it. Correct order: PR-merge the bump → `git reset --hard origin/main` locally → tag → `git push origin <tag>`. If a build already started from a bad tag, cancel the run (`gh run cancel`) and delete + recreate the tag.
- **Unsigned macOS builds need both `"mac": {"identity": null}` in `package.json` and `notarize: false`.** A `CSC_LINK` env that's set-but-empty (e.g. `${{ secrets.CSC_LINK || '' }}`) is read by electron-builder as a certificate *file path* — `stat('')` resolves to the CI working directory, and the mac job fails with `... not a file` only on tag-triggered (release) runs, never on PR builds. Gating `CSC_IDENTITY_AUTO_DISCOVERY` on whether the secret is set does **not** fix this; `identity: null` does.
- **`gh release upload`/`create` can hit an intermittent 401 from `uploads.github.com` on a single asset** (often a `.blockmap`), aborting a batch upload and leaving a partial draft release. Upload assets one at a time with a retry loop (`for i in 1..5; do gh release upload "$TAG" "$f" --clobber && break; sleep 2; done`) instead of a single `gh release create ... dist/*` call.

## Auto-Updates

The app uses `electron-updater` to check for updates from GitHub Releases on launch and every 4 hours. Updates are only checked in packaged builds (not during development). The flow:

1. App auto-downloads updates in the background
2. A toast notification appears when the update is ready
3. User can restart immediately or dismiss (installs on next quit)

## Code Signing

For distribution, set these environment variables:

- **macOS**: `CSC_LINK` (p12 certificate) and `CSC_KEY_PASSWORD`, or sign via Keychain
- **Windows**: `CSC_LINK` and `CSC_KEY_PASSWORD` for EV/OV code signing
- Set `CSC_IDENTITY_AUTO_DISCOVERY=false` to skip signing (CI artifact builds)

The macOS build uses custom entitlements (`build/entitlements.mac.plist`) to allow JIT and unsigned memory execution, required by native modules (node-pty, better-sqlite3).

## Project Structure

```
main.js             Electron main process (IPC, PTY sessions, watchers)
preload.js          Context bridge (IPC bindings)
db.js               SQLite session cache, metadata, FTS search
session-cache.js    JSONL indexer + projects watcher
schedule-runner.js  In-process cron for scheduled Claude tasks
trigger-watcher.js  File-based command-injection API
workers/            Worker threads (indexing, search queries)
public/             Renderer (HTML/CSS/JS)
test/               node:test suites (jsdom for renderer files)
docs/               User-facing documentation
.ai/                Agent guidelines + architecture context docs
scripts/            Build & postinstall scripts
build/              Icons, entitlements, builder resources
.github/workflows/  CI/CD
```
