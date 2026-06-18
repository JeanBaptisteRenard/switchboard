# Keyboard Shortcuts

## Editor and terminal shortcuts

These shortcuts are built-in and not rebindable:

| Shortcut | Action |
|----------|--------|
| `Cmd+F` / `Ctrl+F` | Find in file (also works in terminal) |
| `Cmd+G` / `Ctrl+G` | Go to line (editor) / next match (terminal find) |
| `Cmd+S` / `Ctrl+S` | Save current file (in Plans / Memory / Work Files panels) |
| `Shift+Enter` | Insert literal newline in terminal without submitting |

## Rebindable session-navigation shortcuts

Three shortcuts control session and grid navigation. They are rebindable from **Global Settings → Keyboard Shortcuts**.

| Action | Default (macOS) | Default (Windows/Linux) | Description |
|--------|----------------|-------------------------|-------------|
| Navigate sessions / grid | `Cmd+Shift+↑/↓/←/→` | `Ctrl+Shift+↑/↓/←/→` | Move between sessions in single view, or between cells in grid view |
| Previous / next session | `Cmd+Shift+[` / `Cmd+Shift+]` | `Ctrl+Shift+[` / `Ctrl+Shift+]` | Cycle to the previous or next session in the sidebar |
| Toggle grid view | `Cmd+Shift+G` | `Ctrl+Shift+G` | Show or hide the session grid overview |

The arrow-based shortcut uses `Shift` (not `Alt`) to avoid conflicting with terminal word-jump (`Ctrl+Left/Right`) and common Linux desktop workspace-switch bindings.

## How to rebind

1. Open **Global Settings** (gear icon or the settings button in the toolbar)
2. Scroll to the **Keyboard Shortcuts** section
3. Click the button showing the current binding for the action you want to change
4. The button changes to "Press keys…" — press your new combination
5. At least one modifier (`Cmd`/`Ctrl`, `Option`/`Alt`, or `Shift`) is required
6. Press `Esc` to cancel without saving, or click the button again to reset to the default
7. Click **Save Settings**

Shortcuts take effect immediately after saving — no restart required.

> **Note:** Keyboard shortcuts are global-only and cannot be overridden per project.
