/**
 * BT2 — Golden-output characterization tests for readSessionFile and
 * readSessionDisplayHeader. These tests pin the full output contract against a
 * checked-in synthetic fixture so a perf refactor must produce identical output
 * to stay green.
 *
 * Fixture: test/fixtures/golden-session.jsonl
 *   - 2 user turns + 2 assistant turns (messageCount = 4)
 *   - slug = "golden-slug-abc123"
 *   - model = "claude-opus-4-5"
 *   - inputTokens = 20 + 30 = 50
 *   - outputTokens = 10 + 15 = 25
 *   - cacheReadTokens = 5 + 3 = 8
 *   - summary = first user message text
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { readSessionFile, readSessionDisplayHeader } = require('../read-session-file');

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'golden-session.jsonl');

test('readSessionFile: golden output matches fixture — full shape', () => {
  const stat = fs.statSync(FIXTURE_PATH);
  const row = readSessionFile(FIXTURE_PATH, 'test-folder', '/some/project');

  assert.ok(row, 'readSessionFile must return a non-null row for a valid fixture');

  // sessionId derived from filename (basename without .jsonl)
  assert.equal(row.sessionId, 'golden-session');
  assert.equal(row.folder, 'test-folder');
  assert.equal(row.projectPath, '/some/project');

  // summary = first real user message (not tool_result, not bash command)
  assert.equal(row.summary, 'What is the capital of France?');

  // messageCount: user + assistant + user + assistant = 4
  assert.equal(row.messageCount, 4);

  // slug from JSONL content
  assert.equal(row.slug, 'golden-slug-abc123');

  // modified = stat.mtime.toISOString()
  assert.equal(row.modified, stat.mtime.toISOString());

  // dailyMetrics: all 4 messages share the same date (2024-03-15)
  // The 2 assistant turns are on claude-opus-4-5; the 2 user turns bucket under ''
  assert.ok(Array.isArray(row.dailyMetrics), 'dailyMetrics must be an array');

  const assistantMetric = row.dailyMetrics.find(m => m.model === 'claude-opus-4-5');
  assert.ok(assistantMetric, 'expected a metric row for claude-opus-4-5');
  assert.equal(assistantMetric.date, '2024-03-15');
  assert.equal(assistantMetric.inputTokens, 50,  'inputTokens: 20 + 30');
  assert.equal(assistantMetric.outputTokens, 25, 'outputTokens: 10 + 15');
  assert.equal(assistantMetric.cacheReadTokens, 8, 'cacheReadTokens: 5 + 3');
  assert.equal(assistantMetric.messageCount, 2, 'two assistant messages');
});

test('readSessionFile: partial-write — truncated last line is skipped, rest parses fine', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-golden-partial-'));
  try {
    const filePath = path.join(tmp, 'partial.jsonl');
    // Valid line + truncated line (missing closing brace)
    const content =
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello partial' } }) + '\n' +
      '{"type":"assistant","message":{"role":"assistant","model":"claude-opus-4-5","content":[{"type":"text","text":"hi"}';
    // Intentionally NOT closing the JSON — simulates mid-write truncation
    fs.writeFileSync(filePath, content, 'utf8');

    const row = readSessionFile(filePath, 'folder', '/proj');
    assert.ok(row, 'must return a row even with a truncated last line');
    assert.equal(row.summary, 'hello partial');
    // Only the complete line counts toward messageCount (the assistant line is truncated)
    assert.equal(row.messageCount, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('readSessionDisplayHeader: parity with readSessionFile on summary / slug / agentId for golden fixture', () => {
  const full = readSessionFile(FIXTURE_PATH, 'folder', '/proj');
  const header = readSessionDisplayHeader(FIXTURE_PATH);

  assert.ok(full, 'readSessionFile must succeed');
  assert.ok(header, 'readSessionDisplayHeader must succeed');

  // Fields the header path is required to return correctly
  assert.equal(header.summary, full.summary,
    'summary must match between full and header read');
  assert.equal(header.slug, full.slug,
    'slug must match between full and header read');
  assert.equal(header.sessionId, full.sessionId,
    'sessionId (from filename) must match');
  // modified: both derive from stat.mtime — should be identical
  assert.equal(header.modified, full.modified,
    'modified timestamp must match');
});
