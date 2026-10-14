import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { httpsFixture, resumeFixture } from './helpers.mjs';

async function fixture(t) {
  const f = await httpsFixture(); t.after(() => f.close());
  f.config.backendHome = join(f.dir, 'native-home');
  await mkdir(f.config.backendHome, { mode: 0o700 });
  const cookie = await f.login(), viewId = await f.view(cookie);
  return { ...f, cookie, viewId, post: (action, body = {}, options = {}) => f.request('/api/automations/' + action,
    { method: 'POST', cookie, body: { viewId, ...body }, ...options }) };
}
async function nativeCall(f, method, result, count = 1) {
  for (let i = 0; i < 100; i++) {
    const calls = f.peer.sent.filter(call => call.method === method);
    if (calls.length >= count) { f.peer.replyTo(method, result); return calls.at(-1); }
    await delay(5);
  }
  assert.fail('Missing native call: ' + method);
}
const heartbeat = () => ({ kind: 'heartbeat', name: 'Scheduled check', prompt: 'Check the latest changes.',
  status: 'PAUSED', rrule: 'FREQ=HOURLY;INTERVAL=2', targetThreadId: 'thread-1' });

test('automation routes require owner origin and view and reject browser paths before native access', async t => {
  const f = await fixture(t), before = f.peer.sent.length;
  assert.equal((await f.post('list', {}, { cookie: undefined })).status, 401);
  assert.equal((await f.post('list', {}, { origin: 'https://example.com' })).status, 403);
  assert.equal((await f.post('list', {}, { cookie: await f.login() })).status, 403);
  assert.equal((await f.post('list', { home: '/tmp' })).status, 400);
  for (const patch of [{ cwds: ['/tmp'] }, { id: 'mine' }, { createdAt: 1 }, { targetThreadId: '../thread' }]) {
    assert.equal((await f.post('create', { item: { ...heartbeat(), ...patch } })).status, 400);
  }
  assert.equal((await f.post('read', { id: '../outside' })).status, 400);
  assert.equal((await f.post('delete', { id: 'task', confirmed: false, expectedUpdatedAt: 1 })).status, 400);
  assert.equal(f.peer.sent.length, before);
  assert.deepEqual(await readdir(f.config.backendHome), []);
});

test('native heartbeat create, metadata list, full read, versioned pause and delete do not send a model turn', async t => {
  const f = await fixture(t), pending = f.post('create', { item: heartbeat() });
  const call = await nativeCall(f, 'thread/read', { thread: resumeFixture().thread });
  assert.deepEqual(call.params, { threadId: 'thread-1', includeTurns: false });
  const created = await pending;
  assert.equal(created.status, 200, created.text);
  const task = created.json.item, taskPath = join(f.config.backendHome, 'automations', task.id, 'automation.toml');
  assert.match(await readFile(taskPath, 'utf8'), /"?target_thread_id"?\s*=\s*"thread-1"/);
  assert.equal(task.prompt, heartbeat().prompt);
  const listed = await f.post('list');
  assert.equal(listed.status, 200); assert.equal(listed.json.items.length, 1);
  assert.equal(listed.json.items[0].prompt, undefined);
  assert.equal(typeof listed.json.items[0].promptPreview, 'string');
  assert.equal(listed.json.timeZone, Intl.DateTimeFormat().resolvedOptions().timeZone);
  assert.equal(Number.isFinite(listed.json.now), true);
  const read = await f.post('read', { id: task.id });
  assert.equal(read.json.item.prompt, heartbeat().prompt);
  const changed = await f.post('update', { id: task.id, expectedUpdatedAt: task.updatedAt, patch: { status: 'ACTIVE' } });
  assert.equal(changed.status, 200, changed.text); assert.equal(changed.json.item.status, 'ACTIVE');
  assert.equal((await f.post('update', { id: task.id, expectedUpdatedAt: task.updatedAt, patch: { prompt: 'stale overwrite' } })).status, 409);
  assert.equal((await f.post('delete', { id: task.id, expectedUpdatedAt: task.updatedAt, confirmed: true })).status, 409);
  const deleted = await f.post('delete', { id: task.id, expectedUpdatedAt: changed.json.item.updatedAt, confirmed: true });
  assert.equal(deleted.status, 200, deleted.text);
  assert.equal((await f.post('list')).json.items.length, 0);
  assert.equal(f.peer.sent.some(call => /thread\/resume|turn\/start|thread\/start|project\/create|fs\//.test(call.method)), false);
});

test('standalone native tasks derive directories from the existing project and validate native model choices', async t => {
  const f = await fixture(t), item = { kind: 'cron', name: 'Project summary', prompt: 'Summarize changes.',
    status: 'PAUSED', rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0', projectId: 'project-1',
    executionEnvironment: 'local', model: 'fixture-model', reasoningEffort: 'low' };
  const pending = f.post('create', { item });
  await nativeCall(f, 'project/read', { project: { id: 'project-1', roots: [{ path: f.dir }] } });
  await nativeCall(f, 'model/list', { data: [{ model: 'fixture-model', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }], nextCursor: null });
  const response = await pending;
  assert.equal(response.status, 200, response.text); assert.deepEqual(response.json.item.cwds, [f.dir]);
  const id = response.json.item.id, updatedAt = response.json.item.updatedAt;
  const change = f.post('update', { id, expectedUpdatedAt: updatedAt, patch: { model: 'invented' } });
  await nativeCall(f, 'model/list', { data: [{ model: 'fixture-model' }], nextCursor: null }, 2);
  assert.equal((await change).status, 422);
  assert.equal((await f.post('read', { id })).json.item.model, 'fixture-model');
  assert.equal(f.peer.sent.some(call => /project\/create|thread\/start|turn\/start/.test(call.method)), false);
});

test('invalid native targets and effort overrides leave task files untouched', async t => {
  const f = await fixture(t);
  const pending = f.post('create', { item: heartbeat() });
  await nativeCall(f, 'thread/read', { thread: { ...resumeFixture().thread, id: 'other-thread' } });
  assert.equal((await pending).status, 422);
  assert.equal((await f.post('create', { item: { ...heartbeat(), model: 'fixture-model' } })).status, 400);
  const invalid = f.post('create', { item: { kind: 'cron', name: 'Unknown effort', prompt: 'Check.', status: 'PAUSED',
    rrule: 'FREQ=HOURLY;INTERVAL=2', projectId: null, model: 'fixture-model', reasoningEffort: 'ultra' } });
  await nativeCall(f, 'model/list', { data: [{ model: 'fixture-model', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }], nextCursor: null });
  assert.equal((await invalid).status, 422);
  assert.deepEqual(await readdir(f.config.backendHome), []);
});

test('remote automation requests cannot read or change the local native home', async t => {
  const f = await fixture(t);
  f.config.remoteHost = { id: 'remote' };
  const before = f.peer.sent.length;
  for (const action of ['list', 'read', 'create', 'update', 'delete']) {
    const response = await f.post(action);
    assert.equal(response.status, 403, response.text); assert.equal(response.json.error.code, 'LOCAL_AUTOMATIONS_ONLY');
  }
  assert.equal(f.peer.sent.length, before); assert.deepEqual(await readdir(f.config.backendHome), []);
});

test('desktop task-file changes notify the authenticated browser over SSE', async t => {
  const f = await fixture(t);
  assert.equal((await f.post('list')).status, 200);
  const stream = await f.events(f.cookie, f.viewId); t.after(() => stream.req.destroy());
  const taskDir = join(f.config.backendHome, 'automations', 'desktop-task');
  await mkdir(taskDir, { recursive: true, mode: 0o700 });
  await writeFile(join(taskDir, 'automation.toml'), 'version = 1\nid = "desktop-task"\nkind = "heartbeat"\nname = "Desktop task"\nprompt = "Check."\nstatus = "PAUSED"\nrrule = "FREQ=HOURLY;INTERVAL=2"\ntarget_thread_id = "thread-1"\ncreated_at = 1\nupdated_at = 2\n');
  for (let i = 0; i < 200 && !stream.text().includes('automation/changed'); i++) await delay(10);
  assert.match(stream.text(), /automation\/changed/);
  const listed = await f.post('list');
  assert.equal(listed.json.items.some(item => item.id === 'desktop-task'), true);
});

test('duplicate long native task names remain readable, editable and deletable', async t => {
  const f = await fixture(t), item = { kind: 'cron', name: 'x'.repeat(128), prompt: 'Check.', status: 'PAUSED', rrule: 'FREQ=HOURLY;INTERVAL=2' };
  const first = await f.post('create', { item }), second = await f.post('create', { item });
  assert.equal(first.status, 200); assert.equal(second.status, 200);
  const task = second.json.item;
  assert.notEqual(task.id, first.json.item.id);
  assert.equal((await f.post('read', { id: task.id })).status, 200);
  const updated = await f.post('update', { id: task.id, expectedUpdatedAt: task.updatedAt, patch: { name: 'Renamed long task' } });
  assert.equal(updated.status, 200, updated.text);
  assert.equal((await f.post('delete', { id: task.id, expectedUpdatedAt: updated.json.item.updatedAt, confirmed: true })).status, 200);
});

test('legacy native cwd-only worktree tasks can be paused and renamed without changing their target', async t => {
  const f = await fixture(t), taskDir = join(f.config.backendHome, 'automations', 'legacy-task');
  await mkdir(taskDir, { recursive: true });
  const taskPath = join(taskDir, 'automation.toml');
  await writeFile(taskPath, 'version = 1\nid = "legacy-task"\nkind = "cron"\nname = "Legacy"\nprompt = "Check."\nstatus = "ACTIVE"\nrrule = "FREQ=HOURLY;INTERVAL=2"\ncwds = ["/tmp"]\ncreated_at = 1\nupdated_at = 2\n');
  const read = await f.post('read', { id: 'legacy-task' });
  assert.equal(read.status, 200); assert.equal(read.json.item.executionEnvironment, 'worktree');
  const updated = await f.post('update', { id: 'legacy-task', expectedUpdatedAt: 2, patch: { name: 'Legacy paused', status: 'PAUSED' } });
  assert.equal(updated.status, 200, updated.text);
  assert.deepEqual(updated.json.item.cwds, ['/tmp']);
  assert.doesNotMatch(await readFile(taskPath, 'utf8'), /"target"\s*=/);
  const invalid = await f.post('create', { item: { kind: 'cron', name: 'Invalid worktree', prompt: 'Check.', status: 'PAUSED', rrule: 'FREQ=HOURLY;INTERVAL=2', executionEnvironment: 'worktree', projectId: null } });
  assert.equal(invalid.status, 400);
});
