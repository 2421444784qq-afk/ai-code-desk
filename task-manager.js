const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { realPath } = require('./asar-path');
function createTaskManager(dataDir) {
  const root = path.join(dataDir, 'tasks');
  const validId = id => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id);
  const folder = id => { if (!validId(id)) throw new Error('无效任务 ID。'); return path.join(root, id); };
  async function read(id) {
    const directory = folder(id);
    const meta = JSON.parse(await fs.readFile(path.join(directory, 'meta.json'), 'utf8'));
    let workerPid = null;
    try { workerPid = Number(await fs.readFile(path.join(directory, 'worker.pid'), 'utf8')); } catch {}
    if (['starting', 'running'].includes(meta.status) && workerPid) {
      try { process.kill(workerPid, 0); }
      catch { meta.status = 'unknown'; meta.error = '任务进程已结束，但未写入最终状态。'; }
    }
    return { ...meta, workerPid };
  }
  async function list() {
    await fs.mkdir(root, { recursive: true });
    const entries = await fs.readdir(root, { withFileTypes: true });
    const records = [];
    for (const entry of entries.filter(x => x.isDirectory() && validId(x.name)).slice(-100)) {
      try { records.push(await read(entry.name)); } catch {}
    }
    return records.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 30);
  }
  async function start(command, cwd, expectedArtifacts = []) {
    if (typeof command !== 'string' || !command.trim() || command.length > 4000) throw new Error('命令必须为 1 至 4000 字。');
    if (!Array.isArray(expectedArtifacts) || expectedArtifacts.length > 10 || expectedArtifacts.some(x => typeof x !== 'string' || x.length > 500)) throw new Error('预期产物路径无效。');
    if ((await list()).filter(x => ['starting', 'running'].includes(x.status)).length >= 3) throw new Error('最多同时运行三个长任务。');
    const directory = path.resolve(String(cwd || os.homedir()));
    if (!(await fs.stat(directory)).isDirectory()) throw new Error('工作目录不是文件夹。');
    const id = crypto.randomUUID(), taskDir = folder(id);
    await fs.mkdir(taskDir, { recursive: true });
    const meta = { id, command, cwd: directory, expectedArtifacts, status: 'starting', startedAt: new Date().toISOString(), exitCode: null };
    await fs.writeFile(path.join(taskDir, 'meta.json'), JSON.stringify(meta));
    // Use the current runtime (node in tests, the packaged app via ELECTRON_RUN_AS_NODE),
    // so background tasks work on machines without a separate Node.js installation.
    const worker = spawn(process.execPath, [realPath(path.join(__dirname, 'task-worker.js')), taskDir], {
      cwd: directory, detached: true, windowsHide: true, stdio: 'ignore',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    });
    await new Promise((resolve, reject) => { worker.once('spawn', resolve); worker.once('error', reject); });
    await fs.writeFile(path.join(taskDir, 'worker.pid'), String(worker.pid));
    worker.unref();
    return { ...meta, workerPid: worker.pid };
  }
  async function tail(file, bytes = 8000) {
    try {
      const stat = await fs.stat(file);
      const handle = await fs.open(file, 'r');
      try { const size = Math.min(bytes, stat.size), data = Buffer.alloc(size); await handle.read(data, 0, size, stat.size - size); return data.toString('utf8'); }
      finally { await handle.close(); }
    } catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
  }
  async function inspect(id) {
    const meta = await read(id), directory = folder(id);
    return { ...meta, stdoutTail: await tail(path.join(directory, 'output.log')), stderrTail: await tail(path.join(directory, 'error.log')) };
  }
  async function stop(id) {
    const meta = await read(id);
    if (!['starting', 'running'].includes(meta.status)) return meta;
    if (!meta.workerPid) throw new Error('没有可停止的任务进程。');
    const check = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "(Get-CimInstance Win32_Process -Filter 'ProcessId = " + meta.workerPid + "').CommandLine"], { encoding: 'utf8', windowsHide: true });
    if (check.status !== 0 || !check.stdout.includes('task-worker.js') || !check.stdout.includes(folder(id)))
      throw new Error('无法确认后台任务进程身份，已拒绝停止以免误伤其他程序。');
    const ended = spawnSync('taskkill.exe', ['/PID', String(meta.workerPid), '/T', '/F'], { windowsHide: true });
    if (ended.status !== 0) throw new Error('停止任务失败：' + String(ended.stderr || ended.stdout).slice(0, 300));
    const final = { ...meta, status: 'stopped', finishedAt: new Date().toISOString(), exitCode: null };
    delete final.workerPid;
    const metaPath = path.join(folder(id), 'meta.json');
    await fs.writeFile(metaPath, JSON.stringify(final));
    return { ...final, workerPid: meta.workerPid };
  }
  async function verify(id, artifacts = null) {
    const task = await inspect(id);
    const paths = artifacts == null ? task.expectedArtifacts : artifacts;
    if (!Array.isArray(paths) || paths.length > 10 || paths.some(x => typeof x !== 'string' || x.length > 500)) throw new Error('产物路径无效。');
    const checks = [];
    for (const item of paths) {
      const target = path.resolve(task.cwd, item);
      try {
        const stat = await fs.stat(target);
        checks.push({ path: target, exists: true, file: stat.isFile(), bytes: stat.size, modifiedAt: stat.mtime.toISOString(), fresh: stat.mtimeMs >= Date.parse(task.startedAt) - 2000 });
      } catch (error) { if (error.code !== 'ENOENT') throw error; checks.push({ path: target, exists: false }); }
    }
    const verified = task.status === 'completed' && task.exitCode === 0 && checks.length > 0 && checks.every(x => x.exists && x.file && x.bytes > 0 && x.fresh);
    return { taskId: id, status: task.status, exitCode: task.exitCode, verified, checks,
      reason: verified ? '进程成功结束，所有产物存在、非空且在任务启动后更新。' : !checks.length ? '未提供预期产物，无法完成产物验收。' : '任务状态或产物检查未通过。' };
  }
  return { start, inspect, list, stop, verify };
}
module.exports = { createTaskManager };
