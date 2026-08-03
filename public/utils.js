// --- Utility functions (shared across renderer modules) ---

// Claude CLI permission modes offered by the New/Resume Session dialogs
// (dialogs.js) and the global/project Settings panel (settings-panel.js).
// Single source of truth so the two dialogs.js copies and the settings
// <select> can't drift out of sync again — that's exactly how `auto` got
// missed from every picker despite being a real `--permission-mode` value.
//
// `value: null` ("Default") means the --permission-mode flag is omitted
// entirely — Claude prompts for every action. See main.js SETTING_DEFAULTS
// / get-effective-settings for how an unconfigured install now defaults to
// 'auto' instead, without touching an explicitly-saved null.
const PERMISSION_MODES = [
  { value: null, label: 'Default', desc: 'Prompt for all actions' },
  { value: 'auto', label: 'Auto', desc: 'Claude auto-approves lower-risk actions after a safety check, and blocks the rest' },
  { value: 'acceptEdits', label: 'Accept Edits', desc: 'Auto-accept file edits, prompt for others' },
  { value: 'plan', label: 'Plan Mode', desc: 'Read-only exploration, no writes' },
  { value: 'dontAsk', label: "Don't Ask", desc: 'Auto-deny tools not explicitly allowed' },
  { value: 'bypassPermissions', label: 'Bypass', desc: 'Auto-accept all tool calls' },
];

// Mirror Claude CLI's project-folder naming. Must stay in sync with
// encode-project-path.js (main process). Reverse-engineered from claude CLI 2.1.126.
function encodeProjectPath(projectPath) {
  const sanitized = projectPath.replace(/[^a-zA-Z0-9]/g, '-');
  if (sanitized.length <= 200) return sanitized;
  let h = 0;
  for (let i = 0; i < projectPath.length; i++) {
    h = (h << 5) - h + projectPath.charCodeAt(i) | 0;
  }
  return sanitized.slice(0, 200) + '-' + Math.abs(h).toString(36);
}

function cleanDisplayName(name) {
  if (!name) return name;
  const prefix = 'Implement the following plan:';
  if (name.startsWith(prefix)) name = name.slice(prefix.length).trim();
  // Strip XML/HTML-like tags (e.g. <command>, </message>, <system-reminder>)
  name = name.replace(/<\/?[a-zA-Z][a-zA-Z0-9_-]*(?:\s[^>]*)?\/?>/g, ' ');
  // Collapse multiple spaces and trim
  name = name.replace(/\s+/g, ' ').trim();
  return name;
}

function formatDate(date) {
  const now = new Date();
  const diff = now - date;
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function shellEscape(path) {
  return "'" + path.replace(/'/g, "'\\''") + "'";
}
