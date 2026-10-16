import { mountChat } from './chat.js';
import { mountConnections } from './connections.js';
import { mountAutomations } from './automations.js';
import { scopeHostPath } from './composer.js';
import { createTransport } from './transport.js';

let standalone;
export function api(path, body) { return standalone.api(path, body); }

export function mountApp({ backendOrigin, registerMenu } = {}) {
  const transport = createTransport(backendOrigin), abort = new AbortController();
  const $ = selector => document.querySelector(selector);
  const page = new URL(location.href), selectedHost = page.searchParams.get('host') ?? 'local';
  if (page.searchParams.has('password')) {
    page.searchParams.delete('password'); history.replaceState(history.state, '', page.href);
  }
  document.body.dataset.sideChat = String(page.searchParams.get('side') === '1');
  let events, chat, connections, automations, unregisterMenu, leaving = false, initialization = 0, loggingIn = false;
  const hostPath = path => {
    if (selectedHost === 'local' || path.startsWith('/api/controller/') || ['/api/login', '/api/logout'].includes(path)) return path;
    return scopeHostPath(path, selectedHost);
  };
  const api = (path, body) => request(hostPath(path), body);
  async function request(path, body) {
    if (leaving) throw new DOMException('Application disposed', 'AbortError');
    const version = initialization;
    try {
      const data = await transport.request(path, body);
      if (leaving) throw new DOMException('Application disposed', 'AbortError');
      return data;
    } catch (error) { if (!leaving && version === initialization && error.status === 401) showLogin(); throw error; }
  }
  function clearWorkspace() {
    const owned = [automations, chat, connections];
    // Drop ownership before callbacks can reenter cleanup.
    const stream = events; events = null;
    if (stream) { stream.onmessage = stream.onerror = null; stream.close(); }
    chat = connections = automations = null;
    for (const resource of owned) resource?.dispose();
  }
  function dispose() {
    if (leaving) return;
    leaving = true; ++initialization; abort.abort();
    try { clearWorkspace(); } finally { unregisterMenu?.(); unregisterMenu = null; }
  }
  function showLogin() {
    if (leaving) return;
    ++initialization; clearWorkspace(); $('#login-panel').hidden = false; $('#workspace').hidden = true;
  }
  function showWorkspace() {
    $('#login-panel').hidden = true; $('#workspace').hidden = false;
    connections?.dispose(); connections = null;
    connections = mountConnections({ api, selectedHost, selectHost(id) {
      dispose();
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
  async function connected(verified = false) {
    const version = ++initialization;
    let mounted = false;
    try {
      if (!verified) await request('/api/status');
      if (leaving || version !== initialization) return;
      showWorkspace(); $('#workspace-error').hidden = true;
      const status = await api('/api/status');
      if (leaving || version !== initialization) return;
      const { viewId } = await api('/api/view', {});
      if (leaving || version !== initialization) return;
      automations?.dispose(); automations = null; chat?.dispose(); chat = null;
      chat = mountChat({ api, viewId, selectedHost, businessUrl: transport.url, backendOrigin, uploadLimitBytes: status.uploadLimitBytes });
      automations = mountAutomations({ api, viewId, selectedHost, getState: () => chat?.getState(), onOpenThread: id => chat?.open(id) });
      chat.connection(status.online);
      events?.close(); events = transport.eventSource(hostPath('/api/events?viewId=' + encodeURIComponent(viewId)));
      events.onmessage = event => {
        if (leaving || version !== initialization) return;
        const envelope = JSON.parse(event.data);
        automations?.onEvent(envelope);
        if (envelope.native?.method !== 'automation/changed') chat?.onEvent(envelope);
      };
      events.onerror = () => { if (leaving || version !== initialization) return; chat?.connection(false); api('/api/status').catch(() => {}); };
      mounted = true;
      await chat.load();
      if (leaving || version !== initialization) return;
    } catch (error) {
      if (!leaving && version === initialization) { if (!mounted) clearWorkspace(); connectionError(error); }
    }
  }
  try {
    if (window.visualViewport) {
      const viewport = () => document.documentElement.style.setProperty('--app-height', `${window.visualViewport.height}px`);
      window.visualViewport.addEventListener('resize', viewport, { signal: abort.signal }); viewport();
    }
    window.addEventListener?.('pagehide', dispose, { signal: abort.signal });
    $('#login-form').addEventListener('submit', async event => {
      event.preventDefault(); if (leaving || loggingIn) return;
      loggingIn = true;
      const version = ++initialization, button = event.submitter, password = $('#password').value;
      $('#password').value = ''; if (button) button.disabled = true; $('#login-error').textContent = '';
      let accepted = false;
      try {
        await api('/api/login', { password });
        if (leaving || version !== initialization) return;
        accepted = true;
        await request('/api/status');
        if (leaving || version !== initialization) return;
        await connected(true);
        if (leaving) return;
      } catch (error) {
        if (!leaving) $('#login-error').textContent = accepted && error.status === 401 ? '无法保持登录会话，可能被浏览器 Cookie 策略阻止。' : error.message;
      } finally { if (!leaving) { loggingIn = false; if (button) button.disabled = false; } }
    }, { signal: abort.signal });
    unregisterMenu = registerMenu?.([
      { id: 'new-thread', label: '新建会话', onSelect: () => { if (!leaving) $('#new-thread').click(); } },
      { id: 'settings', label: '设置', onSelect: () => { if (!leaving) $('#show-settings').click(); } },
    ]);
    connected();
    return { api, dispose };
  } catch (error) { dispose(); throw error; }
}

if (typeof document !== 'undefined' && document.documentElement?.dataset.isolaPlugin !== 'true') standalone = mountApp();
