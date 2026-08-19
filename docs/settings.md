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
| **Sandbox** | Toggle | Off | Linux only. Run `claude` inside a [bubblewrap](https://github.com/containers/bubblewrap) sandbox that hides the rest of `$HOME`. Requires `bwrap` to be installed. Takes effect for new sessions (interactive and scheduled). See [What the sandbox does and doesn't isolate](#what-the-sandbox-does-and-doesnt-isolate). |
| **Additional Directories** | Text | — | Comma-separated list of extra directories to include in Claude sessions (passed as additional context paths). |

#### What the sandbox does and doesn't isolate

The sandbox is a **filesystem** boundary, built with `bwrap` by `scripts/claude-sandbox.sh` (shipped inside the app — only bubblewrap itself needs to be installed).

Visible inside the sandbox:

- **read-write** — the project directory, Additional Directories, the project root when resuming a worktree session, and Claude's own state: `~/.claude`, `~/.claude.json`, `~/.config/claude`, `~/.cache/claude`, `~/.local/share/claude`.
- **read-only** — `/usr`, `/etc`, the resolved `claude` binary's directory, the resolved `node` interpreter's directory, `$NVM_DIR`, and the podman API socket when one is live.

Everything else — the rest of `$HOME` in particular (`~/.ssh`, `~/.gitconfig`, other projects' source trees) — does not exist inside the sandbox.

Deliberately **not** isolated — know these before relying on it:

- **Environment variables are inherited.** No `--clearenv`: anything exported in your shell profile or injected by a Pre-launch Command (`AWS_*`, tokens, agent sockets) is visible inside the sandbox.
- **The network is the host's** (`--share-net`). Claude needs the Anthropic API, and the Switchboard IDE bridge listens on localhost — but this also means other localhost services and the LAN are reachable.
- **Claude's state is shared across projects.** `~/.claude` holds credentials and *every* project's transcripts and memory; a sandboxed session can read all of it. The boundary protects the rest of `$HOME`, not one project from another.
- **The `claude` binary is not always read-only.** With the native installer the versioned binary lives under `~/.local/share/claude`, which has to be read-write for Claude's own updates — so on that layout the binary's directory is writable inside the sandbox. On npm/nvm layouts it is read-only. The wrapper detects which case applies and drops the misleading read-only bind rather than pretending it holds.

A session running inside the sandbox shows a **🔒 Sandbox** badge in the terminal header, so you can tell at a glance whether the isolation is on; hovering it summarises what is and isn't confined.

Prerequisites and known blockers:

- **Ubuntu 23.10 and later (24.04 LTS included) block this out of the box.** Those releases default to `kernel.apparmor_restrict_unprivileged_userns=1` and the distro `bubblewrap` package ships no AppArmor profile of its own, so *every* unprivileged `bwrap` — not just a nested one — fails at `bwrap: setting up uid map: Permission denied`. The failure is safe (nothing launches) and the wrapper prints the remedies; pick one:
  - relax the restriction: `echo 'kernel.apparmor_restrict_unprivileged_userns=0' | sudo tee /etc/sysctl.d/60-apparmor-userns.conf && sudo sysctl --system`
  - or keep it on globally and grant `bwrap` an AppArmor profile containing `userns,`.
- **Run `claude` once outside the sandbox first.** If `~/.claude` does not exist the wrapper refuses to launch, rather than pre-seed a config the CLI is about to initialise itself.

Practical limitations:

- `~/.gitconfig` is not visible, so `git commit` inside the sandbox has no user identity unless the repo sets one locally.
- Claude Code's own Bash-tool sandboxing also uses namespaces, so it needs unprivileged user namespaces too. Where those are available to the outer sandbox they are generally available to the inner one as well, but if the Bash tool starts failing only under Sandbox mode, disable one of the two layers.
- **Docker is not reachable.** Only podman's API socket is bound. Neither `/var/run/docker.sock` nor a rootless `$XDG_RUNTIME_DIR/docker.sock` exists inside the sandbox, so `docker` / `docker compose` commands will fail — relevant for projects whose test suite runs in Compose.
- Extra bind paths containing `:` or a newline cannot be forwarded (the bind list is a colon-separated env var) — they are skipped with a warning in the main log.
- Debugging: put `SWITCHBOARD_SANDBOX_DEBUG=1` in the session's Pre-launch Command to print every bind and the full `bwrap` invocation; a pre-flight reports bwrap setup errors before claude starts.

Non-Linux platforms: the toggle is hidden, and a session or schedule that still carries `sandbox: true` (e.g. from a settings file synced from a Linux machine) is refused rather than run unconfined — including scheduled runs, where nobody is watching.

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
| **Automatic Updates** | Toggle, on by default. Download updates in the background and install them when Switchboard quits. Turn off to keep the installed binary exactly as it is — **Check for Updates** still works, and a manual check downloads the update so you can restart into it. Read at launch, so a change takes effect next time you start Switchboard. |
| **Version** | Shows the current installed version and update status. |
| **Check for Updates** | Manually triggers an update check against GitHub Releases. |

With **Automatic Updates** off, Switchboard never fetches or replaces its own binary on its own initiative — only when you press **Check for Updates**. This matters if you run a locally built or patched build: with it on, the next upstream release is downloaded and swapped in on quit, silently replacing your build with the official one of the same or higher version.

Unless **Automatic Updates** is off, Switchboard checks for updates automatically on launch and every 4 hours (packaged builds only). When an update is ready, a toast notification appears. You can restart immediately or dismiss — the update installs on the next quit.

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
| **Sandbox** | Enable or disable the bubblewrap sandbox for this project (Linux only). |
| **Additional Directories** | Extra directories specific to this project. |
| **Pre-launch Command** | Override the pre-launch command for this project. |

### Hide Project

The **Hide Project** button removes the project from the Switchboard sidebar. Your session files on disk are not deleted. The project can be re-added via the **Add Project** button.
