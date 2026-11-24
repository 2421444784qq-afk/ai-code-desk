const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createTaskManager } = require('./task-manager');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
test('tracks a long task and verifies a fresh artifact', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-task-test-'));
  const manager = createTaskManager(root);
  try {
    const task = await manager.start("Start-Sleep -Seconds 2; Set-Content -LiteralPath result.txt -Value ready -Encoding UTF8", root, ['result.txt']);
    let state;
    for (let i = 0; i < 30; i++) { state = await manager.inspect(task.id); if (state.status === 'completed' || state.status === 'failed') break; await wait(300); }
    assert.equal(state.status, 'completed');
    assert.equal(state.exitCode, 0);
    assert.equal((await manager.verify(task.id)).verified, true);
    assert.match(await fs.readFile(path.join(root, 'result.txt'), 'utf8'), /ready/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('stops a running task', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-task-stop-'));
  const manager = createTaskManager(root);
  try {
    const task = await manager.start('Start-Sleep -Seconds 30', root);
    await wait(700);
    assert.equal((await manager.stop(task.id)).status, 'stopped');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('worker survives starter process exit and can be reattached', async () => {
  const { execFileSync } = require('node:child_process');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'desk-task-persist-'));
  try {
    const script = [
      "const m=require('./task-manager').createTaskManager(process.argv[1]);",
      "m.start('Start-Sleep -Seconds 2; Set-Content -LiteralPath persisted.txt -Value alive -Encoding UTF8',process.argv[1],['persisted.txt']).then(t=>console.log(t.id)).catch(e=>{console.error(e);process.exitCode=1})"
    ].join('');
    const id = execFileSync(process.execPath, ['-e', script, root], { cwd: __dirname, encoding: 'utf8' }).trim();
    assert.match(id, /^[a-f0-9-]{36}$/);
    const manager = createTaskManager(root);
    let status;
    for (let i = 0; i < 30; i++) {
      status = (await manager.inspect(id)).status;
      if (status === 'completed' || status === 'failed') break;
      await wait(300);
    }
    assert.equal(status, 'completed');
    assert.equal((await manager.verify(id)).verified, true);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
