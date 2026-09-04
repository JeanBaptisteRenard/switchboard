// Regression tests for renderJsonlText() sanitization.
//
// public/jsonl-viewer.js renders transcript text through marked.parse()
// then innerHTML. marked doesn't filter URL schemes: markdown link/image
// syntax (`[x](javascript:...)`, `![x](javascript:...)`) survives into the
// DOM even though literal HTML tags are escaped first by a regex. The fix
// pipes marked's output through DOMPurify, matching the other two markdown
// sinks in this app (viewer-panel.js, viewer-toolbar.js). See
// .ai/contexts/viewer-panel.md.
//
// This suite loads the REAL marked and DOMPurify builds (the same files
// index.html loads via <script>), not mocks — a mock sanitizer would prove
// nothing about the actual vulnerability.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const NODE_MODULES = path.join(__dirname, '..', 'node_modules');
const MARKED_PATH = path.join(NODE_MODULES, 'marked', 'lib', 'marked.umd.js');
const DOMPURIFY_PATH = path.join(NODE_MODULES, 'dompurify', 'dist', 'purify.min.js');

function evalInWindow(dom, file) {
  const src = fs.readFileSync(file, 'utf8');
  vm.runInContext(src, dom.getInternalVMContext(), { filename: file });
}

// installMarked / installDOMPurify let individual tests omit either global,
// so we can prove the fallback path and the mutation-inverse (DOMPurify
// missing/removed) behave safely.
function setupDom({ installMarked = true, installDOMPurify = true } = {}) {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'http://localhost/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });

  evalInWindow(dom, path.join(PUBLIC_DIR, 'utils.js'));
  if (installMarked) evalInWindow(dom, MARKED_PATH);
  if (installDOMPurify) evalInWindow(dom, DOMPURIFY_PATH);
  evalInWindow(dom, path.join(PUBLIC_DIR, 'jsonl-viewer.js'));

  return dom;
}

test('renderJsonlText: javascript: URL in markdown link produces no href', () => {
  const dom = setupDom();
  try {
    const html = dom.window.renderJsonlText('[click me](javascript:alert(1))');
    const div = dom.window.document.createElement('div');
    div.innerHTML = html;
    const a = div.querySelector('a');
    assert.ok(a, 'anchor must still be present (text content preserved)');
    assert.equal(a.getAttribute('href'), null, 'href must be stripped by DOMPurify');
    assert.equal(a.textContent, 'click me');
  } finally {
    dom.window.close();
  }
});

test('renderJsonlText: javascript: URL in markdown image produces no src', () => {
  const dom = setupDom();
  try {
    const html = dom.window.renderJsonlText('![img](javascript:alert(1))');
    const div = dom.window.document.createElement('div');
    div.innerHTML = html;
    const img = div.querySelector('img');
    assert.ok(img, 'img element must still be present');
    assert.equal(img.getAttribute('src'), null, 'src must be stripped by DOMPurify');
  } finally {
    dom.window.close();
  }
});

test('renderJsonlText: legitimate markdown (code block, https link, bold) survives sanitization', () => {
  const dom = setupDom();
  try {
    const text = [
      'Some **bold** text with `inline code`.',
      '',
      '```js',
      'const x = 1;',
      '```',
      '',
      'See [docs](https://example.com/page).',
    ].join('\n');
    const html = dom.window.renderJsonlText(text);
    const div = dom.window.document.createElement('div');
    div.innerHTML = html;

    const strong = div.querySelector('strong');
    assert.ok(strong, 'bold must render as <strong>');
    assert.equal(strong.textContent, 'bold');

    const inlineCode = div.querySelector('code');
    assert.ok(inlineCode, 'inline code must render');

    const pre = div.querySelector('pre');
    assert.ok(pre, 'fenced code block must render as <pre>');
    assert.match(pre.textContent, /const x = 1;/);

    const link = div.querySelector('a');
    assert.ok(link, 'https link must render');
    assert.equal(link.getAttribute('href'), 'https://example.com/page', 'https href must survive sanitization');
  } finally {
    dom.window.close();
  }
});

test('renderJsonlText: fallback path (no marked) still escapes HTML fully', () => {
  const dom = setupDom({ installMarked: false, installDOMPurify: false });
  try {
    const html = dom.window.renderJsonlText('<img src=x onerror=alert(1)> and **bold**');
    const div = dom.window.document.createElement('div');
    div.innerHTML = html;
    assert.equal(div.querySelector('img'), null, 'no raw img element must survive the no-marked fallback');
    const strong = div.querySelector('strong');
    assert.ok(strong, 'fallback still renders **bold** as <strong>');
  } finally {
    dom.window.close();
  }
});

test('renderJsonlText: marked loaded but DOMPurify missing falls back safely (no raw marked output)', () => {
  const dom = setupDom({ installMarked: true, installDOMPurify: false });
  try {
    const html = dom.window.renderJsonlText('[click me](javascript:alert(1))');
    const div = dom.window.document.createElement('div');
    div.innerHTML = html;
    assert.equal(div.querySelector('a'), null, 'must not fall through to unsanitized marked output when DOMPurify is absent');
  } finally {
    dom.window.close();
  }
});

// --- Mutation-inverse proof ---------------------------------------------
// Removing the DOMPurify.sanitize() call (i.e. reverting to the pre-fix
// `return html;`) must turn the first two tests red, and must NOT affect
// the third (legitimate-markdown) test. This function reproduces the
// pre-fix renderJsonlText exactly, so we can assert its unsafe output here
// as documented proof rather than relying on prose.
function preFixRenderJsonlText(dom, text) {
  const { window } = dom;
  const escaped = text.replace(/<(\/?[a-zA-Z][a-zA-Z0-9_-]*(?:\s[^>]*)?\/?)\>/g, '&lt;$1&gt;');
  return window.marked.parse(escaped);
}

test('mutation-inverse: pre-fix renderJsonlText DOES leak javascript: href (proves the first test is not vacuous)', () => {
  const dom = setupDom();
  try {
    const html = preFixRenderJsonlText(dom, '[click me](javascript:alert(1))');
    const div = dom.window.document.createElement('div');
    div.innerHTML = html;
    const a = div.querySelector('a');
    assert.ok(a, 'anchor present');
    assert.equal(a.getAttribute('href'), 'javascript:alert(1)', 'pre-fix code leaks the javascript: href');
  } finally {
    dom.window.close();
  }
});

test('mutation-inverse: pre-fix renderJsonlText DOES leak javascript: src on image (proves the second test is not vacuous)', () => {
  const dom = setupDom();
  try {
    const html = preFixRenderJsonlText(dom, '![img](javascript:alert(1))');
    const div = dom.window.document.createElement('div');
    div.innerHTML = html;
    const img = div.querySelector('img');
    assert.ok(img, 'img present');
    assert.equal(img.getAttribute('src'), 'javascript:alert(1)', 'pre-fix code leaks the javascript: src');
  } finally {
    dom.window.close();
  }
});

test('mutation-inverse: pre-fix renderJsonlText still renders legitimate markdown fine (proves test 3 does not depend on the fix)', () => {
  const dom = setupDom();
  try {
    const text = 'Some **bold** text with `inline code`.\n\nSee [docs](https://example.com/page).';
    const html = preFixRenderJsonlText(dom, text);
    const div = dom.window.document.createElement('div');
    div.innerHTML = html;
    assert.ok(div.querySelector('strong'), 'bold still renders without the fix');
    const link = div.querySelector('a');
    assert.equal(link.getAttribute('href'), 'https://example.com/page', 'https link still renders without the fix');
  } finally {
    dom.window.close();
  }
});
