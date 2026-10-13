import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { httpsFixture } from './helpers.mjs';

async function waitCall(peer, method, count = 1) {
  for (let i = 0; i < 100; i++) { if (peer.sent.filter(call => call.method === method).length >= count) return; await delay(5); }
  assert.fail(`Missing ${method}`);
}

test('owner project archive and restore update only namespaced native metadata', async t => {
  const f = await httpsFixture(); t.after(() => f.close()); const cookie = await f.login(), viewId = await f.view(cookie);
  for (const [i, archived] of [true, false].entries()) {
    const pending = f.request('/api/project/archive', { method: 'POST', cookie, body: { viewId, projectId: 'p', archived } });
    await waitCall(f.peer, 'project/read', i + 1);
    f.peer.replyTo('project/read', { project: { id: 'p', metadata: { unrelated: 'keep', ...(archived ? {} : { 'codex-console.archived': 'true' }) } } });
    await waitCall(f.peer, 'project/update', i + 1);
    assert.deepEqual(f.peer.sent.at(-1).params, { projectId: 'p', metadata: { unrelated: 'keep', ...(archived ? { 'codex-console.archived': 'true' } : {}) } });
    f.peer.replyTo('project/update', { project: { id: 'p' } }); assert.equal((await pending).status, 200);
  }
  assert.equal(f.peer.sent.some(call => call.method.startsWith('thread/') || call.method.startsWith('fs/')), false);
});

test('project archive and delete reject invalid inputs and foreign views before native access', async t => {
  const f = await httpsFixture(); t.after(() => f.close()); const cookie = await f.login(), viewId = await f.view(cookie), other = await f.login();
  const before = f.peer.sent.length;
  for (const [path, params] of [['archive', { archived: 'true' }], ['archive', { archived: true, projectId: '../p' }], ['archive', { archived: true, roots: [] }], ['delete', { confirmed: false }], ['delete', { confirmed: true, projectId: '../p' }]]) {
    assert.equal((await f.request('/api/project/' + path, { method: 'POST', cookie, body: { viewId, projectId: 'p', ...params } })).status, 400);
  }
  for (const path of ['archive', 'delete']) assert.equal((await f.request('/api/project/' + path, { method: 'POST', cookie: other, body: { viewId, projectId: 'p', ...(path === 'archive' ? { archived: true } : { confirmed: true }) } })).status, 403);
  for (const method of ['project/update', 'project/delete']) assert.equal((await f.request('/api/rpc', { method: 'POST', cookie, body: { method, params: { projectId: 'p' } } })).status, 403);
  assert.equal(f.peer.sent.length, before);
});

test('confirmed project deletion removes only native project registration and leaves directory files alone', async t => {
  const f = await httpsFixture(); t.after(() => f.close()); const cookie = await f.login(), viewId = await f.view(cookie);
  const path = join(f.dir, 'keep.txt'); await writeFile(path, 'keep project files');
  const pending = f.request('/api/project/delete', { method: 'POST', cookie, body: { viewId, projectId: 'p', confirmed: true } });
  await waitCall(f.peer, 'project/delete'); assert.deepEqual(f.peer.sent.at(-1).params, { projectId: 'p' }); f.peer.replyTo('project/delete', {});
  assert.equal((await pending).status, 200); assert.equal(await readFile(path, 'utf8'), 'keep project files');
  assert.equal(f.peer.sent.some(call => call.method.startsWith('thread/') || call.method.startsWith('fs/')), false);
});
