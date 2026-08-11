# Switchboard Documentation

Switchboard is a desktop command center for Claude Code sessions. It gives you a unified window across all your projects — launch, resume, monitor, and search sessions without leaving the app.

This is the documentation for the [devsuitup/switchboard](https://github.com/devsuitup/switchboard) fork of [doctly/switchboard](https://github.com/doctly/switchboard). See the [README's "About this fork"](../README.md#about-this-fork) section for what the fork adds on top of upstream.

## Pages

- [Session Browser](session-browser.md) — sidebar, project grouping, full-text search, archive, star, filters
- [Terminal](terminal.md) — built-in terminal, right-click menu, drag-and-drop, in-terminal find
- [Grid Overview](grid-overview.md) — bird's-eye live grid of all open sessions
- [IDE Emulation](ide-emulation.md) — file diffs in a side panel, inline and side-by-side, partial accept
- [Subagents](subagents.md) — subagent index, hierarchy, live status, read-only transcript viewer
- [Session Restore](session-restore.md) — persist open sessions and restore them on restart
- [Keyboard Shortcuts](keyboard-shortcuts.md) — editor/terminal shortcuts and rebindable session-nav keys
- [Notifications](notifications.md) — sidebar status badges: waiting for input, permission approval, activity
- [Plans, Memory, and Work Files](plans-memory-workfiles.md) — edit plan files, CLAUDE.md, and `.work-files/` in CodeMirror panels
- [Activity Stats](activity-stats.md) — coding activity heatmap
- [Settings Reference](settings.md) — every field in Global and Project Settings
- [Automation](automation.md) — scheduled Claude tasks (cron) and the file-based trigger API
- [Customizing Colors](customizing-colors.md) — community guide (in French) to theming via `app.asar`

## Download / Install

Grab the latest release for your platform from the [GitHub Releases page](https://github.com/devsuitup/switchboard/releases/latest):

- **macOS**: `.dmg` (Apple Silicon and Intel)
- **Windows**: `.exe` installer
- **Linux**: `.AppImage` or `.deb`

## For Developers

See [../CLAUDE.md](../CLAUDE.md) for fork-specific conventions, architecture invariants, and AI agent guidance.

See [decisions/](decisions/README.md) for architecture decision records (e.g. why there's no full Go rewrite).
