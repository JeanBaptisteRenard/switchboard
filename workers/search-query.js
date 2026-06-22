'use strict';

// Dedicated read-only search-query worker.
//
// Why a separate worker (not the scan-projects worker)?
// The scan-projects worker is used for cold-start index population and may be
// busy with a long sequential scan when the user types a query. Routing search
// through it would queue the query behind a full project scan, making the UI
// unresponsive for up to tens of seconds. A dedicated read-only worker handles
// queries on its own thread with no contention from index writes.
//
// Protocol (via parentPort):
//   inbound:  { id: string, type: string, query: string, limit: number, titleOnly: boolean }
//   outbound: { id: string, results: Array } on success
//             { id: string, error: string }  on error
//
// The worker opens its own read-only better-sqlite3 connection. SQLite WAL mode
// supports multiple concurrent readers — a reader on this thread never blocks
// writers on the main thread and vice-versa.

const { parentPort, workerData } = require('worker_threads');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// DB path is passed from main thread via workerData to respect SWITCHBOARD_DATA_DIR.
const DB_PATH = workerData.dbPath;

// Ensure DB directory exists (belt-and-braces; main process already created it).
const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

// Open read-only to avoid any accidental write and to allow this connection to
// coexist without locking the WAL writer on the main thread.
// readonly:true → SQLite OPEN_READONLY flag; throws if the file does not exist.
// If the DB doesn't exist yet (first launch before indexing), catch below and
// respond with empty results rather than crashing the worker.
let db;
try {
  db = new Database(DB_PATH, { readonly: true });
  db.pragma('journal_mode = WAL');
} catch {
  // DB not yet created — respond to every incoming query with [].
  parentPort.on('message', (msg) => {
    parentPort.postMessage({ id: msg.id, results: [] });
  });
  return;
}

// FTS_QUERY_MAX_CHARS: must match the value in db.js.
// A trigram phrase query over a long input (e.g. a 60-char GitLab URL) generates
// ~58 overlapping trigrams. FTS5 must intersect all doclists as a contiguous phrase,
// which can block the thread for ~60 s on a 4000+ session index. This cap limits
// phrase queries to ≤46 trigrams — safe even for a dedicated worker, as a belt-and-
// braces defence in case Fix B (main-thread truncation) is bypassed by future callers.
const FTS_QUERY_MAX_CHARS = 48;

const searchQuery = db.prepare(`
  SELECT search_map.id, snippet(search_fts, 1, '<mark>', '</mark>', '...', 40) as snippet
  FROM search_fts
  JOIN search_map ON search_fts.rowid = search_map.rowid
  WHERE search_map.type = ? AND search_fts MATCH ?
  ORDER BY rank
  LIMIT ?
`);

parentPort.on('message', (msg) => {
  const { id, type, query, limit, titleOnly } = msg;
  try {
    const bounded = (query || '').slice(0, FTS_QUERY_MAX_CHARS);
    const escaped = '"' + bounded.replace(/"/g, '""') + '"';
    const match = titleOnly ? 'title:' + escaped : escaped;
    const results = searchQuery.all(type, match, limit || 50);
    parentPort.postMessage({ id, results });
  } catch (e) {
    parentPort.postMessage({ id, error: e.message });
  }
});
