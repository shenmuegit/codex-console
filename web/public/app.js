import { mountChat } from './chat.js';
const $ = selector => document.querySelector(selector);
let events, chat;
if (window.visualViewport) {
  const viewport = () => document.documentElement.style.setProperty('--app-height', `${window.visualViewport.height}px`);
  window.visualViewport.addEventListener('resize', viewport); viewport();
}
export async function api(path, body) {
  const response = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401) showLogin();
    throw Object.assign(new Error(data.error?.message ?? '请求失败。'), data.error, { status: response.status });
  }
  return data;
}
function showLogin() { events?.close(); chat?.dispose(); chat = null; $('#login-panel').hidden = false; $('#workspace').hidden = true; }
async function connected() {
  $('#login-panel').hidden = true; $('#workspace').hidden = false;
  const status = await api('/api/status');
  const { viewId } = await api('/api/view', {});
  chat?.dispose(); chat = mountChat({ api, viewId, uploadLimitBytes: status.uploadLimitBytes });
  chat.connection(status.online);
  events?.close(); events = new EventSource('/api/events?viewId=' + encodeURIComponent(viewId));
  events.onmessage = event => {
    const envelope = JSON.parse(event.data);
    if (envelope.kind === 'status') $('#connection').textContent = envelope.native.online ? '已连接' : '后端离线 · 正在重连';
    chat?.onEvent(envelope);
  };
  events.onerror = () => { $('#connection').textContent = '连接中断 · 正在重连'; chat?.connection(false); api('/api/status').catch(() => {}); };
  await chat.load();
}
$('#login-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true; $('#login-error').textContent = '';
  try { await api('/api/login', { password: $('#password').value }); $('#password').value = ''; await connected(); }
  catch (e) { $('#login-error').textContent = e.message; }
  finally { button.disabled = false; }
});
api('/api/status').then(connected).catch(() => showLogin());
