// Diagnostics panel: the debug-mode switch and the trace files it produces.
// Rendered inside the global settings viewer by settings-panel.js.
// See docs/activity-trace.md and .ai/contexts/ipc-bridge.md "Activity trace".

let activityTracePanel = null;
// The list the Diagnostics section last rendered into, so a delete made from
// the viewer's own toolbar refreshes it too.
let activityTraceListEl = null;

function activityTraceViewerEl() {
  return document.getElementById('activity-trace-viewer');
}

function refreshActivityTraceList() {
  if (activityTraceListEl && activityTraceListEl.isConnected) {
    renderActivityTraceFiles(activityTraceListEl);
  }
}

function getActivityTracePanel() {
  if (activityTracePanel) return activityTracePanel;
  const container = activityTraceViewerEl();
  if (!container || typeof ViewerPanel !== 'function') return null;
  activityTracePanel = new ViewerPanel(container, {
    copyPath: true, copyContent: true,
    language: 'auto', storageKey: 'activityTracePreviewMode',
    format: true,
    onDelete: async (filePath) => {
      let result;
      try {
        result = await window.api.deleteActivityTraceFile(filePath);
      } catch (err) {
        return { ok: false, error: (err && err.message) || String(err) };
      }
      if (result && result.ok) {
        container.style.display = 'none';
        refreshActivityTraceList();
      }
      return result;
    },
    onClose: () => { container.style.display = 'none'; },
  });
  return activityTracePanel;
}

function formatTraceSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function formatTraceDate(iso) {
  if (typeof formatDate === 'function') {
    try { return formatDate(new Date(iso)); } catch { /* fall through */ }
  }
  return new Date(iso).toLocaleString();
}

async function openActivityTraceFile(file) {
  const panel = getActivityTracePanel();
  if (!panel) return;
  let result;
  try {
    result = await window.api.readActivityTraceFile(file.filePath);
  } catch (err) {
    result = { ok: false, error: (err && err.message) || String(err) };
  }
  if (!result || !result.ok) {
    window.alert(`Could not read ${file.name}: ${(result && result.error) || 'unknown error'}`);
    return;
  }
  if (typeof hideAllViewers === 'function') hideAllViewers();
  if (typeof terminalArea !== 'undefined' && terminalArea) terminalArea.style.display = 'none';
  if (typeof placeholder !== 'undefined' && placeholder) placeholder.style.display = 'none';
  const container = activityTraceViewerEl();
  if (container) container.style.display = 'flex';
  const title = result.truncated
    ? `${file.name} — last ${formatTraceSize(result.shown)} of ${formatTraceSize(result.size)}`
    : file.name;
  panel.open(title, file.filePath, result.content);
}

function buildActivityTraceRow(file, listEl) {
  const row = document.createElement('div');
  row.className = 'activity-trace-file';

  const info = document.createElement('div');
  info.className = 'activity-trace-file-info';

  const name = document.createElement('div');
  name.className = 'activity-trace-file-name';
  name.textContent = file.name;
  if (file.current) {
    const badge = document.createElement('span');
    badge.className = 'activity-trace-current';
    badge.textContent = 'recording';
    name.appendChild(badge);
  }

  const meta = document.createElement('div');
  meta.className = 'activity-trace-file-meta';
  meta.textContent = `${formatTraceSize(file.size)} · ${formatTraceDate(file.modified)}`;

  info.appendChild(name);
  info.appendChild(meta);

  const actions = document.createElement('div');
  actions.className = 'activity-trace-file-actions';

  const openBtn = document.createElement('button');
  openBtn.className = 'settings-check-updates-btn';
  openBtn.textContent = 'Open';
  openBtn.addEventListener('click', () => openActivityTraceFile(file));

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'settings-check-updates-btn activity-trace-delete-btn';
  deleteBtn.textContent = 'Delete';
  deleteBtn.addEventListener('click', async () => {
    if (!window.confirm(`Delete "${file.name}"?\n\nThis cannot be undone.`)) return;
    deleteBtn.disabled = true;
    let result;
    try {
      result = await window.api.deleteActivityTraceFile(file.filePath);
    } catch (err) {
      result = { ok: false, error: (err && err.message) || String(err) };
    } finally {
      deleteBtn.disabled = false;
    }
    if (result && result.ok) {
      renderActivityTraceFiles(listEl);
    } else {
      window.alert(`Delete failed: ${(result && result.error) || 'unknown error'}`);
    }
  });

  actions.appendChild(openBtn);
  actions.appendChild(deleteBtn);
  row.appendChild(info);
  row.appendChild(actions);
  return row;
}

async function renderActivityTraceFiles(listEl) {
  if (!listEl) return;
  activityTraceListEl = listEl;
  let files = [];
  try { files = (await window.api.listActivityTraceFiles()) || []; } catch { files = []; }
  listEl.innerHTML = '';
  if (!files.length) {
    const empty = document.createElement('div');
    empty.className = 'activity-trace-empty';
    empty.textContent = 'No trace files yet.';
    listEl.appendChild(empty);
    return;
  }
  for (const file of files) listEl.appendChild(buildActivityTraceRow(file, listEl));
}

function wireActivityTraceToggle(inputEl, listEl) {
  if (!inputEl) return;
  inputEl.addEventListener('change', async () => {
    inputEl.disabled = true;
    try {
      const state = await window.api.setActivityTraceEnabled(inputEl.checked);
      if (state && typeof state.enabled === 'boolean') inputEl.checked = state.enabled;
    } catch {
      inputEl.checked = !inputEl.checked;
    } finally {
      inputEl.disabled = false;
    }
    await renderActivityTraceFiles(listEl);
  });
}

window.openActivityTraceFile = openActivityTraceFile;
window.renderActivityTraceFiles = renderActivityTraceFiles;
window.wireActivityTraceToggle = wireActivityTraceToggle;
