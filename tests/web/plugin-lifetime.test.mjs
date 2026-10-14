import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { mountAttachments } from '../../web/public/composer.js';
import { mountConnections } from '../../web/public/connections.js';
import { mountChat } from '../../web/public/chat.js';
import { getEventListeners } from 'node:events';
import { domFixture } from './dom.mjs';

for (const stage of ['image decoding', 'metadata', 'transfer']) test(`unmount during ${stage} cleans upload exactly once and prevents late transfer`, async t => {
  const dom = domFixture(), saved = new Map(), transfers = [], revoked = [], calls = [];
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const globals = {
    createImageBitmap: () => stage === 'image decoding' ? pending : Promise.resolve({ close() {} }),
    XMLHttpRequest: class { upload = {}; aborted = 0; open() {} setRequestHeader() {} send() { transfers.push(this); } abort() { this.aborted++; this.onabort(); } },
  };
  for (const [key, value] of Object.entries(globals)) { saved.set(key, globalThis[key]); globalThis[key] = value; }
  const create = URL.createObjectURL, revoke = URL.revokeObjectURL;
  URL.createObjectURL = () => 'blob:fixture'; URL.revokeObjectURL = value => revoked.push(value);
  t.after(() => { for (const [key, value] of saved) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } URL.createObjectURL = create; URL.revokeObjectURL = revoke; dom.restore(); });
  const state = { threadId: 't', ready: true, attachments: [] };
  const attachments = mountAttachments({ api: async path => { calls.push(path); return stage === 'metadata' ? pending : { id: 'u' }; },
    viewId: 'v', getState: () => state, getStates: () => [state], onChange() {}, uploadLimitBytes: 32 });
  dom.get('file-input').files = [new File(['x'], 'image.png', { type: 'image/png' })]; dom.event('file-input', 'change'); await tick();
  attachments.dispose(); attachments.dispose();
  release(stage === 'image decoding' ? { close() {} } : { id: 'u' }); await tick();
  assert.deepEqual(revoked, ['blob:fixture']);
  assert.equal(calls.length, stage === 'image decoding' ? 0 : 1);
  assert.equal(transfers.length, stage === 'transfer' ? 1 : 0);
  if (transfers.length) assert.equal(transfers[0].aborted, 1);
});

test('late controller callback does not refresh or clear input after unmount', async t => {
  const dom = domFixture(), calls = []; let release;
  const connections = mountConnections({ api: async path => {
    calls.push(path); if (path === '/api/controller/callback') await new Promise(resolve => { release = resolve; }); return {};
  }, selectHost() {} });
  t.after(() => { connections.dispose(); dom.restore(); });
  dom.get('controller-callback').value = 'https://fixture.test/'; dom.event('controller-callback-form', 'submit');
  connections.dispose(); dom.get('controller-callback').value = 'new mount'; release(); await tick();
  assert.deepEqual(calls, ['/api/controller/callback']); assert.equal(dom.get('controller-callback').value, 'new mount');
});

test('partial chat initialization releases child and body listeners', t => {
  const dom = domFixture(), lookup = dom.document.querySelector.bind(dom.document);
  t.after(() => dom.restore());
  dom.document.querySelector = selector => selector === '#messages' ? null : lookup(selector);
  assert.throws(() => mountChat({ api: async () => ({}), viewId: 'v', uploadLimitBytes: 32 }));
  assert.equal(getEventListeners(dom.get('draft'), 'input').length, 0);
  assert.equal(getEventListeners(dom.get('file-input'), 'change').length, 0);
  assert.equal(getEventListeners(dom.document.body, 'click').length, 0);
});
