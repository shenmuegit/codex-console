import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mountChat } from '../public/chat.js';
import { commandAction, mountCompletions } from '../public/composer.js';
import { domFixture } from './dom.mjs';
import { httpsFixture, resumeFixture } from './helpers.mjs';

const goal = (overrides = {}) => ({ threadId: 't', objective: '完成项目检查', status: 'active', tokenBudget: 10000, tokensUsed: 1200, timeUsedSeconds: 65, createdAt: 1, updatedAt: 2, ...overrides });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
async function chatFixture(t, initial = goal(), handler) {
  const dom = domFixture(), calls = []; let current = initial, seq = 5, chat;
  const api = async (path, body) => {
    calls.push({ path, body });
    if (path === '/api/thread/open') return { snapshot: resumeFixture(body.threadId), cursor: { generation: 1, seq: 1 } };
    if (path === '/api/thread/goal') {
      if (handler) return handler(body);
      if (body.action === 'set') current = goal({ ...current, objective: body.objective });
      if (body.action === 'pause' || body.action === 'resume') current = { ...current, status: body.action === 'pause' ? 'paused' : 'active' };
      if (body.action === 'clear') current = null;
      return { result: { goal: current }, cursor: { generation: 1, seq: seq++ } };
    }
    return { result: { data: [], nextCursor: null } };
  };
  chat = mountChat({ api, viewId: 'view', uploadLimitBytes: 32 }); chat.connection(true); await chat.open('t');
  t.after(() => { chat.dispose(); dom.restore(); });
  return { dom, chat, calls, async command(text) { chat.getState().draft = dom.get('draft').value = text; dom.get('draft').setSelectionRange(text.length, text.length); dom.event('composer', 'submit'); await delay(0); }, writes: () => calls.filter(call => call.path === '/api/thread/goal' && call.body.action !== 'get') };
}

test('slash goal can be found by its Chinese description and parses objective text', async t => {
  assert.deepEqual(commandAction('/goal 完成项目检查'), { command: 'goal', args: '完成项目检查' });
  const dom = domFixture(), state = { ready: true, generation: 1, settings: {}, selections: [] }; dom.get('draft').value = '/目标'; dom.get('draft').setSelectionRange(3, 3);
  const menu = mountCompletions({ api: async () => assert.fail('Commands are local'), getState: () => state, onChange() {} });
  t.after(() => { menu.dispose(); dom.restore(); }); await menu.refresh();
  assert.match(dom.get('completion-menu').textContent, /goal.*目标/);
});

test('bare goal opens the native objective and usage without sending a chat message', async t => {
  const f = await chatFixture(t); await f.command('/goal');
  assert.equal(f.calls.some(call => call.path === '/api/thread/goal'), true); assert.equal(f.calls.some(call => call.path === '/api/thread/send'), false);
  assert.equal(f.dom.get('goal-dialog').open, true); assert.equal(f.dom.get('goal-objective').value, '完成项目检查');
  assert.match(f.dom.get('goal-summary').textContent, /进行中/); assert.match(f.dom.get('goal-summary').textContent, /1,200/); assert.match(f.dom.get('goal-summary').textContent, /10,000/);
});

test('a new objective saves once and the edit command focuses the objective', async t => {
  const f = await chatFixture(t, null); await f.command('/goal');
  f.dom.get('goal-objective').value = '  新目标  '; f.dom.event('goal-form', 'submit'); f.dom.event('goal-form', 'submit'); await delay(0);
  assert.deepEqual(f.writes().map(call => call.body), [{ viewId: 'view', threadId: 't', action: 'set', objective: '新目标' }]);
  assert.equal(f.dom.get('goal-objective').value, '新目标');
  await f.command('/goal edit'); assert.equal(f.dom.document.activeElement, f.dom.get('goal-objective'));
});

test('editing a paused goal preserves native status and budget rather than resuming it', async t => {
  const f = await chatFixture(t, goal({ status: 'paused' })); await f.command('/goal 新的目标文字');
  assert.deepEqual(f.writes().at(-1).body, { viewId: 'view', threadId: 't', action: 'set', objective: '新的目标文字' });
  assert.match(f.dom.get('goal-summary').textContent, /已暂停/); assert.match(f.dom.get('goal-summary').textContent, /10,000/);
});

test('goal pause and resume use goal operations, and clear requires confirmation', async t => {
  const f = await chatFixture(t); await f.command('/goal pause'); await f.command('/goal resume');
  assert.deepEqual(f.writes().map(call => call.body.action), ['pause', 'resume']);
  window.confirm = () => false; await f.command('/goal clear'); assert.equal(f.writes().length, 2);
  window.confirm = () => true; await f.command('/goal clear'); assert.equal(f.writes().at(-1).body.action, 'clear'); assert.match(f.dom.get('goal-summary').textContent, /尚未设置/);
});

test('goal SSE updates usage without replacing a locally edited objective, and cleared goals stay cleared', async t => {
  const f = await chatFixture(t); await f.command('/goal'); f.dom.get('goal-objective').value = '未保存的修改'; f.dom.event('goal-objective', 'input');
  f.chat.onEvent({ kind: 'notification', cursor: { generation: 1, seq: 20 }, native: { method: 'thread/goal/updated', params: { threadId: 't', turnId: null, goal: goal({ tokensUsed: 2400 }) } } }); await delay(0);
  assert.match(f.dom.get('goal-summary').textContent, /2,400/); assert.equal(f.dom.get('goal-objective').value, '未保存的修改');
  f.chat.onEvent({ kind: 'notification', cursor: { generation: 1, seq: 21 }, native: { method: 'thread/goal/cleared', params: { threadId: 't' } } }); await delay(0);
  assert.match(f.dom.get('goal-summary').textContent, /尚未设置/); assert.equal(f.dom.get('goal-save').disabled, true);
});

test('a late goal read cannot overwrite a newer goal notification', async t => {
  const response = deferred(), f = await chatFixture(t, null, () => response.promise); await f.command('/goal');
  f.chat.onEvent({ kind: 'notification', cursor: { generation: 1, seq: 20 }, native: { method: 'thread/goal/updated', params: { threadId: 't', goal: goal({ tokensUsed: 2400 }) } } });
  response.resolve({ result: { goal: goal() }, cursor: { generation: 1, seq: 10 } }); await delay(0);
  assert.match(f.dom.get('goal-summary').textContent, /2,400/);
});

test('ordinary message deltas keep the unchanged goal summary DOM intact', async t => {
  const f = await chatFixture(t); await f.command('/goal'); const summary = f.dom.get('goal-summary').firstChild;
  f.chat.onEvent({ kind: 'notification', cursor: { generation: 1, seq: 20 }, native: { method: 'item/agentMessage/delta', params: { threadId: 't', turnId: 'turn', itemId: 'message', delta: '回答' } } }); await delay(0);
  assert.equal(f.dom.get('goal-summary').firstChild, summary);
});

test('empty native mutation replies are reconciled with one read and never another write', async t => {
  let reads = 0;
  const f = await chatFixture(t, null, async body => body.action === 'get' ? { result: { goal: ++reads === 1 ? null : goal({ objective: '新目标' }) }, cursor: { generation: 1, seq: reads * 5 } } : { result: {}, cursor: { generation: 1, seq: 6 } });
  await f.command('/goal 新目标'); assert.equal(f.writes().length, 1); assert.equal(reads, 2); assert.equal(f.dom.get('goal-objective').value, '新目标');
});

test('switching conversations or disconnecting invalidates a pending goal command', async t => {
  for (const change of ['thread', 'connection']) await t.test(change, async t => {
    const response = deferred(), f = await chatFixture(t, null, () => response.promise); await f.command('/goal 不应发送');
    if (change === 'thread') await f.chat.open('other'); else f.chat.connection(false);
    response.resolve({ result: { goal: null }, cursor: { generation: 1, seq: 5 } }); await delay(0);
    assert.equal(f.writes().length, 0); assert.notEqual(f.dom.get('goal-dialog').open, true);
  });
});

test('failed goal writes keep the objective for correction and never send a model message', async t => {
  const f = await chatFixture(t, null, async body => { if (body.action === 'get') return { result: { goal: null }, cursor: { generation: 1, seq: 5 } }; throw Object.assign(Error('原生目标不可用'), { status: 400 }); });
  await f.command('/goal 不能丢失的目标'); assert.equal(f.dom.get('goal-objective').value, '不能丢失的目标'); assert.match(f.dom.get('goal-error').textContent, /原生目标不可用/);
  assert.equal(f.calls.some(call => call.path === '/api/thread/send'), false);
});

test('failed initial goal reads and uncertain writes disable mutations until the goal is reopened', async t => {
  for (const phase of ['get', 'set']) await t.test(phase, async t => {
    const f = await chatFixture(t, null, async body => { if (body.action === phase) throw Object.assign(Error('连接中断'), { status: 503, outcome: 'unknown' }); return { result: { goal: null }, cursor: { generation: 1, seq: 5 } }; });
    await f.command('/goal 保留目标'); assert.equal(f.dom.get('goal-save').disabled, true);
    const count = f.writes().length; f.dom.event('goal-form', 'submit'); await delay(0); assert.equal(f.writes().length, count);
  });
});

test('goal objectives never silently discard attached files or bound mentions', async t => {
  const f = await chatFixture(t); f.chat.getState().attachments.push({ id: 'upload', status: 'complete' }); await f.command('/goal 带附件的目标');
  assert.equal(f.writes().length, 0); assert.equal(f.calls.some(call => call.path === '/api/thread/send'), false); assert.equal(f.chat.getState().attachments.length, 1);
  assert.match(f.dom.get('chat-error').textContent, /先.*会话消息/);
});

test('native goal gateway validates the opened view, actions and objective before any mutation', async t => {
  const f = await httpsFixture(); t.after(() => f.close()); const cookie = await f.login(), viewId = await f.view(cookie), stream = await f.events(cookie, viewId); t.after(() => stream.req.destroy());
  const opening = f.request('/api/thread/open', { method: 'POST', cookie, body: { viewId, threadId: 't' } });
  for (let n = 0; n < 100 && !f.peer.sent.some(call => call.method === 'thread/resume'); n++) await delay(5);
  f.peer.replyTo('thread/resume', resumeFixture('t')); await opening;
  for (const [change, status] of [[{ threadId: 'other' }, 403], [{ action: 'anything' }, 400], [{ action: 'set', objective: ' ' }, 400], [{ action: 'set', objective: '中'.repeat(4001) }, 400], [{ action: 'pause', objective: '不要接受多余字段' }, 400], [{ origin: 'agent' }, 400]]) {
    const r = await f.request('/api/thread/goal', { method: 'POST', cookie, body: { viewId, threadId: 't', action: 'get', ...change } }); assert.equal(r.status, status);
  }
  assert.equal(f.peer.sent.some(call => call.method?.startsWith('thread/goal/')), false);
  const results = { 'thread/goal/get': { goal: goal({ status: 'paused' }) }, 'thread/goal/set': { goal: goal({ status: 'paused' }) }, 'thread/goal/clear': { cleared: true } }, answered = new Set();
  const timer = setInterval(() => { for (const call of f.peer.sent) if (results[call.method] && !answered.has(call.id)) { answered.add(call.id); f.peer.emit({ id: call.id, result: results[call.method] }); } }, 5); t.after(() => clearInterval(timer));
  for (const action of ['get', 'set', 'pause', 'resume', 'clear']) {
    const r = await f.request('/api/thread/goal', { method: 'POST', cookie, body: { viewId, threadId: 't', action, ...(action === 'set' ? { objective: '  修改目标  ' } : {}) } }); assert.equal(r.status, 200);
  }
  const calls = f.peer.sent.filter(call => call.method?.startsWith('thread/goal/'));
  assert.deepEqual(calls.map(call => [call.method, call.params]), [
    ['thread/goal/get', { threadId: 't' }], ['thread/goal/set', { threadId: 't', origin: 'user', objective: '修改目标' }],
    ['thread/goal/set', { threadId: 't', origin: 'user', status: 'paused' }], ['thread/goal/set', { threadId: 't', origin: 'user', status: 'active' }], ['thread/goal/clear', { threadId: 't', origin: 'user' }],
  ]);
  const denied = await f.request('/api/rpc', { method: 'POST', cookie, body: { method: 'thread/goal/set', params: { threadId: 't', objective: '绕过会话验证' } } }); assert.equal(denied.status, 403);
});
