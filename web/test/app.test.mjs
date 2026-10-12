import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { domFixture } from './dom.mjs';
import { resumeFixture } from './helpers.mjs';

test('authenticated app starts without removed controls and still reports a disconnection', async t => {
  const dom = domFixture(), fetchBefore = globalThis.fetch, sourceBefore = Object.getOwnPropertyDescriptor(globalThis, 'EventSource');
  dom.location.href = 'https://fixture.test/';
  const lookup = dom.document.querySelector.bind(dom.document), streams = []; let stream;
  dom.document.querySelector = selector => ['#logout', '#connection', '#effective-settings', '#refresh-usage'].includes(selector) ? null : lookup(selector);
  globalThis.fetch = async (path, options) => {
    const data = path === '/api/status' ? { online: true, uploadLimitBytes: 32 } : path === '/api/view' ? { viewId: 'view' } :
      path === '/api/thread/start' ? { snapshot: resumeFixture('new'), cursor: { generation: 1, seq: 1 } } : { result: { data: [], nextCursor: null } };
    return { ok: true, status: 200, json: async () => data };
  };
  Object.defineProperty(globalThis, 'EventSource', { configurable: true, value: class {
    constructor(url) { streams.push(url); stream = this; } close() {}
  } });
  t.after(() => { globalThis.fetch = fetchBefore; if (sourceBefore) Object.defineProperty(globalThis, 'EventSource', sourceBefore); else delete globalThis.EventSource; dom.restore(); });
  await import('../public/app.js?without-logout');
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
  app = await import('../public/app.js?first-sse-project-refresh');
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
