import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mountChat } from '../public/chat.js';
import { renderTranscript } from '../transcript.mjs';
import { domFixture } from './dom.mjs';
import { resumeFixture } from './helpers.mjs';

const message = (id, text = id) => ({ id, type: 'agentMessage', text });
function snapshot(id, items, nextCursor = 'older', references = new Map()) {
  const value = resumeFixture(id, [{ id: id + '-turn', status: 'completed', items }]);
  value.thread.name = 'Conversation ' + id; value.historyKind = 'items'; value.initialTurnsPage.nextCursor = nextCursor;
  value.transcript = renderTranscript(value.thread, value.initialTurnsPage.data, references); return value;
}
async function fixture(t) {
  const dom = domFixture(), snapshots = new Map(), gates = new Map(), history = new Map(), calls = []; let seq = 0, generation = 1;
  const api = async (path, body) => {
    calls.push({ path, body });
    if (path === '/api/thread/open') {
      const response = { snapshot: snapshots.get(body.threadId) ?? snapshot(body.threadId, [message(body.threadId)]), cursor: { generation, seq: ++seq } };
      if (gates.has(body.threadId)) await gates.get(body.threadId).promise;
      return response;
    }
    if (path === '/api/thread/history') return { result: history.get(body.threadId), cursor: { generation, seq: ++seq } };
    return { result: { goal: null, data: [], nextCursor: null }, cursor: { generation, seq: ++seq } };
  };
  const chat = mountChat({ api, viewId: 'view', uploadLimitBytes: 32 }); chat.connection(true);
  t.after(() => { chat.dispose(); for (const gate of gates.values()) gate.resolve(); dom.restore(); });
  return { dom, chat, snapshots, history, calls, cursor() { return { generation, seq: ++seq }; }, nextGeneration() { generation++; },
    hold(id) { let resolve; const promise = new Promise(yes => { resolve = yes; }); gates.set(id, { promise, resolve }); return () => { gates.delete(id); resolve(); }; },
    ids() { return chat.getState().turns.flatMap(turn => turn.items.map(item => item.id)); },
  };
}

test('returning to a cached conversation immediately restores nodes, expanded activity, draft and scroll', async t => {
  const f = await fixture(t), feed = f.dom.get('chat-feed');
  f.snapshots.set('a', snapshot('a', [message('first'), { id: 'command', type: 'commandExecution', command: 'pwd', status: 'completed' },
    { id: 'image', type: 'imageGeneration', status: 'completed', result: '', savedPath: '/native/cat.png' }], 'older', new Map([['image', [{ name: 'cat.png', href: '/api/files/cat', imageHref: '/api/images/cat' }]]])));
  await f.chat.open('a'); const [row, activity, photo] = f.dom.get('messages').children, image = photo.children[2].children[0]; activity.open = true;
  feed.scrollHeight = 2400; feed.clientHeight = 400; feed.scrollTop = 450;
  f.dom.get('draft').value = 'Draft A'; f.dom.event('draft', 'input');
  await f.chat.open('b'); feed.scrollTop = 1100;
  const release = f.hold('a'), opening = f.chat.open('a');
  assert.ok(f.dom.get('messages').children[0] === row); assert.ok(f.dom.get('messages').children[1] === activity);
  assert.ok(f.dom.get('messages').children[2].children[2].children[0] === image);
  assert.equal(activity.open, true); assert.equal(feed.scrollTop, 450); assert.equal(f.dom.get('draft').value, 'Draft A');
  assert.equal(f.dom.get('send').disabled, true, 'Writes wait for the gateway to bind this conversation');
  release(); await opening;
  assert.ok(f.dom.get('messages').children[0] === row); assert.equal(activity.open, true); assert.equal(feed.scrollTop, 450);
  assert.ok(f.dom.get('messages').children[2].children[2].children[0] === image);
  assert.deepEqual(f.calls.filter(call => call.path === '/api/thread/open').map(call => call.body.threadId), ['a', 'b', 'a']);
});

test('cached older pages stay loaded when the refreshed native tail overlaps them', async t => {
  const f = await fixture(t); f.snapshots.set('a', snapshot('a', [message('recent-1'), message('recent-2')], 'older-1'));
  await f.chat.open('a');
  f.history.set('a', { data: [{ id: 'a-turn', status: 'completed', items: [message('old-1'), message('old-2')] }], nextCursor: 'older-2' });
  f.dom.get('older-history').click(); await delay(0); const old = f.dom.get('messages').children[0];
  await f.chat.open('b'); f.snapshots.set('a', snapshot('a', [message('recent-1'), message('recent-2'), message('new')], 'refreshed-boundary'));
  await f.chat.open('a');
  assert.deepEqual(f.ids(), ['old-1', 'old-2', 'recent-1', 'recent-2', 'new']);
  assert.equal(f.chat.getState().historyCursor, 'older-2'); assert.ok(f.dom.get('messages').children[0] === old);
  assert.equal(f.calls.filter(call => call.path === '/api/thread/history').length, 1);
});

test('a native history gap uses the new paging boundary instead of skipping missing messages', async t => {
  const f = await fixture(t); await f.chat.open('a'); await f.chat.open('b');
  f.snapshots.set('a', snapshot('a', [message('new-1'), message('new-2')], 'fill-gap'));
  await f.chat.open('a'); assert.deepEqual(f.ids(), ['new-1', 'new-2']); assert.equal(f.chat.getState().historyCursor, 'fill-gap');
});

test('an authoritative full history cannot revive removed cached messages', async t => {
  const f = await fixture(t); f.snapshots.set('a', snapshot('a', [message('removed'), message('kept')], null));
  await f.chat.open('a'); await f.chat.open('b'); f.snapshots.set('a', snapshot('a', [message('kept')], null));
  await f.chat.open('a'); assert.deepEqual(f.ids(), ['kept']); assert.equal(f.chat.getState().historyCursor, null);
});

test('unfinished cached prefixes and connection changes require authoritative history', async t => {
  for (const change of ['unfinished', 'generation']) await t.test(change, async t => {
    const f = await fixture(t); f.snapshots.set('a', snapshot('a', [message('old'), message('anchor')])); await f.chat.open('a');
    if (change === 'unfinished') f.chat.getState().turns[0].items[0]._incomplete = true;
    await f.chat.open('b'); if (change === 'generation') f.nextGeneration();
    f.snapshots.set('a', snapshot('a', [message('anchor'), message('new')], 'authoritative'));
    await f.chat.open('a'); assert.deepEqual(f.ids(), ['anchor', 'new']); assert.equal(f.chat.getState().historyCursor, 'authoritative');
  });
});

test('late cached refreshes cannot replace the newer selected conversation', async t => {
  const f = await fixture(t); await f.chat.open('a'); await f.chat.open('b'); const row = f.dom.get('messages').children[0];
  const release = f.hold('a'), pending = f.chat.open('a'); await f.chat.open('b'); release(); await pending;
  assert.equal(f.chat.getState().threadId, 'b'); assert.ok(f.dom.get('messages').children[0] === row);
});

test('unanswered native cards retain their input nodes and values across cached navigation', async t => {
  const f = await fixture(t), native = { method: 'item/tool/requestUserInput', params: { threadId: 'a', turnId: 'a-turn', itemId: 'ask', questions: [{ id: 'answer', header: 'Answer', question: 'Your answer?', isOther: false, isSecret: false, options: null }] } };
  const a = snapshot('a', [message('a')]); a.pendingRequests = [['1:question', native]]; f.snapshots.set('a', a);
  await f.chat.open('a'); const card = f.dom.get('native-requests').children[0], input = card.querySelectorAll().find(node => node.tagName === 'INPUT');
  input.value = 'Unsubmitted answer'; await f.chat.open('b'); await f.chat.open('a');
  assert.ok(f.dom.get('native-requests').children[0] === card); assert.equal(input.value, 'Unsubmitted answer');
});

test('cached conversations include background SSE updates before their binding request completes', async t => {
  const f = await fixture(t); await f.chat.open('a'); await f.chat.open('b');
  f.chat.onEvent({ kind: 'notification', cursor: f.cursor(), native: { method: 'item/agentMessage/delta', params: { threadId: 'a', turnId: 'a-turn', itemId: 'a', delta: ' updated' } } });
  const release = f.hold('a'), opening = f.chat.open('a');
  assert.equal(f.dom.get('messages').children[0].children[1].children[0].textContent, 'a updated');
  release(); await opening;
});
