# Session Restore

Switchboard can remember which sessions were open when you closed it and reopen them automatically on the next launch.

## How it works

Whenever you open or close a session, Switchboard saves the current "working set" — the list of open sessions, their project paths, and which one was active — to global settings. On startup, this list is used to restore your previous state.

Each session is resumed using the project's current session-launch settings (permission mode, worktrees, pre-launch command). Options from the previous launch are not frozen — the session starts fresh with the current project defaults.

Sessions that no longer exist in the index (deleted JSONL files, removed worktrees) are silently skipped during restore.

> **Technical note (for contributors):** "restore" is a **respawn**, not a reattach. The underlying terminal process (PTY) is a child of the Electron main process and is killed when Switchboard quits — nothing survives the process boundary. On restart, Switchboard spawns a brand-new PTY per restored session (using `claude --resume <sessionId>` for Claude sessions), it does not reconnect to anything left running. True reattach — replaying buffered terminal output onto an existing, still-running PTY — only happens *within* a single app run (e.g. the renderer reloads, or you click back into a session tab), gated on the session still being present in the in-memory `activeSessions` map. Once the app has fully quit, that map is empty, so restore always takes the "spawn new PTY" path.

## Restore on Startup setting

Open **Global Settings** and look for **Restore Sessions on Startup**:

| Option | Behavior |
|--------|----------|
| **Don't restore** | Sessions are not restored; Switchboard opens to the empty state |
| **Ask on startup** (default) | A non-modal toast bar appears asking "Restore N sessions from last time?" with Restore / Dismiss buttons |
| **Restore automatically** | Sessions are reopened silently on every launch, no prompt |

> **Note:** This setting is read at launch. Changing it takes effect the next time you start Switchboard.

## Settings

**Restore Sessions on Startup** is a global-only setting. See [Settings Reference](settings.md).
