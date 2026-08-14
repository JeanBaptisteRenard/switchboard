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

Existing schedules are listed in the project's brain tab (Plans/Memory panel), each with a **run now** button that fires it immediately, bypassing the cron match.

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
- `wait` — `"none"` (default) sends immediately; `"idle"` waits until the session stops being busy before sending. Use `"idle"` for anything that must not interrupt a mid-response stream.
- `timeout_ms` — optional cap on the idle wait (≤ 600 000 ms; default 300 000).

Instead of a single `command`, you can send a `chain` — a sequence of up to 20 steps injected one after another, each submitted and verified before the next:

```json
{
  "sessionId": "abc-123-def",
  "chain": [{ "command": "/compact" }],
  "wait": "none"
}
```

`command` and `chain` are mutually exclusive.

The trigger file is deleted after processing, and a result file is written to `~/.switchboard/triggers/processed/<name>.result.json`:

```json
{ "ok": true,  "sessionId": "...", "command": "...", "sent_at": "...", "waited_ms": 320 }
{ "ok": false, "error": "<reason>", "sessionId": "..." }
```

The primary use case is context-management harnesses — e.g. an agent hook that detects a full context window and injects `/compact` into its own session. Write the trigger file atomically (write to a temp name, then rename) so the watcher never reads a half-written file.
