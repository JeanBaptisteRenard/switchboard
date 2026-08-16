# Session Browser

The session browser is the left sidebar. It lists every Claude Code session Switchboard has indexed, organized by project, and gives you fast access to search, filter, archive, and star sessions.

![Switchboard](../build/screenshot.png)

## Project grouping

Sessions are grouped by the project they belong to. Each project has its own collapsible section in the sidebar. Worktrees are collapsed back to their parent repository so related sessions stay together regardless of which branch they ran on.

Sessions that Switchboard cannot map to a known project path appear in a **Missing project** group with a remap option to reassign them.

## Session names

Session titles come from two sources:

- **AI-generated titles** — Switchboard automatically picks up the AI-generated summary Claude Code writes at the start of every session.
- **`/rename` command** — if you run Claude's `/rename` command inside a session, Switchboard picks up the name automatically the next time it indexes that session.

## Filters

The filter bar above the session list offers four toggles:

- **Running** — show only sessions with an active PTY process
- **Today** — show only sessions modified today
- **Starred** — show only starred sessions
- **Archived** — show archived sessions (hidden by default)

Filters combine: enabling "Running" and "Today" together shows only sessions that are both running and modified today.

## Full-text search

The search bar at the top searches across session content — not just titles. Switchboard uses an FTS5 full-text index over session transcripts, plan files, memory files, and work files. Results update as you type (minimum 3 characters).

To scope a search to a specific content type, use the type selector next to the search bar (Sessions, Subagents, Plans, Memory, Work Files).

## Delete a session

The trash button on a session card **permanently removes that session's transcript from disk**, along with any subagent transcripts belonging to it. There is no trash to recover it from, so the action asks for confirmation naming the session first.

Use **archive** instead if you only want the session out of the way — archiving hides it from the sidebar but keeps the file.

A session that is still running is stopped first. If its transcript cannot be found, or something outside `~/.claude/projects` is somehow targeted, the deletion is refused and the reason is shown.

## Star and archive

- **Star** — right-click a session and choose Star, or use the star icon in the session header. Starred sessions appear at the top of their project group.
- **Archive** — right-click and choose Archive to hide a session from the default view. Archived sessions reappear when you enable the Archived filter.

## Session count limits

By default the sidebar shows the 10 most recent sessions per project and hides older ones behind a "+N older" link. Both the count limit and a maximum age (in days) are configurable in **Global Settings** — see [Settings Reference](settings.md).

## Subagents

Sessions that Claude spawned as sub-agents appear nested under their parent session. Orphan subagents (those whose parent cannot be found) appear in a collapsible **Orphan subagents** group at the bottom of each project section. See [Subagents](subagents.md) for details.
