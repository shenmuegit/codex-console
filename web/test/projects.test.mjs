import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { saveProject, deleteThread } from '../server.mjs';
import { httpsFixture, resumeFixture } from './helpers.mjs';

async function waitCall(peer, method, count = 1) {
  for (let i = 0; i < 100; i++) { if (peer.sent.filter(m => m.method === method).length >= count) return; await delay(5); }
  assert.fail(`Missing ${method}`);
}
const project = (roots, name = 'Project') => ({ id: 'p', name, roots: roots.map(path => ({ path })), metadata: { unrelated: 'preserve' }, position: 0, createdAt: 1, updatedAt: 1 });
async function fixtureArchive(f, cookie, viewId, archived) {
  const before = f.peer.sent.length;
  const response = await f.request('/api/project/archive', { method: 'POST', cookie, body: { viewId, projectId: 'p', archived } });
  assert.equal(response.status, 200);
  return { archivedProjectIds: (await f.preferences()).archivedProjectIds, nativeCalls: f.peer.sent.slice(before) };
}

test('host picking validates absolute paths; creation uses the native filesystem without removing files', async t => {
  const f = await httpsFixture(); t.after(() => f.close()); const cookie = await f.login(), viewId = await f.view(cookie);
  const list = f.request('/api/rpc', { method: 'POST', cookie, body: { method: 'fs/readDirectory', params: { path: f.dir } } });
  await waitCall(f.peer, 'fs/readDirectory'); f.peer.replyTo('fs/readDirectory', { entries: [{ fileName: 'folder', isDirectory: true, isFile: false }] });
  assert.equal((await list).json.result.entries[0].fileName, 'folder');
  for (const path of ['relative', f.dir + '/../escape', f.dir + '/\0bad']) assert.equal((await f.request('/api/rpc', { method: 'POST', cookie, body: { method: 'fs/readDirectory', params: { path } } })).status, 400);
  const create = f.request('/api/directory/create', { method: 'POST', cookie, body: { viewId, path: join(f.dir, 'new folder') } });
  await waitCall(f.peer, 'fs/getMetadata'); f.peer.replyTo('fs/getMetadata', { isDirectory: true, isFile: false, isSymlink: false });
  await waitCall(f.peer, 'fs/createDirectory'); assert.deepEqual(f.peer.sent.at(-1).params, { path: join(f.dir, 'new folder'), recursive: false });
  f.peer.replyTo('fs/createDirectory', {}); assert.equal((await create).status, 200);
  assert.equal(f.peer.sent.some(m => ['fs/remove', 'fs/writeFile', 'project/delete'].includes(m.method)), false);
});

test('project creation forwards a stable native idempotency key, editing preserves secondary roots and metadata', async t => {
  const f = await httpsFixture(); t.after(() => f.close());
  const old = join(f.dir, 'old'), next = join(f.dir, 'next'), secondary = join(f.dir, 'second');
  await Promise.all([mkdir(old), mkdir(next), mkdir(secondary)]);
  const created = saveProject(f.client, { name: 'New', rootPath: old, idempotencyKey: 'create-key' });
  await waitCall(f.peer, 'fs/getMetadata'); f.peer.replyTo('fs/getMetadata', { isDirectory: true });
  await waitCall(f.peer, 'project/create'); assert.deepEqual(f.peer.sent.at(-1).params, { name: 'New', roots: [{ path: old }], idempotencyKey: 'create-key' });
  f.peer.replyTo('project/create', { project: project([old, secondary], 'New') }); assert.equal((await created).id, 'p');
  const edited = saveProject(f.client, { projectId: 'p', name: 'Edited', rootPath: next, idempotencyKey: 'unused-update-key' });
  await waitCall(f.peer, 'fs/getMetadata', 2); f.peer.replyTo('fs/getMetadata', { isDirectory: true });
  await waitCall(f.peer, 'project/read'); f.peer.replyTo('project/read', { project: project([old, secondary], 'New') });
  await waitCall(f.peer, 'project/update'); assert.deepEqual(f.peer.sent.at(-1).params, { projectId: 'p', name: 'Edited', roots: [{ path: next }, { path: secondary }] });
  f.peer.replyTo('project/update', { project: project([next, secondary], 'Edited') });
  assert.deepEqual((await edited).metadata, { unrelated: 'preserve' });
  assert.equal(f.peer.sent.some(m => m.method === 'thread/settings/update'), false);
});

test('web archive/restore is atomic preference-only; native pagination remains opaque', async t => {
  const f = await httpsFixture(); t.after(() => f.close()); const cookie = await f.login(), viewId = await f.view(cookie);
  assert.deepEqual(await fixtureArchive(f, cookie, viewId, true), { archivedProjectIds: ['p'], nativeCalls: [] });
  const listing = f.request('/api/rpc', { method: 'POST', cookie, body: { method: 'project/list', params: { limit: 20, cursor: 'opaque-native-cursor' } } });
  await waitCall(f.peer, 'project/list'); assert.equal(f.peer.sent.at(-1).params.cursor, 'opaque-native-cursor');
  f.peer.replyTo('project/list', { data: [project([f.dir])], nextCursor: 'next-opaque' });
  const result = (await listing).json.result; assert.equal(result.nextCursor, 'next-opaque'); assert.equal(result.data[0].webArchived, true);
  const editing = f.request('/api/project/save', { method: 'POST', cookie, body: { viewId, projectId: 'p', name: 'Archived edit', rootPath: f.dir } });
  await waitCall(f.peer, 'fs/getMetadata'); f.peer.replyTo('fs/getMetadata', { isDirectory: true });
  await waitCall(f.peer, 'project/read'); f.peer.replyTo('project/read', { project: project([f.dir]) });
  await waitCall(f.peer, 'project/update'); f.peer.replyTo('project/update', { project: project([f.dir], 'Archived edit') });
  assert.equal((await editing).json.project.webArchived, true);
  assert.deepEqual(await fixtureArchive(f, cookie, viewId, false), { archivedProjectIds: [], nativeCalls: [] });
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
