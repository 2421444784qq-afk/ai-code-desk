// 本地文件解析：TXT/MD/PY 等文本直读；DOCX/XLSX/PPTX 走 zip+xml 解析；
// PDF 走精简文本提取（ToUnicode CMap + 内容流）；PNG/JPG 等图片转 base64 交给视觉模型。
// 全部使用 Node 内置能力（zlib/inflate），打包版无需任何外部运行时。
const fs = require('node:fs/promises');
const zlib = require('node:zlib');
const path = require('node:path');

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_CHARS = 200000;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

const textExtensions = ['.txt', '.md', '.py', '.js', '.ts', '.jsx', '.tsx', '.json', '.csv', '.log',
  '.html', '.css', '.c', '.h', '.cpp', '.hpp', '.java', '.sh', '.bat', '.ps1', '.yaml', '.yml',
  '.toml', '.ini', '.sql', '.xml', '.go', '.rs', '.rb', '.php'];

function truncate(text, limit = MAX_TEXT_CHARS) {
  const s = String(text ?? '');
  if (s.length <= limit) return s;
  return s.slice(0, limit) + '\n…(内容过长，已截断)';
}

async function readSmartText(full) {
  const bytes = await fs.readFile(full);
  for (const encoding of ['utf-8', 'gbk', 'latin1']) {
    try { return new TextDecoder(encoding, { fatal: true }).decode(bytes); } catch {}
  }
  return bytes.toString('utf8');
}

function xmlDecode(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch { return '?'; } })
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(Number(n)); } catch { return '?'; } });
}

// ---- 极简 zip 读取（local file header + central directory） ----
function zipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65536); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 Office 文件（缺少 zip 结构）。');
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.set(name, { method, compressedSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function zipRead(buf, entries, name) {
  const entry = entries.get(name);
  if (!entry) return null;
  const { method, compressedSize, localOffset } = entry;
  const p = localOffset;
  if (buf.readUInt32LE(p) !== 0x04034b50) throw new Error('zip 条目损坏。');
  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const start = p + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + compressedSize);
  if (method === 0) return Buffer.from(data);
  if (method === 8) return zlib.inflateRawSync(data);
  throw new Error('不支持的 zip 压缩方式：' + method);
}

// ---- DOCX：段落 + 表格 ----
function parseDocx(buf) {
  const entries = zipEntries(buf);
  const xml = zipRead(buf, entries, 'word/document.xml').toString('utf8');
  const parts = [];
  const lines = [];
  for (const p of xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) || []) {
    const t = [...p.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map(m => xmlDecode(m[1])).join('');
    if (t.trim()) lines.push(t);
  }
  parts.push(lines.join('\n'));
  const tables = xml.match(/<w:tbl>[\s\S]*?<\/w:tbl>/g) || [];
  tables.forEach((tbl, i) => {
    parts.push('\n[表格 ' + (i + 1) + ']');
    for (const row of tbl.match(/<w:tr[ >][\s\S]*?<\/w:tr>/g) || []) {
      const cells = (row.match(/<w:tc>[\s\S]*?<\/w:tc>/g) || []).map(c => {
        return [...c.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map(m => xmlDecode(m[1])).join('');
      });
      parts.push('| ' + cells.join(' | ') + ' |');
    }
  });
  return parts.join('\n');
}

// ---- XLSX：工作表名 + 共享字符串 + 单元格 ----
function parseXlsx(buf) {
  const entries = zipEntries(buf);
  const shared = [];
  const ss = zipRead(buf, entries, 'xl/sharedStrings.xml');
  if (ss) {
    for (const item of ss.toString('utf8').match(/<si>[\s\S]*?<\/si>/g) || []) {
      shared.push([...item.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(m => xmlDecode(m[1])).join(''));
    }
  }
  const wbXml = zipRead(buf, entries, 'xl/workbook.xml').toString('utf8');
  const sheets = [...wbXml.matchAll(/<sheet\b[^>]*?name="([^"]*)"[^>]*?r:id="([^"]*)"/g)].map(m => ({ name: m[1], rid: m[2] }));
  const rels = {};
  const relsXml = zipRead(buf, entries, 'xl/_rels/workbook.xml.rels');
  if (relsXml) {
    for (const m of relsXml.toString('utf8').matchAll(/<Relationship\b[^>]*?Id="([^"]*)"[^>]*?Target="([^"]*)"/g)) rels[m[1]] = m[2];
  }
  const out = [];
  sheets.forEach((sheet, si) => {
    const target = rels[sheet.rid] || ('worksheets/sheet' + (si + 1) + '.xml');
    const key = 'xl/' + target.replace(/^\//, '');
    out.push('\n=== 工作表：' + sheet.name + ' ===');
    const xml = zipRead(buf, entries, key);
    if (!xml) return;
    const body = xml.toString('utf8');
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let rowCount = 0, m;
    for (const row of body.match(/<row\b[^>]*>(?:[\s\S]*?)<\/row>/g) || []) {
      if (rowCount >= 200) { out.push('…(行数过多，仅显示前 200 行)'); break; }
      const vals = [];
      while ((m = cellRe.exec(row))) {
        const attr = m[1] || '';
        const inner = m[2] || '';
        const type = (attr.match(/t="([^"]*)"/) || [])[1];
        let value = '';
        if (type === 's') {
          const v = inner.match(/<v>([\s\S]*?)<\/v>/);
          const idx = v ? Number(v[1]) : NaN;
          value = Number.isInteger(idx) && shared[idx] !== undefined ? shared[idx] : '';
        } else if (type === 'inlineStr') {
          const t = inner.match(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/);
          value = t ? xmlDecode(t[1]) : '';
        } else if (type === 'b') {
          const v = inner.match(/<v>([\s\S]*?)<\/v>/);
          value = v ? (v[1] === '1' ? 'TRUE' : 'FALSE') : '';
        } else {
          const v = inner.match(/<v>([\s\S]*?)<\/v>/);
          value = v ? xmlDecode(v[1]) : '';
        }
        vals.push(value);
      }
      const line = vals.join('\t').trim();
      if (line) { out.push(line); rowCount++; }
    }
  });
  return out.join('\n');
}

// ---- PPTX：每页文本 + 图片统计 ----
function parsePptx(buf) {
  const entries = zipEntries(buf);
  const slideKeys = [...entries.keys()]
    .filter(k => /^ppt\/slides\/slide\d+\.xml$/.test(k))
    .sort((a, b) => Number(a.match(/(\d+)/)[1]) - Number(b.match(/(\d+)/)[1]));
  const out = [];
  slideKeys.forEach((key, i) => {
    const xml = zipRead(buf, entries, key).toString('utf8');
    const texts = [...xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map(m => xmlDecode(m[1])).filter(t => t.trim());
    out.push('\n=== 幻灯片 ' + (i + 1) + ' ===\n' + texts.join('\n'));
  });
  const media = [...entries.keys()].filter(k => k.startsWith('ppt/media/'));
  if (media.length) out.push('\n[演示文稿包含 ' + media.length + ' 张图片]');
  return out.join('\n');
}

// ---- PDF：精简文本提取（对象/流/ToUnicode/内容流） ----
function parsePdf(buf) {
  const s = buf.toString('latin1');
  const objs = {};
  const objRe = /(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  while ((m = objRe.exec(s))) {
    const start = m.index + m[0].length;
    const end = s.indexOf('endobj', start);
    if (end > start) objs[Number(m[1])] = s.slice(start, end);
  }
  const streamOf = (objStr) => {
    const sm = objStr.match(/stream\r?\n/);
    if (!sm) return null;
    let body = objStr.slice(sm.index + sm[0].length);
    const e = body.lastIndexOf('endstream');
    body = body.slice(0, e < 0 ? body.length : e);
    if (body.endsWith('\r\n')) body = body.slice(0, -2);
    else if (body.endsWith('\n')) body = body.slice(0, -1);
    try { return zlib.inflateSync(Buffer.from(body, 'latin1')).toString('latin1'); } catch { return body; }
  };
  const parseCmap = (cm) => {
    const map = {};
    for (const block of cm.match(/beginbfchar([\s\S]*?)endbfchar/g) || []) {
      for (const pair of block.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
        map[parseInt(pair[1], 16)] = String.fromCodePoint(parseInt(pair[2], 16));
      }
    }
    for (const block of cm.match(/beginbfrange([\s\S]*?)endbfrange/g) || []) {
      for (const r of block.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(\[[^\]]*\]|<[0-9a-fA-F]+>)/g)) {
        const lo = parseInt(r[1], 16), hi = parseInt(r[2], 16);
        if (r[3].startsWith('[')) {
          const vals = [...r[3].matchAll(/<([0-9a-fA-F]+)>/g)].map(x => parseInt(x[1], 16));
          for (let i = 0; i <= hi - lo && i < vals.length; i++) map[lo + i] = String.fromCodePoint(vals[i]);
        } else {
          const u0 = parseInt(r[3].slice(1, -1), 16);
          for (let i = 0; i <= hi - lo; i++) map[lo + i] = String.fromCodePoint(u0 + i);
        }
      }
    }
    return map;
  };
  const fontCmap = (fontObj) => {
    const tm = fontObj.match(/\/ToUnicode\s+(\d+)\s+0\s+R/);
    if (!tm || !objs[tm[1]]) return null;
    const st = streamOf(objs[tm[1]]);
    return st ? parseCmap(st) : null;
  };
  const resourcesOf = (raw) => {
    let res = raw.match(/\/Resources\s*<<([\s\S]*?)>>/);
    if (res) return res[1];
    const ref = raw.match(/\/Resources\s+(\d+)\s+0\s+R/);
    if (ref && objs[ref[1]]) {
      const inner = objs[ref[1]].match(/<<([\s\S]*?)>>/);
      return inner ? inner[1] : objs[ref[1]];
    }
    return '';
  };
  const decodeBytes = (bts, cmap) => {
    if (bts.length % 2 === 0) {
      let out = '';
      for (let i = 0; i < bts.length; i += 2) {
        const cid = (bts[i] << 8) | bts[i + 1];
        if (cmap && cmap[cid] !== undefined) { out += cmap[cid]; continue; }
        // 无 ToUnicode 映射时（如 UTF-8/Identity-H CMap），CID 即 Unicode 码点。
        if (cid >= 32 && cid !== 127 && cid !== 0x2028 && cid !== 0x2029) {
          try { out += String.fromCodePoint(cid); } catch { out += '?'; }
        } else out += '?';
      }
      return out;
    }
    try { return Buffer.from(bts).toString('utf16le'); } catch { return '?'; }
  };
  const lines = [];
  const parent = {};
  for (const num of Object.keys(objs)) {
    const pm = objs[num].match(/\/Parent\s+(\d+)\s+0\s+R/);
    if (pm) parent[Number(num)] = Number(pm[1]);
  }
  for (const num of Object.keys(objs)) {
    const raw = objs[num];
    if (!/\/Type\s*\/Page\b/.test(raw)) continue;
    const fonts = {};
    let res = resourcesOf(raw);
    let walk = Number(num);
    while ((!res || !/\/Font/.test(res)) && parent[walk]) { walk = parent[walk]; res = resourcesOf(objs[walk] || ''); }
    const fm = res.match(/\/Font\s*<<([\s\S]*?)>>/);
    if (fm) {
      for (const pair of fm[1].matchAll(/\/([A-Za-z0-9]+)\s+(\d+)\s+0\s+R/g)) {
        fonts[pair[1]] = fontCmap(objs[pair[2]] || '');
      }
    }
    let contents = [];
    const single = raw.match(/\/Contents\s+(\d+)\s+0\s+R/);
    if (single && objs[single[1]]) contents = [objs[single[1]]];
    else {
      const arr = raw.match(/\/Contents\s*\[([\s\S]*?)\]/);
      if (arr) for (const ref of arr[1].matchAll(/(\d+)\s+0\s+R/g)) if (objs[ref[1]]) contents.push(objs[ref[1]]);
    }
    let currentFont = '';
    for (const c of contents) {
      const content = streamOf(c);
      if (!content) continue;
      const tokRe = /\/([A-Za-z0-9]+)\s+[\d.]+\s+Tf|\(((?:[^()\\]|\\.)*)\)\s*Tj|\[([\s\S]*?)\]\s*TJ|<([0-9a-fA-F\s]+)>\s*Tj/g;
      let t;
      while ((t = tokRe.exec(content))) {
        if (t[1]) { currentFont = t[1]; continue; }
        const cmap = fonts[currentFont] || null;
        if (t[2] !== undefined) {
          const lit = t[2].replace(/\\([()\\])/g, '$1');
          try { lines.push(Buffer.from(lit, 'latin1').toString('utf16le')); } catch { lines.push(lit); }
        } else {
          const source = t[3] !== undefined ? t[3] : ('<' + t[4] + '>');
          let piece = '';
          for (const part of source.matchAll(/\(((?:[^()\\]|\\.)*)\)|<([0-9a-fA-F\s]+)>/g)) {
            if (part[1] !== undefined) piece += part[1].replace(/\\([()\\])/g, '$1');
            else {
              const hex = part[2].replace(/\s+/g, '');
              if (hex.length % 2 === 1) continue;
              const bts = [];
              for (let i = 0; i < hex.length; i += 2) bts.push(parseInt(hex.slice(i, i + 2), 16));
              piece += decodeBytes(bts, cmap);
            }
          }
          lines.push(piece);
        }
      }
    }
  }
  let text = lines.join('\n').replace(/\u0000/g, '').trim();
  // 合并逐字换行：连续的单字（中文等宽字符）行拼成完整语句，提高可读性。
  const merged = [];
  for (const line of text.split('\n')) {
    const last = merged[merged.length - 1];
    if (last && [...last].length === 1 && [...line].length === 1 && !/[\s\dA-Za-z]/.test(last) && !/[\s\dA-Za-z]/.test(line)) {
      merged[merged.length - 1] = last + line;
    } else merged.push(line);
  }
  text = merged.join('\n');
  const note = text.length < 30 ? '（该 PDF 文本极少，可能是扫描件，暂不支持 OCR，建议转为图片后上传识别）' : '';
  return { text: truncate(text), note };
}

async function parseFile(full) {
  const stat = await fs.stat(full);
  if (!stat.isFile()) throw new Error('不是文件。');
  if (stat.size > MAX_FILE_BYTES) throw new Error('文件超过 10 MB，无法上传。');
  const ext = path.extname(full).toLowerCase();
  const name = path.basename(full);
  if (textExtensions.includes(ext)) {
    const text = await readSmartText(full);
    return { name, kind: 'text', text: truncate(text), source: ext.slice(1) };
  }
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(ext)) {
    if (stat.size > MAX_IMAGE_BYTES) throw new Error('图片超过 4 MB，请压缩后再上传。');
    const bytes = await fs.readFile(full);
    const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' }[ext];
    return { name, kind: 'image', mime, dataUrl: 'data:' + mime + ';base64,' + bytes.toString('base64') };
  }
  const buf = await fs.readFile(full);
  if (ext === '.docx') return { name, kind: 'text', text: truncate(parseDocx(buf)), source: 'docx' };
  if (ext === '.xlsx') return { name, kind: 'text', text: truncate(parseXlsx(buf)), source: 'xlsx' };
  if (ext === '.pptx') return { name, kind: 'text', text: truncate(parsePptx(buf)), source: 'pptx' };
  if (ext === '.pdf') {
    const r = parsePdf(buf);
    return { name, kind: 'text', text: r.text, source: 'pdf', note: r.note };
  }
  throw new Error('暂不支持的文件类型：' + ext + '（支持 TXT/MD/PY 等文本、DOCX、PDF、PNG/JPG、XLSX、PPTX）');
}

module.exports = { parseFile, parsePdf };
