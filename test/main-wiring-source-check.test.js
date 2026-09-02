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
