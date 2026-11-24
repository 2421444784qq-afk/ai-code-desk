const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs/promises');
const { realPath } = require('./asar-path');
const allowed = new Set(['.docx','.doc','.xlsx','.xlsm','.xls','.pptx','.ppt','.vsdx','.vsd']);
async function runOffice(action, input, output) {
  if (!allowed.has(path.extname(input).toLowerCase())) throw new Error('请选择 Word、Excel、PowerPoint 或 Visio 文件。');
  if (!['inspect','exportPdf'].includes(action)) throw new Error('不支持的 Office 操作。');
  const args = ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',
    realPath(path.join(__dirname,'office-bridge.ps1')),'-Action',action,'-InputPath',input];
  if (output) args.push('-OutputPath',output);
  const result = await new Promise((resolve,reject) => {
    const child = spawn('powershell.exe',args,{windowsHide:true,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='',settled=false;
    const timer = setTimeout(() => { child.kill(); },120000);
    child.stdout.on('data',chunk => { stdout += chunk.toString('utf8'); if(stdout.length > 1000000) child.kill(); });
    child.stderr.on('data',chunk => { stderr += chunk.toString('utf8'); if(stderr.length > 20000) child.kill(); });
    child.once('error',reject);
    child.once('close',code => {
      clearTimeout(timer);
      if (code === 0) return resolve(stdout);
      // Office 有时在写完产物后才挂住退出（被超时强杀）：产物有效即视为成功。
      (async () => {
        try {
          JSON.parse(stdout.trim());
          if (output) { const stat = await fs.stat(output); if (stat.isFile() && stat.size > 0) return resolve(stdout); }
        } catch {}
        reject(new Error('Office 操作失败：' + stderr.slice(0, 700)));
      })();
    });
  });
  const parsed = JSON.parse(result.trim());
  if (output) { const stat=await fs.stat(output); if(!stat.isFile() || stat.size === 0) throw new Error('Office 没有生成有效的预览文件。'); parsed.bytes=stat.size; }
  return parsed;
}
module.exports = { runOffice };

async function addFlowSlide(input, output, title, steps) {
  if (!['.pptx','.ppt'].includes(path.extname(input).toLowerCase())) throw new Error('请选择 PowerPoint 文件。');
  if (typeof title !== 'string' || !title.trim() || title.length > 80 ||
      !Array.isArray(steps) || steps.length < 2 || steps.length > 6 ||
      steps.some(x => typeof x !== 'string' || !x.trim() || x.length > (steps.length >= 5 ? 18 : 30)))
    throw new Error('标题不超过 80 字，流程包含 2 至 6 步；每步请保持简短（最多 18 至 30 字）。');
  const specPath = output + '.json';
  await fs.writeFile(specPath, JSON.stringify({ title, steps }), 'utf8');
  try {
    const raw = await new Promise((resolve,reject) => {
      const child = spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',
        realPath(path.join(__dirname,'office-diagram.ps1')),'-InputPath',input,'-OutputPath',output,'-SpecPath',specPath],
        { windowsHide:true,stdio:['ignore','pipe','pipe'] });
      let stdout='',stderr='';
      const timer=setTimeout(()=>child.kill(),120000);
      child.stdout.on('data',b=>{stdout+=b.toString('utf8');});
      child.stderr.on('data',b=>{stderr+=b.toString('utf8');});
      child.once('error',reject);
      child.once('close',code=>{clearTimeout(timer); if(code) reject(new Error('生成流程图失败：'+stderr.slice(0,700))); else resolve(stdout);});
    });
    const result=JSON.parse(raw.trim());
    const stat=await fs.stat(output);
    if(stat.size===0) throw new Error('未生成有效的 PowerPoint 文件。');
    return {...result,bytes:stat.size};
  } finally { await fs.rm(specPath,{force:true}); }
}
module.exports.addFlowSlide = addFlowSlide;

// Copy-based editing for Word / Excel / Visio. The spec JSON is written next to the
// output copy; office-edit.ps1 applies it with the local Office automation and
// reports a structural acceptance check in its JSON result.
const editExtensions = { word: '.docx', excel: '.xlsx', visio: '.vsdx' };
async function runOfficeEdit(kind, input, output, spec) {
  if (!editExtensions[kind]) throw new Error('不支持的编辑类型。');
  const ext = path.extname(input).toLowerCase();
  const ok = { word: ['.docx', '.doc'], excel: ['.xlsx', '.xlsm', '.xls'], visio: ['.vsdx', '.vsd'] }[kind];
  if (!ok.includes(ext)) throw new Error('文件类型与所选编辑不匹配。');
  const specPath = output + '.json';
  await fs.writeFile(specPath, JSON.stringify(spec), 'utf8');
  try {
    const raw = await new Promise((resolve, reject) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
        realPath(path.join(__dirname, 'office-edit.ps1')), '-Kind', kind, '-InputPath', input, '-OutputPath', output, '-SpecPath', specPath],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      const timer = setTimeout(() => child.kill(), 180000);
      child.stdout.on('data', b => { stdout += b.toString('utf8'); if (stdout.length > 1000000) child.kill(); });
      child.stderr.on('data', b => { stderr += b.toString('utf8'); if (stderr.length > 20000) child.kill(); });
      child.once('error', reject);
      child.once('close', code => { clearTimeout(timer); if (code !== 0) reject(new Error('Office 编辑失败：' + stderr.slice(0, 700))); else resolve(stdout); });
    });
    const parsed = JSON.parse(raw.trim());
    const stat = await fs.stat(output);
    if (!stat.isFile() || stat.size === 0) throw new Error('Office 没有生成有效的编辑文件。');
    return { ...parsed, bytes: stat.size };
  } finally { await fs.rm(specPath, { force: true }); }
}
module.exports.runOfficeEdit = runOfficeEdit;
