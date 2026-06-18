# Grid Overview

The session grid is a bird's-eye view of all your open sessions at once. Toggle it with the grid button in the toolbar or with the keyboard shortcut (`Ctrl+Shift+G` by default, or `Cmd+Shift+G` on macOS).

![Session Grid Overview](../build/screenshot-grid.png)

## What you see

Each open session gets a card. Cards are arranged in a responsive grid grouped by project. Every card renders the session's live terminal output, so you can monitor multiple agents running in parallel without switching between them.

Each card header shows:

- The session name (from `/rename` or the AI-generated title)
- A status dot: running (spinning), stopped, or busy
- The last-activity timestamp

When a session has active sub-agents running, colored pills appear below the header — one pill per sub-agent type (explore, plan, implement, review, test). This lets you see at a glance what work is in flight.

## Interacting with cards

- **Click a card header** — focus that session. The sidebar highlights it and the status bar updates.
- **Double-click a card header** — switch back to single-session view for that session, expanding the terminal to full size.
- **Stop button** — each card has a stop button to kill the session's PTY without leaving the grid.

## Persistence

Whether the grid is active or not is saved in `localStorage` and restored the next time you open Switchboard. If you close the app with the grid on, it opens in grid view next time.

## Keyboard shortcut

Toggle the grid with `Ctrl+Shift+G` (Windows/Linux) or `Cmd+Shift+G` (macOS). The shortcut is rebindable — see [Keyboard Shortcuts](keyboard-shortcuts.md).
