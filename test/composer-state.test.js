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

test('composer-state: lastInputAt advances on any non-empty chunk', () => {
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
