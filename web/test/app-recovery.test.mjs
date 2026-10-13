import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { domFixture } from './dom.mjs';
import { resumeFixture } from './helpers.mjs';

let moduleId = 0;
async function fixture(t, { host = 'removed-host', ownerStatus = 200, controllerStatus = 200, failure, enrolled = true, beforeResponse = async () => {}, side = false } = {}) {
  const dom = domFixture(), savedFetch = globalThis.fetch, savedSource = Object.getOwnPropertyDescriptor(globalThis, 'EventSource');
  const calls = [], streams = []; let signedOut = false, activeOwnerStatus = ownerStatus, app;
  dom.location.href = 'https://fixture.test/?thread=collision' + (host === 'local' ? '' : '&host=' + host) + (side ? '&side=1' : '');
  dom.location.assign = url => { dom.location.href = url; };
  globalThis.fetch = async (path, options) => {
    calls.push(path); const url = new URL(path, dom.location.href), body = options?.body ? JSON.parse(options.body) : {};
    await beforeResponse(url, body);
    if (url.pathname === '/api/login') activeOwnerStatus = 200;
    const status = signedOut ? 401 : url.pathname === '/api/status' && !url.searchParams.has('host') ? activeOwnerStatus : url.pathname === '/api/controller/status' ? controllerStatus :
      failure && url.searchParams.get('host') === host && url.pathname === failure.path ? failure.status : 200;
    const data = status !== 200 ? { error: { code: signedOut || status === 401 ? 'UNAUTHORIZED' : failure?.code, message: status === 401 ? 'Owner login required' : failure?.message ?? 'Selected host unavailable' } } :
      url.pathname === '/api/status' ? { online: true, uploadLimitBytes: 32, generation: url.searchParams.has('host') ? 7 : 99 } :
      url.pathname === '/api/controller/status' ? { available: true, enrolled, phase: enrolled ? 'ready' : 'authenticationUnavailable', enrollmentPreserved: !enrolled } :
      url.pathname === '/api/controller/hosts' ? { hosts: [{ id: 'host-b', name: 'Other device', online: true }, ...(host === 'host-a' ? [{ id: host, name: 'Selected device', online: true }] : [])] } :
      url.pathname === '/api/view' ? { viewId: url.searchParams.has('host') ? 'remote-view' : 'local-view' } :
      url.pathname === '/api/thread/open' ? { snapshot: { ...resumeFixture(body.threadId), model: url.searchParams.has('host') ? 'remote-model' : 'local-model' }, cursor: { generation: url.searchParams.has('host') ? 7 : 99, seq: 1 } } :
      { result: { data: body.method === 'model/list' ? [{ model: 'remote-model', displayName: 'Remote', defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }] : [], nextCursor: null } };
    return { ok: status === 200, status, json: async () => data };
  };
  Object.defineProperty(globalThis, 'EventSource', { configurable: true, value: class {
    constructor(url) { this.url = url; streams.push(this); } close() { this.closed = true; }
  } });
  t.after(async () => { signedOut = true; if (app) await app.api('/api/status').catch(() => {}); globalThis.fetch = savedFetch;
    if (savedSource) Object.defineProperty(globalThis, 'EventSource', savedSource); else delete globalThis.EventSource; dom.restore(); });
  app = await import('../public/app.js?recovery=' + ++moduleId);
  for (let i = 0; i < 12; i++) await tick();
  return { dom, calls, streams };
}

for (const failure of [
  { path: '/api/status', status: 404, code: 'REMOTE_HOST_NOT_PAIRED' },
  { path: '/api/status', status: 409, code: 'CONTROLLER_NOT_ENROLLED' },
  { path: '/api/status', status: 503, code: 'AUTH_UNAVAILABLE' },
  { path: '/api/view', status: 503, code: 'NATIVE_DISCONNECTED' },
  { path: '/api/rpc', status: 503, code: 'NATIVE_DISCONNECTED' },
]) test('authenticated startup shows a compact, specific error for ' + failure.code + ' at ' + failure.path, async t => {
  const { dom, calls } = await fixture(t, { failure, enrolled: failure.status !== 409 && failure.code !== 'AUTH_UNAVAILABLE' });
  assert.equal(calls[0], '/api/status', 'Owner authentication must not inherit the saved host');
  assert.equal(dom.get('login-panel').hidden, true); assert.equal(dom.get('workspace').hidden, false);
  assert.ok(calls.includes('/api/controller/status'));
  assert.equal(dom.get('workspace-error').hidden, false);
  assert.match(dom.get('workspace-error-message').textContent, /Selected host unavailable/);
  assert.ok(dom.get('workspace-error-message').textContent.includes(failure.code));
  assert.equal(dom.get('recovery-host-picker'), null); assert.equal(dom.get('recover-connections'), null);
  assert.equal(dom.get('host-picker').value, 'removed-host', 'Unavailable host identity stays selected');
  assert.ok(dom.get('host-picker').children.some(option => option.value === 'local'));
  assert.equal(calls.some(path => path !== '/api/status' && new URL(path, dom.location.href).pathname.startsWith('/api/') &&
    !new URL(path, dom.location.href).pathname.startsWith('/api/controller/') && !new URL(path, dom.location.href).searchParams.has('host')), false, 'No remote operation silently falls back to local');
  dom.get('show-settings').click(); dom.get('show-connections').click(); assert.equal(dom.get('connections-dialog').open, true);
  dom.get('close-connections').click(); dom.get('close-settings').click();
  dom.get('host-picker').value = 'local'; dom.event('host-picker', 'change');
  assert.equal(new URL(dom.location.href).searchParams.has('host'), false);
  assert.equal(new URL(dom.location.href).searchParams.has('thread'), false);
});

test('actual owner 401 shows login without starting remote initialization', async t => {
  const { dom, calls, streams } = await fixture(t, { ownerStatus: 401 });
  assert.equal(dom.get('login-panel').hidden, false); assert.equal(dom.get('workspace').hidden, true);
  assert.deepEqual(calls, ['/api/status']); assert.equal(streams.length, 0);
});

test('successful remote startup uses the remote model view and event stream', async t => {
  const { dom, calls, streams } = await fixture(t, { host: 'host-a' });
  assert.equal(calls[0], '/api/status');
  assert.equal(dom.get('login-panel').hidden, true); assert.equal(dom.get('workspace').hidden, false);
  assert.equal(dom.get('workspace-error').hidden, true);
  assert.equal(dom.get('host-picker').value, 'host-a'); assert.equal(dom.get('model').value, 'remote-model');
  assert.ok(!dom.get('draft').disabled);
  assert.equal(streams[0].url, '/api/events?viewId=remote-view&host=host-a');
  assert.ok(calls.includes('/api/view?host=host-a'));
});

test('explicit local selection boots the local workspace without a remote view or event cursor', async t => {
  const { dom, calls, streams } = await fixture(t, { host: 'local' });
  // Selecting local reloads this URL; exercise its actual startup independently.
  assert.equal(dom.get('workspace').hidden, false); assert.ok(!dom.get('draft').disabled);
  assert.ok(calls.includes('/api/view')); assert.equal(streams[0].url, '/api/events?viewId=local-view');
  assert.equal(calls.some(path => new URL(path, dom.location.href).searchParams.has('host')), false);
});

test('a selected-host owner 401 closes the partially initialized workspace', async t => {
  const { dom, streams } = await fixture(t, { failure: { path: '/api/rpc', status: 401 } });
  assert.equal(dom.get('login-panel').hidden, false); assert.equal(dom.get('workspace').hidden, true);
  assert.equal(streams[0].closed, true);
});

test('side-chat failures show the error without additional device controls', async t => {
  const { dom } = await fixture(t, { side: true, failure: { path: '/api/status', status: 404, code: 'REMOTE_HOST_NOT_PAIRED' } });
  assert.equal(dom.document.body.dataset.sideChat, 'true');
  assert.ok(dom.get('workspace-error-message').textContent.includes('REMOTE_HOST_NOT_PAIRED'));
  assert.equal(dom.get('recovery-host-picker'), null); assert.equal(dom.get('recover-connections'), null);
});

test('the standard offline error is readable in Chinese while specific backend reasons remain intact', async t => {
  const { dom } = await fixture(t, { failure: { path: '/api/rpc', status: 503, code: 'NATIVE_DISCONNECTED', message: 'The native backend is offline.' } });
  assert.equal(dom.get('workspace-error-message').textContent, '未能建立到所选设备的 Codex 连接。（NATIVE_DISCONNECTED）');
});

test('a gateway connection error preserves the reported upstream status and error code as text', async t => {
  const { dom } = await fixture(t, { failure: { path: '/api/status', status: 502, code: 'REMOTE_REQUEST_FAILED', message: 'Official remote-control request failed (403).' } });
  assert.equal(dom.get('workspace-error-message').textContent, 'Official remote-control request failed (403).（REMOTE_REQUEST_FAILED）');
});

test('choosing another host closes its partial stream and ignores late initialization failures', async t => {
  let release; const pending = new Promise(resolve => { release = resolve; });
  const { dom, streams } = await fixture(t, { failure: { path: '/api/rpc', status: 503 },
    beforeResponse: url => url.pathname === '/api/rpc' ? pending : undefined });
  assert.equal(streams.length, 1);
  dom.get('host-picker').value = 'host-b'; dom.event('host-picker', 'change');
  assert.equal(streams[0].closed, true); release(); await tick(); await tick();
  assert.equal(new URL(dom.location.href).searchParams.get('host'), 'host-b');
  assert.equal(dom.get('workspace-error').hidden, true, 'Late failure cannot install old recovery state');
});

test('a concurrent controller owner 401 cannot be overwritten by a selected-host startup error', async t => {
  const { dom, calls } = await fixture(t, { controllerStatus: 401, failure: { path: '/api/status', status: 404 } });
  assert.equal(dom.get('login-panel').hidden, false); assert.equal(dom.get('workspace').hidden, true);
  assert.equal(calls.filter(path => path === '/api/controller/status').length, 1, 'A late remote failure cannot remount controls after owner logout');
});

test('owner login followed by a remote startup failure reports the device error inside the workspace', async t => {
  const { dom } = await fixture(t, { ownerStatus: 401, failure: { path: '/api/status', status: 409 } });
  const button = dom.document.createElement('button'); dom.get('password').value = 'fixture-password';
  dom.event('login-form', 'submit', { submitter: button }); await tick(); await tick();
  assert.equal(dom.get('login-panel').hidden, true); assert.equal(dom.get('workspace').hidden, false);
  assert.equal(dom.get('workspace-error').hidden, false); assert.equal(dom.get('login-error').textContent, '');
  assert.equal(dom.get('password').value, ''); assert.equal(button.disabled, false);
});
