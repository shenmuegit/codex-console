import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createChatState, applyNativeEvent, installSnapshot, prependHistory, beginSend, settleSend, buildTurnParams, permissionText, shouldSubmitKey, mountChat } from '../public/chat.js';
import { renderTranscript } from '../transcript.mjs';
import { httpsFixture, resumeFixture } from './helpers.mjs';
import { domFixture } from './dom.mjs';

const cursor = seq => ({ generation: 1, seq });
const message = (seq, delta) => ({ kind: 'notification', cursor: cursor(seq), native: { method: 'item/agentMessage/delta', params: { threadId: 't', turnId: 'turn', itemId: 'a', delta } } });
const turn = (text = '') => ({ id: 'turn', status: 'inProgress', items: [{ id: 'a', type: 'agentMessage', text }], error: null });
async function waitCall(peer, method) {
  for (let i = 0; i < 100; i++) { if (peer.sent.some(m => m.method === method)) return; await delay(5); }
  assert.fail(`Native call did not arrive: ${method}`);
}
async function open(f, cookie, viewId, turns = []) {
  const result = f.request('/api/thread/open', { method: 'POST', cookie, body: { viewId, threadId: 't' } });
  await waitCall(f.peer, 'thread/resume'); f.peer.replyTo('thread/resume', resumeFixture('t', turns));
  const response = await result; assert.equal(response.status, 200); return response;
}

test('full defaults are encoded using native sandbox fields; effective restrictions remain visible', () => {
  const p = buildTurnParams({ threadId: 't', input: [{ type: 'text', text: '测试' }], clientUserMessageId: 'm' });
  assert.deepEqual(p.sandboxPolicy, { type: 'dangerFullAccess' }); assert.equal(p.approvalPolicy, 'never');
  assert.equal('permissions' in p, false);
  assert.match(permissionText(resumeFixture('t')), /完全访问/);
  assert.doesNotMatch(permissionText({ approvalPolicy: 'on-request', sandbox: { type: 'workspaceWrite' } }), /完全访问/);
});

test('mid-turn snapshots establish a checkpoint; identical deltas are distinct and completed items are authoritative', () => {
  const state = createChatState('t');
  applyNativeEvent(state, message(1, 'before'));
  applyNativeEvent(state, message(4, '哈'));
  installSnapshot(state, { snapshot: resumeFixture('t', [turn('start')]), cursor: cursor(3) });
  assert.equal(state.turns[0].items[0].text, 'start哈');
  applyNativeEvent(state, message(4, '哈')); assert.equal(state.turns[0].items[0].text, 'start哈');
  applyNativeEvent(state, message(7, '哈')); assert.equal(state.turns[0].items[0].text, 'start哈哈');
  applyNativeEvent(state, { kind: 'notification', cursor: cursor(8), native: { method: 'item/completed', params: { threadId: 't', turnId: 'turn', item: { id: 'a', type: 'agentMessage', text: 'authoritative' } } } });
  assert.equal(state.turns[0].items[0].text, 'authoritative');
  installSnapshot(state, { snapshot: resumeFixture('t', [turn('stale HTTP')]), cursor: cursor(3) });
  assert.equal(state.turns[0].items[0].text, 'authoritative');
  // Delayed HTML/file enrichment never overwrites newer native text.
  applyNativeEvent(state, { kind: 'render', cursor: cursor(4), native: { threadId: 't', items: [{ id: 'a', text: 'start哈', html: '<p>stale</p>', cursor: cursor(4) }] } });
  assert.notEqual(state.turns[0].items[0].html, '<p>stale</p>');
  applyNativeEvent(state, { kind: 'notification', cursor: cursor(9), native: { method: 'item/completed', params: { threadId: 't', turnId: 'turn', item: { id: 'cmd', type: 'commandExecution', command: 'true', status: 'completed' } } } });
  applyNativeEvent(state, { kind: 'notification', cursor: cursor(10), native: { method: 'turn/completed', params: { threadId: 't', turn: { id: 'turn', status: 'completed', itemsView: 'summary', items: [{ id: 'a', type: 'agentMessage', text: 'final' }] } } } });
  assert.equal(state.turns[0].items.find(i => i.id === 'a').text, 'final');
  assert.equal(state.turns[0].items.some(i => i.id === 'cmd'), true);
});

test('generation changes demand resync and older history prepends without replacing current items', () => {
  const state = createChatState('t');
  installSnapshot(state, { snapshot: resumeFixture('t', [turn('latest')]), cursor: cursor(10) });
  prependHistory(state, { data: [{ id: 'older', status: 'completed', items: [] }, turn('stale')], nextCursor: 'opaque' });
  assert.deepEqual(state.turns.map(t => t.id), ['older', 'turn']); assert.equal(state.turns[1].items[0].text, 'latest');
  assert.equal(state.historyCursor, 'opaque');
  applyNativeEvent(state, { ...message(1, 'new generation'), cursor: { generation: 2, seq: 1 } });
  assert.equal(state.resync, true); assert.equal(state.ready, false);
  installSnapshot(state, { snapshot: resumeFixture('t', [turn('new')]), cursor: { generation: 2, seq: 2 } });
  assert.equal(state.turns[0].items[0].text, 'new'); assert.equal(state.resync, false);
});

test('submit guards are synchronous; failures and newer drafts survive uncertain or successful sends', () => {
  const state = createChatState('t'); state.draft = 'original';
  const submission = beginSend(state);
  assert.throws(() => beginSend(state), { code: 'SEND_PENDING' });
  settleSend(state, submission.id, { ok: false, unknown: true });
  assert.equal(state.draft, 'original'); assert.equal(state.pending.unknown, true);
  assert.throws(() => beginSend(state), { code: 'SEND_PENDING' });
  state.pending = null;
  const next = beginSend(state); state.draft = 'edited while sending';
  settleSend(state, next.id, { ok: true }); assert.equal(state.draft, 'edited while sending');
  const final = beginSend(state); settleSend(state, final.id, { ok: false });
  assert.equal(state.draft, 'edited while sending');
  state.composing = true; const composing = beginSend(state);
  settleSend(state, composing.id, { ok: true }); assert.equal(state.draft, 'edited while sending');
});

test('mounted slash submission locks synchronously and preserves newer drafts on success or failure', async t => {
  const dom = domFixture(); let chat, rejectCommand, resolveCommand; const calls = [];
  t.after(() => { chat?.dispose(); dom.restore(); });
  const api = async (path, body) => {
    if (path === '/api/thread/open') return { snapshot: resumeFixture(body.threadId), cursor: cursor(1) };
    if (path === '/api/rpc') return { result: { data: [], nextCursor: null } };
    calls.push(path); return new Promise((resolve, reject) => { resolveCommand = resolve; rejectCommand = reject; });
  };
  chat = mountChat({ api, viewId: 'view', defaultCwd: '/tmp', uploadLimitBytes: 32 }); chat.connection(true); await chat.open('t');
  const state = chat.getState(); state.draft = '/fork'; dom.get('draft').value = state.draft;
  dom.event('composer', 'submit'); dom.event('composer', 'submit');
  assert.deepEqual(calls, ['/api/thread/fork']); assert.equal(dom.get('send').disabled, true);
  rejectCommand(new Error('native refused')); await delay(0);
  assert.equal(state.draft, '/fork'); assert.equal(dom.get('send').disabled, false);
  state.draft = '/compact'; dom.event('composer', 'submit'); dom.event('composer', 'submit');
  assert.deepEqual(calls, ['/api/thread/fork', '/api/thread/compact']);
  state.draft = 'newer draft'; resolveCommand({}); await delay(0);
  assert.equal(state.draft, 'newer draft'); assert.equal(dom.get('send').disabled, false);
  state.pending = { id: 'message-in-flight' }; state.draft = '/compact'; dom.event('composer', 'submit');
  assert.equal(calls.length, 2);
});

test('new and forked selections update the URL and reload the visible conversation', async t => {
  const dom = domFixture(); let chat, seq = 0; const opened = [];
  t.after(() => { chat?.dispose(); dom.restore(); });
  const api = async (path, body) => {
    if (path === '/api/rpc') return { result: { data: [], nextCursor: null } };
    const id = path === '/api/thread/start' ? 'new' : path === '/api/thread/fork' ? 'forked' : body.threadId;
    if (path === '/api/thread/open') opened.push(id);
    return { snapshot: resumeFixture(id), cursor: cursor(++seq) };
  };
  const mount = () => mountChat({ api, viewId: 'view', defaultCwd: '/tmp', uploadLimitBytes: 32 });
  chat = mount(); chat.connection(true); await chat.open('t');
  for (const id of ['new', 'forked']) {
    if (id === 'new') dom.get('new-thread').click();
    else { chat.getState().draft = '/fork'; dom.event('composer', 'submit'); }
    await delay(0); assert.equal(chat.getState().threadId, id);
    assert.equal(new URL(dom.location.href).searchParams.get('thread'), id);
    chat.dispose(); chat = mount(); chat.connection(true); await chat.load();
    assert.equal(opened.at(-1), id); assert.equal(chat.getState().threadId, id);
  }
});

test('reconnection refreshes native project and conversation lists without a selected chat', async t => {
  const dom = domFixture(); dom.location.href = 'https://fixture.test/'; let chat; const reads = [];
  t.after(() => { chat?.dispose(); dom.restore(); });
  const api = async (path, body) => { assert.equal(path, '/api/rpc'); reads.push(body.method); return { result: { data: [], nextCursor: null } }; };
  chat = mountChat({ api, viewId: 'view', uploadLimitBytes: 32 }); chat.connection(true); await chat.load();
  const before = reads.length;
  chat.onEvent({ kind: 'status', cursor: cursor(1), native: { online: false } });
  chat.onEvent({ kind: 'status', cursor: cursor(2), native: { online: true } }); await delay(0);
  const refreshed = reads.slice(before); assert.ok(refreshed.includes('project/list')); assert.ok(refreshed.includes('thread/list'));
  assert.equal(chat.getState(), undefined);
});

test('IME confirmation, mobile Enter and Shift+Enter never send a draft', () => {
  assert.equal(shouldSubmitKey({ key: 'Enter' }, { composing: false, finePointer: true }), true);
  for (const event of [{ key: 'Enter', isComposing: true }, { key: 'Enter', keyCode: 229 }, { key: 'Enter', shiftKey: true }]) {
    assert.equal(shouldSubmitKey(event, { composing: false, finePointer: true }), false);
  }
  assert.equal(shouldSubmitKey({ key: 'Enter' }, { composing: true, finePointer: true }), false);
  assert.equal(shouldSubmitKey({ key: 'Enter' }, { composing: false, finePointer: false }), false);
});

test('server Markdown never executes HTML/unsafe URLs and external images cannot beacon', () => {
  const { items, html } = renderTranscript({ id: 't' }, [{ id: 'v', items: [{ id: 'a', type: 'agentMessage',
    text: '<script>evil()</script> [bad](javascript:alert(1)) [file](file:///etc/passwd) ![remote](https://evil.test/beacon) [safe](https://example.com)' }] }]);
  assert.equal(items.length, 1); assert.doesNotMatch(html, /<script|href="(?:javascript|file):|<img/);
  assert.match(html, /&lt;script&gt;/); assert.match(html, /rel="noopener noreferrer"/);
});

test('new browser threads use full defaults and are named before their atomic resume', async t => {
  const f = await httpsFixture(); t.after(() => f.close());
  const cookie = await f.login(), viewId = await f.view(cookie), stream = await f.events(cookie, viewId);
  const invalid = await f.request('/api/thread/start', { method: 'POST', cookie, body: { viewId, cwd: f.dir + '/missing-directory' } });
  assert.equal(invalid.status, 400); assert.equal(f.peer.sent.some(m => m.method === 'thread/start'), false);
  const pending = f.request('/api/thread/start', { method: 'POST', cookie, body: { viewId } });
  await waitCall(f.peer, 'thread/start');
  const start = f.peer.sent.find(m => m.method === 'thread/start');
  assert.equal(start.params.approvalPolicy, 'never'); assert.equal(start.params.sandbox, 'danger-full-access');
  f.peer.replyTo('thread/start', resumeFixture('t'));
  await waitCall(f.peer, 'thread/name/set'); assert.equal(f.peer.sent.at(-1).params.name, '新会话');
  f.peer.replyTo('thread/name/set', {});
  await waitCall(f.peer, 'thread/resume'); f.peer.replyTo('thread/resume', resumeFixture('t'));
  const response = await pending; assert.equal(response.status, 200); assert.equal(response.json.snapshot.thread.id, 't');
  stream.req.destroy();
});

test('HTTP resume snapshot stays pinned to its frame even when the following delta arrives before its awaiter', async t => {
  const f = await httpsFixture(); t.after(() => f.close());
  const cookie = await f.login(), viewId = await f.view(cookie), stream = await f.events(cookie, viewId);
  const pending = f.request('/api/thread/open', { method: 'POST', cookie, body: { viewId, threadId: 't' } });
  await waitCall(f.peer, 'thread/resume');
  f.peer.replyTo('thread/resume', resumeFixture('t', [turn('before')]));
  f.peer.notify('item/agentMessage/delta', { threadId: 't', turnId: 'turn', itemId: 'a', delta: 'after' });
  const response = await pending;
  assert.equal(response.status, 200); assert.equal(response.json.snapshot.transcript.items[0].text, 'before');
  await delay(120); assert.match(stream.text(), /"delta":"after"/);
  stream.req.destroy();
});

test('duplicate browser sends correlate once; uncertain sent writes stay locked instead of replaying', async t => {
  const f = await httpsFixture(); t.after(() => f.close());
  const cookie = await f.login(), viewId = await f.view(cookie), stream = await f.events(cookie, viewId);
  await open(f, cookie, viewId);
  const body = { viewId, threadId: 't', draft: { text: 'hello' }, mode: 'start', clientUserMessageId: 'message-1' };
  const one = f.request('/api/thread/send', { method: 'POST', cookie, body });
  const two = f.request('/api/thread/send', { method: 'POST', cookie, body });
  await waitCall(f.peer, 'turn/start'); await delay(20);
  assert.equal(f.peer.sent.filter(m => m.method === 'turn/start').length, 1);
  f.peer.replyTo('turn/start', { turn: turn() });
  assert.equal((await one).status, 200); assert.equal((await two).status, 200);
  const uncertainBody = { ...body, clientUserMessageId: 'message-2' };
  const uncertain = f.request('/api/thread/send', { method: 'POST', cookie, body: uncertainBody });
  for (let i = 0; i < 100 && f.peer.sent.filter(m => m.method === 'turn/start').length < 2; i++) await delay(5);
  f.peer.disconnect();
  const failure = await uncertain; assert.equal(failure.json.error.outcome, 'unknown');
  assert.equal((await f.request('/api/thread/send', { method: 'POST', cookie, body: uncertainBody })).status, 409);
  stream.req.destroy();
});

test('rapid A-B-C navigation cannot retain a superseded middle conversation', async t => {
  const f = await httpsFixture(); t.after(() => f.close());
  const cookie = await f.login(), viewId = await f.view(cookie), stream = await f.events(cookie, viewId);
  const request = threadId => f.request('/api/thread/open', { method: 'POST', cookie, body: { viewId, threadId } }).catch(() => null);
  const first = request('a'); await waitCall(f.peer, 'thread/resume');
  const a = f.peer.sent.find(m => m.method === 'thread/resume');
  const middle = request('b'); await delay(15); const last = request('c'); await delay(20);
  f.peer.replyTo('thread/resume', resumeFixture('c')); assert.equal((await last).status, 200);
  f.peer.emit({ id: a.id, result: resumeFixture('a', [turn()]) });
  await delay(25);
  assert.equal(f.peer.sent.some(m => m.method === 'thread/resume' && m.params.threadId === 'b'), false);
  assert.equal((await middle).status, 409); assert.equal((await first).status, 409);
  stream.req.destroy();
});

test('steer and stop use the active ID; queued work changes only future permission defaults', async t => {
  const f = await httpsFixture(); t.after(() => f.close());
  const cookie = await f.login(), viewId = await f.view(cookie), stream = await f.events(cookie, viewId);
  const opening = f.request('/api/thread/open', { method: 'POST', cookie, body: { viewId, threadId: 't' } });
  await waitCall(f.peer, 'thread/resume');
  const snapshot = resumeFixture('t', [turn()]); snapshot.approvalPolicy = 'on-request'; snapshot.sandbox = { type: 'workspaceWrite' };
  f.peer.replyTo('thread/resume', snapshot); assert.equal((await opening).status, 200);
  const body = { viewId, threadId: 't', draft: { text: 'extra' }, clientUserMessageId: 'steer-message', mode: 'start' };
  assert.equal((await f.request('/api/thread/send', { method: 'POST', cookie, body })).status, 409);
  const steer = f.request('/api/thread/send', { method: 'POST', cookie, body: { ...body, mode: 'steer' } });
  await waitCall(f.peer, 'turn/steer');
  assert.equal(f.peer.sent.at(-1).params.expectedTurnId, 'turn'); assert.equal('sandboxPolicy' in f.peer.sent.at(-1).params, false);
  f.peer.replyTo('turn/steer', { turnId: 'turn' }); assert.equal((await steer).status, 200);
  const queue = f.request('/api/thread/send', { method: 'POST', cookie, body: { ...body, mode: 'queue', clientUserMessageId: 'queued-message' } }).catch(() => null);
  await delay(25);
  assert.equal(f.peer.sent.at(-1).method, 'thread/settings/update');
  const settings = f.peer.sent.at(-1).params;
  assert.deepEqual(settings, { threadId: 't', approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } });
  f.peer.replyTo('thread/settings/update', {}); await delay(15);
  assert.equal(f.peer.sent.some(m => m.method === 'thread/queue/add'), false);
  f.peer.notify('thread/settings/updated', { threadId: 't', threadSettings: { model: 'fixture-model', effort: 'low', cwd: f.dir, approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } } });
  await waitCall(f.peer, 'thread/queue/add');
  assert.equal('model' in f.peer.sent.at(-1).params, false); assert.equal('sandboxPolicy' in f.peer.sent.at(-1).params, false);
  f.peer.replyTo('thread/queue/add', { queuedSubmission: { clientUserMessageId: 'queued-message' } }); assert.equal((await queue).status, 200);
  const stop = f.request('/api/thread/stop', { method: 'POST', cookie, body: { viewId, threadId: 't', turnId: 'turn' } });
  await waitCall(f.peer, 'turn/interrupt'); assert.deepEqual(f.peer.sent.at(-1).params, { threadId: 't', turnId: 'turn' });
  f.peer.replyTo('turn/interrupt', {}); assert.equal((await stop).status, 200);
  stream.req.destroy();
});
