import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mountChat } from '../public/chat.js';
import { renderTranscript } from '../transcript.mjs';
import { resumeFixture } from './helpers.mjs';
import { domFixture } from './dom.mjs';

const message = (id, text) => ({ id, type: 'agentMessage', text });
async function fixture(t, items, references = new Map()) {
  const dom = domFixture(), snapshot = resumeFixture('t', [{ id: 'turn', status: 'inProgress', items }]);
  snapshot.transcript = renderTranscript(snapshot.thread, snapshot.initialTurnsPage.data, references);
  const api = async path => path === '/api/thread/open' ? { snapshot, cursor: { generation: 1, seq: 1 } } : { result: { data: [], nextCursor: null } };
  const chat = mountChat({ api, viewId: 'view', uploadLimitBytes: 32 }); t.after(() => { chat.dispose(); dom.restore(); });
  chat.connection(true); await chat.open('t'); await delay(0);
  return { dom, chat, messages: dom.get('messages'), notify(seq, method, params) {
    chat.onEvent({ kind: 'notification', cursor: { generation: 1, seq }, native: { method, params: { threadId: 't', turnId: 'turn', ...params } } });
  } };
}

function watch(nodes) {
  let writes = 0; const seen = new Set();
  function visit(node) {
    if (seen.has(node)) return; seen.add(node);
    for (const key of ['textContent', 'innerHTML']) {
      let value = node[key]; Object.defineProperty(node, key, { configurable: true, get: () => value, set(next) { writes++; value = next; } });
    }
    for (const key of ['replaceChildren', 'insertBefore', 'append', 'remove', 'setAttribute']) {
      const original = node[key]; node[key] = function (...args) { writes++; return original.apply(this, args); };
    }
    for (const child of node.children) visit(child);
  }
  nodes.forEach(visit); return () => writes;
}

test('streaming updates leave historical messages, activity and reading state untouched', async t => {
  const history = Array.from({ length: 100 }, (_, index) => message('old-' + index, 'Historical reply ' + index));
  const f = await fixture(t, [...history, { id: 'cmd', type: 'commandExecution', command: 'pwd', status: 'completed' },
    { id: 'agent', type: 'subAgentActivity', kind: 'completed', agentPath: '/root/review' }, message('live', 'Reply')]);
  const previous = f.messages.children.slice(0, -1), activity = previous[100]; activity.open = true;
  const writes = watch(previous), state = f.chat.getState(), feed = f.dom.get('chat-feed'), draft = f.dom.get('draft');
  let historicalReads = 0;
  for (const item of state.turns[0].items.slice(0, 100)) {
    const text = item.text; Object.defineProperty(item, 'text', { get() { historicalReads++; return text; } });
  }
  feed.scrollHeight = 2000; feed.clientHeight = 300; feed.scrollTop = 100; state.draft = draft.value = 'Keep this draft'; draft.focus();
  for (let seq = 2; seq < 8; seq++) { f.notify(seq, 'item/agentMessage/delta', { itemId: 'live', delta: ' next' }); await delay(0); }
  assert.equal(writes(), 0, 'Streaming must not rewrite any historical DOM node');
  assert.equal(historicalReads, 0, 'Unchanged historical replies must skip content rendering');
  assert.ok(previous.every((node, index) => f.messages.children[index] === node)); assert.equal(activity.open, true);
  assert.equal(feed.scrollTop, 100); assert.equal(state.draft, 'Keep this draft'); assert.equal(f.dom.document.activeElement, draft);
  f.notify(8, 'item/started', { item: message('new', 'New reply') }); await delay(0);
  assert.equal(f.messages.children.length, previous.length + 2); assert.equal(writes(), 0);
});

test('consecutive plain deltas reuse the active reply body', async t => {
  const f = await fixture(t, [message('live', 'Reply')]);
  f.notify(2, 'item/agentMessage/delta', { itemId: 'live', delta: ' one' }); await delay(0);
  const body = f.messages.children[0].children[1], plain = body.children[0];
  f.notify(3, 'item/agentMessage/delta', { itemId: 'live', delta: ' two' }); await delay(0);
  assert.ok(body.children[0] === plain, 'A delta must not replace the existing plain body');
  assert.equal(plain.textContent, 'Reply one two');
});

test('equivalent file enrichment preserves image nodes while changed references update them', async t => {
  const file = { name: 'photo.png', href: '/api/files/photo', imageHref: '/api/images/photo' };
  const f = await fixture(t, [message('old', 'Picture'), message('live', 'Reply')], new Map([['old', [file]]]));
  const row = f.messages.children[0], image = row.children[2].children[0], writes = watch([row]);
  const presentation = f.chat.getState().turns[0].items[0]._presentation;
  function render(files) { f.chat.onEvent({ kind: 'render', cursor: { generation: 1, seq: 1 }, native: { threadId: 't', items: [{ ...structuredClone(presentation), cursor: { generation: 1, seq: 1 }, files }] } }); }
  render([structuredClone(file)]); await delay(0); assert.ok(row.children[2].children[0] === image); assert.equal(writes(), 0);
  render([{ ...file, imageHref: '/api/images/updated' }]); await delay(0);
  assert.equal(row.children[2].children[0].src, '/api/images/updated'); assert.ok(row.children[2].children[0] !== image);
  render([]); await delay(0); assert.equal(row.children[2].children.length, 0, 'An explicit empty file list still removes references');
});

test('background conversation deltas do not redraw the selected conversation', async t => {
  const f = await fixture(t, [message('live', 'Reply')]), writes = watch([f.dom.get('thread-title')]);
  f.notify(2, 'item/agentMessage/delta', { threadId: 'other', itemId: 'elsewhere', delta: 'Background reply' }); await delay(0);
  assert.equal(writes(), 0); assert.equal(f.chat.getState().turns[0].items[0].text, 'Reply');
});

test('reply deltas retain draft attachment nodes and focused removal controls', async t => {
  const f = await fixture(t, [message('live', 'Reply')]), state = f.chat.getState();
  state.attachments.push({ id: 'upload', name: 'draft.png', status: 'complete', imageHref: '/api/images/upload' }); f.chat.connection(true);
  const attachments = f.dom.get('attachments'), thumbnail = attachments.children[0], remove = thumbnail.children.at(-1); remove.focus();
  f.notify(2, 'item/agentMessage/delta', { itemId: 'live', delta: ' next' }); await delay(0);
  assert.ok(attachments.children[0] === thumbnail, 'An unchanged draft image must stay mounted');
  assert.equal(f.dom.document.activeElement, remove); assert.equal(remove.isConnected, true);
  remove.click(); assert.equal(state.attachments.length, 0); assert.equal(attachments.children.length, 0);
});
