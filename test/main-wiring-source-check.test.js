// test/main-wiring-source-check.test.js — reads main.js as TEXT and fails when
// the politeness glue disappears from it.
//
// This file proves NOTHING about runtime behaviour: it only shows the glue is
// still written down. The behaviour is exercised in
// test/terminal-input-handler.test.js and test/trigger-context.test.js.
'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');

const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

/** Slice the balanced `(...)` group that starts at the first `(` at or after `from`. */
function balancedParens(src, from) {
  const open = src.indexOf('(', from);
  assert.notEqual(open, -1, 'expected an argument list after index ' + from);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  throw new Error('unbalanced parentheses from index ' + open);
}

/**
 * Arguments of the call whose opening `(` follows `callee` inside `anchor`.
 * `anchor` locates the call site; `callee` is the part of it before that `(`.
 */
function argsOf(anchor, callee) {
  assert.ok(anchor.startsWith(callee), 'callee must be a prefix of anchor');
  const at = mainSrc.indexOf(anchor);
  assert.notEqual(at, -1, `main.js should still contain ${anchor}`);
  return balancedParens(mainSrc, at + callee.length);
}

test('main-wiring source check: terminal-input is registered and calls handleTerminalInput', () => {
  const args = argsOf("ipcMain.on('terminal-input'", 'ipcMain.on');
  // The whole argument list, not just the callee: `handleTerminalInput(...)`
  // with a swapped or hard-coded `now` disables half the politeness guard
  // while still matching a bare name check.
  assert.match(
    args,
    /\bhandleTerminalInput\s*\(\s*activeSessions\s*,\s*sessionId\s*,\s*data\s*,\s*Date\.now\(\)\s*\)/,
    'terminal-input must call handleTerminalInput(activeSessions, sessionId, data, Date.now())',
  );
  assert.match(
    mainSrc, /require\('\.\/terminal-input'\)/,
    'main.js must require ./terminal-input',
  );
});

test('main-wiring source check: terminal-input carries the pty.input probe, under the TRACE guard', () => {
  const args = argsOf("ipcMain.on('terminal-input'", 'ipcMain.on');
  assert.match(
    args,
    /if\s*\(TRACE\)\s*\{/,
    'the pty.input probe must sit behind `if (TRACE)` — no cost when the trace is off',
  );
  assert.match(
    args,
    /trace\(\s*'pty\.input'\s*,\s*sessionId\s*,/,
    "terminal-input must trace('pty.input', sessionId, ...)",
  );
  assert.match(
    args, /\bcontrolOffset\(\s*chunk\s*\)/,
    'the probe must locate the first control character before deciding what to record',
  );
  // The whole point of the offset: `codePoints(chunk, …)` would transcribe a
  // typed chunk, hex-encoded and reversible. Only the slice may be rendered.
  assert.match(
    args, /\bcodePoints\(\s*chunk\.slice\(\s*at\s*\)\s*,\s*10\s*\)/,
    'cp must be taken from chunk.slice(at), never from the whole chunk',
  );
  assert.doesNotMatch(
    args, /\bcodePoints\(\s*chunk\s*[,)]/,
    'cp must never be rendered from the whole chunk',
  );
  assert.match(
    args, /at\s*===\s*-1\s*\?\s*\{\s*len:\s*chunk\.length\s*\}/,
    'an all-printable chunk must contribute its length and nothing else',
  );
});

test('main-wiring source check: trigger-watcher.start is handed createTriggerContext(...)', () => {
  const args = argsOf(
    "require('./trigger-watcher').start", "require('./trigger-watcher').start",
  );
  assert.match(
    args.trim(), /^createTriggerContext\s*\(/,
    'trigger-watcher.start must receive the result of createTriggerContext',
  );
  assert.match(
    mainSrc, /require\('\.\/trigger-context'\)/,
    'main.js must require ./trigger-context',
  );
});

/** Slice the balanced `{...}` object literal that starts at the first `{` at or after `from`. */
function balancedBraces(src, from) {
  const open = src.indexOf('{', from);
  assert.notEqual(open, -1, 'expected an object literal after index ' + from);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  throw new Error('unbalanced braces from index ' + open);
}

test('main-wiring source check: the open-terminal session carries composerState', () => {
  const handler = argsOf("ipcMain.handle('open-terminal'", 'ipcMain.handle');
  const at = handler.indexOf('const session = {');
  assert.notEqual(at, -1, 'open-terminal should still build a `const session = { ... }`');
  const literal = balancedBraces(handler, at);
  assert.ok(
    literal.includes('activeSessions.set') === false,
    'the slice should stop at the session literal',
  );
  assert.match(
    literal, /composerState:\s*createComposerState\(\)/,
    'the session built in open-terminal must carry composerState: createComposerState()',
  );
});

test('main-wiring source check: no PTY method is called bare on a session', () => {
  // The crash this guards: a `terminal-resize` for a session whose pty exited
  // between the `!exited` check and the call. See .ai/contexts/ipc-bridge.md.
  const bare = /\bsession\.pty\.(resize|kill|write|pause|resume)\s*\(/g;
  const found = mainSrc.match(bare) || [];
  assert.deepEqual(
    found, [],
    'main.js must reach a session pty through pty-ops, not call it directly: ' + found.join(', '),
  );
  assert.match(
    mainSrc, /require\('\.\/pty-ops'\)/,
    'main.js must require ./pty-ops',
  );
  assert.match(
    mainSrc, /\bsetPtyOpLogger\(\s*log\s*\)/,
    'main.js must hand electron-log to pty-ops so swallowed errors stay diagnosable',
  );
});

test('main-wiring source check: terminal-resize goes through resizePty, nudge included', () => {
  const args = argsOf("ipcMain.on('terminal-resize'", 'ipcMain.on');
  assert.match(
    args, /resizePty\(\s*session\s*,\s*cols\s*,\s*rows\s*,\s*sessionId\s*\)/,
    'the primary resize must go through resizePty(session, cols, rows, sessionId)',
  );
  assert.match(
    args, /resizePty\(\s*session\s*,\s*cols\s*\+\s*1\s*,\s*rows\s*,\s*sessionId\s*\)/,
    'the first-resize nudge must go through resizePty too',
  );
  assert.equal(
    (args.match(/resizePty\(/g) || []).length, 3,
    'all three resizes on this path must be guarded',
  );
});

test('main-wiring source check: stop-session kills through killPty', () => {
  const args = argsOf("ipcMain.handle('stop-session'", 'ipcMain.handle');
  assert.match(
    args, /killPty\(\s*session\s*,\s*sessionId\s*\)/,
    'stop-session must kill through killPty — a bare kill() rejects the invoke',
  );
});

test('main-wiring source check: the keystroke path writes through pty-ops', () => {
  const inputSrc = fs.readFileSync(path.join(__dirname, '..', 'terminal-input.js'), 'utf8');
  assert.doesNotMatch(
    inputSrc, /\bsession\.pty\.write\s*\(/,
    'terminal-input.js must write through writePty, not straight at the pty',
  );
  assert.match(
    inputSrc, /writePty\(\s*session\s*,\s*data\s*,\s*sessionId\s*\)/,
    'terminal-input.js must call writePty(session, data, sessionId)',
  );
});
