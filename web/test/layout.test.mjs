import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { mountUsage } from '../public/usage.js';
import { createChatState } from '../public/chat.js';
import { domFixture } from './dom.mjs';

test('model effort and context are in the composer while weekly usage belongs to the global sidebar', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const start = html.indexOf('<form id="composer"'), composer = html.slice(start, html.indexOf('</form>', start));
  for (const id of ['model', 'effort', 'context-usage', 'context-meter']) assert.ok(composer.includes(`id="${id}"`), `${id} is inside the input surface`);
  for (const id of ['effective-settings', 'connection', 'refresh-usage']) assert.equal(html.includes(`id="${id}"`), false, `${id} is omitted`);
  assert.equal(composer.includes('id="show-usage"'), false);
  const sidebar = html.indexOf('id="sidebar"');
  assert.ok(sidebar >= 0); assert.ok(html.slice(sidebar, html.indexOf('id="sidebar-backdrop"', sidebar)).includes('id="show-usage"'));
});

test('weekly usage opens without a selected chat and keeps one account-scoped value across thread switches', async t => {
  const dom = domFixture(), calls = []; let state, usage;
  t.after(() => { usage?.dispose(); dom.restore(); });
  const api = async (path, body) => { calls.push({ path, body }); return { result: { rateLimitsByLimitId: { codex: { secondary: { usedPercent: 23, windowDurationMins: 10080, resetsAt: null } } } } }; };
  usage = mountUsage({ api, viewId: 'view', getState: () => state, onChange() {}, onError: error => assert.fail(error.message) });
  dom.get('show-usage').click(); await delay(0);
  assert.equal(dom.get('usage-dialog').open, true); assert.deepEqual(calls, [{ path: '/api/rpc', body: { method: 'account/rateLimits/read', params: {} } }]);
  const quota = dom.get('weekly-usage').children[0].children[1].textContent; assert.match(quota, /23%/);
  state = createChatState('first'); usage.render(); state = createChatState('second'); usage.render();
  assert.equal(calls.length, 1); assert.equal(dom.get('weekly-usage').children[0].children[1].textContent, quota);
});

test('compact context indicator retains native percentages and complete accessible details', t => {
  const dom = domFixture(), state = createChatState('current'); let usage;
  t.after(() => { usage?.dispose(); dom.restore(); });
  state.ready = true; state.tokenUsage = { last: { totalTokens: 112000 }, modelContextWindow: 200000 };
  usage = mountUsage({ api: async () => ({}), viewId: 'view', getState: () => state, onChange() {}, onError: error => assert.fail(error.message) });
  usage.render(); assert.equal(dom.get('context-usage').textContent, '53%');
  assert.equal(dom.get('context-meter').value, 53);
  const detail = dom.get('context-toggle').getAttribute('aria-label'); assert.ok(detail.includes((112000).toLocaleString())); assert.ok(detail.includes((200000).toLocaleString())); assert.match(detail, /47%/);
});
