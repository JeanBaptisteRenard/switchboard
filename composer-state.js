// composer-state.js — how many bytes the user has typed and not submitted.
// see docs/automation.md ("Politeness") for what each rule protects and where
// the counter is blind.
'use strict';

const MAX_PARTIAL = 32;

const PASTE_START = '\x1b[200~';
const PASTE_END   = '\x1b[201~';

function createComposerState() {
  return { pending: 0, lastInputAt: 0, inPaste: false, partial: '' };
}

function isComposerEmpty(state) {
  return !state || state.pending === 0;
}

/** True when `buf` from `i` is a strict prefix of `seq` and runs to the end. */
function isTruncatedPrefixOf(buf, i, seq) {
  const rest = buf.length - i;
  return rest < seq.length && seq.startsWith(buf.slice(i));
}

/**
 * Match one escape sequence starting at `i`.
 * Returns { len, kind, params } or null when the sequence is not yet complete.
 * kind: 'csi' | 'ss3' | 'osc' | 'esc'
 */
function matchEscape(buf, i) {
  const next = buf[i + 1];
  if (next === undefined) return null;

  if (next === '[') {
    let j = i + 2;
    while (j < buf.length && buf[j] >= '\x30' && buf[j] <= '\x3f') j++;
    const paramsEnd = j;
    while (j < buf.length && buf[j] >= '\x20' && buf[j] <= '\x2f') j++;
    if (j >= buf.length) return null;
    const final = buf[j];
    if (final < '\x40' || final > '\x7e') return { len: j - i + 1, kind: 'csi', params: '', final };
    return { len: j - i + 1, kind: 'csi', params: buf.slice(i + 2, paramsEnd), final };
  }

  if (next === 'O') {
    if (i + 2 >= buf.length) return null;
    return { len: 3, kind: 'ss3', final: buf[i + 2] };
  }

  if (next === ']') {
    for (let j = i + 2; j < buf.length; j++) {
      if (buf[j] === '\x07') return { len: j - i + 1, kind: 'osc' };
      if (buf[j] === '\x1b' && buf[j + 1] === '\\') return { len: j - i + 2, kind: 'osc' };
      if (buf[j] === '\x1b' && j + 1 >= buf.length) return null;
    }
    return null;
  }

  return { len: 2, kind: 'esc' };
}

const KITTY_ENTER_RE = /^13(;[0-9:;]*)?$/;

/**
 * Fold one chunk of renderer keystrokes into `state`.
 *
 * @param {object} state  from createComposerState()
 * @param {string|Buffer} data  bytes the user just sent to the PTY
 * @param {number} now  epoch ms
 */
function noteUserInput(state, data, now) {
  if (!state) return state;
  const chunk = typeof data === 'string' ? data : String(data ?? '');
  if (chunk.length === 0) return state;

  state.lastInputAt = now;

  const buf = state.partial + chunk;
  state.partial = '';

  let i = 0;
  while (i < buf.length) {
    const c = buf[i];

    if (state.inPaste) {
      if (buf.startsWith(PASTE_END, i)) {
        state.inPaste = false;
        i += PASTE_END.length;
        continue;
      }
      if (c === '\x1b' && isTruncatedPrefixOf(buf, i, PASTE_END)) {
        state.partial = buf.slice(i);
        return state;
      }
      state.pending += 1;
      i += 1;
      continue;
    }

    if (c === '\x1b') {
      if (buf.startsWith(PASTE_START, i)) {
        state.inPaste = true;
        i += PASTE_START.length;
        continue;
      }
      if (isTruncatedPrefixOf(buf, i, PASTE_START)) {
        state.partial = buf.slice(i);
        return state;
      }

      const seq = matchEscape(buf, i);
      if (!seq) {
        const tail = buf.slice(i);
        if (tail.length > MAX_PARTIAL) {
          state.pending += 1;
          return state;
        }
        state.partial = tail;
        return state;
      }

      if (seq.kind === 'csi' && seq.final === 'A' && seq.params === '') {
        state.pending += 1;
      } else if (seq.kind === 'csi' && seq.final === 'u' && KITTY_ENTER_RE.test(seq.params)) {
        state.pending += 1;
      } else if (seq.kind === 'ss3' && seq.final === 'A') {
        state.pending += 1;
      }
      i += seq.len;
      continue;
    }

    if (c === '\r' || c === '\n' || c === '\x15' || c === '\x03') {
      state.pending = 0;
    } else if (c === '\x7f' || c === '\b') {
      state.pending = Math.max(0, state.pending - 1);
    } else if (c === '\x16') {
      state.pending += 1;
    } else if (c >= '\x20') {
      state.pending += 1;
    }
    i += 1;
  }

  return state;
}

module.exports = { createComposerState, noteUserInput, isComposerEmpty, MAX_PARTIAL };
