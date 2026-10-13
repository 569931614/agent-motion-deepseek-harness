const $ = id => document.getElementById(id);
if (window.parent !== window) $('returnStudioLink').hidden = true;
const secrets = ['DASHSCOPE_API_KEY', 'YIDEVS_API_KEY', 'MOTION_OSS_ACCESS_KEY_ID', 'MOTION_OSS_ACCESS_KEY_SECRET', 'MOTION_OSS_SECURITY_TOKEN'];
const fields = ['MOTION_OSS_ENDPOINT', 'MOTION_OSS_BUCKET', 'COSYVOICE_VOICE_ID'];
let busy = false, loaded = false, writable = false, baseline = {};
function clearSecrets() { for (const name of secrets) { $(name).value = ''; $(`clear-${name}`).checked = false; } }
function controls() {
  for (const input of $('settingsForm').querySelectorAll('input')) input.disabled = busy || !loaded || !writable;
  for (const name of secrets) if ($(`clear-${name}`).checked) $(name).disabled = true;
  $('saveSettings').disabled = busy || !loaded || !writable;
  $('saveSettingsLabel').textContent = busy ? '正在处理…' : '保存设置';
  $('reloadSettings').disabled = busy;
  $('settingsReadonly').hidden = !loaded || writable;
}
function showError(message) { $('settingsErrorMessage').textContent = message; $('settingsError').hidden = false; }
function apply(result, saved = false) {
  loaded = true; writable = result.writable === true;
  for (const name of fields) {
    const value = result.values?.[name];
    $(name).value = name === 'MOTION_OSS_ENDPOINT' && !value ? 'https://cos.ap-beijing.myqcloud.com' : typeof value === 'string' ? value : '';
    baseline[name] = $(name).value;
  }
  for (const name of secrets) $(`configured-${name}`).textContent = result.configured?.[name] === true ? '已配置' : '尚未配置';
  clearSecrets();
  $('settingsStatus').dataset.ready = String(result.ready === true);
  $('settingsStatusTitle').textContent = saved ? '设置已保存' : result.ready === true ? '制作服务已配置' : '制作服务尚未就绪';
  $('settingsStatusMessage').textContent = (saved ? '已立即生效，无需重启。' : '') + (typeof result.message === 'string' && result.message ? result.message : result.ready === true ? '可以返回制作页开始准备素材。' : '请补全所需服务配置。');
  $('settingsError').hidden = true;
}
async function request(body) {
  const response = await fetch('/api/agent-motion/settings', { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values: body }) }) });
  const result = await response.json().catch(() => undefined);
  if (!response.ok) throw new Error(response.status === 401 ? '请先在 Harness 首页登录，再重新读取设置。' : response.status >= 400 && response.status < 500 && typeof result?.error === 'string' && result.error.trim() ? result.error : `设置请求未完成（HTTP ${response.status}），请重新读取核对；需要时重新填写密钥。`);
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('无法读取设置状态，请重新读取核对。');
  return result;
}
async function load() {
  if (busy) return;
  busy = true; controls();
  try { apply(await request()); }
  catch (error) { showError(error.message || '无法读取设置，请检查连接后重试。'); }
  finally { clearSecrets(); busy = false; controls(); }
}
async function save() {
  if (busy || !loaded || !writable) return;
  const values = {};
  for (const name of fields) { const value = $(name).value.trim(); if (value !== baseline[name]) values[name] = value || null; }
  for (const name of secrets) {
    if ($(`clear-${name}`).checked) values[name] = null;
    else if ($(name).value.trim()) values[name] = $(name).value.trim();
  }
  busy = true; controls();
  try {
    apply(await request(values), true);
    if (window.parent !== window) window.parent.postMessage({ type: 'agent-motion-settings-saved' }, location.origin);
  }
  catch (error) { showError(error.message || '保存结果尚未确认，请重新读取核对；需要时重新填写密钥。'); }
  finally { clearSecrets(); busy = false; controls(); }
}
for (const name of secrets) $(`clear-${name}`).onchange = controls;
$('settingsForm').onsubmit = event => { event.preventDefault(); save(); };
$('reloadSettings').onclick = load;
window.addEventListener('pagehide', clearSecrets);
controls(); load();
