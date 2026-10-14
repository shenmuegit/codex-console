import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatState, installSnapshot, applyNativeEvent } from '../../web/public/chat.js';
import { resumeFixture } from './helpers.mjs';
import { createPassiveHistorySync } from '../../web/passive-history.mjs';
import { httpsFixture } from './helpers.mjs';
import { setTimeout as delay } from 'node:timers/promises';

const cursor = seq => ({ generation: 1, seq });
const agent = (id, text) => ({ id, type: 'agentMessage', text });
function state() {
  const value = createChatState('t');
  installSnapshot(value, { snapshot: resumeFixture('t', [{ id: 'old', status: 'completed', items: [agent('a', '已有回复')] }]), cursor: cursor(1) });
  value.historyCursor = 'older-page'; value.draft = '尚未发送';
  return value;
}
const update = (seq, text = '定时回复') => ({ kind: 'notification', cursor: cursor(seq), native: { method: 'thread/history/updated', params: {
  threadId: 't', thread: { id: 't', updatedAt: 20 },
  turns: [{ id: 'scheduled', status: 'completed', error: null }],
  entries: [{ turnId: 'scheduled', item: agent('scheduled-answer', text), completedAtMs: 20000 }],
} } });

test('persisted replies from another native runtime merge without replacing loaded history or drafts', () => {
  const value = state(), original = value.turns[0].items[0];
  applyNativeEvent(value, update(2));
  assert.deepEqual(value.turns.map(turn => turn.id), ['old', 'scheduled']);
  assert.equal(value.turns[1].items[0].text, '定时回复');
  assert.strictEqual(value.turns[0].items[0], original);
  assert.equal(value.historyCursor, 'older-page'); assert.equal(value.draft, '尚未发送');
  applyNativeEvent(value, update(2)); assert.equal(value.turns[1].items.length, 1);
  applyNativeEvent(value, update(3, '定时回复已完成')); assert.equal(value.turns[1].items[0].text, '定时回复已完成');
  applyNativeEvent(value, update(2, '迟到的旧内容')); assert.equal(value.turns[1].items[0].text, '定时回复已完成');
});

test('a persisted native prompt can arrive during live output without replacing newer streamed text', async t => {
  const f = source(t); f.value.turns[0].status = 'inProgress'; f.value.turns[0].items[0].text = '更新、更长的流式内容';
  f.persisted.turns = [{ id: 'old', status: 'interrupted', items: [], error: null }];
  f.persisted.entries = [{ turnId: 'old', item: agent('a', '旧持久化文本') },
    { turnId: 'old', item: { id: 'native-prompt', type: 'userMessage', content: [{ type: 'text', text: '原生主动指令', text_elements: [] }] } }];
  await f.sync.sync();
  assert.deepEqual(f.value.turns[0].items.map(i => i.id), ['native-prompt', 'a']);
  assert.equal(f.value.turns[0].items[1].text, '更新、更长的流式内容');
  assert.equal(f.value.turns[0].status, 'inProgress');
});

function source(t) {
  const value = state(), messages = [], calls = [];
  let generation = 1, seq = 2, enabled = true;
  const persisted = { thread: { ...value.thread, updatedAt: 20 },
    turns: [{ id: 'scheduled', status: 'completed', items: [], error: null }, { id: 'old', status: 'completed', items: [], error: null }],
    entries: [{ turnId: 'scheduled', item: agent('scheduled-answer', '原生主动回复'), completedAtMs: 20000 }, { turnId: 'old', item: agent('a', '已有回复') }] };
  const codex = { status: () => ({ generation, online: true }), async rpc(method, params) {
    calls.push({ method, params });
    const result = method === 'thread/list' ? { data: [persisted.thread] } : method === 'thread/read' ? { thread: persisted.thread } :
      method === 'thread/turns/list' ? { data: persisted.turns, nextCursor: null } : (() => {
        const items = params.sortDirection === 'asc' && persisted.prefix ? persisted.prefix : persisted.entries;
        const start = Number(params.cursor ?? 0), data = items.slice(start, start + params.limit);
        return { data, nextCursor: start + data.length < items.length ? String(start + data.length) : null };
      })();
    return { result, cursor: { generation, seq: ++seq } };
  } };
  const sync = createPassiveHistorySync({ codex, active: () => enabled, states: () => [value], publish(event) { messages.push(event); applyNativeEvent(value, event); } });
  t.after(() => sync.close());
  return { value, persisted, messages, calls, codex, sync, disable() { enabled = false; }, reconnect() { generation++; } };
}

test('a persisted reply is delivered without a native notification or another send, and unchanged reads stay silent', async t => {
  const f = source(t), previous = f.value.turns[0].items[0];
  await f.sync.sync();
  assert.equal(f.value.turns[1].items[0].text, '原生主动回复'); assert.strictEqual(f.value.turns[0].items[0], previous);
  assert.equal(f.messages.filter(e => e.native.method === 'thread/history/updated').length, 1);
  const reads = f.calls.filter(c => c.method === 'thread/items/list').length;
  await f.sync.sync();
  assert.equal(f.messages.filter(e => e.native.method === 'thread/history/updated').length, 1); assert.equal(f.calls.filter(c => c.method === 'thread/items/list').length, reads);
  assert.ok(f.calls.every(c => ['thread/list', 'thread/read', 'thread/items/list', 'thread/turns/list'].includes(c.method)));
  for (const call of f.calls.filter(c => /list$/.test(c.method))) assert.ok(call.params.limit <= 20);
  f.persisted.thread.updatedAt++;
  f.persisted.entries[0].item = agent('scheduled-answer', '原生主动回复，随后更新');
  await f.sync.sync(); assert.equal(f.value.turns[1].items[0].text, '原生主动回复，随后更新');
  assert.equal(f.value.turns[1].items.length, 1);
});

test('passive paginated conversations pick up changed records even when metadata has the same timestamp', async t => {
  const f = source(t); f.value.passive = true;
  await f.sync.sync();
  f.persisted.entries[0].item.text = '同一时间戳内持久化的新回复';
  await f.sync.sync();
  assert.equal(f.value.turns[1].items[0].text, '同一时间戳内持久化的新回复');
});

test('a native prompt outside the recent tool tail is read from a small turn prefix', async t => {
  const f = source(t); f.value.turns[0].status = 'inProgress';
  f.persisted.turns = [{ id: 'old', status: 'inProgress', items: [] }];
  f.persisted.entries = [{ turnId: 'old', item: agent('a', '旧持久化文本') }];
  f.persisted.prefix = [{ turnId: 'old', item: { id: 'native-prompt', type: 'userMessage', content: [{ type: 'text', text: '更早的原生指令', text_elements: [] }] } },
    { turnId: 'old', item: agent('a', '旧持久化文本') }];
  await f.sync.sync();
  assert.deepEqual(f.value.turns[0].items.map(i => i.id), ['native-prompt', 'a']);
  const prefix = f.calls.find(c => c.method === 'thread/items/list' && c.params.sortDirection === 'asc');
  assert.equal(prefix.params.limit, 20); assert.equal(prefix.params.turnId, 'old');
});

test('native live turns are preserved and closed pages or disposed synchronization never read history', async t => {
  const f = source(t); f.value.turns[0].status = 'inProgress';
  await f.sync.sync(); assert.equal(f.value.turns.length, 1); assert.equal(f.value.turns[0].status, 'inProgress');
  f.calls.length = 0; f.disable(); await f.sync.sync(); assert.equal(f.calls.length, 0);
  f.sync.close(); await f.sync.sync(); assert.equal(f.calls.length, 0);
});

test('the first passive catalog read refreshes threads even without a previous catalog stamp', async t => {
  const f = source(t);
  await f.sync.sync();
  assert.equal(f.messages[0].native.method, 'thread/list/updated');
  assert.ok(f.messages[0].cursor.seq > 1);
});

test('new items spanning multiple small pages stay ordered and do not add unloaded old turns', async t => {
  const f = source(t);
  f.persisted.entries = [...Array.from({ length: 25 }, (_, i) => ({ turnId: 'scheduled', item: agent('new-' + (24 - i), String(24 - i)) })), f.persisted.entries[1]];
  f.persisted.turns.push({ id: 'unloaded-older-turn', status: 'completed', items: [] });
  await f.sync.sync();
  assert.deepEqual(f.value.turns.map(t => t.id), ['old', 'scheduled']);
  assert.deepEqual(f.value.turns[1].items.map(i => i.id), Array.from({ length: 25 }, (_, i) => 'new-' + i));
  assert.equal(f.calls.filter(c => c.method === 'thread/items/list').length, 2);
});

test('a missing history anchor requests a fresh recent page instead of scanning an unbounded archive', async t => {
  const f = source(t);
  f.persisted.entries = Array.from({ length: 400 }, (_, i) => ({ turnId: 'scheduled', item: agent('new-' + i, String(i)) }));
  await f.sync.sync();
  assert.equal(f.calls.filter(c => c.method === 'thread/items/list').length, 10);
  assert.equal(f.messages.at(-1).kind, 'resync'); assert.equal(f.value.resync, true);
});

test('native events and connection changes supersede passive reads still in flight', async t => {
  for (const reason of ['live-event', 'generation']) await t.test(reason, async t => {
    const f = source(t), rpc = f.codex.rpc; let release;
    const held = new Promise(resolve => { release = resolve; });
    f.codex.rpc = async (method, params) => { const result = await rpc(method, params); if (method === 'thread/items/list') await held; return result; };
    const reading = f.sync.sync();
    for (let i = 0; i < 50 && !f.calls.some(c => c.method === 'thread/items/list'); i++) await delay(1);
    if (reason === 'generation') f.reconnect();
    else applyNativeEvent(f.value, { kind: 'notification', cursor: cursor(100), native: { method: 'item/completed', params: {
      threadId: 't', turnId: 'old', item: agent('a', '更新的原生消息'),
    } } });
    release(); await reading;
    assert.equal(f.messages.some(e => e.native.method === 'thread/history/updated'), false);
    assert.equal(f.value.turns.length, 1);
  });
});

test('the authenticated SSE stream receives history written outside its native connection', async t => {
  const f = await httpsFixture(); t.after(() => f.close());
  const cookie = await f.login(), viewId = await f.view(cookie), stream = await f.events(cookie, viewId);
  t.after(() => stream.req.destroy());
  const answered = new Set();
  const timer = setInterval(() => {
    for (const call of f.peer.sent) if (!answered.has(call.id)) {
      let result;
      if (call.method === 'thread/resume') result = resumeFixture('t', [{ id: 'old', status: 'completed', items: [agent('a', '已有回复')] }]);
      if (call.method === 'thread/list') result = { data: [{ id: 't', updatedAt: 20, name: 'Fixture' }], nextCursor: null };
      if (call.method === 'thread/read') result = { thread: { ...resumeFixture('t').thread, updatedAt: 20 } };
      if (call.method === 'thread/turns/list') result = { data: [{ id: 'scheduled', status: 'completed', items: [], error: null }], nextCursor: null };
      if (call.method === 'thread/items/list') result = { data: [{ turnId: 'scheduled', item: agent('scheduled-answer', 'SSE 主动回复'), completedAtMs: 20000 }], nextCursor: null };
      if (result) { answered.add(call.id); f.peer.replyTo(call.method, result); }
    }
  }, 5); t.after(() => clearInterval(timer));
  const opened = await f.request('/api/thread/open', { method: 'POST', cookie, body: { viewId, threadId: 't' } });
  assert.equal(opened.status, 200);
  for (let i = 0; i < 600 && !stream.text().includes('SSE 主动回复'); i++) await delay(10);
  assert.match(stream.text(), /thread\/history\/updated/); assert.match(stream.text(), /SSE 主动回复/);
  assert.equal(f.peer.sent.some(c => c.method === 'turn/start'), false);
});

test('an occupied native writer remains observable and rejects browser sends without submitting or losing the draft', async t => {
  const f = await httpsFixture(); t.after(() => f.close());
  const cookie = await f.login(), viewId = await f.view(cookie), answered = new Set();
  const timer = setInterval(() => {
    for (const call of f.peer.sent) if (!answered.has(call.id)) {
      answered.add(call.id);
      if (call.method === 'thread/resume') f.peer.errorTo(call.method, { code: -32600, message: 'thread t already has an active writer' });
      else if (call.method === 'thread/read') f.peer.replyTo(call.method, { thread: resumeFixture('t').thread });
      else if (['thread/turns/list', 'thread/items/list'].includes(call.method)) f.peer.replyTo(call.method, { data: [], nextCursor: null });
    }
  }, 5); t.after(() => clearInterval(timer));
  const opened = await f.request('/api/thread/open', { method: 'POST', cookie, body: { viewId, threadId: 't' } });
  assert.equal(opened.status, 200); assert.equal(opened.json.snapshot.passive, true);
  const sent = await f.request('/api/thread/send', { method: 'POST', cookie, body: { viewId, threadId: 't', clientUserMessageId: 'not-submitted',
    mode: 'start', draft: { text: '保留此问题', selections: [], uploadIds: [] } } });
  assert.equal(sent.status, 409); assert.equal(sent.json.error.code, 'THREAD_OWNED_ELSEWHERE');
  assert.equal(sent.json.error.outcome, 'not-sent'); assert.equal(f.peer.sent.some(c => c.method === 'turn/start'), false);
});
