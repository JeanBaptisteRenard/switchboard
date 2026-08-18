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
const isMac = typeof window !== 'undefined' && window.api && window.api.platform === 'darwin';

// True when a keydown is being consumed by an IME (e.g. Korean/Japanese/Chinese)
// to compose a character. Chromium reports keyCode 229 for such keydowns, and
// sets isComposing while a composition is active. xterm's own _keyDown defers to
// its composition helper in this state — but only if our custom handler lets the
// event through (returns true) instead of intercepting it.
function isImeComposing(e) {
  return e.isComposing === true || e.keyCode === 229;
}

// Whether a Space keydown should be written straight to the PTY (the push-to-talk
// key-repeat path from #22) rather than left to xterm. It must NOT fire during IME
// composition: preventDefault-ing the Space there drops the in-progress syllable
// (e.g. Korean "녕 " came out as " 녕" or lost the syllable entirely).
function shouldSendSpaceDirectly(e) {
  return e.key === ' '
    && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey
    && !isImeComposing(e);
}

// Decode an OSC 52 payload into the text the program wants on the clipboard.
// Payload is "<selection>;<base64>", e.g. "c;aGVsbG8=".
//
// Returns null when there is nothing to write — an empty payload, or a read-back
// query ("<selection>;?"). The read-back case is a deliberate refusal, not a gap:
// answering it would write the user's clipboard contents back into the terminal,
// letting any program running in the session exfiltrate whatever they last
// copied. We consume the sequence and stay silent. Do not "finish" this by
// implementing the query response.
//
// Throws on malformed base64 (atob), which the caller reports as unhandled.
function decodeOsc52Payload(payload) {
  const sep = payload.indexOf(';');
  const b64 = sep === -1 ? payload : payload.slice(sep + 1);
  if (!b64 || b64 === '?') return null;
  const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function setupTerminalKeyBindings(terminal, container, getSessionId, { onFind } = {}) {
  terminal.attachCustomKeyEventHandler((e) => {
    // Cmd/Ctrl+F → open terminal search bar
    if (e.key === 'f' && (isMac ? e.metaKey : e.ctrlKey) && !e.shiftKey && !e.altKey) {
      if (e.type === 'keydown' && onFind) onFind();
      return false;
    }

    // F11 → window fullscreen toggle. Without this, xterm consumes the keydown
    // (writes CSI 23~ to the PTY) and preventDefaults it, which suppresses the
    // menu's togglefullscreen accelerator — so F11 only worked when the focus
    // was outside the terminal, and there was no way out of fullscreen on
    // Windows/Linux where the menu bar is hidden in that state.
    // preventDefault is REQUIRED here: without it the un-consumed keydown also
    // reaches the menu accelerator, which toggles fullscreen right back —
    // a double toggle that looks like F11 doing nothing (shipped broken in
    // v0.0.47 exactly that way).
    if (e.key === 'F11' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
      if (e.type === 'keydown') {
        e.preventDefault();
        window.api.toggleFullScreen();
      }
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

    // Paste. Two jobs:
    //  1. Image paste — a terminal is a text stream, so an image can't ride a text
    //     paste. On any paste shortcut (Ctrl/Cmd+V or Shift+Insert), ask the main
    //     process whether the clipboard holds an image; if it does, forward Ctrl+V
    //     (0x16) to the PTY so the child (e.g. Claude Code) does its own native
    //     clipboard paste — it reads the image straight off the system clipboard and
    //     shows an [image] placeholder, exactly like a regular terminal. A text-only
    //     clipboard skips this and falls through to the normal text paste below.
    //  2. Text paste — on Windows/Linux, Ctrl+V is otherwise captured by xterm as a
    //     control character (0x16); return false to block xterm's key pipeline and
    //     let Electron's Edit menu { role: 'paste' } do the text paste. On Mac the
    //     default Cmd+V text paste already works, and Shift+Insert text paste arrives
    //     via Chromium's native paste event, so for both we fall through (return true)
    //     and only add the image forward.
    const isCtrlOrCmdV = isMac
      ? (e.key === 'v' && e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey)
      : (e.key === 'v' && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey);
    const isShiftInsert = e.key === 'Insert' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey;
    if (isCtrlOrCmdV || isShiftInsert) {
      if (e.type === 'keydown') {
        window.api.clipboardHasImage().then(hasImage => {
          if (hasImage) window.api.sendInput(getSessionId(), '\x16');
        });
      }
      // Only Ctrl+V needs xterm blocked so Electron's { role: 'paste' } runs;
      // Cmd+V and Shift+Insert paste text through their own native paths.
      if (isCtrlOrCmdV && !isMac) return false;
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
    // Skips IME composition (isImeComposing): during Korean/Japanese/Chinese
    // composition, Space commits the pending syllable, so it must fall through
    // to xterm's composition helper instead of being sent raw.
    if (shouldSendSpaceDirectly(e)) {
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

// Measure the dimensions the terminal should have for its current container,
// clamped to the container's true content-box height (see clampRowsToContentBox).
// Returns null when the container cannot be measured (hidden, unrendered, or
// xterm has no valid cell size yet) — FitAddon.proposeDimensions() itself
// returns undefined when cell width/height are 0.
//
// This is the ONLY DOM-measuring call in the resize path. Everything that wants
// to re-fit goes through it, so the cost of a refit is one proposeDimensions()
// plus one getComputedStyle() per terminal — and only when something asked.
function proposeFittedDimensions(entry) {
  const dims = entry.fitAddon.proposeDimensions();
  if (!dims || !(dims.rows > 1)) return null;
  const el = entry.element; // .terminal-container
  const cs = getComputedStyle(el);
  const padV = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
  // Prefer the private xterm render-service path (same source FitAddon uses).
  // Fall back to measuring the first row element if the internal path is gone.
  const cellH =
    entry.terminal._core?._renderService?.dimensions?.css?.cell?.height ||
    el.querySelector('.xterm-rows')?.firstElementChild?.getBoundingClientRect().height ||
    0;
  return { cols: dims.cols, rows: clampRowsToContentBox(dims.rows, el.clientHeight, padV, cellH) };
}

// Fit terminal to container, clamping rows to the container's true content-box
// height to avoid bottom-row clipping (see clampRowsToContentBox above).
function safeFit(entry) {
  const dims = proposeFittedDimensions(entry);
  if (dims) {
    entry.terminal.resize(dims.cols, dims.rows);
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
    forceRepaint(entry);
    if (wasAtBottom) {
      entry.terminal.scrollToBottom();
    }
  });
}

// The WebGL renderer keeps a glyph texture atlas that survives display:none and
// reparenting (single-view <-> grid). On reveal, safeFit only repaints when the
// dimensions actually change, so a same-size terminal redraws from the stale
// atlas and shows ghosted or vertically misplaced glyphs (a manual resize or a
// select/deselect clears it). Clear the atlas and force a full row refresh
// whenever a terminal is revealed.
function forceRepaint(entry) {
  if (entry.webglAddon) {
    try { entry.webglAddon.clearTextureAtlas(); } catch { /* addon disposed mid-flight */ }
  }
  entry.terminal.refresh(0, entry.terminal.rows - 1);
}

// --- PTY size synchronisation ---
//
// Symptom this closes: xterm.js and the PTY disagree on the column count.
// Whatever the shell/TUI writes is already wrapped for the width IT believes
// in; xterm re-wraps against a different width, and the TUI's next cursor-up
// lands one line too low — "lignes qui sautent".
//
// Three sources of drift existed:
//   1. The PTY was spawned at a hard-coded 120x30 and only learned the real
//      size on the first refit (see createTerminalEntry / open-terminal).
//   2. Refits only ran on window resize, tab switch and session focus — a
//      geometry change from wake-from-sleep, a DPI change or a move to another
//      monitor produced none of those.
//   3. Every refit re-sent a resize even when nothing had changed.
//
// Deliberately NOT fixed with a polling timer: proposeDimensions() reads the
// DOM, and doing that on an interval for every open terminal costs real CPU
// while idle. The mechanisms below are all event-driven — they cost nothing
// when the geometry does not move.

// Record the size last handed to the PTY for this session and report whether it
// actually changed. This is what makes every refit point idempotent: a refit
// that proposes the same dimensions produces no IPC and no pty.resize().
function ptySizeChanged(entry, cols, rows) {
  const last = entry.lastPtySize;
  if (last && last.cols === cols && last.rows === rows) return false;
  entry.lastPtySize = { cols, rows };
  return true;
}

// Send one resize to the PTY unconditionally, right after open-terminal
// resolved. Two reasons this is not deduplicated:
//   - the main process arms its reattach "nudge" (cols+1 then cols, which
//     forces a TUI repaint) on the FIRST terminal-resize it receives for a
//     session; with the spawn size now already correct, no organic resize may
//     ever arrive and a resumed session would never repaint;
//   - it is the acknowledgement that the size we asked to spawn with is the
//     size xterm actually ended up with.
// Cost: exactly one fire-and-forget IPC per session open.
function syncPtySizeAfterOpen(entry) {
  if (!entry || !entry.terminal) return;
  const { cols, rows } = entry.terminal;
  if (!cols || !rows) return;
  entry.lastPtySize = { cols, rows };
  window.api.resizeTerminal(entry.session.sessionId, cols, rows);
}

// Debounce for container-geometry changes. A window drag fires the observer on
// every frame; 80 ms collapses a drag into a single refit at the end of it
// without being perceptible.
const CONTAINER_RESIZE_DEBOUNCE_MS = 80;

// Watch the terminal container's own geometry. This is the piece that covers
// the cases no existing hook did (wake-from-sleep, DPI change, monitor change,
// sidebar drag): the browser only calls back when the box really changed, so
// the idle cost is zero. The observer is disconnected in destroySession —
// a leaked observer would be exactly the recurring cost we are avoiding.
function observeContainerResize(entry) {
  if (typeof ResizeObserver !== 'function') return; // jsdom / very old runtimes
  let timer = 0;
  const observer = new ResizeObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = 0;
      // Cheap guard before any measuring call: a hidden container (inactive
      // tab, grid card scrolled out) has nothing to fit.
      if (!entry.element.isConnected || entry.element.clientHeight === 0) return;
      safeFit(entry);
    }, CONTAINER_RESIZE_DEBOUNCE_MS);
  });
  observer.observe(entry.element);
  entry.stopObservingResize = () => {
    clearTimeout(timer);
    timer = 0;
    try { observer.disconnect(); } catch {}
    entry.stopObservingResize = null;
  };
}

// Re-fit whatever is currently on screen. Wired to window resize, page
// visibilitychange and window focus in app.js. Thanks to ptySizeChanged, a call
// that finds nothing changed sends no IPC at all.
function refitOpenTerminals() {
  if (gridViewActive) {
    for (const entry of openSessions.values()) {
      fitAndScroll(entry);
    }
    return;
  }
  if (activeSessionId && openSessions.has(activeSessionId)) {
    safeFit(openSessions.get(activeSessionId));
  }
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

// A session that is neither the focused single-view terminal nor part of an
// open grid gets none of its PTY output written to xterm at all — see
// appendToHiddenAccumulator/replayHiddenBuffer below. A prior version of this
// throttled hidden sessions to ~1fps instead of suspending them outright;
// that still ran a parse on every flush (measured: renderer JS main thread
// ~17% of a core with 4 hidden sessions). Not calling write() removes that
// parse cost entirely, on top of the paint/WebGL draw call cost already
// avoided (xterm's own RenderService pauses rendering via an
// IntersectionObserver on the screen element once its display:none ancestor
// makes it non-intersecting — see node_modules/@xterm/xterm
// src/browser/services/RenderService.ts _registerIntersectionObserver/
// _handleIntersectionChange — so paint was already near-zero before this
// change; this closes the remaining parse-cost gap).
// Grid view is excluded — its own per-card WebGL virtualization
// (suspendTerminalWebgl/restoreTerminalWebgl + gridCardObserver in
// grid-view.js) already caps the dominant render cost there, and every open
// grid session keeps the fast cadence so thumbnails stay live.
function isHiddenSingleViewSession(sessionId) {
  return !gridViewActive && sessionId !== activeSessionId;
}

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

// Only ever called for a session that is active or part of an open grid (see
// handleTerminalData below) — a hidden single-view session never reaches
// this function at all, so there is no hidden-cadence branch here anymore.
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

// --- Hidden-session full suspend: accumulate-while-hidden, replay-on-show ---
//
// A hidden single-view session's raw PTY chunks are appended to a plain
// string buffer and NEVER handed to terminal.write() — no parse, no dirty
// marking, no render call of any kind — until the session is revealed again
// (showSession/wrapInGridCard), at which point the whole accumulated buffer
// is replayed in exactly one write() call, atomically, before the container
// becomes visible.
//
// Sync-block tracking (ESC_SYNC_START/END) does not apply to text already
// sitting in the accumulator: it existed to decide when the *live*
// write-buffering path above should call terminal.write(), so a redraw split
// across two PTY chunks wouldn't split across two writes either. A hidden
// accumulator never calls write() until reveal, so there is exactly one
// write no matter how many sync blocks the accumulated text contains —
// xterm's own DEC 2026 handling (CoreService.decPrivateModes
// .synchronizedOutput, gating RenderService until the matching end sequence
// or its own 1000ms timeout — see RenderService.ts) interprets whatever
// sync-mode transitions are embedded in the replayed text exactly as it
// would for a single huge PTY chunk, which its parser must already handle
// correctly.
//
// It DOES still apply to a live terminalWriteBuffers entry at the moment of
// a reveal: replayHiddenBuffer's drain would write that buffer's first half
// of an open sync block now and leave its remainder to a later, genuinely
// time-separated write — see isMidSyncBlock below and the guard in
// replayHiddenBuffer.
const hiddenAccumulators = new Map(); // sessionId → { raw, reset }

// Deliberately a flat cap rather than a precise scrollback→bytes conversion
// — row byte length varies wildly with ANSI overhead and there is no fixed
// avg-bytes-per-row to derive from SCROLLBACK_SINGLE. 2 MB is generous
// relative to a typical full-screen TUI redraw (order of a few KB to a few
// tens of KB), so the safe-marker cut below is expected to handle the
// overwhelming majority of overflow events — trimHiddenBuffer's reset+tail
// fallback exists for the rare non-TUI full-throughput dump.
const HIDDEN_BUFFER_MAX_LEN = 2 * 1024 * 1024; // ~2 MB per hidden session

// Full-redraw markers: once one of these has been written, everything
// visible afterward is rebuilt from scratch, so cutting the buffer to start
// exactly here loses no visual state (scrollback fidelity for content that
// was NEVER shown is an accepted trade for the memory bound). ESC can never
// appear as a parameter/intermediate byte of an unrelated CSI sequence (its
// 0x1b code point falls outside every CSI byte range), so a literal
// substring match cannot be produced by an unrelated, longer CSI sequence.
// The one acknowledged gap: an OSC payload (e.g. a hyperlink title) can carry
// arbitrary bytes and could in principle contain one of these sequences
// verbatim — accepted as vanishingly unlikely for real shell/TUI output
// rather than implemented against, matching this function's "not a full VT
// parser" scope (see findEscapeSequenceEnd below).
const SAFE_REDRAW_MARKERS = [
  '\x1b[?1049h', // enter alt screen
  '\x1b[?1049l', // leave alt screen
  '\x1b[2J',     // erase entire screen
  '\x1b[3J',     // erase entire screen + scrollback
];

// Index of the START of the LAST occurrence of any safe redraw marker in
// str, or -1 if none is present.
function findLastSafeRedrawMarker(str) {
  let best = -1;
  for (const marker of SAFE_REDRAW_MARKERS) {
    const idx = str.lastIndexOf(marker);
    if (idx > best) best = idx;
  }
  return best;
}

// Given str[escIndex] === ESC, return the index right after the escape
// sequence that starts there, or -1 if it is not terminated before the end
// of the string. Intentionally narrow (CSI, string-type OSC/DCS/APC/PM, and
// generic 2-byte escapes) — this only needs to be complete enough that a cut
// index it reports as "after" this sequence is never inside it; xterm's own
// parser does the real semantic parsing once the replayed text reaches it.
function findEscapeSequenceEnd(str, escIndex) {
  const next = str[escIndex + 1];
  if (next === undefined) return -1; // ESC is the last character — incomplete
  if (next === '[') {
    // CSI: ESC [ params(0x30-0x3f)* intermediates(0x20-0x2f)* final(0x40-0x7e)
    let i = escIndex + 2;
    while (i < str.length) {
      const code = str.charCodeAt(i);
      if (code >= 0x40 && code <= 0x7e) return i + 1;
      i++;
    }
    return -1;
  }
  if (next === ']' || next === 'P' || next === '_' || next === '^') {
    // String-type sequences that can carry an arbitrary-length payload:
    // OSC (]), DCS (P — this is the shape sixel image data arrives as),
    // APC (_), PM (^). All are terminated by ST (ESC \). OSC additionally
    // tolerates a bare BEL terminator — a long-standing xterm convention for
    // window-title OSCs — that DCS/APC/PM have no equivalent for, so BEL
    // only closes the sequence when next === ']'.
    let i = escIndex + 2;
    while (i < str.length) {
      if (next === ']' && str.charCodeAt(i) === 0x07) return i + 1;
      if (str[i] === '\x1b' && str[i + 1] === '\\') return i + 2;
      i++;
    }
    return -1;
  }
  // Any other single-character escape (ESC c, ESC 7, ESC =, ESC >, ...)
  return escIndex + 2;
}

// A lone low surrogate (0xDC00-0xDFFF) is never a valid start of text on its
// own — it only means something paired right after a high surrogate (e.g.
// one half of an emoji). A cut that lands exactly between the two halves
// would hand xterm a malformed lead character; step past it if found.
function skipLoneLowSurrogate(str, index) {
  if (index >= str.length) return index;
  const code = str.charCodeAt(index);
  return (code >= 0xdc00 && code <= 0xdfff) ? index + 1 : index;
}

// Smallest index >= index that does not fall strictly inside an escape
// sequence, and does not start with a lone low surrogate — used to move a
// naive byte-budget cut point forward so it never splits one of either. An
// escape sequence left unterminated at the end of the string is treated as
// extending to the end of the string (nothing after it is a safe place to
// start either).
function advanceToAnsiSafeBoundary(str, index) {
  if (index <= 0) return 0;
  if (index >= str.length) return str.length;
  let pos = 0;
  while (pos < str.length) {
    if (pos >= index) return skipLoneLowSurrogate(str, index); // reached the target at a clean boundary
    if (str[pos] !== '\x1b') { pos++; continue; }
    const end = findEscapeSequenceEnd(str, pos);
    const seqEnd = end === -1 ? str.length : end;
    if (index > pos && index < seqEnd) return skipLoneLowSurrogate(str, seqEnd); // target lands inside — skip past it
    pos = seqEnd;
  }
  return skipLoneLowSurrogate(str, index);
}

// Bounds a hidden session's accumulated buffer, dropping the OLDEST bytes on
// overflow but only at a point cheap to resume visually from. Preferred: the
// last safe redraw marker in the buffer (see findLastSafeRedrawMarker) — the
// kept tail is then self-contained. Fallback (no marker, or the marker still
// doesn't fit maxLen): keep the newest maxLen characters, advanced to the
// nearest ANSI-safe boundary, and flag reset:true so the caller resets the
// terminal before replay — without a marker to anchor on, the tail's
// cursor/attribute state can no longer be assumed correct.
function trimHiddenBuffer(raw, maxLen) {
  if (raw.length <= maxLen) return { data: raw, reset: false };

  const markerIdx = findLastSafeRedrawMarker(raw);
  if (markerIdx !== -1) {
    const fromMarker = raw.slice(markerIdx);
    if (fromMarker.length <= maxLen) {
      return { data: fromMarker, reset: false };
    }
  }

  const naiveStart = Math.max(0, raw.length - maxLen);
  const safeStart = advanceToAnsiSafeBoundary(raw, naiveStart);
  return { data: raw.slice(safeStart), reset: true };
}

// A session can still have a pending terminalWriteBuffers entry at the
// moment it becomes hidden — an ordinary <=33ms flush, or a sync block whose
// SYNC_BUFFER_TIMEOUT (500ms) safety timer is still armed. Left alone, that
// leftover buffer and the hidden accumulator would become two independently
// scheduled queues for the same session: if the session is shown again
// before the leftover's own timer/rAF fires, replayHiddenBuffer paints the
// newer accumulator content, and the leftover then fires on its own
// schedule — possibly after the reveal — painting older content AFTER
// newer content already appeared, inverting visible order.
//
// Called from handleTerminalData's hidden branch, unconditionally and on
// every chunk: the first call after a session becomes hidden migrates
// whatever's left (cancelling its rafId/timerId so it can never fire
// flushTerminalBuffer independently), and every call after that is a cheap
// no-op (terminalWriteBuffers.get returns undefined once drained). This
// makes the exact transition moment irrelevant — it doesn't matter whether a
// session became hidden via a single-view switch or a grid close, only that
// no new data can reach the accumulator without the leftover being folded in
// first.
//
// buf.syncDepth is intentionally dropped, not carried over: an unterminated
// sync block in the drained text replays exactly like any other embedded
// sync-mode transition once the whole accumulator is written in one shot on
// reveal (see the "Hidden-session full suspend" comment above) — there is
// nothing left to track once the drained bytes are just more accumulated
// text. That reasoning only holds when the drained bytes ARE eventually
// written as part of a single replay — the reveal path therefore checks
// isMidSyncBlock before calling this (see replayHiddenBuffer); this call
// site (hidden branch) must stay unguarded, or the leftover's own timer
// would fire independently of the accumulator again (the F1 inversion this
// drain exists to prevent).
function drainLiveBufferIntoHiddenAccumulator(sessionId) {
  const buf = terminalWriteBuffers.get(sessionId);
  if (!buf) return;
  cancelAnimationFrame(buf.rafId);
  clearTimeout(buf.timerId);
  terminalWriteBuffers.delete(sessionId);
  if (buf.chunks.length === 0) return;
  let acc = hiddenAccumulators.get(sessionId);
  if (!acc) {
    acc = { raw: '', reset: false };
    hiddenAccumulators.set(sessionId, acc);
  }
  acc.raw = buf.chunks.join('') + acc.raw; // leftover is older — goes first
}

function appendToHiddenAccumulator(sessionId, data) {
  let acc = hiddenAccumulators.get(sessionId);
  if (!acc) {
    acc = { raw: '', reset: false };
    hiddenAccumulators.set(sessionId, acc);
  }
  acc.raw += data;
  if (acc.raw.length > HIDDEN_BUFFER_MAX_LEN) {
    const trimmed = trimHiddenBuffer(acc.raw, HIDDEN_BUFFER_MAX_LEN);
    acc.raw = trimmed.data;
    acc.reset = trimmed.reset;
  }
}

// Whether sessionId has live data buffered mid an unclosed synchronized-
// update block (ESC_SYNC_START seen, ESC_SYNC_END not yet — buf.syncDepth
// > 0). Guards the reveal-path drain in replayHiddenBuffer below; the
// SYNC_BUFFER_TIMEOUT safety valve (armed in handleTerminalData for as long
// as syncDepth > 0) bounds how long the guard can defer, exactly as it
// bounds a block that never closes for the already-active session.
function isMidSyncBlock(sessionId) {
  const buf = terminalWriteBuffers.get(sessionId);
  return !!buf && buf.syncDepth > 0;
}

// Replay a hidden session's accumulated buffer in exactly one write() call,
// resetting the terminal first if a hard (non-safe-marker) cut happened
// somewhere in its history. Called from showSession/wrapInGridCard BEFORE
// the container becomes visible, so the reveal never shows stale content.
// A session with nothing accumulated (never received data while hidden, or
// was never hidden at all) is a cheap no-op.
//
// Also drains any leftover terminalWriteBuffers entry first — the no-new-
// data variant of the drain race fixed above: a session can go hidden with
// a pending live-buffer flush (an ordinary <=33ms flush, or a still-armed
// SYNC_BUFFER_TIMEOUT) and receive nothing further before being shown again,
// in which case handleTerminalData's hidden branch never runs and never
// gets a chance to drain it. Without this, the reveal here would paint
// nothing while that leftover buffer's own timer/rAF is still armed to fire
// independently, possibly after the container is already visible. Calling
// drainLiveBufferIntoHiddenAccumulator here is idempotent with the call in
// handleTerminalData — whichever runs first drains and deletes the entry,
// so the other is a cheap no-op — and prepends in the same order (leftover
// predates anything already accumulated).
//
// EXCEPT when that live buffer is mid an open sync block (isMidSyncBlock):
// draining it here would write the block's first half immediately and its
// remainder in a later, time-separated write once the rest of the block
// arrives on the live path — splitting one atomic TUI redraw into two
// paints. Concrete trigger: showGridView() wraps the ACTIVE session into a
// grid card too (gridViewActive is already true, so the session was never
// hidden and its live buffer is still tracking syncDepth). Deferring is
// bounded, never indefinite: handleTerminalData keeps SYNC_BUFFER_TIMEOUT
// (500ms) armed for the whole time syncDepth > 0, so the buffer flushes
// either when the block closes (syncDepth back to 0 → scheduleFlush) or at
// that safety timeout if the closing ESC_SYNC_END never arrives — the same
// two exits it has for a session that stays active. The accumulator replay
// below still runs in the deferred case; it is necessarily empty then (a
// live buffer only exists while the session is visible, and every reveal
// clears the accumulator before the session becomes visible), so order
// cannot invert.
function replayHiddenBuffer(sessionId) {
  if (!isMidSyncBlock(sessionId)) drainLiveBufferIntoHiddenAccumulator(sessionId);
  const acc = hiddenAccumulators.get(sessionId);
  hiddenAccumulators.delete(sessionId);
  if (!acc || !acc.raw) return;
  const entry = openSessions.get(sessionId);
  if (!entry) return; // destroySession may have removed it first
  if (acc.reset) entry.terminal.reset();
  entry.terminal.write(acc.raw);
}

// Entry point for PTY data (wired to window.api.onTerminalData in app.js).
// Lives here rather than app.js so the sync-block/flush interplay runs under
// the jsdom test harness — the v0.0.35 frozen-terminal bug shipped because
// this logic sat in untestable app.js.
function handleTerminalData(sessionId, data) {
  const entry = openSessions.get(sessionId);
  if (entry) {
    if (isHiddenSingleViewSession(sessionId)) {
      // Fully suspended — accumulate only, never call terminal.write().
      // drainLiveBufferIntoHiddenAccumulator folds in whatever was left
      // pending from before this session became hidden (see its own
      // comment) so there is only ever one queue per session, in order.
      drainLiveBufferIntoHiddenAccumulator(sessionId);
      appendToHiddenAccumulator(sessionId, data);
      trackActivity(sessionId, data);
      return;
    }
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

  // URI of the link currently under the cursor (set by the link hover/leave
  // callbacks below), so the right-click context menu can offer link actions.
  let hoveredLinkUri = null;

  const terminal = new Terminal({
    fontSize: 12,
    fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
    theme: TERMINAL_THEME,
    cursorBlink: false,
    scrollback: opts.scrollback ?? (gridViewActive ? SCROLLBACK_GRID : SCROLLBACK_SINGLE),
    convertEol: true,
    allowProposedApi: true,
    // A TUI that turns on full mouse tracking (CSI ?1003h) makes xterm forward every
    // drag to the application, so normal text selection is dead. Terminal.app and
    // iTerm2 let you hold Option to override that; xterm.js requires opting in.
    // Without this, selecting (and therefore copying) inside such a session is
    // impossible on macOS and Cmd+C silently leaves the previous clipboard contents
    // in place. Windows/Linux get the same escape hatch via Shift, which needs no flag.
    macOptionClickForcesSelection: true,
    linkHandler: {
      activate: (event, uri) => {
        // xterm fires link activate on any mouseup button (no guard); only act
        // on a left-click so a right-click goes to the context menu instead of
        // re-opening the link.
        if (event && typeof event.button === 'number' && event.button !== 0) return;
        if (uri.startsWith('file://') && typeof openFileInPanel === 'function') {
          try { openFileInPanel(sessionId, decodeURIComponent(new URL(uri).pathname)); } catch {}
        } else {
          window.api.openExternal(uri);
        }
      },
      hover: (_event, uri) => { hoveredLinkUri = uri; },
      leave: () => { hoveredLinkUri = null; },
      allowNonHttpProtocols: true,
    },
  });

  // OSC 52 — let the program inside the terminal set the system clipboard (this is how
  // Claude Code copies). xterm doesn't wire this up itself, so we do.
  // Route through the main process — see writeClipboard — because the renderer clipboard
  // is unreliable on Wayland.
  terminal.parser.registerOscHandler(52, (payload) => {
    let text;
    try {
      text = decodeOsc52Payload(payload);
    } catch {
      return false;
    }
    // null = read-back query or empty payload: consumed, and deliberately not
    // answered. See decodeOsc52Payload.
    if (text === null) return true;
    window.api.writeClipboard(text).catch(() => {});
    return true;
  });

  const fitAddon = new FitAddon.FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(new WebLinksAddon.WebLinksAddon((event, url) => {
    if (event && typeof event.button === 'number' && event.button !== 0) return;
    if (url.startsWith('file://') && typeof openFileInPanel === 'function') {
      try { openFileInPanel(sessionId, decodeURIComponent(new URL(url).pathname)); } catch {}
    } else {
      window.api.openExternal(url);
    }
  }, { hover: (_event, url) => { hoveredLinkUri = url; }, leave: () => { hoveredLinkUri = null; } }));
  const searchAddon = new SearchAddon.SearchAddon();
  terminal.loadAddon(searchAddon);
  terminal.loadAddon(new UnicodeGraphemesAddon.UnicodeGraphemesAddon());
  terminal.unicode.activeVersion = '15';
  // Lay the container out (without painting it) for the duration of
  // terminal.open() and the initial measurement below. .terminal-container is
  // display:none until showSession adds .visible, and xterm's CharSizeService
  // measures 0x0 in a display:none subtree — which makes
  // FitAddon.proposeDimensions() return undefined, which is precisely why the
  // PTY used to be spawned at a hard-coded 120x30. `.measuring` is
  // display:block + visibility:hidden: real layout, no paint, and the
  // container is position:absolute so no sibling reflows.
  container.classList.add('measuring');
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

  const entry = { terminal, element: container, fitAddon, searchAddon, openSearchBar, closeSearchBar, session, closed: false, webglAddon: null, lastPtySize: null, initialSize: null, stopObservingResize: null };

  // Measure NOW, before the caller spawns the PTY, so the shell is born with
  // the width it will actually be displayed at instead of 120x30. The caller
  // passes entry.initialSize to window.api.openTerminal(); when the measure
  // fails (returns null) the main process falls back to its historical
  // defaults.
  //
  // Known residual: on the very first session of a fresh window,
  // #terminal-header is still display:none, so #terminals is one header taller
  // than it will be once showSession reveals it — the measured row count is a
  // few rows high. showSession's fitAndScroll corrects it on the next frame,
  // and thanks to ptySizeChanged that correction is a single resize instead of
  // the permanent 120x30 mismatch it replaces.
  try {
    const dims = proposeFittedDimensions(entry);
    if (dims) {
      entry.initialSize = dims;
      entry.lastPtySize = dims; // set BEFORE resize() so onResize sends no IPC
      terminal.resize(dims.cols, dims.rows);
    }
  } catch {
    // Measurement is best-effort: never let it block terminal creation.
  } finally {
    container.classList.remove('measuring');
  }

  openSessions.set(sessionId, entry);
  lruTouch(sessionId);
  loadTerminalWebgl(entry);
  observeContainerResize(entry);

  // Wire up IPC (use entry.session.sessionId so fork re-keying works)
  terminal.onData(data => {
    if (data === '\x1b[I' || data === '\x1b[O') return;
    window.api.sendInput(entry.session.sessionId, data);
  });
  setupTerminalKeyBindings(terminal, container, () => entry.session.sessionId, { onFind: openSearchBar });
  setupTerminalContextMenu(container, terminal, () => entry.session.sessionId, () => hoveredLinkUri);
  setupDragAndDrop(container, () => entry.session.sessionId);
  terminal.onResize(({ cols, rows }) => {
    // Only tell the PTY when the size really moved — see ptySizeChanged.
    if (!ptySizeChanged(entry, cols, rows)) return;
    window.api.resizeTerminal(entry.session.sessionId, cols, rows);
  });
  terminal.onTitleChange(title => {
    entry.ptyTitle = title;
    if (activeSessionId === entry.session.sessionId) updatePtyTitle();
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
    // When the glyph texture atlas is rebuilt or extended (e.g. it overflows
    // after Claude emits many distinct box-drawing/unicode glyphs), cells
    // rendered earlier keep pointing at stale atlas slots and show ghosted or
    // garbled glyphs. Repaint all visible rows so they re-resolve against the
    // new atlas.
    const repaintVisible = () => entry.terminal.refresh(0, entry.terminal.rows - 1);
    webglAddon.onChangeTextureAtlas(repaintVisible);
    webglAddon.onAddTextureAtlasCanvas(repaintVisible);
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
  // Tear down any open right-click menu for this session before disposing the
  // terminal — its action closures hold the (about-to-be-disposed) xterm.
  if (typeof closeTerminalContextMenuForSession === 'function') closeTerminalContextMenuForSession(sessionId);
  // Drop the container ResizeObserver (and any pending debounce) first: an
  // observer that outlives its entry would keep firing safeFit on a disposed
  // terminal, and leaking one per session is exactly the kind of standing cost
  // this change is supposed to avoid.
  if (entry.stopObservingResize) entry.stopObservingResize();
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
  hiddenAccumulators.delete(sessionId); // no replay target left to flush into
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
  // Captured before setActiveSession() below overwrites the global — this is
  // the session single view is switching AWAY from.
  const previousActiveSessionId = activeSessionId;

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
    // Only one terminal is ever visible in single view — suspend the WebGL
    // context of whatever we're switching away from. This is the single-view
    // equivalent of the per-card suspend/restore grid-view.js already does
    // via gridCardObserver; guarded so re-showing the already-active session
    // doesn't tear down and immediately reload the context it keeps using.
    if (previousActiveSessionId && previousActiveSessionId !== sessionId) {
      suspendTerminalWebgl(previousActiveSessionId);
    }
    if (entry) {
      // The incoming session may have accumulated a hidden buffer while it
      // wasn't visible (see appendToHiddenAccumulator) — replay it now, in
      // one atomic write, before the container becomes visible.
      replayHiddenBuffer(sessionId);
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

// Expose pure key-handling predicates to Node for unit testing. No-op in the
// browser, where this file is loaded as a plain <script> and `module` is undefined.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    isImeComposing, shouldSendSpaceDirectly, decodeOsc52Payload,
    findLastSafeRedrawMarker, findEscapeSequenceEnd, advanceToAnsiSafeBoundary, trimHiddenBuffer,
    skipLoneLowSurrogate,
  };
}
