/**
 * viewer-panel.js — Unified viewer component for CodeMirror-based panels.
 *
 * A single component used by plan viewer, memory viewer, and file panel.
 * Manages toolbar, editor, preview area, and all interactions.
 * Watches files for external changes and reloads automatically.
 *
 * Toolbar buttons are shown/hidden automatically based on file type:
 *   - Preview: shown for markdown files
 *   - Wrap: always shown (defaults on for markdown, off for others)
 *   - Save: shown if onSave is provided
 *   - Close: shown if onClose is provided
 *   - Copy path/content: shown if opted in
 *
 * Depends on: viewer-toolbar.js
 * codemirror-bundle.js is loaded on demand (lazy) via loadCodeMirrorBundle().
 */

// ── Lazy CodeMirror loader ───────────────────────────────────────────────────
//
// Returns a Promise that resolves once codemirror-bundle.js has been injected
// and its globals (CMEditorView, createPlanEditor, …) are available on window.
// The Promise is cached after the first call — the <script> is injected exactly
// once regardless of how many callers race to open a panel.

let _cmBundlePromise = null;

function loadCodeMirrorBundle() {
  if (_cmBundlePromise) return _cmBundlePromise;

  _cmBundlePromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'codemirror-bundle.js';
    script.onload = () => resolve();
    script.onerror = (err) => { _cmBundlePromise = null; reject(err); };
    document.head.appendChild(script);
  });

  return _cmBundlePromise;
}

window.loadCodeMirrorBundle = loadCodeMirrorBundle;

class ViewerPanel {
  /**
   * @param {HTMLElement} container - Parent element to render into
   * @param {Object} opts
   * @param {Function}  opts.onSave       - async (filePath, content) => result
   * @param {Function}  opts.onClose      - () => void
   * @param {boolean}   opts.copyPath     - Show copy-path button
   * @param {boolean}   opts.copyContent  - Show copy-content button
   * @param {string}    opts.language     - 'markdown' or 'auto' (default 'markdown')
   * @param {string}    opts.storageKey   - localStorage key for preview mode persistence
   */
  constructor(container, opts = {}) {
    this.container = container;
    this.opts = opts;

    // State
    this.filePath = '';
    this.editorView = null;
    this.previewMode = opts.storageKey ? localStorage.getItem(opts.storageKey) === 'true' : false;
    this.wrapMode = false;
    this._watchedPath = null;
    this._saving = false;

    // Create toolbar — always include preview, wrap, save; visibility managed in open()
    this.toolbar = window.createViewerToolbar({
      copyPath: !!opts.copyPath,
      copyContent: !!opts.copyContent,
      preview: true,
      wrap: true,
      gotoLine: true,
      format: !!opts.format,
      delete: !!opts.onDelete,
      save: !!opts.onSave,
      close: !!opts.onClose,
    });
    container.insertBefore(this.toolbar.el, container.firstChild);

    // Hide preview initially (shown in open() if markdown)
    if (this.toolbar.previewBtn) this.toolbar.previewBtn.style.display = 'none';

    // Create editor area
    this.editorEl = document.createElement('div');
    this.editorEl.className = 'viewer-panel-editor';
    container.appendChild(this.editorEl);

    // Create preview area
    this.previewEl = document.createElement('div');
    this.previewEl.className = 'markdown-preview';
    this.previewEl.style.display = 'none';
    container.appendChild(this.previewEl);

    // Wire toolbar events
    this._wireEvents();

    // Listen for Cmd/Ctrl+S from CM editors
    container.addEventListener('cm-save', () => this._save());

    // Listen for file changes from main process
    this._onFileChanged = (changedPath) => {
      if (changedPath === this._watchedPath && !this._saving) {
        this._reloadFromDisk();
      }
    };
    if (window.api.onFileChanged) {
      window.api.onFileChanged(this._onFileChanged);
    }
  }

  _wireEvents() {
    const { toolbar, opts } = this;

    if (toolbar.previewBtn) {
      toolbar.previewBtn.addEventListener('click', () => this._togglePreview());
    }

    if (toolbar.wrapBtn) {
      toolbar.wrapBtn.addEventListener('click', () => this._toggleWrap());
    }

    if (toolbar.gotoLineBtn) {
      toolbar.gotoLineBtn.addEventListener('click', () => {
        if (this.editorView && window.cmOpenGotoLine) {
          window.cmOpenGotoLine(this.editorView);
        }
      });
    }

    if (toolbar.saveBtn && opts.onSave) {
      toolbar.saveBtn.addEventListener('click', () => this._save());
    }

    if (toolbar.closeBtn && opts.onClose) {
      toolbar.closeBtn.addEventListener('click', () => opts.onClose());
    }

    if (toolbar.copyPathBtn) {
      toolbar.copyPathBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(this.filePath);
        toolbar.flashCopyPath();
      });
    }

    if (toolbar.copyContentBtn) {
      toolbar.copyContentBtn.addEventListener('click', () => {
        const content = this.getContent();
        navigator.clipboard.writeText(content);
        toolbar.flashCopyContent();
      });
    }

    if (toolbar.formatBtn) {
      toolbar.formatBtn.addEventListener('click', () => this._format());
    }

    if (toolbar.deleteBtn && opts.onDelete) {
      toolbar.deleteBtn.addEventListener('click', () => this._delete());
    }
  }

  _format() {
    if (!this.editorView || !this.filePath) return;
    const ext = this.filePath.split('.').pop()?.toLowerCase();
    const raw = this.getContent();
    let formatted = null;
    try {
      if (ext === 'jsonl') {
        // Pretty-print each JSON line, separate with --- to preserve line semantics
        const lines = raw.split('\n').filter(l => l.trim().length > 0);
        formatted = lines.map(l => JSON.stringify(JSON.parse(l), null, 2)).join('\n---\n');
      } else {
        // Default: treat as JSON
        formatted = JSON.stringify(JSON.parse(raw), null, 2);
      }
    } catch (err) {
      window.flashButtonText?.(this.toolbar.formatBtn, '!', 1200);
      return;
    }
    if (formatted === raw) return;
    this.editorView.dispatch({
      changes: { from: 0, to: this.editorView.state.doc.length, insert: formatted },
    });
    window.flashButtonText?.(this.toolbar.formatBtn, '✓', 800);
  }

  async _delete() {
    if (!this.opts.onDelete || !this.filePath) return;
    // Confirm via native-ish browser confirm
    const name = this.filePath.split('/').pop();
    if (!window.confirm(`Delete "${name}"?\n\nThis cannot be undone.`)) return;
    try {
      const result = await this.opts.onDelete(this.filePath);
      if (result && result.ok !== false) {
        // Close panel and trigger refresh through onClose
        if (this.opts.onClose) this.opts.onClose();
      } else {
        window.alert(`Delete failed: ${result?.error || 'unknown error'}`);
      }
    } catch (err) {
      window.alert(`Delete failed: ${err.message}`);
    }
  }

  /**
   * Open a file in the viewer.
   *
   * The toolbar and file-watch are configured synchronously so the panel
   * header appears immediately. CodeMirror editor creation is deferred until
   * codemirror-bundle.js has been loaded (first call triggers the load; all
   * subsequent calls share the same cached Promise and resolve near-instantly).
   */
  open(title, filePath, content) {
    this._unwatchFile();

    this.filePath = filePath;
    this.toolbar.setTitle(title);
    this.toolbar.setPath(filePath);

    const isMd = this._isMarkdown(filePath);
    const isJsonish = this._isJsonish(filePath);

    // Show/hide preview button based on file type
    if (this.toolbar.previewBtn) {
      this.toolbar.previewBtn.style.display = isMd ? '' : 'none';
    }
    // Format button: only for .json / .jsonl
    if (this.toolbar.formatBtn) {
      this.toolbar.formatBtn.style.display = isJsonish ? '' : 'none';
    }

    // Reset to edit mode before updating content (without touching localStorage)
    if (this.previewMode) {
      this.previewEl.style.display = 'none';
      this.editorEl.style.display = '';
      if (this.toolbar.previewBtn) this.toolbar.previewBtn.classList.remove('active');
      this.previewMode = false;
    }

    // Watch for external changes (sync — does not need CodeMirror)
    this._watchFile(filePath);

    // Snapshot the caller's intent so that if open() is called again before
    // the bundle resolves, the latest content/filePath wins.
    // A monotonically-incrementing generation token lets each .then() callback
    // identify whether it is the most-recent open() call or a stale one.
    this._openGen = (this._openGen || 0) + 1;
    const myGen = this._openGen;
    const pending = { content, filePath, isMd };

    // Defer all CodeMirror work until the bundle is available.
    loadCodeMirrorBundle().then(() => {
      // Guard: if open() was called again after this closure was queued,
      // a newer call has incremented _openGen — skip this stale one.
      if (this._openGen !== myGen) return;
      const { content: c, filePath: fp, isMd: md } = pending;

      // Save preview preference before creating/updating editor
      const wantPreview = md && this.opts.storageKey && localStorage.getItem(this.opts.storageKey) === 'true';

      // Create or update editor
      if (!this.editorView) {
        this._createEditor(c, fp);
      } else {
        this.editorView.dispatch({
          changes: { from: 0, to: this.editorView.state.doc.length, insert: c },
        });
      }

      // Set wrap default based on file type
      this.wrapMode = md;
      this.toolbar.setWrapMode(this.wrapMode);
      if (this.editorView && this.editorView._wrapCompartment) {
        this.editorView.dispatch({
          effects: this.editorView._wrapCompartment.reconfigure(
            this.wrapMode ? window.CMEditorView.lineWrapping : []
          ),
        });
      }

      // Re-apply preview preference
      if (wantPreview) {
        this._setPreview(true);
      }
    }).catch((err) => {
      console.error('[viewer-panel] Failed to load codemirror-bundle:', err);
    });
  }

  _createEditor(content, filePath) {
    if (this.opts.language === 'auto') {
      this.editorView = window.createEditableViewer(
        this.editorEl, content, filePath, { wrap: this.wrapMode },
      );
    } else {
      this.editorView = window.createPlanEditor(this.editorEl);
      if (content) {
        this.editorView.dispatch({
          changes: { from: 0, to: this.editorView.state.doc.length, insert: content },
        });
      }
    }
  }

  _togglePreview() {
    this.previewMode = toggleMarkdownPreview({
      editorEl: this.editorEl,
      previewEl: this.previewEl,
      toggleBtn: this.toolbar.previewBtn,
      editorView: this.editorView,
      isPreview: this.previewMode,
      storageKey: this.opts.storageKey,
    });
  }

  _setPreview(show) {
    if (this.previewMode === show) return;
    this._togglePreview();
  }

  _toggleWrap() {
    if (!this.editorView || !this.editorView._wrapCompartment) return;
    this.wrapMode = !this.wrapMode;
    this.editorView.dispatch({
      effects: this.editorView._wrapCompartment.reconfigure(
        this.wrapMode ? window.CMEditorView.lineWrapping : []
      ),
    });
    this.toolbar.setWrapMode(this.wrapMode);
  }

  async _save() {
    if (!this.opts.onSave || !this.filePath) return;
    this._saving = true;
    const content = this.getContent();
    try {
      const result = await this.opts.onSave(this.filePath, content);
      if (result && result.ok !== false) {
        this.toolbar.flashSave();
      }
    } finally {
      setTimeout(() => { this._saving = false; }, 500);
    }
  }

  getContent() {
    return this.editorView ? this.editorView.state.doc.toString() : '';
  }

  destroy() {
    this._openGen = (this._openGen || 0) + 1;  // invalidate in-flight open() closure
    this._unwatchFile();
    if (this.editorView) {
      this.editorView.destroy();
      this.editorView = null;
    }
    // Clear stale search/goto-line bar references so they get recreated with the new editor
    delete this.editorEl._cmSearchBar;
    delete this.editorEl._cmGotoLine;
    this.editorEl.innerHTML = '';
    this.previewEl.innerHTML = '';
    this.previewEl.style.display = 'none';
  }

  // ── File Watching ──────────────────────────────────────────────────

  _watchFile(filePath) {
    if (!filePath || !window.api.watchFile) return;
    this._watchedPath = filePath;
    window.api.watchFile(filePath);
  }

  _unwatchFile() {
    if (this._watchedPath && window.api.unwatchFile) {
      window.api.unwatchFile(this._watchedPath);
      this._watchedPath = null;
    }
  }

  async _reloadFromDisk() {
    if (!this.filePath || !window.api.readFileForPanel) return;
    const result = await window.api.readFileForPanel(this.filePath);
    if (!result.ok) return;

    const newContent = result.content;
    const currentContent = this.getContent();
    if (newContent === currentContent) return;

    if (this.editorView) {
      this.editorView.dispatch({
        changes: { from: 0, to: this.editorView.state.doc.length, insert: newContent },
      });
    }

    if (this.previewMode) {
      this.previewEl.innerHTML = DOMPurify.sanitize(window.marked.parse(newContent));
    }
  }

  _isMarkdown(filePath) {
    if (!filePath) return this.opts.language === 'markdown';
    const ext = filePath.split('.').pop()?.toLowerCase();
    return ext === 'md' || ext === 'mdx';
  }

  _isJsonish(filePath) {
    if (!filePath) return false;
    const ext = filePath.split('.').pop()?.toLowerCase();
    return ext === 'json' || ext === 'jsonl';
  }
}

window.ViewerPanel = ViewerPanel;
