import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { deleteThread } from '../server.mjs';
import { httpsFixture, resumeFixture } from './helpers.mjs';

async function waitCall(peer, method, count = 1) {
  for (let i = 0; i < 100; i++) { if (peer.sent.filter(m => m.method === method).length >= count) return; await delay(5); }
  assert.fail(`Missing ${method}`);
}
const project = (roots, name = 'Project') => ({ id: 'p', name, roots: roots.map(path => ({ path })), metadata: { unrelated: 'preserve' }, position: 0, createdAt: 1, updatedAt: 1 });
test('browser project and folder mutations are denied without native side effects', async t => {
  const f = await httpsFixture(); t.after(() => f.close()); const cookie = await f.login(), viewId = await f.view(cookie);
  const before = f.peer.sent.length;
  for (const [path, body] of [
    ['/api/project/archive', { projectId: 'p', archived: true }],
    ['/api/project/save', { name: 'Forbidden', rootPath: f.dir, idempotencyKey: 'forbidden' }],
    ['/api/directory/create', { path: join(f.dir, 'forbidden') }],
  ]) {
    const response = await f.request(path, { method: 'POST', cookie, body: { viewId, ...body } });
    assert.equal(response.status, 403); assert.equal(response.json.error.code, 'WORKSPACE_MANAGED_BY_CODEX');
  }
  assert.deepEqual(f.peer.sent.slice(before), []);
  for (const method of ['project/create', 'project/update', 'fs/createDirectory']) assert.equal((await f.request('/api/rpc', { method: 'POST', cookie, body: { method, params: {} } })).status, 403);
});

test('browser cwd overrides are rejected and new chats use the configured native workspace', async t => {
  const f = await httpsFixture(); t.after(() => f.close()); const cookie = await f.login(), viewId = await f.view(cookie), stream = await f.events(cookie, viewId);
  const overriding = f.request('/api/thread/start', { method: 'POST', cookie, body: { viewId, cwd: f.dir } }); overriding.catch(() => {});
  await delay(20); assert.equal(f.peer.sent.some(call => call.method === 'thread/start'), false);
  assert.equal((await overriding).status, 400);
  const created = f.request('/api/thread/start', { method: 'POST', cookie, body: { viewId } });
  await waitCall(f.peer, 'thread/start'); assert.equal(f.peer.sent.at(-1).params.cwd, f.dir); f.peer.replyTo('thread/start', resumeFixture('new'));
  await waitCall(f.peer, 'thread/name/set'); f.peer.replyTo('thread/name/set', {});
  await waitCall(f.peer, 'thread/resume'); f.peer.replyTo('thread/resume', resumeFixture('new'));
  assert.equal((await created).status, 200); stream.req.destroy();
});

test('a new project chat derives its working directory from the native primary root', async t => {
  const f = await httpsFixture(); t.after(() => f.close()); const cookie = await f.login(), viewId = await f.view(cookie), stream = await f.events(cookie, viewId);
  const primary = join(f.dir, 'primary'), secondary = join(f.dir, 'secondary'); await mkdir(primary); await mkdir(secondary);
  const created = f.request('/api/thread/start', { method: 'POST', cookie, body: { viewId, projectId: 'p' } });
  await waitCall(f.peer, 'project/read'); f.peer.replyTo('project/read', { project: project([primary, secondary]) });
  await waitCall(f.peer, 'thread/start'); assert.equal(f.peer.sent.at(-1).params.cwd, primary); assert.equal(f.peer.sent.at(-1).params.projectId, 'p'); f.peer.replyTo('thread/start', resumeFixture('new'));
  await waitCall(f.peer, 'thread/name/set'); f.peer.replyTo('thread/name/set', {});
  await waitCall(f.peer, 'thread/resume'); f.peer.replyTo('thread/resume', resumeFixture('new'));
  assert.equal((await created).status, 200); stream.req.destroy();
});

test('project pagination reads native records without web archive overrides', async t => {
  const f = await httpsFixture(); t.after(() => f.close()); const cookie = await f.login();
  const listing = f.request('/api/rpc', { method: 'POST', cookie, body: { method: 'project/list', params: { limit: 20, cursor: 'opaque-native-cursor' } } });
  await waitCall(f.peer, 'project/list'); assert.equal(f.peer.sent.at(-1).params.cursor, 'opaque-native-cursor');
  const data = [project([f.dir])]; f.peer.replyTo('project/list', { data, nextCursor: 'next-opaque' });
  assert.deepEqual((await listing).json.result, { data, nextCursor: 'next-opaque' });
});

test('old conversation cwd survives project rebinding and deletion keeps workspace files', async t => {
  const f = await httpsFixture(); t.after(() => f.close()); const cookie = await f.login(), viewId = await f.view(cookie), stream = await f.events(cookie, viewId);
  const path = join(f.dir, 'keep.txt'); await writeFile(path, 'preserve me');
  const opened = f.request('/api/thread/open', { method: 'POST', cookie, body: { viewId, threadId: 't' } });
  await waitCall(f.peer, 'thread/resume'); const snapshot = resumeFixture('t'); snapshot.cwd = f.dir; snapshot.thread.cwd = f.dir;
  f.peer.replyTo('thread/resume', snapshot); assert.equal((await opened).json.snapshot.thread.cwd, f.dir);
  assert.equal((await f.request('/api/thread/delete', { method: 'POST', cookie, body: { viewId, threadId: 't', confirmed: false } })).status, 400);
  const deleting = f.request('/api/thread/delete', { method: 'POST', cookie, body: { viewId, threadId: 't', confirmed: true } });
  await waitCall(f.peer, 'thread/resume', 2); assert.deepEqual(f.peer.sent.at(-1).params, { threadId: 't', excludeTurns: true, initialTurnsPage: { limit: 20, sortDirection: 'desc', itemsView: 'full' } });
  f.peer.replyTo('thread/resume', snapshot);
  await waitCall(f.peer, 'thread/delete'); f.peer.replyTo('thread/delete', {});
  // Release is allowed to unsubscribe, but must never call a host-file deletion API.
  await delay(10); if (f.peer.sent.at(-1).method === 'thread/unsubscribe') f.peer.replyTo('thread/unsubscribe', { status: 'unsubscribed' });
  assert.equal((await deleting).status, 200); assert.equal(await readFile(path, 'utf8'), 'preserve me');
  assert.equal(f.peer.sent.some(m => m.method === 'fs/remove'), false); stream.req.destroy();
});

test('active deletion waits for matching interruption completion, and refusal prevents native delete', async t => {
  const f = await httpsFixture(); t.after(() => f.close());
  const snapshot = resumeFixture('t', [{ id: 'active', status: 'inProgress', items: [] }]);
  const deleting = deleteThread(f.client, { threadId: 't', confirmed: true });
  await waitCall(f.peer, 'thread/resume'); f.peer.replyTo('thread/resume', snapshot);
  await waitCall(f.peer, 'turn/interrupt'); f.peer.replyTo('turn/interrupt', {});
  assert.equal(f.peer.sent.some(m => m.method === 'thread/delete'), false);
  f.peer.notify('turn/completed', { threadId: 't', turn: { id: 'older', status: 'completed', items: [] } }); await delay(10);
  assert.equal(f.peer.sent.some(m => m.method === 'thread/delete'), false);
  f.peer.notify('turn/completed', { threadId: 't', turn: { id: 'active', status: 'interrupted', items: [] } });
  await waitCall(f.peer, 'thread/delete'); f.peer.replyTo('thread/delete', {});
  await delay(10); if (f.peer.sent.at(-1).method === 'thread/unsubscribe') f.peer.replyTo('thread/unsubscribe', { status: 'unsubscribed' });
  await deleting;
  const refused = deleteThread(f.client, { threadId: 'another', confirmed: true }); const rejection = assert.rejects(refused, { code: -32600 });
  await waitCall(f.peer, 'thread/resume', 2); f.peer.replyTo('thread/resume', resumeFixture('another', [{ id: 'active-2', status: 'inProgress', items: [] }]));
  await waitCall(f.peer, 'turn/interrupt', 2); f.peer.errorTo('turn/interrupt', { code: -32600, message: 'Refused' });
  await rejection; assert.equal(f.peer.sent.filter(m => m.method === 'thread/delete').length, 1);
});

test('native deletion is never submitted after the real interruption deadline', { timeout: 35000 }, async t => {
  const f = await httpsFixture(); t.after(() => f.close());
  const deleting = deleteThread(f.client, { threadId: 't', confirmed: true });
  const failure = assert.rejects(deleting, { code: 'INTERRUPT_TIMEOUT' });
  await waitCall(f.peer, 'thread/resume'); f.peer.replyTo('thread/resume', resumeFixture('t', [{ id: 'active', status: 'inProgress', items: [] }]));
  await waitCall(f.peer, 'turn/interrupt'); f.peer.replyTo('turn/interrupt', {});
  await failure; assert.equal(f.peer.sent.some(m => m.method === 'thread/delete'), false);
});

test('a turn starting immediately after the resume checkpoint must finish interruption before deletion', async t => {
  const f = await httpsFixture(); t.after(() => f.close());
  const deleting = deleteThread(f.client, { threadId: 't', confirmed: true }); deleting.catch(() => {});
  await waitCall(f.peer, 'thread/resume'); f.peer.replyTo('thread/resume', resumeFixture('t'));
  f.peer.notify('turn/started', { threadId: 't', turn: { id: 'race-turn', status: 'inProgress', items: [] } });
  await delay(15); assert.equal(f.peer.sent.some(m => m.method === 'thread/delete'), false);
  await waitCall(f.peer, 'turn/interrupt'); f.peer.replyTo('turn/interrupt', {});
  f.peer.notify('turn/completed', { threadId: 't', turn: { id: 'race-turn', status: 'interrupted', items: [] } });
  await waitCall(f.peer, 'thread/delete'); f.peer.replyTo('thread/delete', {});
  await delay(10); if (f.peer.sent.at(-1).method === 'thread/unsubscribe') f.peer.replyTo('thread/unsubscribe', { status: 'unsubscribed' });
  await deleting;
});
