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
