// Regression: middle-click pasted the selection twice (and, with an earlier
// wrong fix, three times).
//
// A devtools trace of one middle-click showed both `paste` and `input` firing on
// xterm's hidden textarea, neither prevented. xterm's paste listener delivers
// the text, and because its handler calls stopPropagation() but not
// preventDefault(), the browser still performs the default insertion into the
// textarea — whose input listener delivers it a second time.
//
// Ctrl+V does not double, because xterm's _inputEvent bails unless
// `!e.composed || !this._keyDownSeen`; only a mouse paste, which has no
// preceding keydown, escapes that guard. So cancelling the default insertion is
// safe for both, and that is what these tests pin down.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { setupTerminalDom } = require('./terminal-manager-harness');

test('a paste inside a terminal has its default insertion cancelled', () => {
  const { window, destroy } = setupTerminalDom();
  try {
    window.createTerminalEntry({ sessionId: 's1' });
    const container = window.document.querySelector('.terminal-container')
      || window.document.querySelector('[id^="term-"]')
      || window.document.body.querySelector('div');
    assert.ok(container, 'a terminal container must exist');

    // xterm's textarea is a descendant of the container; the browser targets it.
    const textarea = window.document.createElement('textarea');
    container.appendChild(textarea);

    const ev = new window.Event('paste', { bubbles: true, cancelable: true });
    textarea.dispatchEvent(ev);

    assert.strictEqual(ev.defaultPrevented, true,
      'without this the browser inserts the text into the textarea and its input listener delivers it a second time');
  } finally {
    destroy();
  }
});

test('the cancel is registered in the capture phase, so xterm still delivers once', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'terminal-manager.js'), 'utf8');
  const idx = src.indexOf("addEventListener('paste'");
  assert.ok(idx !== -1, 'the paste listener must exist');
  // Take the whole source line, not from the match onward, so the receiver is included.
  const line = src.slice(src.lastIndexOf('\n', idx) + 1, src.indexOf('\n', idx));

  assert.match(line, /capture: true/,
    'capture phase: it must run before xterm\'s own textarea listener, which reads clipboardData');
  assert.match(line, /preventDefault\(\)/);
  assert.doesNotMatch(line, /stopPropagation/,
    'propagation must NOT be stopped — xterm\'s paste listener is what actually delivers the text');
  assert.match(line, /^\s*container\./,
    'scoped to the terminal container so CodeMirror panels keep normal paste behaviour');
});

test('the discredited auxclick approach is not reintroduced', () => {
  const files = ['public/terminal-manager.js', 'public/terminal-context-menu.js'];
  for (const f of files) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.ok(!src.includes('setupTerminalMiddleClickPaste'),
      `${f}: pasting PRIMARY ourselves on auxclick added a THIRD delivery — auxclick fires after the native paste has already happened`);
  }
});
