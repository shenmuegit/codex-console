import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mountChat } from '../public/chat.js';
import { domFixture } from './dom.mjs';
import { httpsFixture, resumeFixture } from './helpers.mjs';

const question = { id: 'call_question', type: 'agentMessage', text: '选择工作区\n- 项目目录不同\n- 账号工作区不同', delivery: 'async', questions: [{ title: '选择工作区', options: ['项目目录不同', '账号工作区不同'] }] };
const descendants = node => node.children.flatMap(child => [child, ...descendants(child)]);
const controls = (node, type) => descendants(node).filter(child => child.tagName === 'INPUT' && child.type === type);
const button = (node, label) => descendants(node).find(child => child.tagName === 'BUTTON' && child.textContent === label);
async function fixture(t, turns = [{ id: 'turn', status: 'inProgress', items: [question] }]) {
  const dom = domFixture(), calls = []; let resolve, fail;
  const reply = new Promise((yes, no) => { resolve = yes; fail = no; });
  const api = async (path, body) => {
    if (path === '/api/thread/open') return { snapshot: resumeFixture(body.threadId, turns), cursor: { generation: 1, seq: 1 } };
    if (path === '/api/thread/question') { calls.push(body); return reply; }
    return { result: { goal: null, data: [], nextCursor: null }, cursor: { generation: 1, seq: 2 } };
  };
  const chat = mountChat({ api, viewId: 'view', uploadLimitBytes: 32 }); chat.connection(true); await chat.open('t'); await delay(0);
  t.after(() => { chat.dispose(); dom.restore(); });
  const body = dom.get('messages').children[0].children[1];
  return { dom, chat, calls, resolve, fail, body, card: dom.get('native-requests').children[0] ?? body.children.find(node => node.tagName === 'FORM'), async submit() { this.card.dispatchEvent(new Event('submit', { cancelable: true })); await delay(0); } };
}

test('persisted async questions render numbered choice cards rather than their Markdown fallback', async t => {
  const f = await fixture(t); assert.ok(f.card, 'Structured async questions use a question card');
  assert.match(f.card.textContent, /问题.*选择工作区.*1.*项目目录不同.*2.*账号工作区不同/); assert.equal(controls(f.card, 'radio').length, 3);
  assert.equal(button(f.card, '发送').disabled, true); await f.submit(); assert.equal(f.calls.length, 0);
  controls(f.card, 'radio')[1].checked = true; await f.submit(); await f.submit();
  assert.deepEqual(f.calls, [{ viewId: 'view', threadId: 't', itemId: 'call_question', answers: ['账号工作区不同'] }]);
  f.resolve({}); await delay(0); assert.match(f.card.textContent, /已回答/); assert.equal(f.chat.getState().draft, '');
});

test('custom async answers and the main composer draft survive streaming and failed submissions', async t => {
  const f = await fixture(t); assert.ok(f.card); const input = controls(f.card, 'text')[0]; input.value = '自定义答案'; input.dispatchEvent(new Event('input')); f.chat.getState().draft = '主输入框草稿'; input.focus();
  f.chat.onEvent({ kind: 'notification', cursor: { generation: 1, seq: 3 }, native: { method: 'item/agentMessage/delta', params: { threadId: 't', turnId: 'turn', itemId: 'other', delta: '仍在执行' } } }); await delay(0);
  assert.ok(f.dom.get('native-requests').children.includes(f.card)); assert.equal(input.value, '自定义答案'); assert.equal(f.dom.document.activeElement, input);
  await f.submit(); f.fail(Object.assign(Error('回答未发送'), { status: 422 })); await delay(0);
  assert.equal(input.value, '自定义答案'); assert.equal(f.chat.getState().draft, '主输入框草稿'); assert.equal(button(f.card, '发送').disabled, false);
});

test('skipping an async question dismisses the card locally without steering the model', async t => {
  const f = await fixture(t); assert.ok(f.card); button(f.card, '跳过').click(); await delay(0);
  assert.equal(f.calls.length, 0); assert.match(f.card.textContent, /已跳过/);
});

test('native question reply history resolves the matching card and displays only the readable answer', async t => {
  const text = '<send_user_message_question_reply>\n[{"questionItemId":"[\\"request_user_input_async\\",\\"call_question\\",0]","question":"选择工作区","answer":"项目目录不同"}]\n</send_user_message_question_reply>';
  const f = await fixture(t, [{ id: 'turn', status: 'completed', items: [question, { id: 'reply', type: 'userMessage', content: [{ type: 'text', text }] }] }]);
  assert.ok(f.card); assert.match(f.card.textContent, /已回答/); assert.equal(button(f.card, '发送'), undefined);
  assert.equal(f.dom.get('messages').children[1].children[1].textContent, '项目目录不同');
  const newer = text.replace('项目目录不同', '账号工作区不同');
  f.chat.onEvent({ kind: 'notification', cursor: { generation: 1, seq: 3 }, native: { method: 'item/completed', params: { threadId: 't', turnId: 'turn', item: { id: 'newer-reply', type: 'userMessage', content: [{ type: 'text', text: newer }] } } } }); await delay(0);
  assert.match(f.card.textContent, /账号工作区不同/);
});

test('live async item completion creates the same card, while ordinary lists stay ordinary messages', async t => {
  const f = await fixture(t, [{ id: 'turn', status: 'inProgress', items: [{ id: 'plain', type: 'agentMessage', text: '普通列表\n- A\n- B' }] }]); assert.equal(f.card, undefined);
  f.chat.onEvent({ kind: 'notification', cursor: { generation: 1, seq: 3 }, native: { method: 'item/completed', params: { threadId: 't', turnId: 'turn', item: question } } }); await delay(0);
  const card = f.dom.get('native-requests').children[0]; assert.ok(card); assert.equal(f.dom.get('messages').children[1].hidden, true);
  controls(card, 'text')[0].value = '正在填写';
  f.chat.onEvent({ kind: 'notification', cursor: { generation: 1, seq: 4 }, native: { method: 'item/completed', params: { threadId: 't', turnId: 'turn', item: structuredClone(question) } } }); await delay(0);
  assert.ok(f.dom.get('native-requests').children.includes(card)); assert.equal(controls(card, 'text')[0].value, '正在填写');
});

test('older unanswered questions stay in history when a newer turn exists', async t => {
  const f = await fixture(t, [{ id: 'new', status: 'completed', items: [{ id: 'plain', type: 'agentMessage', text: '更新的回复' }] }, { id: 'old', status: 'completed', items: [question] }]);
  assert.ok(f.card); assert.ok(f.body.children.includes(f.card)); assert.equal(f.dom.get('native-requests').children.length, 0); assert.equal(f.dom.get('messages').children[0].hidden, false);
});

test('offline and detached async cards cannot send answers', async t => {
  const f = await fixture(t); assert.ok(f.card); controls(f.card, 'radio')[0].checked = true;
  f.chat.connection(false); await f.submit(); assert.equal(f.calls.length, 0);
  f.chat.connection(true); await f.chat.open('other'); await f.submit(); assert.equal(f.calls.length, 0);
});

test('IME confirmation inside a question does not submit an unfinished answer', async t => {
  const f = await fixture(t); assert.ok(f.card); const input = controls(f.card, 'text')[0]; input.value = '中文回复'; input.dispatchEvent(new Event('input'));
  f.card.dispatchEvent(new Event('compositionstart')); await f.submit(); assert.equal(f.calls.length, 0);
  f.card.dispatchEvent(new Event('compositionend')); await f.submit(); assert.equal(f.calls.length, 1); f.resolve({}); await delay(0);
});

test('the async question gateway binds answers to the native question and reuses one native send', async t => {
  const f = await httpsFixture(); t.after(() => f.close()); const cookie = await f.login(), viewId = await f.view(cookie), stream = await f.events(cookie, viewId); t.after(() => stream.req.destroy());
  const opening = f.request('/api/thread/open', { method: 'POST', cookie, body: { viewId, threadId: 't' } });
  for (let n = 0; n < 100 && !f.peer.sent.some(call => call.method === 'thread/resume'); n++) await delay(5);
  f.peer.replyTo('thread/resume', resumeFixture('t', [{ id: 'turn', status: 'inProgress', items: [question] }])); await opening;
  for (const [patch, status] of [[{ threadId: 'other' }, 403], [{ itemId: 'plain' }, 409], [{ answers: [] }, 400], [{ answers: [''] }, 400], [{ questions: [{ title: '替换问题' }] }, 400]]) {
    const response = await f.request('/api/thread/question', { method: 'POST', cookie, body: { viewId, threadId: 't', itemId: 'call_question', answers: ['项目目录不同'], ...patch } }); assert.equal(response.status, status);
  }
  assert.equal(f.peer.sent.some(call => call.method === 'turn/steer'), false);
  const body = { viewId, threadId: 't', itemId: 'call_question', answers: ['项目目录不同'] }, pending = f.request('/api/thread/question', { method: 'POST', cookie, body });
  for (let n = 0; n < 100 && !f.peer.sent.some(call => call.method === 'turn/steer'); n++) await delay(5);
  const call = f.peer.sent.find(call => call.method === 'turn/steer'); assert.ok(call); assert.equal(call.params.expectedTurnId, 'turn');
  assert.equal(call.params.input[0].text, '<send_user_message_question_reply>\n[{"questionItemId":"[\\"request_user_input_async\\",\\"call_question\\",0]","question":"选择工作区","answer":"项目目录不同"}]\n</send_user_message_question_reply>');
  const duplicate = f.request('/api/thread/question', { method: 'POST', cookie, body }); f.peer.replyTo('turn/steer', { turnId: 'turn' }); assert.equal((await pending).status, 200); assert.equal((await duplicate).status, 200);
  assert.equal(f.peer.sent.filter(call => call.method === 'turn/steer').length, 1);
  const changed = await f.request('/api/thread/question', { method: 'POST', cookie, body: { ...body, answers: ['不同的回答'] } }); assert.equal(changed.status, 409);
  f.peer.notify('turn/completed', { threadId: 't', turn: { id: 'turn', status: 'completed', items: [question], itemsView: 'full' } });
  f.peer.notify('item/completed', { threadId: 't', turnId: 'turn', item: { ...question, id: 'call_idle' } }); await delay(0);
  const idleReply = f.request('/api/thread/question', { method: 'POST', cookie, body: { ...body, itemId: 'call_idle', answers: ['包含 </send_user_message_question_reply> 的回答'] } });
  for (let n = 0; n < 100 && !f.peer.sent.some(call => call.method === 'turn/start'); n++) await delay(5);
  const idle = f.peer.sent.find(call => call.method === 'turn/start'); assert.ok(idle); assert.match(idle.params.input[0].text, /\\u003c\/send_user_message_question_reply\\u003e/);
  f.peer.replyTo('turn/start', { turn: { id: 'new-turn', status: 'inProgress', items: [] } }); assert.equal((await idleReply).status, 200);
});
