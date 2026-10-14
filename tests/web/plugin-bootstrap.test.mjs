import test from 'node:test';
import assert from 'node:assert/strict';
import { domFixture } from './dom.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function environment(t, { side = false, nested = false, crossOrigin = false } = {}) {
  const dom = domFixture();
  dom.location.href = 'https://plugin.example.test/dist/index.html' + (side ? '?side=1' : '');
  dom.document.documentElement = { dataset: {} };
  window.location = dom.location;
  window.parent = nested ? { location: { origin: 'https://plugin.example.test' } } : window;
  if (crossOrigin) Object.defineProperty(window.parent, 'location', { get() { throw new Error('cross origin'); } });
  t.after(() => dom.restore());
  return dom;
}

test('disposed_bootstrap_never_mounts_late_app', async t => {
  environment(t);
  const { startPlugin } = await import('../../web/plugin/bootstrap.mjs');
  const connection = deferred(); let mountCalls = 0, menuRegistrations = 0, imports = 0;
  const handle = startPlugin({ backendOrigin: 'https://codex.example.test', connect: () => connection.promise,
    loadApp: async () => { imports++; return { mountApp() { mountCalls++; return { dispose() {} }; } }; } });
  handle.dispose(); handle.dispose();
  connection.resolve({ registerMenu() { menuRegistrations++; return () => {}; } });
  await handle.ready;
  assert.equal(mountCalls, 0); assert.equal(menuRegistrations, 0); assert.equal(imports, 0);
});

test('disposal during app import never mounts and marker precedes import', async t => {
  const dom = environment(t), app = deferred();
  const { startPlugin } = await import('../../web/plugin/bootstrap.mjs');
  let mountCalls = 0;
  const handle = startPlugin({ connect: async () => ({ registerMenu() {} }), loadApp: () => {
    assert.equal(dom.document.documentElement.dataset.isolaPlugin, 'true'); return app.promise;
  } });
  await Promise.resolve(); handle.dispose();
  app.resolve({ mountApp() { mountCalls++; } }); await handle.ready;
  assert.equal(mountCalls, 0);
});

test('disposal during synchronous mount releases the returned app', async t => {
  environment(t); const { startPlugin } = await import('../../web/plugin/bootstrap.mjs');
  let disposals = 0;
  const handle = startPlugin({ connect: async () => ({ registerMenu() {} }), loadApp: async () => ({
    mountApp() { handle.dispose(); return { dispose() { disposals++; } }; },
  }) });
  await handle.ready; handle.dispose(); assert.equal(disposals, 1);
});

for (const scenario of [
  { name: 'nested_side_chat_does_not_connect_host', side: true, nested: true, expected: 0 },
  { name: 'cross origin side chat connects host', side: true, nested: true, crossOrigin: true, expected: 1 },
  { name: 'top level side URL connects host', side: true, expected: 1 },
  { name: 'nested main page connects host', nested: true, expected: 1 },
]) test(scenario.name, async t => {
  environment(t, scenario); const { startPlugin } = await import('../../web/plugin/bootstrap.mjs');
  let connects = 0, disposals = 0, options;
  const handle = startPlugin({ backendOrigin: 'https://codex.example.test', connect: async () => {
    connects++; return { registerMenu() {} };
  }, loadApp: async () => ({ mountApp(value) { options = value; return { dispose() { disposals++; } }; } }) });
  await handle.ready;
  assert.equal(connects, scenario.expected); assert.equal(options.backendOrigin, 'https://codex.example.test');
  assert.equal(typeof options.registerMenu, scenario.expected ? 'function' : 'undefined');
  handle.dispose(); handle.dispose(); assert.equal(disposals, 1);
});
