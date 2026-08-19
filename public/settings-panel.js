// Settings panel component
// Manages the global and project settings viewer UI.

(function () {
  const settingsViewer = document.getElementById('settings-viewer');
  const settingsViewerTitle = document.getElementById('settings-viewer-title');
  const settingsViewerBody = document.getElementById('settings-viewer-body');

  function closeSettingsViewer() {
    settingsViewer.style.display = 'none';
    const terminalArea = document.getElementById('terminal-area');
    const terminalHeader = document.getElementById('terminal-header');
    const placeholder = document.getElementById('placeholder');
    const gridViewActive = localStorage.getItem('gridViewActive') === '1';
    const activeSessionId = sessionStorage.getItem('activeSessionId') || null;
    // Check if there's an active session with an open terminal
    if (activeSessionId && window._openSessions && window._openSessions.has(activeSessionId)) {
      terminalArea.style.display = '';
      terminalHeader.style.display = '';
    } else if (gridViewActive) {
      terminalArea.style.display = '';
    } else {
      placeholder.style.display = '';
    }
  }

  async function openSettingsViewer(scope, projectPath) {
    const isProject = scope === 'project';
    const settingsKey = isProject ? 'project:' + projectPath : 'global';
    const current = (await window.api.getSetting(settingsKey)) || {};
    const globalSettings = isProject ? ((await window.api.getSetting('global')) || {}) : {};

    const shortName = isProject
      ? shortProjectPath(projectPath)
      : 'Global';

    settingsViewerTitle.textContent = (isProject ? 'Project Settings — ' : 'Global Settings — ') + shortName;

    // Show settings viewer, hide others
    document.getElementById('placeholder').style.display = 'none';
    document.getElementById('terminal-area').style.display = 'none';
    document.getElementById('plan-viewer').style.display = 'none';
    document.getElementById('stats-viewer').style.display = 'none';
    document.getElementById('memory-viewer').style.display = 'none';
    document.getElementById('jsonl-viewer').style.display = 'none';
    settingsViewer.style.display = 'flex';

    function useGlobalCheckbox(fieldName) {
      if (!isProject) return '';
      const useGlobal = current[fieldName] === undefined || current[fieldName] === null;
      return `<label class="settings-use-global"><input type="checkbox" data-field="${fieldName}" class="use-global-cb" ${useGlobal ? 'checked' : ''}> Use global default</label>`;
    }

    function fieldValue(fieldName, fallback) {
      if (isProject && (current[fieldName] === undefined || current[fieldName] === null)) {
        return globalSettings[fieldName] !== undefined ? globalSettings[fieldName] : fallback;
      }
      return current[fieldName] !== undefined ? current[fieldName] : fallback;
    }

    function fieldDisabled(fieldName) {
      if (!isProject) return '';
      return (current[fieldName] === undefined || current[fieldName] === null) ? 'disabled' : '';
    }

    const permModeValue = fieldValue('permissionMode', '');
    const worktreeValue = fieldValue('worktree', false);
    const worktreeNameValue = fieldValue('worktreeName', '');
    const chromeValue = fieldValue('chrome', false);
    const sandboxValue = fieldValue('sandbox', false);
    const isLinux = window.api.platform === 'linux';
    const preLaunchValue = fieldValue('preLaunchCmd', '');
    const addDirsValue = fieldValue('addDirs', '');
    const visCountValue = fieldValue('visibleSessionCount', 10);
    const maxAgeValue = fieldValue('sessionMaxAgeDays', 3);
    const themeValue = fieldValue('terminalTheme', 'switchboard');
    const rightClickValue = fieldValue('terminalRightClick', 'menu');
    const restoreStartupValue = fieldValue('restoreOnStartup', 'ask');
    const mcpEmulationValue = fieldValue('mcpEmulation', true);
    const autoUpdateValue = fieldValue('autoUpdate', true);
    const shellProfileValue = fieldValue('shellProfile', 'auto');

    // Working copy of the (global-only) re-bindable keyboard shortcuts.
    let scShortcuts = normalizeShortcuts(isProject ? null : current.shortcuts);
    const scIsMac = typeof isMac !== 'undefined' ? isMac : /Mac|iPhone|iPad/.test(navigator.platform);

    // Discover available shell profiles
    let shellProfiles = [];
    try { shellProfiles = await window.api.getShellProfiles(); } catch {};

    settingsViewerBody.innerHTML = `
    <div class="settings-form">
      <div class="settings-section">
        <div class="settings-section-title">Claude CLI Options</div>

        <div class="settings-field">
          <div class="settings-field-info">
            <div class="settings-field-header">
              <span class="settings-label">Permission Mode</span>
              ${useGlobalCheckbox('permissionMode')}
            </div>
            <div class="settings-description">Permission mode passed to the <code>claude</code> command</div>
          </div>
          <div class="settings-field-control">
            <select class="settings-select" id="sv-perm-mode" ${fieldDisabled('permissionMode')}>
              ${PERMISSION_MODES.map(m => m.value === null
                ? '<option value="">Default (none)</option>'
                : `<option value="${m.value}" ${permModeValue === m.value ? 'selected' : ''}>${escapeHtml(m.label)}</option>`
              ).join('')}
            </select>
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <div class="settings-field-header">
              <span class="settings-label">Worktree</span>
              ${useGlobalCheckbox('worktree')}
            </div>
            <div class="settings-description">Enable worktree for new sessions</div>
          </div>
          <div class="settings-field-control">
            <label class="settings-toggle"><input type="checkbox" id="sv-worktree" ${worktreeValue ? 'checked' : ''} ${fieldDisabled('worktree')}><span class="settings-toggle-slider"></span></label>
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <div class="settings-field-header">
              <span class="settings-label">Worktree Name</span>
              ${useGlobalCheckbox('worktreeName')}
            </div>
            <div class="settings-description">Custom name for worktree branches</div>
          </div>
          <div class="settings-field-control">
            <input type="text" class="settings-input" id="sv-worktree-name" placeholder="auto" value="${escapeHtml(worktreeNameValue)}" ${fieldDisabled('worktreeName')} style="width:140px">
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <div class="settings-field-header">
              <span class="settings-label">Chrome</span>
              ${useGlobalCheckbox('chrome')}
            </div>
            <div class="settings-description">Enable Chrome browser automation</div>
          </div>
          <div class="settings-field-control">
            <label class="settings-toggle"><input type="checkbox" id="sv-chrome" ${chromeValue ? 'checked' : ''} ${fieldDisabled('chrome')}><span class="settings-toggle-slider"></span></label>
          </div>
        </div>

        ${isLinux ? `<div class="settings-field">
          <div class="settings-field-info">
            <div class="settings-field-header">
              <span class="settings-label">Sandbox</span>
              ${useGlobalCheckbox('sandbox')}
            </div>
            <div class="settings-description">Run claude in a bubblewrap sandbox — only the project directory and Claude's own config are visible. Requires <code>bwrap</code> (bubblewrap). Takes effect for new sessions.</div>
          </div>
          <div class="settings-field-control">
            <label class="settings-toggle"><input type="checkbox" id="sv-sandbox" ${sandboxValue ? 'checked' : ''} ${fieldDisabled('sandbox')}><span class="settings-toggle-slider"></span></label>
          </div>
        </div>` : ''}

        <div class="settings-field settings-field-wide">
          <div class="settings-field-info">
            <div class="settings-field-header">
              <span class="settings-label">Additional Directories</span>
              ${useGlobalCheckbox('addDirs')}
            </div>
            <div class="settings-description">Extra directories to include in Claude sessions</div>
          </div>
          <div class="settings-field-control">
            <input type="text" class="settings-input" id="sv-add-dirs" placeholder="/path/to/dir1, /path/to/dir2" value="${escapeHtml(addDirsValue)}" ${fieldDisabled('addDirs')}>
          </div>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">Session Launch</div>

        <div class="settings-field settings-field-wide">
          <div class="settings-field-info">
            <div class="settings-field-header">
              <span class="settings-label">Pre-launch Command</span>
              ${useGlobalCheckbox('preLaunchCmd')}
            </div>
            <div class="settings-description">Prepended to the claude command (e.g. "aws-vault exec profile --")</div>
          </div>
          <div class="settings-field-control">
            <input type="text" class="settings-input" id="sv-pre-launch" placeholder="e.g. aws-vault exec profile --" value="${escapeHtml(preLaunchValue)}" ${fieldDisabled('preLaunchCmd')}>
          </div>
        </div>
      </div>

      ${!isProject ? `<div class="settings-section">
        <div class="settings-section-title">Application</div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Terminal Theme</span>
            <div class="settings-description">Color theme for terminal sessions</div>
          </div>
          <div class="settings-field-control">
            <select class="settings-select" id="sv-terminal-theme">
              ${Object.entries(TERMINAL_THEMES).map(([key, t]) =>
                `<option value="${key}" ${themeValue === key ? 'selected' : ''}>${escapeHtml(t.label)}</option>`
              ).join('')}
            </select>
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Terminal Right-Click</span>
            <div class="settings-description">What a right-click does in the terminal. "Context menu" offers file-link actions (open in panel / system editor, copy path), copy and paste. Takes effect on the next right-click.</div>
          </div>
          <div class="settings-field-control">
            <select class="settings-select" id="sv-right-click">
              <option value="menu" ${rightClickValue === 'menu' ? 'selected' : ''}>Context menu (default)</option>
              <option value="paste" ${rightClickValue === 'paste' ? 'selected' : ''}>Paste clipboard</option>
              <option value="default" ${rightClickValue === 'default' ? 'selected' : ''}>Native (xterm)</option>
              <option value="none" ${rightClickValue === 'none' ? 'selected' : ''}>Do nothing</option>
            </select>
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Restore Sessions on Startup</span>
            <!-- No live-apply hook — this setting is only read at next app launch. -->
            <div class="settings-description">Re-open the sessions that were open when Switchboard last closed. Each is resumed in turn.</div>
          </div>
          <div class="settings-field-control">
            <select class="settings-select" id="sv-restore-startup">
              <option value="off" ${restoreStartupValue === 'off' ? 'selected' : ''}>Don't restore</option>
              <option value="ask" ${restoreStartupValue === 'ask' ? 'selected' : ''}>Ask on startup (default)</option>
              <option value="auto" ${restoreStartupValue === 'auto' ? 'selected' : ''}>Restore automatically</option>
            </select>
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Shell Profile</span>
            <div class="settings-description">Shell used for terminal and Claude sessions. Changes take effect for new sessions only.</div>
          </div>
          <div class="settings-field-control">
            <select class="settings-select" id="sv-shell-profile">
              <option value="auto" ${shellProfileValue === 'auto' ? 'selected' : ''}>Auto (detect)</option>
              ${shellProfiles.map(p =>
                `<option value="${escapeHtml(p.id)}" ${shellProfileValue === p.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`
              ).join('')}
            </select>
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Max Visible Sessions</span>
            <div class="settings-description">Show up to this many sessions before collapsing the rest behind "+N older"</div>
          </div>
          <div class="settings-field-control">
            <input type="number" class="settings-input settings-input-compact" id="sv-visible-count" min="1" max="100" value="${visCountValue}">
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Session Max Age (days)</span>
            <div class="settings-description">Sessions older than this are hidden behind "+N older" even if under the count limit</div>
          </div>
          <div class="settings-field-control">
            <input type="number" class="settings-input settings-input-compact" id="sv-max-age" min="1" max="365" value="${maxAgeValue}">
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">IDE Emulation</span>
            <div class="settings-description">Emulate an IDE so Claude can open files and diffs in a side panel. Disable to use your own IDE instead. Changes take effect for new sessions only.</div>
          </div>
          <div class="settings-field-control">
            <label class="settings-toggle"><input type="checkbox" id="sv-mcp-emulation" ${mcpEmulationValue ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
          </div>
        </div>
      </div>` : ''}

      ${!isProject ? `<div class="settings-section">
        <div class="settings-section-title">Keyboard Shortcuts</div>
        ${SHORTCUT_DEFS.map(def => `
        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">${escapeHtml(def.label)}</span>
            <div class="settings-description">${escapeHtml(def.description)}</div>
          </div>
          <div class="settings-field-control">
            <button class="settings-shortcut-btn" id="sv-sc-${def.id}" data-sc-id="${def.id}">${escapeHtml(formatBinding(def.id, scIsMac, scShortcuts))}</button>
          </div>
        </div>`).join('')}
        <div class="settings-hint">Click a shortcut, then press the new combination. At least one modifier (${scIsMac ? 'Cmd' : 'Ctrl'}, ${scIsMac ? 'Option' : 'Alt'} or Shift) is required. Press Esc to cancel, or click again to reset to defaults.</div>
      </div>` : ''}

      ${!isProject ? `<div class="settings-section">
        <div class="settings-section-title">Updates</div>
        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Automatic Updates</span>
            <div class="settings-description">Download updates in the background and install them when Switchboard quits. Turn off to keep the installed binary exactly as it is \u2014 "Check for Updates" below still works on demand. Takes effect on next launch.</div>
          </div>
          <div class="settings-field-control">
            <label class="settings-toggle"><input type="checkbox" id="sv-auto-update" ${autoUpdateValue ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
          </div>
        </div>
        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Version</span>
            <div class="settings-description"><span id="sv-current-version"></span> <span id="sv-update-status"></span></div>
          </div>
          <div class="settings-field-control">
            <button class="settings-check-updates-btn" id="sv-check-updates-btn">Check for Updates</button>
          </div>
        </div>
      </div>` : ''}

      <div class="settings-btn-row">
        <button class="settings-cancel-btn" id="sv-cancel-btn">Cancel</button>
        <button class="settings-save-btn" id="sv-save-btn">Save Settings</button>
        ${isProject ? '<button class="settings-remove-btn" id="sv-remove-btn">Hide Project</button>' : ''}
      </div>
    </div>
  `;

    // Use-global checkboxes toggle field disabled state
    settingsViewerBody.querySelectorAll('.use-global-cb').forEach(cb => {
      cb.addEventListener('change', () => {
        const field = cb.dataset.field;
        const fieldMap = {
          permissionMode: 'sv-perm-mode',
          worktree: 'sv-worktree',
          worktreeName: 'sv-worktree-name',
          chrome: 'sv-chrome',
          sandbox: 'sv-sandbox',
          preLaunchCmd: 'sv-pre-launch',
          addDirs: 'sv-add-dirs',
        };
        const input = settingsViewerBody.querySelector('#' + fieldMap[field]);
        if (input) input.disabled = cb.checked;
      });
    });

    // --- Keyboard shortcut rebinding (global only) ---
    // Capture listeners live on the button element itself (not on document), so
    // they can never leak app-wide: losing focus (incl. the settings viewer being
    // dismissed by ANY path) fires `blur` → stops capture, and re-opening the
    // viewer replaces settingsViewerBody, discarding the old listeners with it.
    let capturingBtn = null;
    function stopShortcutCapture() {
      if (capturingBtn) {
        capturingBtn.classList.remove('capturing');
        capturingBtn.textContent = formatBinding(capturingBtn.dataset.scId, scIsMac, scShortcuts);
        capturingBtn = null;
      }
    }
    settingsViewerBody.querySelectorAll('.settings-shortcut-btn').forEach(btn => {
      const id = btn.dataset.scId;
      const def = SHORTCUT_DEFS.find(d => d.id === id);
      btn.addEventListener('click', () => {
        // Clicking the button that is already capturing resets it to default.
        if (capturingBtn === btn) {
          scShortcuts = { ...scShortcuts, [id]: normalizeShortcuts(null)[id] };
          stopShortcutCapture();
          btn.blur();
          return;
        }
        stopShortcutCapture();
        capturingBtn = btn;
        btn.classList.add('capturing');
        btn.textContent = 'Press keys…';
        btn.focus();
      });
      // keydown only acts while THIS button is the one capturing.
      btn.addEventListener('keydown', (e) => {
        if (capturingBtn !== btn) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'Escape') { stopShortcutCapture(); btn.blur(); return; }
        const binding = captureBinding(e, def, scIsMac);
        if (!binding) return; // chord incomplete — keep listening
        scShortcuts = { ...scShortcuts, [id]: binding };
        stopShortcutCapture();
        btn.blur();
      });
      // Losing focus (click elsewhere, panel dismissed, tab switch) cancels capture.
      btn.addEventListener('blur', () => {
        if (capturingBtn === btn) stopShortcutCapture();
      });
    });

    // Save button
    settingsViewerBody.querySelector('#sv-save-btn').addEventListener('click', async () => {
      let settings = {};

      if (isProject) {
        // Only save fields where "use global" is unchecked
        settingsViewerBody.querySelectorAll('.use-global-cb').forEach(cb => {
          if (!cb.checked) {
            const field = cb.dataset.field;
            const fieldMap = {
              permissionMode: () => settingsViewerBody.querySelector('#sv-perm-mode').value || null,
              worktree: () => settingsViewerBody.querySelector('#sv-worktree').checked,
              worktreeName: () => settingsViewerBody.querySelector('#sv-worktree-name').value.trim(),
              chrome: () => settingsViewerBody.querySelector('#sv-chrome').checked,
              sandbox: () => settingsViewerBody.querySelector('#sv-sandbox').checked,
              preLaunchCmd: () => settingsViewerBody.querySelector('#sv-pre-launch').value.trim(),
              addDirs: () => settingsViewerBody.querySelector('#sv-add-dirs').value.trim(),
            };
            if (fieldMap[field]) settings[field] = fieldMap[field]();
          }
        });
      } else {
        settings.permissionMode = settingsViewerBody.querySelector('#sv-perm-mode').value || null;
        settings.worktree = settingsViewerBody.querySelector('#sv-worktree').checked;
        settings.worktreeName = settingsViewerBody.querySelector('#sv-worktree-name').value.trim();
        settings.chrome = settingsViewerBody.querySelector('#sv-chrome').checked;
        const sandboxToggle = settingsViewerBody.querySelector('#sv-sandbox');
        if (sandboxToggle) settings.sandbox = sandboxToggle.checked;
        settings.preLaunchCmd = settingsViewerBody.querySelector('#sv-pre-launch').value.trim();
        settings.addDirs = settingsViewerBody.querySelector('#sv-add-dirs').value.trim();
        settings.visibleSessionCount = parseInt(settingsViewerBody.querySelector('#sv-visible-count').value) || 10;
        settings.sessionMaxAgeDays = parseInt(settingsViewerBody.querySelector('#sv-max-age').value) || 3;
        settings.terminalTheme = settingsViewerBody.querySelector('#sv-terminal-theme').value || 'switchboard';
        settings.terminalRightClick = settingsViewerBody.querySelector('#sv-right-click').value || 'menu';
        settings.restoreOnStartup = settingsViewerBody.querySelector('#sv-restore-startup').value || 'ask';
        settings.mcpEmulation = settingsViewerBody.querySelector('#sv-mcp-emulation').checked;
        settings.autoUpdate = settingsViewerBody.querySelector('#sv-auto-update').checked;
        settings.shellProfile = settingsViewerBody.querySelector('#sv-shell-profile').value || 'auto';
        settings.shortcuts = scShortcuts;
      }
      stopShortcutCapture();

      // Merge form values into existing settings to preserve keys not managed by the form
      if (!isProject) {
        const existing = (await window.api.getSetting('global')) || {};
        settings = { ...existing, ...settings };
      }

      await window.api.setSetting(settingsKey, settings);

      // Update visibleSessionCount, sessionMaxAgeDays, and theme
      if (!isProject) {
        if (settings.visibleSessionCount && typeof window._setVisibleSessionCount === 'function') {
          window._setVisibleSessionCount(settings.visibleSessionCount);
        }
        if (settings.sessionMaxAgeDays && typeof window._setSessionMaxAge === 'function') {
          window._setSessionMaxAge(settings.sessionMaxAgeDays);
        }
        if (settings.terminalTheme && typeof window._applyTerminalTheme === 'function') {
          window._applyTerminalTheme(settings.terminalTheme);
        }
        if (settings.terminalRightClick && typeof window._applyTerminalRightClick === 'function') {
          window._applyTerminalRightClick(settings.terminalRightClick);
        }
        if (settings.shortcuts && typeof window._applyShortcuts === 'function') {
          window._applyShortcuts(settings.shortcuts);
        }
        if (typeof refreshSidebar === 'function') refreshSidebar();
      }

      // Notify if IDE Emulation changed
      if (!isProject && settings.mcpEmulation !== mcpEmulationValue) {
        const notice = document.createElement('div');
        notice.className = 'settings-notice';
        notice.textContent = 'IDE Emulation setting changed. New sessions will use the updated setting \u2014 running sessions are not affected.';
        const saveBtn = settingsViewerBody.querySelector('#sv-save-btn');
        saveBtn.parentElement.insertBefore(notice, saveBtn);
        setTimeout(() => notice.remove(), 8000);
      }

      const saveBtn = settingsViewerBody.querySelector('#sv-save-btn');
      saveBtn.textContent = '✓ Saved';
      saveBtn.style.background = '#2ea043';
      saveBtn.style.color = '#fff';
      setTimeout(() => closeSettingsViewer(), 600);
    });

    // Cancel button
    settingsViewerBody.querySelector('#sv-cancel-btn').addEventListener('click', () => {
      stopShortcutCapture();
      closeSettingsViewer();
    });

    // Check for updates button + current version + inline status
    const checkUpdatesBtn = settingsViewerBody.querySelector('#sv-check-updates-btn');
    if (checkUpdatesBtn) {
      const updateStatusEl = settingsViewerBody.querySelector('#sv-update-status');
      window.api.getAppVersion().then(v => {
        const el = settingsViewerBody.querySelector('#sv-current-version');
        if (el) el.textContent = `v${v}`;
      });
      const settingsUpdaterHandler = (type, data) => {
        if (!updateStatusEl) return;
        switch (type) {
          case 'checking': updateStatusEl.textContent = '\u2014 checking\u2026'; break;
          case 'update-available': updateStatusEl.textContent = `\u2014 v${data.version} available`; break;
          case 'update-not-available': updateStatusEl.textContent = '\u2014 up to date'; break;
          case 'download-progress': updateStatusEl.textContent = `\u2014 downloading ${Math.round(data.percent)}%`; break;
          case 'update-downloaded': updateStatusEl.textContent = `\u2014 v${data.version} ready, restart to update`; break;
          case 'error': updateStatusEl.textContent = '\u2014 check failed'; break;
        }
      };
      window.api.onUpdaterEvent(settingsUpdaterHandler);
      checkUpdatesBtn.addEventListener('click', () => {
        window.api.updaterCheck();
      });
    }

    // Remove project button
    const removeBtn = settingsViewerBody.querySelector('#sv-remove-btn');
    if (removeBtn) {
      removeBtn.addEventListener('click', async () => {
        if (!confirm(`Hide project "${shortName}" from Switchboard?\n\nThis hides the project from the sidebar. Your session files are not deleted.`)) return;
        await window.api.removeProject(projectPath);
        settingsViewer.style.display = 'none';
        document.getElementById('placeholder').style.display = 'flex';
        if (typeof loadProjects === 'function') loadProjects();
      });
    }
  }

  // Expose globally
  window.openSettingsViewer = openSettingsViewer;
  window.closeSettingsViewer = closeSettingsViewer;
})();
