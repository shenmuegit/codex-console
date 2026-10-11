import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mountChat } from '../public/chat.js';
import { renderTranscript } from '../transcript.mjs';
import { domFixture } from './dom.mjs';
import { resumeFixture } from './helpers.mjs';

async function fixture(t, text, markdown = true, files = new Map()) {
  const dom = domFixture(), snapshot = resumeFixture('t', [{ id: 'turn', status: 'inProgress', items: [{ id: 'reply', type: 'agentMessage', text }] }]);
  if (markdown) snapshot.transcript = renderTranscript(snapshot.thread, snapshot.initialTurnsPage.data, files);
  const api = async path => path === '/api/thread/open' ? { snapshot, cursor: { generation: 1, seq: 1 } } : { result: { data: [], nextCursor: null } };
  const chat = mountChat({ api, viewId: 'view', uploadLimitBytes: 32 }); t.after(() => { chat.dispose(); dom.restore(); }); chat.connection(true); await chat.open('t');
  let seq = 1;
  return { chat, dom, body: dom.get('messages').children[0].children[1], async delta(delta) {
    chat.onEvent({ kind: 'notification', cursor: { generation: 1, seq: ++seq }, native: { method: 'item/agentMessage/delta', params: { threadId: 't', turnId: 'turn', itemId: 'reply', delta } } }); await delay(0);
  }, async render() {
    const state = chat.getState(), transcript = renderTranscript(state.thread, state.turns, files);
    chat.onEvent({ kind: 'render', cursor: state.cursor, native: { threadId: 't', items: transcript.items } }); await delay(0);
  }, async complete(text) {
    chat.onEvent({ kind: 'notification', cursor: { generation: 1, seq: ++seq }, native: { method: 'item/completed', params: { threadId: 't', turnId: 'turn', item: { id: 'reply', type: 'agentMessage', text } } } }); await delay(0);
  } };
}
function edits(node) {
  const appended = [], replaced = [];
  const append = node.appendData, replace = node.replaceData;
  node.appendData = function (text) { appended.push(text); return append.call(this, text); };
  node.replaceData = function (...args) { replaced.push(args); return replace.apply(this, args); };
  return { appended, replaced };
}

test('plain SSE deltas append only new characters to the existing text node', async t => {
  const f = await fixture(t, '已有文字', false); await f.delta('中'); const pre = f.body.firstChild, text = pre.firstChild, writes = edits(text);
  for (const chunk of ['文', '😀', 'e\u0301', '\n下一行']) await f.delta(chunk);
  assert.ok(f.body.firstChild === pre); assert.ok(pre.firstChild === text);
  assert.deepEqual(writes.appended, ['文', '😀', 'e\u0301', '\n下一行']); assert.deepEqual(writes.replaced, []);
  assert.equal(text.data, '已有文字中文😀e\u0301\n下一行');
});

test('the first Markdown presentation preserves the initial streaming paragraph and text node', async t => {
  const f = await fixture(t, '开始', false); await f.delta('输出'); const paragraph = f.body.firstChild, text = paragraph.firstChild;
  await f.render(); assert.ok(f.body.firstChild === paragraph); assert.ok(paragraph.firstChild === text); assert.equal(paragraph.tagName, 'P');
});

test('Markdown replies retain their paragraphs while raw SSE and rendered updates alternate', async t => {
  const f = await fixture(t, '已完成的段落。\n\n正在输出'), [fixed, live] = f.body.children, text = live.firstChild, writes = edits(text);
  await f.delta('中'); assert.ok(f.body.children[0] === fixed); assert.ok(f.body.children[1] === live); assert.equal(text.data, '正在输出中');
  await f.render(); assert.ok(f.body.children[1] === live); assert.ok(live.firstChild === text);
  await f.delta('文😀'); await f.render(); assert.equal(f.body.innerHTML, '<p>已完成的段落。</p>\n<p>正在输出中文😀</p>\n');
  assert.ok(f.body.children[0] === fixed); assert.ok(live.firstChild === text); assert.deepEqual(writes.appended, ['中', '文😀']); assert.deepEqual(writes.replaced, []);
});

test('closing Markdown markup updates only the changed subtree and preserves completed content and images', async t => {
  const ref = { name: 'photo.png', target: '/photo.png', href: '/api/files/photo', imageHref: '/api/images/photo' };
  const f = await fixture(t, '![照片](/photo.png)\n\n完整段落。\n\n末尾 **加粗', true, new Map([['reply', [ref]]]));
  const [picture, fixed, live] = f.body.children, image = picture.firstChild, text = live.firstChild;
  await f.delta('**');
  assert.equal(f.dom.get('messages').children[0].children[2].children.length, 0, 'A raw delta must not duplicate an inline image in downloads');
  await f.render();
  assert.ok(f.body.children[0] === picture); assert.ok(picture.firstChild === image); assert.ok(f.body.children[1] === fixed); assert.ok(f.body.children[2] === live);
  assert.ok(live.firstChild === text); assert.equal(text.data, '末尾 '); assert.equal(live.children[0].tagName, 'STRONG'); assert.equal(live.children[0].textContent, '加粗');
  assert.equal(f.dom.get('messages').children[0].children[2].children.length, 0, 'A raw delta must not duplicate an inline image in downloads');
});

test('same-HTML Markdown updates reconcile invisible source characters without rebuilding the paragraph', async t => {
  const f = await fixture(t, '段落'), paragraph = f.body.children[0], text = paragraph.firstChild;
  await f.delta('\n'); await f.render(); assert.ok(f.body.children[0] === paragraph); assert.ok(paragraph.firstChild === text); assert.equal(text.data, '段落');
  await f.delta('\n下一段'); await f.render(); assert.ok(f.body.children[0] === paragraph); assert.equal(f.body.children[1].textContent, '下一段');
});

test('authoritative plain corrections edit only the differing text range', async t => {
  const f = await fixture(t, '开始 old 结束', false); await f.delta('。'); const pre = f.body.firstChild, text = pre.firstChild, writes = edits(text);
  await f.complete('开始 new 结束。'); assert.ok(pre.firstChild === text); assert.deepEqual(writes.replaced, [[3, 3, 'new']]);
  await f.complete('开始 new'); assert.ok(pre.firstChild === text); assert.equal(text.data, '开始 new');
});

test('final item completion does not rewrite already rendered text', async t => {
  const f = await fixture(t, '完成'); await f.delta('了'); await f.render(); const paragraph = f.body.children[0], text = paragraph.firstChild, writes = edits(text);
  await f.complete('完成了'); await f.render(); assert.ok(f.body.children[0] === paragraph); assert.ok(paragraph.firstChild === text);
  assert.deepEqual(writes, { appended: [], replaced: [] });
});

test('authoritative Markdown corrections retain formatting until safe HTML can patch the existing text node', async t => {
  const f = await fixture(t, '前缀 old 后缀'), paragraph = f.body.children[0], text = paragraph.firstChild, writes = edits(text);
  await f.complete('前缀 new 后缀'); assert.ok(f.body.children[0] === paragraph);
  await f.render(); assert.ok(f.body.children[0] === paragraph); assert.ok(paragraph.firstChild === text);
  assert.deepEqual(writes.replaced, [[3, 3, 'new']]); assert.equal(text.data, '前缀 new 后缀');
});
