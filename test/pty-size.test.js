// Unit tests for pty-size.js — normalisation of the renderer-supplied spawn
// geometry that replaced the hard-coded 120x30 in main.js's open-terminal.

const test = require('node:test');
const assert = require('node:assert');
const { normalizePtySize, DEFAULT_COLS, DEFAULT_ROWS, MAX_COLS, MAX_ROWS } = require('../pty-size');

test('a measured size passes through unchanged', () => {
  assert.deepStrictEqual(normalizePtySize({ cols: 213, rows: 57 }), { cols: 213, rows: 57 });
});

test('missing size falls back to the historical 120x30 defaults', () => {
  for (const bad of [undefined, null, 0, '', 'nope', 42]) {
    assert.deepStrictEqual(
      normalizePtySize(bad),
      { cols: DEFAULT_COLS, rows: DEFAULT_ROWS },
      `fallback for ${JSON.stringify(bad)}`,
    );
  }
});

test('each axis falls back independently', () => {
  assert.deepStrictEqual(normalizePtySize({ cols: 200 }), { cols: 200, rows: DEFAULT_ROWS });
  assert.deepStrictEqual(normalizePtySize({ rows: 50 }), { cols: DEFAULT_COLS, rows: 50 });
});

test('non-finite and non-numeric values fall back instead of reaching node-pty', () => {
  assert.deepStrictEqual(
    normalizePtySize({ cols: NaN, rows: Infinity }),
    { cols: DEFAULT_COLS, rows: DEFAULT_ROWS },
  );
  assert.deepStrictEqual(
    normalizePtySize({ cols: {}, rows: [] }),
    { cols: DEFAULT_COLS, rows: DEFAULT_ROWS },
  );
});

test('fractional dimensions are floored, not rounded up', () => {
  // A half-visible column must never be reported to the shell as whole:
  // over-reporting the width is exactly the double-wrap that this fix closes.
  assert.deepStrictEqual(normalizePtySize({ cols: 120.9, rows: 30.9 }), { cols: 120, rows: 30 });
});

test('out-of-range values fall back rather than clamp silently', () => {
  assert.deepStrictEqual(normalizePtySize({ cols: 1, rows: 10 }), { cols: DEFAULT_COLS, rows: 10 });
  assert.deepStrictEqual(normalizePtySize({ cols: 100, rows: 0 }), { cols: 100, rows: DEFAULT_ROWS });
  assert.deepStrictEqual(normalizePtySize({ cols: -5, rows: -5 }), { cols: DEFAULT_COLS, rows: DEFAULT_ROWS });
  assert.deepStrictEqual(
    normalizePtySize({ cols: MAX_COLS + 1, rows: MAX_ROWS + 1 }),
    { cols: DEFAULT_COLS, rows: DEFAULT_ROWS },
  );
});

test('the boundary values themselves are accepted', () => {
  assert.deepStrictEqual(normalizePtySize({ cols: 2, rows: 1 }), { cols: 2, rows: 1 });
  assert.deepStrictEqual(
    normalizePtySize({ cols: MAX_COLS, rows: MAX_ROWS }),
    { cols: MAX_COLS, rows: MAX_ROWS },
  );
});
