'use strict';

// See .ai/contexts/ipc-bridge.md "Busy-state reconciliation".

const IDLE_GLYPH = '✳';
const IDLE_CP = IDLE_GLYPH.codePointAt(0);

const SPINNER_RANGES = [
  [0x2800, 0x28ff],
  [0x25d0, 0x25d3],
];

function isSpinnerCodePoint(cp) {
  return SPINNER_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
}

function classifyTitleActivity(title, options) {
  const none = { busy: false, idle: false, via: null };
  if (typeof title !== 'string' || title.length === 0) return none;

  const cp = title.codePointAt(0);
  if (cp === IDLE_CP) return { busy: false, idle: true, via: 'idle-glyph' };
  if (isSpinnerCodePoint(cp)) return { busy: true, idle: false, via: 'glyph' };

  const rest = title.slice(String.fromCodePoint(cp).length);
  const prefixed = rest.startsWith(' ') && rest.length > 1;
  const allowFallback = !options || options.allowFallback !== false;
  if (allowFallback && prefixed && cp > 0x7f) return { busy: true, idle: false, via: 'fallback' };

  return none;
}

module.exports = { classifyTitleActivity, IDLE_GLYPH, SPINNER_RANGES };
