#!/usr/bin/env bash
# claude-sandbox.sh — launch Claude Code inside a bubblewrap (bwrap) sandbox.
#
# Used by the "Sandbox" session option (Linux only). The sandboxed process
# sees:
#   read-only:   /usr, /etc, the resolved claude binary's directory, the
#                resolved node interpreter's directory, $NVM_DIR, and the
#                podman API socket when one is live
#   read-write:  the project directory (cwd), Claude's own config/state
#                (~/.claude, ~/.claude.json, ~/.config/claude,
#                ~/.cache/claude, ~/.local/share/claude), and any extra
#                directories passed via $SWITCHBOARD_SANDBOX_BINDS
#                (colon-separated — Switchboard forwards "Additional
#                Directories" and the project root here; paths containing
#                ':' or a newline cannot be transported and are dropped on
#                the app side)
#   network:     shared with the host — Claude needs the API, and the
#                Switchboard IDE bridge listens on localhost
#
# Everything else — the rest of $HOME in particular — does not exist inside
# the sandbox. This is a FILESYSTEM boundary only: environment variables are
# inherited (no --clearenv) and the network namespace is the host's. Note
# that ~/.claude itself carries credentials and all projects' transcripts.
# See docs/settings.md for the full isolation contract.
#
# Host side effects: none until the sandbox is known to be constructible. The
# bwrap pre-flight runs against the binds that already exist, and only after it
# passes are missing state dirs created (a bind mount needs an existing source).
# A launch that bwrap refuses outright leaves $HOME untouched.
#
# Debugging: set SWITCHBOARD_SANDBOX_DEBUG=1 to print the resolved binary,
# every bind, and the full bwrap invocation before launch. From Switchboard,
# put `SWITCHBOARD_SANDBOX_DEBUG=1` in the session's Pre-launch Command.
#
# Usage: claude-sandbox.sh [claude args...]

set -u

DEBUG="${SWITCHBOARD_SANDBOX_DEBUG:-0}"
debug() { [ "$DEBUG" = "1" ] && echo "claude-sandbox: $*" >&2; return 0; }
fail() { echo "claude-sandbox: $*" >&2; exit 125; }

if ! command -v bwrap >/dev/null 2>&1; then
  fail "bwrap not found — install bubblewrap (e.g. apt install bubblewrap)"
fi

# type -P does a PATH search only, so a shell function, alias or builtin named
# "claude" cannot be mistaken for a path — `command -v` reports those as a bare
# word ("claude") or as "alias claude='...'", neither of which is executable.
# Switchboard launches us from `bash -l -i -c`, so the user's profile really is
# in play and wrappers around claude are common. Fall back to command -v so a
# genuinely odd setup still gets the old behaviour rather than a hard stop.
CLAUDE_BIN="$(type -P claude 2>/dev/null || true)"
[ -n "$CLAUDE_BIN" ] || CLAUDE_BIN="$(command -v claude 2>/dev/null || true)"
if [ -z "$CLAUDE_BIN" ]; then
  fail "claude not found in PATH ($PATH)"
fi

# readlink -f prints NOTHING and exits non-zero when a non-final component of
# the path is missing. Unvalidated, that empty string reached bwrap as the
# program to exec, and bwrap reported it as the useless
# "bwrap: execvp : No such file or directory" — an empty program name.
CLAUDE_REAL="$(readlink -f "$CLAUDE_BIN" 2>/dev/null || true)"
[ -n "$CLAUDE_REAL" ] || CLAUDE_REAL="$CLAUDE_BIN"
if [ ! -f "$CLAUDE_REAL" ] || [ ! -x "$CLAUDE_REAL" ]; then
  fail "resolved claude is not an executable file: '$CLAUDE_REAL' (resolved from '$CLAUDE_BIN'). If 'claude' is a shell function or alias wrapping the real binary, put that binary on PATH — the sandbox has to exec a file, not a shell construct."
fi
debug "claude: $CLAUDE_BIN -> $CLAUDE_REAL"
debug "bwrap: $(command -v bwrap) ($(bwrap --version 2>/dev/null || echo 'version unknown'))"

# Refuse to be someone's very first claude launch: the CLI's first run creates
# and initialises ~/.claude and ~/.claude.json, and doing that through a bind
# list we had to invent up front is how you get a half-seeded config. Run
# claude once unsandboxed, then turn the option on.
if [ ! -e "$HOME/.claude" ]; then
  fail "$HOME/.claude does not exist — run claude once outside the sandbox first, then enable Sandbox mode"
fi

RW_STATE_DIRS=(
  "$HOME/.claude"
  "$HOME/.config/claude"
  "$HOME/.cache/claude"
  "$HOME/.local/share/claude"
)
RW_STATE_FILES=("$HOME/.claude.json")

# Project directory plus whatever Switchboard forwarded. These must already
# exist — creating a mistyped "Additional Directory" on the host would be worse
# than not binding it.
RW_DIRS=("$PWD")
if [ -n "${SWITCHBOARD_SANDBOX_BINDS:-}" ]; then
  # -d '' reads to NUL rather than newline, so a bind path containing a newline
  # is not silently truncated at the first one. read exits non-zero when it
  # never finds the delimiter; the array is populated regardless.
  EXTRA_BINDS=()
  IFS=':' read -r -d '' -a EXTRA_BINDS < <(printf '%s' "$SWITCHBOARD_SANDBOX_BINDS") || true
  for d in "${EXTRA_BINDS[@]}"; do
    [ -n "$d" ] && RW_DIRS+=("$d")
  done
fi

# Binding $HOME — or any ancestor of it, up to / — would expose the exact thing
# this sandbox exists to hide, while still reporting success. No project
# directory is ever legitimately $HOME or above, so in practice this means the
# session was launched with the wrong working directory. Fail closed and say so:
# a sandbox that silently hands out the whole home directory is worse than none,
# because the user believes they are protected.
for d in ${RW_DIRS[@]+"${RW_DIRS[@]}"}; do
  _bad=""
  case "$d" in
    /) _bad="the filesystem root" ;;
  esac
  case "$HOME" in
    "$d") _bad="\$HOME itself" ;;
    "$d"/*) _bad="a parent of \$HOME" ;;
  esac
  if [ -n "$_bad" ]; then
    fail "refusing to bind '$d' — it is $_bad, so the sandbox would expose everything it is meant to hide. Expected a project directory; the session's working directory is '$PWD'."
  fi
done

# True when $1 is at or below one of the read-write state dirs.
under_rw_state() {
  local candidate="$1/" d
  for d in "${RW_STATE_DIRS[@]}"; do
    case "$candidate" in "$d"/*) return 0 ;; esac
  done
  return 1
}

CLAUDE_BIN_DIR="$(dirname "$CLAUDE_REAL")"
RO_DIRS=()
# The native installer keeps versioned binaries under ~/.local/share/claude,
# which is bound read-write for claude's own updates — a read-only bind of the
# binary's directory would be overridden by it. Skip the bind rather than
# imply a guarantee we cannot keep (see docs/settings.md).
if under_rw_state "$CLAUDE_BIN_DIR"; then
  debug "claude binary dir $CLAUDE_BIN_DIR lives under Claude's state dirs — writable inside the sandbox"
else
  RO_DIRS+=("$CLAUDE_BIN_DIR")
fi
if [ -d "${NVM_DIR:-$HOME/.nvm}" ]; then
  RO_DIRS+=("${NVM_DIR:-$HOME/.nvm}")
fi

# The claude entrypoint is often a node script (#!/usr/bin/env node), so the
# node that will run it must exist inside the sandbox too. Version managers
# other than nvm (fnm, volta, asdf, n) keep node outside $NVM_DIR — bind the
# resolved interpreter's directory wherever it lives. Absent node is fine: the
# native installer ships a self-contained binary that needs no interpreter.
NODE_BIN="$(type -P node 2>/dev/null || true)"
if [ -n "$NODE_BIN" ]; then
  RO_DIRS+=("$(dirname "$(readlink -f "$NODE_BIN")")")
  debug "node: $NODE_BIN"
else
  debug "node not on PATH — skipping (fine unless claude is a node script)"
fi

# Don't assume the interpreter is node. claude may be installed via npm, bun,
# or a distro package, so read the shebang of whatever we actually resolved and
# bind that interpreter. A missing interpreter is the one case where the launch
# is doomed but the wrapper itself cannot tell — warn loudly instead of letting
# it surface as an opaque exec failure inside the sandbox.
if [ "$(head -c 2 "$CLAUDE_REAL" 2>/dev/null)" = '#!' ]; then
  IFS=' ' read -r _shebang_cmd _shebang_arg _ < <(head -n 1 "$CLAUDE_REAL" 2>/dev/null | sed 's/^#!//')
  if [ "$(basename "${_shebang_cmd:-}")" = 'env' ]; then
    _interp="${_shebang_arg:-}"
  else
    _interp="${_shebang_cmd:-}"
  fi
  if [ -n "$_interp" ]; then
    _interp_path="$(type -P "$_interp" 2>/dev/null || true)"
    case "$_interp" in /*) [ -n "$_interp_path" ] || _interp_path="$_interp" ;; esac
    if [ -n "$_interp_path" ] && [ -e "$_interp_path" ]; then
      RO_DIRS+=("$(dirname "$(readlink -f "$_interp_path")")")
      debug "claude is a script; interpreter $_interp -> $_interp_path"
    else
      echo "claude-sandbox: warning: claude is a script needing '$_interp', which is not on PATH — it will not exist inside the sandbox" >&2
    fi
  fi
fi

# Podman: only when installed and its API socket is live. Read-only is enough —
# connect(2) on a unix socket works across a read-only bind mount. Docker's
# socket is deliberately not bound; see docs/settings.md.
PODMAN_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/podman"
if command -v podman >/dev/null 2>&1 && [ -S "$PODMAN_DIR/podman.sock" ]; then
  RO_DIRS+=("$PODMAN_DIR")
  debug "podman socket live, binding $PODMAN_DIR read-only"
fi

BIND_ARGS=()
# Read-only binds go first so a read-write bind of a nested directory
# (e.g. ~/.local/share/claude under a read-only parent) mounts over it.
for d in ${RO_DIRS[@]+"${RO_DIRS[@]}"}; do
  if [ -e "$d" ]; then
    BIND_ARGS+=(--ro-bind "$d" "$d")
    debug "ro-bind $d"
  else
    debug "skip ro-bind $d (does not exist)"
  fi
done
for d in "${RW_DIRS[@]}"; do
  if [ -e "$d" ]; then
    BIND_ARGS+=(--bind "$d" "$d")
    debug "rw-bind $d"
  else
    echo "claude-sandbox: skipping bind — does not exist: $d" >&2
  fi
done
for d in "${RW_STATE_DIRS[@]}" "${RW_STATE_FILES[@]}"; do
  # Missing state paths are created after the pre-flight, not now — a launch
  # bwrap is going to refuse must not leave anything behind in $HOME.
  if [ -e "$d" ]; then
    BIND_ARGS+=(--bind "$d" "$d")
    debug "rw-bind $d"
  else
    debug "defer rw-bind $d (does not exist yet)"
  fi
done

BWRAP_ARGS=(
  --dev /dev
  --proc /proc
  --tmpfs /tmp
  --unshare-all
  --share-net
  --die-with-parent
  --dir /var
  --ro-bind /usr /usr
  --ro-bind /etc /etc
  --symlink usr/lib /lib
  --symlink usr/lib64 /lib64
  --symlink usr/bin /bin
  --symlink usr/sbin /sbin
  ${BIND_ARGS[@]+"${BIND_ARGS[@]}"}
  --chdir "$PWD"
  --setenv SHELL /bin/bash
)

debug "full command: bwrap ${BWRAP_ARGS[*]} $CLAUDE_REAL $*"

# Pre-flight: build the exact sandbox once around /bin/true so mount/namespace
# problems surface as bwrap's own error message instead of a claude crash.
if ! PREFLIGHT_ERR="$(bwrap "${BWRAP_ARGS[@]}" /bin/true 2>&1)"; then
  echo "claude-sandbox: bwrap failed to set up the sandbox:" >&2
  echo "  ${PREFLIGHT_ERR:-'(no error output)'}" >&2
  # Ubuntu 23.10+ (24.04 LTS included) ships
  # kernel.apparmor_restrict_unprivileged_userns=1, and the distro bubblewrap
  # package carries no AppArmor profile of its own — so every unprivileged
  # bwrap fails here, with nothing about the message pointing at the cause.
  case "$PREFLIGHT_ERR" in
    *"setting up uid map"*|*"namespace"*|*"Operation not permitted"*)
      echo "  this usually means unprivileged user namespaces are restricted (Ubuntu 23.10+ default)." >&2
      echo "  check:  sysctl kernel.apparmor_restrict_unprivileged_userns" >&2
      echo "  fix it either by relaxing the restriction:" >&2
      echo "    echo 'kernel.apparmor_restrict_unprivileged_userns=0' | sudo tee /etc/sysctl.d/60-apparmor-userns.conf && sudo sysctl --system" >&2
      echo "  or by granting bwrap an AppArmor profile with 'userns,' (keeps the restriction on for everything else)." >&2
      ;;
  esac
  echo "  re-run with SWITCHBOARD_SANDBOX_DEBUG=1 (Pre-launch Command in Switchboard) to see every bind" >&2
  exit 125
fi
debug "pre-flight OK, launching claude"

# The sandbox is constructible — now it is safe to materialise the state dirs
# bwrap needs as bind sources. Anything created here, claude would have created
# on its own outside the sandbox.
LATE_BIND_ARGS=()
for d in "${RW_STATE_DIRS[@]}"; do
  if [ ! -e "$d" ]; then
    mkdir -p "$d" || fail "could not create $d"
    LATE_BIND_ARGS+=(--bind "$d" "$d")
    debug "created + rw-bind $d"
  fi
done
for f in "${RW_STATE_FILES[@]}"; do
  if [ ! -e "$f" ]; then
    # An empty object, not an empty file: claude parses this path as JSON.
    echo '{}' > "$f" || fail "could not create $f"
    LATE_BIND_ARGS+=(--bind "$f" "$f")
    debug "created + rw-bind $f"
  fi
done
exec bwrap "${BWRAP_ARGS[@]}" ${LATE_BIND_ARGS[@]+"${LATE_BIND_ARGS[@]}"} "$CLAUDE_REAL" "$@"
