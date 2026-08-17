// --- Terminal right-click context menu ---
//
// xterm's built-in `contextmenu` handler (rightClickHandler in @xterm/xterm)
// moves the hidden helper textarea under the cursor and fills it with the
// current selection — on Linux this surfaces as a stray "paste" into the
// prompt. xterm's link service also fires link `activate` on ANY mouseup
// (no button guard), so a right-click over a file link re-opens it. We
// intercept `contextmenu` in capture phase (see setupTerminalContextMenu in
// terminal-manager.js) so neither default runs, then apply the user's chosen
// behavior.
//
// Behavior is gated by the global `terminalRightClickMode`, persisted as the
// `terminalRightClick` global setting and pushed live via
// window._applyTerminalRightClick:
//   'menu'    → show this context menu (default)
//   'paste'   → right-click pastes the clipboard (PuTTY-style), no menu
//   'default' → leave xterm's native right-click behavior untouched
//   'none'    → right-click does nothing
//
// Depends on globals: openFileInPanel (file-panel.js), window.api.
// Pure helpers (fileUriToPath / classifyLinkUri / buildTerminalMenuItems) are
// unit-tested; showTerminalContextMenu does the DOM rendering.

let terminalRightClickMode = 'menu';

// Convert a file:// URI to a filesystem path, or null if it isn't one.
function fileUriToPath(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('file://')) return null;
  try {
    return decodeURIComponent(new URL(uri).pathname);
  } catch {
    return null;
  }
}

// Classify the link (if any) under the cursor into the actions we can offer.
function classifyLinkUri(uri) {
  if (typeof uri !== 'string' || !uri) return { kind: null };
  if (uri.startsWith('file://')) {
    const path = fileUriToPath(uri);
    return path ? { kind: 'file', path } : { kind: null };
  }
  if (/^https?:\/\//i.test(uri)) return { kind: 'url', url: uri };
  return { kind: null };
}

// Build the ordered list of menu items for a right-click. Returns an array of
// { id, label } entries; a `null` entry marks a separator. Pure — the caller
// (runTerminalMenuAction) maps each id to an effect.
function buildTerminalMenuItems({ linkUri, hasSelection }) {
  const items = [];
  const link = classifyLinkUri(linkUri);
  if (link.kind === 'file') {
    items.push({ id: 'open-panel', label: 'Open in panel' });
    items.push({ id: 'open-system', label: 'Open in system editor' });
    items.push({ id: 'copy-path', label: 'Copy path' });
  } else if (link.kind === 'url') {
    items.push({ id: 'open-browser', label: 'Open in browser' });
    items.push({ id: 'copy-link', label: 'Copy link' });
  }
  if (items.length) items.push(null); // separator before the generic actions
  if (hasSelection) items.push({ id: 'copy', label: 'Copy' });
  items.push({ id: 'paste', label: 'Paste' });
  items.push({ id: 'select-all', label: 'Select all' });
  return items;
}

// Execute the effect for a chosen menu item.
async function runTerminalMenuAction(id, ctx) {
  const { terminal, sessionId, linkUri } = ctx;
  const link = classifyLinkUri(linkUri);
  switch (id) {
    case 'open-panel':
      if (link.kind === 'file' && typeof openFileInPanel === 'function') {
        openFileInPanel(sessionId, link.path);
      }
      break;
    case 'open-system':
      if (link.kind === 'file') window.api.openPath(link.path);
      break;
    case 'copy-path':
      if (link.kind === 'file') window.api.writeClipboard(link.path);
      break;
    case 'open-browser':
      if (link.kind === 'url') window.api.openExternal(link.url);
      break;
    case 'copy-link':
      if (link.kind === 'url') window.api.writeClipboard(link.url);
      break;
    case 'copy':
      if (terminal.hasSelection()) window.api.writeClipboard(terminal.getSelection());
      break;
    case 'paste':
      try {
        const text = await window.api.readClipboard();
        if (text) terminal.paste(text);
      } catch { /* clipboard unavailable — no-op */ }
      break;
    case 'select-all':
      terminal.selectAll();
      break;
  }
}

// --- Menu DOM (single instance at a time) ---
let activeTerminalMenu = null;
let activeTerminalMenuSessionId = null;

function onTerminalMenuClickOutside(e) {
  if (activeTerminalMenu && !activeTerminalMenu.contains(e.target)) closeTerminalContextMenu();
}
function onTerminalMenuKey(e) {
  if (e.key === 'Escape') closeTerminalContextMenu();
}

function closeTerminalContextMenu() {
  if (activeTerminalMenu) {
    activeTerminalMenu.remove();
    activeTerminalMenu = null;
    activeTerminalMenuSessionId = null;
  }
  document.removeEventListener('mousedown', onTerminalMenuClickOutside, true);
  document.removeEventListener('keydown', onTerminalMenuKey, true);
}

// Close the menu if it belongs to a session being torn down — otherwise its
// button closures would call paste()/selectAll() on a disposed xterm instance.
// Called from destroySession (terminal-manager.js).
function closeTerminalContextMenuForSession(sessionId) {
  if (activeTerminalMenu && activeTerminalMenuSessionId === sessionId) closeTerminalContextMenu();
}

function showTerminalContextMenu(event, ctx) {
  closeTerminalContextMenu();
  const hasSelection = !!(ctx.terminal && ctx.terminal.hasSelection && ctx.terminal.hasSelection());
  const items = buildTerminalMenuItems({ linkUri: ctx.linkUri, hasSelection });

  const menu = document.createElement('div');
  menu.className = 'popover terminal-context-menu';
  for (const item of items) {
    if (item === null) {
      const sep = document.createElement('div');
      sep.className = 'popover-separator';
      menu.appendChild(sep);
      continue;
    }
    const btn = document.createElement('button');
    btn.className = 'popover-option';
    btn.textContent = item.label;
    btn.addEventListener('click', () => {
      closeTerminalContextMenu();
      runTerminalMenuAction(item.id, ctx);
    });
    menu.appendChild(btn);
  }

  document.body.appendChild(menu);

  // Position at the cursor, flipping back inside the viewport on overflow.
  menu.style.position = 'fixed';
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  let x = event.clientX;
  let y = event.clientY;
  if (x + mw > window.innerWidth) x = Math.max(0, window.innerWidth - mw - 4);
  if (y + mh > window.innerHeight) y = Math.max(0, window.innerHeight - mh - 4);
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';

  activeTerminalMenu = menu;
  activeTerminalMenuSessionId = ctx.sessionId;
  // Defer listener registration so the originating event doesn't immediately close it.
  setTimeout(() => {
    document.addEventListener('mousedown', onTerminalMenuClickOutside, true);
    document.addEventListener('keydown', onTerminalMenuKey, true);
  }, 0);
}

// Wire a terminal container's right-click to the configured behavior. Called
// from createTerminalEntry. getHoveredLinkUri returns the URI of the link the
// cursor is currently over (tracked via the link hover/leave callbacks), or
// null.
function setupTerminalContextMenu(container, terminal, getSessionId, getHoveredLinkUri) {
  container.addEventListener('contextmenu', (e) => {
    if (terminalRightClickMode === 'default') return; // let xterm handle it natively
    // Capture-phase preventDefault + stopPropagation: xterm's contextmenu
    // listener is on a descendant element, so stopping here keeps it from
    // running (and suppresses any native menu).
    e.preventDefault();
    e.stopPropagation();
    if (terminalRightClickMode === 'none') return;
    if (terminalRightClickMode === 'paste') {
      window.api.readClipboard().then((t) => { if (t) terminal.paste(t); }).catch(() => {});
      return;
    }
    // 'menu' (default)
    showTerminalContextMenu(e, {
      terminal,
      sessionId: getSessionId(),
      linkUri: getHoveredLinkUri(),
    });
  }, { capture: true });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    fileUriToPath,
    classifyLinkUri,
    buildTerminalMenuItems,
    runTerminalMenuAction,
    showTerminalContextMenu,
    closeTerminalContextMenu,
    closeTerminalContextMenuForSession,
    setupTerminalContextMenu,
    // Test seam: in the renderer the mode is a shared global set by app.js's
    // window._applyTerminalRightClick; under require() it's module-scoped.
    _setTerminalRightClickMode: (m) => { terminalRightClickMode = m; },
  };
}
