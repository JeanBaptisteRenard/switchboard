# Working practices for AI agents

Distilled, portable practices for any AI agent (Claude Code or otherwise) working in this
repo. Cross-references [shared-guidelines.md](../shared-guidelines.md) rather than repeating
it — see that file for worktree isolation (§3), no `Co-Authored-By` (§5), and not touching the
live app while a session is mid-run (§1, §2, §6).

## 1. Never simulate behavior that did not happen

A functional framing implying a step occurred requires that step to have actually occurred.
Never describe a test run, a check, or a fix that wasn't executed. If a command fails, report
the failure verbatim — don't paraphrase it into something that reads as success.

## 2. HANDOFF — how agents report results

Any sub-agent or automated task ends its final message with a structured block:

```text
---HANDOFF---
skill: <name | none>
outcome: PASS | FAIL | PARTIAL | REWORK
- What was done/changed (cite files when relevant)
- Key decisions and why
- What remains / blockers / next steps
---
```

- `skill:` and `outcome:` are the first two lines, always present, machine-parseable.
- 3-5 bullets, ≤150 words total. Be specific — no "made progress on X".
- **Out-of-scope discoveries go in the HANDOFF as a note, not as a fix.** Don't scope-creep a
  task because you spotted something else wrong nearby.

### Final-message contract

Whoever dispatches an agent only sees that agent's **last message**. Earlier messages
(intermediate findings, a verification run, a report) are not reliably visible to the caller.
Consequences:

- The HANDOFF block must be in the FINAL message, after any verification step — not before it.
- A long-form deliverable (a review, a research writeup) gets **written to a file** under
  `.work-files/<topic>/` and the path is cited in the HANDOFF; the HANDOFF itself stays short.
- **If the task ends in a commit + push, the push is the terminal action** — run it, then
  confirm with `git log origin/<branch> --oneline -1` that the remote head advanced, and only
  then emit the HANDOFF. Never end on a sub-step (e.g. a formatting/lint pass) that leaves the
  push undone — that sub-step's own output would become the final message instead.

## 3. Review loop before shipping

A change ships once an implementer ↔ reviewer loop has converged: the reviewer has nothing
left to flag (no unresolved correctness findings), not just "looks fine on a skim". A reviewer
verifies claims with **executed evidence** — actually running the command, the test, the
`git log`/`git show`/`wc -l` check — rather than re-reading the diff and trusting the prose.
Findings get fixed, then re-reviewed, until the loop is clean.

## 4. Shell pitfalls in an agent harness

Commands that read fine to a human can silently misbehave or get blocked in an agent
execution environment. Rules of thumb:

- **No heredocs** (`<< EOF`) — treat multi-line content as data to write to a file, not to
  inline into a shell command.
- **No `cd <path> && git ...`** and **no `git -C <path> ...`** for a repo other than the
  current one — these patterns are commonly blocked by permission guards against
  cross-repo/bare-repo mistakes. If you need another repo's state, `git fetch` into the
  current one, or work from a separate worktree/checkout.
- **Avoid shell loops** (`for`/`while`/`until`) in a single command — prefer separate
  commands, or `xargs` for a single-command iteration.
- **Use `jq` for JSON parsing**, not inline `python3 -c "import json; ..."` — cleaner and less
  fragile to quote.
- **Use `.work-files/`, not `/tmp/`, for scratch files** — it's gitignored, project-scoped, and
  visible in the Work Files sidebar tab for debugging.
- **No `sleep N && command` to wait for background work** — if a task runs in the background,
  react to its completion signal; don't poll with a fixed sleep.

## 5. Memory / notes hygiene

Any saved note, memory, or prior observation is a **point-in-time snapshot**, not live state.
Before citing something more than about a week old as a current fact — a file's line count, a
commit range, a "this is safe" claim — re-verify it against the actual repo (read the file, run
the check). If it's stale, correct or delete it in the same pass rather than repeating it.

## 6. Scope discipline

Fix exactly what was asked. When a task names N specific findings, apply N fixes — no
unrelated cleanup, no rewriting adjacent prose "while you're in there". If you notice something
else that's wrong, say so in the HANDOFF; don't fix it silently.
