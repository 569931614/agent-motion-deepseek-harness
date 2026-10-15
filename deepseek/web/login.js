const form = document.getElementById('loginForm');
const field = document.getElementById('tokenInput');
const button = document.getElementById('loginButton');
const status = document.getElementById('statusText');
const initial = new URLSearchParams(location.hash.slice(1)).get('token');
history.replaceState(null, '', location.pathname);

function tokenFrom(value) {
  let token = value.trim();
  if (token.includes('://')) {
    const url = new URL(token);
    if (url.origin !== location.origin || url.pathname !== '/' || url.searchParams.getAll('token').length !== 1) throw new Error('请使用当前本机地址的启动链接。');
    token = url.searchParams.get('token');
  }
  if (!/^[a-zA-Z0-9_-]{20,256}$/.test(token)) throw new Error('请粘贴完整启动链接或有效登录口令。');
  return token;
}

async function login(value) {
  if (button.disabled) return;
  button.disabled = true;
  try {
    const token = value ? tokenFrom(value) : undefined;
    field.value = '';
    status.textContent = '正在验证本机登录…';
    const options = { credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer' };
    if (token) {
      const exchange = await fetch('/?token=' + encodeURIComponent(token), options);
      if (!exchange.ok) throw new Error('登录未成功。请使用本次启动链接，并允许此本地地址保存 Cookie。');
    }
    const verified = await fetch('/', options);
    if (!verified.ok) throw new Error(token ? '浏览器未保持登录状态。请允许本地 Cookie，或在普通浏览器中使用当前启动链接。' : '当前尚未登录，请填写本次启动链接后继续。');
    status.textContent = '登录成功，正在打开项目…';
    location.replace('/');
  } catch (error) {
    status.textContent = error instanceof Error && !/fetch|network|URL/i.test(error.message) ? error.message : '无法连接本地项目，请确认服务正在运行后重试。';
  } finally { button.disabled = false; }
}

form.addEventListener('submit', event => { event.preventDefault(); login(field.value); });
login(initial);
