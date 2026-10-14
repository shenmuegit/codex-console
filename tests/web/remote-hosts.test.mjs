import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuth, hashPassword } from '../../web/auth.mjs';
import { createWebServer } from '../../web/server.mjs';
import { createRemoteHostPool } from '../../web/remote-hosts.mjs';
import { httpsFixture, connectedFixture } from './helpers.mjs';

test('paired hosts share owner login but have isolated native clients and view IDs', async t => {
  const nativeA = await connectedFixture(), nativeB = await connectedFixture();
  t.after(() => { nativeA.client.close(); nativeB.client.close(); });
  const controller = { async status() { return { enrolled: true }; }, async listHosts() { return [
    { id: 'host-a', name: 'Computer A' }, { id: 'host-b', name: 'Computer B' }]; } };
  let pool;
  const sharedAuth = createAuth({ passwordHash: await hashPassword('fixture-passphrase') });
  const f = await httpsFixture({ controller, sharedAuth, routeHost: host => pool.server(host) }); t.after(() => f.close());
  pool = createRemoteHostPool({ config: f.config, sharedAuth, controller,
    createClient: host => host.id === 'host-a' ? nativeA.client : nativeB.client,
    createServer: options => createWebServer(options) });
  t.after(() => pool.close());
  const cookie = await f.login();
  const childA = await pool.server('host-a'), childB = await pool.server('host-b');
  assert.notEqual(childA, childB);
  const request = (path, body) => f.request(path, { method: 'POST', body, cookie });
  const a = await request('/api/view?host=host-a', {}), b = await request('/api/view?host=host-b', {});
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.notEqual(a.json.viewId, b.json.viewId);
  const wrong = await request('/api/request/respond?host=host-b', { viewId: a.json.viewId, requestKey: 'collision', answer: { result: {} } });
  assert.equal(wrong.status, 403);
  await assert.rejects(pool.server('unpaired-host'), { code: 'REMOTE_HOST_NOT_PAIRED' });
});

test('remote host servers inherit browser access config and retain session and host boundaries', async t => {
  const origin = 'https://plugin.example.test', native = await connectedFixture(); t.after(() => native.client.close());
  const controller = { async status() { return { enrolled: true }; }, async listHosts() { return [{ id: 'host-a', name: 'A' }]; } };
  const sharedAuth = createAuth({ passwordHash: await hashPassword('fixture-passphrase') });
  let pool;
  const f = await httpsFixture({ sharedAuth, controller, routeHost: host => pool.server(host),
    configOverrides: { allowedOrigins: [origin], cookieSameSite: 'none' } }); t.after(() => f.close());
  pool = createRemoteHostPool({ config: f.config, sharedAuth, controller, createClient: () => native.client, createServer: createWebServer });
  t.after(() => pool.close());
  const child = await pool.server('host-a');
  await new Promise(resolve => child.listen(0, '127.0.0.1', resolve));
  // Send directly to the child listener so parent CORS headers cannot mask missing propagation.
  const parentOrigin = f.config.origin;
  f.config.origin = `https://127.0.0.1:${child.address().port}`;
  t.after(() => { child.closeAllConnections(); return new Promise(resolve => child.close(resolve)); });
  const missing = await f.request('/api/status?host=host-a', { origin, headers: { Host: new URL(parentOrigin).host } });
  assert.equal(missing.status, 401); assert.equal(missing.headers['access-control-allow-origin'], origin);
  const login = await f.request('/api/login', { method: 'POST', origin, headers: { Host: new URL(parentOrigin).host }, body: { password: 'fixture-passphrase' } });
  assert.equal(login.status, 200); assert.match(login.headers['set-cookie'][0], /SameSite=None/);
  f.config.origin = parentOrigin;
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  const view = await f.request('/api/view?host=host-a', { method: 'POST', origin, cookie, body: {} });
  assert.equal(view.status, 200);
  const wrong = await f.request('/api/events?host=host-a&viewId=' + view.json.viewId, { origin, cookie: await f.login() });
  assert.equal(wrong.status, 403); assert.equal(wrong.headers['access-control-allow-origin'], origin);
  assert.equal((await f.request('/api/status?host=host-a', { cookie, origin: 'null' })).status, 403);
  assert.equal((await f.request('/api/status?host=host-a', { cookie, origin, headers: { Host: 'evil.example.test' } })).status, 403);
});

test('an account change closes existing host clients before another remote request can be routed', async t => {
  let enrolled = true, closed = 0;
  const controller = { async status() { return { enrolled }; }, async listHosts() { return [{ id: 'host-a', name: 'A' }]; } };
  const pool = createRemoteHostPool({ config: { stateDir: '/unused/private-state' }, sharedAuth: {}, controller,
    createClient: () => ({ close() { ++closed; }, status() { return { online: true }; } }),
    createServer: () => ({ emit() {} }) }); t.after(() => pool.close());
  await pool.server('host-a'); enrolled = false;
  await assert.rejects(pool.server('host-a'), { code: 'CONTROLLER_NOT_ENROLLED' });
  assert.equal(closed, 1);
});
