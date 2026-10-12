import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { httpsFixture, resumeFixture } from './helpers.mjs';
import { mountChat } from '../public/chat.js';
import { domFixture } from './dom.mjs';

async function waitCall(peer, method, count = 1) {
  for (let i = 0; i < 100; i++) { if (peer.sent.filter(call => call.method === method).length >= count) return peer.sent.filter(call => call.method === method).at(-1); await delay(5); }
  assert.fail(`Missing ${method}`);
}
const user = { id: 'user', type: 'userMessage', content: [{ type: 'text', text: 'Keep this question' }] };
const answer = { id: 'answer', type: 'agentMessage', text: 'Keep this final answer [file](/project/result.txt)' };
function nativeHistory(view) {
  const items = view === 'summary' ? [user, answer] : [user, { id: 'large-tool', type: 'commandExecution', aggregatedOutput: 'TOOL_OUTPUT'.repeat(400_000) }, answer];
  return [{ id: 'turn', status: 'completed', itemsView: view, items }];
}

test('history reads normalize legacy full requests and keep native pagination without tool hydration', async t => {
  const f = await httpsFixture(); t.after(() => f.close()); const cookie = await f.login();
  for (const [i, view] of [undefined, 'summary', 'full'].entries()) {
    const reading = f.request('/api/rpc', { method: 'POST', cookie, body: { method: 'thread/turns/list', params: { threadId: 't', cursor: 'native-older', limit: 20, sortDirection: 'desc', ...(view ? { itemsView: view } : {}) } } });
    const call = await waitCall(f.peer, 'thread/turns/list', i + 1);
    f.peer.replyTo('thread/turns/list', { data: nativeHistory(call.params.itemsView), nextCursor: 'next-native' });
    await waitCall(f.peer, 'thread/read', i + 1); f.peer.replyTo('thread/read', { thread: resumeFixture('t').thread });
    const response = await reading; assert.equal(response.status, 200); assert.equal(call.params.itemsView, 'summary');
    assert.equal(call.params.cursor, 'native-older'); assert.equal(response.json.result.nextCursor, 'next-native'); assert.ok(response.text.length < 100_000);
  }
});

test('opening older history in the composer requests native summaries and preserves newer content', async t => {
  const dom = domFixture(), calls = [];
  const api = async (path, body) => {
    if (path === '/api/thread/open') { const snapshot = resumeFixture('t', [{ id: 'latest', items: [answer] }]); snapshot.initialTurnsPage.nextCursor = 'older'; return { snapshot, cursor: { generation: 1, seq: 1 } }; }
    calls.push(body);
    if (body.method === 'thread/turns/list') return { result: { data: [{ id: 'older-turn', items: [user] }], nextCursor: null }, cursor: { generation: 1, seq: 2 } };
    return { result: { data: [], nextCursor: null } };
  };
  const chat = mountChat({ api, viewId: 'view', uploadLimitBytes: 32 }); t.after(() => { chat.dispose(); dom.restore(); }); chat.connection(true); await chat.open('t');
  dom.get('older-history').click(); await delay(0);
  assert.equal(calls.find(call => call.method === 'thread/turns/list').params.itemsView, 'summary');
  assert.deepEqual(chat.getState().turns.map(turn => turn.id), ['older-turn', 'latest']); assert.equal(chat.getState().ready, true);
});
