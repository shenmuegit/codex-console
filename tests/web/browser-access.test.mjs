import test from 'node:test';
import assert from 'node:assert/strict';
import { browserAccess, checkOrigin } from '../../web/auth.mjs';
import { httpsFixture } from './helpers.mjs';

const O = 'https://plugin.example.test';
const overrides = { allowedOrigins: [O], cookieSameSite: 'none' };
const preflight = { method: 'OPTIONS', origin: O, headers: {
  'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } };

test('browser_access_accepts_exact_loopback_http_origins', () => {
  const allowedOrigins = ['http://localhost:5173', 'http://127.0.0.1:3000', 'http://127.0.0.2:3000', 'http://[::1]:5174'];
  assert.deepEqual(browserAccess({ allowedOrigins }), { allowedOrigins, cookieSameSite: 'strict' });
  for (const origin of ['http://192.168.1.1:5173', 'http://0.0.0.0:5173', 'http://localhost.example.test',
    'http://127.0.0.1.example.test', 'http://127.0.0.1:3000/', 'http://127.1:3000',
    'http://user@127.0.0.1:3000', 'http://localhost:0', 'null', '*']) {
    assert.throws(() => browserAccess({ allowedOrigins: [origin] }), { code: 'INVALID_BROWSER_ACCESS' });
  }
});

test('loopback_http_plugin_can_preflight_login_and_reuse_its_session', async t => {
  const origin = 'http://127.0.0.1:3000';
  const f = await httpsFixture({ configOverrides: { allowedOrigins: [origin], cookieSameSite: 'none' } });
  t.after(() => f.close());
  const options = await f.request('/api/login', { ...preflight, origin });
  assert.equal(options.status, 204);
  assert.equal(options.headers['access-control-allow-origin'], origin);
  const login = await f.request('/api/login', { method: 'POST', origin, body: { password: 'fixture-passphrase' } });
  assert.equal(login.status, 200);
  assert.equal(login.headers['access-control-allow-credentials'], 'true');
  const header = login.headers['set-cookie'][0];
  assert.match(header, /; HttpOnly; Secure; SameSite=None; Path=\//);
  const cookie = header.split(';')[0];
  assert.equal((await f.request('/api/status', { origin, cookie })).json.online, true);
  assert.equal((await f.request('/api/status', { origin: 'http://127.0.0.2:3000', cookie })).status, 403);
  assert.equal((await f.request('/api/status', { origin: 'null', cookie })).status, 403);
});

test('browser_access_rejects_noncanonical_origins', () => {
  assert.deepEqual(browserAccess({}), { allowedOrigins: [], cookieSameSite: 'strict' });
  for (const origin of ['*', 'https://*.example.test', 'null', 'http://plugin.example.test',
    'https://plugin.example.test:0', 'https://plugin.example.test:65536', 'https://plugin.example.test:-1',
    'https://plugin.example.test:abc', 'https://plugin.example.test:443', 'https://PLUGIN.example.test',
    'https://plugin.example.test/path', O + '/', O + '?q=1', O + '#x', 'https://user@plugin.example.test',
    ' ' + O, O + '\n', null, 1]) {
    assert.throws(() => browserAccess({ allowedOrigins: [origin] }), { code: 'INVALID_BROWSER_ACCESS' });
  }
  for (const allowedOrigins of [null, O, {}]) assert.throws(() => browserAccess({ allowedOrigins }));
  for (const cookieSameSite of [null, 'lax', 'None', false]) assert.throws(() => browserAccess({ cookieSameSite }));
  assert.deepEqual(browserAccess({ origin: 'https://127.0.0.1:0', allowedOrigins: [O, O, O + ':65535'], cookieSameSite: 'none' }),
    { allowedOrigins: [O, O + ':65535'], cookieSameSite: 'none' });
  assert.doesNotThrow(() => checkOrigin(O, 'https://console.example.test', [O]));
  for (const actual of [undefined, 'null', 'https://unknown.example.test'])
    assert.throws(() => checkOrigin(actual, 'https://console.example.test', [O]), { code: 'ORIGIN_DENIED' });
});

test('preflight_needs_no_login', async t => {
  const f = await httpsFixture({ configOverrides: overrides }); t.after(() => f.close());
  const before = [...f.peer.sent];
  for (const method of ['GET', 'POST', 'PUT']) {
    const response = await f.request('/api/login', { ...preflight, body: 'not JSON', headers: {
      'Content-Length': '8', 'Access-Control-Request-Method': method, 'Access-Control-Request-Headers': 'Content-Type, LAST-EVENT-ID' } });
    assert.equal(response.status, 204); assert.equal(response.text, '');
    assert.equal(response.headers['access-control-allow-origin'], O);
    assert.equal(response.headers['access-control-allow-credentials'], 'true');
    assert.match(response.headers.vary, /Origin/);
    assert.equal(response.headers['access-control-allow-methods'], 'GET, POST, PUT');
    assert.equal(response.headers['access-control-allow-headers'], 'Content-Type, Last-Event-ID');
    assert.equal(response.headers['set-cookie'], undefined);
  }
  assert.equal((await f.request('/api/login', { ...preflight, origin: f.config.origin })).status, 204);
  assert.deepEqual(f.peer.sent, before);
});

test('preflight_rejects_unknown_origins_methods_headers_and_hosts', async t => {
  const f = await httpsFixture({ configOverrides: overrides }); t.after(() => f.close());
  for (const origin of [null, 'null', 'https://unknown.example.test']) {
    const response = await f.request('/api/login', { ...preflight, origin });
    assert.equal(response.status, 403); assert.equal(response.headers['access-control-allow-origin'], undefined);
  }
  for (const headers of [{}, { 'Access-Control-Request-Method': 'DELETE' },
    { 'Access-Control-Request-Method': 'post' }, { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization' },
    { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,' },
    { 'Access-Control-Request-Method': 'POST', Host: 'evil.example.test' }]) {
    const response = await f.request('/api/login', { ...preflight, headers });
    assert.equal(response.status, 403); assert.equal(response.headers['access-control-allow-origin'], O);
    assert.equal(response.headers['access-control-allow-methods'], undefined);
  }
  assert.equal((await f.request('/', preflight)).status, 403);
});

test('allowed_origin_can_read_auth_errors_before_host_validation', async t => {
  const f = await httpsFixture({ configOverrides: overrides }); t.after(() => f.close());
  const response = await f.request('/api/status', { origin: O });
  assert.equal(response.status, 401); assert.equal(response.json.error.code, 'LOGIN_REQUIRED');
  assert.equal(response.headers['access-control-allow-origin'], O);
  assert.equal(response.headers['access-control-allow-credentials'], 'true');
  assert.match(response.headers.vary, /Origin/);
  const host = await f.request('/api/status', { origin: O, headers: { Host: 'evil.example.test' } });
  assert.equal(host.status, 403); assert.equal(host.json.error.code, 'HOST_DENIED');
  assert.equal(host.headers['access-control-allow-origin'], O);
  assert.equal((await f.request('/api/login', { method: 'POST', origin: null, body: {} })).status, 403);
  assert.equal((await f.request('/api/status', { origin: f.config.origin })).status, 401);
  assert.equal((await f.request('/')).status, 200);
  const asset = await f.request('/', { origin: O });
  assert.equal(asset.status, 403); assert.equal(asset.headers['access-control-allow-origin'], undefined);
});

test('none_cookies_keep_security_flags_and_session_view_boundaries', async t => {
  const f = await httpsFixture({ configOverrides: overrides }); t.after(() => f.close());
  const login = await f.request('/api/login', { method: 'POST', origin: O, body: { password: 'fixture-passphrase' } });
  assert.equal(login.status, 200);
  const header = login.headers['set-cookie'][0], cookie = header.split(';')[0];
  assert.match(header, /^__Host-codex_console=/);
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=None', 'Path=/', 'Max-Age=43200']) assert.ok(header.includes(flag));
  const view = await f.request('/api/view', { method: 'POST', origin: O, cookie, body: {} });
  assert.equal(view.status, 200);
  const stream = await f.events(cookie, view.json.viewId, false, O);
  assert.equal(stream.res.statusCode, 200); assert.equal(stream.res.headers['access-control-allow-origin'], O);
  stream.req.destroy();
  const wrong = await f.request('/api/events?viewId=' + view.json.viewId, { origin: O, cookie: await f.login() });
  assert.equal(wrong.status, 403); assert.equal(wrong.headers['access-control-allow-origin'], O);
  const invalid = await f.request('/api/view', { method: 'POST', origin: O, cookie, body: { unexpected: true } });
  assert.equal(invalid.status, 400); assert.equal(invalid.headers['access-control-allow-origin'], O);
  const logout = await f.request('/api/logout', { method: 'POST', origin: O, cookie, body: {} });
  assert.equal(logout.status, 200); assert.match(logout.headers['set-cookie'][0], /^__Host-codex_console=/);
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=None', 'Path=/', 'Max-Age=0']) assert.ok(logout.headers['set-cookie'][0].includes(flag));
  assert.equal((await f.request('/api/status', { origin: O, cookie })).status, 401);
  const page = await f.request('/'); assert.match(page.headers['content-security-policy'], /frame-ancestors 'self'/);
});
