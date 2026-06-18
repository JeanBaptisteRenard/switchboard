# Settings Reference

Switchboard has two levels of settings: **Global Settings** and **Project Settings**. Global settings apply to all projects. Project settings override globals for a specific project.

Open settings via the gear icon in the toolbar. The title bar shows whether you are editing Global or Project settings.

---

## Global Settings

### Claude CLI Options

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| **Permission Mode** | Select | Default (none) | Permission mode passed to the `claude` command when launching new sessions. Options: Default (none), Accept Edits, Plan Mode, Don't Ask, Bypass. |
| **Worktree** | Toggle | Off | Enable worktree for new sessions. When on, Claude is started inside a git worktree. |
| **Worktree Name** | Text | auto | Custom name for worktree branches. Leave blank to auto-generate. |
| **Chrome** | Toggle | Off | Enable Chrome browser automation (`--chrome` flag). |
| **Additional Directories** | Text | — | Comma-separated list of extra directories to include in Claude sessions (passed as additional context paths). |

### Session Launch

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| **Pre-launch Command** | Text | — | Command prepended to the `claude` invocation (e.g. `aws-vault exec profile --`). Useful for credential wrappers. |

### Application

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| **Terminal Theme** | Select | Switchboard | Color theme for terminal sessions. Multiple themes are available. Takes effect immediately. |
| **Terminal Right-Click** | Select | Context menu | What a right-click does in the terminal. See [Terminal](terminal.md) for details. Takes effect on the next right-click. |
| **Restore Sessions on Startup** | Select | Ask on startup | Whether to reopen sessions from the last run. Options: Don't restore, Ask on startup, Restore automatically. Read at launch — change takes effect next time you start Switchboard. |
| **Shell Profile** | Select | Auto (detect) | Shell used for terminal and Claude sessions. Auto detects your login shell. Changes take effect for new sessions only. |
| **Max Visible Sessions** | Number | 10 | Show up to this many sessions per project before collapsing the rest behind a "+N older" link. |
| **Session Max Age (days)** | Number | 3 | Sessions older than this are also hidden behind "+N older", even if under the count limit. |
| **IDE Emulation** | Toggle | On | Register Switchboard as an IDE so Claude can open files and diffs in the side panel. Disable to use VS Code, Cursor, or another editor. Changes take effect for new sessions only. See [IDE Emulation](ide-emulation.md). |

### Keyboard Shortcuts

Three session-navigation shortcuts are rebindable. Click any shortcut button to capture a new combination. At least one modifier (Cmd/Ctrl, Option/Alt, or Shift) is required. Click again to reset to the default, or press Esc to cancel.

See [Keyboard Shortcuts](keyboard-shortcuts.md) for the defaults and full instructions.

### Updates

| Field | Description |
|-------|-------------|
| **Version** | Shows the current installed version and update status. |
| **Check for Updates** | Manually triggers an update check against GitHub Releases. |

Switchboard checks for updates automatically on launch and every 4 hours (packaged builds only). When an update is ready, a toast notification appears. You can restart immediately or dismiss — the update installs on the next quit.

---

## Project Settings

Project settings are opened by clicking the settings icon on a project in the sidebar. Each field has a **Use global default** checkbox. When checked, the global value is used. Uncheck to override for this project.

The following fields are available per project:

| Field | Description |
|-------|-------------|
| **Permission Mode** | Override the global permission mode for this project. |
| **Worktree** | Enable or disable worktree for new sessions in this project. |
| **Worktree Name** | Override the worktree branch name for this project. |
| **Chrome** | Enable or disable Chrome browser automation for this project. |
| **Additional Directories** | Extra directories specific to this project. |
| **Pre-launch Command** | Override the pre-launch command for this project. |

### Hide Project

The **Hide Project** button removes the project from the Switchboard sidebar. Your session files on disk are not deleted. The project can be re-added via the **Add Project** button.
