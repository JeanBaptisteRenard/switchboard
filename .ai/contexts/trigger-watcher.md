# Context: trigger-watcher

**Purpose**: lets external harness scripts inject keyboard input into open PTY sessions without any Electron IPC.  The primary use case is the token-usage harness calling `/compact` on a session when it detects a high context-window fill.

## Key files

| File | LOC | Role |
|---|---|---|
| `trigger-watcher.js` | ~800 | The entire module: directory setup, `fs.watch` listener, idle-wait logic, single + chained trigger processing, submit-with-verify busy-rise/fall polling, input validation, PTY write, result file. |
| `main.js` (wiring) | 15 | `require('./trigger-watcher').start(ctx)` in the `app.whenReady` block, right after `startScheduler`. |

## Public surface

### `start(ctx)` → `{ close() }`

Starts the watcher.  Call once at app boot.

```js
require('./trigger-watcher').start({
  log,                          // electron-log compatible
  getPtyForSession(sessionId),  // → { ptyProcess } | null
  isSessionBusy(sessionId),     // → boolean
  getComposerState(sessionId),  // → { pending, lastInputAt } | null
});
```

`getPtyForSession` returns `null` when the session is unknown or has already exited.
`isSessionBusy` reads `session._cliBusy` — the same flag that tracks OSC 0 title-change spinner chars.
`getComposerState` reads `session.composerState`, the running count of bytes the
user typed and has not submitted (`composer-state.js`, fed from
`ipcMain.on('terminal-input')`).  It returns `null` for an unknown or exited
session, and **a `null` — or an absent `getComposerState` — means busy, never
free**.

## The submission contract

The transport honours `conventions/session-trigger-transport.md` in the harness
repository.  Three obligations show up in this file:

**Politeness.** Nothing is written into a session that has input typed and not
submitted.  `waitForComposerFree(sessionId, ctx, deadlineMs)` polls every
`IDLE_POLL_INTERVAL` and calls the composer free only when `pending === 0` **and**
`now - lastInputAt >= quietMs` (`SWITCHBOARD_TRIGGER_QUIET_MS`, default 3000 ms).
It gates every PTY write: the single-`command` path, every `chain` step, and the
bare recovery `` inside `submitWithVerify` — that last one is the sharp edge,
since a lone `` on somebody's half-typed sentence submits the sentence.  Every
wait is bounded by the deadline already in force; the recovery `` is bounded by
the shorter of that deadline and one verify window.

Two consequences beyond hygiene, both measured on Claude Code v2.1.258: a
`/compact` injected while the user was typing concatenated itself onto their
sentence, and a slash command injected into a **non-empty** composer never
submits at all — the CLI only submits `/compact` through the completion menu,
which opens only when the `/` is the first character of an empty box.  A VPS
session slept nine hours with an inert `/compact` sitting in its composer.

**How the counter is built, and where it is blind.** See the "Politeness" section
of `docs/automation.md` — the blind spots are listed there and are part of the
contract, not an implementation detail.

**`submitted`.** Every result carries it, compared by strict equality:
`confirmed` (a busy rising edge was observed after our write), `assumed`
(written, no failure seen, nothing observed after), `no` (nothing written, or
written and not submitted).  A chain reports the **weakest** of its steps
(`weakestSubmitted`), because the field exists to stop a transport overstating
what it saw.

**`not sent` vs `chain timeout`.** `error` is compared by strict equality, so the
detail goes in `reason` and never into `error` — `not sent: input pending` is not
`not sent`.  `not sent` promises the session was never touched: a chain whose
step 0 landed and whose step 1 was held back by politeness reports
`chain timeout`, never `not sent`.

**An unknown `wait` is refused, loudly.** Only `idle` and `none` are accepted.
An **absent** field still defaults to `none` (existing triggers rely on it), but
any other value — empty string, `null`, a typo — is refused before any write
with `error: "not sent"` and a `reason` naming the value received.  The previous
behaviour, silently falling back to `none`, chose the more dangerous of the two.

The returned `{ close() }` handle is not held by `main.js` (no graceful-close needed — Electron kills the process, and `persistent: false` is not set so the watcher keeps the event loop alive naturally).

## Trigger file contract

Drop a file at `SWITCHBOARD_TRIGGERS_DIR/<uuid>.json` (default `~/.switchboard/triggers/`):

```json
{
  "sessionId": "abc-123-def",
  "command": "/compact",
  "wait": "idle",
  "timeout_ms": 120000
}
```

Fields:
- `sessionId` — must match a key in `activeSessions` (`main.js`)
- `command` — written to the PTY, then Enter is sent as a SEPARATE write (discrete submit; a `\r` concatenated onto the text can be absorbed by the composer). Mutually exclusive with `chain`.
- `chain` — array of up to 20 `{command, ...}` steps (`MAX_CHAIN_LENGTH`), injected sequentially; each step's submission is verified (busy-rise) with one bare-Enter retry before the next step is sent. Mutually exclusive with `command`; exactly one of the two is required.
- `wait` — `"none"` (default) | `"idle"`.  `"idle"` polls `isSessionBusy` every 100 ms until the session goes idle or the timeout fires.
- `timeout_ms` — optional positive integer, ≤ 600 000 ms.  Overrides both the env var and the default for this trigger only.  On invalid value → `{ok:false, error:"invalid timeout_ms"}`, semaphore released, no PTY write.

**Timeout precedence**: per-trigger `timeout_ms` > `SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS` env var > compiled default (300 000 ms).

Result written to `SWITCHBOARD_TRIGGERS_DIR/processed/<uuid>.result.json`:

```json
{ "ok": true,  "sessionId": "...", "command": "...", "sent_at": "...", "waited_ms": 320 }
{ "ok": false, "error": "<reason>", "sessionId": "..." }
```

Trigger file is **deleted** after processing (success or failure).

## Invariants

- **Never throws out of the watcher callback** — every error path lands in the result file.
- **Deduplication via `inFlight` Set** — noisy `rename` events for the same file (common on Linux inotify) are coalesced; a file is processed at most once per appearance.
- **`accessSync` guard** — the `rename` event fires both on file creation and deletion; the existence check prevents processing a deletion event.
- **Directories ignored** — non-`*.json` filenames and any name containing `/` or `path.sep` are skipped.
- **Invalid `timeout_ms` releases the semaphore** — validation happens before the session look-up and before acquiring an idle-wait slot; a bad value produces a result file and returns without counting against `MAX_INFLIGHT`.

## Non-obvious behaviors

- **OSC-title-based busy detection**: `session._cliBusy` is set to `true` by the OSC 0 handler in `main.js` when `classifyTitleActivity()` reads the title as a spinner frame, and back to `false` when the ✳ idle char (U+2733) appears.  The glyph set is not fixed — see `.ai/contexts/ipc-bridge.md`, "The OSC 0 title is the primary busy channel".  The trigger watcher reuses this flag directly via `isSessionBusy`.
- **Politeness is not `wait`** — `wait` is about the CLI being busy; the politeness guard is about the human's composer.  `wait:"none"` still cannot write over typed input.
- **`wait:"none"` sends even if busy** — it is the caller's responsibility to choose the right wait strategy. The harness should use `"idle"` for `/compact` to avoid injecting into a mid-response stream.
- **Timeout env var for tests** — `SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS` lets tests use a 200 ms timeout instead of 30 s, making the idle-timeout test fast.
- **`persistent: true` on `fs.watch`** — the watcher keeps the Node event loop alive, matching the pattern of all other persistent watchers in `main.js` (projects watcher, subagent watcher).

## Change-also checklist

- If you rename `_cliBusy` on `session` in `main.js`, update `isSessionBusy` in the `start(ctx)` wiring block.
- If you rename `session.composerState` or stop feeding it from `ipcMain.on('terminal-input')`, `getComposerState` returns `null` and **every trigger renounces with `not sent`** — the safe direction, but the channel goes silent.  Tests for the counter live in `test/composer-state.test.js`.
- If you rename `activeSessions` or change the structure (`session.pty` → `session.ptyProcess`), update both `getPtyForSession` and `isSessionBusy` in the wiring block.
- Tests live in `test/trigger-watcher.test.js`.  They use `SWITCHBOARD_TRIGGERS_DIR` env override — do not hardcode paths there.
