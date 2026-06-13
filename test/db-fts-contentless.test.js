const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Static-analysis tests (native-module-free) — verify db.js source text for
// the contentless FTS5 schema, body truncation, and migration wiring.
// better-sqlite3 is compiled against Electron's Node ABI and cannot be
// required from plain node:test (same constraint as db-daily-activity.test.js).
// ---------------------------------------------------------------------------

const root = path.join(__dirname, '..');

function readSrc(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

const dbSrc = readSrc('db.js');

// ---------------------------------------------------------------------------
// 1. Schema: external-content FTS5 table
// ---------------------------------------------------------------------------

test('search_fts uses content= pointing to search_content table', () => {
  // Must contain content='search_content' (or content="search_content")
  assert.match(
    dbSrc,
    /content\s*=\s*['"]search_content['"]/,
    'search_fts DDL must reference search_content as its external content table'
  );
});

test('search_content table is created with title and body columns', () => {
  assert.match(
    dbSrc,
    /CREATE TABLE IF NOT EXISTS search_content/,
    'search_content table must be defined in db.js'
  );
  // Must have a body column
  const contentTableMatch = dbSrc.match(
    /CREATE TABLE IF NOT EXISTS search_content[\s\S]*?\)/
  );
  assert.ok(contentTableMatch, 'search_content CREATE TABLE not found');
  assert.match(contentTableMatch[0], /body/, 'search_content must have a body column');
  assert.match(contentTableMatch[0], /title/, 'search_content must have a title column');
});

test('search_fts DDL no longer stores its own content (no bare fts5 without content=)', () => {
  // Find the search_fts USING fts5( ... ) block
  const ftsMatch = dbSrc.match(/USING fts5\s*\([\s\S]*?\)/);
  assert.ok(ftsMatch, 'search_fts USING fts5(...) block not found');
  // Must contain content= — proves it is NOT a plain content-storing table
  assert.match(
    ftsMatch[0],
    /content\s*=/,
    'fts5 options must include content= (external or contentless)'
  );
});

// ---------------------------------------------------------------------------
// 2. Body truncation constant
// ---------------------------------------------------------------------------

test('db.js defines a body truncation cap (FTS_BODY_MAX_CHARS or similar)', () => {
  // We expect a constant like: const FTS_BODY_MAX_CHARS = N
  // Accept any reasonable name as long as a truncation cap is applied on body
  assert.match(
    dbSrc,
    /FTS_BODY_MAX/,
    'db.js must define an FTS body truncation cap constant'
  );
});

test('body is truncated before insertion into search_content', () => {
  // The insert into search_content (or insert into search_fts) must use
  // a slice/substr call or the truncation constant on the body argument.
  // We look for .slice(0, applied near the searchInsertContent or searchInsertFts stmt.
  assert.match(
    dbSrc,
    /\.slice\s*\(\s*0\s*,\s*FTS_BODY_MAX/,
    'body must be sliced to FTS_BODY_MAX_CHARS before insertion'
  );
});

// ---------------------------------------------------------------------------
// 3. Migration: v6 drops old search_fts + search_content, recreates both,
//    sets searchFtsRecreated = true
// ---------------------------------------------------------------------------

test('migrations array contains a v6 entry that drops and recreates search_fts', () => {
  // v6 migration must drop the old table and set searchFtsRecreated
  assert.match(
    dbSrc,
    /DROP TABLE IF EXISTS search_fts/,
    'db.js must DROP search_fts in a migration'
  );
  assert.match(
    dbSrc,
    /DROP TABLE IF EXISTS search_content/,
    'db.js must DROP search_content in a migration (clean slate for existing installs)'
  );
});

test('searchFtsRecreated is set to true in the v6 migration', () => {
  // The migration that drops search_fts must also set the flag so
  // main.js triggers a full repopulate.
  // Count occurrences: one in v2 (existing), one in v6 (new).
  const matches = dbSrc.match(/searchFtsRecreated\s*=\s*true/g);
  assert.ok(matches && matches.length >= 2, 'searchFtsRecreated = true should appear at least twice (v2 + v6 migrations)');
});

// ---------------------------------------------------------------------------
// 4. v6 migration includes a VACUUM step to reclaim freed freelist pages
// ---------------------------------------------------------------------------

test('v6 migration includes a VACUUM call to reclaim freed pages', () => {
  // The DROP TABLE calls in v6 free ~152 MB of pages into the freelist.
  // Without VACUUM SQLite keeps the file at its old size ("stopped growing"
  // not "shrank"). Empirically: 225 MB → 37.9 MB in ~0.5 s on a real DB.
  // VACUUM cannot run inside a SQLite transaction; the migrations loop is
  // not wrapped in a transaction, so placing it inside the v6 function body
  // (after the DROPs) is legal.

  // Locate the v6 migration function body: the block that contains both
  // DROP TABLE IF EXISTS search_fts AND searchFtsRecreated = true (distinguishes
  // v6 from v2, which only drops search_fts but not search_content).
  const v6Start = dbSrc.indexOf("DROP TABLE IF EXISTS search_content");
  assert.ok(v6Start !== -1, 'v6 migration DROP TABLE IF EXISTS search_content not found');

  // Extract from the DROP TABLE search_content up to the next migrations-array
  // closing paren, approximately 600 chars — enough to cover the v6 function body.
  const v6Slice = dbSrc.slice(v6Start, v6Start + 600);

  assert.match(
    v6Slice,
    /VACUUM/,
    'v6 migration must call VACUUM after the DROP TABLEs to reclaim freed freelist pages'
  );
});

test('v6 VACUUM is placed inside the migration function body (not outside migrations[])', () => {
  // We verify that the actual db.exec('VACUUM') call appears AFTER the
  // DROP TABLE search_content call (which uniquely identifies v6) and BEFORE
  // the migrations loop runner. This ensures VACUUM is inside the per-migration
  // function, not added as a post-loop global (which would run on every startup).
  // We look for the exec call specifically to skip any VACUUM mentions in comments.
  const v6Drop = dbSrc.indexOf("DROP TABLE IF EXISTS search_content");
  assert.ok(v6Drop !== -1, 'DROP TABLE IF EXISTS search_content not found (v6 marker)');

  // Find the actual try { db.exec('VACUUM') } call in code (not comments).
  // We use the try-wrapped form which only appears in code, not in inline comments.
  const vacuumCall = dbSrc.indexOf("try { db.exec('VACUUM')");
  assert.ok(vacuumCall !== -1, "try { db.exec('VACUUM') } call not found in db.js");

  // The exec call must come after the v6 DROP TABLE
  assert.ok(
    vacuumCall > v6Drop,
    "try { db.exec('VACUUM') } must appear after the v6 DROP TABLE IF EXISTS search_content"
  );

  // The exec call must appear before the migrations loop runner (the for loop
  // that executes migrations) — i.e., inside the migrations array literal
  const migrationsLoopMarker = 'for (let i = currentDbVersion';
  const loopPos = dbSrc.indexOf(migrationsLoopMarker);
  assert.ok(loopPos !== -1, 'migrations loop not found');
  assert.ok(
    vacuumCall < loopPos,
    "try { db.exec('VACUUM') } must be inside the migrations[] array (before the loop that runs them), not after"
  );
});

// ---------------------------------------------------------------------------
// 5. Delete statements keep search_content in sync
// ---------------------------------------------------------------------------

test('searchDeleteBySession also cleans search_content rows', () => {
  // Expect a prepared statement or inline DELETE targeting search_content
  // keyed by session rowid
  assert.match(
    dbSrc,
    /DELETE FROM search_content WHERE rowid IN[\s\S]*?search_map[\s\S]*?session/,
    'delete-by-session must purge search_content rows'
  );
});

test('searchDeleteByFolder also cleans search_content rows', () => {
  assert.match(
    dbSrc,
    /DELETE FROM search_content WHERE rowid IN[\s\S]*?search_map[\s\S]*?folder/,
    'delete-by-folder must purge search_content rows'
  );
});

test('searchDeleteByType also cleans search_content rows', () => {
  assert.match(
    dbSrc,
    /DELETE FROM search_content WHERE rowid IN[\s\S]*?search_map[\s\S]*?type/,
    'delete-by-type must purge search_content rows'
  );
});

// ---------------------------------------------------------------------------
// 5. searchUpdateTitle updates search_content, not search_fts directly
//    (external-content tables are read-only via the FTS shadow tables;
//     the content table is the authoritative store for the columns)
// ---------------------------------------------------------------------------

test('searchUpdateTitle targets search_content (not search_fts) for title update', () => {
  // The UPDATE stmt for title should touch search_content, not search_fts
  // (updating search_fts directly on an external-content table is not how it works)
  assert.match(
    dbSrc,
    /UPDATE search_content SET title/,
    'searchUpdateTitle must UPDATE search_content.title (not search_fts)'
  );
});

// ---------------------------------------------------------------------------
// 6. searchQuery snippet() call still works (column index 1 = body column)
// ---------------------------------------------------------------------------

test('searchQuery uses snippet(search_fts, 1, ...) to extract body preview', () => {
  assert.match(
    dbSrc,
    /snippet\s*\(\s*search_fts\s*,\s*1\s*,/,
    'searchQuery must call snippet(search_fts, 1, ...) for the body column'
  );
});

// ---------------------------------------------------------------------------
// 7. Insertion writes to search_content THEN search_fts (external-content
//    protocol: content row must exist before the FTS shadow-row insert)
// ---------------------------------------------------------------------------

test('upsertSearchEntriesBatch inserts into search_content before search_fts', () => {
  // Find the upsertSearchEntriesBatch transaction body.
  // Use 2000 chars to cover the full body including the truncation comment.
  const txStart = dbSrc.indexOf('upsertSearchEntriesBatch');
  assert.ok(txStart !== -1, 'upsertSearchEntriesBatch not found');
  const txSlice = dbSrc.slice(txStart, txStart + 2000);
  const contentPos = txSlice.indexOf('searchInsertContent');
  const ftsPos = txSlice.indexOf('searchInsertFts');
  assert.ok(contentPos !== -1, 'searchInsertContent call not found in upsertSearchEntriesBatch');
  assert.ok(ftsPos !== -1, 'searchInsertFts call not found in upsertSearchEntriesBatch');
  assert.ok(
    contentPos < ftsPos,
    'search_content row must be inserted before search_fts row (external-content protocol)'
  );
});

// ---------------------------------------------------------------------------
// 8. Delete functions issue the FTS5 delete BEFORE the search_content delete
//    (external-content protocol: SQLite reads content rows to remove trigram
//     entries from the shadow tables; if content is deleted first, ghost
//     trigrams accumulate and the DB silently re-inflates on every delete).
//    Static assertion: verify statement call order in each function body.
// ---------------------------------------------------------------------------

/**
 * Extract the source text of a top-level named function from src.
 * Scans from the `function <name>` declaration to the matching closing brace.
 */
function extractFunctionSrc(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) return null;
  let depth = 0;
  let i = start;
  while (i < src.length) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
    i++;
  }
  return null;
}

test('deleteSearchSession: FTS delete issued before search_content delete', () => {
  const fnSrc = extractFunctionSrc(dbSrc, 'deleteSearchSession');
  assert.ok(fnSrc, 'deleteSearchSession not found in db.js');
  const ftsDel = fnSrc.indexOf('searchDeleteBySession');
  const contentDel = fnSrc.indexOf('searchDeleteContentBySession');
  assert.ok(ftsDel !== -1, 'searchDeleteBySession call not found');
  assert.ok(contentDel !== -1, 'searchDeleteContentBySession call not found');
  assert.ok(
    ftsDel < contentDel,
    'deleteSearchSession must delete from search_fts (searchDeleteBySession) BEFORE search_content ' +
    '(external-content FTS5 protocol — ghost trigrams accumulate if order is reversed)'
  );
});

test('deleteSearchFolder: FTS delete issued before search_content delete', () => {
  const fnSrc = extractFunctionSrc(dbSrc, 'deleteSearchFolder');
  assert.ok(fnSrc, 'deleteSearchFolder not found in db.js');
  const ftsDel = fnSrc.indexOf('searchDeleteByFolder');
  const contentDel = fnSrc.indexOf('searchDeleteContentByFolder');
  assert.ok(ftsDel !== -1, 'searchDeleteByFolder call not found');
  assert.ok(contentDel !== -1, 'searchDeleteContentByFolder call not found');
  assert.ok(
    ftsDel < contentDel,
    'deleteSearchFolder must delete from search_fts (searchDeleteByFolder) BEFORE search_content ' +
    '(external-content FTS5 protocol — ghost trigrams accumulate if order is reversed)'
  );
});

test('deleteSearchType: FTS delete issued before search_content delete', () => {
  const fnSrc = extractFunctionSrc(dbSrc, 'deleteSearchType');
  assert.ok(fnSrc, 'deleteSearchType not found in db.js');
  const ftsDel = fnSrc.indexOf('searchDeleteByType');
  const contentDel = fnSrc.indexOf('searchDeleteContentByType');
  assert.ok(ftsDel !== -1, 'searchDeleteByType call not found');
  assert.ok(contentDel !== -1, 'searchDeleteContentByType call not found');
  assert.ok(
    ftsDel < contentDel,
    'deleteSearchType must delete from search_fts (searchDeleteByType) BEFORE search_content ' +
    '(external-content FTS5 protocol — ghost trigrams accumulate if order is reversed)'
  );
});

// ---------------------------------------------------------------------------
// 9. main-ctx-db-wiring compatibility: db.js still exports the same set of
//    public FTS functions (no renames that would break main.js callers)
// ---------------------------------------------------------------------------

test('db.js module.exports still includes all required FTS function names', () => {
  const exportsSrc = dbSrc.split('module.exports')[1] || '';
  for (const name of [
    'upsertSearchEntries',
    'updateSearchTitle',
    'deleteSearchSession',
    'deleteSearchFolder',
    'deleteSearchType',
    'searchByType',
    'isSearchIndexPopulated',
    'searchFtsRecreated',
  ]) {
    assert.match(
      exportsSrc,
      new RegExp(`\\b${name}\\b`),
      `db.js module.exports must include ${name}`
    );
  }
});
