import test from 'node:test';
import assert from 'node:assert/strict';
import { httpsFixture } from './helpers.mjs';

function controllerFixture() {
  const calls = [];
  return { calls,
    async status() { return { enrolled: false, phase: 'unconfigured', headers: { Authorization: 'private-token' } }; },
    async startAuthorization() {
      calls.push(['authorize']);
      return { url: 'https://auth.openai.com/oauth/authorize?state=fixture-state', expiresAt: Date.now() + 600000,
        completion: Promise.resolve({ enrolled: true }), secret: 'private-token' };
    },
    submitCallback(url) { calls.push(['callback', url]); return { accepted: true }; },
    async pair(code) { calls.push(['pair', code]); return { environmentId: 'host-a' }; },
    async listHosts() { return [{ id: 'host-a', name: 'My computer', hostName: 'pc' }]; },
  };
}

test('controller setup and pairing require owner authentication and the canonical origin', async t => {
  const controller = controllerFixture(), f = await httpsFixture({ controller }); t.after(() => f.close());
  assert.equal((await f.request('/api/controller/status')).status, 401);
  assert.equal((await f.request('/api/controller/authorize', { method: 'POST', body: {} })).status, 401);
  const cookie = await f.login();
  assert.equal((await f.request('/api/controller/pair', { method: 'POST', cookie, origin: 'https://other.test', body: { code: 'ABCD-1234' } })).status, 403);
  assert.equal(controller.calls.length, 0);
  const status = await f.request('/api/controller/status', { cookie });
  assert.equal(status.status, 200);
  assert.deepEqual(status.json, { available: true, enrolled: false, phase: 'unconfigured' });
  assert(!status.text.includes('private-token'));
});

test('authorization and copied callbacks are handled by the server without returning credentials', async t => {
  const controller = controllerFixture(), f = await httpsFixture({ controller }); t.after(() => f.close());
  const cookie = await f.login();
  const started = await f.request('/api/controller/authorize', { method: 'POST', cookie, body: {} });
  assert.equal(started.status, 200);
  assert.equal(new URL(started.json.url).origin, 'https://auth.openai.com');
  assert.equal(typeof started.json.expiresAt, 'number');
  assert(!started.text.includes('private-token'));
  const url = 'http://localhost:1455/auth/callback?state=fixture-state&code=fixture-code';
  const completed = await f.request('/api/controller/callback', { method: 'POST', cookie, body: { url } });
  assert.equal(completed.status, 200);
  assert.deepEqual(controller.calls, [['authorize'], ['callback', url]]);
  assert.equal((await f.request('/api/controller/callback', { method: 'POST', cookie, body: { url, extra: 'denied' } })).status, 400);
});

test('owner-supplied host codes reach the controller and another controller session is never exposed', async t => {
  const controller = controllerFixture(), f = await httpsFixture({ controller }); t.after(() => f.close());
  const cookie = await f.login();
  const pair = await f.request('/api/controller/pair', { method: 'POST', cookie, body: { code: 'ABCD-1234' } });
  assert.equal(pair.status, 200);
  assert.deepEqual(pair.json, { environmentId: 'host-a' });
  assert.deepEqual(controller.calls, [['pair', 'ABCD-1234']]);
  const hosts = await f.request('/api/controller/hosts', { cookie });
  assert.equal(hosts.status, 200);
  assert.equal(hosts.json.hosts[0].id, 'host-a');
  assert.equal((await f.request('/api/controller/session', { cookie })).status, 404);
});

test('a host route is resolved only after login and view state cannot fall back to the local backend', async t => {
  let routed = 0;
  const f = await httpsFixture({ routeHost: async host => {
    ++routed; assert.equal(host, 'host-a');
    return { emit(_event, _req, res) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"selectedHost":"host-a"}'); } };
  } }); t.after(() => f.close());
  assert.equal((await f.request('/api/status?host=host-a')).status, 401);
  assert.equal(routed, 0);
  const cookie = await f.login();
  const result = await f.request('/api/status?host=host-a', { cookie });
  assert.equal(result.status, 200);
  assert.deepEqual(result.json, { selectedHost: 'host-a' });
  assert.equal(routed, 1);
});

test('an unconfigured controller reports its setup state without breaking existing local APIs', async t => {
  const f = await httpsFixture(); t.after(() => f.close()); const cookie = await f.login();
  assert.deepEqual((await f.request('/api/controller/status', { cookie })).json, { available: false, enrolled: false, phase: 'unconfigured' });
  assert.equal((await f.request('/api/status', { cookie })).status, 200);
  assert.equal((await f.request('/api/controller/authorize', { method: 'POST', cookie, body: {} })).status, 503);
});
