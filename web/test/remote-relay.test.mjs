import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createRemoteRelay } from '../remote-relay.mjs';
import { createCodexClient } from '../codex.mjs';
import { fixture } from './remote-controller-fixture.mjs';
import { relayPeer } from './relay-peer.mjs';

async function waitFor(check, milliseconds = 3000) {
  const deadline = Date.now() + milliseconds;
  while (!check()) { if (Date.now() > deadline) assert.fail('Relay condition did not become true'); await delay(5); }
}
async function setup(t, options = {}) {
  const f = await fixture(t); await f.authorize();
  const session = await f.controller.session();
  const peer = await relayPeer(t, { session, key: f.keys.get(session.enrollment.keyId).publicKey, ...options });
  const relay = createRemoteRelay({ controller: f.controller, openWebSocket: peer.openWebSocket });
  t.after(() => relay.close());
  return { ...f, peer, relay, session };
}

test('one authenticated relay carries independent native clients with colliding RPC and approval IDs', async t => {
  const f = await setup(t), events = { a: [], b: [] };
  f.peer.onMessage(packet => {
    if (packet.type !== 'client_message' || !packet.message.method) return;
    const m = packet.message;
    if (m.method === 'initialize') f.peer.reply(packet, { id: m.id, result: { codexHome: '/different-host-home', platformFamily: 'unix', platformOs: 'linux' } });
    else if (m.method !== 'initialized') f.peer.reply(packet, { id: m.id, result: { host: packet.env_id } });
  });
  const a = createCodexClient({ socketFactory: () => f.relay.openHost('host-a') });
  const b = createCodexClient({ socketFactory: () => f.relay.openHost('host-b') });
  t.after(() => { a.close(); b.close(); });
  a.onEvent(event => events.a.push(event)); b.onEvent(event => events.b.push(event));
  await waitFor(() => a.status().online && b.status().online);
  const [ar, br] = await Promise.all([a.rpc('model/list', {}), b.rpc('model/list', {})]);
  assert.equal(ar.result.host, 'host-a'); assert.equal(br.result.host, 'host-b');
  assert.equal(f.peer.headers.length, 1); assert.equal(f.peer.proofCount, 1);
  assert.equal(f.peer.headers[0]['x-codex-client-id'], 'server-created-client');
  assert.equal(f.peer.headers[0]['x-codex-protocol-version'], '3');
  assert.equal(f.peer.headers[0]['x-codex-client-session-token'], 'Bearer fixture-relay-token-1');
  assert.match(f.peer.headers[0].authorization, /^Bearer e30\./);
  const ap = f.peer.messages.find(p => p.env_id === 'host-a' && p.message?.method === 'model/list');
  const bp = f.peer.messages.find(p => p.env_id === 'host-b' && p.message?.method === 'model/list');
  assert.equal(ap.message.id, bp.message.id);
  f.peer.reply(ap, { id: 7, method: 'item/commandExecution/requestApproval', params: { threadId: 'same-thread' } });
  f.peer.reply(bp, { id: 7, method: 'item/commandExecution/requestApproval', params: { threadId: 'same-thread' } });
  await waitFor(() => events.a.some(e => e.kind === 'request') && events.b.some(e => e.kind === 'request'));
  await a.respond(events.a.find(e => e.kind === 'request').requestKey, { result: { decision: 'accept' } });
  await b.respond(events.b.find(e => e.kind === 'request').requestKey, { result: { decision: 'decline' } });
  await waitFor(() => f.peer.messages.filter(p => p.message?.id === 7 && !p.message.method).length === 2);
  const answers = f.peer.messages.filter(p => p.message?.id === 7 && !p.message.method);
  assert.equal(answers.find(p => p.env_id === 'host-a').message.result.decision, 'accept');
  assert.equal(answers.find(p => p.env_id === 'host-b').message.result.decision, 'decline');
});

test('a mismatched device challenge cannot open a host stream or send an RPC', async t => {
  const f = await setup(t, { challenge: { targetOrigin: 'https://example.com' } });
  const socket = f.relay.openHost('host-a');
  await waitFor(() => socket.readyState === 3);
  assert.equal(f.peer.proofCount, 0);
  assert.equal(f.peer.messages.length, 0);
});

test('duplicate messages and a foreign host stream cannot deliver another host’s events', async t => {
  const f = await setup(t), socket = f.relay.openHost('host-a'), received = [];
  socket.addEventListener('message', e => received.push(JSON.parse(e.data)));
  await waitFor(() => socket.readyState === 1);
  socket.send('{"id":"request-one","method":"test","params":{}}');
  await waitFor(() => f.peer.messages.some(p => p.message?.id === 'request-one'));
  const request = f.peer.messages.find(p => p.message?.id === 'request-one');
  const event = { type: 'server_message', client_id: 'server-created-client', env_id: 'host-a', stream_id: request.stream_id,
    seq_id: 0, message: { method: 'thread/name/updated', params: { threadId: 'same-thread', name: 'Host A' } } };
  f.peer.send({ ...event, env_id: 'host-b' }); f.peer.send(event); f.peer.send(event);
  await waitFor(() => received.length === 1);
  assert.equal(received[0].params.name, 'Host A');
});

test('UTF-8 chunks reassemble once and oversized chunk metadata closes only that stream', async t => {
  const f = await setup(t), a = f.relay.openHost('host-a'), b = f.relay.openHost('host-b'), received = [];
  a.addEventListener('message', e => received.push(JSON.parse(e.data)));
  await waitFor(() => a.readyState === 1 && b.readyState === 1);
  a.send('{"method":"test"}'); b.send('{"method":"test"}');
  await waitFor(() => f.peer.messages.filter(p => p.type === 'client_message').length === 2);
  const request = f.peer.messages.find(p => p.env_id === 'host-a' && p.type === 'client_message');
  const data = Buffer.from('{"method":"test/event","params":{"text":"你好"}}');
  const split = data.indexOf(Buffer.from('你')) + 1;
  const chunks = [data.subarray(0, split), data.subarray(split)];
  for (let i = 0; i < 2; ++i) f.peer.send({ type: 'server_message_chunk', client_id: 'server-created-client', env_id: 'host-a', stream_id: request.stream_id,
    seq_id: 0, segment_id: i, segment_count: 2, message_size_bytes: data.length, message_chunk_base64: chunks[i].toString('base64') });
  await waitFor(() => received.length === 1);
  assert.equal(received[0].params.text, '你好');
  f.peer.send({ type: 'server_message_chunk', client_id: 'server-created-client', env_id: 'host-a', stream_id: request.stream_id,
    seq_id: 1, segment_id: 0, segment_count: 1_000_000, message_size_bytes: 1_000_000_000, message_chunk_base64: 'e30=' });
  await waitFor(() => a.readyState === 3);
  assert.equal(b.readyState, 1);
});

test('large outgoing JSON is sent as bounded protocol chunks without splitting UTF-8 data incorrectly', async t => {
  const f = await setup(t), socket = f.relay.openHost('host-a');
  await waitFor(() => socket.readyState === 1);
  const text = '你'.repeat(50_000);
  socket.send(JSON.stringify({ id: 'large-input', method: 'turn/start', params: { text } }));
  await waitFor(() => f.peer.messages.some(p => p.type === 'client_message_chunk'));
  await waitFor(() => {
    const chunks = f.peer.messages.filter(p => p.type === 'client_message_chunk'); return chunks.length === chunks[0]?.segment_count;
  });
  const chunks = f.peer.messages.filter(p => p.type === 'client_message_chunk');
  assert(chunks.length >= 2);
  assert(chunks.every(p => Buffer.byteLength(JSON.stringify(p)) <= 153_600));
  assert.equal(JSON.parse(Buffer.concat(chunks.map(p => Buffer.from(p.message_chunk_base64, 'base64')))).params.text, text);
});

test('a sequence gap closes its host while a wrong controller identity closes the whole relay', async t => {
  const f = await setup(t), a = f.relay.openHost('host-a'), b = f.relay.openHost('host-b');
  await waitFor(() => a.readyState === 1 && b.readyState === 1);
  a.send('{"method":"test"}'); b.send('{"method":"test"}');
  await waitFor(() => f.peer.messages.filter(p => p.type === 'client_message').length === 2);
  const requestA = f.peer.messages.find(p => p.env_id === 'host-a'), requestB = f.peer.messages.find(p => p.env_id === 'host-b');
  const packet = { type: 'server_message', client_id: 'server-created-client', env_id: 'host-a', stream_id: requestA.stream_id,
    seq_id: 0, message: { method: 'test/event' } };
  f.peer.send(packet); f.peer.send({ ...packet, seq_id: 2 });
  await waitFor(() => a.readyState === 3);
  assert.equal(b.readyState, 1);
  f.peer.send({ ...packet, env_id: 'host-b', stream_id: requestB.stream_id, client_id: 'different-controller' });
  await waitFor(() => b.readyState === 3);
});

test('connection loss reports an unknown mutation outcome and reconnect initializes a fresh stream without replaying it', async t => {
  const f = await setup(t);
  f.peer.onMessage(p => { if (p.message?.method === 'initialize') f.peer.reply(p, { id: p.message.id, result: {} }); });
  const client = createCodexClient({ socketFactory: () => f.relay.openHost('host-a') });
  t.after(() => client.close());
  await waitFor(() => client.status().online);
  const original = f.peer.messages.find(p => p.message?.method === 'initialize').stream_id;
  const mutation = client.rpc('turn/start', { threadId: 'same-thread', input: [] });
  const failed = assert.rejects(mutation, error => error.code === 'NATIVE_DISCONNECTED' && error.outcome === 'unknown');
  await waitFor(() => f.peer.messages.some(p => p.message?.method === 'turn/start'));
  f.peer.disconnect(); await failed;
  await waitFor(() => f.peer.headers.length === 2 && client.status().online);
  const initializations = f.peer.messages.filter(p => p.message?.method === 'initialize');
  assert.notEqual(initializations.at(-1).stream_id, original);
  assert.equal(f.peer.messages.filter(p => p.message?.method === 'turn/start').length, 1);
});
