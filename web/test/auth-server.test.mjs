import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createAuth, checkOrigin, hashPassword } from '../auth.mjs';
import { httpsFixture } from './helpers.mjs';
import { writeEvent } from '../server.mjs';

test('owner authentication has exact Origin, native scrypt, bounded failures and absolute expiry', async () => {
  assert.throws(() => checkOrigin('https://evil.test', 'https://127.0.0.1:8443'), { code: 'ORIGIN_DENIED' });
  assert.throws(() => checkOrigin(undefined, 'https://127.0.0.1:8443'), { code: 'ORIGIN_DENIED' });
  assert.doesNotThrow(() => checkOrigin('https://127.0.0.1:8443', 'https://127.0.0.1:8443'));
  const passwordHash = await hashPassword('fixture-passphrase');
  const [kind, salt, key] = passwordHash.split(':');
  assert.equal(kind, 'scrypt'); assert.equal(Buffer.from(salt, 'base64').length, 16);
  assert.equal(Buffer.from(key, 'base64').length, 64);
  let now = 1000;
  const auth = createAuth({ passwordHash, now: () => now });
  for (let i = 0; i < 5; i++) await assert.rejects(auth.login('bad', 'ip-1'), { code: 'LOGIN_DENIED' });
  await assert.rejects(auth.login('fixture-passphrase', 'ip-1'), { code: 'LOGIN_THROTTLED' });
  now += 60_001;
  const { token, expiresAt } = await auth.login('fixture-passphrase', 'ip-1');
  assert.equal(Buffer.from(token, 'base64url').length, 32);
  assert.ok(auth.verifySession(token));
  now = expiresAt; assert.equal(auth.verifySession(token), null);
  await assert.rejects(hashPassword('x'.repeat(257)), { code: 'INVALID_PASSWORD' });
});

test('HTTPS rejects unauthenticated APIs, cross-Origin requests, oversized bodies and unknown RPCs', async t => {
  const f = await httpsFixture(); t.after(() => f.close());
  for (const path of ['/api/status', '/api/events?viewId=missing']) assert.equal((await f.request(path)).status, 401);
  assert.equal((await f.request('/api/login', { method: 'POST', origin: 'https://evil.test', body: { password: 'fixture-passphrase' } })).status, 403);
  assert.equal((await f.request('/api/login', { method: 'POST', origin: null, body: { password: 'fixture-passphrase' } })).status, 403);
  assert.equal((await f.request('/api/login', { method: 'POST', body: JSON.stringify({ password: 'x'.repeat(1_048_576) }) })).status, 413);
  const cookie = await f.login();
  assert.equal((await f.request('/api/status', { cookie })).json.online, true);
  const unknown = await f.request('/api/rpc', { method: 'POST', cookie, body: { method: 'process/exec', params: {} } });
  assert.equal(unknown.status, 403);
  assert.equal(f.peer.sent.some(m => m.method === 'process/exec'), false);
  assert.equal((await f.request('/api/rpc', { method: 'POST', cookie, body: { method: 'thread/start', params: {} } })).status, 403);
  assert.equal((await f.request('/api/view', { method: 'POST', cookie, origin: 'https://evil.test', body: {} })).status, 403);
  assert.deepEqual(await f.preferences(), { archivedProjectIds: [], ui: {} });
});

test('login sets an absolute secure cookie and views belong to one session', async t => {
  const f = await httpsFixture(); t.after(() => f.close());
  const login = await f.request('/api/login', { method: 'POST', body: { password: 'fixture-passphrase' } });
  const header = login.headers['set-cookie'][0];
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', 'Max-Age=43200']) assert.ok(header.includes(flag));
  assert.equal(login.headers['access-control-allow-origin'], undefined);
  const one = header.split(';')[0], two = await f.login(), view = await f.view(one);
  assert.equal((await f.request('/api/events?viewId=' + view, { cookie: two })).status, 403);
  assert.equal((await f.request('/api/request/respond', { method: 'POST', cookie: two, body: { viewId: view, requestKey: 'q', answer: { result: {} } } })).status, 403);
});

test('fixed reads validate params, filter credentials and native secret requests never reach SSE', async t => {
  const f = await httpsFixture(); t.after(() => f.close());
  const cookie = await f.login(), view = await f.view(cookie), stream = await f.events(cookie, view);
  const pending = f.request('/api/rpc', { method: 'POST', cookie, body: { method: 'account/read', params: { refreshToken: false } } });
  await delay(20);
  f.peer.replyTo('account/read', { account: { type: 'chatgpt', accessToken: 'DO_NOT_EXPOSE', refreshToken: 'ALSO_PRIVATE', planType: 'plus' }, requiresOpenaiAuth: true });
  const response = await pending;
  assert.equal(response.status, 200); assert.equal(JSON.stringify(response.json).includes('DO_NOT_EXPOSE'), false);
  assert.equal((await f.request('/api/rpc', { method: 'POST', cookie, body: { method: 'account/read', params: { refreshToken: true } } })).status, 400);
  f.peer.request('secret', 'account/chatgptAuthTokens/refresh', { refreshToken: 'SSE_PRIVATE' });
  await delay(25);
  assert.equal(stream.text().includes('SSE_PRIVATE'), false);
  assert.deepEqual(f.peer.sent.at(-1), { id: 'secret', error: { code: -32601, message: 'Unsupported by this browser client.' } });
  assert.match(stream.text(), /"kind":"resync"/);
  stream.req.destroy();
});

test('two_pages_cannot_answer_one_request_twice and native responses preserve original ID', async t => {
  const f = await httpsFixture(); t.after(() => f.close());
  const cookie = await f.login(), v1 = await f.view(cookie), v2 = await f.view(cookie);
  const s1 = await f.events(cookie, v1), s2 = await f.events(cookie, v2);
  f.peer.request(0, 'item/fileChange/requestApproval', { threadId: 't', turnId: 'v', itemId: 'i', reason: 'Test', grantRoot: null });
  await delay(20);
  const event = s1.text().split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6))).find(e => e.kind === 'request');
  assert.ok(event); assert.ok(s2.text().includes(event.requestKey));
  const body = viewId => ({ viewId, requestKey: event.requestKey, answer: { result: { decision: 'accept' } } });
  const responses = await Promise.all([f.request('/api/request/respond', { method: 'POST', cookie, body: body(v1) }), f.request('/api/request/respond', { method: 'POST', cookie, body: body(v2) })]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  assert.equal(f.peer.sent.filter(m => m.id === 0).length, 1);
  s1.req.destroy(); s2.req.destroy();
});

test('permission forms cannot grant more than the native request', async t => {
  const f = await httpsFixture(); t.after(() => f.close());
  const cookie = await f.login(), viewId = await f.view(cookie), stream = await f.events(cookie, viewId);
  f.peer.request('p', 'item/permissions/requestApproval', { threadId: 't', turnId: 'v', itemId: 'i', permissions: { network: { enabled: true } } });
  await delay(20);
  const event = stream.text().split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6))).find(e => e.kind === 'request');
  const result = await f.request('/api/request/respond', { method: 'POST', cookie, body: { viewId, requestKey: event.requestKey,
    answer: { result: { permissions: { network: { enabled: true }, fileSystem: { write: ['/'] } }, scope: 'session' } } } });
  assert.equal(result.status, 400);
  assert.equal(f.peer.sent.some(m => m.id === 'p'), false);
  stream.req.destroy();
});

test('logout_closes_only_that_sessions_streams and a new stream demands snapshot', async t => {
  const f = await httpsFixture(); t.after(() => f.close());
  const c1 = await f.login(), c2 = await f.login();
  const s1 = await f.events(c1, await f.view(c1)), s2 = await f.events(c2, await f.view(c2));
  const r = await f.request('/api/logout', { method: 'POST', cookie: c1, body: {} });
  assert.equal(r.status, 200); assert.match(r.headers['set-cookie'][0], /Max-Age=0/);
  await s1.closed;
  assert.equal((await f.request('/api/status', { cookie: c1 })).status, 401);
  assert.equal(s2.res.destroyed, false);
  assert.equal((await f.request('/api/status', { cookie: c2 })).status, 200);
  s2.req.destroy();
});

test('slow SSE readers are disconnected without blocking a healthy page', async t => {
  const f = await httpsFixture(); t.after(() => f.close());
  const cookie = await f.login(), slow = await f.events(cookie, await f.view(cookie), true);
  const healthy = await f.events(cookie, await f.view(cookie));
  // Give the healthy TCP reader time to drain, while the paused one fills its bounded queue.
  for (let i = 0; i < 200 && !f.eventResponses[0].destroyed; i++) {
    f.peer.notify('item/agentMessage/delta', { threadId: 't', turnId: 'v', itemId: 'a', delta: 'x'.repeat(100_000) });
    await delay(3);
  }
  await delay(25);
  assert.equal(f.eventResponses[0].destroyed, true);
  assert.equal(f.eventResponses[1].destroyed, false);
  f.peer.notify('thread/name/updated', { threadId: 't', threadName: 'healthy-reader-marker' });
  await delay(20);
  assert.match(healthy.text(), /healthy-reader-marker/);
  assert.equal((await f.request('/api/status', { cookie })).status, 200);
  slow.req.destroy(); healthy.req.destroy();
});

test('SSE cap includes already queued bytes and never writes an oversized frame', () => {
  let destroyed = false, writes = 0;
  const res = { destroyed: false, writableLength: 1_048_570, destroy() { destroyed = true; }, write() { writes++; } };
  assert.equal(writeEvent(res, { cursor: { generation: 1, seq: 1 }, kind: 'notification', native: {} }), false);
  assert.equal(destroyed, true); assert.equal(writes, 0);
});
