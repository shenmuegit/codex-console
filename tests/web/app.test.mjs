import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { domFixture } from './dom.mjs';
import { resumeFixture } from './helpers.mjs';
import { getEventListeners } from 'node:events';

function pluginFixture(t, respond) {
  const dom = domFixture(), previousFetch = globalThis.fetch, previousSource = globalThis.EventSource;
  dom.document.documentElement = { dataset: { isolaPlugin: 'true' }, style: { setProperty() {} } };
  const viewport = window.visualViewport = new EventTarget(); viewport.height = 800;
  const streams = [], calls = [];
  globalThis.fetch = async (path, options) => {
    assert.equal(options.credentials, 'include'); calls.push(path);
    const result = await respond?.(path, options);
    const data = path.endsWith('/api/status') ? { online: true, uploadLimitBytes: 1000 } : path.endsWith('/api/view') ? { viewId: 'view' } :
      path.endsWith('/api/thread/open') || path.endsWith('/api/thread/start') ? { snapshot: resumeFixture('t'), cursor: { generation: 1, seq: 1 } } : { result: { data: [], nextCursor: null } };
    return result ?? { ok: true, status: 200, json: async () => data };
  };
  globalThis.EventSource = class { constructor(url) { this.url = url; this.closed = 0; streams.push(this); } close() { this.closed++; } };
  t.after(() => { globalThis.fetch = previousFetch; if (previousSource) globalThis.EventSource = previousSource; else delete globalThis.EventSource; dom.restore(); });
  return { dom, streams, calls, viewport };
}
const settle = async () => { for (let i = 0; i < 15; i++) await delay(0); };

test('plugin entry removes password queries without losing navigation or history state', async t => {
  const unauthorized = { ok: false, status: 401, json: async () => ({ error: { message: 'Signed out' } }) };
  const { dom, calls } = pluginFixture(t, () => unauthorized);
  dom.location.href = 'https://plugin.example.test/dist/index.html?password=fixture-secret&host=remote&thread=t&password=second-secret&side=1#anchor';
  history.state = { hostState: true };
  let savedState;
  history.replaceState = (state, _title, url) => { savedState = state; dom.location.href = String(url); };
  const { mountApp } = await import('../../web/public/app.js?clean-login-url');
  const app = mountApp({ backendOrigin: 'https://codex.example.test' }); t.after(() => app.dispose());
  assert.equal(dom.location.href, 'https://plugin.example.test/dist/index.html?host=remote&thread=t&side=1#anchor');
  assert.deepEqual(savedState, { hostState: true });
  assert.equal(dom.get('password').value, '');
  await settle();
  assert.equal(calls.some(path => path.includes('password') || path.endsWith('/api/login')), false);
});

test('app_unmount_cleans_streams_and_menu', async t => {
  const { dom, streams, calls, viewport } = pluginFixture(t);
  const { mountApp } = await import('../../web/public/app.js?plugin-lifecycle');
  assert.equal(typeof mountApp, 'function');
  let menu, removed = 0, resizeCalls = 0;
  dom.document.documentElement.style.setProperty = () => resizeCalls++;
  for (let i = 0; i < 2; i++) {
    const app = mountApp({ backendOrigin: 'https://codex.example.test', registerMenu(items) { menu = items; return () => removed++; } });
    await settle();
    assert.equal(streams.length, i + 1);
    assert.deepEqual(menu.map(({ id, label }) => ({ id, label })), [{ id: 'new-thread', label: '新建会话' }, { id: 'settings', label: '设置' }]);
    menu[1].onSelect(); assert.equal(dom.get('settings-dialog').open, true);
    app.dispose(); app.dispose(); assert.equal(streams[i].closed, 1); assert.equal(removed, i + 1);
    const before = calls.length, resized = resizeCalls;
    viewport.dispatchEvent(new Event('resize')); menu[0].onSelect(); dom.get('new-thread').click();
    dom.event('login-form', 'submit', { submitter: { disabled: false } }); await settle();
    assert.equal(calls.length, before); assert.equal(resizeCalls, resized);
    assert.equal(getEventListeners(dom.get('draft'), 'input').length, 0);
    assert.equal(getEventListeners(dom.document.body, 'click').length, 0);
  }
});

test('successful login with blocked cookie stays on login without creating a view', async t => {
  const unauthorized = { ok: false, status: 401, json: async () => ({ error: { message: 'Signed out' } }) };
  const { dom, calls } = pluginFixture(t, path => path.endsWith('/api/status') ? unauthorized : undefined);
  const { mountApp } = await import('../../web/public/app.js?blocked-cookie');
  assert.equal(typeof mountApp, 'function');
  const app = mountApp({ backendOrigin: 'https://codex.example.test' }); t.after(() => app.dispose()); await settle();
  dom.get('password').value = 'fixture-password';
  dom.event('login-form', 'submit', { submitter: { disabled: false } });
  assert.equal(dom.get('password').value, ''); await settle();
  assert.equal(dom.get('login-error').textContent, '无法保持登录会话，可能被浏览器 Cookie 策略阻止。');
  assert.equal(dom.get('login-panel').hidden, false); assert.equal(dom.get('workspace').hidden, true);
  assert.deepEqual(calls.map(path => new URL(path).pathname), ['/api/status', '/api/login', '/api/status']);
});

test('late login response after disposal cannot create a session or touch a new mount', async t => {
  let release;
  const { dom, calls } = pluginFixture(t, path => path.endsWith('/api/login') ? new Promise(resolve => { release = resolve; }) :
    { ok: false, status: 401, json: async () => ({ error: { message: 'Signed out' } }) });
  const { mountApp } = await import('../../web/public/app.js?late-login');
  assert.equal(typeof mountApp, 'function');
  const app = mountApp(); await settle();
  dom.get('password').value = 'fixture-password'; dom.event('login-form', 'submit', { submitter: { disabled: false } });
  app.dispose(); dom.get('login-error').textContent = 'new mount';
  release({ ok: true, status: 200, json: async () => ({}) }); await settle();
  assert.deepEqual(calls, ['/api/status', '/api/login']); assert.equal(dom.get('login-error').textContent, 'new mount');
});

test('failed menu setup removes already installed viewport and form listeners', async t => {
  const { dom, calls, viewport } = pluginFixture(t);
  const { mountApp } = await import('../../web/public/app.js?failed-mount');
  assert.equal(typeof mountApp, 'function'); let resizeCalls = 0;
  dom.document.documentElement.style.setProperty = () => resizeCalls++;
  assert.throws(() => mountApp({ registerMenu() { throw new Error('bridge closed'); } }), /bridge closed/);
  const resized = resizeCalls; viewport.dispatchEvent(new Event('resize'));
  dom.event('login-form', 'submit', { submitter: { disabled: false } }); await settle();
  assert.equal(resizeCalls, resized); assert.deepEqual(calls, []);
});

test('an initial catalog failure keeps the SSE available for native reconnection', async t => {
  const { streams } = pluginFixture(t, (path, options) => {
    if (path.endsWith('/api/rpc') && JSON.parse(options.body).method === 'project/list') throw new Error('Catalog offline');
  });
  const { mountApp } = await import('../../web/public/app.js?catalog-offline');
  const app = mountApp(); await settle();
  try { assert.equal(streams.length, 1); assert.equal(streams[0].closed, 0); assert.equal(typeof streams[0].onmessage, 'function'); }
  finally { app.dispose(); }
  assert.equal(streams[0].closed, 1);
});

test('authenticated app starts without removed controls and still reports a disconnection', async t => {
  const dom = domFixture(), fetchBefore = globalThis.fetch, sourceBefore = Object.getOwnPropertyDescriptor(globalThis, 'EventSource');
  dom.location.href = 'https://fixture.test/';
  const lookup = dom.document.querySelector.bind(dom.document), streams = []; let stream;
  dom.document.querySelector = selector => ['#logout', '#connection', '#effective-settings', '#refresh-usage'].includes(selector) ? null : lookup(selector);
  globalThis.fetch = async (path, options) => {
    assert.equal(options.credentials, 'include');
    const data = path === '/api/status' ? { online: true, uploadLimitBytes: 32 } : path === '/api/view' ? { viewId: 'view' } :
      path === '/api/thread/start' ? { snapshot: resumeFixture('new'), cursor: { generation: 1, seq: 1 } } : { result: { data: [], nextCursor: null } };
    return { ok: true, status: 200, json: async () => data };
  };
  Object.defineProperty(globalThis, 'EventSource', { configurable: true, value: class {
    constructor(url, options) { assert.equal(options.withCredentials, true); streams.push(url); stream = this; } close() {}
  } });
  t.after(() => { globalThis.fetch = fetchBefore; if (sourceBefore) Object.defineProperty(globalThis, 'EventSource', sourceBefore); else delete globalThis.EventSource; dom.restore(); });
  await import('../../web/public/app.js?without-logout');
  for (let i = 0; i < 20 && (!streams.length || dom.get('draft').disabled); i++) await delay(0);
  assert.equal(dom.get('login-panel').hidden, true); assert.equal(dom.get('workspace').hidden, false);
  assert.deepEqual(streams, ['/api/events?viewId=view']);
  assert.equal(dom.get('turn-status').textContent, '');
  stream.onerror(); assert.equal(dom.get('turn-status').textContent, '连接中断 · 正在重连');
});

test('the first online SSE handshake refreshes project names after the initial HTTP read', async t => {
  const dom = domFixture(), fetchBefore = globalThis.fetch, sourceBefore = Object.getOwnPropertyDescriptor(globalThis, 'EventSource');
  dom.location.href = 'https://fixture.test/?thread=existing';
  let stream, app, releaseProject, holdProject = false, unauthorized = false, projectName = 'Before subscription', projectReads = 0, starts = 0;
  globalThis.fetch = async (path, options) => {
    if (unauthorized) return { ok: false, status: 401, json: async () => ({ error: { message: 'Signed out' } }) };
    const body = options?.body ? JSON.parse(options.body) : {};
    let data;
    if (path === '/api/status') data = { online: true, uploadLimitBytes: 32 };
    else if (path === '/api/view') data = { viewId: 'view' };
    else if (path === '/api/thread/open') data = { snapshot: resumeFixture(body.threadId), cursor: { generation: 1, seq: 1 } };
    else if (path === '/api/thread/start') { starts++; assert.fail('A catalog refresh must not create another conversation'); }
    else {
      assert.equal(path, '/api/rpc');
      if (body.method === 'project/list') projectReads++;
      data = { result: { data: body.method === 'project/list' ? [{ id: 'p', name: projectName, roots: [{ path: '/p' }] }] : [], nextCursor: null } };
    }
    if (body.method === 'project/list' && holdProject) { holdProject = false; await new Promise(resolve => { releaseProject = resolve; }); }
    return { ok: true, status: 200, json: async () => data };
  };
  Object.defineProperty(globalThis, 'EventSource', { configurable: true, value: class {
    constructor() { stream = this; } close() {}
  } });
  t.after(async () => { releaseProject?.(); unauthorized = true; if (app) await app.api('/api/status').catch(() => {}); globalThis.fetch = fetchBefore; if (sourceBefore) Object.defineProperty(globalThis, 'EventSource', sourceBefore); else delete globalThis.EventSource; dom.restore(); });
  app = await import('../../web/public/app.js?first-sse-project-refresh');
  for (let i = 0; i < 30 && (!stream || dom.get('draft').disabled); i++) await delay(0);
  const label = () => dom.get('projects').children[0].children[0].children[1].textContent;
  assert.equal(label(), 'Before subscription');
  dom.get('draft').value = 'keep this draft'; dom.get('draft').focus(); dom.event('draft', 'input');
  projectName = 'Latest project name';
  const status = online => stream.onmessage({ data: JSON.stringify({ kind: 'status', cursor: { generation: 1, seq: 2 }, native: { online } }) });
  status(true); await delay(0);
  assert.equal(label(), 'Latest project name'); assert.equal(projectReads, 2);
  assert.equal(dom.get('draft').value, 'keep this draft'); assert.equal(dom.document.activeElement, dom.get('draft')); assert.equal(starts, 0);
  assert.equal(new URL(dom.location.href).searchParams.get('thread'), 'existing');
  status(true); await delay(0); assert.equal(projectReads, 2, 'Repeated online status does not repeatedly reload the list');
  stream.onerror(); projectName = 'After reconnection'; status(true); await delay(0);
  assert.equal(label(), 'After reconnection'); assert.equal(projectReads, 3);
  holdProject = true; projectName = 'Delayed old name';
  stream.onmessage({ data: JSON.stringify({ kind: 'notification', cursor: { generation: 1, seq: 3 }, native: { method: 'project/changed', params: { projectId: 'p', changeType: 'updated' } } }) });
  await delay(0); assert.equal(typeof releaseProject, 'function');
  stream.onerror(); projectName = 'Newest name'; status(true); await delay(0);
  assert.equal(label(), 'Newest name'); releaseProject(); await delay(0);
  assert.equal(label(), 'Newest name', 'An older response must not restore the old project name');
  assert.equal(dom.get('draft').value, 'keep this draft');
});
