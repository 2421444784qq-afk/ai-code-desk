const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { mentionedFiles } = require('./project-context');

test('detects named files, nested paths, selected file and unrelated chat', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-code-desk-test-'));
  try {
    await fs.writeFile(path.join(root, 'function.txt'), 'hello');
    await fs.mkdir(path.join(root, 'src'));
    await fs.writeFile(path.join(root, 'src', 'worker.py'), 'pass');
    assert.deepEqual(await mentionedFiles(root, '读取 function.txt 的内容', 'function.txt', false), ['function.txt']);
    assert.deepEqual(await mentionedFiles(root, '解释 src/worker.py', '', false), [path.join('src', 'worker.py')]);
    assert.deepEqual(await mentionedFiles(root, '你好', 'function.txt', false), []);
    assert.deepEqual(await mentionedFiles(root, '解释这个文件', 'function.txt', false), ['function.txt']);
    assert.deepEqual(await mentionedFiles(root, '你好', 'function.txt', true), ['function.txt']);
    await fs.writeFile(path.join(root, 'src', 'function.txt'), 'different');
    assert.deepEqual(await mentionedFiles(root, '读取 src/function.txt', 'function.txt', false), [path.join('src', 'function.txt')]);
    assert.deepEqual(await mentionedFiles(root, '读取 function.txt', 'function.txt', false), ['function.txt']);
    await assert.rejects(mentionedFiles(root, '读取 function.txt', '', false), /同名文件/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
