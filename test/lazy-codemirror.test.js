// Tests for lazy-load behaviour of codemirror-bundle.js.
//
// Verifies three invariants:
//   (a) codemirror-bundle.js script is NOT present in the DOM at startup
//   (b) it is injected exactly once after the first ViewerPanel.open() call
//   (c) a second open() call does not inject a second script tag
//
// Strategy: evaluate viewer-toolbar.js and viewer-panel.js inside a jsdom
// window, stub the DOM elements and globals ViewerPanel needs, then call
// open() and assert <script> presence in document.head.
//
// codemirror-bundle.js itself is never fetched — the test intercepts the
// script.onload by overriding document.createElement('script') so that the
// injected <script> resolves immediately without a real network request.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const INDEX_HTML = `<!DOCTYPE html>
<html>
  <head></head>
  <body>
    <div id="panel-container"></div>
  </body>
</html>`;

function evalInWindow(dom, file) {
  const src = fs.readFileSync(file, 'utf8');
  vm.runInContext(src, dom.getInternalVMContext(), { filename: file });
}

/**
 * Set up a jsdom window with viewer-toolbar.js and viewer-panel.js loaded.
 *
 * The jsdom window's document.createElement is monkey-patched so that any
 * <script> element created in-window has its onload/onerror hooked: as soon
 * as the element is appended to document.head, onload fires synchronously
 * (simulating an instant cache hit) without any real network request.
 */
function setupViewerPanelDom() {
  const dom = new JSDOM(INDEX_HTML, {
    url: 'http://localhost/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;

  // Stub window.api — ViewerPanel uses onFileChanged, watchFile, unwatchFile
  window.api = {
    onFileChanged: () => {},
    watchFile: () => {},
    unwatchFile: () => {},
  };

  // Stub localStorage — ViewerPanel reads preview preference
  window.localStorage = {
    getItem: () => null,
    setItem: () => {},
  };

  // Intercept document.createElement so <script> elements resolve instantly.
  // We wrap the real createElement and fire onload synchronously after the
  // element is appended to any parent (via a MutationObserver substitute —
  // jsdom supports it).
  const realCreateElement = window.document.createElement.bind(window.document);
  window.document.createElement = function (tag, ...args) {
    const el = realCreateElement(tag, ...args);
    if (tag.toLowerCase() === 'script') {
      // Patch appendChild on document.head to fire onload right after insert
      const origHeadAppend = window.document.head.appendChild.bind(window.document.head);
      window.document.head.appendChild = function (child) {
        const result = origHeadAppend(child);
        // Fire onload on the next microtask to mimic real async script load
        if (child === el && typeof el.onload === 'function') {
          Promise.resolve().then(() => el.onload());
        }
        return result;
      };
    }
    return el;
  };

  // viewer-toolbar.js defines createViewerToolbar + toggleMarkdownPreview
  evalInWindow(dom, path.join(PUBLIC_DIR, 'viewer-toolbar.js'));

  // viewer-panel.js defines ViewerPanel + loadCodeMirrorBundle
  evalInWindow(dom, path.join(PUBLIC_DIR, 'viewer-panel.js'));

  const container = window.document.getElementById('panel-container');

  return { window, document: window.document, container, destroy: () => window.close() };
}

// ── Tests ──────────────────────────────────────────────────────────────────

test('lazy-codemirror: bundle script NOT in DOM at startup', () => {
  const ctx = setupViewerPanelDom();
  try {
    const scripts = [...ctx.document.head.querySelectorAll('script')];
    const cmScript = scripts.find(s => s.src && s.src.includes('codemirror-bundle'));
    assert.equal(cmScript, undefined, 'codemirror-bundle.js must NOT be injected before any panel is opened');
  } finally {
    ctx.destroy();
  }
});

test('lazy-codemirror: bundle injected exactly once after first panel open', async () => {
  const ctx = setupViewerPanelDom();
  try {
    // Stub CodeMirror globals that _createEditor needs (they are normally
    // provided by codemirror-bundle.js; here we stub them so open() completes)
    ctx.window.createPlanEditor = () => ({
      dispatch: () => {},
      state: { doc: { toString: () => '', length: 0 } },
      destroy: () => {},
    });
    ctx.window.createEditableViewer = ctx.window.createPlanEditor;
    ctx.window.CMEditorView = { lineWrapping: [] };

    const panel = new ctx.window.ViewerPanel(ctx.container, { language: 'markdown' });

    // Before open — no script
    const beforeScripts = [...ctx.document.head.querySelectorAll('script')];
    assert.equal(
      beforeScripts.filter(s => s.src && s.src.includes('codemirror-bundle')).length,
      0,
      'no codemirror-bundle script before open()',
    );

    panel.open('Test', '/tmp/test.md', '# hello');

    // Allow the microtask queue to flush (onload fires via Promise.resolve)
    await new Promise(resolve => setTimeout(resolve, 0));

    const afterScripts = [...ctx.document.head.querySelectorAll('script')];
    const cmScripts = afterScripts.filter(s => s.src && s.src.includes('codemirror-bundle'));
    assert.equal(cmScripts.length, 1, 'codemirror-bundle.js must be injected exactly once after first open()');
  } finally {
    ctx.destroy();
  }
});

test('lazy-codemirror: second open() does not inject a second script tag', async () => {
  const ctx = setupViewerPanelDom();
  try {
    // Stub CodeMirror globals
    ctx.window.createPlanEditor = () => ({
      dispatch: () => {},
      state: { doc: { toString: () => '', length: 0 } },
      destroy: () => {},
      _wrapCompartment: null,
    });
    ctx.window.createEditableViewer = ctx.window.createPlanEditor;
    ctx.window.CMEditorView = { lineWrapping: [] };

    const panel = new ctx.window.ViewerPanel(ctx.container, { language: 'markdown' });

    panel.open('First', '/tmp/a.md', '# first');
    await new Promise(resolve => setTimeout(resolve, 0));

    // Second open
    panel.open('Second', '/tmp/b.md', '# second');
    await new Promise(resolve => setTimeout(resolve, 0));

    const cmScripts = [...ctx.document.head.querySelectorAll('script')]
      .filter(s => s.src && s.src.includes('codemirror-bundle'));
    assert.equal(cmScripts.length, 1, 'codemirror-bundle.js must remain exactly one <script> tag after multiple open() calls');
  } finally {
    ctx.destroy();
  }
});

test('lazy-codemirror: window.loadCodeMirrorBundle is exported', () => {
  const ctx = setupViewerPanelDom();
  try {
    assert.equal(typeof ctx.window.loadCodeMirrorBundle, 'function', 'loadCodeMirrorBundle must be exported on window');
  } finally {
    ctx.destroy();
  }
});

/**
 * Set up a jsdom window where the bundle load is HELD until the caller manually
 * fires the resolve or reject callback.  Returns { ...ctx, resolveBundle, rejectBundle }.
 */
function setupViewerPanelDomHeld() {
  const dom = new JSDOM(INDEX_HTML, {
    url: 'http://localhost/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;

  window.api = {
    onFileChanged: () => {},
    watchFile: () => {},
    unwatchFile: () => {},
  };

  window.localStorage = {
    getItem: () => null,
    setItem: () => {},
  };

  let capturedScript = null;

  const realCreateElement = window.document.createElement.bind(window.document);
  window.document.createElement = function (tag, ...args) {
    const el = realCreateElement(tag, ...args);
    if (tag.toLowerCase() === 'script') {
      // Capture the script element so the test can fire onload/onerror manually.
      // Do NOT auto-fire — the caller controls resolution timing.
      const origHeadAppend = window.document.head.appendChild.bind(window.document.head);
      window.document.head.appendChild = function (child) {
        const result = origHeadAppend(child);
        if (child === el) capturedScript = el;
        return result;
      };
    }
    return el;
  };

  evalInWindow(dom, path.join(PUBLIC_DIR, 'viewer-toolbar.js'));
  evalInWindow(dom, path.join(PUBLIC_DIR, 'viewer-panel.js'));

  const container = window.document.getElementById('panel-container');

  function resolveBundle() {
    if (capturedScript && typeof capturedScript.onload === 'function') {
      capturedScript.onload();
    }
  }

  function rejectBundle() {
    if (capturedScript && typeof capturedScript.onerror === 'function') {
      capturedScript.onerror(new Error('load failed'));
    }
  }

  return {
    window, document: window.document, container,
    resolveBundle, rejectBundle,
    destroy: () => window.close(),
  };
}

// ── Regression: destroy() before bundle resolves must NOT create an editor ──

test('lazy-codemirror: destroy() before bundle resolves does not create a zombie editor', async () => {
  const ctx = setupViewerPanelDomHeld();
  try {
    // Stub CM globals (should never be reached in this test)
    let createEditorCalled = false;
    ctx.window.createEditableViewer = () => {
      createEditorCalled = true;
      return {
        dispatch: () => {},
        state: { doc: { toString: () => '', length: 0 } },
        destroy: () => {},
        _wrapCompartment: null,
      };
    };
    ctx.window.createPlanEditor = ctx.window.createEditableViewer;
    ctx.window.CMEditorView = { lineWrapping: [] };

    const panel = new ctx.window.ViewerPanel(ctx.container, { language: 'auto' });

    // open() queues the .then() callback — bundle is NOT yet resolved
    panel.open('Test', '/tmp/test.js', 'const x = 1;');

    // destroy() must increment _openGen so the queued .then() becomes stale
    panel.destroy();

    // Now resolve the bundle — the stale .then() should bail early
    ctx.resolveBundle();
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.equal(createEditorCalled, false, 'destroy() before bundle load must prevent editor creation');
    assert.equal(panel.editorView, null, 'editorView must remain null after destroy+late-resolve');
  } finally {
    ctx.destroy();
  }
});

// ── Regression: rejected bundle load must reset the cached promise for retry ──

test('lazy-codemirror: rejected bundle load resets cached promise so next open() retries', async () => {
  const ctx = setupViewerPanelDomHeld();
  try {
    ctx.window.createEditableViewer = () => ({
      dispatch: () => {},
      state: { doc: { toString: () => '', length: 0 } },
      destroy: () => {},
      _wrapCompartment: null,
    });
    ctx.window.createPlanEditor = ctx.window.createEditableViewer;
    ctx.window.CMEditorView = { lineWrapping: [] };

    const panel = new ctx.window.ViewerPanel(ctx.container, { language: 'auto' });

    // First open — triggers bundle load
    panel.open('Test', '/tmp/test.js', 'const x = 1;');

    // Simulate a load failure (404 / CSP)
    ctx.rejectBundle();
    await new Promise(resolve => setTimeout(resolve, 0));

    // After rejection the module-level _cmBundlePromise must be reset to null.
    // We verify this indirectly: a second open() must inject a new <script> tag
    // (meaning loadCodeMirrorBundle() created a fresh Promise rather than
    // returning the old rejected one).
    const scriptsBefore = [...ctx.document.head.querySelectorAll('script')]
      .filter(s => s.src && s.src.includes('codemirror-bundle')).length;

    // The onerror handler resets _cmBundlePromise = null.  A new open() call
    // will then call loadCodeMirrorBundle() which creates a fresh Promise and
    // injects a second <script> element.
    panel.open('Retry', '/tmp/test2.js', 'const y = 2;');
    await new Promise(resolve => setTimeout(resolve, 0));

    const scriptsAfter = [...ctx.document.head.querySelectorAll('script')]
      .filter(s => s.src && s.src.includes('codemirror-bundle')).length;

    assert.ok(
      scriptsAfter > scriptsBefore,
      `A new <script> must be injected after a failed load so the panel can retry (before=${scriptsBefore}, after=${scriptsAfter})`,
    );
  } finally {
    ctx.destroy();
  }
});
