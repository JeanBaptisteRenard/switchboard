// --- Configurable keyboard shortcuts ---
// Single source of truth for the (re-bindable) session-navigation shortcuts.
//
// Loaded as a classic <script> in the renderer (exposes globals) AND require()-d
// by node tests (module.exports). Keep this file free of DOM/browser APIs.
//
// A "binding" describes a modifier combo plus, for the 'key' family, a literal
// key. The base key(s) of each action are fixed by its `family`:
//   arrows   → ArrowLeft/Right/Up/Down   (session/grid navigation)
//   brackets → [ and ]                    (previous/next session)
//   key      → a single literal key       (e.g. grid toggle = G)
// The user customises the *modifiers*; `primary` is Cmd on macOS / Ctrl elsewhere.

const DEFAULT_SHORTCUTS = {
  // Ctrl/Cmd+Shift+Arrows — moved off bare Ctrl+Arrows so the terminal keeps
  // word-jump (Ctrl+Left/Right) for editing. Shift (not Alt) avoids the
  // Ctrl+Alt+Arrow workspace-switch binding common on Linux desktops.
  sessionNavArrows: { primary: true, alt: false, shift: true },
  // Ctrl/Cmd+Shift+[ / ] — never conflicted with terminal editing, kept as-is.
  sessionNavBrackets: { primary: true, alt: false, shift: true },
  // Ctrl/Cmd+Shift+G — toggle the grid overview.
  gridToggle: { primary: true, alt: false, shift: true, key: 'g' },
};

// Metadata for rendering the settings UI and resolving each action's key family.
const SHORTCUT_DEFS = [
  {
    id: 'sessionNavArrows',
    label: 'Navigate sessions / grid',
    description: 'Move between sessions (single view) or between cells (grid view)',
    family: 'arrows',
  },
  {
    id: 'sessionNavBrackets',
    label: 'Previous / next session',
    description: 'Cycle to the previous or next session',
    family: 'brackets',
  },
  {
    id: 'gridToggle',
    label: 'Toggle grid view',
    description: 'Show or hide the session grid overview',
    family: 'key',
  },
];

function getDef(id) {
  return SHORTCUT_DEFS.find((d) => d.id === id) || null;
}

// Merge a stored (possibly partial / untrusted) shortcuts object over the
// defaults, keeping only the fields each binding is allowed to carry.
function normalizeShortcuts(stored) {
  const out = {};
  for (const def of SHORTCUT_DEFS) {
    const base = DEFAULT_SHORTCUTS[def.id];
    const s = (stored && typeof stored === 'object' && stored[def.id]) || null;
    const b = {
      primary: s && typeof s.primary === 'boolean' ? s.primary : base.primary,
      alt: s && typeof s.alt === 'boolean' ? s.alt : base.alt,
      shift: s && typeof s.shift === 'boolean' ? s.shift : base.shift,
    };
    if (def.family === 'key') {
      b.key = s && typeof s.key === 'string' && s.key.length === 1
        ? s.key.toLowerCase()
        : base.key;
    }
    out[def.id] = b;
  }
  return out;
}

// Which physical-key family does this keyboard event belong to?
function keyFamily(e) {
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return 'arrows';
  if (e.code === 'BracketLeft' || e.code === 'BracketRight') return 'brackets';
  return 'key';
}

function modifiersMatch(binding, e, isMac) {
  const primary = isMac ? e.metaKey : e.ctrlKey;
  const secondary = isMac ? e.ctrlKey : e.metaKey; // cross-modifier must be off
  if (secondary) return false;
  return (
    !!binding.primary === !!primary &&
    !!binding.alt === !!e.altKey &&
    !!binding.shift === !!e.shiftKey
  );
}

// Does this event trigger the given action under the current bindings?
function matchShortcut(id, e, isMac, shortcuts) {
  const def = getDef(id);
  if (!def) return false;
  const sc = (shortcuts && shortcuts[id]) || DEFAULT_SHORTCUTS[id];
  if (!modifiersMatch(sc, e, isMac)) return false;
  if (def.family === 'arrows') return keyFamily(e) === 'arrows';
  if (def.family === 'brackets') return keyFamily(e) === 'brackets';
  if (def.family === 'key') {
    const want = (sc.key || DEFAULT_SHORTCUTS[id].key || '').toLowerCase();
    return (e.key || '').toLowerCase() === want;
  }
  return false;
}

// Is this event any session-navigation shortcut (arrows or brackets)?
// Used by xterm to block the key without the terminal acting on it.
function isSessionNavShortcut(e, isMac, shortcuts) {
  return (
    matchShortcut('sessionNavArrows', e, isMac, shortcuts) ||
    matchShortcut('sessionNavBrackets', e, isMac, shortcuts)
  );
}

// Human-readable label, e.g. "Ctrl+Alt+←/→" or "Cmd+Shift+[ / ]".
function formatBinding(id, isMac, shortcuts) {
  const def = getDef(id);
  if (!def) return '';
  const sc = (shortcuts && shortcuts[id]) || DEFAULT_SHORTCUTS[id];
  const parts = [];
  if (sc.primary) parts.push(isMac ? 'Cmd' : 'Ctrl');
  if (sc.alt) parts.push(isMac ? 'Option' : 'Alt');
  if (sc.shift) parts.push('Shift');
  if (def.family === 'arrows') parts.push('←/→/↑/↓');
  else if (def.family === 'brackets') parts.push('[ / ]');
  else parts.push((sc.key || DEFAULT_SHORTCUTS[id].key || '').toUpperCase());
  return parts.join('+');
}

// Build a binding from a captured keydown event (for the settings rebind UI).
// Returns null while the chord is incomplete (only modifiers, or no modifier,
// or a 'key'-family action without a literal key yet).
function captureBinding(e, def, isMac) {
  if (['Control', 'Alt', 'Shift', 'Meta', 'CapsLock'].includes(e.key)) return null;
  // The cross-modifier (Ctrl on mac / Meta elsewhere) isn't representable in a
  // binding, and matchShortcut rejects events that hold it — so refuse to capture
  // a combo that includes it (would otherwise produce an unmatchable binding).
  const secondary = isMac ? e.ctrlKey : e.metaKey;
  if (secondary) return null;
  const primary = isMac ? e.metaKey : e.ctrlKey;
  const binding = { primary: !!primary, alt: !!e.altKey, shift: !!e.shiftKey };
  // Require at least one modifier so we never shadow a bare arrow / letter.
  if (!binding.primary && !binding.alt && !binding.shift) return null;
  if (def.family === 'key') {
    if (e.key && e.key.length === 1) binding.key = e.key.toLowerCase();
    else return null;
  }
  return binding;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    DEFAULT_SHORTCUTS,
    SHORTCUT_DEFS,
    normalizeShortcuts,
    keyFamily,
    matchShortcut,
    isSessionNavShortcut,
    formatBinding,
    captureBinding,
  };
}
