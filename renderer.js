const $ = id => document.getElementById(id);
const storageKey = 'ai-code-desk-sessions-v1';
let folder = '', current = '', officeCurrent = '', officePreview = '', officeEdited = '', officeDeck = '', proposalId = '', backupId = '', busy = false, permissionMode = 'view';
let sessions = [], activeId = '', currentRequestId = '';
let workspaces = [];
let uploads = [];
const pendingToolSessions = new Map();
const pendingAssistants = new Map();
try { sessions = JSON.parse(localStorage.getItem(storageKey) || '[]'); if (!Array.isArray(sessions)) sessions = []; } catch { sessions = []; }
function persist() { try { localStorage.setItem(storageKey, JSON.stringify(sessions.slice(0, 30))); } catch {} }
function active() { return sessions.find(s => s.id === activeId); }
function notice(message, error = false) { $('notice').textContent = message; $('notice').style.color = error ? '#b14c5b' : '#7385a2'; }
async function run(fn) { if (busy) return; busy = true; document.querySelectorAll('button').forEach(b => { if (b.id !== 'stopSend') b.disabled = true; }); try { await fn(); } catch (e) { notice(e.message || String(e), true); } finally { busy = false; document.querySelectorAll('button').forEach(b => b.disabled = false); $('send').hidden = false; $('stopSend').hidden = true; renderPermission(); } }
const permissionNames = { view: ['仅可查看', '♢'], workspace: ['工作区内修改', '▱'], full: ['完全权限', '⬡'] };
function renderPermission() {
  const [label, icon] = permissionNames[permissionMode];
  $('permissionLabel').textContent = label; $('permissionIcon').textContent = icon;
  document.querySelectorAll('.permission-option').forEach(option => option.setAttribute('aria-checked', String(option.dataset.mode === permissionMode)));
  $('propose').disabled = permissionMode === 'view'; $('apply').disabled = permissionMode === 'view'; $('undo').disabled = permissionMode === 'view';
  $('modeHelp').textContent = permissionMode === 'view' ? '仅可查看模式不会修改文件。切换权限后可生成预览。' : '文件修改仍需预览和确认。完全权限还允许对话中的 Agent 运行 Windows 命令或启动后台任务。';
}
function closePermission() { $('permissionMenu').hidden = true; $('permissionButton').setAttribute('aria-expanded', 'false'); }
$('permissionButton').onclick = () => { const open = $('permissionMenu').hidden; $('permissionMenu').hidden = !open; $('permissionButton').setAttribute('aria-expanded', String(open)); };
document.querySelectorAll('.permission-option').forEach(option => { option.onclick = () => run(async () => {
  const mode = await window.desk.setPermission(option.dataset.mode); permissionMode = mode;
  if (mode === 'view') { proposalId = ''; $('preview').hidden = true; }
  closePermission(); notice('权限已切换为“' + permissionNames[mode][0] + '”。');
}); });
document.addEventListener('click', e => { if (!e.target.closest('.permission-wrap')) closePermission(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closePermission(); });
function tab(which) {
  for (const name of ['chat', 'editor', 'tasks', 'office']) { $(name + 'View').hidden = which !== name; $(name + 'Tab').classList.toggle('active', which === name); }
  if (which === 'tasks') refreshTasks().catch(e => notice(e.message, true));
}
$('chatTab').onclick = () => tab('chat');
$('editorTab').onclick = () => tab('editor');
$('tasksTab').onclick = () => tab('tasks');
$('officeTab').onclick = () => tab('office');
$('settingsButton').onclick = () => { $('settingsPanel').hidden = !$('settingsPanel').hidden; };
function renderSessions() {
  const list = $('sessions'); list.replaceChildren();
  for (const s of sessions) {
    const item = document.createElement('div'); item.className = 'session-item';
    const b = document.createElement('button'); b.className = 'session-row' + (s.id === activeId ? ' active' : ''); b.textContent = '☷  ' + s.title; b.title = s.title;
    b.onclick = () => { activeId = s.id; renderSessions(); renderMessages(); };
    const del = document.createElement('button'); del.className = 'session-delete'; del.textContent = '✕'; del.title = '删除会话'; del.onclick = (e) => { e.stopPropagation(); deleteSession(s.id); };
    item.append(b, del); list.append(item);
  }
}
function deleteSession(id) {
  const s = sessions.find(x => x.id === id);
  if (!s) return;
  if (!confirm('删除会话「' + (s.title || '新会话') + '」？此操作不可恢复。')) return;
  sessions = sessions.filter(x => x.id !== id);
  if (!sessions.length) { newSession(); return; }
  if (activeId === id) activeId = sessions[0].id;
  persist(); renderSessions(); renderMessages();
}
function renderWorkspaces() {
  const list = $('workspaces'); list.replaceChildren();
  for (const w of workspaces) {
    const item = document.createElement('div'); item.className = 'workspace-item';
    const b = document.createElement('button'); b.className = 'workspace-row' + (w.path === folder ? ' active' : ''); b.textContent = '▱  ' + w.name; b.title = w.path;
    b.onclick = () => run(async () => {
      if (w.path === folder) return;
      const r = await window.desk.selectFolder(w.path);
      folder = r.root; current = '';
      await showFolder(r.root);
      renderWorkspaces();
    });
    const del = document.createElement('button'); del.className = 'workspace-delete'; del.textContent = '✕'; del.title = '从列表移除（不删除磁盘文件）';
    del.onclick = (e) => { e.stopPropagation(); run(async () => {
      if (!confirm('从工作区列表移除「' + w.name + '」？\n磁盘上的文件不会被删除。')) return;
      const r = await window.desk.removeFolder(w.path);
      workspaces = r.workspaces;
      if (r.active) { folder = r.active; await showFolder(r.active); }
      else { folder = ''; clearWorkspaceView(); }
      renderWorkspaces();
    }); };
    item.append(b, del); list.append(item);
  }
}
function clearWorkspaceView() {
  $('workspaceName').textContent = '尚未打开文件夹';
  $('root').textContent = '';
  $('files').replaceChildren();
  $('selected').textContent = '未选择文件';
  $('selectedBadge').textContent = '';
  $('source').textContent = '选择左侧文件后查看内容。';
  $('currentContext').textContent = '提到文件名时自动读取';
  $('preview').hidden = true; $('undoPanel').hidden = true;
  refreshOfficePanels();
}
function newSession() {
  const s = { id: crypto.randomUUID(), title: '新会话', messages: [] };
  sessions.unshift(s); activeId = s.id; persist(); renderSessions(); renderMessages(); tab('chat');
}
$('newChat').onclick = newSession;
function renderMessages() {
  const s = active(), list = $('messages'); list.replaceChildren();
  $('chatTitle').textContent = s?.title || '新会话';
  if (!s || !s.messages.length) { const empty = document.createElement('div'); empty.className = 'empty'; empty.innerHTML = '<div class="empty-symbol">✦</div><strong>今天想做点什么？</strong><p>打开左侧项目文件夹，提到文件名即可让 AI 读取。<br>文件修改会先生成预览，由你确认后应用。</p>'; list.append(empty); return; }
  for (const m of s.messages) {
    const box = document.createElement('div'); box.className = 'message ' + m.role;
    const label = document.createElement('div'); label.className = 'author'; label.textContent = m.role === 'user' ? '你' : m.role === 'activity' ? '终端活动' : 'AI Code Desk';
    const body = document.createElement('div'); body.className = 'message-body';
    if (Array.isArray(m.content)) {
      const texts = m.content.filter(p => p.type === 'text').map(p => p.text).join('\n');
      const imgs = m.content.filter(p => p.type === 'image_url').length;
      body.textContent = texts + (imgs ? (texts ? '\n' : '') + '[已上传 ' + imgs + ' 张图片]' : '');
    } else body.textContent = m.content;
    box.append(label, body); list.append(box);
  }
  list.scrollTop = list.scrollHeight;
}
function makeRow(item, holder) {
  const row = document.createElement('button'); row.className = 'file-row' + (item.directory ? ' folder' : '') + (item.relative === current ? ' selected' : '');
  const icon = document.createElement('span'); icon.className = 'icon'; icon.textContent = item.directory ? '▸' : '▤';
  const label = document.createElement('span'); label.textContent = item.name; row.append(icon, label); row.title = item.relative; holder.append(row);
  if (item.directory) { const children = document.createElement('div'); children.className = 'children'; children.hidden = true; holder.append(children);
    row.onclick = () => run(async () => { if (children.hidden && !children.childElementCount) { const items = await window.desk.list(item.relative); items.forEach(x => makeRow(x, children)); } children.hidden = !children.hidden; icon.textContent = children.hidden ? '▸' : '▾'; });
  } else if (/\.(docx?|xlsx?|xlsm|pptx?|vsdx?)$/i.test(item.name)) { row.onclick = () => { officeCurrent = item.relative; officePreview = ''; officeEdited = ''; $('officeSelected').textContent = item.relative; $('officeResult').textContent = '可以读取结构、导出 PDF 预览，或在副本中编辑。'; $('officeOpen').hidden = true; $('officeOpenEdited').hidden = true; refreshOfficePanels(); tab('office'); }; 
  } else { row.onclick = () => run(async () => { const file = await window.desk.read(item.relative); current = file.relative; $('selected').textContent = current; $('selectedBadge').textContent = '· ' + item.name; $('source').textContent = file.text; $('currentContext').textContent = '当前：' + item.name; $('preview').hidden = true; proposalId = ''; document.querySelectorAll('.file-row.selected').forEach(x => x.classList.remove('selected')); row.classList.add('selected'); notice('已读取 ' + current); tab('editor'); }); }
}
async function listRoot() { const items = await window.desk.list(''); const tree = $('files'); tree.replaceChildren(); items.forEach(x => makeRow(x, tree)); }
async function showFolder(chosen) { folder = chosen; current = ''; officeCurrent = ''; officePreview = ''; officeEdited = ''; proposalId = ''; backupId = ''; $('workspaceName').textContent = '▱  ' + chosen.split(/[\\/]/).filter(Boolean).at(-1); $('root').textContent = chosen; $('selected').textContent = '未选择文件'; $('selectedBadge').textContent = ''; $('source').textContent = '选择左侧文件后查看内容。'; $('currentContext').textContent = '提到文件名时自动读取'; $('preview').hidden = true; $('undoPanel').hidden = true; $('subtitle').textContent = chosen; refreshOfficePanels(); renderWorkspaces(); await listRoot(); notice('已打开项目：' + chosen); }
$('folderButton').onclick = () => run(async () => { const r = await window.desk.chooseFolder(); if (!r) return; workspaces = r.workspaces; await showFolder(r.root); renderWorkspaces(); });
$('save').onclick = () => run(async () => { const config = await window.desk.saveConfig({ baseUrl: $('baseUrl').value, model: $('model').value, key: $('key').value }); $('key').value = ''; $('key').placeholder = config.hasKey ? '已安全保存；留空保持原密钥' : 'API Key'; $('settingsPanel').hidden = true; notice('模型连接已保存。'); });
$('propose').onclick = () => run(async () => { if (!current) throw Error('请先从左侧选择一个文本文件。'); notice('AI 正在生成修改建议…'); const result = await window.desk.propose(current, $('instruction').value); if (!result.changed) { notice('模型没有修改文件。'); return; } proposalId = result.id; $('diff').textContent = result.diff; $('preview').hidden = false; $('preview').scrollIntoView({ behavior: 'smooth' }); notice('请检查差异，确认后才会写入文件。'); });
$('apply').onclick = () => run(async () => { if (!proposalId) throw Error('没有可应用的修改预览。'); const result = await window.desk.apply(proposalId); proposalId = ''; backupId = result.backupId; $('preview').hidden = true; $('undoPanel').hidden = false; $('source').textContent = (await window.desk.read(current)).text; notice('修改已应用。'); });
$('discard').onclick = () => { proposalId = ''; $('preview').hidden = true; notice('已放弃预览，文件未改变。'); };
$('undo').onclick = () => run(async () => { await window.desk.undo(backupId); backupId = ''; $('undoPanel').hidden = true; $('source').textContent = (await window.desk.read(current)).text; notice('已恢复修改前的文件。'); });
function buildUploadContent(input) {
  const texts = uploads.filter(u => u.kind === 'text');
  const images = uploads.filter(u => u.kind === 'image').slice(0, 4);
  let head = input;
  if (texts.length) {
    head += (head ? '\n\n' : '') + '[用户上传的文件]\n' + texts.map(u => '《' + u.name + '》\n' + u.text).join('\n\n');
  }
  if (images.length) {
    const parts = [{ type: 'text', text: head || '请识别这些图片。' }];
    for (const img of images) parts.push({ type: 'image_url', image_url: { url: img.dataUrl } });
    return parts;
  }
  return head;
}
function renderUploads() {
  const holder = $('uploads');
  holder.replaceChildren();
  holder.hidden = uploads.length === 0;
  uploads.forEach((u, i) => {
    const chip = document.createElement('span'); chip.className = 'upload-chip';
    const icon = document.createElement('span'); icon.className = 'upload-icon'; icon.textContent = u.kind === 'image' ? '🖼' : '📄';
    const label = document.createElement('span'); label.className = 'upload-name'; label.textContent = u.name; label.title = u.name + (u.note ? '\n' + u.note : '');
    const x = document.createElement('button'); x.className = 'upload-remove'; x.textContent = '✕'; x.title = '移除';
    x.onclick = () => { uploads.splice(i, 1); renderUploads(); };
    chip.append(icon, label, x); holder.append(chip);
  });
}
$('attachButton').onclick = () => run(async () => {
  const file = await window.desk.uploadFile();
  if (!file) return;
  uploads.push(file);
  renderUploads();
  notice('已附加：' + file.name + (file.note ? '（' + file.note + '）' : ''));
});
async function send() {
  const input = $('chatInput').value.trim();
  if (!input && !uploads.length) return;
  if ($('includeFile').checked && !current) throw Error('请先选择文件，或取消“始终附带当前文件”。');
  const s = active();
  const requestId = crypto.randomUUID();
  currentRequestId = requestId;
  const userEntry = { role: 'user', content: buildUploadContent(input) };
  const assistantEntry = { role: 'assistant', content: '' };
  const sentUploads = uploads;
  uploads = [];
  renderUploads();
  $('chatInput').value = '';
  s.messages.push(userEntry, assistantEntry);
  if (s.title === '新会话') s.title = input.slice(0, 30);
  persist(); renderSessions(); renderMessages(); notice('AI 正在回复…');
  pendingToolSessions.set(requestId, s.id);
  pendingAssistants.set(requestId, { message: assistantEntry, sessionId: s.id });
  $('send').hidden = true; $('stopSend').hidden = false;
  try {
    const history = s.messages.filter(m => (m.role === 'user' || m.role === 'assistant') && m !== assistantEntry).slice(-20);
    const result = await window.desk.chat(history, current, $('includeFile').checked, requestId);
    if (result.answer && typeof result.answer === 'string' && !assistantEntry.content) assistantEntry.content = result.answer;
    if (result.stopped && !assistantEntry.content) assistantEntry.content = '（已停止生成。）';
    persist(); renderMessages();
    notice(result.files.length ? '已读取并发送文件：' + result.files.join('、') : (result.stopped ? '已停止生成。' : '回复完成。'));
  } catch (e) {
    s.messages = s.messages.filter(m => m !== userEntry && m !== assistantEntry);
    uploads = sentUploads; renderUploads();
    persist(); renderMessages(); $('chatInput').value = input;
    throw e;
  } finally {
    pendingToolSessions.delete(requestId);
    pendingAssistants.delete(requestId);
    if (currentRequestId === requestId) currentRequestId = '';
  }
}
window.desk.onChatChunk(event => {
  const slot = pendingAssistants.get(event.requestId);
  if (!slot) return;
  slot.message.content += event.delta;
  persist();
  const s = sessions.find(item => item.id === slot.sessionId);
  if (s && s.id === activeId) renderMessages();
});
$('stopSend').onclick = () => { if (currentRequestId) window.desk.stopChat(currentRequestId); notice('正在停止生成…'); };
window.desk.onToolEvent(event => {
  const id = pendingToolSessions.get(event.requestId), s = sessions.find(item => item.id === id);
  if (!s) return;
  const previous = [...s.messages].reverse().find(m => m.role === 'activity' && m.requestId === event.requestId && m.command === event.command && m.running);
  if (event.stage === 'running') s.messages.push({ role: 'activity', requestId: event.requestId, command: event.command, running: true, content: '调用工具：' + event.command + '\n执行中…' });
  else {
    const r = event.result || {};
    const content = '工具：' + event.command + '\n' + JSON.stringify(r, null, 2).slice(0, 16000);
    if (previous) { previous.running = false; previous.content = content; } else s.messages.push({ role: 'activity', requestId: event.requestId, command: event.command, content });
  }
  persist(); if (activeId === s.id) renderMessages();
  if (event.stage === 'done' && event.command?.startsWith('start_task')) refreshTasks().catch(() => {});
});
$('send').onclick = () => run(send);
$('chatInput').onkeydown = e => { if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); run(send); } };
if (!sessions.length) newSession(); else { activeId = sessions[0].id; renderSessions(); renderMessages(); }
renderPermission();
window.desk.config().then(c => { $('baseUrl').value = c.baseUrl; $('model').value = c.model; $('key').placeholder = c.hasKey ? '已安全保存；留空保持原密钥' : 'API Key'; if (!c.hasKey) $('settingsPanel').hidden = false; permissionMode = c.permissionMode || 'view'; renderPermission(); }).catch(e => notice(e.message, true));
window.desk.workspaces().then(async r => {
  workspaces = r.workspaces || [];
  renderWorkspaces();
  if (r.active) await showFolder(r.active);
  else clearWorkspaceView();
}).catch(e => notice(e.message, true));

function taskStatus(status) { return { starting: '启动中', running: '运行中', completed: '已完成', failed: '失败', stopped: '已停止', unknown: '状态未知' }[status] || status; }
function taskButton(label, action) { const button = document.createElement('button'); button.className = 'quiet-button'; button.textContent = label; button.onclick = () => run(action); return button; }
async function refreshTasks() {
  const tasks = await window.desk.listTasks(), list = $('taskList');
  list.replaceChildren();
  if (!tasks.length) { const empty = document.createElement('p'); empty.className = 'tasks-empty'; empty.textContent = '还没有后台任务。切换到“完全权限”，在对话中要求 Agent 启动长任务并说明预期产物。'; list.append(empty); return; }
  for (const task of tasks) {
    const card = document.createElement('article'); card.className = 'task-card';
    const head = document.createElement('div'); head.className = 'task-card-head';
    const title = document.createElement('strong'); title.textContent = taskStatus(task.status);
    const time = document.createElement('span'); time.textContent = new Date(task.startedAt).toLocaleString();
    head.append(title, time);
    const command = document.createElement('code'); command.textContent = task.command;
    const meta = document.createElement('div'); meta.className = 'task-meta';
    meta.textContent = '任务 ID：' + task.id + '  ·  目录：' + task.cwd + (task.exitCode == null ? '' : '  ·  退出码：' + task.exitCode);
    const artifacts = document.createElement('div'); artifacts.className = 'task-artifacts';
    artifacts.textContent = task.expectedArtifacts.length ? '预期产物：' + task.expectedArtifacts.join('、') : '未指定预期产物；需要提供路径才能做产物验收。';
    const actions = document.createElement('div'); actions.className = 'task-actions';
    const detail = document.createElement('div'); detail.className = 'task-detail'; detail.hidden = true;
    actions.append(taskButton('查看日志', async () => {
      const full = await window.desk.inspectTask(task.id);
      detail.hidden = false; detail.textContent = '状态：' + taskStatus(full.status) + '\n标准输出（末尾）：\n' + (full.stdoutTail || '无') + '\n\n错误输出（末尾）：\n' + (full.stderrTail || '无');
    }));
    actions.append(taskButton('验收产物', async () => {
      const result = await window.desk.verifyTask(task.id);
      detail.hidden = false;
      detail.textContent = (result.verified ? '基础验收通过：' : '基础验收未通过：') + result.reason + '\n' +
        result.checks.map(x => x.path + ' | ' + (x.exists ? (x.bytes + ' 字节，更新时间 ' + x.modifiedAt + (x.fresh ? '，已更新' : '，未更新')) : '不存在')).join('\n') + '\n内容质量仍需单独检查。';
      notice(result.verified ? '任务产物基础验收通过。' : '任务产物基础验收未通过。', !result.verified);
    }));
    if (task.status === 'starting' || task.status === 'running') actions.append(taskButton('停止任务', async () => {
      await window.desk.stopTask(task.id); await refreshTasks(); notice('任务已停止。');
    }));
    card.append(head, command, meta, artifacts, actions, detail); list.append(card);
  }
}
$('refreshTasks').onclick = () => run(refreshTasks);
setInterval(() => { if (!$('tasksView').hidden && !busy) refreshTasks().catch(e => notice(e.message, true)); }, 3000);

$('officeInspect').onclick = () => run(async () => {
  if (!officeCurrent) throw Error('请先选择 Office 文件。');
  notice('正在读取 Office 文件结构…');
  const result = await window.desk.inspectOffice(officeCurrent);
  $('officeResult').textContent = JSON.stringify(result, null, 2);
  notice('结构读取完成。');
});
$('officeExport').onclick = () => run(async () => {
  if (!officeCurrent) throw Error('请先选择 Office 文件。');
  notice('Office 正在导出 PDF…');
  const result = await window.desk.exportOffice(officeCurrent);
  officePreview = result.output; $('officeOpen').hidden = false;
  $('officeResult').textContent = 'PDF 预览：' + result.output + '\n大小：' + result.bytes + ' 字节\n请打开检查分页、字体和图形。';
  notice('PDF 已导出，请打开检查。');
});
$('officeOpen').onclick = () => run(async () => { if (officePreview) await window.desk.openOfficePreview(officePreview); });

$('officeFlow').onclick = () => run(async () => {
  if (!officeCurrent) throw Error('请先选择 PowerPoint 文件。');
  const steps = $('flowSteps').value.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  notice('正在生成可编辑流程图与 PDF 预览…');
  const result = await window.desk.addFlowSlide(officeCurrent, $('flowTitle').value.trim(), steps);
  officeDeck = result.output; officePreview = result.pdf;
  $('officeOpenDeck').hidden = false; $('officeOpen').hidden = false;
  $('officeResult').textContent = '新演示文稿：' + officeDeck + '\nPDF 预览：' + officePreview + '\n共 ' + result.slideCount + ' 页。原文件未修改，请打开检查新增页面。';
  notice('流程图已生成在副本中。');
});
$('officeOpenEdited').onclick = () => run(async () => { if (officeEdited) await window.desk.openOfficePreview(officeEdited); });

function refreshOfficePanels() {
  const ext = (officeCurrent || '').toLowerCase();
  $('wordEditPanel').hidden = !/\.docx?$/i.test(ext);
  $('excelEditPanel').hidden = !/\.xlsx?$|\.xlsm$/i.test(ext);
  $('visioEditPanel').hidden = !/\.vsdx?$/i.test(ext);
  $('flowPanel').hidden = !/\.pptx?$/i.test(ext);
}
$('wordEdit').onclick = () => run(async () => {
  if (!officeCurrent) throw Error('请先选择 Word 文件。');
  const actions = [];
  for (const line of $('wordAppend').value.split(/\r?\n/).map(x => x.trim()).filter(Boolean)) {
    if (line.startsWith('#')) actions.push({ type: 'append_heading', text: line.slice(1).trim(), level: 1 });
    else actions.push({ type: 'append_paragraph', text: line });
  }
  const tableRows = $('wordTable').value.split(/\r?\n/).map(x => x.trim()).filter(Boolean).map(row => row.split('|').map(c => c.trim()));
  if (tableRows.length) actions.push({ type: 'append_table', rows: tableRows });
  if (!actions.length) throw Error('请填写要追加的段落或表格。');
  notice('Word 正在副本中编辑并导出 PDF…');
  const result = await window.desk.editOffice(officeCurrent, 'word', { actions });
  officePreview = result.pdf; officeEdited = result.output;
  $('officeOpen').hidden = false; $('officeOpenEdited').hidden = false;
  const checks = (result.appendedCheck || []).map(x => (x.found ? '✓' : '✗') + ' ' + x.text).join('；');
  $('officeResult').textContent = '编辑副本：' + result.output + '\nPDF 预览：' + result.pdf + '\n段落数：' + result.paragraphs + '，表格数：' + result.tables + '\n追加内容核对：' + (checks || '无') + '\n布局与字体请打开预览人工检查。';
  notice('Word 编辑副本已生成。');
});
$('excelEdit').onclick = () => run(async () => {
  if (!officeCurrent) throw Error('请先选择 Excel 文件。');
  const sheet = $('excelSheet').value.trim() || 'Sheet1';
  const cells = $('excelCells').value.split(/\r?\n/).map(x => x.trim()).filter(Boolean).map(line => {
    const m = line.match(/^([A-Za-z]{1,3}\d+)\s*=\s*(.+)$/);
    if (!m) throw Error('单元格行格式应为 A1=值（公式以 = 开头，如 C3==SUM(A1:A2)）。');
    return { sheet, cell: m[1].toUpperCase(), value: m[2] };
  });
  if (!cells.length) throw Error('请填写要写入的单元格。');
  notice('Excel 正在副本中编辑、重算并导出 PDF…');
  const result = await window.desk.editOffice(officeCurrent, 'excel', { cells });
  officePreview = result.pdf; officeEdited = result.output;
  $('officeOpen').hidden = false; $('officeOpenEdited').hidden = false;
  const checks = (result.checks || []).map(c => c.sheet + '!' + c.cell + ' = ' + c.text + (c.error ? '（公式错误）' : '')).join('；');
  $('officeResult').textContent = '编辑副本：' + result.output + '\nPDF 预览：' + result.pdf + '\n写入结果：' + checks + '\n公式错误单元格：' + (result.errorCells.length ? result.errorCells.join('；') : '无') + '\n数值与图表请打开副本检查。';
  notice('Excel 编辑副本已生成。');
});
$('visioEdit').onclick = () => run(async () => {
  if (!officeCurrent) throw Error('请先选择 Visio 文件。');
  const steps = $('visioSteps').value.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  if (steps.length < 2) throw Error('流程图需要至少两个步骤（每行一步）。');
  notice('Visio 正在副本中绘制流程图并导出 PDF…');
  const result = await window.desk.editOffice(officeCurrent, 'visio', { steps, pageTitle: $('visioTitle').value.trim() || '流程图' });
  officePreview = result.pdf; officeEdited = result.output;
  $('officeOpen').hidden = false; $('officeOpenEdited').hidden = false;
  $('officeResult').textContent = '编辑副本：' + result.output + '\nPDF 预览：' + result.pdf + '\n新增页面：' + result.page + '，形状数：' + result.shapes + '，步骤：' + result.steps + '\n连线与标签请打开预览人工检查。';
  notice('Visio 流程图副本已生成。');
});
refreshOfficePanels();
$('officeOpenDeck').onclick = () => run(async () => { if (officeDeck) await window.desk.openOfficePreview(officeDeck); });
