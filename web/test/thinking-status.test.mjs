import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mountChat } from '../public/chat.js';
import { domFixture } from './dom.mjs';
import { resumeFixture } from './helpers.mjs';

const running = { id: 'new-turn', status: 'inProgress', items: [], itemsView: 'notLoaded' };
async function fixture(t, turns = []) {
  const dom = domFixture(), submissions = []; let resolve, reject, sends = 0;
  const reply = new Promise((yes, no) => { resolve = yes; reject = no; });
  const api = async (path, body) => {
    if (path === '/api/thread/open') return { snapshot: resumeFixture('t', turns), cursor: { generation: 1, seq: 1 } };
    if (path === '/api/thread/send') { sends++; submissions.push(body); return reply; }
    return { result: { data: [], nextCursor: null } };
  };
  const chat = mountChat({ api, viewId: 'view', uploadLimitBytes: 32 }); t.after(() => { chat.dispose(); dom.restore(); });
  chat.connection(true); await chat.open('t'); await delay(0);
  const indicator = dom.get('thinking-status'); assert.ok(indicator, 'The chat transcript has a thinking status row');
  return { dom, chat, indicator, get sends() { return sends; }, get submission() { return submissions.at(-1); },
    bubbles() { return dom.get('messages').children.filter(node => node.className === 'message message-user'); },
    send() { chat.getState().draft = dom.get('draft').value = 'Hello'; dom.event('composer', 'submit'); },
    accept(result = { turn: running }, seq = 5) { resolve({ result, cursor: { generation: 1, seq } }); },
    fail(error) { reject(error); },
    notify(seq, method, params) { chat.onEvent({ kind: 'notification', cursor: { generation: 1, seq }, native: { method, params: { threadId: 't', turnId: 'new-turn', ...params } } }); },
  };
}

test('accepted sends immediately show thinking before SSE without fabricating native history', async t => {
  const f = await fixture(t); f.send(); assert.equal(f.indicator.hidden, true);
  f.accept(); await delay(0);
  assert.equal(f.indicator.hidden, false); assert.equal(f.indicator.textContent, '正在思考');
  assert.equal(f.dom.get('chat-empty').hidden, true); assert.equal(f.chat.getState().turns.length, 0);
  assert.equal(f.chat.getState().cursor.seq, 1, 'The HTTP acknowledgement must not skip earlier SSE frames');
  f.send(); await delay(0); assert.equal(f.sends, 1, 'Wait for native start before accepting another submission');
  f.notify(2, 'turn/started', { turn: running });
  f.notify(3, 'item/completed', { item: { id: 'user', type: 'userMessage', content: [{ type: 'text', text: 'Hello', text_elements: [] }] } });
  await delay(0); assert.equal(f.indicator.hidden, false); assert.equal(f.chat.getState().turns[0].items[0].id, 'user');
});

test('sending shows the clicked text immediately and retains one bubble until native delivery', async t => {
  const f = await fixture(t); f.send(); assert.equal(f.bubbles().length, 1); assert.equal(f.bubbles()[0].children[1].textContent, 'Hello');
  assert.equal(f.bubbles()[0].children[0].textContent, '正在发送…'); assert.equal(f.indicator.hidden, true);
  f.chat.getState().draft = f.dom.get('draft').value = 'Newer draft'; f.accept(); await delay(0);
  assert.equal(f.bubbles().length, 1); assert.equal(f.bubbles()[0].children[0].textContent, '已发送'); assert.equal(f.chat.getState().draft, 'Newer draft'); assert.equal(f.indicator.hidden, false);
  f.notify(2, 'turn/started', { turn: running });
  f.notify(3, 'item/completed', { item: { id: 'native-user', clientId: f.submission.clientUserMessageId, type: 'userMessage', content: [{ type: 'text', text: 'Hello' }] } }); await delay(0);
  assert.equal(f.bubbles().length, 1); assert.equal(f.bubbles()[0].dataset.itemId, 'native-user');
});

test('a non-turn SSE event ahead of the HTTP reply cannot hide accepted-send thinking', async t => {
  const f = await fixture(t); f.send(); f.notify(6, 'thread/name/updated', { threadName: 'Updated' }); f.accept(); await delay(0);
  assert.equal(f.indicator.hidden, false); assert.equal(f.bubbles().length, 1); assert.equal(f.chat.getState().cursor.seq, 6);
});

test('a missing native user echo does not move the sent question below its streamed answer', async t => {
  const f = await fixture(t); f.send(); const bubble = f.bubbles()[0];
  f.notify(2, 'item/agentMessage/delta', { itemId: 'reply', delta: 'Answer' }); await delay(0);
  assert.ok(f.dom.get('messages').children[0] === bubble); assert.equal(f.dom.get('messages').children[1].children[1].textContent, 'Answer');
  f.accept(); await delay(0); assert.ok(f.dom.get('messages').children[0] === bubble);
});

test('a newer authoritative snapshot prevents a late acknowledgement from reviving thinking', async t => {
  const f = await fixture(t); f.send(); f.chat.onEvent({ kind: 'snapshot', cursor: { generation: 1, seq: 7 }, native: resumeFixture('t') });
  f.accept(); await delay(0); assert.equal(f.indicator.hidden, true);
});

test('rejected sends remove the temporary bubble while unknown outcomes remain visibly unconfirmed', async t => {
  for (const unknown of [false, true]) await t.test(unknown ? 'unknown' : 'rejected', async t => {
    const f = await fixture(t); f.send(); f.fail(Object.assign(Error('Send failed'), { status: 422, outcome: unknown ? 'unknown' : 'not-sent' })); await delay(0);
    assert.equal(f.bubbles().length, unknown ? 1 : 0); if (unknown) assert.equal(f.bubbles()[0].children[0].textContent, '发送状态待核对');
    assert.equal(f.indicator.hidden, true); assert.equal(f.chat.getState().draft, 'Hello');
  });
});

test('queued sends immediately show a queued bubble without claiming a new thinking turn', async t => {
  const f = await fixture(t, [{ ...running, items: [{ id: 'reply', type: 'agentMessage', text: 'Current reply', _incomplete: true }] }]);
  f.send(); assert.equal(f.bubbles().length, 1); assert.equal(f.bubbles()[0].children[0].textContent, '正在排队…');
  f.accept({ queuedSubmission: { id: 'queued' } }); await delay(0);
  assert.equal(f.bubbles()[0].children[0].textContent, '已排队'); assert.equal(f.indicator.hidden, true);
});

test('thinking follows native reasoning and reply streaming, then disappears on completion', async t => {
  const f = await fixture(t, [running]); assert.equal(f.indicator.hidden, false);
  f.notify(2, 'item/started', { item: { id: 'reason', type: 'reasoning', summary: [], content: [] } }); await delay(0);
  assert.equal(f.indicator.hidden, false, 'Empty public reasoning still gives visible feedback');
  f.notify(3, 'item/agentMessage/delta', { itemId: 'reply', delta: 'Visible reply' }); await delay(0); assert.equal(f.indicator.hidden, true);
  f.notify(4, 'item/completed', { item: { id: 'reply', type: 'agentMessage', text: 'Visible reply', phase: 'commentary' } }); await delay(0);
  assert.equal(f.indicator.hidden, false, 'Thinking can resume between commentary and further work');
  f.notify(5, 'turn/completed', { turn: { ...running, status: 'completed' } }); await delay(0); assert.equal(f.indicator.hidden, true);
});

test('definitive and uncertain send failures do not claim that thinking has started', async t => {
  for (const unknown of [false, true]) await t.test(unknown ? 'unknown outcome' : 'rejected send', async t => {
    const f = await fixture(t); f.send(); f.fail(Object.assign(new Error('Send failed'), { status: 422, outcome: unknown ? 'unknown' : 'not-sent' }));
    await delay(0); assert.equal(f.indicator.hidden, true); assert.equal(f.chat.getState().draft, 'Hello');
    assert.equal(f.chat.getState().turns.length, 0); assert.match(f.dom.get('chat-error').textContent, /Send failed/);
  });
});

test('a delayed send acknowledgement cannot revive a completed turn', async t => {
  const f = await fixture(t); f.send(); f.notify(2, 'turn/started', { turn: running });
  f.notify(6, 'turn/completed', { turn: { ...running, status: 'completed' } }); await delay(0);
  f.accept(); await delay(0); assert.equal(f.indicator.hidden, true); assert.equal(f.chat.getState().turns[0].status, 'completed');
});

test('an authoritative snapshot clears the temporary acknowledgement feedback', async t => {
  const f = await fixture(t); f.send(); f.accept(); await delay(0); assert.equal(f.indicator.hidden, false);
  f.chat.onEvent({ kind: 'snapshot', cursor: { generation: 1, seq: 1 }, native: resumeFixture('t') });
  await delay(0); assert.equal(f.indicator.hidden, false, 'A stale snapshot cannot cancel the accepted-send feedback');
  f.chat.onEvent({ kind: 'snapshot', cursor: { generation: 1, seq: 7 }, native: resumeFixture('t') });
  await delay(0); assert.equal(f.indicator.hidden, true);
});

test('an old-connection acknowledgement cannot start thinking after the connection generation changes', async t => {
  const f = await fixture(t); f.send();
  f.chat.onEvent({ kind: 'status', cursor: { generation: 2, seq: 1 }, native: { online: false } });
  f.accept(); await delay(0); assert.equal(f.indicator.hidden, true); assert.equal(f.chat.getState().turns.length, 0);
});

test('queue acknowledgement does not fabricate a new thinking turn while a reply is streaming', async t => {
  const f = await fixture(t, [{ ...running, items: [{ id: 'reply', type: 'agentMessage', text: 'Current reply', _incomplete: true }] }]);
  assert.equal(f.indicator.hidden, true); f.send(); f.accept({ queuedSubmission: { id: 'queued' } }); await delay(0);
  assert.equal(f.indicator.hidden, true); assert.equal(f.chat.getState().turns.length, 1);
});

test('native input requests replace thinking feedback until the request is resolved', async t => {
  const f = await fixture(t, [running]); assert.equal(f.indicator.hidden, false);
  f.chat.onEvent({ kind: 'request', cursor: { generation: 1, seq: 2 }, requestKey: '1:"question"',
    native: { method: 'item/tool/requestUserInput', params: { threadId: 't', turnId: 'new-turn', itemId: 'ask', questions: [] } } });
  await delay(0); assert.equal(f.indicator.hidden, true);
  f.notify(3, 'serverRequest/resolved', { requestId: 'question' }); await delay(0); assert.equal(f.indicator.hidden, false);
});
