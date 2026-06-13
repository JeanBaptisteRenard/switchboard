// --- Terminal management ---
// Key bindings, write buffering, xterm instance lifecycle, drag-and-drop.
//
// Depends on globals: openSessions, activeSessionId, TERMINAL_THEME, terminalsEl,
// gridViewActive, gridCards, gridViewerCount, placeholder, terminalHeader,
// sessionMap, activePtyIds (app.js)
// Depends on: toggleGridView, isSessionNavKey, handleSessionNavKey, focusGridCard,
// wrapInGridCard, showGridView (grid-view.js)
// Depends on: shellEscape (utils.js)

// --- Terminal key bindings ---
// Shift+Enter → kitty protocol (CSI 13;2u) so Claude Code treats it as newline, not submit.
// Two layers needed:
//   1. attachCustomKeyEventHandler returning false — blocks xterm's key pipeline (onKey/onData)
//   2. preventDefault on capture-phase keydown — prevents browser inserting \n into textarea
const isMac = window.api.platform === 'darwin';
function setupTerminalKeyBindings(terminal, container, getSessionId, { onFind } = {}) {
  terminal.attachCustomKeyEventHandler((e) => {
    // Cmd/Ctrl+F → open terminal search bar
    if (e.key === 'f' && (isMac ? e.metaKey : e.ctrlKey) && !e.shiftKey && !e.altKey) {
      if (e.type === 'keydown' && onFind) onFind();
      return false;
    }

    // Toggle grid view (default Cmd/Ctrl+Shift+G)
    if (matchShortcut('gridToggle', e, isMac, appShortcuts)) {
      if (e.type === 'keydown') { e._handled = true; toggleGridView(); }
      return false;
    }

    // Session navigation: Cmd+Shift+[/], Cmd+Arrow
    if (isSessionNavKey(e)) {
      if (e.type === 'keydown') { e._handled = true; handleSessionNavKey(e); }
      return false;
    }

    // Shift+Enter → newline (kitty protocol CSI 13;2u) so Claude Code treats it as newline, not submit.
    if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      if (e.type === 'keydown') {
        window.api.sendInput(getSessionId(), '\x1b[13;2u');
      }
      return false;
    }

    // Ctrl+Enter → newline on Windows/Linux (matches PowerShell convention).
    // Send the same Shift+Enter kitty sequence that Claude Code recognizes as newline.
    if (!isMac && e.key === 'Enter' && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
      if (e.type === 'keydown') {
        window.api.sendInput(getSessionId(), '\x1b[13;2u');
      }
      return false;
    }

    // On Windows/Linux, Ctrl+V is captured by xterm as a control character (0x16)
    // instead of triggering a paste. Return false to block xterm's key pipeline and
    // let Electron's Edit menu { role: 'paste' } handle the actual clipboard paste.
    if (!isMac && e.key === 'v' && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
      return false;
    }

    // On Windows/Linux, Ctrl+C with a selection should copy instead of sending SIGINT.
    // When nothing is selected, Ctrl+C falls through to xterm (sends SIGINT as normal).
    if (!isMac && e.key === 'c' && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
      if (terminal.hasSelection()) {
        if (e.type === 'keydown') {
          window.api.writeClipboard(terminal.getSelection());
        }
        return false;
      }
    }

    // Space → send directly on keydown (including key-repeat) to ensure reliable
    // delivery to the PTY. xterm.js's evaluateKeyboardEvent does not handle plain
    // Space in keydown (keyCode 32 < 48 threshold) and instead relies on the
    // deprecated 'keypress' event, which Electron/Chromium may not fire reliably
    // for key-repeat events. This fixes Claude Code's "Hold Space to record"
    // push-to-talk voice feature, which depends on rapid key-repeat characters
    // arriving at stdin to detect a held key.
    if (e.key === ' ' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
      if (e.type === 'keydown') {
        e.preventDefault();
        window.api.sendInput(getSessionId(), ' ');
      }
      return false;
    }

    return true;
  });

  const textarea = container.querySelector('.xterm-helper-textarea');
  if (textarea) {
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.shiftKey || (!isMac && e.ctrlKey)) && !e.altKey && !e.metaKey) {
        e.preventDefault();
      }
    }, { capture: true });
  }
}

// Check whether a terminal is scrolled to the bottom using xterm's buffer API.
function isAtBottom(terminal) {
  const buf = terminal.buffer.active;
  return buf.viewportY >= buf.baseY;
}

// Pure helper: clamp a FitAddon-proposed row count to what the container's
// content-box height can actually display.
//
// Problem: xterm's FitAddon.proposeDimensions() reads
//   getComputedStyle(container).height  ← the .terminal-container border-box
// and subtracts only the .xterm element's OWN padding (0 in Switchboard).
// Under the global `* { box-sizing: border-box }` rule, the computed height
// already includes the container's 8 px top + 8 px bottom padding, so those
// 16 px are counted as drawable area. Result: 1–2 extra rows are proposed and
// the bottom portion is clipped by overflow:hidden (measured: 16 px / ~1.14
// rows in both single and grid views).
//
// Fix: clamp proposed rows to floor((clientHeight − verticalPadding) /
// cellHeight). clientHeight is the padding-box height (excludes borders only),
// so subtracting the vertical padding gives the true content-box height.
// Math.min ensures we only ever shrink an overshoot, never add rows.
// Returns proposedRows unchanged when cellHeight ≤ 0 (unmeasured state).
function clampRowsToContentBox(proposedRows, clientHeight, verticalPadding, cellHeight) {
  if (cellHeight <= 0) return proposedRows;
  const maxRows = Math.max(1, Math.floor((clientHeight - verticalPadding) / cellHeight));
  return Math.min(proposedRows, maxRows);
}

// Fit terminal to container, clamping rows to the container's true content-box
// height to avoid bottom-row clipping (see clampRowsToContentBox above).
function safeFit(entry) {
  const dims = entry.fitAddon.proposeDimensions();
  if (dims && dims.rows > 1) {
    const el = entry.element; // .terminal-container
    const cs = getComputedStyle(el);
    const padV = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    // Prefer the private xterm render-service path (same source FitAddon uses).
    // Fall back to measuring the first row element if the internal path is gone.
    const cellH =
      entry.terminal._core?._renderService?.dimensions?.css?.cell?.height ||
      el.querySelector('.xterm-rows')?.firstElementChild?.getBoundingClientRect().height ||
      0;
    const clampedRows = clampRowsToContentBox(dims.rows, el.clientHeight, padV, cellH);
    entry.terminal.resize(dims.cols, clampedRows);
  } else {
    entry.fitAddon.fit();
  }
}

// Fit a terminal that just became visible (from display:none or reparent).
// Defers to requestAnimationFrame so the container has dimensions.
function fitAndScroll(entry) {
  const wasAtBottom = isAtBottom(entry.terminal);
  requestAnimationFrame(() => {
    safeFit(entry);
    if (wasAtBottom) {
      entry.terminal.scrollToBottom();
    }
  });
}

// --- Terminal write buffering ---
// Batch incoming terminal data to coalesce IPC chunks into fewer write() calls.
const ESC_SYNC_START = '\x1b[?2026h';
const ESC_SYNC_END = '\x1b[?2026l';
const SYNC_BUFFER_TIMEOUT = 500; // max ms to hold data waiting for sync end
const terminalWriteBuffers = new Map(); // sessionId → { chunks, syncDepth, rafId, timerId }

// ~30 fps flush cap — halves paint/compositor work vs. 60 fps during streaming.
// Measured: compositor burns 40-60% of a core at 60 fps; 33 ms doubles parse-batch
// size and is imperceptible for streaming text (worst-case added latency: 33 ms).
const MIN_FLUSH_INTERVAL_MS = 33; // ~30 fps
const lastFlushAt = new Map(); // sessionId → performance.now() of last flush

function flushTerminalBuffer(sessionId) {
  const buf = terminalWriteBuffers.get(sessionId);
  if (!buf) return;
  clearTimeout(buf.timerId);
  cancelAnimationFrame(buf.rafId);
  terminalWriteBuffers.delete(sessionId);

  // Intentional guard: destroySession may have removed the entry between the
  // rAF schedule and this flush — bail out instead of writing to a disposed
  // terminal.
  const entry = openSessions.get(sessionId);
  if (!entry) return;

  const data = buf.chunks.join('');
  lastFlushAt.set(sessionId, performance.now());
  const wasAtBottom = isAtBottom(entry.terminal);
  const savedViewportY = entry.terminal.buffer.active.viewportY;
  entry.terminal.write(data, () => {
    if (sessionId !== activeSessionId) return;
    if (wasAtBottom) {
      entry.terminal.scrollToBottom();
    } else {
      // Restore scroll position so redraws don't yank the user away
      entry.terminal.scrollLines(savedViewportY - entry.terminal.buffer.active.viewportY);
    }
  });
}

function scheduleFlush(sessionId, buf) {
  // If a timer or rAF is already pending, don't stack another.
  if (buf.timerId || buf.rafId) return;

  const last = lastFlushAt.get(sessionId);
  const elapsed = last === undefined ? Infinity : performance.now() - last;
  if (elapsed >= MIN_FLUSH_INTERVAL_MS) {
    // Enough time has passed — flush on the next animation frame (current behavior).
    buf.rafId = requestAnimationFrame(() => flushTerminalBuffer(sessionId));
  } else {
    // Too soon — schedule a timer for the remaining interval, then rAF from there.
    // Reuses buf.timerId so destroySession/flushTerminalBuffer teardown works unchanged.
    const remaining = MIN_FLUSH_INTERVAL_MS - elapsed;
    buf.timerId = setTimeout(() => {
      buf.timerId = 0;
      buf.rafId = requestAnimationFrame(() => flushTerminalBuffer(sessionId));
    }, remaining);
  }
}

// Entry point for PTY data (wired to window.api.onTerminalData in app.js).
// Lives here rather than app.js so the sync-block/flush interplay runs under
// the jsdom test harness — the v0.0.35 frozen-terminal bug shipped because
// this logic sat in untestable app.js.
function handleTerminalData(sessionId, data) {
  const entry = openSessions.get(sessionId);
  if (entry) {
    let buf = terminalWriteBuffers.get(sessionId);
    if (!buf) {
      buf = { chunks: [], syncDepth: 0, rafId: 0, timerId: 0 };
      terminalWriteBuffers.set(sessionId, buf);
    }
    buf.chunks.push(data);

    // Track sync start/end nesting
    if (data.includes(ESC_SYNC_START)) buf.syncDepth++;
    if (data.includes(ESC_SYNC_END)) buf.syncDepth = Math.max(0, buf.syncDepth - 1);

    if (buf.syncDepth > 0) {
      // Inside a synchronized update — keep buffering.
      // Set a safety timeout so we never hold data forever.
      cancelAnimationFrame(buf.rafId);
      // Must zero rafId: scheduleFlush early-returns on a truthy rafId, so a
      // stale id here would permanently block every future flush (frozen
      // terminal) once the sync block closes.
      buf.rafId = 0;
      if (!buf.timerId) {
        buf.timerId = setTimeout(() => flushTerminalBuffer(sessionId), SYNC_BUFFER_TIMEOUT);
      }
    } else {
      // Not in a sync block (or sync just ended) — flush on next frame.
      clearTimeout(buf.timerId);
      buf.timerId = 0;
      scheduleFlush(sessionId, buf);
    }
  }
  // Update last activity time (noise-filtered)
  trackActivity(sessionId, data);
}

// --- LRU cap on live terminals ---
// Every open session keeps a live xterm (+ WebGL context) until destroyed,
// so renderer memory scales with the number of sessions ever opened in this
// window (measured: 462 MB renderer RSS). The LRU destroys the
// least-recently-shown *closed* session beyond the cap. Sessions with a live
// PTY — and the active session — are never evicted, so the cap is soft when
// more than TERMINAL_LRU_CAP sessions are actually running. An evicted
// closed session behaves exactly like the existing re-click flow
// (openSession finds no entry and relaunches); it just loses its exit
// banner earlier.
const TERMINAL_LRU_CAP = 12;
const lruOrder = []; // sessionIds, most-recently-shown first

function lruTouch(sessionId) {
  if (!openSessions.has(sessionId)) return;
  const i = lruOrder.indexOf(sessionId);
  if (i !== -1) lruOrder.splice(i, 1);
  lruOrder.unshift(sessionId);
  while (lruOrder.length > TERMINAL_LRU_CAP) {
    if (!lruEvictOne()) break; // nothing evictable right now — soft cap
  }
}

// Destroy the least-recently-shown evictable session. Returns false when no
// entry can be evicted (all running, active, or still open).
function lruEvictOne() {
  for (let i = lruOrder.length - 1; i >= 0; i--) {
    const sid = lruOrder[i];
    const entry = openSessions.get(sid);
    if (!entry) { lruOrder.splice(i, 1); return true; } // stale id — drop it
    if (sid === activeSessionId || activePtyIds.has(sid) || !entry.closed) continue;
    destroySession(sid); // also removes sid from lruOrder
    return true;
  }
  return false;
}

// --- Terminal lifecycle helpers ---

// Scrollback budget per view mode. A 10k-row buffer costs ~3 MB per terminal;
// grid cards are thumbnails and only need enough rows for context. showSession
// and showGridView switch the live value when the view mode changes.
const SCROLLBACK_SINGLE = 10000; // focused single-view terminal
const SCROLLBACK_GRID = 1000;    // grid card (thumbnail)

// Create an xterm instance, wire up IPC, and register in openSessions.
// Returns the entry. Does NOT make it visible or fit it — call showSession() for that.
function createTerminalEntry(session, opts = {}) {
  const { sessionId } = session;
  const container = document.createElement('div');
  container.className = 'terminal-container';
  terminalsEl.appendChild(container);

  const terminal = new Terminal({
    fontSize: 12,
    fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
    theme: TERMINAL_THEME,
    cursorBlink: false,
    scrollback: opts.scrollback ?? (gridViewActive ? SCROLLBACK_GRID : SCROLLBACK_SINGLE),
    convertEol: true,
    allowProposedApi: true,
    linkHandler: {
      activate: (_event, uri) => {
        if (uri.startsWith('file://') && typeof openFileInPanel === 'function') {
          try { openFileInPanel(sessionId, decodeURIComponent(new URL(uri).pathname)); } catch {}
        } else {
          window.api.openExternal(uri);
        }
      },
      allowNonHttpProtocols: true,
    },
  });

  // OSC 52 — let the program inside the terminal set the system clipboard (this is how
  // Claude Code copies). xterm doesn't wire this up itself, so we do. Payload is
  // "<selection>;<base64>" (or "<selection>;?" for a read-back query, which we ignore).
  // Route through the main process — see writeClipboard — because the renderer clipboard
  // is unreliable on Wayland.
  terminal.parser.registerOscHandler(52, (payload) => {
    const sep = payload.indexOf(';');
    const b64 = sep === -1 ? payload : payload.slice(sep + 1);
    if (!b64 || b64 === '?') return true;
    try {
      const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
      window.api.writeClipboard(new TextDecoder().decode(bytes));
    } catch {
      return false;
    }
    return true;
  });

  const fitAddon = new FitAddon.FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(new WebLinksAddon.WebLinksAddon((_event, url) => {
    if (url.startsWith('file://') && typeof openFileInPanel === 'function') {
      try { openFileInPanel(sessionId, decodeURIComponent(new URL(url).pathname)); } catch {}
    } else {
      window.api.openExternal(url);
    }
  }));
  const searchAddon = new SearchAddon.SearchAddon();
  terminal.loadAddon(searchAddon);
  terminal.loadAddon(new UnicodeGraphemesAddon.UnicodeGraphemesAddon());
  terminal.unicode.activeVersion = '15';
  terminal.open(container);
  container.style.backgroundColor = TERMINAL_THEME.background;

  // --- Terminal search bar (Cmd/Ctrl+F) ---
  const searchBar = document.createElement('div');
  searchBar.className = 'terminal-search-bar';
  searchBar.style.display = 'none';
  searchBar.innerHTML = `
    <input type="text" class="terminal-search-input" placeholder="Find..." />
    <span class="terminal-search-count"></span>
    <button class="terminal-search-prev" title="Previous (Shift+Enter)">&#x25B2;</button>
    <button class="terminal-search-next" title="Next (Enter)">&#x25BC;</button>
    <button class="terminal-search-close" title="Close (Escape)">&times;</button>
  `;
  container.appendChild(searchBar);
  const searchInput = searchBar.querySelector('.terminal-search-input');
  const searchCount = searchBar.querySelector('.terminal-search-count');
  const searchOpts = { decorations: { matchBackground: '#515C6A', activeMatchBackground: '#EAA549', matchOverviewRuler: '#515C6A', activeMatchColorOverviewRuler: '#EAA549' } };

  function openSearchBar() {
    searchBar.style.display = 'flex';
    searchInput.focus();
    const sel = terminal.getSelection();
    if (sel) { searchInput.value = sel; searchAddon.findNext(sel, searchOpts); }
  }
  function closeSearchBar() {
    searchBar.style.display = 'none';
    searchAddon.clearDecorations();
    searchInput.value = '';
    searchCount.textContent = '';
    terminal.focus();
  }
  searchInput.addEventListener('input', () => {
    const q = searchInput.value;
    if (q) { searchAddon.findNext(q, searchOpts); } else { searchAddon.clearDecorations(); searchCount.textContent = ''; }
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeSearchBar(); e.preventDefault(); }
    else if (e.key === 'Enter' && e.shiftKey) { searchAddon.findPrevious(searchInput.value, searchOpts); e.preventDefault(); }
    else if (e.key === 'Enter') { searchAddon.findNext(searchInput.value, searchOpts); e.preventDefault(); }
  });
  searchBar.querySelector('.terminal-search-next').addEventListener('click', () => searchAddon.findNext(searchInput.value, searchOpts));
  searchBar.querySelector('.terminal-search-prev').addEventListener('click', () => searchAddon.findPrevious(searchInput.value, searchOpts));
  searchBar.querySelector('.terminal-search-close').addEventListener('click', closeSearchBar);

  const entry = { terminal, element: container, fitAddon, searchAddon, openSearchBar, closeSearchBar, session, closed: false, webglAddon: null };
  openSessions.set(sessionId, entry);
  lruTouch(sessionId);
  loadTerminalWebgl(entry);

  // Wire up IPC (use entry.session.sessionId so fork re-keying works)
  terminal.onData(data => {
    if (data === '\x1b[I' || data === '\x1b[O') return;
    window.api.sendInput(entry.session.sessionId, data);
  });
  setupTerminalKeyBindings(terminal, container, () => entry.session.sessionId, { onFind: openSearchBar });
  setupDragAndDrop(container, () => entry.session.sessionId);
  terminal.onResize(({ cols, rows }) => {
    window.api.resizeTerminal(entry.session.sessionId, cols, rows);
  });
  terminal.onTitleChange(title => {
    entry.ptyTitle = title;
    if (activeSessionId === entry.session.sessionId) updatePtyTitle();
  });
  terminal.onBell(() => {
    trackActivity(entry.session.sessionId, '\x07');
  });

  return entry;
}

// --- WebGL renderer lifecycle ---
// GPU-accelerated rendering via WebGL drops renderer+compositor CPU ~50-70%,
// but each addon holds a GL context and Chromium caps ~16 of them per
// process — past the cap, contexts are lost and terminals silently degrade.
// The grid view suspends the addon on off-screen cards (IntersectionObserver
// in grid-view.js) and restores it when they scroll back in; showSession
// restores it for single view. Loading must happen after terminal.open()
// (needs attached DOM); failure falls back to xterm's DOM renderer.
function loadTerminalWebgl(entry) {
  if (entry.webglAddon || !entry.terminal) return;
  try {
    const webglAddon = new WebglAddon.WebglAddon();
    webglAddon.onContextLoss(() => {
      webglAddon.dispose();
      if (entry.webglAddon === webglAddon) entry.webglAddon = null;
    });
    entry.terminal.loadAddon(webglAddon);
    entry.webglAddon = webglAddon;
  } catch (e) {
    console.warn('[terminal] WebGL addon failed, falling back to DOM renderer', e);
  }
}

function suspendTerminalWebgl(sessionId) {
  const entry = openSessions.get(sessionId);
  if (!entry || !entry.webglAddon) return;
  try { entry.webglAddon.dispose(); } catch {}
  entry.webglAddon = null; // xterm falls back to its DOM renderer
}

function restoreTerminalWebgl(sessionId) {
  const entry = openSessions.get(sessionId);
  if (entry) loadTerminalWebgl(entry);
}

// Clean up a closed session entry (dispose terminal, remove DOM, remove from maps).
function destroySession(sessionId) {
  const entry = openSessions.get(sessionId);
  if (!entry) return;
  window.api.closeTerminal(sessionId);
  // Drop any pending write buffer before disposing — a scheduled rAF/timeout
  // flush would otherwise call terminal.write() on a disposed instance if
  // terminal-data IPC raced with the teardown.
  const buf = terminalWriteBuffers.get(sessionId);
  if (buf) {
    cancelAnimationFrame(buf.rafId);
    clearTimeout(buf.timerId);
    terminalWriteBuffers.delete(sessionId);
  }
  lastFlushAt.delete(sessionId);
  // terminal.dispose() also disposes the parser and its registered OSC
  // handlers (the OSC-52 clipboard hook) and all onX emitters — no manual
  // cleanup needed for those. The DnD/search-bar listeners live on
  // entry.element, which is removed below and garbage-collected once the
  // entry leaves openSessions/gridCards.
  entry.terminal.dispose();
  entry.element.remove();
  openSessions.delete(sessionId);
  const li = lruOrder.indexOf(sessionId);
  if (li !== -1) lruOrder.splice(li, 1);
  if (destroyGridCard(sessionId) && gridViewActive) {
    // Keep the grid header count honest when a card disappears outside the
    // showGridView/showSession flows (e.g. LRU eviction of a closed session).
    gridViewerCount.textContent = gridCards.size + ' session' + (gridCards.size !== 1 ? 's' : '');
  }
}

// Make a session visible in the current view mode (grid or single).
// Handles sidebar highlight, notifications, header, fit, and focus.
function showSession(sessionId) {
  const entry = openSessions.get(sessionId);
  const session = sessionMap.get(sessionId) || (entry && entry.session);

  // Update sidebar active state
  document.querySelectorAll('.session-item.active').forEach(el => el.classList.remove('active'));
  const item = document.querySelector(`[data-session-id="${sessionId}"]`);
  if (item) item.classList.add('active');
  setActiveSession(sessionId);
  clearNotifications(sessionId);
  lruTouch(sessionId);

  if (gridViewActive) {
    // Ensure grid layout is set up (e.g. on first session after startup restore)
    if (!terminalsEl.classList.contains('grid-layout')) {
      showGridView();
    }
    if (entry && gridCards.has(sessionId)) {
      // Already in grid — just focus it
      focusGridCard(sessionId);
    } else if (entry) {
      // New entry not yet in grid — wrap and focus
      wrapInGridCard(sessionId);
      fitAndScroll(entry);
      requestAnimationFrame(() => focusGridCard(sessionId));
      gridViewerCount.textContent = gridCards.size + ' session' + (gridCards.size !== 1 ? 's' : '');
    }
  } else {
    // Single terminal view
    document.querySelectorAll('.terminal-container').forEach(el => el.classList.remove('visible'));
    placeholder.style.display = 'none';
    hidePlanViewer();
    if (session) showTerminalHeader(session);
    if (entry) {
      // Restore the full scrollback budget for the focused terminal (the grid
      // may have trimmed it — see showGridView). Growing the limit is lossless.
      entry.terminal.options.scrollback = SCROLLBACK_SINGLE;
      restoreTerminalWebgl(sessionId); // grid may have suspended the GL context
      entry.element.classList.add('visible');
      entry.terminal.focus();
      fitAndScroll(entry);
    }
  }
}

function setupDragAndDrop(container, getSessionId) {
  let dragCounter = 0;
  container.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragCounter++;
    container.classList.add('drag-over');
  });
  container.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  container.addEventListener('dragleave', () => {
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      container.classList.remove('drag-over');
    }
  });
  container.addEventListener('drop', (e) => {
    e.preventDefault();
    dragCounter = 0;
    container.classList.remove('drag-over');
    const files = e.dataTransfer.files;
    if (!files.length) return;
    const paths = Array.from(files).map(f => shellEscape(window.api.getPathForFile(f)));
    window.api.sendInput(getSessionId(), paths.join(' '));
  });
}
