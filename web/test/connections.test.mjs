import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { mountConnections } from '../public/connections.js';
import { domFixture } from './dom.mjs';

test('setup opens the official account link and keeps host-code submission disabled until enrollment', async t => {
  const dom = domFixture(); let enrolled = false; const calls = [];
  const api = async (path, body) => {
    calls.push({ path, body });
    if (path === '/api/controller/status') return { available: true, enrolled, phase: enrolled ? 'ready' : 'unconfigured' };
    if (path === '/api/controller/authorize') return { url: 'https://auth.openai.com/oauth/authorize?state=test', expiresAt: Date.now() + 600000 };
    if (path === '/api/controller/callback') { enrolled = true; return { accepted: true }; }
    if (path === '/api/controller/hosts') return { hosts: [{ id: 'host-a', name: 'My computer', online: true }] };
    return { environmentId: 'host-a' };
  };
  const connections = mountConnections({ api, selectedHost: 'local', selectHost() {} }); t.after(() => { connections.dispose(); dom.restore(); });
  await connections.refresh();
  assert.equal(dom.get('pair-submit').disabled, true);
  dom.get('controller-authorize').click(); await tick();
  assert.equal(new URL(dom.get('controller-auth-link').href).origin, 'https://auth.openai.com');
  dom.get('controller-callback').value = 'http://localhost:1455/auth/callback?state=test&code=test';
  dom.event('controller-callback-form', 'submit'); await tick(); await tick();
  assert.equal(dom.get('pair-submit').disabled, false);
  assert(calls.some(call => call.path === '/api/controller/callback'));
  dom.get('pair-code').value = 'ABCD-1234'; dom.event('pair-form', 'submit'); await tick();
  assert(calls.some(call => call.path === '/api/controller/pair' && call.body.code === 'ABCD-1234'));
});

test('device names are rendered as text and selection delegates the exact paired host identity', async t => {
  const dom = domFixture(); let selected;
  const connections = mountConnections({ selectedHost: 'host-a', selectHost(id) { selected = id; }, api: async path =>
    path === '/api/controller/status' ? { available: true, enrolled: true, phase: 'ready' } :
      { hosts: [{ id: 'host-a', name: '<script>name</script>', online: true }] } });
  t.after(() => { connections.dispose(); dom.restore(); }); await connections.refresh();
  const picker = dom.get('host-picker');
  assert.equal(picker.children[1].textContent, '<script>name</script> · 已连接');
  assert.equal(picker.children[1].children.length, 0);
  picker.value = 'host-a'; dom.event('host-picker', 'change');
  assert.equal(selected, 'host-a');
});

test('preserved enrollment with revoked account login explains recovery and disables new enrollment', async t => {
  const dom = domFixture();
  const connections = mountConnections({ selectHost() {}, api: async () => ({ available: true, enrolled: false,
    enrollmentPreserved: true, phase: 'authenticationRequired', errorCode: 'AUTH_REQUIRED' }) });
  t.after(() => { connections.dispose(); dom.restore(); }); await connections.refresh();
  assert.match(dom.get('controller-state').textContent, /官方账号登录/);
  assert.equal(dom.get('controller-authorize').disabled, true);
  assert.equal(dom.get('pair-submit').disabled, true);
});
