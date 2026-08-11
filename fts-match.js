'use strict';

// Shared by db.js (synchronous main-thread searchByType, also the worker's
// fallback path) and workers/search-query.js (the dedicated search worker) so
// the query cap and the MATCH-expression construction cannot drift apart.

// FTS_QUERY_MAX_CHARS caps the length of the query string passed to FTS5.
// A trigram-tokenized FTS5 table with tokenize='trigram' builds one trigram per
// 3-char sliding window. When the query is wrapped in double-quotes (phrase query),
// FTS5 intersects ALL trigram doclists in order — a 60-char URL produces ~58
// overlapping trigrams. Common trigrams like "://" or "git" can appear in tens of
// thousands of rows; intersecting all doclists as a contiguous phrase forces FTS5
// to scan enormous intermediate sets and blocks the querying thread for ~60 s.
// Capping the query at 48 chars limits the phrase to ≤46 trigrams (safe upper bound
// for a synchronous main-thread query on a 4000+ session index) while covering any
// plausible hand-typed search string. Longer inputs (pasted URLs, long stack traces)
// are silently truncated — the first 48 chars remain actionable search terms.
const FTS_QUERY_MAX_CHARS = 48;

// Build the FTS5 MATCH expression. Truncation happens BEFORE quote-escaping so
// escaping cannot extend the phrase past the cap. The double-quote wrap gives
// exact substring matching with the trigram tokenizer (prevents FTS5 from
// splitting on punctuation, e.g. "spec.md" → "spec" + "md"). The "title:"
// column filter restricts the match to the title column.
function buildFtsMatch(query, titleOnly) {
  const bounded = String(query || '').slice(0, FTS_QUERY_MAX_CHARS);
  const escaped = '"' + bounded.replace(/"/g, '""') + '"';
  return titleOnly ? 'title:' + escaped : escaped;
}

module.exports = { FTS_QUERY_MAX_CHARS, buildFtsMatch };
