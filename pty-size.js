// Normalisation of the terminal size the renderer asks a PTY to be spawned
// with.
//
// Why this exists: the PTY used to be spawned at a hard-coded 120x30 and only
// learned its real geometry from the first terminal-resize IPC. Until then the
// shell wrapped its output against a width the display did not have, which is
// what makes a TUI's cursor land one line off. The renderer now measures its
// container before asking for the spawn (see proposeFittedDimensions in
// public/terminal-manager.js) and passes the result here.
//
// The value crosses an IPC boundary, so it is treated as untrusted input:
// anything missing, non-finite or out of range falls back to the historical
// defaults rather than reaching node-pty.

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;

// Lower bounds match what xterm itself enforces (FitAddon never proposes fewer
// than 2 cols / 1 row). Upper bounds are a sanity ceiling: no real display
// reaches them, and node-pty/ConPTY allocate a buffer proportional to them.
const MIN_COLS = 2;
const MIN_ROWS = 1;
const MAX_COLS = 1000;
const MAX_ROWS = 500;

function coerce(value, min, max, fallback) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < min || i > max) return fallback;
  return i;
}

// Returns { cols, rows } — always usable, never throws.
// `size` is whatever the renderer sent: { cols, rows }, null, or garbage.
function normalizePtySize(size) {
  if (!size || typeof size !== 'object') {
    return { cols: DEFAULT_COLS, rows: DEFAULT_ROWS };
  }
  return {
    cols: coerce(size.cols, MIN_COLS, MAX_COLS, DEFAULT_COLS),
    rows: coerce(size.rows, MIN_ROWS, MAX_ROWS, DEFAULT_ROWS),
  };
}

module.exports = {
  normalizePtySize,
  DEFAULT_COLS,
  DEFAULT_ROWS,
  MIN_COLS,
  MIN_ROWS,
  MAX_COLS,
  MAX_ROWS,
};
