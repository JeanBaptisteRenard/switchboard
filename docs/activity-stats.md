# Activity Stats

The **Stats** tab shows a heatmap of your Claude Code activity across all projects, similar to a GitHub contributions graph.

## What the heatmap shows

Each cell represents one day. The intensity of the color reflects how many assistant messages were recorded that day across all indexed sessions. This gives you a visual record of when you were most active.

Below the heatmap, the stats panel shows summary numbers:

- Total messages across all sessions
- Total sessions indexed
- Date of first and most recent session

## Data source

The heatmap is sourced directly from the SQLite session cache — the same database that powers the sidebar. It counts assistant messages grouped by day using the `modified` timestamp on each session. No external service or `~/.claude/stats-cache.json` file is involved.

## Refreshing

Stats update automatically as new sessions are indexed. You can also force a refresh from the stats panel using the **Refresh** button, which re-reads the cache and fetches the latest usage data.
