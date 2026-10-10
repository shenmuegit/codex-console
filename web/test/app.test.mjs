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
