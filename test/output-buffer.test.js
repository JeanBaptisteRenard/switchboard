// Unit tests for appendToOutputBuffer() — the pure helper that manages the
// PTY output replay buffer in main.js.
//
// Design contract:
//   1. Total retained bytes (outputBufferSize) stays ≤ MAX_BUFFER_SIZE at all times.
//   2. After many small pushes the array length stays bounded (≤ COALESCE_THRESHOLD+1)
//      so per-slot GC pressure does not grow without bound.
//   3. The retained bytes are ALWAYS a tail-suffix of the full input stream — no
//      reordering, no byte corruption, no duplication.
//   4. Coalescing does not change the concatenated bytes vs un-coalesced version
//      (modulo the documented front-trim that keeps the buffer ≤ MAX_BUFFER_SIZE).
//   5. When a line-boundary-safe trim fires (single oversized chunk), the result
//      starts on a line boundary (no stray bytes before the first newline).

'use strict';

const test  = require('node:test');
const assert = require('node:assert/strict');
const { appendToOutputBuffer, COALESCE_THRESHOLD, MAX_BUFFER_SIZE } = require('../output-buffer');

const MAX = MAX_BUFFER_SIZE; // exported from output-buffer.js — single source of truth

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeState() {
  return { outputBuffer: [], outputBufferSize: 0 };
}

/** Generate `count` chunks of `size` bytes each (ASCII 'a'). */
function makeChunks(count, size) {
  return Array.from({ length: count }, () => 'a'.repeat(size));
}

/** Join every chunk in outputBuffer (the concatenated replay bytes). */
function joined(state) {
  return state.outputBuffer.join('');
}

// ---------------------------------------------------------------------------
// 1. Basic invariant: retained bytes ≤ MAX_BUFFER_SIZE
// ---------------------------------------------------------------------------

test('appendToOutputBuffer: retained bytes never exceed MAX_BUFFER_SIZE', () => {
  const state = makeState();
  const chunk = 'x'.repeat(1024); // 1 KB chunks
  for (let i = 0; i < 400; i++) {          // 400 KB total input
    appendToOutputBuffer(state, chunk, MAX);
  }
  assert.ok(
    state.outputBufferSize <= MAX,
    `expected ≤${MAX} bytes, got ${state.outputBufferSize}`,
  );
  assert.strictEqual(
    state.outputBufferSize,
    joined(state).length,
    'outputBufferSize must match actual joined length',
  );
});

// ---------------------------------------------------------------------------
// 2. Array length stays bounded after many small pushes
// ---------------------------------------------------------------------------

test('appendToOutputBuffer: array length stays bounded after many small pushes', () => {
  const state = makeState();
  for (let i = 0; i < 1000; i++) {
    appendToOutputBuffer(state, 'tiny', MAX);
  }
  // After coalescing, the array should hold at most COALESCE_THRESHOLD + 1
  // entries (one coalesced string + up to COALESCE_THRESHOLD new chunks).
  assert.ok(
    state.outputBuffer.length <= COALESCE_THRESHOLD + 1,
    `array length ${state.outputBuffer.length} exceeds COALESCE_THRESHOLD+1=${COALESCE_THRESHOLD + 1}`,
  );
});

// ---------------------------------------------------------------------------
// 3. Retained bytes are a tail-suffix of the input stream
// ---------------------------------------------------------------------------

test('appendToOutputBuffer: retained content is the tail of the input stream', () => {
  const state = makeState();
  const full = [];
  // Push enough data to trigger trim: (MAX / 512 + 10) chunks of 512 bytes
  const chunkSize = 512;
  const count = Math.floor(MAX / chunkSize) + 10;
  for (let i = 0; i < count; i++) {
    const ch = String.fromCharCode(65 + (i % 26)).repeat(chunkSize);
    full.push(ch);
    appendToOutputBuffer(state, ch, MAX);
  }
  const expected = full.join('').slice(-MAX);
  const actual   = joined(state);
  // Retained bytes should be the tail of the combined stream.
  assert.ok(
    expected.endsWith(actual),
    'retained content must be a suffix of the full input stream',
  );
  // Lower bound: retained history must be within one chunk of the budget.
  // This assertion catches the coalesce-after-trim bug: with the wrong step
  // order the coalesced spine can be atomically dropped on the next push,
  // leaving ~64 KB retained instead of ~256 KB.
  assert.ok(
    actual.length >= MAX - chunkSize,
    `retained ${actual.length} bytes is too low — expected ≥${MAX - chunkSize} (MAX − one chunk). ` +
    'Likely cause: coalesce firing after front-trim, building a large spine that gets shift()ed.',
  );
  assert.ok(actual.length <= MAX, `buffer ${actual.length} exceeds MAX ${MAX}`);
});

// ---------------------------------------------------------------------------
// 4. Coalesce does not corrupt bytes (pre-trim equality)
// ---------------------------------------------------------------------------

test('appendToOutputBuffer: coalescing does not change concatenated bytes (small input, no trim)', () => {
  const state = makeState();
  // 80 chunks of 10 bytes = 800 bytes — well under MAX, triggers one coalesce.
  const chunks = makeChunks(80, 10);
  const expected = chunks.join('');
  for (const ch of chunks) {
    appendToOutputBuffer(state, ch, MAX);
  }
  assert.strictEqual(joined(state), expected, 'coalesced bytes must equal original concatenation');
});

// ---------------------------------------------------------------------------
// 5. Line-boundary-safe trim: result starts on a line boundary
// ---------------------------------------------------------------------------

test('appendToOutputBuffer: single oversized chunk trim starts at a line boundary', () => {
  const state = makeState();
  // Trigger the single-entry overflow trim by pushing ONE chunk that is
  // 1.2× MAX in size.  Step 1 (whole-entry front-trim) leaves it alone
  // because length === 1.  Step 3 (single-entry overflow) must fire.
  //
  // Layout:  preamble (0.3×MAX bytes of 'a') + '\n' + suffix (0.9×MAX bytes of 'b')
  // Total = 1.2×MAX > MAX → trim fires.
  // After slicing to the last MAX bytes and advancing past the first '\n',
  // the buffer should start with 'b'.
  const preambleSize = Math.floor(MAX * 0.3);
  const suffixSize   = Math.floor(MAX * 0.9);
  const big = 'a'.repeat(preambleSize) + '\n' + 'b'.repeat(suffixSize);
  appendToOutputBuffer(state, big, MAX);

  const buf = joined(state);
  assert.ok(buf.length <= MAX, `buffer ${buf.length} > MAX ${MAX}`);
  // The single-entry trim keeps the LAST MAX bytes, then advances past the
  // first '\n'.  The 'a'-preamble and the '\n' fall off; only 'b's remain.
  assert.strictEqual(buf[0], 'b',
    `buffer should start at line boundary char, got ${JSON.stringify(buf.slice(0, 10))}`);
  // Every character must be 'b' (no 'a' stray bytes from before the newline).
  assert.ok(buf.split('').every(c => c === 'b'), 'no stray preamble bytes after trim');
});

// ---------------------------------------------------------------------------
// 6. outputBufferSize tracks actual byte count at every step
// ---------------------------------------------------------------------------

test('appendToOutputBuffer: outputBufferSize always matches actual joined length', () => {
  const state = makeState();
  const chunks = makeChunks(200, 256); // 200×256 = 50 KB, well under MAX
  for (const ch of chunks) {
    appendToOutputBuffer(state, ch, MAX);
    assert.strictEqual(
      state.outputBufferSize,
      joined(state).length,
      'size accounting drifts after a push',
    );
  }
});

// ---------------------------------------------------------------------------
// 7. Single-chunk identical to direct push (empty initial state, no trim)
// ---------------------------------------------------------------------------

test('appendToOutputBuffer: single chunk under MAX is stored as-is', () => {
  const state = makeState();
  appendToOutputBuffer(state, 'hello', MAX);
  assert.deepStrictEqual(state.outputBuffer, ['hello']);
  assert.strictEqual(state.outputBufferSize, 5);
});

// ---------------------------------------------------------------------------
// 8. Empty data is a no-op
// ---------------------------------------------------------------------------

test('appendToOutputBuffer: empty string push is ignored', () => {
  const state = makeState();
  appendToOutputBuffer(state, '', MAX);
  assert.strictEqual(state.outputBuffer.length, 0);
  assert.strictEqual(state.outputBufferSize, 0);
});

// ---------------------------------------------------------------------------
// 9. Multiple small pushes followed by a large one: no content reordering
// ---------------------------------------------------------------------------

test('appendToOutputBuffer: large chunk after many smalls appends in order', () => {
  const state = makeState();
  for (let i = 0; i < 70; i++) appendToOutputBuffer(state, `chunk${i}|`, MAX);
  appendToOutputBuffer(state, 'LAST', MAX);
  const buf = joined(state);
  assert.ok(buf.endsWith('LAST'), 'last chunk must be at the end');
});

// ---------------------------------------------------------------------------
// 10. max-1 spine tip-over: small chunk on a freshly nl-trimmed spine must
//     coalesce, not atomically shift the spine. Regression for the WARNING in
//     PR #75 re-review: step 3's nl=0 path leaves a spine of exactly MAX-1
//     bytes, which slipped under a `spine.length >= MAX` coalesce guard, so the
//     next small push let step 2 shift() the whole MAX-1 spine (history loss).
// ---------------------------------------------------------------------------

test('appendToOutputBuffer: small chunk on a MAX-1 spine keeps full history', () => {
  const state = makeState();
  // Build a spine of exactly MAX-1 bytes via the nl=0 step-3 path:
  // 'a'*k + '\n' + 'b'*(MAX-1).  Last MAX chars = '\n' + 'b'*(MAX-1) (nl at 0),
  // advancing past the '\n' yields 'b'*(MAX-1).
  const big = 'a'.repeat(10) + '\n' + 'b'.repeat(MAX - 1);
  appendToOutputBuffer(state, big, MAX);
  assert.strictEqual(state.outputBufferSize, MAX - 1, 'spine should be exactly MAX-1 bytes');

  // Now tip over MAX with a small chunk.  On the buggy guarded code this
  // shifts the entire MAX-1 spine (retained drops to chunkSize); on the fix
  // it coalesces then byte-slices, retaining ~MAX.
  const chunkSize = 2048;
  appendToOutputBuffer(state, 'c'.repeat(chunkSize), MAX);

  assert.ok(state.outputBufferSize <= MAX, `buffer ${state.outputBufferSize} > MAX ${MAX}`);
  assert.ok(
    state.outputBufferSize >= MAX - chunkSize,
    `retained ${state.outputBufferSize} bytes is too low — expected ≥${MAX - chunkSize}. ` +
    'Likely cause: MAX-1 spine shifted whole instead of coalesced+byte-sliced.',
  );
  // The newest bytes ('c') must survive at the tail.
  assert.ok(joined(state).endsWith('c'.repeat(chunkSize)), 'newest chunk must remain at the tail');
});
