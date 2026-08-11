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
// If better-sqlite3 fails to load (ABI mismatch) or the DB is unavailable,
// exit with a non-zero code: the client's exit handler counts the failure,
// restarts with exponential backoff, and opens its circuit-breaker after
// maxRestarts — from then on every search takes the documented synchronous
// searchByType fallback on the main thread. Answering queries from a broken
// worker instead (e.g. a permanent `results: []` stub) would keep the worker
// "online" and make search silently empty forever, with the fallback machinery
// never engaging.
let db;
try {
  // require() is inside the try block so a native-module load failure (e.g.
  // ABI mismatch after npm rebuild) is caught rather than thrown at top level.
  const Database = require('better-sqlite3');
  db = new Database(DB_PATH, { readonly: true });
  // WAL coexistence: the main thread's connection sets journal_mode=WAL at startup.
  // A readonly connection in WAL mode never blocks writers and vice-versa.
  // Setting journal_mode on a SQLITE_OPEN_READONLY connection is a no-op, so we
  // rely on the DB-level mode rather than issuing a redundant pragma here.
  // busy_timeout is per-connection, though: without it a reader hitting a brief
  // lock (e.g. WAL checkpoint) fails immediately instead of waiting it out.
  db.pragma('busy_timeout = 5000');
} catch (e) {
  console.error(`[search-query-worker] cannot open DB, exiting: ${e.message}`);
  process.exit(1);
}

// Query cap + MATCH construction shared with db.js via fts-match.js so the
// worker and the synchronous fallback cannot drift apart.
const { buildFtsMatch } = require('../fts-match');

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
    const match = buildFtsMatch(query, titleOnly);
    const results = searchQuery.all(type, match, limit || 50);
    parentPort.postMessage({ id, results });
  } catch (e) {
    parentPort.postMessage({ id, error: e.message });
  }
});
