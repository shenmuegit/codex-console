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
  const dom = domFixture(), calls = [], goals = new Map([['t', initial]]); let seq = 5, chat;
  const api = async (path, body) => {
    calls.push({ path, body });
    if (path === '/api/thread/open') return { snapshot: resumeFixture(body.threadId), cursor: { generation: 1, seq: 1 } };
    if (path === '/api/thread/goal') {
      if (handler) return handler(body);
      let current = goals.get(body.threadId) ?? null;
      if (body.action === 'set') current = goal({ ...current, threadId: body.threadId, objective: body.objective });
      if (body.action === 'pause' || body.action === 'resume') current = { ...current, status: body.action === 'pause' ? 'paused' : 'active' };
      if (body.action === 'clear') current = null;
      goals.set(body.threadId, current); return { result: { goal: current }, cursor: { generation: 1, seq: seq++ } };
    }
    return { result: { data: [], nextCursor: null } };
  };
  chat = mountChat({ api, viewId: 'view', uploadLimitBytes: 32 }); chat.connection(true); await chat.open('t'); await delay(0);
  t.after(() => { chat.dispose(); dom.restore(); });
  return { dom, chat, calls, input(text) { chat.getState().draft = dom.get('draft').value = text; dom.get('draft').setSelectionRange(text.length, text.length); dom.event('draft', 'input'); },
    async command(text) { this.input(text); dom.event('composer', 'submit'); await delay(0); }, writes: () => calls.filter(call => call.path === '/api/thread/goal' && call.body.action !== 'get') };
}

test('slash goal can be found by its Chinese description and parses objective text', async t => {
  assert.deepEqual(commandAction('/goal 完成项目检查'), { command: 'goal', args: '完成项目检查' });
  const dom = domFixture(), state = { ready: true, generation: 1, settings: {}, selections: [] }; dom.get('draft').value = '/目标'; dom.get('draft').setSelectionRange(3, 3);
  const menu = mountCompletions({ api: async () => assert.fail('Commands are local'), getState: () => state, onChange() {} });
  t.after(() => { menu.dispose(); dom.restore(); }); await menu.refresh(); assert.match(dom.get('completion-menu').textContent, /goal.*目标/);
});

test('choosing goal enters the existing composer immediately with a goal chip and no modal', async t => {
  const f = await chatFixture(t, null); f.input('/go'); await delay(0); f.dom.event('draft', 'keydown', { key: 'Enter' }); await delay(0);
  assert.equal(f.dom.get('goal-dialog')?.open ?? false, false, 'Choosing /goal must stay in the chat composer');
  assert.equal(f.dom.get('goal-mode').hidden, false); assert.match(f.dom.get('draft').placeholder, /描述你的目标/);
  assert.equal(f.dom.get('draft').value, ''); assert.equal(f.dom.document.activeElement, f.dom.get('draft'));
  assert.equal(f.calls.some(call => call.path === '/api/thread/send'), false); assert.equal(f.writes().length, 0);
});

test('sending a goal from the composer writes once, clears goal mode, and shows the inline status bar', async t => {
  const writing = deferred(); const f = await chatFixture(t, null, async body => body.action === 'get' ? { result: { goal: null }, cursor: { generation: 1, seq: 5 } } : writing.promise);
  await f.command('/goal'); f.input('  新目标  '); f.dom.event('composer', 'submit'); f.dom.event('composer', 'submit'); await delay(0);
  assert.deepEqual(f.writes().map(call => call.body), [{ viewId: 'view', threadId: 't', action: 'set', objective: '新目标' }]);
  writing.resolve({ result: { goal: goal({ objective: '新目标' }) }, cursor: { generation: 1, seq: 6 } }); await delay(0);
  assert.equal(f.dom.get('goal-mode').hidden, true); assert.equal(f.dom.get('draft').value, ''); assert.equal(f.dom.get('goal-status').hidden, false);
  assert.equal(f.dom.get('draft').placeholder, '与 Codex 协作');
  assert.match(f.dom.get('goal-title').textContent, /进行中的目标/); assert.match(f.dom.get('goal-progress').textContent, /继续/);
  await f.command('继续聊天'); assert.equal(f.calls.filter(call => call.path === '/api/thread/send').length, 1);
});

test('existing native goals load into the status bar when the conversation opens', async t => {
  const f = await chatFixture(t); assert.equal(f.dom.get('goal-status').hidden, false); assert.equal(f.dom.get('goal-mode').hidden, true);
  assert.match(f.dom.get('goal-details').textContent, /完成项目检查/); assert.match(f.dom.get('goal-details').textContent, /1,200.*10,000/);
  f.dom.get('goal-expand').click(); assert.equal(f.dom.get('goal-details').hidden, false);
});

test('edit fills the shared composer and preserves native paused status and budget when sent', async t => {
  const f = await chatFixture(t, goal({ status: 'paused' })); await f.command('/goal edit');
  assert.equal(f.dom.get('draft').value, '完成项目检查'); assert.equal(f.dom.get('goal-mode').hidden, false);
  await f.command('新的目标文字'); assert.deepEqual(f.writes().at(-1).body, { viewId: 'view', threadId: 't', action: 'set', objective: '新的目标文字' });
  assert.match(f.dom.get('goal-title').textContent, /已暂停/); assert.match(f.dom.get('goal-details').textContent, /10,000/);
});

test('inline pause/resume/clear operate on the goal without entering goal mode', async t => {
  const f = await chatFixture(t); f.dom.get('goal-toggle').click(); await delay(0); f.dom.get('goal-toggle').click(); await delay(0);
  assert.deepEqual(f.writes().map(call => call.body.action), ['pause', 'resume']); assert.equal(f.dom.get('goal-mode').hidden, true);
  window.confirm = () => false; f.dom.get('goal-clear').click(); await delay(0); assert.equal(f.writes().length, 2);
  window.confirm = () => true; f.dom.get('goal-clear').click(); await delay(0); assert.equal(f.writes().at(-1).body.action, 'clear'); assert.equal(f.dom.get('goal-status').hidden, true);
});

test('goal mode can be cancelled without losing the draft and stays scoped to its conversation', async t => {
  const f = await chatFixture(t, null); await f.command('/goal'); f.input('保留的草稿');
  await f.chat.open('other'); assert.equal(f.dom.get('goal-mode').hidden, true); await f.chat.open('t'); await delay(0);
  assert.equal(f.dom.get('goal-mode').hidden, false); assert.equal(f.dom.get('draft').value, '保留的草稿');
  f.dom.get('goal-mode').click(); assert.equal(f.dom.get('goal-mode').hidden, true); assert.equal(f.dom.get('draft').value, '保留的草稿');
});

test('goal SSE updates usage without replacing the composer draft, and conflicting changes require checking', async t => {
  const f = await chatFixture(t); await f.command('/goal edit'); f.input('未保存的修改');
  f.chat.onEvent({ kind: 'notification', cursor: { generation: 1, seq: 20 }, native: { method: 'thread/goal/updated', params: { threadId: 't', turnId: null, goal: goal({ tokensUsed: 2400 }) } } }); await delay(0);
  assert.match(f.dom.get('goal-details').textContent, /2,400/); assert.equal(f.dom.get('draft').value, '未保存的修改');
  f.chat.onEvent({ kind: 'notification', cursor: { generation: 1, seq: 21 }, native: { method: 'thread/goal/cleared', params: { threadId: 't' } } }); await delay(0);
  assert.equal(f.dom.get('send').disabled, true); assert.equal(f.dom.get('goal-check').hidden, false);
});

test('a late goal read cannot overwrite a newer goal notification', async t => {
  const response = deferred(), f = await chatFixture(t, null, () => response.promise);
  f.chat.onEvent({ kind: 'notification', cursor: { generation: 1, seq: 20 }, native: { method: 'thread/goal/updated', params: { threadId: 't', goal: goal({ tokensUsed: 2400 }) } } });
  response.resolve({ result: { goal: goal() }, cursor: { generation: 1, seq: 10 } }); await delay(0);
  assert.match(f.dom.get('goal-details').textContent, /2,400/);
});

test('ordinary message deltas keep the unchanged goal title and progress DOM intact', async t => {
  const f = await chatFixture(t), title = f.dom.get('goal-title').firstChild, progress = f.dom.get('goal-progress').firstChild;
  f.chat.onEvent({ kind: 'notification', cursor: { generation: 1, seq: 20 }, native: { method: 'item/agentMessage/delta', params: { threadId: 't', turnId: 'turn', itemId: 'message', delta: '回答' } } }); await delay(0);
  assert.equal(f.dom.get('goal-title').firstChild, title); assert.equal(f.dom.get('goal-progress').firstChild, progress);
});

test('empty native mutation replies are reconciled with one read and never another write', async t => {
  let reads = 0; const f = await chatFixture(t, null, async body => body.action === 'get' ? { result: { goal: ++reads === 1 ? null : goal({ objective: '新目标' }) }, cursor: { generation: 1, seq: reads * 5 } } : { result: {}, cursor: { generation: 1, seq: 6 } });
  await f.command('/goal'); await f.command('新目标'); assert.equal(f.writes().length, 1); assert.equal(reads, 2); assert.equal(f.dom.get('draft').value, '');
});

test('switching conversations or disconnecting invalidates a goal command still waiting for its read', async t => {
  for (const change of ['thread', 'connection']) await t.test(change, async t => {
    const response = deferred(), f = await chatFixture(t, null, () => response.promise); await f.command('/goal 不应发送');
    if (change === 'thread') await f.chat.open('other'); else f.chat.connection(false);
    response.resolve({ result: { goal: null }, cursor: { generation: 1, seq: 5 } }); await delay(0); assert.equal(f.writes().length, 0);
  });
});

test('failed goal writes keep the objective in the composer for correction', async t => {
  const f = await chatFixture(t, null, async body => { if (body.action === 'get') return { result: { goal: null }, cursor: { generation: 1, seq: 5 } }; throw Object.assign(Error('原生目标不可用'), { status: 400 }); });
  await f.command('/goal'); await f.command('不能丢失的目标'); assert.equal(f.dom.get('draft').value, '不能丢失的目标'); assert.equal(f.dom.get('goal-mode').hidden, false); assert.match(f.dom.get('goal-error').textContent, /原生目标不可用/);
  assert.equal(f.calls.some(call => call.path === '/api/thread/send'), false);
});

test('uncertain goal writes require an explicit read and reconcile an accepted objective without retrying', async t => {
  let accepted = false; const f = await chatFixture(t, null, async body => { if (body.action === 'get') return { result: { goal: accepted ? goal({ objective: '保留目标' }) : null }, cursor: { generation: 1, seq: accepted ? 9 : 5 } }; accepted = true; throw Object.assign(Error('连接中断'), { status: 503, outcome: 'unknown' }); });
  await f.command('/goal'); await f.command('保留目标'); assert.equal(f.dom.get('send').disabled, true); assert.equal(f.dom.get('goal-check').hidden, false);
  f.dom.event('composer', 'submit'); await delay(0); assert.equal(f.writes().length, 1);
  f.dom.get('goal-check').click(); await delay(0); assert.equal(f.writes().length, 1); assert.equal(f.dom.get('draft').value, ''); assert.equal(f.dom.get('goal-mode').hidden, true);
});

test('checking an uncertain write uses the newer accepted SSE goal even when the read reply is older', async t => {
  const writing = deferred(), f = await chatFixture(t, null, async body => body.action === 'get' ? { result: { goal: null }, cursor: { generation: 1, seq: 5 } } : writing.promise);
  await f.command('/goal'); await f.command('保留目标');
  f.chat.onEvent({ kind: 'notification', cursor: { generation: 1, seq: 20 }, native: { method: 'thread/goal/updated', params: { threadId: 't', goal: goal({ objective: '保留目标' }) } } });
  writing.resolve(Promise.reject(Object.assign(Error('连接中断'), { status: 503, outcome: 'unknown' }))); await delay(0);
  f.dom.get('goal-check').click(); await delay(0); assert.equal(f.dom.get('draft').value, ''); assert.equal(f.dom.get('goal-mode').hidden, true); assert.equal(f.writes().length, 1);
});

test('goal objectives never silently discard attached files or bound mentions', async t => {
  const f = await chatFixture(t); await f.command('/goal'); f.chat.getState().attachments.push({ id: 'upload', status: 'complete' }); await f.command('带附件的目标');
  assert.equal(f.writes().length, 0); assert.equal(f.calls.some(call => call.path === '/api/thread/send'), false); assert.equal(f.chat.getState().attachments.length, 1); assert.match(f.dom.get('goal-error').textContent, /先.*会话消息/);
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
