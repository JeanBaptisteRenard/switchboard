# Activity Trace

A diagnostic trace for the sidebar's activity indicators — the blue braille
spinner, the blue "response ready" dot, the orange attention LED, the purple
subagent glyph, and the green running dot.

Those indicators are driven by two processes with two clocks: the main process
parses OSC sequences off the PTY and watches the filesystem, the renderer keeps
four independent state stores and paints classes. When one of them is wrong,
`main.log` cannot say why — most of the OSC handling logs at `debug`, which a
packaged build never writes, and nothing at all records the renderer side.

The activity trace records **both processes into one ordered file**, so the
question "what did the CLI actually put in the title, and what did the UI do
about it" has a single answer you can read.

**It is off by default and costs nothing when off.** Turn it on only while
investigating.

## Turning it on

Settings → **Diagnostics** → **Debug Mode**. The switch takes effect the moment
it is flipped: no restart, no relaunch, no session lost. That is the point of
it — the symptoms this trace exists to catch correlate with session activity,
and restarting the app to arm a diagnostic destroys the state you wanted to
observe. The panel also lists the trace files, with their size and date, and
can open or delete one.

The choice is remembered across launches: it is stored as `activityTrace` in
the `global` settings row, the same object every other app-wide preference
lives in.

At startup, from a shell:

```bash
SWITCHBOARD_ACTIVITY_TRACE=1 task dev
```

Accepted values: `1`, `true`, `yes`, `on` (case-insensitive); `0`, `no`, `off`
and anything else unrecognised mean off. The variable remains the **startup**
path, for scripts and CI: when it is set at all it decides the state the app
boots with, in either direction, and the stored preference is ignored for that
launch. When it is unset or blank, the stored preference decides. Neither locks
the switch — the panel can toggle the trace either way once the app is running.

The variable is read **once**, by the main process (`activity-trace.js`); the
renderer never parses it, it is told the startup answer through a launch
argument and every later change over the `activity-trace-state` event, so the
two halves cannot disagree.

### Turning it off, and on again

Turning the trace off closes the file properly: the write stream is `end()`ed,
which flushes everything already handed to it before the descriptor closes, so
the last lines written are not lost. Probes stop at the same instant — the
state is read before any payload is built, so nothing is constructed for a
line that will not be written.

Turning it back on **opens a new segment** rather than appending to the closed
one. Two reasons: the file name is stamped with the moment the observation
window opened, and appending would put two disjoint windows with an unexplained
gap between them into one file whose name describes only the first; and the
rotation bookkeeping is per-file. `seq` does not restart — it is process-wide,
and it is what orders the two halves of a session.

The stamp has one-second resolution, so an off/on inside the same second
resolves to the same name and **resumes that window** instead of creating a
second one indistinguishable from it: it reopens the segment the window was
last writing to, not its first. That is the correct reading of the name — the
window is the second it is stamped with.

The byte counter is re-read from the file on open, so the rotation threshold
measures the file rather than the last window. That detail is load-bearing, not
housekeeping: starting the counter at zero on each activation lets one segment
grow past the cap once per toggle, and once past it the threshold is met on
every write, so rotation never fires again and the 64 MB ceiling stops
applying. A segment that is already at the cap when it is reopened rotates
immediately rather than taking one more line first.

That case is not hypothetical — it is a double-click on the switch, and it used
to be destructive: the same path went into the retained-segment list twice, the
ceiling counted one file as two, and the queue eventually unlinked the segment
the trace was still writing to. The queue now re-queues a returning path
instead of duplicating it.

The disk ceiling is not per-window: the retained-segment list spans the whole
process, so four short observation windows leave the same four segments a
single long one would. Rotation works identically whether the trace was armed
at launch or an hour later.

The file lands in the app's data directory, next to `switchboard.db`:

| Run | Directory |
|---|---|
| `task dev` / any dev run | `~/.switchboard-dev/` |
| `task test-pr PR=<n>` | `~/.switchboard-dev-pr<n>/` |
| Explicit `SWITCHBOARD_DATA_DIR=...` | that directory |
| Packaged app, no env var | `~/.switchboard/` |

The directory is not re-derived: it is `path.dirname(DB_PATH)`, the single
resolution `db.js` performs, so the trace always lands beside the database it
belongs to. The name is stamped with the launch time — `activity-trace-20260822-141530.jsonl` —
so a new run never overwrites the previous investigation. The main log prints
the full path at startup (`[activity-trace] enabled → ...`).

Nothing is written into the repository.

## Reading a line

One JSON object per line. The first six fields are the envelope, always in this
order, always present; the rest is the probe's payload.

```json
{"seq":417,"t":38214.912,"wall":"2026-08-22T14:20:09.118Z","src":"main","cat":"osc.title","sid":"6f1c…","cp":"U+25D0 U+0020 U+0043","title":"◐ Claude","busy":true,"idle":false,"rule":"glyph","was":false,"decision":"emit:busy"}
```

| Field | Meaning |
|---|---|
| `seq` | Monotonic sequence number. **The only reliable ordering.** |
| `t` | Milliseconds since the trace opened, from the main process's monotonic clock. |
| `wall` | Wall-clock ISO timestamp, for correlating with `main.log` and screenshots. |
| `src` | `main` or `renderer` — where the event was observed. |
| `cat` | Probe category (table below). |
| `sid` | The session id the entry is about, or `null`. |

**The main process is the only writer.** The renderer sends its probes over a
fire-and-forget IPC (`activity-trace`) and the main process stamps `seq`, `t`
and `wall` on arrival. That is deliberate: two files with two clocks cannot be
interleaved after the fact, and the ordering is the whole point. The cost is
that a renderer entry's timestamp is its *arrival* time in main, not its
emission time — sub-millisecond in practice, but do not read `t` as renderer
latency.

If a payload field collides with an envelope name, it is stored with a leading
underscore (`_seq`), so `seq` always means the sequence number.

Any probe that names an emission carries **`sent`**: every `webContents.send`
in the app is guarded by `mainWindow && !mainWindow.isDestroyed()`, so a line
saying an event was produced would otherwise be claiming a delivery it never
checked. `sent:false` means the state changed but the renderer was already
gone — normal during shutdown, a real finding at any other time. Probes that
only record an observation (`osc.title`, `osc.progress`, `pty.exit`,
`poll.snapshot`, `subagent.assumed-finished`) make no delivery claim and carry
no `sent`.

## Probe categories

### Main process

| `cat` | Fires when | Key fields |
|---|---|---|
| `osc.title` | Every OSC 0 title with a payload | `cp`, `title`, `busy`, `idle`, `rule` (`glyph` / `idle-glyph` / `fallback` / `null`), `was`, `decision` |
| `osc.progress` | Every OSC 9;4 progress level (except `4;0`) | `level`, `payload`, `was`, `decision` |
| `osc.notify` | Every non-progress OSC 9 | `message`, `sent` |
| `busy.emit` | A `cli-busy-state` event leaves main | `busy`, `via` (`osc0` / `osc9.4`), `sent` |
| `subagent.spawned` | `subagent-spawned` is sent | `agentId`, `kind` (`spawn` / `heartbeat`), `subagentType`, `ageMs`, `sent` |
| `subagent.assumed-finished` | An unknown transcript is recorded as already finished, **silently** — no IPC | `agentId`, `ageMs`, `bootstrap`, `recheck` |
| `subagent.rehabilitated` | An assumed-finished entry grew inside its recheck window: the withheld spawn is released | `agentId`, `withheldForMs`, `subagentType`, `sent` |
| `subagent.completed` | `subagent-completed` is sent | `agentId`, `stableForMs`, `reason`, `sent` |
| `session.forked` | A fork re-keys a live session | `newId`, `wasBusy`, `sent` |
| `pty.input` | Every `terminal-input` IPC chunk, before the composer model sees it | `len` always; `at` and `cp` only when the chunk holds a control character |
| `pty.exit` | The PTY exits | `exitCode`, `alsoUnder`, `wasBusy` |
| `poll.snapshot` | `get-active-sessions` answers | `count`, `entries` |
| `app.quit` | Last line of a clean shutdown | — |

### Renderer

| `cat` | Fires when | Key fields |
|---|---|---|
| `recv.*` | An IPC event arrives (`cli-busy-state`, `terminal-notification`, `session-forked`, `session-detected`, `process-exited`, `subagent-spawned`, `subagent-completed`) | per event |
| `recv.subagent-spawned` | …with `applied` telling whether it changed anything. `applied:false` + `reason:"heartbeat-for-untracked-agent"` is a heartbeat deliberately dropped | `agentId`, `applied`, `bootstrap`, `heartbeat`, `from` |
| `store.mutate` | A state store changes | `map`, `op`, `from`, `to`, `fn`, `via` |
| `store.skip` | A write was **refused** by a guard | `map`, `reason`, `fn` |
| `store.purge` | State dropped because the PTY is gone | `reason`, `busy`, `ready`, `attention` |
| `store.rekey` | Activity state carried across a fork | `from`, `busy`, `ready`, `attention` |
| `subagents.prune` | The 60 s TTL sweep ran | `parents`, `agents` |
| `class.apply` | `cli-busy` / `response-ready` written | `el`, both class states |
| `class.toggle` | `needs-attention` / `has-running-pty` written | `el`, `cls`, `on` |
| `class.subagent` | Subagent `running` / `has-running-child` / `has-busy-agents` written | `el` ids, `running` |
| `class.render` | A full sidebar render reconstructed an item's classes from the stores | `el`, `cls` |
| `poll.recv` | The poll reply reaches the renderer | `sinceSeq`, `entries` |
| `reconcile.apply` / `reconcile.skip` / `reconcile.noop` | Per session in the poll reply | `backend`, `local`, `reason`, `sinceSeq`, `sessionSeq` |

`store.mutate` carries `fn` (the function that wrote) and, for `setActivity`,
`via` (the caller that asked). `setActivity`'s third argument exists only for
this — it is inert when the trace is off.

## What the trace is for

Three questions it answers that nothing else can:

**Does the CLI's title still match the busy test?** This is the question the
trace was built for, and the first run of it (2026-08-22) found the test broken:
over the first ten minutes of that trace, 623 of 628 OSC 0 titles started with
`U+25D0` / `U+25D1` and were marked `ignored:no-match`, and every busy transition
was attributed to `via:"osc9.4"` — the title could only turn the spinner *off*.
Quote a window, not a total, if you cite your own run: the file grows for as long
as the variable is set. Recheck after a
CLI upgrade, because the glyphs are the CLI's private business and it has
changed them before:

```bash
# Leading code points, and what the detector made of them
jq -r 'select(.cat=="osc.title") | "\(.cp | split(" ")[0])\t\(.rule)\t\(.decision)"' $TRACE | sort | uniq -c

# Where busy transitions actually came from — `osc0` must appear
jq -r 'select(.cat=="busy.emit" and .busy==true) | .via' $TRACE | sort | uniq -c
```

Spinner frames reading `rule:"fallback"` mean the CLI moved to glyphs the range
table in `classify-title-activity.js` does not list yet — still detected, worth
adding. `ignored:no-match` on a title that visibly carries a prefix means the
fallback itself regressed. No `osc0` in the second count means the title channel
is dead again and the indicator is riding on the progress-bar setting alone. The
full argument is in [`.ai/contexts/ipc-bridge.md`](../.ai/contexts/ipc-bridge.md),
"The OSC 0 title is the primary busy channel".

**Was an event suppressed, or never sent?** `osc.title` records the verdict
(`emit:*` vs `suppressed:*`) and `busy.emit` records the actual send. A
`decision` of `emit:busy` with no `busy.emit` right after it is a bug in the
emitting branch; `suppressed:already-busy` is working as intended.

> **Expect a burst at startup.** The first scan of a session emits one
> `subagent.assumed-finished` line per historical transcript — a project with a
> thousand of them produces a thousand lines in a single pass, before anything
> interesting has happened. They all carry `bootstrap:true`, and later scans
> produce none (the directory-mtime cache skips known files), so filter them
> out when you are reading a startup problem:
> `jq -c 'select(.bootstrap != true)' $TRACE`.

**Is a subagent's state the truth or an assumption?** A transcript first seen
already stale is recorded as finished without any event — `subagent.assumed-finished`
is the only record that it happened. When `recheck` is `true` that verdict is a
guess (the sighting may simply have been late), and a later
`subagent.rehabilitated` line is the guess being retracted, with `withheldForMs`
saying how long the spawn was suppressed. A parent whose indicator is wrong
usually has one of these two lines behind it.

**Did the UI receive it and act?** Follow the `seq` numbers: `busy.emit` →
`recv.cli-busy-state` → `store.mutate` → `class.apply`. A chain that stops
early localises the fault to one process. `store.skip` and `reconcile.skip`
name the guard that dropped the value.

### Useful filters

```bash
TRACE=~/.switchboard-dev/activity-trace-*.jsonl

# Which code points does the CLI actually send, and what did the detector decide?
jq -r 'select(.cat=="osc.title") | "\(.cp)\t\(.rule)\t\(.decision)"' $TRACE | sort | uniq -c

# Everything about one session, in order
jq -c 'select(.sid=="6f1c…")' $TRACE

# Every state write that was refused, and by which guard
jq -c 'select(.cat=="store.skip" or .cat=="reconcile.skip")' $TRACE

# Everything the subagent detector decided, in order, minus the startup burst
jq -c 'select((.cat | startswith("subagent.")) and .bootstrap != true)' $TRACE

# Events the app produced but never delivered (renderer already gone)
jq -c 'select(.sent == false)' $TRACE

# Subagent events the renderer received but deliberately dropped
jq -c 'select(.cat=="recv.subagent-spawned" and .applied==false)' $TRACE

# Emission vs reception, side by side
jq -c 'select(.cat=="busy.emit" or .cat=="recv.cli-busy-state")' $TRACE
```

## Cost when disabled

Nothing is built, sent, or written.

- **Main process** — `TRACE` is the trace module's state object, `{ on }`.
  Every probe is `if (TRACE.on) trace(...)`: one property load on a plain
  object, no allocation, and the payload literal is never evaluated with the
  trace off. The object rather than a boolean is what makes the switch work at
  all — a `const TRACE = activityTrace.enabled` would freeze the value at
  require time, and every probe would be pinned to whatever the environment
  said at launch. The `activity-trace` IPC handler *is* registered
  unconditionally, so that arming the trace needs no new listener; the renderer
  does not send to it while off, and `trace()` drops the line if anything does.
- **Renderer** — `preload.js` resolves the startup flag and exposes it as
  `window.api.activityTraceEnabled`; `public/activity-trace.js` reduces it to
  `window.ATRACE` and keeps that flag following main's state pushes. Probes are
  `if (window.ATRACE) window.atrace(...)`: one property load, no allocation, no
  IPC. `window.atrace` is the real forwarder whenever the preload bridge exists
  — gating the function itself on the startup flag would leave the renderer
  permanently mute whatever main said later.
- The trace function also short-circuits on its own first line, so a stray
  call from anywhere is inert.

`test/activity-trace.test.js` and `test/activity-trace-renderer.test.js` pin
this: a disabled trace never advances its sequence counter, never opens a file,
and never reads a payload property (the tests hand it an object with a
throwing/counting getter).

`test/activity-trace-probe-guards.test.js` pins it at the call sites, and does
so by reading the source rather than by running it. Running a guarded statement
in a sandbox of exploding stubs only demonstrates that `if (false) X` does not
evaluate `X` — a property of the language. What actually goes wrong is a helper
called on the line *above* the guard, which such a rig never loads. So the
checks are scans: every call to `trace`, `codePoints`, `controlOffset`,
`busyDecision` or `progressDecision` in `main.js` must sit under `if (TRACE.on)`,
and the probe categories are named so a probe deleted in a refactor fails the
suite instead of quietly reducing a count.

One call is exempt and pinned by its exact text: the OSC 0 `log.debug` line
renders a code point into a template literal on every title, whatever the trace
is doing. It predates this feature (c07ab13, 2026-03) and is on `main`; the
exemption exists so that it stays the only one.

This matters because of
[ADR 0002](decisions/0002-discrete-steps-sidebar-animations.md) — the
indicators were rebuilt to stop burning CPU at idle, and a diagnostic that
allocated on every render would undo that. Even when the trace is **on**, no
probe sits on the terminal render path: `osc.title` fires only for chunks
carrying an OSC introducer, and `pty.input` only for chunks the renderer sends
*to* the PTY — a channel a person can only drive at typing speed, and whose
unexplained traffic is the thing that probe exists to expose.

`pty.input` always records the chunk's length, and records code points **only
from the chunk's first control character** (C0 or DEL) onwards, with `at` saying
where that was. A chunk of printable text has no control character, so it
contributes a length and nothing else — no `cp` field at all.

That rule is what stops the probe from being a keylogger. xterm sends roughly
one chunk per keystroke, and the leading code points of a typed chunk *are* the
text, hex-encoded and trivially reversible; a trace left on for an evening would
otherwise hold everything typed into every session, on disk, for anything that
reads the file afterwards. Nothing is lost for the question being asked: the
chunks under suspicion push the composer's quiet clock while leaving `pending`
at 0, which makes them escape sequences and control characters by construction —
exactly what is kept — and a typed chunk announces itself through `pending > 0`,
where its length is all the trace needs to add.

Ten code points is more than `osc.title`'s three because the question here is
which escape sequence arrived, and a CPR reply (`ESC [ 24 ; 80 R`) is eight.
Those ten start at the control character, so a chunk whose sequence is followed
by text — a bracketed paste, `ESC [ 200 ~` then the pasted content — can still
carry a few characters of it. That is the bound of the guarantee: no chunk of
plain text is ever rendered, and no rendering ever starts before a control
character.

## Disk use

Bounded. The trace writes to at most 4 rotating segments of 16 MB each — a
64 MB ceiling by default, so it can be left on overnight. When the cap is
reached the oldest segment is deleted; the tail is what you read.

If that deletion fails — most plausibly because you have a `tail` or an editor
open on the segment, which is exactly what an investigation looks like — the
file stays queued and is retried at the next rotation, and a
`trace.prune-failed` line records it. So the ceiling can be temporarily
exceeded, but never silently: grep the trace for `prune-failed` if disk use
surprises you.

A segment that is simply **gone** is the one failure that is not retried: it is
dropped from the queue and the ceiling moves on. Deleting an old segment from
the Diagnostics panel, or by hand in the directory, would otherwise wedge the
queue head on a file that can never be unlinked again, and the 64 MB ceiling
would stop applying for the rest of the run. The panel refuses to delete the
segment currently being written; every other one is fair game.

```bash
# 256 MB ceiling instead of 64
SWITCHBOARD_ACTIVITY_TRACE=1 SWITCHBOARD_ACTIVITY_TRACE_MAX_MB=256 task dev
```

Writes go through an append-only stream and are never read back. The stream
buffers, so a slow disk delays the trace instead of blocking the main thread —
the trade is that the last few lines may be lost on a hard crash. A clean quit
flushes and closes (`app.quit` is the last line).

## Testing the async prune path

`rotate()` runs `openSegment()` synchronously but hands the retired stream's
cleanup (`pruneSegments`) to its `close()`, because Windows refuses to unlink
a handle that is still open. `close()`, `setEnabled(false, ...)` and the
module's own `close()` used to pass that continuation straight to `.end()`
instead: `.end(callback)`'s callback fires on the stream's `finish` event,
which only means the data was handed off — `autoClose`'s own internal
`fs.close()` runs after that, and only the stream's separate `close` event
means the fd is actually released. That gap was invisible on Linux/macOS
(POSIX lets you unlink or remove a directory entry with an open handle on
it) and surfaced as Windows-only CI failures (`ENOTEMPTY` on the test
temp-dir cleanup right after `close()`) once the Windows leg of the test
matrix existed to see it. Fixed by listening for `close` before running the
continuation, instead of relying on `.end()`'s own callback.

Under `node --test`'s default concurrency (one process per test file, dozens
running at once), that `close` event can still take far longer than it does
in isolation: CPU and disk contention from the sibling processes delays the
event loop turn it needs.

That first fix waits for the stream `close()`/`setEnabled(false, ...)`
retires *itself* — not for streams retired by earlier `rotate()` calls
still in flight. A run with several rapid rotations can have more than one
old stream mid-close at once; `close()` returning as soon as its own
stream is done left those still open, the same `ENOTEMPTY` on the
directory. `pendingRotationCloses` tracks every in-flight rotation close;
`close()`/`setEnabled(false, ...)` wait for that count to reach zero too,
not just for their own stream.

Two tests in `test/activity-trace.test.js` used to bridge that async gap with
a fixed `setTimeout(60)`. That is a duration bet, not a correctness check, and
it hides a real ordering hazard rather than just being slow: `close()` sets
`stream = null` synchronously. If a `pruneSegments` callback from an earlier
rotation is still queued when `close()` runs, it later calls `trace()` to
record the `trace.prune-failed` warning, finds `stream` already null, and
`trace()`'s own `if (!stream && !write) return;` guard drops the line with no
error — a silent no-op, not a crash. On a quiet machine 60 ms is enough for
the callback to run before `close()` is reached; under the full suite's
parallel load it sometimes is not, and the warning that the test asserts on
never gets written. This is a test-ordering bug, not a production one: at
real quit time losing one diagnostic warning about pruning (never the trace
data itself) is an acceptable trade, not a defect worth guarding against.

All three of these tests now poll the actual condition (`waitUntil`, capped at
10 s) instead of sleeping a fixed duration — bounded by an outcome, not a
clock — and, in the prune-failure test, wait for the warning to land on disk
*before* calling `close()`, so the shutdown never races the pending callback.
The segment-count test above them flaked the same way once under full-suite
load even with a 1 s poll budget, purely from Windows filesystem-metadata
contention across dozens of concurrent `node --test` processes — not a logic
bug, just headroom that needed to be more generous.

## Related

- [Notifications](notifications.md) — what each indicator means to a user
- [`.ai/contexts/ipc-bridge.md`](../.ai/contexts/ipc-bridge.md) — busy-state reconciliation
- [`.ai/contexts/subagent-observability.md`](../.ai/contexts/subagent-observability.md) — subagent spawn/complete detection
