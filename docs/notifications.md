# Notifications

Switchboard monitors all your sessions in the background and shows status indicators in the sidebar so you can tell at a glance which sessions need attention — even while you are working in a different one.

![Status Notifications](../build/screenshot-notifications.png)

## Status badges

Each session entry in the sidebar can show one of the following badges:

- **Waiting for input** — the session has produced output and Claude is waiting for your response. The session is highlighted so it stands out in the list.
- **Permission approval** — Claude is blocked on a permission grant (tool-use approval). The badge alerts you immediately so the session does not sit idle.
- **Activity indicator** — the session is actively running (Claude is processing). This appears as a spinning or pulsing indicator.
- **Response ready** — Claude finished its last response, but you have not focused the session yet. The badge disappears once you switch to that session.

## How it works

Switchboard detects session state from two signals:

- **OSC 0 terminal title sequences** — Claude CLI prefixes the terminal title with an animated spinner glyph while it is working and with ✳ when idle. This is the authoritative "busy/idle" signal.
- **Terminal output activity** — any non-trivial output (excluding noise like progress spinners) also counts as activity.

The combination means Switchboard can tell whether Claude is actively processing, waiting for you, or finished — without polling the JSONL transcript.

## Status bar

The status bar at the bottom of the window shows the total number of active sessions and a summary of any sessions that need attention.
