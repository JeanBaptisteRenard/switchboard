// test/composer-state.test.js — node:test suite for composer-state.js
//
// The table below is the whole contract: a sequence of PTY input bytes in,
// a pending-byte count out. See docs/automation.md for what each rule protects.
'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

const {
  createComposerState,
  noteUserInput,
  isComposerEmpty,
} = require('../composer-state');

/** Feed every chunk in order into a fresh state and return it. */
function feed(chunks, now = 1000) {
  const state = createComposerState();
  for (const chunk of chunks) noteUserInput(state, chunk, now);
  return state;
}

const CASES = [
  // [name, chunks, expected pending]
  ['plain text counts one per printable byte',        ['hello'],                  5],
  ['Enter clears the counter',                        ['hello\r'],                0],
  ['newline clears the counter',                      ['hello\n'],                0],
  ['DEL removes one byte',                            ['hello\x7f'],              4],
  ['BS removes one byte',                             ['hello\b'],                4],
  ['backspace floors at zero',                        ['\x7f\x7f'],               0],
  ['Ctrl+U clears the composer',                      ['hello\x15'],              0],
  ['Ctrl+C clears the composer',                      ['hello\x03'],              0],
  ['Ctrl+V image paste counts as one',                ['\x16'],                   1],
  ['CSI up arrow recalls history, so it fills',       ['\x1b[A'],                 1],
  ['SS3 up arrow recalls history, so it fills',       ['\x1bOA'],                 1],
  ['Shift+Enter inserts a line break in the box',     ['\x1b[13;2u'],             1],
  ['Ctrl+Enter inserts a line break in the box',      ['\x1b[13;5u'],             1],
  ['CSI right arrow leaves the counter alone',        ['\x1b[C'],                 0],
  ['CSI right arrow between letters is transparent',  ['ab\x1b[Ccd'],             4],
  ['Escape alone leaves the counter alone',           ['\x1b'],                   0],
  ['ESC + byte (alt-b) leaves the counter alone',     ['\x1bb'],                  0],
  ['OSC leaves the counter alone',                    ['\x1b]0;a title\x07'],     0],
  ['other C0 control leaves the counter alone',       ['\x01'],                   0],
  [
    'bracketed paste counts every byte and its CR does NOT clear',
    ['\x1b[200~line one\rline two\x1b[201~'],
    17,
  ],
  [
    'text typed after a paste keeps accumulating',
    ['\x1b[200~ab\x1b[201~cd'],
    4,
  ],
  [
    'Enter after a closed paste still clears',
    ['\x1b[200~ab\x1b[201~\r'],
    0,
  ],
  [
    'an escape sequence split across chunks is not counted as printables',
    ['ab\x1b[', 'C'],
    2,
  ],
  [
    'an up arrow split across chunks still counts once',
    ['\x1b', '[A'],
    1,
  ],
  [
    'a paste terminator split across chunks still ends the paste',
    ['\x1b[200~abc\x1b[', '201~', 'd\r'],
    0,
  ],
  [
    'a paste opener split across chunks still opens the paste',
    ['\x1b[200', '~ab\rcd\x1b[201~'],
    5,
  ],
  // A lone Escape is held in the partial buffer. The chunk that follows it may
  // itself start with ESC — a bracketed paste does — and the two must not be
  // eaten as one Alt+ESC, or the paste opener is missed and the CRs inside the
  // paste clear the composer.
  [
    'an Escape followed by a paste does not swallow the paste opener',
    ['\x1b', '\x1b[200~ab\r\ncd\x1b[201~'],
    6,
  ],
  // Kitty Enter without a modifier is a submission, not a line break.
  ['bare kitty Enter fills nothing',                   ['\x1b[13u'],               0],
  // Editing keys the scalar counter could not model.
  ['Ctrl+W erases the word it erases on screen',       ['hello world\x17\x17'],    0],
  ['Ctrl+A then Ctrl+K empties the box',               ['hello\x01\x0b'],          0],
  ['Ctrl+K only kills from the cursor on',             ['hello\x1b[D\x1b[D\x0b'],  3],
  ['Alt+Backspace erases the word before the cursor',  ['hello\x1b\x7f'],          0],
  ['Home then Delete twice empties the box',           ['ab\x1b[H\x1b[3~\x1b[3~'], 0],
  ['End moves back to the tail',                       ['ab\x1b[H\x1b[Fc'],        3],
  ['Ctrl+Left is a word motion, not a character one',  ['foo bar\x1b[1;5D\x17'],   3],
  ['an astral character weighs one backspace',         ['😀\x7f'],       0],
  ['an astral character weighs one code point',        ['a😀b'],         3],
];

for (const [name, chunks, expected] of CASES) {
  test(`composer-state: ${name}`, () => {
    const state = feed(chunks);
    assert.equal(
      state.pending,
      expected,
      `pending after ${JSON.stringify(chunks)} should be ${expected}`,
    );
  });
}

test('composer-state: a fresh state is empty and has no input timestamp', () => {
  const state = createComposerState();
  assert.equal(state.pending, 0);
  assert.equal(state.lastInputAt, 0);
  assert.equal(state.inPaste, false);
  assert.equal(state.partial, '');
  assert.equal(isComposerEmpty(state), true);
});

test('composer-state: isComposerEmpty tracks the counter', () => {
  const state = createComposerState();
  noteUserInput(state, 'a', 1000);
  assert.equal(isComposerEmpty(state), false);
  noteUserInput(state, '\r', 1001);
  assert.equal(isComposerEmpty(state), true);
});

// ── Terminal reports ─────────────────────────────────────────────────────────
// Regression cover for the 2026-09-02 measurement: a resting pointer over a
// mouse-tracking session pushed the quiet clock and got a trigger refused.
// See docs/automation.md ("Politeness") for the numbers.

const SGR_PRESS   = '\x1b[<0;42;13M';
const SGR_RELEASE = '\x1b[<0;42;13m';
const SGR_MOVE    = '\x1b[<35;120;40M';
const FOCUS_IN    = '\x1b[I';
const FOCUS_OUT   = '\x1b[O';

/** Feed `chunks` on top of a composer holding "hi", asserting nothing moved. */
function assertInert(chunks) {
  const state = createComposerState();
  noteUserInput(state, 'hi', 1000);
  assert.equal(state.pending, 2);
  let t = 2000;
  for (const chunk of chunks) noteUserInput(state, chunk, (t += 1000));
  assert.equal(state.pending, 2, `${JSON.stringify(chunks)} must not touch the text`);
  assert.equal(state.lastInputAt, 1000, `${JSON.stringify(chunks)} must not push the clock`);
  assert.equal(state.partial, '', 'nothing should be left buffered');
  return state;
}

test('composer-state: an SGR mouse report is neither text nor activity', () => {
  assertInert([SGR_MOVE]);
  assertInert([SGR_PRESS, SGR_RELEASE]);
  // A whole flick of the wrist in one chunk is still silence.
  assertInert([SGR_MOVE.repeat(12)]);
});

test('composer-state: a focus report is neither text nor activity', () => {
  assertInert([FOCUS_IN]);
  assertInert([FOCUS_OUT]);
  assertInert([FOCUS_OUT, FOCUS_IN]);
});

test('composer-state: a chunk mixing a report and a keystroke counts the keystroke', () => {
  const state = createComposerState();
  noteUserInput(state, 'hi', 1000);
  noteUserInput(state, SGR_MOVE + 'x', 5000);
  assert.equal(state.pending, 3, 'the keystroke lands in the composer');
  assert.equal(state.lastInputAt, 5000, 'and pushes the quiet clock');

  const trailing = createComposerState();
  noteUserInput(trailing, 'a' + FOCUS_IN, 6000);
  assert.equal(trailing.pending, 1);
  assert.equal(trailing.lastInputAt, 6000);
});

test('composer-state: a report split across chunks is never counted as text', () => {
  // The head is buffered, the tail completes it, and no byte reaches the box.
  const sgr = createComposerState();
  noteUserInput(sgr, '\x1b[<35;120', 1000);
  assert.equal(sgr.pending, 0, 'a half report is held back, not typed');
  assert.equal(sgr.partial, '\x1b[<35;120');
  noteUserInput(sgr, ';40M', 2000);
  assert.equal(sgr.pending, 0, 'the completed report adds nothing');
  assert.equal(sgr.partial, '');
  assert.equal(sgr.lastInputAt, 1000, 'the completing chunk is silence');
});

test('composer-state: an unrecognised sequence still counts as input', () => {
  // The safety principle: only sequences actually recognised as reports are
  // exempt. A near-miss must resolve towards busy, never towards free — a false
  // "idle" is what lets a trigger type over the user's sentence.
  const cases = [
    ['\x1b[<0;42M',     'an SGR report short of a parameter'],
    ['\x1b[<0;42;13;9M', 'an SGR report with a parameter too many'],
    ['\x1b[5M',          'CSI 5 M — delete lines, not a mouse report'],
    ['\x1b[<a;b;cM',     'non-numeric SGR parameters'],
    ['\x1b[2I',          'a parameterised CSI I'],
    ['\x1b[1;2O',        'a modified CSI O'],
    ['\x1bOM',           'SS3 M, not CSI M'],
    ['\x1b[<0;42;13X',   'the right shape with the wrong final byte'],
    // Empty numeric fields: the near-miss a `\d*` mutant would let through
    // silently, since `*` accepts zero digits where `{1,10}` requires one.
    ['\x1b[<;42;13M',   'SGR report with an empty button field'],
    ['\x1b[<0;;13M',    'SGR report with an empty x field'],
    ['\x1b[<0;42;M',    'SGR report with an empty y field'],
  ];
  for (const [seq, why] of cases) {
    const state = createComposerState();
    noteUserInput(state, 'hi', 1000);
    noteUserInput(state, seq, 9000);
    assert.equal(state.lastInputAt, 9000, `${why} must push the quiet clock`);
  }
});

test('composer-state: a truncated report resolves towards busy for its own chunk', () => {
  const state = createComposerState();
  noteUserInput(state, '\x1b[<35;120', 4000);
  assert.equal(state.lastInputAt, 4000, 'half a report is not proof of silence');
  assert.equal(state.pending, 0, 'but it is not text either');
});

test('composer-state: a typed ESC [ M is input, not a mouse report', () => {
  // Nothing in the repo subscribes to xterm's onBinary channel, so a
  // DEFAULT-encoded mouse report never reaches this model: `ESC [ M` arriving
  // on onData is a person pressing Escape, then [, then M.
  const oneChunk = createComposerState();
  noteUserInput(oneChunk, '\x1b[Mabc', 2000);
  assert.equal(oneChunk.text, 'abc', 'the letters after it are typed text');
  assert.equal(oneChunk.pending, 3);
  assert.equal(oneChunk.lastInputAt, 2000, 'and the chunk pushes the quiet clock');

  const keyByKey = createComposerState();
  let now = 1000;
  for (const key of ['\x1b', '[', 'M', 'i', 's', 'e']) noteUserInput(keyByKey, key, (now += 1000));
  assert.equal(keyByKey.text, 'ise');
  assert.equal(keyByKey.pending, 3);
  assert.equal(keyByKey.lastInputAt, 7000);
});

// ── Cursor position reports (CPR / DECXCPR) ─────────────────────────────────
// Regression cover for the 2026-09-04 measurement: CPR chunks dominated a
// real idle-session trace and, left unhandled, kept the quiet clock from ever
// opening. See .ai/contexts/trigger-watcher.md ("Found it — CPR") for the numbers.

const CPR_DECX  = '\x1b[?59;3R';       // DECXCPR, as measured
const CPR_PAGE  = '\x1b[?59;3;1R';     // DECXCPR with a page field

test('composer-state: a cursor position report is neither text nor activity', () => {
  assertInert([CPR_DECX]);
  assertInert([CPR_PAGE]);
  // The measured cadence: back-to-back queries as the column advances.
  assertInert(['\x1b[?59;3R', '\x1b[?59;4R', '\x1b[?59;6R', '\x1b[?59;8R']);
});

// A bare `CSI n;m R` with no `?` is not a report at all on this CLI/terminal
// pairing: it is what xterm.js sends for a modified F3 keypress (`case 114`
// in xterm.js, `ESC[1;<mod+1>R`). 24,795/24,795 CPR chunks measured in the
// 2026-09-04 trace carried the `?`; zero did not — see
// .ai/contexts/trigger-watcher.md ("Found it — CPR"). The `?` is therefore
// mandatory in CPR_PARAMS_RE, not optional: a bare `n;m R` must count as
// input, exactly like any other unrecognised sequence.
test('composer-state: a bare (non-DECXCPR) CPR-shaped sequence is a keystroke, not a report', () => {
  const bareCases = [
    ['\x1b[24;80R', 'bare CPR: no `?`, plausible-looking but never measured'],
    ['\x1b[1;2R',   'Shift+F3'],
    ['\x1b[1;3R',   'Alt+F3'],
    ['\x1b[1;4R',   'Alt+Shift+F3'],
    ['\x1b[1;5R',   'Ctrl+F3'],
    ['\x1b[1;6R',   'Ctrl+Shift+F3'],
    ['\x1b[1;7R',   'Ctrl+Alt+F3'],
    ['\x1b[1;8R',   'Ctrl+Alt+Shift+F3'],
  ];
  for (const [seq, why] of bareCases) {
    const state = createComposerState();
    noteUserInput(state, 'hi', 1000);
    noteUserInput(state, seq, 9000);
    assert.equal(state.lastInputAt, 9000, `${why} (${JSON.stringify(seq)}) must push the quiet clock`);
  }
});

test('composer-state: a CPR mixing with a keystroke counts only the keystroke', () => {
  const state = createComposerState();
  noteUserInput(state, 'hi', 1000);
  noteUserInput(state, CPR_DECX + 'x', 5000);
  assert.equal(state.pending, 3, 'the keystroke lands in the composer');
  assert.equal(state.lastInputAt, 5000, 'and pushes the quiet clock');
  // The discriminating half: further CPRs on their own, after the keystroke,
  // must not advance the clock past it.
  noteUserInput(state, CPR_DECX, 9000);
  assert.equal(state.lastInputAt, 5000, 'a later CPR alone must not push the clock again');
});

test('composer-state: a CPR split across chunks is never counted as text', () => {
  const state = createComposerState();
  noteUserInput(state, '\x1b[?59;', 1000);
  assert.equal(state.pending, 0, 'a half report is held back, not typed');
  assert.equal(state.partial, '\x1b[?59;');
  noteUserInput(state, '3R', 2000);
  assert.equal(state.pending, 0, 'the completed report adds nothing');
  assert.equal(state.partial, '');
  assert.equal(state.lastInputAt, 1000, 'the completing chunk is silence');
});

test('composer-state: a near-miss CPR still counts as input', () => {
  // Same safety principle as the SGR near-misses: only the exact shape is
  // exempt. Arbitrary params ending in R must resolve towards busy.
  const cases = [
    ['\x1b[24R',           'CPR missing the column field'],
    ['\x1b[24;80;1;1R',    'one field too many'],
    ['\x1b[24;80;1;1;1R',  'two fields too many'],
    ['\x1b[a;bR',          'non-numeric CPR parameters'],
    ['\x1b[24;80;1;R',     'a dangling separator'],
    ['\x1b[5R',            'CSI 5 R — not a position report at all'],
    // Empty numeric fields on an otherwise well-formed DECXCPR: the near-miss
    // a `\d*` mutant would let through silently, since `*` accepts zero
    // digits where `{1,4}` requires one.
    ['\x1b[?;3R',          'DECXCPR with an empty row field'],
    ['\x1b[?59;R',         'DECXCPR with an empty column field'],
  ];
  for (const [seq, why] of cases) {
    const state = createComposerState();
    noteUserInput(state, 'hi', 1000);
    noteUserInput(state, seq, 9000);
    assert.equal(state.lastInputAt, 9000, `${why} must push the quiet clock`);
  }
});

// NOTE: whether a CPR could corrupt `text`/`cursor`/`pending` (not just the
// clock) was checked by reading `applyCsi` rather than by a test here — see
// .ai/contexts/trigger-watcher.md ("Found it — CPR") for why no runtime
// assertion on this can ever go red post-fix.

test('composer-state: ordinary typing still pushes the clock through a CPR flood', () => {
  // The guarantee that matters: excluding CPR must not accidentally exclude
  // real keystrokes that merely resemble one in shape.
  const state = createComposerState();
  let t = 1000;
  for (let i = 0; i < 20; i++) noteUserInput(state, CPR_DECX, (t += 50));
  assert.equal(state.lastInputAt, 0, 'a CPR flood alone must never look like typing');
  noteUserInput(state, 'x', (t += 50));
  assert.equal(state.lastInputAt, t, 'a real keystroke still pushes the clock');
  assert.equal(state.pending, 1);
});

test('composer-state: a bare CSI M never swallows the bytes that follow it', () => {
  // Treating it as the head of a report misaligned the next chunk and left the
  // composer frozen on a phantom count.
  const state = createComposerState();
  noteUserInput(state, '\x1b[M ', 1000);
  assert.equal(state.partial, '', 'nothing is held back waiting for a payload');
  noteUserInput(state, '\x1b[<0;1;1M', 2000);
  assert.equal(state.text, ' ', 'the SGR report that follows stays inert');
  assert.equal(state.pending, 1);
});

// ── The quiet clock during a bracketed paste ─────────────────────────────────
// A paste is the case where "doubt resolves to busy" matters most: its bytes
// are the user's, and a chunk that lands wholly inside one carries no marker of
// its own. Each of the three tests below is the only cover for one of the
// stamps in noteUserInput's paste branches.

test('composer-state: a chunk wholly inside a paste pushes the quiet clock', () => {
  const state = createComposerState();
  noteUserInput(state, '\x1b[200~', 1000);
  noteUserInput(state, 'pasted', 2000);
  assert.equal(state.pending, 6, 'the bytes land in the composer');
  assert.equal(state.lastInputAt, 2000, 'and the chunk is not silence');
  assert.equal(state.inPaste, true, 'the paste is still open');
});

test('composer-state: opening a paste pushes the quiet clock on its own', () => {
  // The opener adds no text, so nothing else in the chunk can stamp the clock.
  const state = createComposerState();
  noteUserInput(state, '\x1b[200~', 2000);
  assert.equal(state.pending, 0);
  assert.equal(state.lastInputAt, 2000, 'an opener alone is still input');
});

test('composer-state: a paste opener cut mid-chunk pushes the quiet clock', () => {
  const state = createComposerState();
  noteUserInput(state, '\x1b[2', 2000);
  assert.equal(state.partial, '\x1b[2', 'the head is buffered for the next chunk');
  assert.equal(state.pending, 0, 'and never typed as text');
  assert.equal(state.lastInputAt, 2000, 'but half an opener is not proof of silence');
});

test('composer-state: lastInputAt advances on any chunk carrying real input', () => {
  const state = createComposerState();
  noteUserInput(state, 'a', 5000);
  assert.equal(state.lastInputAt, 5000);
  // Enter empties the composer but is still input: the freshness window must
  // see it, otherwise a submit-completion Enter looks like silence.
  noteUserInput(state, '\r', 7000);
  assert.equal(state.pending, 0);
  assert.equal(state.lastInputAt, 7000);
});

test('composer-state: an empty chunk does not move the clock', () => {
  const state = createComposerState();
  noteUserInput(state, 'a', 5000);
  noteUserInput(state, '', 9000);
  assert.equal(state.lastInputAt, 5000);
  assert.equal(state.pending, 1);
});

test('composer-state: a partial escape sequence is buffered, capped, and never lost as text', () => {
  const state = createComposerState();
  noteUserInput(state, 'x\x1b[1', 1000);
  assert.equal(state.pending, 1, 'only the "x" counts; the CSI head is held back');
  assert.equal(state.partial, '\x1b[1');
  noteUserInput(state, '2A', 1001);
  assert.equal(state.partial, '', 'the completed sequence drains the buffer');
  assert.equal(state.pending, 1, 'CSI 12 A is not the bare up arrow, so it fills nothing');
});

test('composer-state: an over-long unterminated escape resolves towards busy', () => {
  const state = createComposerState();
  // 64 bytes of parameter with no final byte: past the 32-byte buffer cap.
  noteUserInput(state, '\x1b[' + '1'.repeat(64), 1000);
  assert.equal(state.partial, '', 'the buffer must not grow without bound');
  assert.ok(state.pending > 0, 'an unreadable blob counts as input, never as silence');
});

test('composer-state: a Buffer chunk is accepted like a string', () => {
  const state = createComposerState();
  noteUserInput(state, Buffer.from('abc'), 1000);
  assert.equal(state.pending, 3);
});
