// In a packaged Electron app, files marked asarUnpack live in app.asar.unpacked.
// Node can read asar paths transparently, but external processes
// (powershell.exe, node.exe / ELECTRON_RUN_AS_NODE) cannot; convert those paths.
const path = require('node:path');
function realPath(p) {
  const marker = 'app.asar' + path.sep;
  return p.includes(marker) ? p.replace(marker, 'app.asar.unpacked' + path.sep) : p;
}
module.exports = { realPath };
