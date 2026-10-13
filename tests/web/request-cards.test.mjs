import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mountChat } from '../../web/public/chat.js';
import { domFixture } from './dom.mjs';
import { httpsFixture, resumeFixture } from './helpers.mjs';

const descendants = node => node.children.flatMap(child => [child, ...descendants(child)]);
const controls = (node, type) => descendants(node).filter(child => child.tagName === 'INPUT' && child.type === type);
const button = (node, label) => descendants(node).find(child => child.tagName === 'BUTTON' && child.textContent === label);
async function fixture(t, method, params, turns = [{ id: 'turn', status: 'inProgress', items: [] }]) {
  const dom = domFixture(), calls = []; let resolve, fail;
  const answer = new Promise((yes, no) => { resolve = yes; fail = no; });
  const api = async (path, body) => {
    if (path === '/api/request/respond') { calls.push(body); return answer; }
    if (path === '/api/thread/open') return { snapshot: resumeFixture(body.threadId, turns), cursor: { generation: 1, seq: 1 } };
    return { result: { data: [], nextCursor: null } };
  };
  const chat = mountChat({ api, viewId: 'view', uploadLimitBytes: 32 });
  t.after(() => { chat.dispose(); dom.restore(); }); chat.connection(true); await chat.open('t');
  const native = { method, params: { threadId: 't', turnId: 'turn', itemId: 'item', ...params } };
  chat.onEvent({ kind: 'request', cursor: { generation: 1, seq: 2 }, requestKey: '1:"request"', native }); await delay(0);
  return { dom, chat, calls, native, resolve, fail, card: dom.get('native-requests').children[0],
    async submit() { this.card.dispatchEvent(new Event('submit', { cancelable: true })); await delay(0); },
  };
}

test('question cards show selectable options and descriptions while allowing a custom answer', async t => {
  const f = await fixture(t, 'item/tool/requestUserInput', { isBlocking: true, questions: [{ id: 'approach', header: '方案', question: '选择实现方式', isOther: true, isSecret: false,
    options: [{ label: '最小改动', description: '沿用现有接口' }, { label: '完整重写', description: '替换所有模块' }] }] });
  const radios = controls(f.card, 'radio'); assert.equal(radios.length, 3);
  assert.ok(descendants(f.card).some(node => node.textContent === '沿用现有接口'));
  await f.submit(); assert.equal(f.calls.length, 0, 'An unanswered question must not silently pick the first option');
  radios[0].checked = true; await f.submit();
  assert.deepEqual(f.calls[0].answer.result, { answers: { approach: { answers: ['最小改动'] } } });
  f.resolve({}); await delay(0); assert.equal(f.dom.get('native-requests').children.length, 0);
});

test('custom and secret question answers retain their values when submission fails', async t => {
  const f = await fixture(t, 'item/tool/requestUserInput', { questions: [{ id: 'custom', header: '其他方案', question: '还有其他选择吗？', isOther: true, isSecret: false,
    options: [{ label: '原方案', description: '不修改' }] }, { id: 'secret', header: '口令', question: '输入工具口令', isOther: false, isSecret: true, options: null }] });
  const custom = controls(f.card, 'text')[0], secret = controls(f.card, 'password')[0];
  custom.value = '另一个方案'; custom.dispatchEvent(new Event('input')); secret.value = 'fixture-secret'; await f.submit();
  assert.deepEqual(f.calls[0].answer.result, { answers: { custom: { answers: ['另一个方案'] }, secret: { answers: ['fixture-secret'] } } });
  f.fail(Object.assign(new Error('回答未发送'), { status: 422 })); await delay(0);
  assert.equal(custom.value, '另一个方案'); assert.equal(secret.value, 'fixture-secret');
  assert.ok(descendants(f.card).some(node => node.textContent === '回答未发送')); assert.equal(button(f.card, '提交回答').disabled, false);
});

test('command authorization cards expose native session and policy choices without adding an unavailable allow button', async t => {
  const policy = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['git', 'status'] } };
  const f = await fixture(t, 'item/commandExecution/requestApproval', { kind: 'command', command: 'git status', cwd: '/project', reason: '检查工作区',
    availableDecisions: ['acceptForSession', policy, 'decline', 'cancel'] });
  assert.ok(descendants(f.card).some(node => node.textContent === 'git status')); assert.ok(descendants(f.card).some(node => node.textContent === '/project'));
  assert.equal(button(f.card, '允许一次'), undefined); assert.ok(button(f.card, '允许此会话')); assert.ok(button(f.card, '允许并记住命令规则'));
  await f.submit(); assert.equal(f.calls.length, 0, 'Submitting a form must not invent an unavailable acceptance');
  button(f.card, '允许并记住命令规则').click(); await delay(0); assert.deepEqual(f.calls[0].answer.result, { decision: policy });
  button(f.card, '允许此会话').click(); await delay(0); assert.equal(f.calls.length, 1, 'Pending authorization is sent once'); f.resolve({});
});

test('permission cards grant exactly the requested profile and the user-selected scope', async t => {
  const permissions = { network: { enabled: true }, fileSystem: { write: ['/project/output'] } };
  const f = await fixture(t, 'item/permissions/requestApproval', { reason: '下载并保存文件', cwd: '/project', permissions });
  assert.ok(button(f.card, '允许本轮')); button(f.card, '允许此会话').click(); await delay(0);
  assert.deepEqual(f.calls[0].answer.result, { permissions, scope: 'session' }); f.resolve({});
});

test('terminal input authorization describes the actual action being approved', async t => {
  const f = await fixture(t, 'item/commandExecution/requestApproval', { kind: 'writeStdin', command: 'continue', cwd: '/project', availableDecisions: ['accept', 'decline', 'cancel'] });
  assert.ok(descendants(f.card).some(node => node.textContent === '允许向终端发送输入？'));
  button(f.card, '拒绝').click(); await delay(0); assert.deepEqual(f.calls[0].answer.result, { decision: 'decline' }); f.resolve({});
});

test('native proposed network rules retain their exact host and denial action', async t => {
  const f = await fixture(t, 'item/commandExecution/requestApproval', { command: 'download', cwd: '/project',
    proposedNetworkPolicyAmendments: [{ action: 'deny', host: 'example.com' }] });
  button(f.card, '始终拒绝访问 example.com').click(); await delay(0);
  assert.deepEqual(f.calls[0].answer.result, { decision: { applyNetworkPolicyAmendment: { network_policy_amendment: { action: 'deny', host: 'example.com' } } } }); f.resolve({});
});

test('standalone application cards replace the empty conversation welcome', async t => {
  const f = await fixture(t, 'mcpServer/elicitation/request', { serverName: 'Fixture app', turnId: null, mode: 'url', message: '连接应用', url: 'https://example.com/authorize' }, []);
  assert.equal(f.dom.get('chat-empty').hidden, true); assert.equal(f.chat.getState().turns.length, 0); assert.ok(button(f.card, '已完成授权'));
});

test('MCP cards preserve titled choices, multi-select defaults and primitive field types', async t => {
  const f = await fixture(t, 'mcpServer/elicitation/request', { serverName: 'Fixture app', mode: 'openai/form', message: '请选择要授权的内容', requestedSchema: { type: 'object',
    required: ['space', 'count', 'enabled', 'none'], properties: {
      space: { type: 'string', oneOf: [{ const: 'personal', title: '个人空间' }, { const: 'team', title: '团队空间' }], default: 'team' },
      folders: { type: 'array', items: { anyOf: [{ const: 'docs', title: '文档' }, { const: 'photos', title: '照片' }] }, default: ['docs'], minItems: 1 },
      count: { type: 'integer', minimum: 1, maximum: 5, default: 2 }, enabled: { type: 'boolean', default: false }, note: { type: 'string', default: 'keep' },
      none: { type: 'array', items: { type: 'string', enum: ['optional-scope'] } },
    } } });
  assert.ok(descendants(f.card).some(node => node.textContent === '团队空间')); assert.ok(descendants(f.card).some(node => node.textContent === '文档'));
  await f.submit(); assert.deepEqual(f.calls[0].answer.result, { action: 'accept', content: { space: 'team', folders: ['docs'], count: 2, enabled: false, note: 'keep', none: [] }, _meta: null }); f.resolve({});
});

test('MCP card validation keeps incomplete and invalid numeric input local', async t => {
  const f = await fixture(t, 'mcpServer/elicitation/request', { serverName: 'Fixture app', mode: 'form', message: '填写参数', requestedSchema: { type: 'object', required: ['count'],
    properties: { count: { type: 'integer', minimum: 1, maximum: 3 }, tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] }, minItems: 1 } } } });
  const number = controls(f.card, 'number')[0]; number.value = '1.5'; await f.submit(); assert.equal(f.calls.length, 0);
  number.value = '9'; await f.submit(); assert.equal(f.calls.length, 0);
  number.value = '2'; controls(f.card, 'checkbox')[0].checked = true; await f.submit();
  assert.deepEqual(f.calls[0].answer.result.content, { count: 2, tags: ['a'] }); f.resolve({});
});

test('URL authorization requires an explicit completion response and unsafe URLs cannot be accepted', async t => {
  const f = await fixture(t, 'mcpServer/elicitation/request', { serverName: 'Fixture app', mode: 'url', message: '连接应用', url: 'https://example.com/authorize', elicitationId: 'auth-id' });
  const link = descendants(f.card).find(node => node.tagName === 'A'); assert.equal(link.href, 'https://example.com/authorize'); assert.equal(link.rel, 'noopener noreferrer');
  link.click(); assert.equal(f.calls.length, 0, 'Opening the authorization page is not consent to complete the native request');
  button(f.card, '已完成授权').click(); await delay(0); assert.deepEqual(f.calls[0].answer.result, { action: 'accept', content: null, _meta: null }); f.resolve({});
});

test('unsupported or unsafe authorization requests keep reject/cancel controls without a false acceptance', async t => {
  for (const params of [{ mode: 'url', url: 'javascript:alert(1)' }, { mode: 'form', requestedSchema: { type: 'object', properties: { nested: { type: 'object' } } } },
    { mode: 'form', requestedSchema: { type: 'object', properties: { empty: { type: 'string', enum: [] } } } }]) {
    await t.test(params.mode, async t => {
      const f = await fixture(t, 'mcpServer/elicitation/request', { serverName: 'Fixture app', message: '确认操作', ...params });
      await f.submit(); assert.equal(f.calls.length, 0); assert.ok(button(f.card, '拒绝'));
      button(f.card, '拒绝').click(); await delay(0); assert.equal(f.calls[0].answer.result.action, 'decline'); f.resolve({});
    });
  }
});

test('streaming updates preserve card choices and native resolution removes the card', async t => {
  const f = await fixture(t, 'item/tool/requestUserInput', { questions: [{ id: 'answer', header: '回答', question: '请输入', isOther: false, isSecret: false, options: null }] });
  const input = controls(f.card, 'text')[0]; input.value = '正在填写'; input.focus();
  f.chat.onEvent({ kind: 'notification', cursor: { generation: 1, seq: 3 }, native: { method: 'item/agentMessage/delta', params: { threadId: 't', turnId: 'turn', itemId: 'reply', delta: 'Update' } } }); await delay(0);
  assert.ok(f.dom.get('native-requests').children[0] === f.card); assert.equal(input.value, '正在填写'); assert.equal(f.dom.document.activeElement, input);
  f.chat.onEvent({ kind: 'notification', cursor: { generation: 1, seq: 4 }, native: { method: 'serverRequest/resolved', params: { threadId: 't', requestId: 'request' } } }); await delay(0);
  assert.equal(f.dom.get('native-requests').children.length, 0); await f.submit(); assert.equal(f.calls.length, 0);
});

test('late card responses update their original conversation without removing another conversation request', async t => {
  const f = await fixture(t, 'item/fileChange/requestApproval', { reason: '写入文件', grantRoot: '/project' }), original = f.chat.getState();
  button(f.card, '允许一次').click(); await delay(0); await f.chat.open('other');
  const other = f.chat.getState(); other.requests.set('1:"request"', { ...f.native, params: { ...f.native.params, threadId: 'other' } }); f.chat.connection(true);
  f.resolve({}); await delay(0); assert.equal(original.requests.size, 0); assert.equal(other.requests.size, 1);
  assert.equal(f.dom.get('native-requests').children.length, 1);
});

test('offline, stale and disposed cards cannot send an authorization response', async t => {
  const f = await fixture(t, 'item/fileChange/requestApproval', { reason: '写入文件', grantRoot: '/project' });
  f.chat.connection(false); button(f.card, '允许一次').click(); await delay(0); assert.equal(f.calls.length, 0);
  f.chat.connection(true); f.chat.dispose(); button(f.card, '允许一次').click(); await f.submit(); assert.equal(f.calls.length, 0);
});

test('a stale answer disables the card while preserving its visible input', async t => {
  const f = await fixture(t, 'item/tool/requestUserInput', { questions: [{ id: 'answer', header: '回答', question: '请输入', isOther: false, isSecret: false, options: null }] });
  const input = controls(f.card, 'text')[0]; input.value = 'Keep answer'; await f.submit(); f.fail(Object.assign(new Error('Stale'), { status: 409 })); await delay(0);
  assert.equal(input.value, 'Keep answer'); assert.equal(button(f.card, '提交回答').disabled, true);
  await f.submit(); assert.equal(f.calls.length, 1);
});

test('gateway relays authorization schema field names and native rule choices, rejecting changed policy payloads', async t => {
  const f = await httpsFixture(); t.after(() => f.close()); const cookie = await f.login(), viewId = await f.view(cookie), stream = await f.events(cookie, viewId);
  t.after(() => stream.req.destroy());
  const policy = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['git', 'status'] } };
  f.peer.request('approval', 'item/commandExecution/requestApproval', { threadId: 't', turnId: 'turn', itemId: 'item', command: 'git status', cwd: '/project', reason: '检查',
    proposedExecpolicyAmendment: ['git', 'status'], availableDecisions: ['accept', policy, 'decline', 'cancel'] });
  f.peer.request('schema', 'mcpServer/elicitation/request', { threadId: 't', turnId: 'turn', serverName: 'Fixture app', mode: 'form', message: '填写工具凭据', requestedSchema: {
    type: 'object', required: ['apiKey'], properties: { apiKey: { type: 'string', title: '工具密钥', isSecret: true } } }, accessToken: 'NEVER_RELAY' });
  await delay(20); const events = stream.text().split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6))).filter(event => event.kind === 'request');
  const approval = events.find(event => event.native.method === 'item/commandExecution/requestApproval'), schema = events.find(event => event.native.method === 'mcpServer/elicitation/request');
  assert.deepEqual(approval.native.params.proposedExecpolicyAmendment, ['git', 'status']); assert.equal(schema.native.params.requestedSchema.properties.apiKey.type, 'string'); assert.equal(stream.text().includes('NEVER_RELAY'), false);
  const opening = f.request('/api/thread/open', { method: 'POST', cookie, body: { viewId, threadId: 't' } });
  for (let n = 0; n < 100 && !f.peer.sent.some(item => item.method === 'thread/resume'); n++) await delay(5);
  f.peer.replyTo('thread/resume', resumeFixture('t'));
  const restored = (await opening).json.snapshot.pendingRequests.find(([, native]) => native.method === 'mcpServer/elicitation/request')[1];
  assert.equal(restored.params.requestedSchema.properties.apiKey.type, 'string', 'A newly opened page retains the pending authorization fields');
  const respond = decision => f.request('/api/request/respond', { method: 'POST', cookie, body: { viewId, requestKey: approval.requestKey, answer: { result: { decision } } } });
  assert.equal((await respond({ acceptWithExecpolicyAmendment: { execpolicy_amendment: ['sh'] } })).status, 400);
  assert.equal((await respond(policy)).status, 200); assert.deepEqual(f.peer.sent.find(item => item.id === 'approval').result, { decision: policy });
});
