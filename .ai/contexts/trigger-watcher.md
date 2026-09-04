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

**Found it — CPR, fixed 2026-09-04.** A 340 s trace of two idle sessions
(`SWITCHBOARD_ACTIVITY_TRACE`, real machine, nobody at the keyboard) put a
number on the suspects above:

| Shape | Count | out of 2,422 `pty.input` chunks |
|---|---|---|
| CPR / DECXCPR (`CSI [?] row ; col [; page] R`) | 1,427 | 59% |
| SGR mouse (`CSI < b ; x ; y M`/`m`) | 495 | 20% — already excluded, working |
| plain text, no control byte (real typing) | 473 | 20% — real keystrokes, correctly counted |
| DEL / CR | 27 | 1% — real keystrokes |
| OSC, DCS | 0 | not observed on this machine, ever |

CPR alone, arriving roughly every 240 ms, kept `lastInputAt` reassigned
continuously: the 3000 ms quiet window (`DEFAULT_QUIET_MS`) could not open
between two sessions still on screen, whatever the pointer or the CLI's own
busy state were doing. The 2026-09-02 fix above was correct but aimed at 20%
of the traffic; the dominant 59% was untouched, which is why the symptom
outlived it.

`composer-state.js`'s `reportLength()` now recognises CPR/DECXCPR the same
way it recognises SGR mouse and focus reports: a dedicated regex bounding
every numeric field (`CPR_PARAMS_RE`), not a bare check on the final byte.
`applyCsi` has no case for final `R` — falls through its default — so before
this fix a CPR chunk pushed the clock but never touched `text`/`cursor`/
`pending`; the defect was confined to the quiet window, not to composer
content. Verified by reading the switch, not by a runtime test: once
`reportLength` claims `R`, `applyCsi` never sees it, so nothing post-fix can
exercise that unreachable case (see `test/composer-state.test.js`).

The end-to-end proof — a CPR flood no longer blocking `waitForComposerFree`'s
free condition — lives in `test/composer-state-quiet-window.test.js`, which
reimplements the one-line predicate against fake time rather than importing
`waitForComposerFree`: that function is not exported, and PR #168 edits it
directly, so adding an export here would create an avoidable conflict for a
one-line predicate that composer-state.js's own clock behaviour already
proves.

**DSR, DA1/DA2, DECRPM, window-ops (`t`) — not added, zero occurrences
measured.** The brief that produced this fix asked for all of these as a
matter of course; the trace has none of them, on either the 103 s or the
340 s window, so they are deliberately left out rather than excluded on
reasoning alone — the same conservatism the SGR-params regex already applies
to mouse reports. DECRPM (`CSI ? Pd $ y`) additionally can't be told apart
from a bare final `y` with the current `matchEscape`: the intermediate `$`
byte is consumed but not returned in the match, so distinguishing it would
mean changing `matchEscape`'s return shape, not just adding a param regex —
out of scope for a fix this size. If a future CLI release starts querying any
of these (plausible — Claude Code already probes DECRPM-style modes for
things like synchronized-output support), re-run the trace and treat it the
same way CPR was: measure first, then add the exact shape, never the final
byte alone.

**OSC and DCS replies — parsed differently, and both unmeasured.** OSC
replies (colour query, `10`/`11`) are matched whole by `matchEscape` (kind
`osc`) and, since nothing in `noteUserInput` applies to that kind, push
`lastInputAt` without touching `text`/`pending` — a defect of the same shape
as CPR's, just with zero observed occurrences here. DCS is worse and
structural, not a report-recognition gap: `matchEscape` has no DCS
introducer case, so `ESC P` falls into the generic 2-byte `esc` catch-all,
and everything up to the terminator (`ESC \` or the DECRQSS/XTGETTCAP
payload) is then walked byte-by-byte as literal text — a DCS reply, if one
ever arrived, would be typed into the composer. Not fixed here: zero measured
occurrences, and the fix is a `matchEscape` change (recognising and
discarding a whole DCS sequence), not a `reportLength` addition — a
different, larger piece of work than this PR's scope.

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

- If you rename `_cliBusy` on `session` in `main.js`, update `isSessionBusy` in `trigger-context.js`.
- If you rename `session.composerState` or stop feeding it from `terminal-input.js`, `getComposerState` returns `null` and **every trigger renounces with `not sent`** — the safe direction, but the channel goes silent.  Tests for the model live in `test/composer-state.test.js`; the handler and the ctx are exercised in `test/terminal-input-handler.test.js` and `test/trigger-context.test.js`, and `test/main-wiring-source-check.test.js` reads `main.js` as text to check the remaining glue is still written down (source only — it proves nothing at runtime).
- If you rename `activeSessions` or change the structure (`session.pty` → `session.ptyProcess`), update `getPtyForSession` and `isSessionBusy` in `trigger-context.js`, and `handleTerminalInput` in `terminal-input.js`.
- Tests live in `test/trigger-watcher.test.js`.  They use `SWITCHBOARD_TRIGGERS_DIR` env override — do not hardcode paths there.
