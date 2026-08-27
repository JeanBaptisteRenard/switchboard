// Is an executable reachable on PATH?
//
// Used to tell "this CLI is installed" from "this CLI has left transcripts
// behind", which are not the same thing: a freshly installed CLI has written
// nothing yet, and an uninstalled one leaves its history in place.
//
// Deliberately a PATH scan rather than spawning `which`: this runs on the main
// process during settings and menu rendering, and a synchronous spawn there is
// far more expensive than a handful of stat calls.

const fs = require('fs');
const path = require('path');

function onPath(binary) {
  if (!binary) return false;
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        fs.accessSync(path.join(dir, binary + ext), fs.constants.X_OK);
        return true;
      } catch {}
    }
  }
  return false;
}

module.exports = { onPath };
