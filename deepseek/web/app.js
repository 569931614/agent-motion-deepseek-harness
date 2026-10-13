const $ = id => document.getElementById(id);
if (new URLSearchParams(location.search).get('embedded') === '1') document.documentElement.dataset.embedded = '';
const apiRoot = '/api/agent-motion';
const storageKey = 'agent-motion-task-id';
const uncertainKey = 'agent-motion-execute-uncertain';
const terminal = new Set(['completed', 'failed', 'cancelled']);
const resolvedApprovals = new Set();
const statusNames = { 'awaiting-upload': '等待上传', ready: '素材就绪', queued: '等待制作', running: '正在制作', stopping: '正在停止', completed: '制作完成', failed: '制作失败', cancelled: '已停止' };
let videoFile, sourceUrl, task, polling, upload, operation = 0, busy = false, approvalBusy = false, retryAction, restoredFormId, uncertainId;
let config = { ready: false, message: '正在检查制作服务。', defaultVoice: '' }, configLoading = true;
try { uncertainId = localStorage.getItem(uncertainKey); } catch {}

function endpoint(route, id) { return `${apiRoot}/${route}${id ? `?id=${encodeURIComponent(id)}` : ''}`; }
function remember(id) { try { localStorage.setItem(storageKey, id); } catch {} }
function markUncertain(id) { uncertainId = id; try { if (id) localStorage.setItem(uncertainKey, id); else localStorage.removeItem(uncertainKey); } catch {} }
function localUrl(value) {
  if (typeof value !== 'string' || !value) return;
  try { const url = new URL(value, location.href); return url.origin === location.origin && /^https?:$/.test(url.protocol) ? url.href : undefined; } catch {}
}
function hideError() { $('errorBox').hidden = true; $('authBox').hidden = true; retryAction = undefined; }
function showError(error, retry) {
  $('errorBox').hidden = false;
  $('errorTitle').textContent = error.status === 401 ? '登录状态需要更新' : '操作未完成';
  $('errorMessage').textContent = error.message || '连接中断，请稍后重试。';
  $('authBox').hidden = error.status !== 401;
  $('retryButton').hidden = !retry;
  $('retryButton').textContent = error.status === 401 ? '登录后重试' : '重试当前步骤';
  retryAction = retry;
}
async function api(route, id, body) {
  const response = await fetch(endpoint(route, id), {
    method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(response.status === 401 ? '请先在 Harness 首页登录，再回来重试当前步骤。' : result.error || `请求失败（HTTP ${response.status}）。`);
    error.status = response.status;
    throw error;
  }
  if (!result || typeof result !== 'object') throw new Error('服务返回了无法识别的任务信息。');
  return result;
}
function setBusy(value) { busy = value; render(); }
function selectedVoiceSource() { return document.querySelector('input[name="voiceSource"]:checked')?.value === 'existing' ? 'existing' : 'video'; }
function restoreForm(value) {
  if (!value || typeof value.subtitles !== 'string' || restoredFormId === value.id) return;
  $('subtitles').value = value.subtitles;
  $('title').value = typeof value.title === 'string' ? value.title : '';
  $('voice').value = typeof value.voice === 'string' ? value.voice : '';
  const source = value.voiceSource === 'video' ? 'video' : value.voiceSource === 'existing' || value.voice ? 'existing' : 'video';
  for (const radio of document.querySelectorAll('input[name="voiceSource"]')) radio.checked = radio.value === source;
  for (const radio of document.querySelectorAll('input[name="style"]')) radio.checked = radio.value === value.style;
  const resolution = `${value.width}x${value.height}`;
  if ([...$('resolution').options].some(option => option.value === resolution)) $('resolution').value = resolution;
  $('subtitles').dispatchEvent(new Event('input'));
  restoredFormId = value.id;
}
async function loadConfig() {
  configLoading = true; render();
  try {
    const result = await api('config');
    config = { ready: result.ready === true, message: typeof result.message === 'string' ? result.message : '请在 Harness 设置 → 动效工坊中补全制作服务配置。', defaultVoice: typeof result.defaultVoice === 'string' ? result.defaultVoice : '' };
    if (!$('voice').value.trim() && !task?.voice && config.defaultVoice) $('voice').value = config.defaultVoice;
    if (retryAction === loadConfig) hideError();
  } catch (error) {
    config = { ready: false, message: error.message || '无法读取制作服务配置，请重新检查。', defaultVoice: '' };
    showError(error, loadConfig);
  } finally { configLoading = false; render(); }
}
function setMedia(element, value) {
  const url = localUrl(value);
  if (url && element.src !== url) element.src = url;
  else if (!url && element.getAttribute('src')) { element.pause(); element.removeAttribute('src'); element.load(); }
  return !!url;
}
function render() {
  const status = task?.status;
  const uncertain = !!task && task.id === uncertainId;
  const active = task && !terminal.has(status);
  const approvals = active && Array.isArray(task.pendingApprovals) ? task.pendingApprovals.filter(value => value && typeof value === 'object' && typeof value.id === 'string' && !resolvedApprovals.has(`${task.id}:${value.id}`)) : [];
  const waitingApproval = approvals.length > 0;
  const editable = !active && !busy;
  const existingVoice = selectedVoiceSource() === 'existing';
  $('subtitles').disabled = !editable;
  $('title').disabled = !editable;
  $('voice').disabled = !editable || !existingVoice;
  $('voice').required = existingVoice;
  $('existingVoiceFields').hidden = !existingVoice;
  $('videoVoiceHelp').hidden = existingVoice;
  const createdVoice = task?.voiceSource === 'video' && typeof task.voice === 'string' ? task.voice.trim() : '';
  $('createdVoiceNotice').hidden = !createdVoice;
  $('createdVoiceNotice').textContent = createdVoice ? `本次音色 ID：${createdVoice}（可用于后续制作）` : '';
  document.querySelectorAll('input[name="voiceSource"]').forEach(input => { input.disabled = !editable; });
  $('resolution').disabled = !editable;
  document.querySelectorAll('input[name="style"]').forEach(input => { input.disabled = !editable; });
  $('importSubtitles').disabled = !editable;
  const canChooseVideo = !busy && (!active || status === 'awaiting-upload');
  $('videoInput').disabled = !canChooseVideo;
  $('chooseVideo').disabled = !canChooseVideo;
  $('changeVideo').disabled = !canChooseVideo;
  $('submitButton').disabled = busy || configLoading || !config.ready || uncertain || (active && !['awaiting-upload', 'ready'].includes(status));
  $('submitLabel').textContent = busy ? (upload ? '正在上传…' : '正在提交…') : uncertain ? '提交状态待核对' : status === 'awaiting-upload' ? '继续上传并制作' : status === 'ready' ? '继续制作' : task && terminal.has(status) ? '制作新视频' : '开始制作';
  $('formHint').textContent = uncertain ? '请查看任务状态，避免重复提交收费制作。' : active ? '任务已保存，文案、音色来源与风格沿用本次提交。' : '复刻与配音、数字人口播、抠像、动效与成片输出';
  $('configTitle').textContent = configLoading ? '正在检查制作服务' : config.ready ? '制作服务已配置' : '制作服务尚未就绪';
  $('configMessage').textContent = configLoading ? '读取配置状态，不会提交配音或数字人任务。' : config.ready ? config.message : `${config.message} 请前往设置 → 动效工坊，保存后配置状态自动更新。`;
  $('configBox').dataset.ready = String(config.ready);
  $('configRetryButton').disabled = configLoading || busy;
  $('cancelButton').hidden = !active || !status || status === 'unknown';
  $('cancelButton').disabled = approvalBusy;
  $('statusBadge').textContent = waitingApproval ? '等待操作确认' : statusNames[status] || (task ? '恢复任务中' : '等待素材');
  $('statusBadge').dataset.status = status || '';
  $('taskHeading').textContent = waitingApproval ? '等待操作确认。' : status === 'completed' ? '你的成片，已准备就绪。' : status === 'failed' ? '制作未完成，可查看任务记录。' : status === 'cancelled' ? '制作已停止。' : active ? '让制作流程接管。' : '准备好，就开始。';
  $('stageMessage').textContent = task ? [task.stage, task.message].filter(value => typeof value === 'string' && value).join(' · ') || statusNames[status] || '正在恢复任务状态…' : '制作任务会在这里显示实际进度。';
  $('workingProgress').hidden = waitingApproval || !['queued', 'running'].includes(status);
  $('workingProgress').querySelector('p').textContent = status === 'queued' ? '任务已进入队列，等待制作开始。' : '后台正在处理，页面可保持打开。';
  const sessionUrl = localUrl(task?.sessionUrl);
  $('sessionLink').hidden = !sessionUrl;
  if (sessionUrl) { $('sessionLink').href = sessionUrl; $('sessionLink').textContent = `在 Harness 查看：${task.sessionTitle || task.workspaceName || task.sessionId} ↗`; }
  $('approvalPanel').hidden = !waitingApproval;
  $('approvalList').replaceChildren(...approvals.map(approval => {
    const item = document.createElement('article'); item.className = 'approval-item';
    const heading = document.createElement('h4'); heading.textContent = typeof approval.toolName === 'string' ? approval.toolName : '制作工具操作';
    const reason = document.createElement('p'); reason.textContent = typeof approval.reason === 'string' ? approval.reason : '此操作需要确认后继续。';
    const details = document.createElement('pre'); details.textContent = typeof approval.details === 'string' ? approval.details : JSON.stringify(approval.details ?? {}, null, 2);
    details.tabIndex = 0; details.setAttribute('aria-label', '完整工具参数');
    const actions = document.createElement('div'); actions.className = 'approval-actions';
    const allow = document.createElement('button'); allow.type = 'button'; allow.className = 'secondary-button'; allow.textContent = '允许本次操作';
    allow.disabled = busy || approval.complete !== true; allow.onclick = () => decideApproval(approval.id, 'allowed-once');
    const reject = document.createElement('button'); reject.type = 'button'; reject.className = 'secondary-button danger'; reject.textContent = '拒绝并停止';
    reject.disabled = busy; reject.onclick = () => decideApproval(approval.id, 'rejected');
    actions.append(allow, reject); item.append(heading, reason, details);
    if (approval.complete !== true) { const hint = document.createElement('p'); hint.className = 'approval-hint'; hint.textContent = '页面无法完整显示操作参数，请拒绝并停止，再到 Harness 会话检查。'; item.append(hint); }
    item.append(actions); return item;
  }));
  const videoUrl = localUrl(task?.result?.videoUrl), previewUrl = localUrl(task?.result?.previewUrl), projectUrl = localUrl(task?.result?.projectUrl);
  $('resultVideo').hidden = !videoUrl;
  $('resultEmpty').hidden = !!videoUrl;
  $('resultPlaceholder').textContent = status === 'completed' && !videoUrl ? '任务已结束，请在会话中查看产物' : status === 'failed' ? '制作完成后，成片会显示在这里' : '成片将在这里出现';
  if (videoUrl && $('resultVideo').src !== videoUrl) $('resultVideo').src = videoUrl;
  else if (!videoUrl && $('resultVideo').getAttribute('src')) { $('resultVideo').pause(); $('resultVideo').removeAttribute('src'); $('resultVideo').load(); }
  $('downloadLink').hidden = !videoUrl;
  $('projectLink').hidden = !projectUrl;
  $('previewLink').hidden = !previewUrl;
  $('resultLinks').hidden = !videoUrl && !previewUrl && !projectUrl;
  if (videoUrl) $('downloadLink').href = videoUrl;
  if (projectUrl) { $('projectLink').href = projectUrl; $('projectLink').download = `agent-motion-${task.id}.zip`; }
  if (previewUrl) $('previewLink').href = previewUrl;
  const events = Array.isArray(task?.events) ? task.events.filter(value => typeof value === 'string').slice(-50) : [];
  $('eventDetails').hidden = events.length === 0;
  $('eventCount').textContent = events.length ? `（${events.length}）` : '';
  $('eventList').replaceChildren(...events.map(value => { const item = document.createElement('li'); item.textContent = value; return item; }));
  const audioAvailable = setMedia($('audioPreview'), task?.media?.audioUrl), avatarAvailable = setMedia($('avatarPreview'), task?.media?.avatarUrl);
  $('audioPreviewWrap').hidden = !audioAvailable;
  $('avatarPreviewWrap').hidden = !avatarAvailable;
  $('mediaDetails').hidden = !audioAvailable && !avatarAvailable;
  const phases = ['upload', 'clone', 'voice', 'avatar', 'subtitles', 'matte', 'composition', 'export'];
  const stage = task?.stage || '';
  const phase = phases.includes(task?.phase) ? task.phase : ['awaiting-upload', 'ready'].includes(status) ? 'upload' : /数字人|MuseTalk|口型|上传素材/i.test(stage) ? 'avatar' : /音色|复刻|声音样本/i.test(stage) ? 'clone' : /配音|CosyVoice|语音/i.test(stage) ? 'voice' : /对齐字幕|字幕对齐|align-subtitles/i.test(stage) ? 'subtitles' : /抠图|抠像|matte/i.test(stage) ? 'matte' : /渲染|导出|编码|render|export/i.test(stage) ? 'export' : 'composition';
  const phaseIndex = phases.indexOf(phase);
  for (const item of document.querySelectorAll('[data-phase]')) {
    const itemPhase = item.dataset.phase;
    const skipped = itemPhase === 'clone' && task?.voiceSource === 'existing';
    item.classList.toggle('skipped', skipped);
    item.title = skipped ? '使用已有音色 ID，已跳过复刻' : '';
    item.classList.toggle('active', !skipped && !waitingApproval && (status === 'awaiting-upload' || ['queued', 'running'].includes(status)) && itemPhase === phase);
    item.classList.toggle('done', !skipped && (status === 'completed' || (itemPhase === 'upload' && ['ready', 'queued', 'running', 'stopping'].includes(status)) || (['queued', 'running'].includes(status) && phases.indexOf(itemPhase) < phaseIndex)));
  }
}
function selectVideo(file) {
  if (!file || $('videoInput').disabled) return;
  if (!/\.mp4$/i.test(file.name) || (file.type && !['video/mp4', 'application/octet-stream'].includes(file.type))) return showError(new Error('请选择 MP4 格式的人像视频。'));
  if (!file.size || file.size > 1024 ** 3) return showError(new Error('视频须大于 0 字节，且不能超过 1 GB。'));
  hideError();
  if (sourceUrl) URL.revokeObjectURL(sourceUrl);
  videoFile = file;
  sourceUrl = URL.createObjectURL(file);
  $('sourceVideo').src = sourceUrl;
  $('sourceVideo').hidden = false;
  $('videoEmpty').hidden = true;
  $('changeVideo').hidden = false;
  $('videoFilename').textContent = file.name;
  $('videoDetails').textContent = `${(file.size / 1024 ** 2).toFixed(1)} MB · 本地预览`;
  $('sourceVideo').onloadedmetadata = () => {
    const seconds = Math.floor($('sourceVideo').duration);
    $('videoDetails').textContent = `${(file.size / 1024 ** 2).toFixed(1)} MB · ${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒 · ${$('sourceVideo').videoWidth} × ${$('sourceVideo').videoHeight}`;
  };
  $('sourceVideo').onerror = () => showError(new Error('浏览器无法预览该视频，请检查 MP4 编码或更换原片。'));
}
function uploadVideo(id, file) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    upload = xhr;
    xhr.open('POST', endpoint('upload', id));
    xhr.withCredentials = true;
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    $('uploadProgressWrap').hidden = false;
    $('uploadProgress').value = 0;
    $('uploadPercent').textContent = '0%';
    render();
    xhr.upload.onprogress = event => {
      if (!event.lengthComputable) { $('uploadProgress').removeAttribute('value'); $('uploadPercent').textContent = '上传中'; return; }
      const percent = Math.floor(event.loaded / event.total * 100);
      $('uploadProgress').value = percent;
      $('uploadPercent').textContent = `${percent}%`;
    };
    const finish = () => { if (upload === xhr) upload = undefined; };
    xhr.onload = () => {
      finish();
      let result; try { result = JSON.parse(xhr.responseText); } catch { result = {}; }
      if (xhr.status >= 200 && xhr.status < 300) resolve(result);
      else { const error = new Error(xhr.status === 401 ? '登录状态已失效，请登录后重新上传原片。' : result.error || `视频上传失败（HTTP ${xhr.status}）。`); error.status = xhr.status; reject(error); }
    };
    xhr.onerror = () => { finish(); reject(new Error('视频上传连接中断，可重试当前任务。')); };
    xhr.onabort = () => { finish(); reject(new Error('视频上传已停止。')); };
    xhr.send(file);
  });
}
async function refreshTask() {
  if (!task?.id) return;
  clearTimeout(polling);
  const id = task.id;
  try {
    const next = await api('status', id);
    if (task?.id !== id) return;
    task = { ...task, ...next, id };
    restoreForm(task);
    if (task.id === uncertainId && (terminal.has(task.status) || ['queued', 'running', 'stopping'].includes(task.status))) markUncertain(undefined);
    render();
    if (!terminal.has(task.status)) polling = setTimeout(refreshTask, 3000);
  } catch (error) {
    if (task?.id !== id) return;
    if (error.status === 404) {
      task = undefined;
      markUncertain(undefined); restoredFormId = undefined;
      try { localStorage.removeItem(storageKey); } catch {}
      $('restoreNote').hidden = true;
      render();
      showError(new Error('上次任务已不可用，请重新选择素材开始制作。'));
    } else showError(error, () => { hideError(); refreshTask(); });
  }
}
async function submit() {
  if (busy) return;
  if (task && task.id === uncertainId) { showError(new Error('制作提交状态尚未确认，请查看任务状态，不要重复提交收费任务。'), refreshTask); return; }
  if (configLoading || !config.ready) { showError(new Error(config.message || '请先配置制作服务，再开始制作。'), loadConfig); return; }
  const run = ++operation;
  hideError();
  clearTimeout(polling);
  if (!task || terminal.has(task.status)) {
    if (!videoFile) { showError(new Error('请先选择 MP4 人像视频。')); $('chooseVideo').focus(); return; }
    if (!$('subtitles').value.trim()) { showError(new Error('请粘贴字幕文案，或导入 SRT / TXT 文件。')); $('subtitles').focus(); return; }
    if (selectedVoiceSource() === 'existing' && !$('voice').value.trim()) { showError(new Error('请填写绑定 CosyVoice-v3.5-plus 的音色 ID。')); $('voice').focus(); return; }
  } else if (!['awaiting-upload', 'ready'].includes(task.status)) return;
  if (task?.status === 'awaiting-upload' && !videoFile) { showError(new Error('任务已恢复，请选择本次任务的同一原视频，再继续上传。')); $('chooseVideo').focus(); return; }
  setBusy(true);
  try {
    if (!task || terminal.has(task.status)) {
      const [width, height] = $('resolution').value.split('x').map(Number);
      const voiceSource = selectedVoiceSource();
      const created = await api('tasks', undefined, { subtitles: $('subtitles').value.trim(), voiceSource, ...(voiceSource === 'existing' ? { voice: $('voice').value.trim() } : {}), title: $('title').value.trim(), style: document.querySelector('input[name="style"]:checked').value, width, height });
      if (run !== operation) return;
      if (typeof created.id !== 'string' || !created.id) throw new Error('服务未返回任务编号，请重试。');
      task = created;
      restoreForm(task);
      remember(task.id);
      $('restoreNote').hidden = true;
      render();
    }
    if (task.status === 'awaiting-upload') {
      const uploaded = await uploadVideo(task.id, videoFile);
      if (run !== operation) return;
      task = { ...task, ...uploaded, status: uploaded.status || 'ready' };
      $('uploadProgressWrap').hidden = true;
    }
    markUncertain(task.id);
    const executed = await api('execute', task.id, {});
    if (run !== operation) return;
    markUncertain(undefined);
    task = { ...task, ...executed, status: executed.status || 'queued' };
    render();
    refreshTask();
  } catch (error) {
    if (run === operation) {
      if (task?.id === uncertainId && [400, 401, 403, 404, 409, 413, 415, 503].includes(error.status)) markUncertain(undefined);
      if (task && task.id === uncertainId) {
        error.message = `${error.message} 制作提交状态需要核对，请查询当前任务，避免重复提交收费任务。`;
        showError(error, refreshTask);
      } else showError(error, submit);
    }
  }
  finally { if (run === operation) { setBusy(false); $('uploadProgressWrap').hidden = true; } }
}
async function cancelTask() {
  if (!task?.id || terminal.has(task.status)) return;
  const id = task.id;
  ++operation;
  clearTimeout(polling);
  upload?.abort();
  setBusy(true);
  $('uploadProgressWrap').hidden = true;
  $('cancelButton').disabled = true;
  hideError();
  try { const cancelled = await api('cancel', id, {}); if (task?.id === id) { task = { ...task, ...cancelled }; if (terminal.has(task.status)) markUncertain(undefined); render(); refreshTask(); } }
  catch (error) { showError(error, cancelTask); }
  finally { setBusy(false); $('cancelButton').disabled = false; }
}
async function decideApproval(approvalId, decision) {
  if (busy || !task?.id || terminal.has(task.status) || resolvedApprovals.has(`${task.id}:${approvalId}`)) return;
  const pending = task.pendingApprovals?.find(value => value.id === approvalId);
  if (!pending || (decision === 'allowed-once' && pending.complete !== true)) return;
  const id = task.id;
  clearTimeout(polling); hideError(); approvalBusy = true; setBusy(true);
  let accepted = false;
  try {
    await api('approval', id, { approvalId, decision });
    resolvedApprovals.add(`${id}:${approvalId}`);
    accepted = true;
  } catch (error) {
    if (error.status === 409) { resolvedApprovals.add(`${id}:${approvalId}`); await refreshTask(); }
    else showError(error, () => { hideError(); refreshTask(); });
  } finally { approvalBusy = false; setBusy(false); }
  if (accepted && task?.id === id) {
    if (decision === 'rejected') await cancelTask();
    else await refreshTask();
  }
}
$('chooseVideo').onclick = $('changeVideo').onclick = () => $('videoInput').click();
$('videoInput').onchange = () => selectVideo($('videoInput').files[0]);
for (const name of ['dragenter', 'dragover']) $('dropZone').addEventListener(name, event => { event.preventDefault(); if (!$('videoInput').disabled) $('dropZone').classList.add('dragging'); });
for (const name of ['dragleave', 'drop']) $('dropZone').addEventListener(name, event => { event.preventDefault(); $('dropZone').classList.remove('dragging'); });
$('dropZone').addEventListener('drop', event => { if (event.dataTransfer.files.length !== 1) showError(new Error('请一次选择一段 MP4 原片。')); else selectVideo(event.dataTransfer.files[0]); });
$('importSubtitles').onclick = () => $('subtitleInput').click();
$('subtitleInput').onchange = async () => {
  const file = $('subtitleInput').files[0];
  if (!file) return;
  try {
    if (!/\.(?:srt|txt)$/i.test(file.name)) throw new Error('请导入 .srt 或 .txt 文案文件。');
    if (file.size > 256 * 1024) throw new Error('字幕文件过大，请使用不超过 50000 字的文案。');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
    if (!text.trim()) throw new Error('文案文件为空，请检查文件内容。');
    if (text.length > 50000) throw new Error('字幕最多 50000 个字符。');
    $('subtitles').value = text;
    $('subtitles').dispatchEvent(new Event('input'));
    hideError();
  } catch (error) { showError(new Error(error instanceof TypeError ? '文案不是有效 UTF-8 编码，请另存为 UTF-8 后导入。' : error.message)); }
  finally { $('subtitleInput').value = ''; }
};
$('subtitles').oninput = () => { $('characterCount').textContent = `${[...$('subtitles').value].length.toLocaleString('zh-CN')} 字`; };
document.querySelectorAll('input[name="voiceSource"]').forEach(input => { input.onchange = render; });
$('productionForm').onsubmit = event => { event.preventDefault(); submit(); };
$('cancelButton').onclick = cancelTask;
$('retryButton').onclick = () => retryAction?.();
$('configRetryButton').onclick = loadConfig;
$('openSettings').onclick = event => { if (window.parent !== window) { event.preventDefault(); window.parent.postMessage({ type: 'agent-motion-open-settings' }, location.origin); } };
window.addEventListener('message', event => { if (event.origin === location.origin && event.source === window.parent && event.data?.type === 'agent-motion-settings-updated') loadConfig(); });
window.addEventListener('pagehide', () => { clearTimeout(polling); if (sourceUrl) URL.revokeObjectURL(sourceUrl); });
window.addEventListener('pageshow', event => { if (event.persisted && task && !terminal.has(task.status)) refreshTask(); });
render();
loadConfig();
let saved; try { saved = localStorage.getItem(storageKey); } catch {}
if (saved && /^[a-zA-Z0-9_-]{1,128}$/.test(saved)) {
  task = { id: saved, status: 'unknown' };
  $('restoreNote').hidden = false;
  $('restoreNote').textContent = '已恢复上次任务的文案、音色来源和制作参数。上传尚未完成时，请选择同一原视频；已提交任务请查询状态，避免重复付费。';
  render();
  refreshTask();
}
