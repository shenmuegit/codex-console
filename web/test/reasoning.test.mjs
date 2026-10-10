import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mountChat, itemText } from '../public/chat.js';
import { renderTranscript } from '../transcript.mjs';
import { resumeFixture } from './helpers.mjs';
import { domFixture } from './dom.mjs';

async function fixture(t, status, summary = [], content = []) {
  const dom = domFixture();
  const snapshot = resumeFixture('t', [{ id: 'turn', status, items: [{ id: 'reasoning', type: 'reasoning', summary, content }] }]);
  snapshot.transcript = renderTranscript(snapshot.thread, snapshot.initialTurnsPage.data);
  const api = async (path, body) => {
    if (path === '/api/thread/open') return { snapshot, cursor: { generation: 1, seq: 1 } };
    assert.equal(path, '/api/rpc'); return { result: { data: [], nextCursor: null } };
  };
  const chat = mountChat({ api, viewId: 'view', uploadLimitBytes: 32 }); chat.connection(true);
  t.after(() => { chat.dispose(); dom.restore(); }); await chat.open('t');
  return { chat, messages: dom.get('messages'), body: () => dom.get('messages').children[0].children[1].children[0].children[1],
    notify(seq, method, params) { chat.onEvent({ kind: 'notification', cursor: { generation: 1, seq }, native: { method, params: { threadId: 't', turnId: 'turn', ...params } } }); } };
}

test('completed reasoning without public text leaves no empty transcript row and retains native state', async t => {
  const f = await fixture(t, 'completed');
  assert.equal(f.messages.children.length, 0);
  const item = f.chat.getState().turns[0].items[0];
  assert.deepEqual(item.summary, []); assert.deepEqual(item.content, []); assert.equal(itemText(item), '');
});

test('empty live reasoning appears only when native summary deltas arrive', async t => {
  const f = await fixture(t, 'inProgress'); assert.equal(f.messages.children.length, 0);
  f.notify(2, 'item/reasoning/summaryTextDelta', { itemId: 'reasoning', summaryIndex: 0, delta: '已检查输入边界。' }); await delay(0);
  assert.equal(f.body().children[0].textContent, '已检查输入边界。');
  f.notify(3, 'turn/completed', { turn: { id: 'turn', status: 'completed', itemsView: 'summary', items: [] } }); await delay(0);
  assert.equal(f.body().children[0].textContent, '已检查输入边界。');
});

test('reopened reasoning retains native public text and safe server rendering', async t => {
  const f = await fixture(t, 'completed', ['已检查输入。'], ['<script>untrusted</script>']);
  assert.equal(itemText(f.chat.getState().turns[0].items[0]), '已检查输入。\n<script>untrusted</script>');
  assert.ok(f.body().innerHTML.includes('已检查输入。')); assert.ok(f.body().innerHTML.includes('&lt;script&gt;')); assert.equal(f.body().innerHTML.includes('<script>'), false);
});
