# Plans, Memory, and Work Files

Three sidebar tabs give you access to the markdown and structured files that Claude Code reads and writes as part of its workflow. All three open in an embedded CodeMirror editor panel.

## Plans

The **Plans** tab lists the plan files from `~/.claude/plans/`. These are markdown files Claude uses to track multi-step work.

Click a plan file to open it in the editor panel. You can read, edit, and save changes directly from Switchboard. The editor supports:

- Syntax highlighting for Markdown
- A markdown preview toggle (render the document as formatted HTML)
- Copy path and copy content buttons
- `Cmd+S` / `Ctrl+S` to save
- Word-wrap toggle

## Memory (CLAUDE.md)

The **Memory** tab shows your `CLAUDE.md` files — the global one at `~/.claude/CLAUDE.md` and any per-project ones found in your indexed projects. These files contain persistent instructions Claude reads at the start of every session.

Click a memory file to open it in the editor panel. Editing and saving works the same as Plans.

## Work Files (`.work-files/`)

The **Work Files** tab shows files under each project's `.work-files/` directory. This is a gitignored scratch space for session notes, proposals, agent reports, and any other ephemeral artifacts that should stay with the project but not be committed.

Each project appears as a collapsible section listing its work files. Click a file to open it in the editor panel. The Work Files panel adds:

- **Format** button (for `.json` and `.jsonl` files) — pretty-prints the file for reading. This modifies the editor content only; it does not write to disk.
- **Delete** button — deletes the file from disk (with a confirmation prompt)
- **Close** button — closes the panel without saving

Files appear automatically in the tab as soon as they are written to `.work-files/` — no manual refresh needed.

> **Note:** `.work-files/` directories are gitignored by convention. Files in this directory do not appear in git status.
