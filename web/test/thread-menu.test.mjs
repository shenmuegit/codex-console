import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mountChat } from '../public/chat.js';
import { resumeFixture } from './helpers.mjs';
import { domFixture } from './dom.mjs';

const other = 'thread-other-0123456789abcdefghijklmnopqrstuvwxyz';
async function fixture(t, activeOther = false) {
  const dom = domFixture(); dom.location.href = 'https://fixture.test/'; let chat, seq = 0;
  const calls = [], archived = new Set(), deleted = new Set();
  const threads = ['current', other].map(id => ({ id, name: id, updatedAt: 1, status: { type: activeOther && id === other ? 'active' : 'idle' } }));
  t.after(() => { chat?.dispose(); dom.restore(); });
  const api = async (path, body) => {
    if (path === '/api/rpc') return { result: { data: body.method === 'thread/list' ? threads.filter(item => !deleted.has(item.id) && archived.has(item.id) === Boolean(body.params.archived)) : [], nextCursor: null } };
    if (path === '/api/thread/open') return { snapshot: resumeFixture(body.threadId), cursor: { generation: 1, seq: ++seq } };
    calls.push({ path, body });
    if (path === '/api/thread/archive') archived.add(body.threadId);
    else if (path === '/api/thread/unarchive') archived.delete(body.threadId);
    else if (path === '/api/thread/delete') deleted.add(body.threadId);
    else assert.fail(path);
    return {};
  };
  chat = mountChat({ api, viewId: 'view', uploadLimitBytes: 32 }); chat.connection(true); await chat.load(); await chat.open('current'); chat.getState().draft = 'keep my current draft';
  const menu = id => { const row = dom.get('threads').children.find(node => node.dataset.threadId === id); assert.ok(row, 'Conversation row has its own action menu'); row.children[1].click(); };
  return { dom, chat, calls, menu };
}

test('row menu copies the full clicked ID and supports keyboard dismissal without changing selection', async t => {
  const f = await fixture(t); f.menu(other);
  assert.equal(f.dom.get('thread-menu').hidden, false); assert.equal(f.dom.document.activeElement, f.dom.get('thread-menu-copy'));
  f.dom.get('thread-menu-copy').click(); await delay(0);
  assert.deepEqual(f.dom.clipboardWrites, [other]); assert.equal(f.chat.getState().threadId, 'current'); assert.equal(f.chat.getState().draft, 'keep my current draft'); assert.deepEqual(f.calls, []);
  f.menu(other); f.dom.event('thread-menu', 'keydown', { key: 'ArrowDown' }); assert.equal(f.dom.document.activeElement, f.dom.get('thread-menu-archive'));
  f.dom.event('thread-menu', 'keydown', { key: 'Escape' }); assert.equal(f.dom.get('thread-menu').hidden, true);
  assert.equal(f.dom.document.activeElement.getAttribute('aria-expanded'), 'false');
});

test('archive restore and delete operate on the clicked row and preserve another chat draft', async t => {
  const f = await fixture(t); f.menu(other); f.dom.get('thread-menu-archive').click(); await delay(0);
  assert.deepEqual(f.calls[0], { path: '/api/thread/archive', body: { viewId: 'view', threadId: other, confirmed: true } });
  assert.equal(f.chat.getState().threadId, 'current'); assert.equal(f.chat.getState().draft, 'keep my current draft');
  f.dom.get('show-archived-threads').checked = true; f.dom.event('show-archived-threads', 'change'); await delay(0);
  f.menu(other); assert.equal(f.dom.get('thread-menu-archive').textContent, '恢复会话'); f.dom.get('thread-menu-archive').click(); await delay(0);
  assert.equal(f.calls[1].path, '/api/thread/unarchive'); assert.equal(f.calls[1].body.threadId, other);
  await f.chat.open('current'); f.menu(other); f.dom.get('thread-menu-delete').click(); f.dom.get('thread-menu-delete').click(); await delay(0);
  assert.equal(f.calls.filter(call => call.path === '/api/thread/delete').length, 1); assert.equal(f.calls.at(-1).body.threadId, other);
  assert.equal(f.chat.getState().threadId, 'current'); assert.equal(f.chat.getState().draft, 'keep my current draft');
});

test('delete asks for confirmation and clears only the selected conversation after success', async t => {
  const f = await fixture(t); window.confirm = () => false; f.menu('current'); f.dom.get('thread-menu-delete').click(); await delay(0);
  assert.deepEqual(f.calls, []); assert.equal(f.chat.getState().threadId, 'current');
  window.confirm = () => true; f.menu('current'); f.dom.get('thread-menu-delete').click(); await delay(0);
  assert.equal(f.chat.getState(), undefined); assert.equal(new URL(f.dom.location.href).searchParams.has('thread'), false);
  assert.equal(f.dom.get('draft').value, '');
});

test('archiving a running row can be cancelled before any native interruption', async t => {
  const f = await fixture(t, true); window.confirm = () => false;
  f.menu(other); f.dom.get('thread-menu-archive').click(); await delay(0);
  assert.deepEqual(f.calls, []); assert.equal(f.chat.getState().threadId, 'current');
  window.confirm = () => true; f.menu(other); f.dom.get('thread-menu-archive').click(); await delay(0);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].body.threadId, other);
});

test('archive confirmation does not trust a stale idle list row', async t => {
  const f = await fixture(t); let confirmations = 0;
  f.chat.onEvent({ kind: 'notification', cursor: { generation: 1, seq: 2 }, native: { method: 'turn/started', params: { threadId: 'current', turn: { id: 'running', status: 'inProgress', items: [] } } } });
  assert.equal(f.chat.getState().turns.at(-1).status, 'inProgress');
  window.confirm = () => { confirmations++; return false; };
  f.menu('current'); f.dom.get('thread-menu-archive').click(); await delay(0);
  assert.equal(confirmations, 1); assert.deepEqual(f.calls, []); assert.equal(f.chat.getState().ready, true);
  f.menu(other); f.dom.get('thread-menu-archive').click(); await delay(0);
  assert.equal(confirmations, 2); assert.deepEqual(f.calls, []);
});
