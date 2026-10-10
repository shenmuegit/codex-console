import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mountChat } from '../public/chat.js';
import { displayNativeText, utf8Range } from '../public/composer.js';
import { domFixture } from './dom.mjs';
import { resumeFixture } from './helpers.mjs';

const submission = (id = 'q1') => ({ id, clientUserMessageId: 'client-' + id,
  input: [{ type: 'text', text: '继续 <script> 😀', text_elements: [] }, { type: 'localImage', path: '/private/photo.png' }] });
const running = { id: 'active', status: 'inProgress', items: [] };
async function fixture(t) {
  const dom = domFixture(), calls = []; let seq = 0, queue = [submission()], fail = false, chat;
  t.after(() => { chat?.dispose(); dom.restore(); });
  const api = async (path, body) => {
    calls.push({ path, body });
    if (path === '/api/rpc') return { result: { data: body.method === 'thread/queue/list' ? queue : [], nextCursor: null }, cursor: { generation: 1, seq: ++seq } };
    if (path === '/api/thread/open') return { snapshot: resumeFixture(body.threadId, [running]), cursor: { generation: 1, seq: ++seq } };
    if (path === '/api/thread/queue') {
      if (fail) throw Object.assign(new Error('Native queue changed'), { status: 409, ...(fail === 'unknown' ? { outcome: 'unknown' } : {}) });
      if (body.action === 'update') queue = queue.map(item => item.id === body.queuedSubmissionId ? { ...item, input: [{ ...item.input[0], text: body.text }, ...item.input.slice(1)] } : item);
      else queue = queue.filter(item => item.id !== body.queuedSubmissionId);
      return { result: body.action === 'side' ? { threadId: 'side-thread' } : {} };
    }
    if (path === '/api/thread/send') return { result: { queuedSubmission: submission('new') } };
    assert.fail(path);
  };
  chat = mountChat({ api, viewId: 'view', uploadLimitBytes: 32 }); chat.connection(true); await chat.open('t'); await delay(0);
  return { dom, calls, chat, api, setChat: value => { chat = value; }, setQueue: items => { queue = items; }, fail: outcome => { fail = outcome || true; },
    change() { chat.onEvent({ kind: 'notification', cursor: { generation: 1, seq: ++seq }, native: { method: 'thread/queue/changed', params: { threadId: 't' } } }); },
    action(name) { dom.get('queued-messages').children[0].querySelectorAll().find(node => node.dataset.action === name).click(); } };
}

test('follow-ups default to the native queue and retain a visible queue with per-message actions', async t => {
  const f = await fixture(t), state = f.chat.getState();
  assert.ok(!f.dom.get('send-mode'), 'The composer has no queue/steer selector');
  const list = f.dom.get('queued-messages'); assert.ok(list); assert.equal(list.hidden, false);
  assert.equal(list.children[0].children[1].textContent, '继续 <script> 😀\n［图片］');
  state.draft = 'Next task'; f.dom.get('draft').value = state.draft; f.dom.event('composer', 'submit'); await delay(0);
  assert.equal(f.calls.find(call => call.path === '/api/thread/send').body.mode, 'queue');
  f.action('menu'); assert.equal(f.dom.get('queue-menu').hidden, false);
  f.dom.get('queue-menu-toggle').click(); await delay(0);
  assert.equal(list.hidden, false, 'Turning off queueing must preserve accepted messages');
  state.draft = 'Correction'; f.dom.event('composer', 'submit'); await delay(0);
  assert.equal(f.calls.filter(call => call.path === '/api/thread/send').at(-1).body.mode, 'steer');
});

test('queue changes from another client refresh the list; menu supports keyboard dismissal', async t => {
  const f = await fixture(t); f.action('menu');
  f.dom.event('queue-menu', 'keydown', { key: 'ArrowDown' });
  assert.equal(f.dom.document.activeElement, f.dom.get('queue-menu-side'));
  f.dom.event('queue-menu', 'keydown', { key: 'Escape' }); assert.equal(f.dom.get('queue-menu').hidden, true);
  f.setQueue([]); f.change(); await delay(0); assert.equal(f.dom.get('queued-messages').hidden, true);
});

test('editing and failed queue mutations preserve the current draft and attachment', async t => {
  const f = await fixture(t), state = f.chat.getState(); state.draft = 'Keep my newer draft';
  f.action('menu'); f.dom.get('queue-menu-edit').click(); await delay(0);
  assert.equal(f.dom.get('queue-edit-dialog').open, true);
  f.dom.get('queue-edit-text').value = 'Changed 😀'; f.fail();
  f.dom.event('queue-edit-form', 'submit'); await delay(0);
  assert.equal(f.dom.get('queue-edit-dialog').open, true); assert.equal(f.dom.get('queue-edit-text').value, 'Changed 😀');
  assert.equal(state.draft, 'Keep my newer draft'); assert.match(f.dom.get('queue-edit-error').textContent, /Native queue changed/);
  f.dom.get('queue-edit-cancel').click(); f.action('delete'); await delay(0);
  assert.equal(f.dom.get('queued-messages').children.length, 1, 'Rejected deletion must leave the native submission visible');
});

test('steering consumes the selected native submission and side chat leaves the source selected', async t => {
  const f = await fixture(t); f.action('steer'); await delay(0);
  assert.equal(f.calls.find(call => call.path === '/api/thread/queue').body.action, 'steer');
  f.setQueue([submission('side')]); f.change(); await delay(0);
  f.action('menu'); f.dom.get('queue-menu-side').click(); await delay(0);
  assert.equal(f.chat.getState().threadId, 't'); assert.equal(f.dom.get('side-chat').hidden, false);
  assert.equal(f.dom.get('side-chat-frame').src, '/?thread=side-thread&side=1');
  f.dom.get('close-side-chat').click(); assert.equal(f.dom.get('side-chat').hidden, true);
});

test('queued edits preserve UTF-8 native references, image inputs and reference snapshots', async () => {
  const { updateQueuedInput } = await import('../public/composer.js');
  const text = '看 [@Other](thread://ref) 😀 end', start = text.indexOf('['), end = text.indexOf(')') + 1;
  const input = [{ type: 'text', text, text_elements: [{ byteRange: utf8Range(text, start, end), placeholder: '@Other' }] },
    { type: 'localImage', path: '/private/photo.png' }, { type: 'skill', name: 'skill', path: '/private/skill.md' },
    { type: 'text', text: '<untrusted_text>saved context</untrusted_text>', text_elements: [] }];
  const edited = updateQueuedInput(input, '加：看 @Other 😀 end!');
  assert.equal(displayNativeText(edited[0]), '加：看 @Other 😀 end!'); assert.match(edited[0].text, /thread:\/\/ref/);
  assert.deepEqual(edited.slice(1), input.slice(1));
  assert.deepEqual(updateQueuedInput(input, '看 only')[0], { type: 'text', text: '看 only', text_elements: [] });
  assert.deepEqual(updateQueuedInput(input, displayNativeText(input[0])), input);
  const native = [{ type: 'text', text: 'Original', text_elements: [{ byteRange: { start: 0, end: 8 }, placeholder: null }] }, { type: 'image', url: 'data:image/png;base64,AA==' }];
  assert.deepEqual(updateQueuedInput(native, 'Changed'), [{ type: 'text', text: 'Changed', text_elements: [] }, native[1]]);
});

test('portable native image-only queued messages have an accessible visible preview', async t => {
  const f = await fixture(t); f.setQueue([{ ...submission(), input: [{ type: 'image', url: 'data:image/png;base64,AA==' }] }]); f.change(); await delay(0);
  assert.equal(f.dom.get('queued-messages').children[0].children[1].textContent, '［图片］');
});

test('an uncertain transfer keeps its recovery input through reload and requires a check before retry', async t => {
  const f = await fixture(t); f.chat.getState().draft = 'Keep this newer draft'; f.fail('unknown'); f.action('steer'); await delay(0);
  const recovery = f.chat.getState().queueRecovery; assert.ok(recovery.id); assert.equal(f.dom.get('queue-recovery').hidden, false);
  assert.match(f.dom.get('queue-recovery-text').textContent, /继续/); assert.equal(f.chat.getState().draft, 'Keep this newer draft');
  f.chat.dispose(); const reopened = mountChat({ api: f.api, viewId: 'view', uploadLimitBytes: 32 }); f.setChat(reopened);
  reopened.connection(true); await reopened.open('t'); await delay(0); assert.deepEqual(reopened.getState().queueRecovery, recovery);
  const before = f.calls.filter(call => call.path === '/api/thread/queue').length;
  window.confirm = () => false; f.dom.get('queue-recovery-restore').click(); await delay(0);
  assert.equal(f.calls.filter(call => call.path === '/api/thread/queue').length, before);
  f.dom.get('queue-recovery-dismiss').click(); assert.equal(reopened.getState().queueRecovery, null);
});
