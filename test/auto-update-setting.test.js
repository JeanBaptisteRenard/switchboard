// The auto-updater downloaded and installed replacements with no consent and no
// opt-out: autoDownload = true, autoInstallOnAppQuit = true, and no setting
// anywhere. For an AppImage that means the file on disk gets swapped on quit —
// which also silently replaces a locally-built binary someone is testing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const main = () => fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');

test('autoUpdate defaults to on, so behaviour is unchanged for existing users', () => {
  const src = main();
  const start = src.indexOf('const SETTING_DEFAULTS = {');
  const body = src.slice(start, src.indexOf('};', start));
  assert.match(body, /autoUpdate: true/, 'the default must preserve current behaviour');
});

test('the setting gates download, install-on-quit, and both scheduled checks', () => {
  const src = main();
  const i = src.indexOf("const autoUpdate = (getSetting('global') || {}).autoUpdate !== false;");
  assert.ok(i !== -1, 'the effective value must be read from global settings');

  const block = src.slice(i, i + 1200);
  assert.match(block, /autoUpdater\.autoDownload = autoUpdate/, 'must gate downloading');
  assert.match(block, /autoUpdater\.autoInstallOnAppQuit = autoUpdate/, 'must gate install-on-quit');

  // Both the 5s startup check and the 4-hourly re-check must sit inside the
  // enabled branch, or the app still phones home when switched off.
  const enabled = block.slice(block.indexOf('} else {'));
  assert.match(enabled, /setTimeout\([\s\S]*?checkForUpdates/, 'startup check must be gated');
  assert.match(enabled, /setInterval\([\s\S]*?checkForUpdates/, 'periodic check must be gated');
  assert.match(block, /disabled by setting/, 'the disabled path must be visible in the log');
});

test('reading the setting happens where getSetting is actually available', () => {
  const src = main();
  // The updater is constructed before db.js is required, so the flags cannot be
  // resolved there — a regression would reintroduce a startup crash.
  const updaterInit = src.indexOf('autoUpdater = require(\'electron-updater\')');
  const settingRead = src.indexOf("{}).autoUpdate !== false");
  const dbRequire = src.indexOf("require('./db')");
  assert.ok(updaterInit < dbRequire, 'precondition: updater is constructed before db is required');
  assert.ok(settingRead > dbRequire, 'the setting must be read after db.js is available');
});

test('the manual Check for Updates path is left working when auto-update is off', () => {
  const src = main();
  // The IPC handlers must not be gated — turning off automation should not
  // remove the ability to check or download deliberately.
  const check = src.slice(src.indexOf("ipcMain.handle('check-for-updates'"), src.indexOf("ipcMain.handle('check-for-updates'") + 260);
  assert.doesNotMatch(check, /autoUpdate/, 'a deliberate check must not consult the automation setting');
});

test('a manual check can still complete while automation is off', () => {
  const src = main();
  // electron-updater only fetches when autoDownload is true (AppUpdater's
  // downloadPromise is null otherwise), and nothing in public/*.js calls the
  // updater-download IPC — it has no call sites. So without this, pressing
  // "Check for Updates" with the toggle off would report an update and then
  // stall, contradicting what the setting promises.
  const i = src.indexOf("autoUpdater.on('update-available'");
  assert.ok(i !== -1);
  const handler = src.slice(i, src.indexOf('});', i));
  assert.match(handler, /if \(!autoUpdater\.autoDownload\)/,
    'the fetch must be kicked precisely when automation is off');
  assert.match(handler, /downloadUpdate\(\)/, 'and it must actually download');
  assert.match(handler, /\.catch\(/, 'a failed download must not surface as an unhandled rejection');
});

test('the toggle is rendered in Global settings only and is persisted', () => {
  const panel = fs.readFileSync(path.join(ROOT, 'public', 'settings-panel.js'), 'utf8');
  assert.match(panel, /const autoUpdateValue = fieldValue\('autoUpdate', true\)/);
  assert.match(panel, /id="sv-auto-update"/, 'the toggle must exist');
  assert.match(panel, /settings\.autoUpdate = settingsViewerBody\.querySelector\('#sv-auto-update'\)\.checked/, 'it must be saved');

  // It lives in the Updates section, which is inside a `!isProject` block —
  // updating the binary is not a per-project concern.
  const updatesIdx = panel.indexOf('Automatic Updates');
  const sectionStart = panel.lastIndexOf('${!isProject ?', updatesIdx);
  assert.ok(sectionStart !== -1 && updatesIdx - sectionStart < 1200,
    'the toggle must sit inside the global-only Updates section');
});
