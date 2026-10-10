import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createCodexClient } from '../codex.mjs';
import { connectedFixture, resumeFixture } from './helpers.mjs';

test('only configured loopback WebSocket endpoints can be used', () => {
  for (const url of ['ws://evil.test:4500', 'wss://127.0.0.1:4500',
    'ws://127.0.0.1:4500/path', 'ws://user:secret@127.0.0.1:4500',
    'ws://127.0.0.1:4500/?token=secret', 'ws://127.0.0.1:0']) {
    assert.throws(() => createCodexClient({ url }), { code: 'INVALID_BACKEND_URL' });
  }
});

test('an unexpected native home is never initialized for actions', async t => {
  const { client, peer } = await connectedFixture({ expectedHome: '/another-native-home' }); t.after(() => client.close());
  assert.equal(client.status().online, false); assert.equal(peer.sent.some(message => message.method === 'initialized'), false);
  await assert.rejects(client.rpc('thread/start', {}), { outcome: 'not-sent' });
});

test('native initialization precedes calls and out-of-order replies remain correlated', async t => {
  const { client, peer, flush } = await connectedFixture();
  t.after(() => client.close());
  assert.equal(client.status().online, true);
  const init = peer.sent[0];
  assert.equal(init.method, 'initialize');
  assert.equal(init.params.capabilities.experimentalApi, true);
  assert.notEqual(init.params.capabilities.requestAttestation, true);
  assert.equal(peer.sent[1].method, 'initialized');
  const models = client.rpc('model/list', {});
  const account = client.rpc('account/read', { refreshToken: false });
  await flush();
  peer.replyTo('account/read', { account: null, requiresOpenaiAuth: true });
  peer.replyTo('model/list', { data: [], nextCursor: null });
  assert.deepEqual((await models).result, { data: [], nextCursor: null });
  assert.deepEqual((await account).result, { account: null, requiresOpenaiAuth: true });
  assert.equal('jsonrpc' in peer.sent[0], false);
});

test('native errors preserve their code and data instead of becoming transport failures', async t => {
  const { client, peer, flush } = await connectedFixture();
  t.after(() => client.close());
  const result = client.rpc('thread/start', {});
  const failure = assert.rejects(result, { code: -32600, message: 'Policy denied', data: { policy: 'managed' } });
  await flush();
  peer.errorTo('thread/start', { code: -32600, message: 'Policy denied', data: { policy: 'managed' } });
  await failure;
  assert.equal(client.status().online, true);
});

test('notifications and numeric-zero server requests reach different handlers; answers consume once', async t => {
  const { client, peer } = await connectedFixture();
  t.after(() => client.close());
  const events = [];
  client.onEvent(e => events.push(e));
  peer.notify('thread/tokenUsage/updated', { threadId: 't', turnId: 'v', tokenUsage: { last: { totalTokens: 10 }, total: { totalTokens: 20 }, modelContextWindow: 100000 } });
  peer.request(0, 'item/tool/requestUserInput', { threadId: 't', turnId: 'v', itemId: 'i', questions: [] });
  assert.equal(events[0].kind, 'notification');
  assert.equal(events[1].kind, 'request');
  await client.respond(events[1].requestKey, { id: 'forged', method: 'thread/delete', result: { answers: {} } });
  assert.deepEqual(peer.sent.at(-1), { id: 0, result: { answers: {} } });
  await assert.rejects(client.respond(events[1].requestKey, { result: {} }), { code: 'STALE_NATIVE_REQUEST' });
});

test('resume_checkpoint_orders_snapshot_and_deltas before promise callbacks', async t => {
  const { client, peer } = await connectedFixture();
  t.after(() => client.close());
  const events = [];
  client.onEvent(e => events.push(e));
  const pending = client.retainThread('t', 'view-1');
  peer.notify('item/agentMessage/delta', { threadId: 't', turnId: 'turn-1', itemId: 'a', delta: 'before' });
  peer.replyTo('thread/resume', resumeFixture('t', [{ id: 'turn-1', status: 'inProgress', items: [], error: null }]));
  peer.notify('item/agentMessage/delta', { threadId: 't', turnId: 'turn-1', itemId: 'a', delta: 'after' });
  const response = await pending;
  assert.deepEqual(events.map(e => e.kind), ['notification', 'snapshot', 'notification']);
  assert.deepEqual(response.cursor, events[1].cursor);
  assert.equal(response.result.thread.id, 't');
  assert.ok(events[0].cursor.seq < response.cursor.seq);
  assert.ok(events[2].cursor.seq > response.cursor.seq);
  const call = peer.sent.find(m => m.method === 'thread/resume');
  assert.deepEqual(call.params, { threadId: 't', excludeTurns: true, initialTurnsPage: { limit: 20, sortDirection: 'desc', itemsView: 'summary' } });
});

test('active_thread_survives_last_view_close and unsubscribes only after matching completion', async t => {
  const { client, peer, flush } = await connectedFixture();
  t.after(() => client.close());
  const retained = client.retainThread('t', 'view');
  peer.replyTo('thread/resume', resumeFixture('t', [{ id: 'active', status: 'inProgress', items: [], error: null }]));
  await retained;
  await client.releaseThread('t', 'view');
  assert.equal(peer.sent.some(m => m.method === 'thread/unsubscribe'), false);
  assert.equal(client.status().online, true);
  peer.notify('turn/completed', { threadId: 't', turn: { id: 'older', status: 'completed', items: [], error: null } });
  assert.equal(peer.sent.some(m => m.method === 'thread/unsubscribe'), false);
  peer.notify('turn/completed', { threadId: 't', turn: { id: 'active', status: 'completed', items: [], error: null } });
  await flush();
  assert.deepEqual(peer.sent.at(-1).params, { threadId: 't' });
  assert.equal(peer.sent.at(-1).method, 'thread/unsubscribe');
  peer.replyTo('thread/unsubscribe', { status: 'unsubscribed' });
});

test('idle_thread_unsubscribes only when every page has released it', async t => {
  const { client, peer } = await connectedFixture();
  t.after(() => client.close());
  for (const view of ['one', 'two']) {
    const pending = client.retainThread('t', view);
    peer.replyTo('thread/resume', resumeFixture('t'));
    await pending;
  }
  await client.releaseThread('t', 'one');
  assert.equal(peer.sent.some(m => m.method === 'thread/unsubscribe'), false);
  const released = client.releaseThread('t', 'two');
  peer.replyTo('thread/unsubscribe', { status: 'unsubscribed' });
  await released;
  assert.equal(peer.sent.filter(m => m.method === 'thread/unsubscribe').length, 1);
});

test('closing the last page during atomic resume waits to learn whether work is active', async t => {
  const { client, peer, flush } = await connectedFixture();
  t.after(() => client.close());
  const retained = client.retainThread('t', 'view');
  const released = client.releaseThread('t', 'view');
  assert.equal(peer.sent.some(m => m.method === 'thread/unsubscribe'), false);
  peer.replyTo('thread/resume', resumeFixture('t', [{ id: 'active', status: 'inProgress', items: [] }]));
  await retained; await released;
  assert.equal(peer.sent.some(m => m.method === 'thread/unsubscribe'), false);
  peer.notify('turn/completed', { threadId: 't', turn: { id: 'active', status: 'completed', items: [] } });
  await flush(); assert.equal(peer.sent.at(-1).method, 'thread/unsubscribe');
  peer.replyTo('thread/unsubscribe', { status: 'unsubscribed' });
});

test('disconnect marks a sent write unknown, rejects stale answers and never replays writes', async t => {
  const { client, peer } = await connectedFixture();
  t.after(() => client.close());
  const events = [];
  client.onEvent(e => events.push(e));
  peer.request('approval', 'item/fileChange/requestApproval', { threadId: 't', turnId: 'v', itemId: 'i', reason: null, grantRoot: null });
  const requestKey = events.at(-1).requestKey;
  const pending = client.rpc('turn/start', { threadId: 't', input: [] });
  const rejected = assert.rejects(pending, { code: 'NATIVE_DISCONNECTED', outcome: 'unknown' });
  peer.disconnect();
  await rejected;
  await assert.rejects(client.rpc('thread/start', {}), { outcome: 'not-sent' });
  await delay(750);
  assert.equal(client.status().online, true);
  assert.equal(peer.socketCount, 2);
  assert.equal(peer.sent.some(m => m.method === 'turn/start'), false);
  await assert.rejects(client.respond(requestKey, { result: { decision: 'accept' } }), { code: 'STALE_NATIVE_REQUEST' });
});

test('reconnect restores watched atomic snapshots, while a native resolution invalidates an unanswered form', async t => {
  const { client, peer } = await connectedFixture();
  t.after(() => client.close());
  const events = [];
  client.onEvent(e => events.push(e));
  const retained = client.retainThread('t', 'view');
  peer.replyTo('thread/resume', resumeFixture('t'));
  await retained;
  peer.request('q', 'item/tool/requestUserInput', { threadId: 't', questions: [] });
  const key = events.at(-1).requestKey;
  peer.notify('serverRequest/resolved', { threadId: 't', requestId: 'q' });
  await assert.rejects(client.respond(key, { result: { answers: {} } }), { code: 'STALE_NATIVE_REQUEST' });
  peer.disconnect();
  await delay(750);
  assert.equal(peer.sent.at(-1).method, 'thread/resume');
  peer.replyTo('thread/resume', resumeFixture('t'));
  assert.equal(events.at(-1).kind, 'snapshot');
  assert.equal(events.at(-1).cursor.generation, 2);
});

test('a native request that never replies rejects after the real default deadline', { timeout: 35000 }, async t => {
  const { client } = await connectedFixture();
  t.after(() => client.close());
  await assert.rejects(client.rpc('model/list', {}), { code: 'NATIVE_TIMEOUT', outcome: 'unknown' });
});
