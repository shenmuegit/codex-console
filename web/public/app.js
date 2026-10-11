import { mountChat } from './chat.js';
import { mountConnections } from './connections.js';
import { scopeHostPath } from './composer.js';
const $ = selector => document.querySelector(selector);
if (new URL(location.href).searchParams.get('side') === '1') document.body.dataset.sideChat = 'true';
let events, chat, connections;
const selectedHost = new URL(location.href).searchParams.get('host') ?? 'local';
const hostPath = path => {
  if (selectedHost === 'local' || path.startsWith('/api/controller/') || ['/api/login', '/api/logout'].includes(path)) return path;
  return scopeHostPath(path, selectedHost);
};
if (window.visualViewport) {
  const viewport = () => document.documentElement.style.setProperty('--app-height', `${window.visualViewport.height}px`);
  window.visualViewport.addEventListener('resize', viewport); viewport();
}
export async function api(path, body) {
  const response = await fetch(hostPath(path), body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401) showLogin();
    throw Object.assign(new Error(data.error?.message ?? '请求失败。'), data.error, { status: response.status });
  }
  return data;
}
function showLogin() { events?.close(); chat?.dispose(); connections?.dispose(); chat = null; connections = null; $('#login-panel').hidden = false; $('#workspace').hidden = true; }
async function connected() {
  $('#login-panel').hidden = true; $('#workspace').hidden = false;
  connections?.dispose(); connections = mountConnections({ api, selectedHost, selectHost(id) {
    chat?.dispose(); events?.close();
    const destination = new URL(location.href); destination.searchParams.delete('thread');
    if (id === 'local') destination.searchParams.delete('host'); else destination.searchParams.set('host', id);
    location.assign(destination.href);
  } });
  connections.refresh();
  const status = await api('/api/status');
  const { viewId } = await api('/api/view', {});
  chat?.dispose(); chat = mountChat({ api, viewId, selectedHost, uploadLimitBytes: status.uploadLimitBytes });
  chat.connection(status.online);
  events?.close(); events = new EventSource(hostPath('/api/events?viewId=' + encodeURIComponent(viewId)));
  events.onmessage = event => {
    const envelope = JSON.parse(event.data);
    chat?.onEvent(envelope);
  };
  events.onerror = () => { chat?.connection(false); api('/api/status').catch(() => {}); };
  await chat.load();
}
$('#login-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true; $('#login-error').textContent = '';
  try { await api('/api/login', { password: $('#password').value }); $('#password').value = ''; await connected(); }
  catch (e) { $('#login-error').textContent = e.message; }
  finally { button.disabled = false; }
});
api('/api/status').then(connected).catch(() => showLogin());
