import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { httpsFixture, resumeFixture } from './helpers.mjs';
import { createChatState, installSnapshot, prependHistory, applyNativeEvent, mountChat } from '../public/chat.js';
import { domFixture } from './dom.mjs';

async function waitCall(peer, method, count = 1) {
  for (let i = 0; i < 100; i++) { const calls = peer.sent.filter(call => call.method === method); if (calls.length >= count) return calls.at(-1); await delay(5); }
  assert.fail(`Missing ${method}`);
}
const checkpoint = seq => ({ generation: 1, seq });
const message = (id, text) => ({ id, type: 'agentMessage', text });
const snapshot = (items, nextCursor = 'older-items') => {
  const result = resumeFixture('t', [{ id: 'turn', status: 'completed', items }]);
  result.historyKind = 'items'; result.initialTurnsPage.nextCursor = nextCursor; return result;
};

test('opening a large native history reads only the newest item page with tools and reasoning', async t => {
  const f = await httpsFixture(); t.after(() => f.close()); const cookie = await f.login(), viewId = await f.view(cookie), stream = await f.events(cookie, viewId);
  const opening = f.request('/api/thread/open', { method: 'POST', cookie, body: { viewId, threadId: 't' } });
  await waitCall(f.peer, 'thread/resume'); const head = resumeFixture('t', [{ id: 'turn', status: 'completed', items: [], itemsView: 'notLoaded' }]); head.itemsBackwardsCursor = 'has-stored-items';
  f.peer.replyTo('thread/resume', head);
  const read = await waitCall(f.peer, 'thread/items/list'); assert.deepEqual(read.params, { threadId: 't', limit: 20, sortDirection: 'desc' });
  const answer = message('answer', 'Latest final reply');
  f.peer.replyTo('thread/items/list', { data: [answer, { id: 'tool', type: 'commandExecution', command: 'pwd', aggregatedOutput: '/project' }, { id: 'reason', type: 'reasoning', summary: ['Public reasoning'] }].map(item => ({ turnId: 'turn', item })), nextCursor: 'native-older' });
  f.peer.notify('item/agentMessage/delta', { threadId: 't', turnId: 'turn', itemId: 'answer', delta: ' after checkpoint' });
  const response = await opening; assert.equal(response.status, 200); assert.equal(response.json.snapshot.historyKind, 'items');
  assert.equal(response.json.snapshot.initialTurnsPage.nextCursor, 'native-older'); assert.ok(response.text.length < 100_000);
  assert.deepEqual(response.json.snapshot.initialTurnsPage.data[0].items.map(item => item.id), ['reason', 'tool', 'answer']);
  assert.equal(response.json.snapshot.transcript.items.find(item => item.id === 'answer').text, 'Latest final reply');
  await delay(130); assert.match(stream.text(), /after checkpoint/); stream.req.destroy();
});

test('a huge individual tool output cannot expand history replies without bound', async t => {
  const f = await httpsFixture(); t.after(() => f.close()); const cookie = await f.login(), viewId = await f.view(cookie);
  const opening = f.request('/api/thread/open', { method: 'POST', cookie, body: { viewId, threadId: 't' } });
  await waitCall(f.peer, 'thread/resume'); const head = resumeFixture('t'); head.itemsBackwardsCursor = 'items'; f.peer.replyTo('thread/resume', head);
  await waitCall(f.peer, 'thread/items/list'); f.peer.replyTo('thread/items/list', { data: [{ turnId: 'turn', item: { id: 'large-tool', type: 'mcpToolCall', server: 's', tool: 'tool', result: { content: [{ type: 'text', text: 'large-output'.repeat(400_000) }] } } }], nextCursor: null });
  const response = await opening; assert.equal(response.status, 200); assert.ok(response.text.length < 500_000);
  assert.equal(response.json.snapshot.initialTurnsPage.data[0].items[0]._historyTruncated, true);
  assert.match(response.json.snapshot.transcript.items[0].label, /部分/);
});

test('initial item snapshots preserve requests context usage and errors received while loading', async t => {
  const f = await httpsFixture(); t.after(() => f.close()); const cookie = await f.login(), viewId = await f.view(cookie);
  const opening = f.request('/api/thread/open', { method: 'POST', cookie, body: { viewId, threadId: 't' } });
  await waitCall(f.peer, 'thread/resume'); const head = resumeFixture('t'); head.itemsBackwardsCursor = 'items'; f.peer.replyTo('thread/resume', head); await waitCall(f.peer, 'thread/items/list');
  f.peer.notify('thread/tokenUsage/updated', { threadId: 't', tokenUsage: { last: { totalTokens: 99 }, total: { totalTokens: 999 }, modelContextWindow: 1000 } });
  f.peer.request('question', 'item/tool/requestUserInput', { threadId: 't', turnId: 'turn', itemId: 'question', questions: [] });
  f.peer.notify('error', { threadId: 't', error: { message: 'Visible native failure' }, willRetry: false });
  f.peer.replyTo('thread/items/list', { data: [{ turnId: 'turn', item: message('answer', 'reply') }], nextCursor: null });
  const response = await opening; assert.equal(response.status, 200);
  const state = createChatState('t'); installSnapshot(state, response.json);
  assert.equal(state.requests.size, 1); assert.equal(state.tokenUsage.last.totalTokens, 99); assert.equal(state.error, 'Visible native failure');
});

test('opening mid-stream preserves materialized messages and deltas absent from durable item pages', async t => {
  for (const withDelta of [false, true]) await t.test(withDelta ? 'delta during page read' : 'materialized summary message', async t => {
    const f = await httpsFixture(); t.after(() => f.close()); const cookie = await f.login(), viewId = await f.view(cookie);
    const opening = f.request('/api/thread/open', { method: 'POST', cookie, body: { viewId, threadId: 't' } });
    await waitCall(f.peer, 'thread/resume'); const head = resumeFixture('t', [{ id: 'active', status: 'inProgress', itemsView: 'summary', items: [message('stream', 'Existing prefix')] }]); head.itemsBackwardsCursor = 'items';
    f.peer.replyTo('thread/resume', head); await waitCall(f.peer, 'thread/items/list');
    if (withDelta) f.peer.notify('item/agentMessage/delta', { threadId: 't', turnId: 'active', itemId: 'stream', delta: ' and live delta' });
    f.peer.replyTo('thread/items/list', { data: [{ turnId: 'previous', item: message('old', 'Previous durable reply') }], nextCursor: null });
    const response = await opening; assert.equal(response.status, 200);
    const state = createChatState('t'); installSnapshot(state, response.json);
    assert.equal(state.turns.find(turn => turn.id === 'active').items.find(item => item.id === 'stream').text, 'Existing prefix' + (withDelta ? ' and live delta' : ''));
    assert.equal(state.turns.find(turn => turn.id === 'active').status, 'inProgress');
  });
});

test('summary resync preserves an already observed unfinished item until completion supplies its full text', () => {
  const state = createChatState('t'), head = snapshot([], null); head.initialTurnsPage.data[0].status = 'inProgress';
  installSnapshot(state, { snapshot: head, cursor: checkpoint(1) });
  applyNativeEvent(state, { kind: 'notification', cursor: checkpoint(2), native: { method: 'item/agentMessage/delta', params: { threadId: 't', turnId: 'turn', itemId: 'stream', delta: 'Observed prefix' } } });
  installSnapshot(state, { snapshot: head, cursor: checkpoint(3) });
  assert.equal(state.turns[0].items[0].text, 'Observed prefix');
  const completed = snapshot([message('stream', 'Complete authoritative reply')], null);
  installSnapshot(state, { snapshot: completed, cursor: checkpoint(4) });
  assert.equal(state.turns[0].items[0].text, 'Complete authoritative reply'); assert.equal(state.turns[0].items.length, 1);
});

test('a buffered completion prevents an omitted old partial from surviving a newer summary', () => {
  const state = createChatState('t'), head = snapshot([], null); head.initialTurnsPage.data[0].status = 'inProgress';
  installSnapshot(state, { snapshot: head, cursor: checkpoint(1) });
  applyNativeEvent(state, { kind: 'notification', cursor: checkpoint(2), native: { method: 'item/agentMessage/delta', params: { threadId: 't', turnId: 'turn', itemId: 'stream', delta: 'Old partial' } } });
  state.ready = false;
  applyNativeEvent(state, { kind: 'notification', cursor: checkpoint(3), native: { method: 'item/completed', params: { threadId: 't', turnId: 'turn', item: message('stream', 'Completed reply') } } });
  const next = snapshot([message('later', 'Later reply')], null); next.initialTurnsPage.data[0].status = 'inProgress';
  installSnapshot(state, { snapshot: next, cursor: checkpoint(5) });
  assert.deepEqual(state.turns[0].items.map(item => item.id), ['later']);
});

test('a delta received before the metadata resume reply survives opening an unfinished turn', async t => {
  const f = await httpsFixture(); t.after(() => f.close()); const cookie = await f.login(), viewId = await f.view(cookie);
  const opening = f.request('/api/thread/open', { method: 'POST', cookie, body: { viewId, threadId: 't' } });
  await waitCall(f.peer, 'thread/resume');
  f.peer.notify('item/agentMessage/delta', { threadId: 't', turnId: 'active', itemId: 'stream', delta: 'Observed before metadata' });
  const head = resumeFixture('t', [{ id: 'active', status: 'inProgress', items: [] }]); head.itemsBackwardsCursor = 'items'; f.peer.replyTo('thread/resume', head);
  await waitCall(f.peer, 'thread/items/list'); f.peer.replyTo('thread/items/list', { data: [], nextCursor: null });
  const response = await opening; assert.equal(response.status, 200);
  assert.equal(response.json.snapshot.initialTurnsPage.data.find(turn => turn.id === 'active').items[0]?.text, 'Observed before metadata');
});

test('legacy conversations hydrate a safe summary turn page instead of an unsupported item read', async t => {
  const f = await httpsFixture(); t.after(() => f.close()); const cookie = await f.login(), viewId = await f.view(cookie);
  const opening = f.request('/api/thread/open', { method: 'POST', cookie, body: { viewId, threadId: 't' } });
  await waitCall(f.peer, 'thread/resume'); const head = resumeFixture('t'); head.thread.historyMode = 'legacy'; head.initialTurnsPage = null; f.peer.replyTo('thread/resume', head);
  const call = await waitCall(f.peer, 'thread/turns/list'); assert.equal(call.params.itemsView, 'summary');
  f.peer.replyTo('thread/turns/list', { data: [{ id: 'legacy-turn', status: 'completed', items: [message('legacy', 'Legacy reply')] }], nextCursor: 'older-turns' });
  const response = await opening; assert.equal(response.status, 200); assert.equal(response.json.snapshot.historyKind, 'turns');
  assert.equal(response.json.snapshot.initialTurnsPage.data[0].items[0].text, 'Legacy reply');
  assert.equal(f.peer.sent.some(call => call.method === 'thread/items/list'), false);
});

test('legacy export pages summary turns without calling the unsupported item API', async t => {
  const f = await httpsFixture(); t.after(() => f.close()); const cookie = await f.login();
  const exporting = f.request('/api/thread/export?threadId=t', { cookie });
  await waitCall(f.peer, 'thread/read'); f.peer.replyTo('thread/read', { thread: { id: 't', historyMode: 'legacy' } });
  const call = await waitCall(f.peer, 'thread/turns/list'); assert.equal(call.params.itemsView, 'summary');
  f.peer.replyTo('thread/turns/list', { data: [{ id: 'legacy-turn', status: 'completed', items: [message('legacy', 'Legacy export')] }], nextCursor: null });
  const response = await exporting; assert.equal(response.status, 200); assert.match(response.text, /Legacy export/);
  assert.equal(f.peer.sent.some(call => call.method === 'thread/items/list'), false);
});

test('large chat text stays complete over HTTPS without a competing SSE snapshot checkpoint', async t => {
  const f = await httpsFixture(); t.after(() => f.close()); const cookie = await f.login(), viewId = await f.view(cookie), stream = await f.events(cookie, viewId);
  const opening = f.request('/api/thread/open', { method: 'POST', cookie, body: { viewId, threadId: 't' } });
  await waitCall(f.peer, 'thread/resume'); const head = resumeFixture('t'); head.itemsBackwardsCursor = 'items'; f.peer.replyTo('thread/resume', head); await waitCall(f.peer, 'thread/items/list');
  const text = 'Complete chat text. '.repeat(20_000);
  f.peer.replyTo('thread/items/list', { data: [{ turnId: 'turn', item: message('answer', text) }], nextCursor: null });
  const response = await opening; assert.equal(response.status, 200); assert.equal(response.json.snapshot.initialTurnsPage.data[0].items[0].text, text);
  assert.doesNotMatch(stream.text(), /"kind":"(?:snapshot|checkpoint)"/); stream.req.destroy();
});

test('older item pages validate their cursor and require the current owner view before native access', async t => {
  const f = await httpsFixture(); t.after(() => f.close()); const cookie = await f.login(), viewId = await f.view(cookie), other = await f.login();
  const body = { viewId, threadId: 't', cursor: 'older-items' }, before = f.peer.sent.length;
  assert.equal((await f.request('/api/thread/history', { method: 'POST', cookie: other, body })).status, 403);
  assert.equal((await f.request('/api/thread/history', { method: 'POST', cookie, body })).status, 403);
  for (const change of [{ cursor: '' }, { cursor: 12 }, { cursor: 'bad\0cursor' }, { threadId: '../t' }, { limit: 100 }]) {
    assert.equal((await f.request('/api/thread/history', { method: 'POST', cookie, body: { ...body, ...change } })).status, 400);
  }
  assert.equal(f.peer.sent.length, before);
});

test('item pages merge within the same turn and late SSE cannot duplicate the historical item', () => {
  const state = createChatState('t'); installSnapshot(state, { snapshot: snapshot([message('latest', 'latest')]), cursor: checkpoint(2) });
  prependHistory(state, { data: [{ id: 'turn', items: [message('older', 'authoritative')] }], nextCursor: null }, checkpoint(10));
  assert.deepEqual(state.turns[0].items.map(item => item.id), ['older', 'latest']);
  applyNativeEvent(state, { kind: 'notification', cursor: checkpoint(5), native: { method: 'item/agentMessage/delta', params: { threadId: 't', turnId: 'turn', itemId: 'older', delta: ' duplicate' } } });
  assert.equal(state.turns[0].items[0].text, 'authoritative');
  applyNativeEvent(state, { kind: 'notification', cursor: checkpoint(11), native: { method: 'item/agentMessage/delta', params: { threadId: 't', turnId: 'turn', itemId: 'older', delta: ' newer' } } });
  assert.equal(state.turns[0].items[0].text, 'authoritative newer');
});

test('file enrichment arriving before its HTTPS snapshot is retained at the same checkpoint', () => {
  const state = createChatState('t'), cursor = checkpoint(10);
  const rendered = { id: 'answer', text: 'file reply', html: '<p>file reply</p>', files: [{ href: '/api/files/example' }], cursor };
  applyNativeEvent(state, { kind: 'render', cursor, native: { threadId: 't', items: [rendered] } });
  installSnapshot(state, { snapshot: snapshot([message('answer', 'file reply')]), cursor });
  assert.deepEqual(state.turns[0].items[0]._presentation.files, rendered.files);
});

test('upward scroll loads one older item page and retains the reading position and draft', async t => {
  const dom = domFixture(), calls = []; let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const api = async (path, body) => {
    if (path === '/api/thread/open') return { snapshot: snapshot([message('latest', 'latest')]), cursor: checkpoint(2) };
    if (path === '/api/thread/history') { calls.push(body); await gate; return { snapshot: snapshot([message('older', 'older')], null), cursor: checkpoint(10) }; }
    return { result: { data: [], nextCursor: null } };
  };
  const chat = mountChat({ api, viewId: 'view', uploadLimitBytes: 32 }); chat.connection(true); t.after(() => { chat.dispose(); dom.restore(); }); await chat.open('t'); chat.getState().draft = 'keep draft';
  const feed = dom.get('chat-feed'); feed.scrollHeight = 1000; feed.clientHeight = 200; feed.scrollTop = 800; dom.event('chat-feed', 'scroll');
  const insert = dom.get('messages').insertBefore.bind(dom.get('messages')); dom.get('messages').insertBefore = (...args) => { feed.scrollHeight += 100; insert(...args); };
  feed.scrollTop = 40; dom.event('chat-feed', 'scroll'); dom.event('chat-feed', 'wheel', { deltaY: -100 }); await delay(0);
  assert.deepEqual(calls, [{ viewId: 'view', threadId: 't', cursor: 'older-items' }]); assert.equal(dom.get('older-history').disabled, true);
  finish(); await delay(0); assert.equal(feed.scrollTop, 140); assert.equal(chat.getState().draft, 'keep draft');
  assert.deepEqual(chat.getState().turns[0].items.map(item => item.id), ['older', 'latest']); assert.equal(dom.get('older-history').hidden, true);
});

test('an older-page failure after switching conversations cannot replace the new conversation or error state', async t => {
  const dom = domFixture(); let fail;
  const gate = new Promise((_resolve, reject) => { fail = reject; });
  const api = async (path, body) => {
    if (path === '/api/thread/open') { const value = snapshot([message('latest', 'latest')]); value.thread.id = body.threadId; return { snapshot: value, cursor: checkpoint(2) }; }
    if (path === '/api/thread/history') return gate;
    return { result: { data: [], nextCursor: null } };
  };
  const chat = mountChat({ api, viewId: 'view', uploadLimitBytes: 32 }); chat.connection(true); t.after(() => { chat.dispose(); dom.restore(); }); await chat.open('t');
  dom.get('older-history').click(); await delay(0); await chat.open('new'); chat.getState().draft = 'new draft';
  fail(Error('Old page failed')); await delay(0);
  assert.equal(chat.getState().threadId, 'new'); assert.equal(chat.getState().draft, 'new draft'); assert.equal(dom.get('chat-error').textContent, '');
});
