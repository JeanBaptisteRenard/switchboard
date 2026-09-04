# Context: trigger-watcher

**Purpose**: lets external harness scripts inject keyboard input into open PTY sessions without any Electron IPC.  The primary use case is the token-usage harness calling `/compact` on a session when it detects a high context-window fill.

## Key files

| File | LOC | Role |
|---|---|---|
| `trigger-watcher.js` | ~800 | The entire module: directory setup, `fs.watch` listener, idle-wait logic, single + chained trigger processing, submit-with-verify busy-rise/fall polling, input validation, PTY write, result file. |
| `trigger-context.js` | ~35 | `createTriggerContext({ activeSessions, log })` — builds the whole `ctx` object out of `main.js`'s session map. |
| `terminal-input.js` | ~20 | `handleTerminalInput(activeSessions, sessionId, data, now)` — the body of the `terminal-input` IPC handler; feeds `session.composerState`. |
| `main.js` (wiring) | 3 | `require('./trigger-watcher').start(createTriggerContext({ activeSessions, log }))` in the `app.whenReady` block, right after `startScheduler`, plus the one-line `terminal-input` registration. |

## Public surface

### `start(ctx)` → `{ close() }`

Starts the watcher.  Call once at app boot.

```js
// main.js
require('./trigger-watcher').start(createTriggerContext({ activeSessions, log }));

// trigger-context.js builds the ctx:
{
  log,                          // electron-log compatible
  getPtyForSession(sessionId),  // → { ptyProcess } | null
  isSessionBusy(sessionId),     // → boolean
  getComposerState(sessionId),  // → { pending, lastInputAt } | null
  isPtyAlive(ptyProcess),       // optional; only present when supplied
}
```

`getPtyForSession` returns `null` when the session is unknown or has already exited.
`isSessionBusy` reads `session._cliBusy` — the same flag that tracks OSC 0 title-change spinner chars.
`getComposerState` reads `session.composerState`, the running model of what the
user typed and has not submitted (`composer-state.js`, fed from
`terminal-input.js`, called from `ipcMain.on('terminal-input')`).  It returns
`null` for an unknown or exited session, and **a `null` — or an absent `getComposerState` — means busy, never
free**.

## The submission contract

The transport honours `conventions/session-trigger-transport.md` in the harness
repository.  Three obligations show up in this file:

**Politeness.** Nothing is written into a session that has input typed and not
submitted.  `waitForComposerFree(sessionId, ctx, deadlineMs)` polls every
`IDLE_POLL_INTERVAL` and calls the composer free only when `pending === 0` **and**
`now - lastInputAt >= quietMs` (`SWITCHBOARD_TRIGGER_QUIET_MS`, default 3000 ms).
It gates every PTY write: the single-`command` path, every `chain` step, and the
bare recovery `
` inside `submitWithVerify` — that last one is the sharp edge,
since a lone `
` on somebody's half-typed sentence submits the sentence.  Every
wait is bounded by the deadline already in force; the recovery `
` is bounded by
the shorter of that deadline and one verify window.

Two consequences beyond hygiene, both measured on Claude Code v2.1.258: a
`/compact` injected while the user was typing concatenated itself onto their
sentence, and a slash command injected into a **non-empty** composer never
submits at all — the CLI only submits `/compact` through the completion menu,
which opens only when the `/` is the first character of an empty box.  A VPS
session slept nine hours with an inert `/compact` sitting in its composer.

**Politeness bounds the wait, and `wait:"none"` is not exempt.** The composer
wait runs to the trigger's deadline — `timeout_ms`, or the idle default, 300 000
ms — and holds one of the `MAX_INFLIGHT` (8) slots for its whole duration. So
`wait:"none"` no longer means "write now": on a non-empty composer it blocks
like any other, and a few such triggers stall the queue. `timeout_ms` is the
only lever.

**Liveness is probed after the waits, never before them.** `isPtyAlive` runs
once as a pre-flight, then again *after* `waitForComposerFree` on the
single-`command` path and on every chain step. A probe taken before a wait that
can last minutes proves nothing about the process at the moment of the write.
The residual probe→write window is bounded by the try/catch on the write.

**How the model is built, and where it is blind.** `composer-state.js` keeps a
copy of the composer's text and a cursor into it, and applies the editing keys
it recognises (backspace, Delete, Ctrl+W, Ctrl+K, Alt+Backspace, Ctrl+A/Ctrl+E,
Home/End, arrows). `pending` is that text's length in code points. A scalar
counter could not model those keys — the number of characters a Ctrl+W removes
is unknowable without the text — and left `pending` positive for good after any
of them, which mutes every later trigger for that session. See the "Politeness"
section of `docs/automation.md` for the full table and the blind spots; they are
part of the contract, not an implementation detail.

**Terminal reports are not user input — fixed 2026-09-02 after a real-world
measurement.** Mouse tracking reports arrive on the same IPC channel as
keystrokes, one per pointer motion, so `noteUserInput` — which stamped
`lastInputAt` at its head for any non-empty chunk — read a resting pointer as
continuous typing. On the real CLI, composer emptied with Ctrl+U and no key
touched: with the pointer over the terminal a trigger waited its whole 30 s and
was **refused** (`"the last keystroke landed 47 ms ago, inside the 3000 ms quiet
window"`, `waited_ms: 30046`); with the pointer off the terminal the same
trigger needed `waited_ms: 15504` to find 3 s of silence. `docs/automation.md`
had promised the opposite ("at most ~3 s each time, never a refusal on its
own"), so the feature was in practice unusable whenever the user sat in front of
the machine. The parser now has a third category — recognised, but touching
neither the text nor the clock — holding exactly two forms: SGR mouse reports
and focus reports. `lastInputAt` is stamped after parsing, only if at least one
element of the chunk counted. Reports still reach the PTY untouched: the TUI
needs them. Two things to keep in mind before widening this. The exemption is
strict by design — a near-miss (wrong parameter count, non-numeric parameter,
another final byte, a report truncated at a chunk boundary) still counts as
input, because a wrong exemption produces a false "free", and a false "free" is
the catastrophic direction. And the renderer independently drops `ESC [ I` /
`ESC [ O` before the IPC send (`public/terminal-manager.js`, in `onData`), so
the focus branch is defence in depth rather than the live path — do not delete
either half on the grounds that the other exists.

**X10 mouse reports were tried here and removed — do not add them back without
first wiring `terminal.onBinary`.** xterm.js sends the DEFAULT (X10) encoding
through `triggerBinaryEvent`, and nothing in this repo subscribes to that
channel, so `ESC [ M` + 3 payload bytes can never arrive on the input path. The
only producer of `ESC [ M` on `onData` is therefore a person: Escape emits
`ESC` alone, then `[`, then `M`. Exempting it meant that typing Escape, `[M`
and up to three more characters left `pending` at 0 on a composer holding real
text — a false "free", the one the guard exists to prevent — and that half an
X10 report held in `state.partial` swallowed the next SGR report and inserted
its remainder as text, freezing the composer until an Enter. Both paths were
safe before the exemption was added. The branch protected an unreachable case
at the cost of a reachable regression.

**Two blind spots the exemption does not close**, both written up in the
"Politeness" section of `docs/automation.md`. xterm.js puts more than reports on
that channel — the OSC colour reply, the XTWINOPS size replies, DA1 and CPR —
and those still push the quiet clock; their periodicity is unverified, so
"solicited, therefore one-off" is a reserve rather than a fact. Worse: in the
alternate buffer with mouse tracking off, the wheel becomes arrow keys, and a
bare `ESC [ A` reads as a history recall here, so three notches put `pending` at
3 and mute every trigger for that session until an Enter or a Ctrl+U. That one
predates the report work and is deliberately left alone.

One of them is worth repeating here because it is a **dated measurement, not a
property**: on Claude Code v2.1.258, measured on an isolated PTY with a screen
dump, plain `ESC [ A` and `ESC O A` recall history and fill the composer (the
screen shows `─── History 2/2 ───`), so the model inserts one placeholder for
them; `ESC [ 1;2 A` (Shift+Up), `ESC [ 1;3 A` (Alt+Up) and `ESC [ 1;5 A`
(Ctrl+Up) leave the box empty, so ignoring them is not an undercount *on that
version*. A CLI release giving those chords a meaning would reopen an
undercount — the dangerous direction, since it reads a full composer as free.

**Measuring what actually writes to the input channel.** On JB's machine the
guard still refuses triggers on a composer the user can see is empty, with
`lastInputAt` pushed every ~50–200 ms. A code investigation ruled out every
periodic producer (no `setInterval` in the repo, none in xterm.js, no ConPTY
poll beyond the ~80 ms startup handshake) and the mouse (Claude Code never sends
`ESC [ ?1002h` / `ESC [ ?1003h`, and xterm.js de-duplicates identical motions, so
a resting pointer emits nothing). What remains, unproven, is xterm.js *answering*
queries the CLI emits while redrawing — CPR, DA, DECRQM, OSC replies — or a
sequence whose final byte `applyCsi` does not handle. The activity trace's
`pty.input` probe (`main.js`, in `ipcMain.on('terminal-input')`) settles it by
recording every chunk the renderer sends to the PTY — its length always, its
code points only from the first control character onwards, so a typed chunk
leaves a length and nothing readable:

```bash
SWITCHBOARD_ACTIVITY_TRACE=1 task dev
TRACE=~/.switchboard-dev/activity-trace-*.jsonl

# What arrives, in order. A line with no `cp` was a chunk of printable text —
# the probe records its length only, never its content (docs/activity-trace.md).
jq -r 'select(.cat=="pty.input") | "\(.wall)\t\(.len)\t\(.at // "-")\t\(.cp // "-")"' $TRACE

# Which control sequences dominate — the suspects are all in here
jq -r 'select(.cat=="pty.input" and .cp) | .cp' $TRACE | sort | uniq -c | sort -rn
```

**Take four control shots, not two.** The two measurements taken so far were
n=1 per condition and varied the pointer while the CLI's own activity varied
with it, so they could not tell the two apart — and the fix they motivated
addressed the wrong factor. Run the full grid: {CLI idle, CLI busy — a task
spawning subagents} × {pointer resting over the terminal, pointer moved off the
window}. In each cell: empty the composer with Ctrl+U, touch nothing, drop a
trigger, and record both the result (`waited_ms`, refusal or not) and the
`pty.input` lines in that window. The culprit is whichever factor moves the
chunk rate, and the chunks to look for push the quiet clock while leaving
`pending` at 0 — which excludes X10 and history recall by construction.

The SGR-and-focus exemption above (PR #160) is correct and worth keeping, but it
**cannot** be the cause of this symptom: exempting mouse reports cannot quiet a
channel that carries none, since Claude Code never turns motion tracking on.

**`submitted`.** Every result carries it, compared by strict equality:
`confirmed` (a busy rising edge was observed after our write), `assumed`
(written, no failure seen, nothing observed after), `no` (nothing written, or
written and not submitted).  A chain reports the **weakest** of its steps
(`weakestSubmitted`), because the field exists to stop a transport overstating
what it saw.

**`not sent` vs `chain timeout`.** `error` is compared by strict equality, so the
detail goes in `reason` and never into `error` — `not sent: input pending` is not
`not sent`.  `reason` is the only field that carries detail; nothing downstream
may parse `error` for a substring.

| `error` | Promise to the reader | Consequence in the harness |
|---|---|---|
| `not sent` | not one byte was written into the target | the pending guard is **voided**; the emitter retries from scratch |
| `chain timeout` | at least one step was written, the effect was not observed | the guard **keeps blocking** the next compaction |
| free text (`session not found`, `pty write failed: …`, validation refusals) | no reserved meaning | read `submitted` |

The invariant, in one line: **no result says `not sent` if a byte reached the
target, and no result says `chain timeout` if none did.**  Concretely, the four
paths that return without touching the PTY all renounce: `submitted: "no"`, the
detail in `reason`, and — on the chain path, which is the only one that carries
the field — `partial: false`.

- `wait:"idle"` expiring on a `command`, and on a `chain`'s initial wait
  (`error: "not sent"`).  This is the path that fires most often: a session
  reports itself busy for as long as a delegated agent runs, so `idle` is
  regularly unsatisfiable; the old `chain timeout` there froze compaction on a
  payload that never left.
- the session exiting during either of those waits (`error` stays the free-text
  `session exited during wait`, since the reserved values do not cover it).

Symmetrically, a chain that wrote step 0 and then stalled — on a turn that never
ends, or on a later step held back by politeness — reports `chain timeout` with
`partial: true`, never `not sent`.  Both directions are covered by the
`renouncing:` tests in `test/trigger-watcher.test.js`.

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
{ "ok": true,  "submitted": "confirmed", "sessionId": "...", "command": "...", "sent_at": "...", "waited_ms": 320 }
{ "ok": false, "submitted": "no", "error": "not sent", "reason": "timeout waiting for idle; nothing was written", "sessionId": "..." }
```

Trigger file is **deleted** after processing (success or failure).

### Removing the entry

`writeResult()` is the single place a trigger's fate is decided: it writes the
result atomically (`.tmp` + rename) and then unlinks the trigger. Every `return`
in `processTriggerFile()` that produces a result goes through it. The body of
`processTriggerFile()` (everything past the `*.json` filename check) also runs
inside one `try`/`catch`: any exception raised anywhere in it — shape
validation, session lookup, the PTY write, a step in a `chain` — is caught and
turned into `writeResult({ ok: false, error: 'internal error: ' + err.message,
internal: true })` before the function returns. `internal: true` is set on
this path only, so a caller can tell "our code broke" apart from a validation
refusal without parsing `error` text (see `docs/automation.md`, "Reading a
result"). Between the two, there is no "processed but left behind" path — the
trigger directory lists exactly what is still pending.
Two review findings on the previous version of this file (a `null` trigger
body, and a `chain` step that is not an object) both threw *before* any
`writeResult()` call was reached; the wrapping `try`/`catch` is what closes
that gap, rather than validating every field defensively before use.

That outer `try`/`catch`, however, only catches a throw from the *synchronous*
call into `processTriggerFile()`'s body. `waitForComposerFree`,
`pollForBusyRise`, `waitForBusyFall` and `waitForIdle` all poll on a
recursive `setTimeout` — every tick after the first runs from inside a timer
callback, a stack frame the outer `try`/`catch` never sees. All four share one
`pollLoop(check)` helper whose `tick()` wraps every call to `check` (first and
all later ones) in its own `try`/`catch` and routes a throw to that promise's
`reject` — which the `await` sites inside `processTriggerFile()` then hand to
the outer `try`/`catch` like any other exception. Before this, a throw from
one of these ctx hooks on the second tick or later had nothing to catch it:
not the original `Promise` executor (already returned), not
`processTriggerFile()`'s `try`/`catch`, not `dispatch()`'s `.catch()` — it
surfaced as an `uncaughtException` on the whole process. See
`pollLoop` in `trigger-watcher.js`.

`writeResult()` itself is written to never throw, full stop — including when
`ctx.log.error` (supplied by the caller, out of this module's control) itself
throws. Both of its `try`/`catch` blocks route their own logging through
`safeLogError()`, which swallows whatever the logger throws, and the unlink
branch calls `onEntryRetained()` *before* attempting to log — a guarantee this
module makes must not depend on whether the log call that merely describes it
succeeds.

Two consequences worth knowing:

- **`ENOENT` on the unlink is not a failure.** Two `rename` events for the same
  file can both reach processing; the loser finds the file already gone. That is
  the intended end state, so it stays silent. The same holds for the initial
  `lstat`: `ENOENT` there means the file vanished before it could be inspected,
  and returns without writing a result — there is nothing to report.
- **Any other unlink error marks the name `retained`.** This is the only path
  that still adds to `retained` in the running process. The entry could not be
  removed, so a later filesystem event on that name would re-run a command that
  already ran. `retained` (a `Set` in `start()`) makes the watcher ignore the
  name for the process's lifetime, and the failure is logged at error level
  rather than swallowed. This trades "processed at least once" for "never
  processed twice", which is the direction the transport must fail in: the
  result file is already written, so nothing is lost by refusing to look at the
  leftover again. The `Set` only ever holds names whose removal failed, so it
  does not grow in normal operation.

A non-`ENOENT` `lstat` error no longer returns silently either: it goes through
`writeResult()` like everything else, with `error: 'trigger could not be
inspected: ' + err.message`. It does not call into `retained` directly — if the
unlink that follows inside `writeResult()` also fails, that is caught by the
one `retained` path described above, same as for any other trigger.

`dispatch()` still wraps the call to `processTriggerFile()` in a `.catch()`
that logs and marks the name `retained`. With the internal `try`/`catch` now
covering the whole function body, this outer `.catch()` should never fire in
practice — a broken `ctx.log` alone can no longer reach it, since every log
call between it and `processTriggerFile()`'s own generic catch is now
`safeLogError()`-guarded too. It stays as a last-resort backstop for the one
thing genuinely outside this module's control: `retained.add(filename)`
(a plain `Set`) itself throwing. `retained.add(filename)` runs *before* the
logging in this `.catch()`, same ordering rule as everywhere else.

Only two `ctx.log.error()` calls sit downstream of every other one in this
file, and both are `safeLogError()`-guarded: the generic catch's own log line
above, and `dispatch()`'s `.catch()` here. Every other `ctx.log.warn` /
`.info` / `.error()` call inside `processTriggerFile()`'s body is deliberately
*not* wrapped individually — each one precedes a `return` through
`writeResult()` inside the same outer `try`, so a throw from any of them is
already caught by the generic catch above, and (if that catch's own guarded
log and `writeResult()` retry somehow both fail) by `dispatch()`'s catch in
turn. Wrapping every site individually would duplicate that protection
without closing any gap the two backstops don't already close. The four
`ctx.log.*` calls in `start()` itself (directory creation, watcher startup,
the `fs.watch` `error` event) are a different case: they describe the
watcher's own lifecycle, not any one trigger's fate, and are out of scope for
this guarantee.

**Known gap, deliberately not fixed**: if writing the result file fails, the
trigger is deleted anyway. The two invariants ("always a result", "never twice")
cannot both hold there, and "never twice" wins.

`processed/` **has no retention policy** — result files accumulate without bound
and nothing prunes them.

## Invariants

- **Never throws out of the watcher callback** — `processTriggerFile()`'s body runs inside one `try`/`catch`; any exception, anticipated or not, lands in the result file via `writeResult()` before the function returns. `dispatch()`'s own `.catch()` is a backstop for the case that should no longer occur.
- **Poll loops must reject, not throw** — `waitForComposerFree`, `pollForBusyRise`, `waitForBusyFall` and `waitForIdle` all share `pollLoop()`, which converts a throw from *any* tick (including the ones run from inside `setTimeout`, not just the first synchronous one) into that promise's rejection. Without this, a throw on a deferred tick has no `try`/`catch` above it — see "Removing the entry".
- **`writeResult()` never throws** — both of its internal `try`/`catch` blocks route their own logging through `safeLogError()`, which cannot itself throw, and the unlink branch records `onEntryRetained()` before logging. A broken `ctx.log` cannot skip either guarantee.
- **A broken `ctx.log` cannot crash the process from either backstop** — the generic catch's own log line and `dispatch()`'s own `.catch()` log line are both `safeLogError()`-guarded. An unguarded log call throwing there would otherwise become an `unhandledRejection`, which terminates the process by default under Node — see "Removing the entry".
- **Deduplication via `inFlight` Set** — noisy `rename` events for the same file (common on Linux inotify) are coalesced; a file is processed at most once per appearance.
- **A processed trigger never runs twice** — normally because it was deleted; when the deletion fails, because its name is in `retained`. A trigger that threw internally is not exempt from this: it still gets a result and a deletion, so it is not "retained" on that account.
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

- If you rename `_cliBusy` on `session` in `main.js`, update `isSessionBusy` in `trigger-context.js`.
- If you rename `session.composerState` or stop feeding it from `terminal-input.js`, `getComposerState` returns `null` and **every trigger renounces with `not sent`** — the safe direction, but the channel goes silent.  Tests for the model live in `test/composer-state.test.js`; the handler and the ctx are exercised in `test/terminal-input-handler.test.js` and `test/trigger-context.test.js`, and `test/main-wiring-source-check.test.js` reads `main.js` as text to check the remaining glue is still written down (source only — it proves nothing at runtime).
- If you rename `activeSessions` or change the structure (`session.pty` → `session.ptyProcess`), update `getPtyForSession` and `isSessionBusy` in `trigger-context.js`, and `handleTerminalInput` in `terminal-input.js`.
- Tests live in `test/trigger-watcher.test.js`.  They use `SWITCHBOARD_TRIGGERS_DIR` env override — do not hardcode paths there.
