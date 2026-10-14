import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createTransport, pageEntryUrl } from '../../web/public/transport.js';
import { mountChat } from '../../web/public/chat.js';
import { mountAttachments, mountImageViewer } from '../../web/public/composer.js';
import { mountFollowups } from '../../web/public/followups.js';
import { domFixture } from './dom.mjs';
import { resumeFixture } from './helpers.mjs';

test('transport_preserves_backend_scope_and_error_outcome', async t => {
  const transport = createTransport('https://codex.example.test');
  assert.equal(transport.url('/api/uploads/u?viewId=v&host=host-a'), 'https://codex.example.test/api/uploads/u?viewId=v&host=host-a');
  assert.equal(createTransport().url('/api/status'), '/api/status');
  for (const path of ['https://evil.example/api/status', '/api/../auth', '/api/%2e%2e/auth', '//evil.example/api/status', '/api/\\evil', '/api/status#fragment']) assert.throws(() => transport.url(path));
  for (const origin of ['http://codex.example.test', 'https://codex.example.test/', 'https://codex.example.test/path', 'https://user@codex.example.test', 'https://CODEX.example.test', 'https://codex.example.test:443']) assert.throws(() => createTransport(origin));
  const fetchBefore = globalThis.fetch, sourceBefore = globalThis.EventSource, calls = [], streams = [];
  t.after(() => { globalThis.fetch = fetchBefore; if (sourceBefore) globalThis.EventSource = sourceBefore; else delete globalThis.EventSource; });
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return { ok: false, status: 504, json: async () => ({ error: { code: 'NATIVE_TIMEOUT', outcome: 'unknown', message: 'Timed out' } }) }; };
  globalThis.EventSource = class { constructor(url, options) { streams.push({ url, options }); } };
  await assert.rejects(transport.request('/api/thread/send?host=host-a', { viewId: 'v', threadId: 't' }), error => error.status === 504 && error.code === 'NATIVE_TIMEOUT' && error.outcome === 'unknown');
  assert.deepEqual(calls, [{ url: 'https://codex.example.test/api/thread/send?host=host-a', options: { credentials: 'include', method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"viewId":"v","threadId":"t"}' } }]);
  transport.eventSource('/api/events?viewId=v&host=host-a');
  assert.deepEqual(streams, [{ url: 'https://codex.example.test/api/events?viewId=v&host=host-a', options: { withCredentials: true } }]);
  globalThis.fetch = async (url, options) => { assert.equal(url, '/api/status'); assert.deepEqual(options, { credentials: 'include' }); return { ok: true, json: async () => ({ online: true }) }; };
  assert.deepEqual(await createTransport().request('/api/status'), { online: true });
});

test('page_entry_keeps_release_path', () => {
  assert.equal(pageEntryUrl('/?thread=t&host=host-a&side=1', 'https://plugin.example.test/plugins/r/dist/index.html'), '/plugins/r/dist/index.html?thread=t&host=host-a&side=1');
  assert.equal(pageEntryUrl('/?thread=t', 'https://fixture.test/'), '/?thread=t');
  assert.equal(pageEntryUrl('/api/status', 'https://plugin.example.test/plugins/r/dist/index.html'), '/api/status');
  assert.equal(pageEntryUrl('https://external.test/?thread=t', 'https://plugin.example.test/plugins/r/dist/index.html'), 'https://external.test/?thread=t');
});

test('all_resource_paths_use_business_origin and retain rendered node identity', async t => {
  const dom = domFixture(), transport = createTransport('https://codex.example.test');
  dom.location.href = 'https://plugin.example.test/plugins/r/dist/index.html?thread=t';
  const item = { id: 'reply', type: 'agentMessage', text: 'Resources' };
  const snapshot = resumeFixture('t', [{ id: 'turn', status: 'completed', items: [item] }]);
  snapshot.transcript = { items: [{ id: 'reply', text: 'Resources', html: '<p><img class="chat-image" tabindex="0" src="/api/images/photo?host=host-a"><a href="/api/files/note?host=host-a">File</a><a href="/?thread=child">Thread</a><a href="https://external.test/api/files/no">External</a></p>', files: [{ name: 'other.png', imageHref: '/api/images/other?host=host-a' }, { name: 'other.txt', href: '/api/files/other?host=host-a' }] }] };
  const api = async path => path === '/api/thread/open' ? { snapshot, cursor: { generation: 1, seq: 1 } } : { result: { data: [], nextCursor: null } };
  const chat = mountChat({ api, viewId: 'v', selectedHost: 'host-a', businessUrl: transport.url, backendOrigin: 'https://codex.example.test' });
  t.after(() => { chat.dispose(); dom.restore(); }); chat.connection(true); await chat.open('t');
  const message = dom.get('messages').children[0], paragraph = message.children[1].children[0], [image, file, thread, external] = paragraph.children;
  assert.equal(image.src, 'https://codex.example.test/api/images/photo?host=host-a');
  assert.equal(file.href, 'https://codex.example.test/api/files/note?host=host-a');
  assert.equal(thread.href, '/plugins/r/dist/index.html?thread=child&host=host-a');
  assert.equal(external.href, 'https://external.test/api/files/no');
  assert.equal(message.children[2].children[0].src, 'https://codex.example.test/api/images/other?host=host-a');
  assert.equal(message.children[2].children[1].href, 'https://codex.example.test/api/files/other?host=host-a');
  chat.getState().attachments = [{ id: 'draft', name: 'draft.png', status: 'complete', imageHref: '/api/images/draft?host=host-a' }]; chat.connection(true);
  assert.equal(dom.get('attachments').children[0].children[0].src, 'https://codex.example.test/api/images/draft?host=host-a');
  chat.getState().attachments[0].imageHref = 'https://evil.example/api/images/draft'; chat.connection(true);
  assert.equal(dom.get('attachments').children[0].children[0].tagName, 'SPAN');
  chat.onEvent({ kind: 'render', cursor: { generation: 1, seq: 1 }, native: { threadId: 't', items: [{ ...snapshot.transcript.items[0], cursor: { generation: 1, seq: 1 }, html: snapshot.transcript.items[0].html.replace('File</a>', 'Updated file</a>') }] } });
  await delay(0); assert.equal(message.children[1].children[0], paragraph); assert.equal(paragraph.children[0], image); assert.equal(file.textContent, 'Updated file');
  const create = dom.document.createElement.bind(dom.document); let exportHref;
  dom.document.createElement = tag => { const node = create(tag); if (tag === 'a') node.click = () => { exportHref = node.href; }; return node; };
  dom.get('draft').value = '/export'; dom.event('draft', 'input'); dom.event('composer', 'submit'); await delay(0);
  assert.equal(exportHref, 'https://codex.example.test/api/thread/export?threadId=t&host=host-a');
});

test('business uploads keep view and host, progress and cancellation without retry', async t => {
  const dom = domFixture(), before = globalThis.XMLHttpRequest, transfers = [];
  globalThis.XMLHttpRequest = class { upload = {}; open(method, url) { this.method = method; this.url = url; } setRequestHeader() {} send(file) { this.file = file; transfers.push(this); } abort() { this.aborted = true; this.onabort(); } };
  const state = { threadId: 't', ready: true, attachments: [] }, transport = createTransport('https://codex.example.test');
  const attachments = mountAttachments({ api: async () => ({ id: 'u' }), businessUrl: transport.url, selectedHost: 'host-a', viewId: 'v', getState: () => state, getStates: () => [state], onChange() {}, uploadLimitBytes: 32 });
  t.after(() => { attachments.dispose(); dom.restore(); globalThis.XMLHttpRequest = before; });
  dom.get('file-input').files = [new File(['bytes'], 'note.txt', { type: 'text/plain' })]; dom.event('file-input', 'change'); await delay(0);
  assert.equal(transfers[0].url, 'https://codex.example.test/api/uploads/u?viewId=v&host=host-a'); assert.equal(transfers[0].withCredentials, true);
  await delay(110); transfers[0].upload.onprogress({ loaded: 2, total: 5 }); attachments.render(state);
  assert.equal(state.attachments[0].progress, 40); assert.equal(dom.get('attachments').children[0].children[1].value, 40);
  dom.get('attachments').children[0].children.at(-1).click(); await delay(0);
  assert.equal(transfers[0].aborted, true); assert.equal(state.attachments.length, 0); assert.equal(transfers.length, 1);
});

test('approved backend previews allow images and page blobs only', t => {
  const dom = domFixture(), viewer = mountImageViewer({ backendOrigin: 'https://codex.example.test' });
  t.after(() => { viewer.dispose(); dom.restore(); });
  const image = dom.document.createElement('img'); image.className = 'chat-image';
  const click = src => { image.src = src; const event = new Event('click'); Object.defineProperty(event, 'target', { value: image }); dom.document.body.dispatchEvent(event); return dom.get('image-viewer').open; };
  for (const src of ['https://codex.example.test/api/images/photo?host=host-a', 'blob:https://fixture.test/local']) { assert.equal(click(src), true); dom.get('image-viewer').close(); }
  for (const src of ['https://evil.example/api/images/photo', 'https://codex.example.test/api/files/photo', 'blob:https://codex.example.test/local']) assert.equal(click(src), false);
});

test('side chat uses the current plugin release entry', async t => {
  const dom = domFixture(); dom.location.href = 'https://plugin.example.test/plugins/r/dist/index.html?host=host-a';
  const state = { threadId: 't', ready: true, online: true, turns: [{ id: 'turn', status: 'inProgress', items: [] }] };
  const queued = { id: 'q', clientUserMessageId: 'client', input: [{ type: 'text', text: 'Task', text_elements: [] }] };
  const api = async (path, body) => path === '/api/thread/queue' ? { result: { threadId: 'side-thread' } } : { result: { data: body.method === 'thread/queue/list' ? [queued] : [], nextCursor: null } };
  const followups = mountFollowups({ api, viewId: 'v', selectedHost: 'host-a', getState: () => state, onChange() {}, onError: assert.fail });
  t.after(() => { followups.dispose(); dom.restore(); }); await followups.load(state); followups.render(state);
  dom.get('queued-messages').children[0].querySelectorAll().find(node => node.dataset.action === 'menu').click(); dom.get('queue-menu-side').click(); await delay(0);
  assert.equal(dom.get('side-chat-frame').src, '/plugins/r/dist/index.html?thread=side-thread&side=1&host=host-a');
});
