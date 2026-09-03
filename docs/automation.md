# Automation

Switchboard can run Claude tasks without you at the keyboard, through two complementary mechanisms:

- **Schedules** — cron-style recurring tasks defined as Markdown files, fired by an in-process scheduler.
- **Triggers** — one-shot command injection into an already-open session, driven by dropping a JSON file. Meant for external scripts and harnesses.

## Schedules

A schedule is a Markdown file at `<project>/.claude/commands/schedule-*.md` with YAML frontmatter:

```markdown
---
name: My morning audit
cron: 0 9 * * 1-5
enabled: true
slug: morning-audit
cli:
  permission-mode: acceptEdits
  allowed-tools: Bash,Read,Write
---

<Full self-contained prompt that Claude will execute>
```

When the cron expression matches, Switchboard pre-seeds a new session with the prompt and spawns `claude --resume <sid> -p "..."` headlessly. The run appears as a regular session in the sidebar — open it there to see the result.

### Creating a schedule

Click the **clock icon** on a project in the sidebar. This opens an interactive Claude session pre-loaded with a schedule-creator command: describe what you want scheduled, and Claude writes the `schedule-*.md` file for you. You can also write the file by hand — the scheduler rescans every minute, so changes take effect within 60 seconds, no restart needed.

Existing schedules are listed in the project's brain tab (Memory panel), each with a **run now** button that fires it immediately, bypassing the cron match.

### Behavior and limits

- `enabled: false` disables a schedule without deleting it.
- `cron` is standard 5-field syntax (minute, hour, day-of-month, month, day-of-week) with `*`, lists, ranges, and steps. No `@daily` aliases, no DST awareness (times are local).
- `permission-mode: acceptEdits` (or `auto`) is the practical default — headless `-p` runs hang on any permission prompt otherwise.
- One run at a time per schedule: if a run is still going when the next tick matches, that tick is silently skipped.
- The scheduler lives in-process: **if Switchboard isn't running, the schedule doesn't fire.** It's a personal tool, not a daemon.

## Triggers

The trigger watcher lets any external script type into an open session's terminal — no Electron IPC required. Drop a JSON file into `~/.switchboard/triggers/` (override with `SWITCHBOARD_TRIGGERS_DIR`):

```json
{
  "sessionId": "abc-123-def",
  "command": "/compact",
  "wait": "idle",
  "timeout_ms": 120000
}
```

- `sessionId` — the target session (must be open in Switchboard).
- `command` — written to the PTY, followed by a discrete Enter keypress.
- `wait` — `"none"` (default) does not wait for the session to stop being busy; `"idle"` does. Neither sends into a composer with unsubmitted input: see "Politeness" — `"none"` can still wait, up to `timeout_ms`. Use `"idle"` for anything that must not interrupt a mid-response stream.
- `timeout_ms` — optional cap on the waiting, idle **and politeness** (≤ 600 000 ms; default 300 000). See "Politeness" below: with `wait: "none"` this is the only bound on how long a trigger sits waiting for a free composer.

Environment overrides: `SWITCHBOARD_TRIGGERS_DIR` (watched directory), `SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS` (default idle wait), `SWITCHBOARD_TRIGGER_QUIET_MS` (the politeness quiet window, default 3000 ms).

Instead of a single `command`, you can send a `chain` — a sequence of up to 20 steps injected one after another, each submitted and verified before the next:

```json
{
  "sessionId": "abc-123-def",
  "chain": [{ "command": "/compact" }],
  "wait": "none"
}
```

`command` and `chain` are mutually exclusive.

`wait` accepts **`idle` and `none`, and nothing else.** An absent field still
means `none`, because existing triggers rely on that default, but any other
value — an empty string, `null`, `"idel"` — is refused before anything is
written, with a `reason` naming the value received. Falling back to `none` on a
typo would send immediately into a session that asked to be waited for, which is
the more dangerous of the two behaviours.

### Politeness: Switchboard never types over you

**Nothing is written into a session that has input typed and not submitted.**
A trigger arriving while you are mid-sentence waits, and if it never gets a free
composer before its deadline it renounces rather than splice its payload into
your words.

This is not only courtesy. A slash command injected into a **non-empty**
composer never submits at all: Claude Code submits `/compact` through the
completion menu, which opens only when the `/` is the first character of an
empty box. A session once slept nine hours with an inert `/compact` sitting in
its composer. Politeness is the condition under which the channel works.

**How Switchboard knows.** It models the box. Every keystroke the renderer sends
reaches the main process through one IPC channel, and `composer-state.js` keeps
a running copy of the text it believes is sitting there, plus a cursor into it.
`pending` is that text's length in **code points**, so an emoji weighs one and
one backspace removes it.

A counter could only add and subtract; a model can be edited. What is applied:

| Input | Effect on the model |
|---|---|
| printable bytes, pasted bytes, `ESC [ 200 ~` … `ESC [ 201 ~` content | inserted at the cursor — a paste's embedded carriage returns are text, and do **not** clear the box |
| Enter, newline, Ctrl+U, Ctrl+C | clears |
| Backspace / DEL, `ESC [ 3 ~` (Delete) | removes one code point behind / ahead of the cursor |
| Ctrl+W, Alt+Backspace | removes the word before the cursor |
| Ctrl+K | removes from the cursor to the end |
| Left / Right (`ESC [ C`, `ESC O C`, …), Ctrl+A, Ctrl+E, Home, End | move the cursor; a modified Left/Right moves by a word |
| bare Up (`ESC [ A`, `ESC O A`), Ctrl+V, an unparseable escape | insert one opaque placeholder — the content is unknown, so it counts as one |
| kitty Enter **with** a modifier (`ESC [ 13;2 u`, `ESC [ 13;5 u`) | inserts a line break |
| kitty Enter **without** one (`ESC [ 13 u`), modified Up, OSC, other escapes | nothing |
| mouse reports (`ESC [ < b ; x ; y M`/`m`, `ESC [ M` + 3 bytes), focus reports (`ESC [ I`, `ESC [ O`) | nothing — **and the quiet clock does not move**; these are the terminal talking, not the user |

An escape sequence cut across two IPC chunks is buffered and re-joined, so half
a sequence is never counted as text — including a lone `ESC` that turns out to
be the first byte of the next chunk's bracketed paste. A sequence that cannot be
parsed at all counts as input: **doubt resolves to busy**, always.

The composer is called free only when `pending` is zero **and** nothing has
arrived on that channel for `SWITCHBOARD_TRIGGER_QUIET_MS` (default 3000). The
freshness window covers the one case the model cannot: an Enter that validates a
slash-command completion empties the box while the CLI refills it.

**Where this is blind — stated, not papered over:**

- Only bytes coming from the renderer are seen. Input reaching the PTY by any
  other route is invisible to the model.
- The model is a **line editor's** model, not the CLI's. It knows nothing of
  wrapping, of multi-line navigation, or of any binding Claude Code adds beyond
  the table above; an unmodelled editing key leaves the text longer than the box
  really is. That over-count is the safe direction — the trigger renounces —
  but it stays until the next Enter, Ctrl+U or Ctrl+C, and until then every
  trigger for that session renounces.
- Ctrl+U is treated as clearing the whole box, which is right when the cursor is
  at the end. Used mid-line it would be an under-count if the CLI binds it to
  "kill to start of line" — unmeasured.
- Any chunk carrying something other than a recognised terminal report restarts
  the quiet clock, whether or not it changes the text. Mouse and focus reports
  are the exception, and they had to be: a TUI with mouse reporting on
  (`CSI ?1003h`) emits one report per pointer motion, on the same IPC channel as
  keystrokes, and until 2026-09-02 each of them pushed the clock. **Measured that
  day on the real CLI**, composer emptied with Ctrl+U, no key touched: pointer
  resting *over* the terminal, a trigger waited its full 30 s and was then
  refused — `{"ok":false,"reason":"the last keystroke landed 47 ms ago, inside
  the 3000 ms quiet window","waited_ms":30046}`; pointer moved *off* the
  terminal, the same trigger took `waited_ms":15504` to find 3 s of silence. The
  earlier claim here — "at most ~3 s each time, never a refusal on its own" —
  was wrong: with the user simply present at the machine, triggers were
  unusable. Reports now count as neither text nor activity, so a chunk holding
  only reports changes nothing at all, clock included. The exemption is
  deliberately narrow: SGR reports (`CSI < b ; x ; y M|m`), X10 reports (`CSI M`
  plus exactly three payload bytes), and focus reports (`CSI I`, `CSI O`) with
  no parameter. A near-miss — a parameter too few or too many, a non-numeric
  one, another final byte, a report cut short by the end of a chunk — is *not*
  recognised and still counts as input. Doubt resolves to busy here too: a wrong
  exemption would be a false "free", and a false "free" types over the user's
  sentence.
- Escape does **not** clear the composer on Claude Code v2.1.258 (measured), so
  treating it as neutral is correct *today*. A CLI change would turn it into a
  false "free".
- An Enter that validates a completion menu empties the model although the box
  is still full. Only the quiet window covers that.
- A composer filled by the CLI itself — a prompt, a queued message, a resumed
  draft — was never typed and is not counted.
- **Modified Up arrows are not counted, and on Claude Code v2.1.258 that is
  correct — as a dated measurement, not a guarantee.** Measured on an isolated
  PTY with a screen dump: plain `ESC [ A` and `ESC O A` do recall history (the
  screen shows `─── History 2/2 ───` and the previous command lands back in the
  box), which is why the model inserts one placeholder for them. `ESC [ 1;2 A` (Shift+Up),
  `ESC [ 1;3 A` (Alt+Up) and `ESC [ 1;5 A` (Ctrl+Up) leave the box empty, so not
  counting them is not an undercount on this version. A CLI release that gave
  those chords a meaning would reopen an undercount — and undercounting is the
  dangerous direction: it reads a full composer as free.
- A triggers directory whose path contains an 8.3 short name (`JEAN-B~1`) kills
  the process outright: `fs.watch`/libuv asserts. Use the long path.

The guard applies to every write, including the bare recovery Enter the watcher
sends when it saw no turn start — on a half-typed sentence that Enter would
submit the sentence. When politeness never allows a write, the result is
`{ "ok": false, "submitted": "no", "error": "not sent", "reason": "…" }`.

**What this costs `wait: "none"`.** It no longer means "write now": against a
non-empty composer it waits, and the only bound is `timeout_ms` — 300 000 ms by
default. For all of that time the trigger holds one of the 8 concurrent slots
(`MAX_INFLIGHT`), so a handful of triggers aimed at sessions whose users walked
away mid-sentence can stall the queue for every other session. Set a short
`timeout_ms` on triggers that would rather renounce than wait.

### Reading a result

The trigger file is deleted after processing, and a result file is written to `~/.switchboard/triggers/processed/<name>.result.json`:

```json
{ "ok": true,  "submitted": "confirmed", "sessionId": "...", "command": "...", "sent_at": "...", "waited_ms": 320 }
{ "ok": false, "submitted": "no", "error": "not sent", "reason": "4 byte(s) of input are sitting unsubmitted in the composer" }
```

**`submitted` is the field to read, not `ok`.** A payload written into a
composer is not a message received. Three values, compared by strict equality:

| Value | Meaning |
|---|---|
| `confirmed` | the session went busy after our write — the submission was observed |
| `assumed` | written, no failure seen, nothing observed afterwards |
| `no` | nothing was written, or it was written and not submitted |

A `chain` reports the **weakest** value any of its steps reached
(`no` < `assumed` < `confirmed`).

**`error` is compared by strict equality too**, so explanations go in `reason`
and never into `error`: `not sent: input pending` is not `not sent`. `reason`
carries the detail alone, and carries it for every failure — a reader that wants
to know *why* reads `reason`, never a substring of `error`.

| `error` | What it promises the reader | What the emitter does with it |
|---|---|---|
| `not sent` | **not one byte reached the session.** No idle ever came, politeness never allowed a write, or the trigger was refused before any write | nothing to assume about: the harness **voids** the pending guard, and the next turn forces again on its own |
| `chain timeout` | at least one step **was written**, and the expected effect was not observed before the deadline | the effect is only assumed, so the harness **keeps blocking** the next compaction |
| anything else | free text: `session not found`, `pty write failed: …`, a validation refusal | read `submitted` to know whether anything landed |

The two reserved values are easy to confuse and mean opposite things, so:

- A chain whose first step landed and whose second was held back by politeness
  reports `chain timeout`, never `not sent`.
- A `wait: "idle"` that expires without the session ever going idle reports
  `not sent` with `reason: "timeout waiting for idle; nothing was written"`,
  and `partial: false` — never `chain timeout`. This is the commonest failure
  in service: a session reports itself busy for as long as any delegated agent
  runs, so `idle` is regularly unsatisfiable, and answering `chain timeout`
  there would block every later compaction over a payload that never left.
- The same holds when the session exits during that initial wait: the `error`
  stays the free-text `session exited during wait`, but `submitted` is `no`,
  `partial` is `false`, and `reason` says nothing was written.

The primary use case is context-management harnesses — e.g. an agent hook that detects a full context window and injects `/compact` into its own session. Write the trigger file atomically (write to a temp name, then rename) so the watcher never reads a half-written file.
