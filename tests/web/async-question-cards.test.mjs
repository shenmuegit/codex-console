import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mountChat } from '../../web/public/chat.js';
import { displayNativeText } from '../../web/public/composer.js';
import { domFixture } from './dom.mjs';
import { resumeFixture } from './helpers.mjs';

const question = { id: 'call-native-question', type: 'agentMessage', phase: 'final_answer', delivery: 'async',
  text: 'Has the token been saved?\n- Not saved\n- Saved', questions: [{ title: 'Has the token been saved?', options: ['Not saved', 'Saved'] }] };
const reply = '<send_user_message_question_reply>\n[{"questionItemId":"[\\"request_user_input_async\\",\\"call-native-question\\",0]","question":"Has the token been saved?","answer":"Saved"}]\n</send_user_message_question_reply>';
const descendants = node => node.children.flatMap(child => [child, ...descendants(child)]);
const button = (node, label) => descendants(node).find(child => child.tagName === 'BUTTON' && child.textContent === label);
const controls = (node, type) => descendants(node).filter(child => child.tagName === 'INPUT' && child.type === type);
async function fixture(t, items = [question], status = 'inProgress') {
  const dom = domFixture(), calls = []; let resolve, reject;
  const response = new Promise((yes, no) => { resolve = yes; reject = no; });
  const api = async (path, body) => {
    if (path === '/api/thread/send') { calls.push(body); return response; }
    if (path === '/api/thread/open') return { snapshot: resumeFixture(body.threadId, [{ id: 'turn', status, items }]), cursor: { generation: 1, seq: 1 } };
    return { result: { data: [], nextCursor: null } };
  };
  let chat = mountChat({ api, viewId: 'view', uploadLimitBytes: 32 });
  t.after(() => { chat.dispose(); dom.restore(); }); chat.connection(true); await chat.open('thread');
  return { dom, get chat() { return chat; }, calls, resolve, reject, get card() { return dom.get('native-requests').children[0]; },
    async remount() { chat.dispose(); chat = mountChat({ api, viewId: 'view', uploadLimitBytes: 32 }); chat.connection(true); await chat.open('thread'); },
    async submit() { this.card.dispatchEvent(new Event('submit', { cancelable: true })); await delay(0); },
    async event(method, params, seq = 2) { chat.onEvent({ kind: 'notification', cursor: { generation: 1, seq }, native: { method, params: { threadId: 'thread', turnId: 'turn', ...params } } }); await delay(0); } };
}

test('native async question metadata renders choices instead of its fallback Markdown', async t => {
  const f = await fixture(t);
  assert.ok(f.card, 'A persisted async agentMessage must become a question card');
  assert.equal(controls(f.card, 'radio').length, 2);
  assert.match(f.card.textContent, /Has the token been saved/);
  assert.equal(f.dom.get('messages').textContent.includes('Has the token been saved?'), false);
  assert.equal(f.dom.get('thinking-status').hidden, true);
  controls(f.card, 'radio')[0].checked = false; controls(f.card, 'radio')[1].checked = true; await f.submit();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].draft.text, reply);
  assert.equal(f.calls[0].mode, 'steer');
  assert.deepEqual(f.calls[0].draft.selections, []); assert.deepEqual(f.calls[0].draft.uploadIds, []);
  f.resolve({ result: {}, cursor: { generation: 1, seq: 2 } }); await delay(0);
  assert.equal(f.dom.get('native-requests').children.length, 0);
});

test('ordinary assistant bullet lists remain prose and never become interactive cards', async t => {
  const f = await fixture(t, [{ ...question, delivery: null, questions: null }]);
  assert.equal(f.card, undefined);
  assert.match(f.dom.get('messages').textContent, /Has the token been saved/);
});

test('live async item events mount a card once and completion keeps the selected answer', async t => {
  const f = await fixture(t, []);
  await f.event('item/started', { item: question });
  assert.ok(f.card); const card = f.card, input = controls(card, 'text')[0]; input.value = 'My answer'; input.dispatchEvent(new Event('input'));
  await f.event('item/completed', { item: question }, 3);
  assert.equal(f.card, card); assert.equal(input.value, 'My answer');
});

test('streaming preserves async answer edits and sending preserves the composer draft and attachments', async t => {
  const f = await fixture(t), card = f.card;
  assert.ok(card);
  const input = controls(card, 'text')[0]; input.value = '/private/token-file'; input.dispatchEvent(new Event('input')); input.focus();
  const state = f.chat.getState(); state.draft = 'Keep this draft';
  state.attachments = [{ id: 'draft-file', name: 'notes.txt', status: 'complete', size: 1 }];
  await f.event('item/agentMessage/delta', { itemId: 'later', delta: 'Continuing background work.' });
  assert.equal(f.card, card); assert.equal(document.activeElement, input); assert.equal(input.value, '/private/token-file');
  await f.submit(); await f.submit(); assert.equal(f.calls.length, 1);
  f.resolve({ result: {}, cursor: { generation: 1, seq: 3 } }); await delay(0);
  assert.equal(state.draft, 'Keep this draft'); assert.equal(state.attachments[0].id, 'draft-file');
  assert.equal(f.calls[0].draft.text.includes('/private/token-file'), true);
});

test('async question replies recorded by another client dismiss only their matching native question', async t => {
  const f = await fixture(t, [{ ...question, questions: [...question.questions, { title: 'Which directory?' }] }]);
  assert.ok(f.card); assert.match(f.card.textContent, /Has the token been saved/);
  await f.event('item/completed', { item: { id: 'native-answer', type: 'userMessage', content: [{ type: 'text', text: reply }] } });
  assert.ok(f.card); assert.equal(f.card.textContent.includes('Has the token been saved?'), false);
  assert.match(f.card.textContent, /Which directory/);
  controls(f.card, 'text')[0].value = '/work'; await f.submit();
  const payload = JSON.parse(f.calls[0].draft.text.slice('<send_user_message_question_reply>'.length, -'</send_user_message_question_reply>'.length));
  assert.deepEqual(payload, [{ questionItemId: '["request_user_input_async","call-native-question",1]', question: 'Which directory?', answer: '/work' }]);
  f.resolve({ result: {}, cursor: { generation: 1, seq: 3 } });
});

test('answered historical questions stay resolved after reopening and reply envelopes display readable answers', async t => {
  const f = await fixture(t, [question, { id: 'answered', type: 'userMessage', content: [{ type: 'text', text: reply }] }], 'completed');
  assert.equal(f.card, undefined);
  assert.equal(f.dom.get('messages').textContent.includes('send_user_message_question_reply'), false);
  assert.equal(displayNativeText({ text: reply }), 'Has the token been saved?\n\nSaved');
  for (const value of ['Quoted: ' + reply, reply + ' trailing', '<send_user_message_question_reply>[]</send_user_message_question_reply>']) {
    assert.equal(displayNativeText({ text: value }), value, 'Only a complete valid native envelope is interpreted');
  }
  assert.equal(displayNativeText({ text: '# Context from my IDE setup:\ncontext\n## My request for Codex:\n' + reply }), 'Has the token been saved?\n\nSaved');
});

test('a rejected async answer keeps the card editable for an explicit retry', async t => {
  const f = await fixture(t); const input = controls(f.card, 'text')[0]; input.value = 'Retain this answer'; input.dispatchEvent(new Event('input'));
  await f.submit(); f.reject(Object.assign(new Error('Not sent'), { status: 422, outcome: 'not-sent' })); await delay(0);
  assert.equal(input.value, 'Retain this answer'); assert.equal(button(f.card, '发送').disabled, false);
  await f.submit(); assert.equal(f.calls.length, 2);
});

test('a late async answer acknowledgement resolves its original conversation only', async t => {
  const f = await fixture(t), original = f.chat.getState(); await f.submit();
  await f.chat.open('other'); const other = f.chat.getState(), card = f.card;
  f.resolve({ result: {}, cursor: { generation: 1, seq: 3 } }); await delay(0);
  assert.equal(original.answeredQuestions.has('["request_user_input_async","call-native-question",0]'), true);
  assert.equal(other.answeredQuestions?.size ?? 0, 0); assert.equal(f.card, card);
});

test('failed async answers retain their choices, while unknown outcomes cannot be sent twice', async t => {
  const f = await fixture(t); assert.ok(f.card); const input = controls(f.card, 'text')[0]; input.value = 'Keep my answer'; input.dispatchEvent(new Event('input'));
  await f.submit(); f.reject(Object.assign(new Error('Delivery status unknown'), { outcome: 'unknown', status: 504 })); await delay(0);
  assert.equal(input.value, 'Keep my answer'); assert.equal(button(f.card, '发送').disabled, true);
  assert.match(f.card.textContent, /核对/); await f.submit(); assert.equal(f.calls.length, 1);
});

test('unknown async delivery stays locked with its original UUID across a page remount', async t => {
  const f = await fixture(t); await f.submit(); const id = f.calls[0].clientUserMessageId;
  f.reject(Object.assign(new Error('Unknown'), { outcome: 'unknown', status: 504 })); await delay(0);
  await f.remount(); assert.ok(f.card);
  assert.equal(button(f.card, '发送').disabled, true); assert.match(f.card.textContent, /核对/);
  await f.submit(); assert.equal(f.calls.length, 1);
  assert.equal(f.chat.getState().pendingAnswers[0].id, id);
  await f.event('item/completed', { item: { id: 'delivered', type: 'userMessage', clientId: id, content: [{ type: 'text', text: reply }] } });
  assert.equal(f.card, undefined); assert.equal(f.chat.getState().pendingAnswers.length, 0);
});

test('accepted async delivery does not reopen its question before native history catches up', async t => {
  const f = await fixture(t); await f.submit(); f.resolve({ result: {}, cursor: { generation: 1, seq: 2 } }); await delay(0);
  await f.remount(); assert.equal(f.card, undefined); assert.equal(f.calls.length, 1);
});

test('legacy desktop replies using the source message ID resolve all of that source questions', async t => {
  const legacy = '<send_user_message_question_reply>[{"questionItemId":"call-native-question","question":"Has the token been saved?","answer":"Saved"}]</send_user_message_question_reply>';
  const f = await fixture(t, [{ ...question, questions: [...question.questions, { title: 'Another question?' }] },
    { id: 'legacy-answer', type: 'userMessage', content: [{ type: 'text', text: legacy }] }]);
  assert.equal(f.card, undefined);
});

test('offline and dismissed async cards cannot submit or grant a native permission', async t => {
  const f = await fixture(t); assert.ok(f.card); f.chat.connection(false); await f.submit(); assert.equal(f.calls.length, 0);
  f.chat.connection(true); button(f.card, '跳过').click(); await delay(0);
  assert.equal(f.card, undefined); assert.equal(f.calls.length, 0);
  await f.event('item/completed', { item: question }); assert.equal(f.card, undefined);
});
