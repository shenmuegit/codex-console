import { mountChat } from './chat.js';
import { mountConnections } from './connections.js';
import { mountAutomations } from './automations.js';
import { scopeHostPath } from './composer.js';
const $ = selector => document.querySelector(selector);
if (new URL(location.href).searchParams.get('side') === '1') document.body.dataset.sideChat = 'true';
let events, chat, connections, automations, leaving = false, initialization = 0;
const selectedHost = new URL(location.href).searchParams.get('host') ?? 'local';
const hostPath = path => {
  if (selectedHost === 'local' || path.startsWith('/api/controller/') || ['/api/login', '/api/logout'].includes(path)) return path;
  return scopeHostPath(path, selectedHost);
};
if (window.visualViewport) {
  const viewport = () => document.documentElement.style.setProperty('--app-height', `${window.visualViewport.height}px`);
  window.visualViewport.addEventListener('resize', viewport); viewport();
}
export function api(path, body) { return request(hostPath(path), body); }
async function request(path, body) {
  const response = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401) showLogin();
    throw Object.assign(new Error(data.error?.message ?? '请求失败。'), data.error, { status: response.status });
  }
  return data;
}
function showLogin() { if (leaving) return; ++initialization; events?.close(); chat?.dispose(); connections?.dispose(); automations?.dispose(); chat = null; connections = null; automations = null; $('#login-panel').hidden = false; $('#workspace').hidden = true; }
function showWorkspace() {
  $('#login-panel').hidden = true; $('#workspace').hidden = false;
  connections?.dispose(); connections = mountConnections({ api, selectedHost, selectHost(id) {
    leaving = true; ++initialization; chat?.dispose(); events?.close(); connections?.dispose(); automations?.dispose();
    const destination = new URL(location.href); destination.searchParams.delete('thread');
    if (id === 'local') destination.searchParams.delete('host'); else destination.searchParams.set('host', id);
    location.assign(destination.href);
  } });
  connections.refresh();
}
function connectionError(error) {
  if (leaving || error.status === 401) return;
  if (!connections) showWorkspace();
  chat?.connection(false);
  const message = error.code === 'NATIVE_DISCONNECTED' && error.message === 'The native backend is offline.' ?
    '未能建立到所选设备的 Codex 连接。' : error.message || '设备连接失败。';
  $('#workspace-error-message').textContent = message + (error.code != null ? `（${error.code}）` : '');
  $('#workspace-error').hidden = false;
}
async function connected() {
  const version = ++initialization;
  try {
    await request('/api/status');
    if (leaving || version !== initialization) return;
    showWorkspace(); $('#workspace-error').hidden = true;
    const status = await api('/api/status');
    if (leaving || version !== initialization) return;
    const { viewId } = await api('/api/view', {});
    if (leaving || version !== initialization) return;
    automations?.dispose(); chat?.dispose(); chat = mountChat({ api, viewId, selectedHost, uploadLimitBytes: status.uploadLimitBytes });
    automations = mountAutomations({ api, viewId, selectedHost, getState: () => chat?.getState(), onOpenThread: id => chat?.open(id) });
    chat.connection(status.online);
    events?.close(); events = new EventSource(hostPath('/api/events?viewId=' + encodeURIComponent(viewId)));
    events.onmessage = event => {
      const envelope = JSON.parse(event.data);
      automations?.onEvent(envelope);
      if (envelope.native?.method !== 'automation/changed') chat?.onEvent(envelope);
    };
    events.onerror = () => { chat?.connection(false); api('/api/status').catch(() => {}); };
    await chat.load();
  } catch (error) { if (version === initialization) connectionError(error); }
}
$('#login-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true; $('#login-error').textContent = '';
  try { await api('/api/login', { password: $('#password').value }); $('#password').value = ''; await connected(); }
  catch (e) { $('#login-error').textContent = e.message; }
  finally { button.disabled = false; }
});
connected();
