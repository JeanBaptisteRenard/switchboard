# IDE Emulation

When IDE Emulation is enabled, Switchboard registers itself as an IDE for Claude CLI. File opens and proposed edits appear in a side panel next to the terminal instead of being sent to an external editor.

![IDE Emulation](../build/screenshot-ide.png)

## How it works

Claude CLI discovers connected IDEs via the MCP protocol. When Switchboard is running with IDE Emulation on, Claude finds Switchboard and routes file-open and diff requests to it. The result is that every file Claude wants to show you appears inside Switchboard rather than popping open VS Code or another editor.

## File viewer

Clicking an OSC 8 `file://` hyperlink in the terminal output opens the file in the side panel with syntax highlighting. You can also right-click any file link in the terminal and choose **Open in panel**.

## Diff review

When Claude proposes a file change, the side panel shows a diff — the old version on one side and the proposed edit on the other (or as a unified patch in inline mode).

You can:
- **Accept** the entire change
- **Reject** the entire change
- **Accept individual chunks** (inline mode only) — review each hunk separately and submit the partial result

## Inline and side-by-side views

Toggle between views using the button in the side panel toolbar. Your preference is persisted across sessions.

- **Inline (unified)** — additions and deletions shown in a single pane. Supports partial accept.
- **Side-by-side** — original file on the left, proposed change on the right.

## Disabling IDE Emulation

To disable IDE Emulation (for example, if you want Claude to use VS Code or Cursor):

1. Open **Global Settings**
2. Uncheck **IDE Emulation**
3. Save

This stops Switchboard from registering as an IDE. Claude CLI will then discover and connect to your real editor instead. The change takes effect for new sessions — sessions already running are not affected.

> **Note:** IDE Emulation is a global-only setting. It cannot be overridden per project.
