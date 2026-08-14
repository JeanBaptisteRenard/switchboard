'use strict';

// Static-analysis tests (native-module-free) for the query-length cap in
// db.js searchByType.
//
// better-sqlite3 is compiled against Electron's Node ABI and cannot be
// required from plain node:test (same constraint as db-fts-contentless.test.js).
// We verify the bounding logic by inspecting db.js source text.
//
// Tests assert:
//   (a) Normal short queries still produce the double-quoted phrase form
//       (FTS5 substring matching preserved for e.g. "spec.md").
//   (b) Over-long queries are truncated via FTS_QUERY_MAX_CHARS so the phrase
//       cannot exceed ~46 trigrams (≤48-char input → ≤46 trigrams).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dbSrc = fs.readFileSync(path.join(root, 'db.js'), 'utf8');
const workerSrc = fs.readFileSync(path.join(root, 'workers', 'search-query.js'), 'utf8');

// The cap + MATCH construction live in fts-match.js, shared by both query
// paths — these tests exercise the REAL implementation, not a replica.
const { FTS_QUERY_MAX_CHARS, buildFtsMatch } = require('../fts-match');

// ---------------------------------------------------------------------------
// 1. FTS_QUERY_MAX_CHARS is a number ≤ 48
// ---------------------------------------------------------------------------

test('fts-match.js exports FTS_QUERY_MAX_CHARS ≤ 48 (keeps phrase query safe on main thread)', () => {
  assert.equal(typeof FTS_QUERY_MAX_CHARS, 'number');
  assert.ok(
    FTS_QUERY_MAX_CHARS <= 48,
    `FTS_QUERY_MAX_CHARS must be ≤48 to keep the trigram phrase safe; got ${FTS_QUERY_MAX_CHARS}`
  );
});

// ---------------------------------------------------------------------------
// 2. Both query paths use the shared builder (no drift possible)
// ---------------------------------------------------------------------------

test('db.js searchByType uses the shared buildFtsMatch from fts-match.js', () => {
  assert.match(dbSrc, /require\(['"]\.\/fts-match['"]\)/, 'db.js must require ./fts-match');
  const fnStart = dbSrc.indexOf('function searchByType(');
  assert.ok(fnStart !== -1, 'searchByType function not found in db.js');
  let depth = 0, fnEnd = -1;
  for (let i = fnStart; i < dbSrc.length; i++) {
    if (dbSrc[i] === '{') depth++;
    else if (dbSrc[i] === '}') { depth--; if (depth === 0) { fnEnd = i; break; } }
  }
  assert.ok(fnEnd !== -1, 'searchByType closing brace not found');
  const fnSrc = dbSrc.slice(fnStart, fnEnd + 1);
  assert.match(fnSrc, /buildFtsMatch\s*\(/, 'searchByType must call buildFtsMatch');
});

test('workers/search-query.js uses the shared buildFtsMatch from fts-match.js', () => {
  assert.match(workerSrc, /require\(['"]\.\.\/fts-match['"]\)/, 'worker must require ../fts-match');
  assert.match(workerSrc, /buildFtsMatch\s*\(/, 'worker must call buildFtsMatch');
});

// ---------------------------------------------------------------------------
// 3. The truncation happens BEFORE the double-quote escaping (not after)
//    — ensures a 48-char slice cannot be extended by " escaping within the cap
// ---------------------------------------------------------------------------

test('buildFtsMatch truncates before escaping: escaping may extend the phrase past the cap, slicing may not remove escapes', () => {
  // 100 double-quotes in: slice-then-escape keeps 48 of them and doubles each
  // (inner length 96). Escape-then-slice would cut back down to ≤48 — so an
  // inner length of 96 proves the order.
  const expr = buildFtsMatch('"'.repeat(100));
  const inner = expr.slice(1, -1);
  assert.equal(inner, '""'.repeat(FTS_QUERY_MAX_CHARS));
});

// ---------------------------------------------------------------------------
// 4. Behavior of the real builder
// ---------------------------------------------------------------------------

const buildMatchExpression = buildFtsMatch;

function trigramCount(phrase) {
  // Number of trigrams FTS5 must match for a phrase of this length.
  // A phrase of N chars produces max(0, N - 2) trigrams.
  return Math.max(0, phrase.length - 2);
}

test('replica: normal short query produces quoted-phrase expression unchanged', () => {
  const expr = buildMatchExpression('spec.md');
  assert.equal(expr, '"spec.md"', 'Short query must be double-quoted as-is');
});

test('replica: query containing a double-quote is escaped', () => {
  const expr = buildMatchExpression('say "hello"');
  assert.equal(expr, '"say ""hello"""', 'Double-quotes inside query must be doubled');
});

test('replica: 60-char URL is truncated to ≤ FTS_QUERY_MAX_CHARS before quoting', () => {
  const url = 'https://gitlab.example.com/product/example-project/-/merge_requests/25629';
  assert.ok(url.length > FTS_QUERY_MAX_CHARS, 'test URL must be longer than the cap');
  const expr = buildMatchExpression(url);
  // The phrase content (without surrounding quotes) must be ≤ cap
  const inner = expr.replace(/^"|"$/g, '');
  assert.ok(
    inner.length <= FTS_QUERY_MAX_CHARS,
    `Phrase length ${inner.length} must be ≤ FTS_QUERY_MAX_CHARS (${FTS_QUERY_MAX_CHARS})`
  );
});

test('replica: trigram count for bounded URL is ≤ 46 (phrase-intersect safe for main thread)', () => {
  const url = 'https://gitlab.example.com/product/example-project/-/merge_requests/25629';
  const expr = buildMatchExpression(url);
  const inner = expr.replace(/^"|"$/g, '');
  const ngrams = trigramCount(inner);
  assert.ok(
    ngrams <= 46,
    `Trigram count ${ngrams} must be ≤ 46 (FTS_QUERY_MAX_CHARS - 2) to be safe`
  );
});

test('replica: titleOnly mode prefixes "title:" before the quoted phrase', () => {
  const expr = buildMatchExpression('spec', true);
  assert.match(expr, /^title:"spec"$/, 'titleOnly must prefix title:');
});
