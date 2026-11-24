const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

async function runTerminal(command, cwd, fallback = '') {
  if (typeof command !== 'string' || !command.trim() || command.length > 4000) throw new Error('命令必须为 1 至 4000 字。');
  const directory = cwd ? path.resolve(String(cwd)) : (fallback || os.homedir());
  if (!(await fs.stat(directory)).isDirectory()) throw new Error('工作目录不是文件夹。');
  return new Promise((resolve, reject) => {
    const utf8Command = '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding; ' + command;
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', utf8Command], {
      cwd: directory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '', stderr = '', truncated = false, timedOut = false;
    const capture = (target, chunk) => {
      const text = chunk.toString('utf8');
      const previous = target === 'stdout' ? stdout : stderr;
      const next = previous + text;
      if (Buffer.byteLength(next, 'utf8') > 12000) truncated = true;
      if (target === 'stdout') stdout = next.slice(0, 12000);
      else stderr = next.slice(0, 12000);
    };
    child.stdout.on('data', chunk => capture('stdout', chunk));
    child.stderr.on('data', chunk => capture('stderr', chunk));
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 30000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolve({
      command, cwd: directory, exitCode: code, stdout, stderr, truncated, timedOut
    }); });
  });
}
module.exports = { runTerminal };
