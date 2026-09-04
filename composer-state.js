// composer-state.js — a model of what the user has typed and not submitted.
// see docs/automation.md ("Politeness") for what each rule protects and where
// the model is blind.
'use strict';

const MAX_PARTIAL = 32;

const PASTE_START = '\x1b[200~';
const PASTE_END   = '\x1b[201~';

// Stands in for input whose text cannot be known: a Ctrl+V image paste, a
// history recall, an escape sequence too long to parse.
const OPAQUE = '￼';

function createComposerState() {
  return { pending: 0, lastInputAt: 0, inPaste: false, partial: '', text: '', cursor: 0 };
}

function isComposerEmpty(state) {
  return !state || state.pending === 0;
}

// ── The composer model ────────────────────────────────────────────────────────
// `text` is what we believe sits in the box, `cursor` a UTF-16 index into it.
// `pending` is derived: the number of code points, so an astral character
// weighs one, exactly as one backspace removes it.

function isHighSurrogate(code) { return code >= 0xd800 && code <= 0xdbff; }
function isLowSurrogate(code)  { return code >= 0xdc00 && code <= 0xdfff; }

function prevBoundary(text, i) {
  if (i <= 0) return 0;
  if (i >= 2 && isLowSurrogate(text.charCodeAt(i - 1)) && isHighSurrogate(text.charCodeAt(i - 2))) {
    return i - 2;
  }
  return i - 1;
}

function nextBoundary(text, i) {
  if (i >= text.length) return text.length;
  if (i + 1 < text.length && isHighSurrogate(text.charCodeAt(i)) && isLowSurrogate(text.charCodeAt(i + 1))) {
    return i + 2;
  }
  return i + 1;
}

function countCodePoints(text) {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    n++;
    if (isHighSurrogate(text.charCodeAt(i)) && i + 1 < text.length
        && isLowSurrogate(text.charCodeAt(i + 1))) {
      i++;
    }
  }
  return n;
}

const WHITESPACE = /\s/;

function wordStart(text, i) {
  let j = i;
  while (j > 0 && WHITESPACE.test(text[j - 1])) j--;
  while (j > 0 && !WHITESPACE.test(text[j - 1])) j--;
  return j;
}

function wordEnd(text, i) {
  let j = i;
  while (j < text.length && WHITESPACE.test(text[j])) j++;
  while (j < text.length && !WHITESPACE.test(text[j])) j++;
  return j;
}

function insertText(state, s) {
  if (!s) return;
  state.text = state.text.slice(0, state.cursor) + s + state.text.slice(state.cursor);
  state.cursor += s.length;
}

function deleteRange(state, from, to) {
  if (from >= to) return;
  state.text = state.text.slice(0, from) + state.text.slice(to);
  state.cursor = from;
}

function backspace(state)     { deleteRange(state, prevBoundary(state.text, state.cursor), state.cursor); }
function deleteForward(state) { deleteRange(state, state.cursor, nextBoundary(state.text, state.cursor)); }
function killWordBack(state)  { deleteRange(state, wordStart(state.text, state.cursor), state.cursor); }
function killToEnd(state)     { state.text = state.text.slice(0, state.cursor); }
function clearAll(state)      { state.text = ''; state.cursor = 0; }

function moveLeft(state)      { state.cursor = prevBoundary(state.text, state.cursor); }
function moveRight(state)     { state.cursor = nextBoundary(state.text, state.cursor); }
function moveWordLeft(state)  { state.cursor = wordStart(state.text, state.cursor); }
function moveWordRight(state) { state.cursor = wordEnd(state.text, state.cursor); }
function moveHome(state)      { state.cursor = 0; }
function moveEnd(state)       { state.cursor = state.text.length; }

function sync(state) {
  state.pending = countCodePoints(state.text);
  return state;
}

// ── The parser ────────────────────────────────────────────────────────────────

/** True when `buf` from `i` is a strict prefix of `seq` and runs to the end. */
function isTruncatedPrefixOf(buf, i, seq) {
  const rest = buf.length - i;
  return rest < seq.length && seq.startsWith(buf.slice(i));
}

/**
 * Match one escape sequence starting at `i`.
 * Returns { len, kind, params, final } or null when the sequence is not yet
 * complete. kind: 'csi' | 'ss3' | 'osc' | 'esc'
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

  // ESC followed by ESC is not Alt+ESC: consume only the first, so the second
  // is re-examined and can still open a bracketed paste.
  if (next === '\x1b') return { len: 1, kind: 'esc', final: '\x1b' };

  return { len: 2, kind: 'esc', final: next };
}

// ── Terminal reports ─────────────────────────────────────────────────────────
// Mouse, focus and cursor-position reports ride the same channel as
// keystrokes but are not user input: neither text nor activity. Recognition
// is deliberately strict — see .ai/contexts/trigger-watcher.md.

const SGR_MOUSE_PARAMS_RE = /^<\d{1,10};\d{1,10};\d{1,10}$/;

// CPR / DECXCPR: `CSI [?] row ; col [; page] R` — see .ai/contexts/trigger-watcher.md.
const CPR_PARAMS_RE = /^\??\d{1,4};\d{1,4}(?:;\d{1,4})?$/;

/**
 * How many bytes of terminal report start at the sequence `seq` just matched.
 * 0 when the sequence is not a report.
 */
function reportLength(seq) {
  if (seq.kind !== 'csi') return 0;
  const { final, params } = seq;
  // SGR (CSI ?1006h): `CSI < b ; x ; y M` press, `… m` release.
  if ((final === 'M' || final === 'm') && SGR_MOUSE_PARAMS_RE.test(params)) return seq.len;
  // Focus in / focus out (CSI ?1004h).
  if ((final === 'I' || final === 'O') && params === '') return seq.len;
  // Cursor position report.
  if (final === 'R' && CPR_PARAMS_RE.test(params)) return seq.len;
  return 0;
}

// A kitty Enter is a line break only when it carries a modifier parameter;
// bare `ESC [ 13 u` is a submission.
const KITTY_ENTER_RE = /^13;[0-9:;]+$/;

/** Numeric prefix of a CSI parameter string: '3;5' → '3'. */
function firstParam(params) {
  const semi = params.indexOf(';');
  return semi === -1 ? params : params.slice(0, semi);
}

function isModified(params) {
  return params.indexOf(';') !== -1;
}

function applyCsi(state, seq) {
  const { final, params } = seq;

  switch (final) {
    case 'A':
      // Bare Up recalls history and fills the box; modified Up does nothing on
      // Claude Code v2.1.258.
      if (params === '') insertText(state, OPAQUE);
      return;
    case 'C':
      if (isModified(params)) moveWordRight(state); else moveRight(state);
      return;
    case 'D':
      if (isModified(params)) moveWordLeft(state); else moveLeft(state);
      return;
    case 'H': moveHome(state); return;
    case 'F': moveEnd(state);  return;
    case 'u':
      if (KITTY_ENTER_RE.test(params)) insertText(state, '\n');
      return;
    case '~': {
      const p = firstParam(params);
      if (p === '3') deleteForward(state);
      else if (p === '1' || p === '7') moveHome(state);
      else if (p === '4' || p === '8') moveEnd(state);
      return;
    }
    default:
  }
}

function applySs3(state, seq) {
  switch (seq.final) {
    case 'A': insertText(state, OPAQUE); return;
    case 'C': moveRight(state); return;
    case 'D': moveLeft(state);  return;
    case 'H': moveHome(state);  return;
    case 'F': moveEnd(state);   return;
    default:
  }
}

function applyEsc(state, seq) {
  if (seq.final === '\x7f' || seq.final === '\b') killWordBack(state);
}

/**
 * Insert a run of literal characters. A run ending on a lone high surrogate at
 * the very end of the buffer is held back so a pair split across two IPC
 * chunks is not counted twice.
 */
function insertRun(state, run, atBufferEnd) {
  let s = run;
  if (atBufferEnd && s.length && isHighSurrogate(s.charCodeAt(s.length - 1))) {
    state.partial = s.slice(-1);
    s = s.slice(0, -1);
  }
  insertText(state, s);
}

/**
 * Fold one chunk of renderer keystrokes into `state`.
 *
 * A chunk made only of terminal reports leaves the state untouched, clock
 * included; anything else pushes `lastInputAt`.
 *
 * @param {object} state  from createComposerState()
 * @param {string|Buffer} data  bytes the user just sent to the PTY
 * @param {number} now  epoch ms
 */
function noteUserInput(state, data, now) {
  if (!state) return state;
  const chunk = typeof data === 'string' ? data : String(data ?? '');
  if (chunk.length === 0) return state;

  const buf = state.partial + chunk;
  state.partial = '';

  let counted = false;
  const finish = () => {
    if (counted) state.lastInputAt = now;
    return sync(state);
  };

  let i = 0;
  while (i < buf.length) {
    const c = buf[i];

    if (state.inPaste) {
      counted = true;
      if (buf.startsWith(PASTE_END, i)) {
        state.inPaste = false;
        i += PASTE_END.length;
        continue;
      }
      if (c === '\x1b' && isTruncatedPrefixOf(buf, i, PASTE_END)) {
        state.partial = buf.slice(i);
        return finish();
      }
      let j = i;
      while (j < buf.length && buf[j] !== '\x1b') j++;
      if (j === i) j = i + 1;
      insertRun(state, buf.slice(i, j), j === buf.length);
      i = j;
      continue;
    }

    if (c === '\x1b') {
      if (buf.startsWith(PASTE_START, i)) {
        counted = true;
        state.inPaste = true;
        i += PASTE_START.length;
        continue;
      }
      if (isTruncatedPrefixOf(buf, i, PASTE_START)) {
        counted = true;
        state.partial = buf.slice(i);
        return finish();
      }

      const seq = matchEscape(buf, i);
      if (!seq) {
        counted = true;
        const tail = buf.slice(i);
        if (tail.length > MAX_PARTIAL) {
          insertText(state, OPAQUE);
          return finish();
        }
        state.partial = tail;
        return finish();
      }

      const report = reportLength(seq);
      if (report > 0) {
        i += report;
        continue;
      }

      counted = true;
      if (seq.kind === 'csi') applyCsi(state, seq);
      else if (seq.kind === 'ss3') applySs3(state, seq);
      else if (seq.kind === 'esc') applyEsc(state, seq);
      i += seq.len;
      continue;
    }

    counted = true;
    if (c === '\r' || c === '\n' || c === '\x15' || c === '\x03') {
      clearAll(state);
    } else if (c === '\x7f' || c === '\b') {
      backspace(state);
    } else if (c === '\x17') {
      killWordBack(state);
    } else if (c === '\x0b') {
      killToEnd(state);
    } else if (c === '\x01') {
      moveHome(state);
    } else if (c === '\x05') {
      moveEnd(state);
    } else if (c === '\x16') {
      insertText(state, OPAQUE);
    } else if (c >= '\x20') {
      let j = i;
      while (j < buf.length && buf[j] >= '\x20' && buf[j] !== '\x7f') j++;
      insertRun(state, buf.slice(i, j), j === buf.length);
      i = j;
      continue;
    }
    i += 1;
  }

  return finish();
}

module.exports = { createComposerState, noteUserInput, isComposerEmpty, MAX_PARTIAL };
