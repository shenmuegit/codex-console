import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mountChat } from '../public/chat.js';
import { domFixture } from './dom.mjs';
import { resumeFixture } from './helpers.mjs';

const queued = id => ({ id, clientUserMessageId: 'client-' + id,
  input: [{ type: 'text', text: 'Correction <script>', text_elements: [] }, { type: 'localImage', path: '/private/photo.png' }] });
const running = { id: 'turn', status: 'inProgress', items: [{ id: 'old', type: 'agentMessage', text: 'Earlier reply' }] };
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function fixture(t) {
  const dom = domFixture(), calls = []; let chat, seq = 1, queue = [queued('q1')], request = deferred(), refresh;
  const api = async (path, body) => {
    calls.push({ path, body });
    if (path === '/api/thread/open') return { snapshot: resumeFixture(body.threadId, [running]), cursor: { generation: 1, seq: seq++ } };
    if (path === '/api/thread/queue' || path === '/api/thread/send') {
      const response = await request.promise; queue = queue.filter(item => item.id !== body.queuedSubmissionId); return response;
    }
    if (path === '/api/rpc' && body.method === 'thread/queue/list') {
      if (refresh) await refresh.promise;
      return { result: { data: body.params.threadId === 't' ? queue : [], nextCursor: null } };
    }
    return { result: { data: [], nextCursor: null } };
  };
  chat = mountChat({ api, viewId: 'view', uploadLimitBytes: 32 }); t.after(() => { refresh?.resolve(); request.resolve({ result: { turnId: 'turn' } }); chat.dispose(); dom.restore(); });
  chat.connection(true); await chat.open('t'); await delay(0);
  return { dom, chat, calls,
    async updateQueuedText(text) { queue[0].input[0].text = text; chat.onEvent({ kind: 'notification', cursor: { generation: 1, seq: seq++ }, native: { method: 'thread/queue/changed', params: { threadId: 't' } } }); await delay(0); },
    steer() { dom.get('queued-messages').children[0].querySelectorAll().find(node => node.dataset.action === 'steer').click(); },
    bubbles() { return dom.get('messages').children.filter(node => node.className === 'message message-user'); },
    accept() { request.resolve({ result: { turnId: 'turn' }, cursor: { generation: 1, seq: 100 } }); },
    fail(unknown = false) { request.reject(Object.assign(new Error('Steer failed'), unknown === 'network' ? {} : { status: 409, outcome: unknown ? 'unknown' : 'not-sent' })); },
    holdRefresh() { refresh = deferred(); }, releaseRefresh() { refresh.resolve(); refresh = null; },
    failRefresh() { refresh.reject(new Error('Queue refresh failed')); refresh = null; },
    async next(id) { request = deferred(); queue = [queued(id)]; chat.onEvent({ kind: 'notification', cursor: { generation: 1, seq: seq++ }, native: { method: 'thread/queue/changed', params: { threadId: 't' } } }); await delay(0); },
    notify(clientId, id = 'native-user') { chat.onEvent({ kind: 'notification', cursor: { generation: 1, seq: seq++ }, native: { method: 'item/completed',
      params: { threadId: 't', turnId: 'turn', item: { id, type: 'userMessage', clientId, content: [{ type: 'text', text: 'Correction <script>', text_elements: [] }] } } } }); },
  };
}

test('clicking steer immediately shows its text and sending status without changing native history', async t => {
  const f = await fixture(t), state = f.chat.getState(), old = f.dom.get('messages').children[0];
  state.draft = f.dom.get('draft').value = 'Keep the newer draft';
  f.steer(); const bubbles = f.bubbles();
  assert.equal(bubbles.length, 1); assert.equal(bubbles[0].children[0].textContent, '正在引导…');
  assert.equal(bubbles[0].children[1].children[0].textContent, 'Correction <script>\n［图片］');
  assert.equal(state.turns[0].items.length, 1); assert.equal(state.cursor.seq, 1);
  assert.ok(f.dom.get('messages').children[0] === old); assert.equal(state.draft, 'Keep the newer draft');
  assert.equal(f.dom.get('queue-recovery').hidden, true, 'Normal pending work is not an unknown-outcome recovery');
  f.steer(); assert.equal(f.calls.filter(call => call.path === '/api/thread/queue').length, 1);
});

test('deleting a queued message leaves the chat transcript untouched', async t => {
  const f = await fixture(t), reply = f.dom.get('messages').children[0];
  f.dom.get('queued-messages').children[0].querySelectorAll().find(node => node.dataset.action === 'delete').click();
  assert.equal(f.bubbles().length, 0); assert.equal(f.dom.get('queued-messages').hidden, false);
  f.accept(); await delay(0); assert.equal(f.bubbles().length, 0); assert.equal(f.dom.get('queued-messages').hidden, true);
  assert.equal(f.dom.get('messages').children[0], reply);
});

test('native queue edits update only the queue row', async t => {
  const f = await fixture(t), reply = f.dom.get('messages').children[0]; await f.updateQueuedText('Edited queued question');
  assert.equal(f.bubbles().length, 0); assert.match(f.dom.get('queued-messages').textContent, /Edited queued question/);
  assert.equal(f.dom.get('messages').children[0], reply);
});

test('accepted steer appears before a slow queue refresh and merges with the later native message', async t => {
  const f = await fixture(t); f.steer(); f.holdRefresh(); f.accept(); await delay(0);
  assert.equal(f.bubbles().length, 1); assert.equal(f.bubbles()[0].children[0].textContent, '已引导');
  assert.equal(f.dom.get('queued-messages').hidden, true); assert.equal(f.chat.getState().queueBusy, false);
  assert.equal(f.chat.getState().cursor.seq, 1, 'Acknowledgement cannot advance the SSE cursor');
  f.notify('client-q1'); await delay(0);
  assert.equal(f.bubbles().length, 1); assert.equal(f.bubbles()[0].dataset.itemId, 'native-user');
  f.releaseRefresh(); await delay(0); assert.equal(f.bubbles().length, 1);
});

test('native delivery before the HTTP acknowledgement never creates a duplicate steer bubble', async t => {
  const f = await fixture(t); f.steer(); f.notify('client-q1'); await delay(0);
  assert.equal(f.bubbles().length, 1); f.accept(); await delay(0);
  assert.equal(f.bubbles().length, 1); assert.equal(f.bubbles()[0].dataset.itemId, 'native-user');
});

test('identical steer text remains separate and reconciles only by its client message ID', async t => {
  const f = await fixture(t); f.steer(); f.accept(); await delay(0); await f.next('q2'); f.steer(); f.accept(); await delay(0);
  assert.equal(f.bubbles().length, 2); f.notify('client-q1', 'user-one'); await delay(0);
  assert.equal(f.bubbles().length, 2); f.notify('client-q2', 'user-two'); await delay(0);
  assert.deepEqual(f.bubbles().map(node => node.dataset.itemId), ['user-one', 'user-two']);
});

test('rejected steering retains the queued input and draft without a sent bubble', async t => {
  const f = await fixture(t); f.chat.getState().draft = 'Keep draft'; f.steer(); f.fail(); await delay(0);
  assert.equal(f.bubbles().length, 0); assert.equal(f.chat.getState().draft, 'Keep draft');
  assert.deepEqual(f.chat.getState().queued[0], queued('q1')); assert.match(f.dom.get('chat-error').textContent, /Steer failed/);
});

test('unknown steering keeps visibly unconfirmed text and the existing recovery action', async t => {
  const f = await fixture(t); f.steer(); f.fail(true); await delay(0);
  assert.equal(f.bubbles().length, 1); assert.equal(f.bubbles()[0].children[0].textContent, '引导状态待核对');
  assert.equal(f.dom.get('queue-recovery').hidden, false); assert.deepEqual(f.chat.getState().queued[0], queued('q1'));
  f.notify('client-q1'); await delay(0); assert.equal(f.bubbles().length, 1); assert.equal(f.bubbles()[0].dataset.itemId, 'native-user');
});

test('network failures leave steer text unconfirmed rather than reporting a successful send', async t => {
  const f = await fixture(t); f.steer(); f.fail('network'); await delay(0);
  assert.equal(f.bubbles().length, 1); assert.equal(f.bubbles()[0].children[0].textContent, '引导状态待核对');
  assert.equal(f.dom.get('queue-recovery').hidden, false); assert.deepEqual(f.chat.getState().queued[0], queued('q1'));
});

test('a failed queue refresh does not revert a confirmed steer or its sent bubble', async t => {
  const f = await fixture(t); f.steer(); f.holdRefresh(); f.accept(); await delay(0); f.failRefresh(); await delay(0);
  assert.equal(f.bubbles()[0].children[0].textContent, '已引导'); assert.equal(f.chat.getState().queueRecovery, null);
  assert.equal(f.chat.getState().queueBusy, false); assert.equal(f.dom.get('queued-messages').hidden, true);
  assert.match(f.dom.get('chat-error').textContent, /Queue refresh failed/);
});

test('reconnection snapshots reconcile accepted steers by ID without inventing durable chat items', async t => {
  const f = await fixture(t); f.steer(); f.accept(); await delay(0);
  assert.equal(f.chat.getState().turns[0].items.length, 1);
  f.chat.onEvent({ kind: 'snapshot', cursor: { generation: 2, seq: 1 }, native: resumeFixture('t', [{ ...running,
    items: [...running.items, { id: 'snapshot-user', type: 'userMessage', clientId: 'client-q1', content: [{ type: 'text', text: 'Correction <script>' }] }] }]) });
  await delay(0); assert.equal(f.bubbles().length, 1); assert.equal(f.bubbles()[0].dataset.itemId, 'snapshot-user');
  assert.equal(f.chat.getState().turns[0].items.length, 2); assert.equal(f.chat.getState().cursor.generation, 2);
});

test('steer acknowledgements and pending bubbles stay with the original conversation during navigation', async t => {
  const f = await fixture(t); f.steer(); await f.chat.open('other'); f.accept(); await delay(0);
  assert.equal(f.chat.getState().threadId, 'other'); assert.equal(f.bubbles().length, 0);
  await f.chat.open('t'); await delay(0); assert.equal(f.bubbles().length, 1); assert.equal(f.bubbles()[0].children[0].textContent, '已引导');
  f.notify('client-q1'); await delay(0); assert.equal(f.bubbles().length, 1); assert.equal(f.bubbles()[0].dataset.itemId, 'native-user');
});

test('background delivery is reconciled before a later history page no longer includes that message', async t => {
  const f = await fixture(t); f.steer(); f.accept(); await delay(0); await f.chat.open('other');
  f.notify('client-q1'); await delay(0); assert.equal(f.bubbles().length, 0);
  await f.chat.open('t'); await delay(0); assert.equal(f.bubbles().length, 0, 'A delivered steer must not reappear as a temporary message');
});

test('deleting a conversation also removes its temporary steer feedback', async t => {
  const f = await fixture(t); f.steer();
  f.chat.onEvent({ kind: 'notification', cursor: { generation: 1, seq: 2 }, native: { method: 'thread/deleted', params: { threadId: 't' } } });
  await delay(0); assert.equal(f.bubbles().length, 0); f.accept(); await delay(0); assert.equal(f.bubbles().length, 0);
});

test('composer steer mode uses the same immediate and acknowledged feedback', async t => {
  const f = await fixture(t);
  f.dom.get('queued-messages').children[0].querySelectorAll().find(node => node.dataset.action === 'menu').click();
  f.dom.get('queue-menu-toggle').click();
  f.chat.getState().draft = f.dom.get('draft').value = 'Composer correction'; f.dom.event('composer', 'submit');
  assert.equal(f.bubbles().length, 1); assert.equal(f.bubbles()[0].children[0].textContent, '正在引导…');
  const sent = f.calls.find(call => call.path === '/api/thread/send'); assert.equal(sent.body.mode, 'steer');
  f.accept(); await delay(0); assert.equal(f.chat.getState().draft, ''); assert.equal(f.bubbles()[0].children[0].textContent, '已引导');
  f.notify(sent.body.clientUserMessageId); await delay(0); assert.equal(f.bubbles().length, 1); assert.equal(f.bubbles()[0].dataset.itemId, 'native-user');
});
