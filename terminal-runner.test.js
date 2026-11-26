const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs/promises');
const path = require('node:path');
const { runTerminal } = require('./terminal-runner');
test('runs a read-only PowerShell command and captures output', async () => {
  const result = await runTerminal('Write-Output AI_CODE_DESK_OK', '', os.tmpdir());
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /AI_CODE_DESK_OK/);
  assert.equal(result.timedOut, false);
});
test('rejects an empty command', async () => {
  await assert.rejects(runTerminal('', '', os.tmpdir()), /命令/);
});
test('preserves Unicode emitted by a Python child process on Windows', async () => {
  const result = await runTerminal('python -c "print(chr(0x25aa)); print(chr(0x4e2d))"', '', os.tmpdir());
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /▪\s+中/);
  assert.equal(result.stderr, '');
});
test('preserves Chinese characters in PowerShell output', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), '测试目录-'));
  try {
    const result = await runTerminal('Get-Location', directory);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /测试目录/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
