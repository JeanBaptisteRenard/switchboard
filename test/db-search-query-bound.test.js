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

// ---------------------------------------------------------------------------
// 1. FTS_QUERY_MAX_CHARS constant is defined and is a number ≤ 48
// ---------------------------------------------------------------------------

test('db.js defines FTS_QUERY_MAX_CHARS constant', () => {
  assert.match(
    dbSrc,
    /const FTS_QUERY_MAX_CHARS\s*=\s*\d+/,
    'db.js must define FTS_QUERY_MAX_CHARS'
  );
});

test('FTS_QUERY_MAX_CHARS is 48 or fewer (keeps phrase query safe on main thread)', () => {
  const m = dbSrc.match(/const FTS_QUERY_MAX_CHARS\s*=\s*(\d+)/);
  assert.ok(m, 'FTS_QUERY_MAX_CHARS definition not found');
  const cap = parseInt(m[1], 10);
  assert.ok(
    cap <= 48,
    `FTS_QUERY_MAX_CHARS must be ≤48 to keep the trigram phrase safe; got ${cap}`
  );
});

// ---------------------------------------------------------------------------
// 2. searchByType truncates the query to FTS_QUERY_MAX_CHARS before escaping
// ---------------------------------------------------------------------------

test('searchByType applies .slice(0, FTS_QUERY_MAX_CHARS) to the query before building the FTS MATCH expression', () => {
  // Extract the searchByType function source.
  const fnStart = dbSrc.indexOf('function searchByType(');
  assert.ok(fnStart !== -1, 'searchByType function not found in db.js');
  // Find the closing brace (depth-tracked).
  let depth = 0, fnEnd = -1;
  for (let i = fnStart; i < dbSrc.length; i++) {
    if (dbSrc[i] === '{') depth++;
    else if (dbSrc[i] === '}') { depth--; if (depth === 0) { fnEnd = i; break; } }
  }
  assert.ok(fnEnd !== -1, 'searchByType closing brace not found');
  const fnSrc = dbSrc.slice(fnStart, fnEnd + 1);

  assert.match(
    fnSrc,
    /\.slice\s*\(\s*0\s*,\s*FTS_QUERY_MAX_CHARS\s*\)/,
    'searchByType must call .slice(0, FTS_QUERY_MAX_CHARS) on the raw query'
  );
});

test('searchByType still wraps the (bounded) query in double-quotes (phrase matching preserved)', () => {
  const fnStart = dbSrc.indexOf('function searchByType(');
  assert.ok(fnStart !== -1, 'searchByType not found');
  let depth = 0, fnEnd = -1;
  for (let i = fnStart; i < dbSrc.length; i++) {
    if (dbSrc[i] === '{') depth++;
    else if (dbSrc[i] === '}') { depth--; if (depth === 0) { fnEnd = i; break; } }
  }
  const fnSrc = dbSrc.slice(fnStart, fnEnd + 1);

  // The double-quote wrapping: '"' + bounded + '"' or equivalent.
  // Accept any form that places literal '"' before and after the bounded var.
  assert.match(
    fnSrc,
    /'"'\s*\+\s*\w+|`".*\$\{.*\}.*"/,
    'searchByType must still wrap the query in double-quotes for FTS5 phrase matching'
  );
});

// ---------------------------------------------------------------------------
// 3. The truncation happens BEFORE the double-quote escaping (not after)
//    — ensures a 48-char slice cannot be extended by " escaping within the cap
// ---------------------------------------------------------------------------

test('searchByType: slice call appears before the quote-escape in function source', () => {
  const fnStart = dbSrc.indexOf('function searchByType(');
  assert.ok(fnStart !== -1);
  let depth = 0, fnEnd = -1;
  for (let i = fnStart; i < dbSrc.length; i++) {
    if (dbSrc[i] === '{') depth++;
    else if (dbSrc[i] === '}') { depth--; if (depth === 0) { fnEnd = i; break; } }
  }
  const fnSrc = dbSrc.slice(fnStart, fnEnd + 1);
  const slicePos = fnSrc.search(/\.slice\s*\(\s*0\s*,\s*FTS_QUERY_MAX_CHARS\s*\)/);
  const escapePos = fnSrc.search(/\.replace\s*\(\s*\/"/);
  assert.ok(slicePos !== -1, '.slice(0, FTS_QUERY_MAX_CHARS) not found');
  assert.ok(escapePos !== -1, '.replace(/"/…) not found');
  assert.ok(
    slicePos < escapePos,
    'Truncation (.slice) must occur before quote-escaping (.replace) in searchByType'
  );
});

// ---------------------------------------------------------------------------
// 4. Inline replica to validate the logic numerically
//    (mirrors what the real searchByType does, without requiring better-sqlite3)
// ---------------------------------------------------------------------------

const FTS_QUERY_MAX_CHARS = 48; // Must match the constant in db.js

function buildMatchExpression(query, titleOnly) {
  const bounded = query.slice(0, FTS_QUERY_MAX_CHARS);
  const escaped = '"' + bounded.replace(/"/g, '""') + '"';
  return titleOnly ? 'title:' + escaped : escaped;
}

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
  const url = 'https://gitlab.com/skaleet/product/tagpay/-/merge_requests/25629';
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
  const url = 'https://gitlab.com/skaleet/product/tagpay/-/merge_requests/25629';
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
