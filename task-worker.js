const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const directory = process.argv[2];
const metaPath = path.join(directory, 'meta.json');
const logPath = path.join(directory, 'output.log');
const errPath = path.join(directory, 'error.log');
const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
const limit = 5 * 1024 * 1024;
function save(changes) {
  Object.assign(meta, changes);
  fs.writeFileSync(metaPath + '.tmp', JSON.stringify(meta));
  fs.renameSync(metaPath + '.tmp', metaPath);
}
function logTo(file, stream) {
  let written = 0;
  let truncated = false;
  stream.on('data', bytes => {
    if (written >= limit) {
      if (!truncated) { fs.appendFileSync(file, '\n[日志超过 5 MB，后续输出未保存]\n'); truncated = true; }
      return;
    }
    const part = bytes.subarray(0, limit - written);
    fs.appendFileSync(file, part);
    written += part.length;
  });
}
const utf8 = '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding; ';
try {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', utf8 + meta.command], {
    cwd: meta.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  save({ status: 'running', commandPid: child.pid });
  logTo(logPath, child.stdout);
  logTo(errPath, child.stderr);
  child.on('error', error => save({ status: 'failed', error: error.message, finishedAt: new Date().toISOString() }));
  child.on('close', code => save({ status: code === 0 ? 'completed' : 'failed', exitCode: code, finishedAt: new Date().toISOString() }));
} catch (error) {
  save({ status: 'failed', error: error.message, finishedAt: new Date().toISOString() });
}
