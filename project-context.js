const fs = require('node:fs/promises');
const path = require('node:path');
const excluded = new Set(['node_modules', '.git', '.venv', 'dist', 'build']);
const hiddenOrSecret = name => name.startsWith('.') || /\.(pem|key|p12|pfx)$/i.test(name);
async function mentionedFiles(root, question, selected, forceSelected) {
  const normalized = String(question).toLowerCase().replace(/\\/g, '/');
  const named = [];
  const pending = [{ directory: root, depth: 0 }];
  let visited = 0;
  while (pending.length && visited < 1500) {
    const { directory, depth } = pending.shift();
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (++visited > 1500) break;
      if (entry.isSymbolicLink() || hiddenOrSecret(entry.name) || excluded.has(entry.name)) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory() && depth < 5) pending.push({ directory: full, depth: depth + 1 });
      if (!entry.isFile()) continue;
      const relative = path.relative(root, full);
      const base = entry.name.toLowerCase();
      const rel = relative.toLowerCase().replace(/\\/g, '/');
      if (normalized.includes(rel) || (base.includes('.') && normalized.includes(base))) named.push(relative);
    }
  }
  let unique = [...new Set(named)];
  const groups = new Map();
  for (const name of unique) {
    const base = path.basename(name).toLowerCase();
    groups.set(base, [...(groups.get(base) || []), name]);
  }
  for (const matches of groups.values()) {
    if (matches.length < 2) continue;
    const explicit = matches.filter(x => x.includes(path.sep) && normalized.includes(x.toLowerCase().replace(/\\/g, '/')));
    if (explicit.length === 1) unique = unique.filter(x => !matches.includes(x) || x === explicit[0]);
    else if (matches.includes(selected)) unique = unique.filter(x => !matches.includes(x) || x === selected);
    else throw new Error('同名文件不止一个，请在问题中写相对路径，或先选中要读的文件。');
  }
  if (selected && (forceSelected || /当前文件|这个文件|该文件|这段代码/.test(question))) unique.push(selected);
  unique = [...new Set(unique)];
  if (unique.length > 3) throw new Error('提到了多个文件，请一次询问最多三个文件。');
  return unique;
}
module.exports = { mentionedFiles };
