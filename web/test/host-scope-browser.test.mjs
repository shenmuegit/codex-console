import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mountChat } from '../public/chat.js';
import { mountAttachments } from '../public/composer.js';
import { domFixture } from './dom.mjs';
import { resumeFixture } from './helpers.mjs';

test('colliding thread drafts and direct exports keep the mounted host', async t => {
  const dom = domFixture();
  const api = async (path, body) => path === '/api/thread/open' ? { snapshot: resumeFixture(body.threadId), cursor: { generation: 1, seq: 1 } } : { result: { data: [], nextCursor: null } };
  let chat;
  t.after(() => { chat?.dispose(); dom.restore(); });
  const open = async host => { chat?.dispose(); chat = mountChat({ api, viewId: 'view', selectedHost: host }); chat.connection(true); await chat.open('collision'); };
  await open('host-a'); dom.get('draft').value = 'A draft'; dom.event('draft', 'input');
  await open('host-b'); assert.equal(chat.getState().draft, ''); dom.get('draft').value = 'B draft'; dom.event('draft', 'input');
  await open('host-a'); assert.equal(chat.getState().draft, 'A draft');
  const create = dom.document.createElement.bind(dom.document); let exportHref;
  dom.document.createElement = tag => { const node = create(tag); if (tag === 'a') node.click = () => { exportHref = node.href; }; return node; };
  dom.get('draft').value = '/export'; dom.event('draft', 'input'); dom.event('composer', 'submit'); await delay(0);
  assert.equal(new URL(exportHref, dom.location.href).searchParams.get('host'), 'host-a');
  await open('local'); assert.equal(chat.getState().draft, '');
});

test('XHR uploads retain the explicit host even when the page URL changes', async t => {
  const dom = domFixture(); t.after(() => dom.restore()); const original = globalThis.XMLHttpRequest; t.after(() => { globalThis.XMLHttpRequest = original; });
  let destination;
  globalThis.XMLHttpRequest = class { upload = {}; open(_method, path) { destination = path; } setRequestHeader() {} send() { this.status = 201; this.responseText = JSON.stringify({ status: 'complete' }); this.onload(); } abort() {} };
  const state = { threadId: 'collision', ready: true, online: true, attachments: [] };
  const attachments = mountAttachments({ api: async () => ({ id: 'upload-one' }), viewId: 'view', selectedHost: 'host-a', getState: () => state, getStates: () => [state], onChange() {}, uploadLimitBytes: 32 }); t.after(() => attachments.dispose());
  dom.location.href = 'https://fixture.test/?host=host-b';
  dom.get('file-input').files = [new Blob(['file'], { type: 'text/plain' })]; dom.get('file-input').files[0].name = 'note.txt';
  dom.event('file-input', 'change'); await delay(0);
  assert.equal(new URL(destination, dom.location.href).searchParams.get('host'), 'host-a');
});

import { mountFollowups } from '../public/followups.js';
test('side chat retains its mounted host', async t => {
  const dom = domFixture(); let chat, followups; t.after(() => { chat?.dispose(); followups?.dispose(); dom.restore(); });
  const state = { threadId: 'collision', ready: true, online: true, cursor: { generation: 1, seq: 1 }, turns: [{ id: 'turn', status: 'inProgress', items: [] }] };
  const queued = { id: 'queued', clientUserMessageId: 'client', input: [{ type: 'text', text: 'Task', text_elements: [] }] };
  const api = async (path, body) => path === '/api/thread/queue' ? { result: { threadId: 'side-thread' } } : { result: { data: body.method === 'thread/queue/list' ? [queued] : [], nextCursor: null }, cursor: { generation: 1, seq: 2 } };
  followups = mountFollowups({ api, selectedHost: 'host-a', viewId: 'view', getState: () => state, onChange() {}, onError: assert.fail });
  await followups.load(state); followups.render(state);
  dom.get('queued-messages').children[0].querySelectorAll().find(node => node.dataset.action === 'menu').click();
  dom.get('queue-menu-side').click(); await delay(0);
  assert.equal(new URL(dom.get('side-chat-frame').src, dom.location.href).searchParams.get('host'), 'host-a');
});

import { renderTranscript } from '../transcript.mjs';
test('remote transcript photos and downloads remain visible with scoped reference URLs', async t => {
  const dom = domFixture(), user = { id: 'user', type: 'userMessage', content: [{ type: 'localImage', path: '/remote/photo.png' }] };
  const snapshot = resumeFixture('collision', [{ id: 'turn', status: 'completed', items: [user] }]);
  const files = [{ name: 'photo.png', href: '/api/files/photo?host=host-a', imageHref: '/api/images/photo?host=host-a' }, { name: 'result.txt', href: '/api/files/result?host=host-a' }];
  snapshot.transcript = renderTranscript(snapshot.thread, snapshot.initialTurnsPage.data, new Map([[user.id, files]]));
  const api = async path => path === '/api/thread/open' ? { snapshot, cursor: { generation: 1, seq: 1 } } : { result: { data: [], nextCursor: null } };
  const chat = mountChat({ api, viewId: 'view', selectedHost: 'host-a' }); t.after(() => { chat.dispose(); dom.restore(); }); chat.connection(true); await chat.open('collision');
  const rendered = dom.get('messages').children[0].children[2].children;
  assert.equal(rendered[0].tagName, 'IMG'); assert.equal(rendered[0].src, files[0].imageHref); assert.equal(rendered[1].href, files[1].href);
});

test('Markdown thread references and subagent links open on the same host', async t => {
  const dom = domFixture(), items = [{ id: 'reply', type: 'agentMessage', text: '[Other](thread://child)' }, { id: 'agent', type: 'subAgentActivity', kind: 'started', agentPath: '/root/child', agentThreadId: 'child' }];
  const snapshot = resumeFixture('collision', [{ id: 'turn', status: 'completed', items }]); snapshot.transcript = renderTranscript(snapshot.thread, snapshot.initialTurnsPage.data);
  const api = async path => path === '/api/thread/open' ? { snapshot, cursor: { generation: 1, seq: 1 } } : { result: { data: [], nextCursor: null } };
  const chat = mountChat({ api, viewId: 'view', selectedHost: 'host-a' }); t.after(() => { chat.dispose(); dom.restore(); }); chat.connection(true); await chat.open('collision');
  const messages = dom.get('messages').children;
  const markdown = messages[0].children[1].children[0].children[0], agent = messages[1].children[0].children[1];
  assert.equal(new URL(markdown.href, dom.location.href).searchParams.get('host'), 'host-a');
  assert.equal(new URL(agent.href, dom.location.href).searchParams.get('host'), 'host-a');
});
