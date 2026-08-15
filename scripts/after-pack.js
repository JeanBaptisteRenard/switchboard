// electron-builder afterPack hook.
//
// Windows only: ship node-pty's bundled ConPTY (conpty.dll + OpenConsole.exe)
// next to the rebuilt native binding. node-pty's loadNativeModule prefers
// build/Release/ (created by the electron-rebuild step) over prebuilds/, and
// conpty.node resolves `conpty\conpty.dll` relative to its own location — so
// after a rebuild the dll shipped under prebuilds/ is unreachable and
// `useConptyDll: true` would fail at spawn time (main.js falls back to the
// inbox ConPTY, losing the fix for its ghost/duplicated-line redraw bugs).
const fs = require('fs');
const path = require('path');

// electron-builder Arch enum: ia32=0, x64=1, armv7l=2, arm64=3, universal=4.
const ARCH_NAMES = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64' };

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const archName = ARCH_NAMES[context.arch];
  if (!archName) return;

  const ptyDir = path.join(
    context.appOutDir, 'resources', 'app.asar.unpacked', 'node_modules', 'node-pty'
  );
  const src = path.join(ptyDir, 'prebuilds', `win32-${archName}`, 'conpty');
  const dst = path.join(ptyDir, 'build', 'Release', 'conpty');

  if (!fs.existsSync(src)) {
    console.warn(`[after-pack] no bundled conpty at ${src} — skipping`);
    return;
  }
  if (!fs.existsSync(path.dirname(dst))) {
    // No rebuild happened; the prebuilds layout is used as-is and already
    // contains the dll next to the binding.
    return;
  }
  fs.cpSync(src, dst, { recursive: true });
  console.log(`[after-pack] copied bundled ConPTY to ${dst}`);
};
