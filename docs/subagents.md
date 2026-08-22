# Subagents

When a Claude session uses the `Agent` tool to spawn sub-tasks, Switchboard indexes those child sessions and surfaces them in the sidebar alongside their parent. This gives you visibility into parallel agent work without digging through raw JSONL files.

## What is a subagent?

A subagent is a child Claude process spawned by a parent session via the `Agent` tool. Each sub-agent has its own JSONL transcript. Subagents are ephemeral — they run to completion and cannot be resumed.

## Sidebar nesting

Subagents appear nested under their parent session in the sidebar. Each entry shows:

- The subagent type (e.g. `implementer`, `researcher`, `reviewer`)
- A live status badge (running / completed)
- The time it was spawned

If the parent session cannot be found in the index (e.g. the parent JSONL was deleted), the subagent appears in a collapsible **Orphan subagents** group at the bottom of its project section. This group is collapsed by default.

## Searching subagents

The full-text search bar covers subagent transcripts. Select **Subagents** in the type selector to restrict results to subagent content only.

## Read-only transcript viewer

Click a subagent entry in the sidebar to open its transcript in a read-only viewer. The viewer renders the full conversation — tool calls, results, and assistant messages — in the same style as the session JSONL viewer.

Because subagents are ephemeral, clicking one does **not** launch `claude --resume`. A **Resume in terminal anyway** button is available at the top of the viewer for the rare case where you genuinely need to re-enter the session context.

## Live status

The sidebar status dot has three shapes for a session that is doing something, and they differ only in movement and hue:

| Dot | Meaning |
|---|---|
| Light-blue braille spinner | The session itself is working, no subagent running under it. |
| Violet braille spinner (same glyph, same cadence) | The session is working **and** at least one subagent is running under it. |
| Static violet ⠿ | The session is at the prompt; subagents are still running under it. |

The violet spinner says the session is busy while agents are running. It does **not** say the session is *waiting* for them: the CLI reports one undifferentiated busy state on its terminal title and never signals "waiting for background agents" to the outside, so nothing here can tell generating apart from waiting. Reading it as "waiting" would be inventing information — see `.ai/contexts/ipc-bridge.md`, "The OSC 0 title is the primary busy channel".

The violet tint reuses the existing spinner rather than adding an animation of its own (`docs/decisions/0002-discrete-steps-sidebar-animations.md`: nothing new that moves in steady state). The session's own higher-priority states still win — `needs-attention` and `response-ready` replace the dot entirely. All three shapes show whether the subagent group is expanded or collapsed.

The grid view shows active subagents as colored pills on the parent session's card. Each pill represents one running sub-agent, color-coded by type:

| Type | Color |
|------|-------|
| explore | green |
| plan | purple |
| implement | orange |
| review | blue |
| test | red |
| other | grey |

Pills disappear when the sub-agent completes.
