# Context: trigger-watcher

**Purpose**: lets external harness scripts inject keyboard input into open PTY sessions without any Electron IPC.  The primary use case is the token-usage harness calling `/compact` on a session when it detects a high context-window fill.

## Key files

| File | LOC | Role |
|---|---|---|
| `trigger-watcher.js` | ~1050 | The entire module: directory setup, `fs.watch` listener, idle-wait logic, single + chained trigger processing, submit-with-verify busy-rise/fall polling, input validation, PTY write, result file. |
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

### Startup scan

**The defect this closes**: `start()` used to do nothing but install
`fs.watch`. A trigger file already sitting in the directory when `start()`
runs — written while the app was closed, or between one launch and the next —
never produces a `rename` event (there was nothing watching yet), so it was
never processed: not on that launch, not on any later one either, since
nothing ever revisits the directory's existing contents. Measured incident: a
trigger written at 00:44, the app restarted for an update at 00:45:28 — no
`.result.json` was ever produced, and the file stayed on disk, inert. The
attempt and the loss look identical on disk (both are "a `.json` file sitting
in the triggers directory"), which is what made this hard to diagnose from the
outside: nothing distinguishes "still waiting" from "will never run."

**The fix**: `start()` now also does one `fs.readdirSync(triggersDir)` and
feeds every `*.json` name it finds through `handleFile()` — the exact same
function the live `fs.watch` callback calls for a `rename` event. Scan-origin
and watch-origin names are indistinguishable once inside `handleFile()`: same
dedup (`inFlight`/`retained`), same `MAX_INFLIGHT` backpressure (`waitQueue`),
same eventual call into `dispatch()` → `processTriggerFile()`. This is
deliberate — a second, parallel dispatch path for "the ones the scan found"
would double the surface for the two invariants "always a result" / "never
processed twice" (see "Removing the entry" below) to disagree with each other.

**Ordering: watcher installed BEFORE the scan runs.** The alternative order
(scan first, install the watcher after) leaves a window — however
narrow — where a trigger written between the scan's `readdirSync` and the
watcher's installation is seen by neither: exactly the bug this section fixes,
just narrowed rather than closed. Installing the watcher first, then scanning,
means the only way to miss a file is for it to be written and fully
disappear again before the scan's `readdirSync` call — not a real case for a
trigger transport, since nothing but this module's own processing ever
deletes a trigger file. `fs.watch` registration and the scan's `readdirSync`
both run synchronously with no `await` between them, so there is no event-loop
turn in which a file created in that gap could be missed by both: any
`fs.watch` callback for a file that arrives in the gap cannot fire until the
current synchronous call stack (which includes the scan) returns control to
the event loop.

**The staleness guard.** A trigger older than `SWITCHBOARD_TRIGGER_MAX_AGE_MS`
(default 300 000 ms / 5 minutes) is refused rather than run — JB's framing:
a `/compact` written six hours ago no longer targets the same session state,
and running it anyway does more damage than dropping it. "Age" is the
trigger file's own `mtimeMs` versus `Date.now()` at the moment
`processTriggerFile` inspects it (the existing `lstatSync` call from the C1/C2
size and symlink guards — the age check reads `stat.mtimeMs` off that same
`stat`, no extra syscall). The check lives inside `processTriggerFile` itself,
not in the scan, so it applies uniformly regardless of whether a name arrived
via the scan or a live `rename` event — a file that ages out while queued
behind `MAX_INFLIGHT` gets the same treatment as one that was already stale
when the scan found it.

Default of 5 minutes: the only two "legitimate wait" durations ever measured
on this transport are 66 s and 102 s (chain step 0, five real `/compact`
incidents — see "An unmeasured hypothesis" above for the full five-value set).
300 000 ms clears the larger of those by roughly 3x, so a trigger that is
merely slow through no fault of its own is never misread as stale, while
staying far short of "hours" — the case JB's own example already treats as
unambiguous. It also reuses `DEFAULT_IDLE_TIMEOUT`'s existing number and
rationale ("the practical upper bound for a genuine wait", see its comment
above) instead of inventing a second, unrelated constant. Configurable via
`SWITCHBOARD_TRIGGER_MAX_AGE_MS`, read live per file (`getTriggerMaxAgeMs()`,
mirrors `getIdleTimeout()`) — not cached at module load, the exact trap this
file's own test suite documents at its top (`SWITCHBOARD_SUBMIT_ENTER_DELAY_MS`
forced to `1` for the whole run) for module-load-time env reads.

A refused-for-staleness trigger is written up like any other refusal:
`{ok: false, submitted: "no", error: "not sent", reason: "..."}`, through the
regular `writeResult()` path — result file in `processed/`, trigger deleted
from the root. It is never left on disk: doing so would trade one silent loss
(never processed) for another (processed-looking result never written, file
still there). `error: "not sent"` specifically, not a new value: item 3 of the
brief that produced this fix flags a real downstream constraint — the harness
(`harness/cmd/harness/compact.go`) buckets anything other than exactly
`"confirmed"` as pessimistic already, but distinguishes within that bucket by
retrying on `"not sent"` while stalling on `"chain timeout"`. A stale refusal
sent nothing to any PTY, so `"not sent"` is the semantically correct value —
and the one that lets the harness re-evaluate the (probably-gone) session
cleanly instead of treating the refusal as a hung chain.

**Never descends into `processed/`.** `readdirSync(triggersDir)` only
returns direct children; it does not recurse. The existing `.json`-suffix
filter in `handleFile()` additionally excludes the `processed` directory
entry itself (a directory name has no `.json` suffix), so no separate
exclusion was needed for the one sub-directory this module creates.

Tests: `test/trigger-watcher.test.js`, the "Startup scan" section — a
pre-existing trigger being picked up, the age guard's refusal shape, the age
threshold being re-read live across two triggers processed by the same
running watcher (not fixed at the point `trigger-watcher.js` was first
required), scan/watcher dedup (a name torn down and recreated — a plain
overwrite reports as a `change` event on this platform and would prove
nothing — while the scan's own dispatch is still in-flight), `processed/`
never being scanned, and `MAX_INFLIGHT` being respected for scan-origin names
(exactly 8 of 12 pre-existing triggers start immediately; releasing 3 lets 3
queued ones take their place).

### Session serialization

`MAX_INFLIGHT` bounds how many trigger *files* run concurrently; it is silent
on which `sessionId` they target — nothing before this fix stopped two
trigger files naming the same session from running their `waitForComposerFree`
/ `submitWithVerify` sequences interleaved, each unaware of the other's
in-flight write. Two commands landing in one composer half-typed into each
other is a worse failure than anything `submitted` reports: corrupted input,
not just a wrong report field.

`start()` keeps `sessionLocks`, a `Map<sessionId, Promise>` used as a FIFO
mutex queue (`acquireSessionLock`). `processTriggerFile` awaits it right after
`sessionId` is known to be a non-empty string — before any wait, any PTY
lookup, any write — and releases it in the function's own `finally`, so every
exit path (success, validation refusal, thrown exception) releases exactly
once. A second trigger for the same session blocks on `await
acquireSessionLock(...)` until the first's entire `processTriggerFile` run —
including its own idle-wait, politeness wait, and submit-verify — has
produced a result. Two triggers naming *different* sessions each get their own
map entry and never wait on each other, still bounded only by `MAX_INFLIGHT`.

This does not create a new way to hang: whichever trigger holds the lock is
still bounded by its own `timeout_ms` / idle-wait deadline exactly as before,
so the queued trigger's worst case is "the first trigger's own bound, then
mine" — not unbounded. See `test/trigger-watcher.test.js`, the "session
serialization" tests, for same-session ordering and cross-session
independence, both proved by write-order assertions rather than by inspecting
the lock directly.

**Interaction with the target guard.** The lock is acquired before the target
guard ever runs (both sit inside the same outer `try`), so a guard refusal —
single command or a chain refused at step 0 — is itself a lock holder for the
brief moment it takes to write its result and `return`. That `return` runs the
same `finally` as every other exit path, so the lock is released exactly like
a success would release it; the only visible cost is a rejected trigger
briefly occupying the front of the queue. Proved by two tests under "Target
guard" that queue a legitimate trigger for the same session right behind a
refused one and require it to still produce a result — and by mutating the
release call itself to confirm those tests go red when it stops firing.

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

**Corrected — the pointer was never the axis to vary.** The paragraph above
already rules it out on its own terms: Claude Code never turns on motion
tracking and xterm.js de-duplicates identical motion, so a resting pointer
cannot put anything on `pty.input` to begin with. A grid that varies pointer
position measures nothing the CLI's own querying doesn't already explain — the
2026-09-02 measurement that seemed to implicate the pointer (§ above, PR #160)
most likely compared two runs where the CLI's own background querying happened
to differ, not two pointer positions; that confound is exactly why n=1 per
condition couldn't tell the two apart.

**What actually resolved it: arm the trace on a session with nobody at the
keyboard.** The absence of a human, not the pointer, is the control — everything
`pty.input` records in that window is machine-originated by construction. A
340 s trace of two idle sessions this way (2026-09-04) put a number on the
suspects this section used to call unproven: of 2,422 chunks, 1,427 (59%) were
CPR / DECXCPR (`CSI [?] row;col[;page] R`) — the terminal answering a
cursor-position query the CLI issues on its own roughly every 240 ms — against
495 (20%) SGR mouse reports, which PR #160 already excluded correctly and which
were not the cause. `reportLength()` did not recognise CPR, so every one of
those chunks kept resetting the quiet clock, and any session left open on
screen could keep the 3000 ms window from ever opening. See PR #170 (open at
the time of writing) for the fix and the full breakdown.

One reading pitfall worth flagging for whoever re-runs this: `pty.input`'s `cp`
field is capped at 10 code points (see `docs/activity-trace.md`), so a longer
escape sequence can show up in the trace without its final byte. Classify a
shape from the full chunk or its length, not from a truncated `cp` alone.

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

**"The same way" is an analogy, not the safety argument — the two exemptions
rest on different properties.** What makes `SGR_MOUSE_PARAMS_RE` safe is that
its final bytes (`M`/`m`) only reach `reportLength` on a chunk starting with
`CSI <`, and no keyboard on this machine's key-event handler
(`public/terminal-manager.js`, `attachCustomKeyEventHandler`) or xterm.js's own
`onData` emits `<` as the third byte of a CSI sequence — the prefix is
terminal-report-only by construction, so bounding the numeric fields is
enough. Final `R` has no such prefix to lean on: xterm.js emits bare
`CSI n ; m R` for a *modified F3 keypress* (`xterm.js`, `case 114`:
`ESC+"[1;"+(mod+1)+"R"`, `1;2` through `1;8` for Shift/Alt/Ctrl combinations).
An earlier version of `CPR_PARAMS_RE` made the `?` optional (`\??`), so it
matched that shape too — a real keystroke silently exempted from the quiet
clock, the direction this whole guard exists to prevent, and strictly worse
than the CPR flood it was fixing. Caught before merge by checking a keyboard
source (xterm.js) rather than reasoning by analogy from the mouse case.

The actual safety argument for `CPR_PARAMS_RE`, mandatory `?` included: DECXCPR
(`CSI ? row ; col [; page] R`) is what this terminal answers with, and it is
the *only* shape observed — 24,795 CPR chunks in the 2026-09-04 trace, `?`
present in all 24,795, present in zero of the responses this codebase has ever
seen without it. Requiring the `?` excludes exactly the modified-F3 shape
above and nothing measured. **Residual**: this is a measurement on one
CLI/terminal pairing, not a proof that no terminal ever answers CPR without
`?` (plain DSR-6, `CSI row ; col R`, is a legal *bare* CPR in the DEC standard
— just not one this xterm.js/ConPTY combination has been observed to send).
If a future terminal or `xterm.js` config starts answering bare CPR, this
regex will — correctly, per the "doubt resolves to busy" principle — count
that as a keystroke rather than false-exempt it; the failure mode of being
wrong here is a spurious wait, not a swallowed keypress.

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

**`submitted`.** Every result carries it, compared by strict equality, in this
total order — `SUBMITTED_RANK` in `trigger-watcher.js`, exported for any
caller that needs to fold or compare values itself rather than duplicate the
ranking:

| Rank | Value | `SUBMITTED_RANK` |
|---|---|---|
| weakest | `no` | 0 |
| | `assumed` | 1 |
| | `activity` | 2 |
| strongest | `confirmed` | 3 |

- `no` — nothing was written, or it was written and never submitted.
- `assumed` — written, no failure seen, nothing observed afterward.
- `activity` — the session was seen busy after our write, but the readback
  below could not rule out interference, or the session was already mid-turn
  the instant we wrote.
- `confirmed` — the composer was read back empty right after our own Enter,
  the session was **not** already busy when we wrote, and a turn was
  independently observed in the same verify window. All three, checked on the
  first attempt only — a retry never yields `confirmed`.

`weakestSubmitted(a, b)` returns whichever of `a`/`b` has the lower
`SUBMITTED_RANK` (`<=`, so it is stable when both sides tie). Anyone adding a
fifth value must give it a rank in this same table before touching the
constant — every fold in this file (`chainSubmitted`, the per-step
classification below) goes through `SUBMITTED_RANK`, not through hand-written
`if`/`else` on the string values, specifically so this table is the one place
that has to change.

A chain reports the **weakest** of its steps (`weakestSubmitted`), because the
field exists to stop a transport overstating what it saw. This is the
top-level field's whole job, unchanged by the per-step field below: it existed
first, a production consumer (the harness) already reads it, and nothing here
alters what it means or how it is computed — only what else is now available
alongside it.

### Per-step `submitted` (2026-09-05)

Every entry in a chain result's `steps[]` now carries its own `submitted`,
classified by `classifySubmitted(composerConfirmed, sawBusy)` — the same
function `chainSubmitted`'s fold uses, so a step's own field and its
contribution to the chain-level fold can never read the classification
differently. **The motivating gap**: a chain whose last step is the one that
matters (a `/compact` → resume chain, where the resume prompt is the payload
a caller actually needs delivered) reports only the chain's weakest value at
the top level. A caller asking "was the *last* step confirmed?" could not
previously distinguish "the last step was weak" from "an earlier step was
weak and the last one was fine" — both fold to the same top-level value. See
`test/trigger-watcher.test.js`, "chain per-step submitted: a confirmed step
and a non-confirmed step in the same chain each keep their own value", for
the case this closes: step 0 genuinely `confirmed`, step 1 only `assumed`,
top level (correctly, unchanged) `assumed` — invisible at the top level, and
now explicit in `steps[1].submitted`.

**A step refused before it ever reached `submitToPty`** — today, that means a
composer that never frees within the step's own deadline — still gets a
`steps[]` entry, with `submitted: "no"` and `submit_retries: 0`: nothing was
written, so no other value would be honest. This is a **narrowing**, not a new
category: before this, such a step had no `steps[]` entry at all (see
`docs/automation.md`, "`waited_ms` / `total_waited_ms`" for the exception list
this moves one item out of). Two related refusal shapes inside the same loop
— the session having exited, and the global deadline firing — are deliberately
**not** given a `steps[]` entry: both are checked before `stepSentAt` is even
assigned for that step (`trigger-watcher.js`, top of the chain loop body), so
there is no per-step wait or per-step anything yet to attribute; adding an
entry there would mean inventing a `sent_at`/`waited_ms` for a step the code
never actually started working on, which is a different, larger claim than
"this step was refused a write." Not extended to the single-`command` path's
own analogous refusals (target guard, composer never free, session not found)
either — that path has no `steps[]` to begin with; its own `submitted: "no"`
at the top level already says exactly this.

### Why the top value used to be `activity`, and no longer is

Between the incident below and this section, `confirmed` was emitted whenever
busy was observed after a write (see history), then removed entirely once that
was shown to lie (`pollForBusyObserved` is a level probe: a session already
mid-turn when the trigger fires satisfies it in milliseconds, with a turn the
write did not cause — see `test/trigger-watcher.test.js`, "a session already
busy before our write never reports confirmed"). Removing it outright broke a
downstream contract: `harness/cmd/harness/compact.go`'s guard releases on
`DeliveryConfirmed` in seconds and otherwise falls back to a 2-hour ceiling, so
with `confirmed` gone every chain fell back to that ceiling. `confirmed` is
therefore back, on a stricter footing.

### What `confirmed` checks, and why composer-emptiness alone is not enough

`submitWithVerify` (`trigger-watcher.js`) reads the composer back
unconditionally after every write — never skipped because activity was seen,
which is exactly the inversion this module used to make. But an empty reading
by itself proves less than it looks like it does: `composer-state.js` is fed
**only** from bytes the renderer sends (see "Politeness" above) — this
module's own writes go straight to the PTY and are invisible to that model. So
"the composer reads empty after our write" only rules out a *human's*
unsubmitted sentence being visible at that instant; it says nothing about
whether the CLI actually consumed what we ourselves just wrote, since the
model never knew that text existed in the first place. Proven by
`test/trigger-watcher.test.js`, the "chain confirmed fold" pair: a step whose
composer is genuinely undisturbed reads exactly the same as a step nobody
observes at all — the reading is vacuous unless something independent anchors
it.

`confirmed` therefore requires **two more things**, both cheap to state and
each closing a concrete gap:

1. **The session must not already have been busy when we wrote.** A session
   mid-turn can swallow or queue injected text with the composer model none
   the wiser — it never saw the text land, so it cannot show it stuck. This is
   the exact shape of the field incident: a chain step written 9.2 s into a
   still-running prior turn read back "confirmed" and the CLI never actually
   submitted it; a human had to press Enter four minutes later. Sampling
   `ctx.isSessionBusy` **before** the write and disqualifying `confirmed`
   outright when it is `true` closes this — not by claiming proof, but by
   refusing to claim one where none exists. (This is a *gate*, not the
   discredited pattern above: it can only prevent a false `confirmed`, never
   produce one.) It closes the incident's own shape — a write landing mid-turn
   — not the broader causality gap; see "What `confirmed` still does not
   claim" below for what is left open.
2. **A turn must still be independently observed** (the existing busy-rise
   poll). Composer-emptiness on its own cannot distinguish "genuinely
   unwritten" from "written, but nothing downstream ever reacts to it" — a
   turn starting is what anchors the reading to something the CLI actually
   did. See `test/trigger-watcher.test.js`, "chain 'confirmed' fold: one
   step composer readback is inconclusive" for the case where a fully-observed
   chain step still cannot reach `confirmed` because the composer reading
   was not clean.
3. **Busy must not have been observed anywhere between the text write and the
   Enter write either** (`midBusy`, `delayWithBusyPoll`/`submitToPty`/
   `submitWithVerify`, added 2026-09-04, corrected same day). Gate 1 samples
   once, before `submitToPty` is even called; there is a second gap it does
   not cover — between the text landing and the discrete Enter that follows
   it `DEFAULT_SUBMIT_ENTER_DELAY_MS` (50ms production default) later. Busy
   observed anywhere in that gap cannot be caused by an Enter that has not
   been written yet.

   **First version of this gate sampled once, at the start of that gap** (t=0,
   right after the text write) instead of across it — found the same day, by
   review, to miss a busy that rises and falls entirely inside the window: 25ms
   after the text, 25ms before the Enter, satisfies the exact causal violation
   this gate exists to catch and still read `confirmed`. Invisible to every
   test in the suite for a structural reason, not bad luck: `SWITCHBOARD_SUBMIT_
   ENTER_DELAY_MS` is forced to 1ms at the top of `test/trigger-watcher.test.js`
   for speed, so the window this gate polls is ~1ms wide in every test that
   predates the fix — no room for "start" and "middle" to differ. Fixed by
   polling continuously (`delayWithBusyPoll`, `MID_BUSY_POLL_INTERVAL_MS` =
   5ms) for the whole delay rather than sampling once, true if busy was seen at
   ANY point in the window — chosen over sampling once at the *end* of the
   delay instead, because a busy that rises and falls before the Enter is
   still a real, causally-disqualifying case, and sampling only the end would
   miss exactly that one. Cost: negligible — the total wait is still bounded to
   exactly the configured delay, polling only changes what happens during it,
   not how long it lasts. Proven in `test/trigger-watcher.test.js`, "submitted:
   busy asserted mid-window (not at the text write itself) between text and
   Enter must still gate confirmed" — deliberately run at a realistic delay
   (50ms, overridden per-test), not the suite's 1ms default, since 1ms cannot
   exhibit the gap either version of this gate closes or misses.

   Same shape as gate 1 either way: a gate, not a proof: it can only withhold a
   `confirmed` it cannot back up, never manufacture one. **This gate is not
   shown to be the mechanism behind any real incident** — it is a distinct,
   mutation-proven gap, constructed independently of the settle-window finding
   below, and kept because it closes a real hole, not because it explains the
   field data. **Scope: both the single-`command` path and the chain path**,
   not chain-only — `submitToPty`/`submitWithVerify` are the same function
   called from both (`trigger-watcher.js:869` and `:1024`); a bare, non-chain
   trigger runs the identical race. Proven in `test/trigger-watcher.test.js`,
   "submitted: busy observed between a step's text write and its own Enter
   must not confirm it, on a bare command (no chain)". This is unlike the
   settle-window gate below, which is chain-only by construction
   (single-command triggers never call `waitForBusyFall`).

**`waitForBusyFall`'s settle window** (`SWITCHBOARD_BUSY_FALL_SETTLE_MS`,
300 ms default, added 2026-09-04) closes a related but distinct gap, one step
earlier in a chain, and **is the one tied to real incidents by measurement**.
Before this, a single `busy=false` sample was enough for `waitForBusyFall` to
declare the previous step's turn over and write the next step. A command's own
tail activity — `/compact` still rendering its summary after the turn
nominally ends — can produce a brief `busy` `false`-then-`true` flicker;
exiting on the first `false` let the next step get written inside that
flicker, and the re-assertion of `busy` then landed inside *that* step's own
verify window, read as its own confirmation.

A competing hypothesis was raised alongside this one: that `isSessionBusy`
never reads true during compaction at all, and the write goes through because
the (unrelated) composer-emptiness check sees a box that looks the same
whether idle or compacting. Measurement rules this out: across the 5 real
`/compact`→resume results on disk that carry this shape
(`triggers/processed/{a9a051cd,9151d9f2,45666e69,88f23bd1,b82f5f80}*.result.json`),
every one of them shows `submit_retries: 0` on the resume step. Had busy never
been observed at all in that step's own verify window, `submitWithVerify`
would have taken the retry branch (`submit_retries: 1`) — see `pollForBusyObserved`'s
"nothing observed" path above. It did not, on any of the five: busy was seen,
with a `waited_ms` of 0 (4 of 5, busy already true at the first poll tick) or 109 ms
(1 of 5, `b82f5f80`, caught one poll tick later) after that step's own Enter.
Busy is not absent during compaction; it reasserts fast enough after the
previous step's fall that every measured occurrence lands inside a single
`IDLE_POLL_INTERVAL` (100 ms) of the next step's own write — well inside the
300 ms settle window. Requiring `busy` to read `false` continuously for that
window before `waitForBusyFall` resolves closes every measured occurrence.
Cost: every non-final chain step now waits at least the settle window before
the next step is written, including the previously-instant "busy never rose"
case — single-command triggers never call `waitForBusyFall` and are
unaffected. Proven in `test/trigger-watcher.test.js`, `chain "confirmed" false
positive: a busy blip right after step 0's turn must not be attributed to step 1`.
Its own invariant — idle must be *continuous* for the settle window, not just
"some false sample happened a while ago, regardless of what busy did since" —
is a separate line (`idleSince = null` on every re-assertion) with its own
test, `waitForBusyFall settle window: busy that keeps reasserting must never
let a step be written mid-activity`; deleting that one line leaves 98/98 other
tests green, so it needed a schedule built specifically to exercise it
(continuous 200ms-on/200ms-off oscillation, never a 300ms-continuous idle
window).

**A second cost, not just latency: the settle window can turn an existing
success into a `chain timeout`.** `waitForBusyFall`'s deadline check runs
before its settle check (trigger-watcher.js:417-419), so a settle window that
starts but has not finished continuously when a step's own `timeout_ms`
arrives resolves as `timedOut`, never as the success it would have been
pre-settle-window. A turn ending with less than `settleMs` (300ms default) of
margin before its own deadline now fails where it used to succeed. Chosen
trade-off: **document this, do not make the settle window additive to the
deadline.** The one real caller measured — the harness's auto-compaction guard
— chains steps in the hundreds of *seconds*; a few hundred ms of margin is not
its regime, and making the window additive would silently change what
`timeout_ms` means for every caller, including ones already calibrated against
the old, single-sample behavior. Revisit if a caller with a genuinely tight
per-step margin turns up. Proven in `test/trigger-watcher.test.js`,
`waitForBusyFall settle window: a turn finishing with too little margin before
its own deadline now times out (documented trade-off, not a bug)`.

**Scope, corrected**: the settle window applies to `waitForBusyFall` alone,
reached only from the chain path's non-final-step branch — single-`command`
triggers are unaffected. This does **not** hold for the `midBusy` gate above
(point 3): `submitToPty`/`submitWithVerify` are shared by both the
single-command call site and the chain call site, so `midBusy` narrows
`confirmed` on both, not chain-only.

Not established at the byte level, and not to be read as more certain than it
is: that the busy reassertion in the real incidents specifically *is*
`/compact`'s own tail activity rather than some other cause with the same
timing signature. Debug/activity-trace was off for all five captures; nothing
recorded what the CLI actually wrote to the terminal in that window. The
`submit_retries: 0` argument above rules out "busy absent throughout", not
"busy present but for an entirely different, coincidentally-timed reason".

**Direct on-screen confirmation, from one of the field incidents**: the target
session's own composer held the unsubmitted resume text, visibly, for
35 minutes, until a human pressed Enter. This confirms the text *was* written
— `submitToPty` never fails silently to write — and settles nothing about
`isSessionBusy`'s behavior; it is independent evidence, not a replacement for
the `submit_retries: 0` argument above. It does retire a DIFFERENT, weaker
argument that was floated and should not be reused: "the resume text never
appears in the target's transcript, therefore it was never written." An
unsubmitted composer is invisible to a transcript by construction — "never
typed" and "typed, not submitted" produce the identical transcript (nothing),
so transcript absence cannot distinguish them and was never a valid basis for
either hypothesis.

### `waitForBusyFall` waits for the rise too (2026-09-05)

The settle window above (`SWITCHBOARD_BUSY_FALL_SETTLE_MS`) closed the gap
where a `false` sample right after a real fall could be a tail-activity
flicker rather than the genuine end of a turn. It did not close a distinct,
earlier gap: `waitForBusyFall` started with `idleSince = null` and no memory
of ever having seen `busy = true` at all. If `ctx.isSessionBusy()` was still
`false` at the moment `waitForBusyFall` began polling — because
`submitWithVerify`'s own busy-observe window (and its one Enter retry, up to
`2 x SWITCHBOARD_SUBMIT_VERIFY_MS` together) had already elapsed without the
CLI's busy flag flipping — a single settle window of continuous `false` was
enough to declare "the previous turn is over", when it had never started.
The next chain step then got written into a session that was mid-turn or
about to become one.

**Field incident**: a `/compact` chain step whose `compactMetadata` recorded
137s of real compaction work had its next chain step written ~260ms after
compaction started — nowhere near enough time for that work to have finished,
because it never had to: the busy flag simply hadn't flipped true yet when
`waitForBusyFall`'s settle window elapsed. A second, independently-observed
instance (0.0.64) showed the same shape from the other side: `/compact`'s own
step recorded `waited_ms: 91450` (a genuine 91s turn, correctly awaited), but
the very next step recorded `submit_retries: 1` and its Enter — including the
retry's own bare `\r` — was absorbed as a newline rather than a submit; a
human found the composer holding the text plus two newlines, unsubmitted,
~3h40 later. Both incidents are consistent with the same root cause:
`waitForBusyFall` treating "busy has not yet been observed for this turn" as
indistinguishable from "the turn already ended".

**Fix**: `waitForBusyFall` now tracks `hasRisen`, set the first time
`ctx.isSessionBusy()` reads `true` since the call began. The settle-based
fall detection (unchanged) only runs once `hasRisen` is true. Before that, a
new bound — `getBusyRiseWaitMs()`, `SWITCHBOARD_BUSY_RISE_WAIT_MS`, defaulting
to `getSubmitVerifyMs()` (itself `SWITCHBOARD_SUBMIT_VERIFY_MS` /
`BUSY_OBSERVE_TIMEOUT_MS`, 2000ms) — governs how long to wait for a rise
before giving up. A session already busy when `waitForBusyFall` is called
satisfies the rise on the very first tick, so that path (the overwhelming
majority of chain steps, whose auto-turn rises within tens of ms) is
unchanged.

**Why the bound reuses `getSubmitVerifyMs()` rather than a new number**:
`submitWithVerify` already spends up to two of these windows (initial attempt
+ one Enter retry) looking for the exact same signal — busy flipping true
after a write — before giving up and letting the chain proceed regardless.
Extending the same, already-calibrated tolerance by one more window-length,
once, before `waitForBusyFall` gives up in turn, is the smallest change
consistent with what the code already asserts about how long this signal can
legitimately take to appear. No field measurement pins down exactly how long
a `/compact`'s busy flag can lag its own start, so this is a reasoned choice,
not a measured one — kept independently configurable
(`SWITCHBOARD_BUSY_RISE_WAIT_MS`) for a caller that needs the two windows to
diverge, read live at call time like every other threshold in this file, not
captured at import.

**Not an error**: a rise that never arrives within the bound resolves exactly
as `waitForBusyFall` always has when a turn is never observed — success, "turn
never observed", not `timedOut` and not `chain timeout`. A step's command can
legitimately produce nothing this transport can see (see the existing
"instant-reply" path in `submitWithVerify`); the bound exists so a genuinely
silent step does not hang the chain until its own `timeout_ms`, not to turn
silence into a failure.

**Interaction with `deadlineMs`, unchanged**: the deadline check still runs
first in `waitForBusyFall`'s poll loop, strictly before both the rise-wait
bound and the settle check — the same priority order documented above for the
settle window alone. The rise-wait bound therefore cannot itself convert a
step that previously succeeded into a `chain timeout` by outliving the
deadline check; a step whose deadline arrives while still waiting for a rise
times out exactly as it would have waiting for a fall. It *can*, in principle,
make a step that used to resolve near-instantly (the old "never rose, settle
straight away" path) now cost up to the rise-wait bound before resolving —
a real, if small (default: at most one `SWITCHBOARD_SUBMIT_VERIFY_MS` window),
cost increase for that specific case, worth knowing if a caller's per-step
`timeout_ms` was calibrated tightly against the old, faster "never observed"
latency.

Proven in `test/trigger-watcher.test.js`: `waitForBusyFall waits for the
rise: a busy flag that lags a genuine multi-second turn must not be read as
"already over"` (the field incident's shape, confirmed red against the
pre-fix code before the fix landed); `waitForBusyFall rise-wait bound: a
command with no observable turn is not an error, just "never observed"`
(the bound is not a failure mode); `waitForBusyFall regression: a session
already busy when the call begins must still wait for the eventual fall`
(the already-busy fast path is unchanged); and `waitForBusyFall settle window
still applies once a rise is observed (unchanged by the rise-wait bound)`
(the pre-existing settle/`idleSince` invariant still holds once `hasRisen`
is true). The two pre-existing settle-window spec tests above — including
the documented deadline-vs-settle trade-off — remain green unmodified.

### Why `composerEmptyAfterWrite` cannot be made to prove submission, even by feeding it our own writes

A proposal, considered and rejected 2026-09-04: since `submitToPty` writes
straight to the PTY, invisible to `composer-state.js`'s model (see above),
route the module's own writes through `noteUserInput` too, the way
`handleTerminalInput` does for the renderer's keystrokes — then, the
reasoning goes, `composerEmptyAfterWrite` would finally mean something: empty
after our own Enter proves the CLI consumed it.

It would not. `noteUserInput` treats **any** `\r` or `\n` byte as an
unconditional `clearAll` (`composer-state.js`, the `c === '\r' || c === '\n'`
branch) — proven by execution, not read off the source: `node -e` against
`createComposerState`/`noteUserInput` directly, and the pre-existing test
`test/composer-state.test.js:26` ("Enter clears the counter"), both show
`pending` drop to 0 on `\r` alone, with no signal anywhere in the model for
whether a real terminal application actually acted on it. The model has no
feedback channel from the PTY's output back into itself; it encodes an
assumption about what pressing Enter in a composer normally does, not an
observation of what this specific CLI, this specific time, actually did.
Feeding `submitToPty`'s own `command + '\r'` into it would make
`composerEmptyAfterWrite` read `true` after **every** write, unconditionally
and by construction — exactly as vacuous a signal as it is today, just
vacuous for a different reason (today: our writes are invisible to the model;
under the proposal: the model would see them, but its own `\r` handling
already assumes success regardless of outcome).

It would also reintroduce a fixed defect from the other end. `noteUserInput`
stamps `lastInputAt`, and `waitForComposerFree` requires `pending === 0 AND
(now - lastInputAt) >= quietMs` (3000ms default, `trigger-watcher.js:222`) —
so routing our own writes through the same clock would make every trigger
self-block the *next* trigger on that session for a full `quietMs` after
itself, the identical "a non-human signal holds the quiet clock open" shape
already fixed twice for terminal reports (mouse: PR #160; cursor-position:
PR #170). **Conclusion: not pursued.** `composerEmptyAfterWrite` stays a
human-unsubmitted-input check, useful for what `waitForComposerFree`
actually needs (never write over a person's half-typed sentence), and not
repurposed into a self-submission proof it structurally cannot provide. This
is a written limit, not a gap awaiting a fix.

### An unmeasured hypothesis: does a failed step poison the next chain's own wait?

Raised 2026-09-04, explicitly as unmeasured: the transport never writes into a
composer holding unsubmitted input (politeness), but that check is the same
blind `composerEmptyAfterWrite`/`waitForComposerFree` model above — blind to
the module's OWN prior writes. If an earlier chain's last step left text
sitting unsubmitted in the real composer (as the 35-minute observation above
shows happens), a later chain's step 0 write lands on top of that residue,
producing something Claude Code may not parse as the intended slash command --
processed as an ordinary message instead, which can genuinely run long. Under
this hypothesis, the multi-second-to-two-minute waits recorded on step 0
across the five incidents (32s, 44s, 66s, 102s, 120s) would not be measuring
`/compact`'s own duration at all, but an artifact of a *previous*, unwitnessed
failure. **The result schema cannot currently tell these two apart**: both
produce `{command:"/compact", submit_retries:0, waited_ms:N}` for a large `N`,
whether `N` is genuine compaction time or the CLI answering a
residue-contaminated prompt. Distinguishing them needs the target's own
transcript (`compact_boundary` / `isCompactSummary`, see "Why no discriminator"
below) — a caller's job today, as already documented, not something
`trigger-watcher.js` observes. No fix attempted here: the previous section
already establishes that making the module's own writes visible to the
composer model is not clean. Flagged as an open question for whoever picks
this up next, not resolved.

Neither of the two 2026-09-04 gates closes the other's gap — each is proven by
a test that goes red when the *other* fix is reverted but its own is intact.
Neither closes the general causality gap below: an external actor's busy,
landing anywhere in the verify window, still reads identically to our own.

A retry is never eligible for `confirmed` either: needing one already means
the first Enter did not visibly register, so the strongest claim left is
whatever the retry's own busy observation supports (`activity` or `assumed`).

### What `confirmed` still does not claim

**It does not claim the turn it observed is the one our write started.**
Stated exactly, `confirmed` means: the session was idle the instant before we
wrote, a turn was observed within the verify window after that write, and it
was the first attempt. That is all three checks — no more. `pollForBusyObserved`
is a level probe over the whole window (`SWITCHBOARD_SUBMIT_VERIFY_MS`,
2 s default), not an edge wired to our own write: any `busy` transition
inside that window satisfies it, whatever caused it. Reproduced directly — a
session at rest, a write that never touches `busy`, and an unrelated timer
flipping `busy` at t=120 ms independently of that write — still reads
`confirmed`. Calling the not-already-busy gate above "the exact shape of the
field incident" describes what it closes for the *same-session* case
(serialization above closes the rest of that case at the source, since a
second same-session trigger can no longer even attempt a write while one is
in flight) — it does not mean the causality gap itself is closed. An actor
outside this transport's own admission queue — a human at the keyboard, a
process this watcher does not serialize against — produces the identical
`confirmed` for a turn our write did not start, and no PTY byte stream can
tell the difference. Narrowed, not eliminated.

Composer-emptiness plus a not-already-busy write plus an observed turn is the
strongest signal this module can produce without reading the CLI's own effect
— it is **not** proof that the CLI ran the text as a *command* rather than an
ordinary message beginning with the same characters (see "Why no discriminator
was wired in" below, unchanged). A caller that must not act twice on the same
intent still has to read the effect itself; `confirmed` only says the
transport-level handoff went through cleanly.

### Why no discriminator for command-vs-message was wired in

We looked for a signal separating "the CLI ran a slash command" from "the CLI
answered a message starting with `/`", observable **when the result is
written**. There is none, measured on 13 real `/compact` occurrences across
four session transcripts:

- At Enter + a few seconds both cases write the *same* line —
  `{"type":"user","message":{"content":"/compact"}}`, no `<command-name>`, no
  `isMeta`, nothing structural to separate them.
- The signal that never lied on that sample is the `system` /
  `subtype:"compact_boundary"` record with its `compactMetadata`, plus the
  `isCompactSummary` user record and the `<command-name>`/`<local-command-stdout>`
  replay carrying the *same* `promptId` as the injected text.  It is flushed only
  once the compaction has finished: **96 s to 271 s** on that sample, with no
  intermediate write to watch.  A compaction stays in the same `.jsonl`; no new
  transcript opens.
- `~/.claude/sessions/<pid>.json` (see cli-session-state.md) reads `busy`
  throughout a compaction exactly as through any other turn.

So the effect *is* readable, minutes later, by a reader that keeps the injected
`promptId` and watches the session file.  That is a caller's job, not the
watcher's: the watcher returns in seconds by construction.

### Compatibility

`confirmed` is emitted again, on the stricter footing above, and remains
strictly above `activity` in `SUBMITTED_RANK`. A reader that debounces on
`submitted === 'confirmed'` alone is trusting the transport-level handoff, not
the CLI's interpretation of the text — see "What `confirmed` still does not
claim". Readers testing `submitted === 'no'` or `submitted !== 'no'` are
unaffected by any of this. The wire format is shared with other
implementations of this contract, so the same reasoning applies to any
transport that writes a `result.json` with this field.

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
- `expectedCwd` — optional. See "Target guard" below.

**Timeout precedence**: per-trigger `timeout_ms` > `SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS` env var > compiled default (300 000 ms).

Result written to `SWITCHBOARD_TRIGGERS_DIR/processed/<uuid>.result.json`:

```json
{ "ok": true,  "submitted": "activity", "sessionId": "...", "command": "...", "sent_at": "...", "waited_ms": 320 }
{ "ok": false, "submitted": "no", "error": "not sent", "reason": "timeout waiting for idle; nothing was written", "sessionId": "..." }
```

A `chain` result also carries `steps` and `total_waited_ms` — see
`docs/automation.md` ("Triggers") for both `waited_ms` (the single-`command`
path) and `total_waited_ms`'s exact definitions, and the two evident gaps
found and fixed while writing them down (2026-09-04): each chain step's own
politeness wait now counts toward that step's own `waited_ms`, not only
toward the chain total; and the single-`command` path's `waited_ms` now
includes the submit-verification poll (and its retry, if one fired), which it
previously left out entirely.

### `steps_total`

Every result carries `steps_total`: the number of steps of the chain **as
written in the trigger file**, not the number that ran. A single-`command`
trigger is a chain of one and reports `1`. It is injected in `writeResult()`
itself, next to the `submitted` default, so every path through
`processTriggerFile()` — success, validation refusal, timeout, internal error —
emits it and no consumer has to special-case its absence. A trigger rejected
before its shape is readable (unparseable JSON, oversized file, `command` and
`chain` both present) reports `0`: no chain could be read from it.

**Added 2026-09-06 (issue #193), strictly additive.** No existing field changed
name, type or meaning, and no `error` value was added, removed or repurposed —
in particular `"not sent"` still means nothing left the watcher, and
`"chain timeout"` still means at least one step did. The result file is a
published interface: the trigger watcher ships in released builds and we are
not its only users, so a consumer that ignores unknown JSON fields sees no
change at all.

Why it exists: to redeliver the steps of a chain that never went out, a
consumer has to know how long the chain was. Without this field it had to
retain the chain it authored across the whole wait — up to five minutes, and
across its own restarts. When it could not, the result was undecidable:
`steps: [{idx: 0}]` reads identically whether the chain had one step or four.
Measured case, trigger `c3f7a91e-5b4d-4e28-9a16-7d0e2f8b4a63` (2026-09-05):
chain `/compact` then a resume prompt, `waitForBusyFall` consumed the full
300 s because a subagent held the CLI busy, step 1 was never written, and the
session was left compacted with no resume instruction.

**Reading it: the asymmetry that costs time to work out.** On a wait timeout,
the step that *was* written but whose wait never completed is pushed into
`steps[]` and is *not* counted in `steps_completed`. So for a truncated chain:

- `steps_completed` counts steps whose wait completed — it is **not** the
  index the tail resumes from;
- `max(steps[].idx)` is the last step actually sent;
- **the unsent tail is `max(steps[].idx) + 1 .. steps_total - 1`.**

In the measured case above, `steps_completed: 0` with one entry in `steps[]`:
step 0 had gone out. Deriving the tail from `steps_completed` would have
re-sent `/compact` a second time.

When there is no step to take a `max` over, the whole chain —
`0 .. steps_total - 1` — is the tail. Two shapes reach that state and they do
not look alike: a chain refused during its initial idle wait carries
`steps: []` with `steps_completed: 0`, whereas a refusal that never got as far
as the chain loop (`session not found`, `target process not running`, a shape
validation error) carries **no `steps` key at all**. Read it as
`(result.steps || []).length === 0`, not as `result.steps.length === 0`.

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

## Target guard (`expectedCwd`)

**The incident this closes.** An auto-compaction trigger named the session of
a *different* agent — the writer chose its target by taking the session whose
transcript had the most recent `ModTime`, across every project, which is a
race: another session writing at the same instant is addressed instead. That
correction belongs in the writer (in progress, tracked as harness card #85);
what belongs here is a check the transport itself can make before it types
anything, because a valid `sessionId` naming an open session is otherwise
indistinguishable from a stale or racy one.

**The field.** `expectedCwd` (optional, string) is what the writer believes
the target session's cwd to be. It is compared against `sessionEntry.cwd` —
`session.cwd` in `main.js` (the PTY's actual spawn cwd, set at session
creation; see the comment above `spawnCwd`'s declaration in `open-terminal`),
surfaced through `getPtyForSession` in `trigger-context.js`. This is an
extension of `ctx`: before this field, `getPtyForSession` returned only
`{ ptyProcess }`.

**Why cwd, and why the PTY's spawn cwd rather than `projectPath`.** The field
exists to catch exactly the shape of the incident: two agents, two sessions,
open in two different folders (typically two worktrees of the same repo).
`session.projectPath` is the *collapsed* project root — the same for every
worktree of one repo — so it cannot tell two such sessions apart; it is
literally useless for the case that motivated this guard. `session.cwd`
(`spawnCwd`) is the directory the CLI process actually runs in, which does
differ between worktrees. Two sessions open in the *same* folder remain
indistinguishable by this field — stated in `docs/automation.md` so a reader
does not credit it with more than it does.

**Comparison: `normalizeCwd()` in `trigger-watcher.js`.** Both sides go
through it before `!==`. It folds: separator style (`path.normalize`,
platform-aware), a trailing separator (except a bare root), the `\\?\` and
`\\?\UNC\` long-path prefixes, and — on Windows only — case (NTFS/ReFS are
case-insensitive; POSIX is left case-sensitive, matching ext4). The bare-root
exemption checks `n !== path.sep` rather than a length threshold: a length
guard degrades silently the moment `path.sep` is a single character, which it
always is on every platform this runs on, so a POSIX/UNC-style root would
otherwise be one edit away from being stripped down to `""`. It does
**not** fold: 8.3 short names (`JEAN-B~1`) against their long form, a
substituted drive (`subst`) against its real target, or a junction/symlink
against the real folder it points at — two spellings of the same real
directory in any of those three shapes read as a mismatch. Returns `null` for
anything that is not a usable non-empty string, which is also the "nothing to
compare" signal the guard's indeterminate branch reads.

**Three outcomes, and how a reader tells them apart without parsing text.**
The result of a refusal carries a boolean set only on its own path — the same
pattern `internal: true` uses elsewhere in this file — so a reader checks a
key, never a substring of `reason`:

| Outcome | `ok` | `targetMismatch` | `targetCwdUnknown` |
|---|---|---|---|
| absent, or present and concordant | (trigger proceeds normally) | — | — |
| present, discordant | `false` | `true` | — |
| present, target cwd indeterminate | `false` | — | `true` |

Both refusal shapes also carry `expectedCwd` (the raw declared value) and
`observedCwd` (the raw session cwd, or `null` when unknown) — the field
neither side could otherwise read back, since the trigger file that carried
`expectedCwd` is deleted like every other trigger (see "Removing the entry").
Without echoing it in the result, only the transport's own log line records
what was declared. Both refusals write `error: "not sent"` (the whole
contract's "nothing was written" value) with the detail in `reason`.

**Fails closed.** An `expectedCwd` the guard cannot check is refused exactly
like one that disagrees — never waved through. This is the failure mode the
guard exists to close: a session whose registry entry is not yet populated,
or a `ctx` that predates the `cwd` field, must not silently degrade back to
"any valid sessionId is trusted", which is the exact hole this guard closes.

**Where it runs.** Right after the session lookup and liveness pre-flight
(step 4), before either the single-`command` or the `chain` path — one check
per trigger file, not per chain step, so a chain refused here reports no
`steps` and no `partial` at all, the same shape as "session not found".
Malformed `expectedCwd` (present, not a non-empty string) is refused earlier
still, in shape validation (3c), before the session lookup — the same
ordering `wait` and `timeout_ms` already use.

**Unconditionally backward-compatible.** No `expectedCwd` in the trigger means the
guard block is never entered; behaviour is byte-for-byte what it was before
this field existed. A `ctx.getPtyForSession` that still returns bare
`{ ptyProcess }` (an older or a test-only `ctx`) reads as `cwd: undefined`,
which is the indeterminate case — refused only when `expectedCwd` is present,
otherwise never consulted.

Tests: `test/trigger-watcher.test.js` ("Target guard" section) and
`test/trigger-context.test.js` (the `cwd` passthrough);
`test/main-wiring-source-check.test.js` checks `main.js` still builds the
session literal with `cwd: spawnCwd` (source-only, proves nothing at
runtime).

### midBusy gate test precondition

**Symptom (issue #195)**: `test/trigger-watcher.test.js` — "submitted: busy
observed between a step's text write and its own Enter must not confirm it
(midBusy gate)" — failed intermittently on a loaded machine, always on its own
precondition assertion (`steps[1].waited_ms === 0`), never on the gate
behaviour it exists to test. Green on CI and on an idle machine every time.

**Root cause**: `pollForBusyObserved()` samples `Date.now()` twice —
`start` before the poll loop begins, `now` on the loop's first tick — with no
`await` between them (the whole span is a handful of synchronous statements).
The old test asserted `now - start === 0` as proof that step 1's busy state
was already true on its very first poll. That arithmetic is not guaranteed:
under real thread preemption or a GC pause landing between those two
statements, the delta can read `1` (or more) even though zero meaningful
"waiting" occurred — a measurement artefact of wall-clock precision, not a
logic race in `trigger-watcher.js`. Confirmed by directly injecting a 2-3ms
spin between the two `Date.now()` calls in a scratch copy of
`pollForBusyObserved`: reproduces the exact reported assertion, same message,
same line, only the numeric delta differs (`2 !== 0` / `3 !== 0` vs the
reported `1 !== 0`). Reverted after confirming; not part of the shipped fix.
Deliberate CPU oversubscription on sibling processes (up to 52 busy-loops on
an 8-core machine, 100 runs total) did **not** reproduce it — this class of
jitter needs a pause landing in a specific few-statement window, which
external CPU contention alone does not reliably produce.

**Fix**: stopped inferring the precondition from a clock delta. The test's
`isSessionBusy` fake now records the boolean it returns on the first call
made after step 1's text is written (`firstBusyReadAfterStep1Text`), and the
precondition assertion checks that value directly. This relies only on JS's
single-threaded, synchronous call ordering — write-then-poll is guaranteed to
happen in that order by the language, never by timing — so no amount of
scheduler jitter can change what gets recorded, only how long it takes to get
there. `steps[1].waited_ms` was dropped from the precondition assertions,
`steps[1].submit_retries === 0` was kept (it depends only on the `sawBusy`
boolean, never flaky).

**Gate coverage gap found and closed in the same pass**: the existing
`assert.notEqual(result.submitted, 'confirmed', ...)` checks the whole
chain's folded value (`weakestSubmitted` takes the minimum rank across
steps). Mutating `submitWithVerify`'s `midBusy === false` to `midBusy ===
true` flips step 1's `composerConfirmed` to `true` as expected, but it also
flips step 0's (whose own `midBusy` is legitimately `false`) to `false` — and
the fold's minimum reports `'activity'` for the whole chain regardless,
silently passing. Added `assert.notEqual(result.steps[1].submitted,
'confirmed', ...)` on the step's own field, which the fold cannot mask.
Verified both mutations turn the test red: negating the comparison
(`midBusy === true`) and deleting the clause entirely — both fail on the new
step-level assertion with `actual: 'confirmed'`.

## Change-also checklist

- If you rename `_cliBusy` on `session` in `main.js`, update `isSessionBusy` in `trigger-context.js`.
- If you rename `session.composerState` or stop feeding it from `terminal-input.js`, `getComposerState` returns `null` and **every trigger renounces with `not sent`** — the safe direction, but the channel goes silent.  Tests for the model live in `test/composer-state.test.js`; the handler and the ctx are exercised in `test/terminal-input-handler.test.js` and `test/trigger-context.test.js`, and `test/main-wiring-source-check.test.js` reads `main.js` as text to check the remaining glue is still written down (source only — it proves nothing at runtime).
- If you rename `activeSessions` or change the structure (`session.pty` → `session.ptyProcess`), update `getPtyForSession` and `isSessionBusy` in `trigger-context.js`, and `handleTerminalInput` in `terminal-input.js`.
- If you rename `session.cwd` in `main.js`, update `getPtyForSession` in `trigger-context.js` — the target guard silently falls back to "indeterminate" (refuses every guarded trigger) rather than throwing, so this one fails quiet, not loud.
- Tests live in `test/trigger-watcher.test.js`.  They use `SWITCHBOARD_TRIGGERS_DIR` env override — do not hardcode paths there.
