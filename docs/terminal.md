# Terminal

Switchboard includes a full built-in terminal powered by xterm.js. You can launch new Claude Code sessions or attach to existing ones without leaving the app.

## Launching and attaching

- Click a session in the sidebar to open it in the terminal. If the session has an active process, you attach to its running PTY. If not, a new Claude CLI process is launched.
- Click **New Session** (the `+` button next to a project) to start a fresh Claude Code session for that project.

## Middle-click paste (Linux)

Middle-click pastes the X11/Wayland **PRIMARY selection** — the text you last
selected with the mouse — which is separate from the `Ctrl+C` clipboard.
Switchboard handles this itself so the selection is pasted exactly once;
letting the browser do it natively resulted in a duplicated paste.

## Right-click behavior

Right-click behavior in the terminal is configurable. Open **Global Settings** and look for **Terminal Right-Click**:

| Setting | Behavior |
|---------|----------|
| **Context menu** (default) | Shows a context menu with file-link actions, copy, paste, and select all |
| **Paste clipboard** | Right-click pastes the clipboard directly (PuTTY-style) |
| **Native (xterm)** | Passes the click through to xterm's built-in handler |
| **Do nothing** | Right-click has no effect |

The setting takes effect immediately on the next right-click — no restart required.

### Context menu actions

When **Context menu** is selected, right-clicking opens a menu. The items shown depend on what the cursor is over:

**Over a file link (OSC 8 `file://` hyperlink):**
- Open in panel — open the file in the IDE side panel
- Open in system editor — open with the OS default application
- Copy path — copy the absolute file path to the clipboard

**Over a URL (`http://` or `https://`):**
- Open in browser — open in the system browser
- Copy link — copy the URL to the clipboard

**Always present:**
- Copy — copy the current selection (only shown when text is selected)
- Paste — paste the clipboard
- Select all — select all terminal output

## Drag and drop

Drag one or more files from your file manager (or macOS Finder) into the terminal. Switchboard inserts the shell-escaped absolute path(s) at the cursor, separated by spaces — exactly as if you had typed them.

## In-terminal find

Press `Ctrl+F` (or `Cmd+F` on macOS) to open xterm's built-in search bar inside the terminal. This searches through the terminal scrollback buffer, not the session transcript. In the search bar, press `Enter` to jump to the next match and `Shift+Enter` for the previous one; `Esc` closes it.

## Multi-line input

Press `Shift+Enter` to insert a literal newline in the terminal input without submitting. This lets you compose multi-line prompts before sending.

## Keyboard shortcuts

The default session-navigation shortcuts (`Ctrl+Shift+Arrows`, `Ctrl+Shift+[/]`) are captured before they reach the terminal, so they never interfere with terminal editing. See [Keyboard Shortcuts](keyboard-shortcuts.md) for the full list and how to rebind them.

## Settings

Open **Global Settings** to change the terminal theme (`Terminal Theme`) and right-click behavior (`Terminal Right-Click`). Both are global-only settings. Shell selection (`Shell Profile`) is also global — changes take effect for new sessions only. See [Settings Reference](settings.md).
