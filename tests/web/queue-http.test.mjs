import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { httpsFixture, resumeFixture } from './helpers.mjs';
import { readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const item = { id: 'q1', clientUserMessageId: 'queued-client', input: [{ type: 'text', text: 'Next task 😀', text_elements: [] }, { type: 'localImage', path: '/private/image.png' }] };
const turn = { id: 'active', status: 'inProgress', items: [] };
async function waitCall(peer, method, count = 1) {
  const end = Date.now() + 1500;
  while (peer.sent.filter(call => call.method === method).length < count && Date.now() < end) await delay(5);
  assert.ok(peer.sent.filter(call => call.method === method).length >= count, 'Expected native ' + method);
  return peer.sent.findLast(call => call.method === method);
}
async function fixture(t) {
  const f = await httpsFixture(); t.after(() => f.close());
  const cookie = await f.login(), viewId = await f.view(cookie), stream = await f.events(cookie, viewId);
  t.after(() => stream.req.destroy());
  const opening = f.request('/api/thread/open', { method: 'POST', cookie, body: { viewId, threadId: 't' } });
  await waitCall(f.peer, 'thread/resume'); f.peer.replyTo('thread/resume', resumeFixture('t', [turn])); assert.equal((await opening).status, 200);
  const body = { viewId, threadId: 't', queuedSubmissionId: item.id, action: 'delete' };
  return { ...f, cookie, viewId, body, action: extra => f.request('/api/thread/queue', { method: 'POST', cookie, body: { ...body, ...(extra?.action && extra.action !== 'delete' ? { operationId: 'operation-' + (extra.operationId ?? extra.action) } : {}), ...extra } }) };
}

test('queue actions require an owned open view, valid fields and the configured origin', async t => {
  const f = await fixture(t);
  assert.equal((await f.action({ threadId: 'other' })).status, 403);
  assert.equal((await f.action({ action: 'unknown' })).status, 400);
  assert.equal((await f.action({ action: 'update', text: ' ' })).status, 400);
  assert.equal((await f.action({ input: [{ type: 'localImage', path: '/etc/passwd' }] })).status, 400);
  assert.equal((await f.request('/api/thread/queue', { method: 'POST', cookie: f.cookie, origin: 'https://evil.test', body: f.body })).status, 403);
  assert.equal(f.peer.sent.some(call => call.method.startsWith('thread/queue/')), false);
});

test('queue steering claims native inputs before sending, so the native queue cannot also dispatch them', async t => {
  const f = await fixture(t), first = f.action({ action: 'steer' });
  await waitCall(f.peer, 'thread/queue/list'); f.peer.replyTo('thread/queue/list', { data: [item], nextCursor: null });
  await waitCall(f.peer, 'thread/queue/delete');
  assert.equal(f.peer.sent.some(call => call.method === 'turn/steer'), false);
  f.peer.replyTo('thread/queue/delete', { deleted: true });
  const call = await waitCall(f.peer, 'turn/steer');
  assert.deepEqual(call.params, { threadId: 't', input: item.input, clientUserMessageId: item.clientUserMessageId, expectedTurnId: 'active' });
  const duplicate = f.action({ action: 'steer' }); await delay(20);
  assert.equal(f.peer.sent.filter(call => call.method === 'turn/steer').length, 1);
  assert.equal(f.peer.sent.filter(call => call.method === 'thread/queue/delete').length, 1);
  f.peer.replyTo('turn/steer', { turnId: 'active' }); assert.equal((await first).status, 200); assert.equal((await duplicate).status, 200);
});

test('queue update preserves attachments; missing submissions cannot be recreated or steered', async t => {
  const f = await fixture(t), update = f.action({ action: 'update', text: 'Changed 😀', operationId: 'edit-1' });
  await waitCall(f.peer, 'thread/queue/list'); f.peer.replyTo('thread/queue/list', { data: [item], nextCursor: null });
  const call = await waitCall(f.peer, 'thread/queue/update'); assert.deepEqual(call.params.input, [{ ...item.input[0], text: 'Changed 😀' }, item.input[1]]);
  f.peer.replyTo('thread/queue/update', { queuedSubmission: { ...item, input: call.params.input } }); assert.equal((await update).status, 200);
  const again = f.action({ action: 'update', text: 'Changed 😀', operationId: 'edit-2' });
  await waitCall(f.peer, 'thread/queue/list', 2); f.peer.replyTo('thread/queue/list', { data: [{ ...item, input: [{ ...item.input[0], text: 'Desktop edit' }, item.input[1]] }], nextCursor: null });
  await waitCall(f.peer, 'thread/queue/update', 2); f.peer.replyTo('thread/queue/update', { queuedSubmission: item }); assert.equal((await again).status, 200);
  const missing = f.action({ action: 'steer' }); await waitCall(f.peer, 'thread/queue/list', 3);
  f.peer.replyTo('thread/queue/list', { data: [], nextCursor: null }); assert.equal((await missing).status, 409);
  assert.equal(f.peer.sent.some(call => call.method === 'turn/steer'), false);
});

test('unknown steering stays locked and never replays a sent native mutation', async t => {
  const f = await fixture(t), first = f.action({ action: 'steer' });
  await waitCall(f.peer, 'thread/queue/list'); f.peer.replyTo('thread/queue/list', { data: [item], nextCursor: null });
  await waitCall(f.peer, 'thread/queue/delete'); f.peer.replyTo('thread/queue/delete', { deleted: true });
  await waitCall(f.peer, 'turn/steer'); f.peer.disconnect();
  const failed = await first; assert.equal(failed.json.error.outcome, 'unknown'); assert.ok(failed.json.error.queueRecovery.id);
  const recovery = failed.json.error.queueRecovery, path = join(f.config.stateDir, 'queue-recovery', recovery.id + '.json');
  assert.equal((await stat(path)).mode & 0o777, 0o600); assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).queued.input, item.input);
  const again = await f.action({ action: 'steer' }); assert.equal(again.status, 409); assert.equal(again.json.error.outcome, 'unknown');
  assert.equal(f.peer.sent.filter(call => call.method === 'turn/steer').length, 1);
  await waitCall(f.peer, 'thread/resume');
  const end = Date.now() + 2500; while (f.peer.socketCount < 2 && Date.now() < end) await delay(20);
  await waitCall(f.peer, 'thread/resume'); f.peer.replyTo('thread/resume', resumeFixture('t', [turn])); await delay(10);
  assert.equal((await f.action({ action: 'restore', queuedSubmissionId: 'other', recoveryId: recovery.id })).status, 403);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).state, 'claimed', 'Denied recovery must not modify its input');
  const restoring = f.action({ action: 'restore', recoveryId: recovery.id });
  await waitCall(f.peer, 'thread/queue/list'); f.peer.replyTo('thread/queue/list', { data: [], nextCursor: null });
  await waitCall(f.peer, 'thread/turns/list'); f.peer.replyTo('thread/turns/list', { data: [], nextCursor: null });
  const restored = await waitCall(f.peer, 'thread/queue/add'); assert.deepEqual(restored.params.input, item.input);
  assert.notEqual(restored.params.clientUserMessageId, item.clientUserMessageId);
  f.peer.replyTo('thread/queue/add', { queuedSubmission: { ...item, id: 'restored' } }); assert.equal((await restoring).status, 200);
  await assert.rejects(readFile(path), { code: 'ENOENT' });
});

test('native queue lifecycle is observed without adding a competing browser dispatcher', async t => {
  const f = await fixture(t);
  const queued = f.request('/api/thread/send', { method: 'POST', cookie: f.cookie,
    body: { viewId: f.viewId, threadId: 't', mode: 'queue', draft: { text: 'Next task 😀' }, clientUserMessageId: item.clientUserMessageId } });
  await waitCall(f.peer, 'thread/queue/add'); f.peer.replyTo('thread/queue/add', { queuedSubmission: item }); assert.equal((await queued).status, 200);
  f.peer.notify('turn/completed', { threadId: 't', turn: { ...turn, status: 'interrupted' } }); await delay(20);
  assert.equal(f.peer.sent.some(call => call.method === 'thread/queue/start'), false);
  f.peer.notify('turn/started', { threadId: 't', turn: { ...turn, id: 'continuation' } });
  f.peer.notify('turn/completed', { threadId: 't', turn: { ...turn, id: 'continuation', status: 'completed' } });
  f.peer.notify('turn/started', { threadId: 't', turn: { ...turn, id: 'queued-turn' } });
  await delay(20); assert.equal(f.peer.sent.filter(call => call.method === 'thread/queue/start').length, 0);
});

test('a definitive rejected steer restores the claimed message and its image to the native queue', async t => {
  const f = await fixture(t), sending = f.action({ action: 'steer' });
  await waitCall(f.peer, 'thread/queue/list'); f.peer.replyTo('thread/queue/list', { data: [item], nextCursor: null });
  await waitCall(f.peer, 'thread/queue/delete'); f.peer.replyTo('thread/queue/delete', { deleted: true });
  await waitCall(f.peer, 'turn/steer'); f.peer.errorTo('turn/steer', { code: -32600, message: 'Active turn changed' });
  const restore = await waitCall(f.peer, 'thread/queue/add'); assert.deepEqual(restore.params.input, item.input);
  f.peer.replyTo('thread/queue/add', { queuedSubmission: { ...item, id: 'restored' } });
  assert.equal((await sending).status, 422); assert.equal(f.peer.sent.filter(call => call.method === 'turn/steer').length, 1);
});

test('a source message consumed during a side transfer cannot also start in the side chat', async t => {
  const f = await fixture(t), sending = f.action({ action: 'side' });
  await waitCall(f.peer, 'thread/queue/list'); f.peer.replyTo('thread/queue/list', { data: [item], nextCursor: null });
  await waitCall(f.peer, 'thread/queue/delete'); f.peer.replyTo('thread/queue/delete', { deleted: false });
  assert.equal((await sending).status, 409); assert.equal(f.peer.sent.some(call => call.method === 'thread/fork'), false);
});

test('reused transfer operation IDs cannot remove another private recovery file', async t => {
  const f = await fixture(t), directory = join(f.config.stateDir, 'queue-recovery'), path = join(directory, 'existing-operation.json');
  await mkdir(directory, { recursive: true, mode: 0o700 }); await writeFile(path, 'preserved backup', { mode: 0o600 });
  const sending = f.action({ action: 'steer', operationId: 'existing-operation' });
  await waitCall(f.peer, 'thread/queue/list'); f.peer.replyTo('thread/queue/list', { data: [item], nextCursor: null });
  assert.equal((await sending).status, 500); assert.equal(await readFile(path, 'utf8'), 'preserved backup');
  assert.equal(f.peer.sent.some(call => call.method === 'thread/queue/delete'), false);
});

test('a restored native queue item is reconciled after a web restart instead of being added twice', async t => {
  const f = await fixture(t), directory = join(f.config.stateDir, 'queue-recovery'), path = join(directory, 'restart-recovery.json');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify({ threadId: 't', queued: item, state: 'restoring', retryId: 'restored-client' }), { mode: 0o600 });
  const restoring = f.action({ action: 'restore', recoveryId: 'restart-recovery' });
  await waitCall(f.peer, 'thread/queue/list'); f.peer.replyTo('thread/queue/list', { data: [{ ...item, id: 'restored-item', clientUserMessageId: 'restored-client' }], nextCursor: null });
  assert.equal((await restoring).status, 200); assert.equal(f.peer.sent.some(call => call.method === 'thread/queue/add'), false);
  await assert.rejects(readFile(path), { code: 'ENOENT' });
});

test('a crash before native requeue leaves an explicit checked recovery path', async t => {
  const f = await fixture(t), directory = join(f.config.stateDir, 'queue-recovery'), path = join(directory, 'crash-recovery.json');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify({ threadId: 't', queued: item, state: 'restoring', retryId: 'never-sent-client' }), { mode: 0o600 });
  const restoring = f.action({ action: 'restore', recoveryId: 'crash-recovery' });
  await waitCall(f.peer, 'thread/queue/list'); f.peer.replyTo('thread/queue/list', { data: [], nextCursor: null });
  await waitCall(f.peer, 'thread/turns/list'); f.peer.replyTo('thread/turns/list', { data: [], nextCursor: null });
  const call = await waitCall(f.peer, 'thread/queue/add'); assert.deepEqual(call.params.input, item.input);
  assert.equal(call.params.clientUserMessageId, 'never-sent-client'); f.peer.replyTo('thread/queue/add', { queuedSubmission: item });
  assert.equal((await restoring).status, 200);
});

test('a denied restore never rewrites another conversation recovery state', async t => {
  const f = await fixture(t), directory = join(f.config.stateDir, 'queue-recovery'), path = join(directory, 'other-recovery.json');
  const bytes = JSON.stringify({ threadId: 'other', queued: item, state: 'restoring', retryId: 'other-client' });
  await mkdir(directory, { recursive: true, mode: 0o700 }); await writeFile(path, bytes, { mode: 0o600 });
  assert.equal((await f.action({ action: 'restore', recoveryId: 'other-recovery' })).status, 403);
  assert.equal(await readFile(path, 'utf8'), bytes); assert.equal(f.peer.sent.some(call => call.method.startsWith('thread/queue/')), false);
});

test('an explicit new restore operation reconciles a lost native requeue reply', async t => {
  const f = await fixture(t), directory = join(f.config.stateDir, 'queue-recovery'), path = join(directory, 'lost-requeue.json');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify({ threadId: 't', queued: item, state: 'claimed', retryId: 'retry-client' }), { mode: 0o600 });
  const first = f.action({ action: 'restore', recoveryId: 'lost-requeue', operationId: 'restore-first' });
  await waitCall(f.peer, 'thread/queue/list'); f.peer.replyTo('thread/queue/list', { data: [], nextCursor: null });
  await waitCall(f.peer, 'thread/turns/list'); f.peer.replyTo('thread/turns/list', { data: [], nextCursor: null });
  await waitCall(f.peer, 'thread/queue/add'); f.peer.disconnect(); assert.equal((await first).json.error.outcome, 'unknown');
  const end = Date.now() + 2500; while (f.peer.socketCount < 2 && Date.now() < end) await delay(20);
  await waitCall(f.peer, 'thread/resume'); f.peer.replyTo('thread/resume', resumeFixture('t', [turn])); await delay(10);
  const retry = f.action({ action: 'restore', recoveryId: 'lost-requeue', operationId: 'restore-second' });
  await waitCall(f.peer, 'thread/queue/list'); f.peer.replyTo('thread/queue/list', { data: [{ ...item, id: 'restored', clientUserMessageId: 'retry-client' }], nextCursor: null });
  assert.equal((await retry).status, 200); assert.equal(f.peer.sent.some(call => call.method === 'thread/queue/add'), false);
});

test('failed side resume releases its temporary watcher and restores the source input', async t => {
  const f = await fixture(t), sending = f.action({ action: 'side' });
  await waitCall(f.peer, 'thread/queue/list'); f.peer.replyTo('thread/queue/list', { data: [item], nextCursor: null });
  await waitCall(f.peer, 'thread/queue/delete'); f.peer.replyTo('thread/queue/delete', { deleted: true });
  await waitCall(f.peer, 'thread/fork'); f.peer.replyTo('thread/fork', { thread: { id: 'side' } });
  await waitCall(f.peer, 'thread/name/set'); f.peer.replyTo('thread/name/set', {});
  await waitCall(f.peer, 'thread/resume', 2); f.peer.errorTo('thread/resume', { code: -32600, message: 'Side resume failed' });
  const release = await waitCall(f.peer, 'thread/unsubscribe'); assert.equal(release.params.threadId, 'side'); f.peer.replyTo('thread/unsubscribe', {});
  await waitCall(f.peer, 'thread/queue/add'); f.peer.replyTo('thread/queue/add', { queuedSubmission: item });
  assert.equal((await sending).status, 422); assert.equal(f.peer.sent.some(call => call.method === 'turn/start'), false);
});

test('an automatically restored message with its original client ID is not queued again after a lost reply', async t => {
  const f = await fixture(t), sending = f.action({ action: 'steer' });
  await waitCall(f.peer, 'thread/queue/list'); f.peer.replyTo('thread/queue/list', { data: [item], nextCursor: null });
  await waitCall(f.peer, 'thread/queue/delete'); f.peer.replyTo('thread/queue/delete', { deleted: true });
  await waitCall(f.peer, 'turn/steer'); f.peer.errorTo('turn/steer', { code: -32600, message: 'Turn changed' });
  await waitCall(f.peer, 'thread/queue/add'); f.peer.disconnect(); const recovery = (await sending).json.error.queueRecovery;
  const end = Date.now() + 2500; while (f.peer.socketCount < 2 && Date.now() < end) await delay(20);
  await waitCall(f.peer, 'thread/resume'); f.peer.replyTo('thread/resume', resumeFixture('t', [turn])); await delay(10);
  const restoring = f.action({ action: 'restore', recoveryId: recovery.id });
  await waitCall(f.peer, 'thread/queue/list'); f.peer.replyTo('thread/queue/list', { data: [{ ...item, id: 'native-restored' }], nextCursor: null });
  assert.equal((await restoring).status, 200); assert.equal(f.peer.sent.some(call => call.method === 'thread/queue/add'), false);
});
