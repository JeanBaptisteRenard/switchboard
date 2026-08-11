# 0001 — No full Go rewrite; Go backend sidecar only, if ever

**Status**: Accepted (2026-06-08)

## Context

Switchboard's main process is ~6000 LOC of Node.js doing SQLite/FTS indexing, an `fs.watch` filesystem watcher, PTY spawning (`node-pty`), cron scheduling, an MCP WebSocket bridge, and IPC. The renderer is ~8500 LOC of Chromium JS. The question "should we rewrite this in Go?" comes up periodically — usually motivated by memory footprint (Electron's baseline RAM) and by wanting to eliminate the native-module segfault class documented in [`_issues.md`](../../.ai/contexts/_issues.md) (rebuilding `better-sqlite3`/`node-pty` while the app is running can kill the live process).

A feasibility pass was done specifically to check whether the backend is portable to Go and whether the whole app could follow.

## Decision

**Do not do a full Go rewrite.** The app splits cleanly into two halves with very different portability:

- **Main process (~6000 LOC)** — SQLite/FTS, fs watcher, PTY spawn, cron, MCP WS, IPC. This is Go-friendly. In particular, the PTY surface is small (spawn/onData/onExit/write/resize/kill, plus a resize-nudge in `main.js`) and is fully covered by `creack/pty`. Porting this piece would also kill the native-rebuild segfault class outright, since a Go binary has no `dlopen()`'d Node native module to invalidate mid-run.
- **Renderer (~8500 LOC)** — built on `xterm.js` (terminal emulator, 5 addons including WebGL) and CodeMirror 6 (diff/IDE-emulation, ~1.6 MB bundle). Neither has a mature Go equivalent. The PTY only yields raw bytes; the *terminal emulator* that turns those bytes into a rendered grid lives in `xterm.js`. Rewriting this in Go means rewriting or replacing the two most feature-dense parts of the UI — this is the wall a full rewrite runs into.

The memory-footprint argument is also partly self-defeating: the big RAM win (~30-80 MB, native toolkits like Gio/Fyne) requires rewriting all the visual code, while the "reasonable" middle path (Wails, keeps HTML/JS) only saves ~30-40% and trades away Chromium's rendering consistency (falls back to WebKitGTK on Linux) and WebGL guarantees.

There's a second, easy-to-miss cost: a full rewrite **breaks fork↔upstream alignment**. This fork tracks `doctly/switchboard` and regularly cherry-picks or ports upstream PRs (see the fork-specific-features list in [`../../.ai/shared-guidelines.md`](../../.ai/shared-guidelines.md)). A different stack means every future upstream feature needs re-porting by hand into Go — an ongoing tax, not a one-time cost.

**If the RAM/crash pain becomes acute, in order of preference:**

1. Optimize the existing Electron app first (e.g. virtualize grid xterm instances) — cheapest, keeps upstream alignment.
2. Extract a **backend-only Go sidecar** (watcher + cache + schedule + MCP) driven by `main.js` over IPC. Incremental, and the renderer/UI stays untouched — upstream alignment on UI is preserved.
3. A full native Go rewrite is only worth it if the goal changes to shipping a new, minimal product that deliberately abandons `xterm.js`/CodeMirror and upstream sync — not as an optimization of the current app.

## Consequences

- No Go rewrite ticket should be scoped as "port the whole app." A Go-related proposal should default to the sidecar shape (option 2) unless it explicitly argues for abandoning upstream sync.
- The native-module segfault risk (build-while-running) is mitigated today by `--config.npmRebuild=false`, not by a rewrite — see the "Safe build while running" guidance in [`../../.ai/shared-guidelines.md`](../../.ai/shared-guidelines.md).
- Revisit this decision if `xterm.js` or CodeMirror gain a maintained Go/WASM-native equivalent, or if the product goal shifts away from staying close to `doctly/switchboard` upstream.
