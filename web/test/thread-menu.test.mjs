import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mountChat } from '../public/chat.js';
import { resumeFixture } from './helpers.mjs';
import { domFixture } from './dom.mjs';

const other = 'thread-other-0123456789abcdefghijklmnopqrstuvwxyz';
async function fixture(t, activeOther = false, unarchiveResult, renameResult) {
  const dom = domFixture(); dom.location.href = 'https://fixture.test/?thread=current'; let chat, seq = 0;
  const calls = [], archived = new Set(), deleted = new Set();
  const threads = ['current', other].map(id => ({ id, name: id, updatedAt: 1, status: { type: activeOther && id === other ? 'active' : 'idle' } }));
  t.after(() => { chat?.dispose(); dom.restore(); });
  const api = async (path, body) => {
    if (path === '/api/rpc') return { result: { data: body.method === 'thread/list' ? threads.filter(item => !deleted.has(item.id) && archived.has(item.id) === Boolean(body.params.archived)) : [], nextCursor: null } };
    if (path === '/api/thread/open') return { snapshot: resumeFixture(body.threadId), cursor: { generation: 1, seq: ++seq } };
    calls.push({ path, body });
    if (path === '/api/thread/archive') archived.add(body.threadId);
    else if (path === '/api/thread/unarchive') { archived.delete(body.threadId); await unarchiveResult; }
    else if (path === '/api/thread/delete') deleted.add(body.threadId);
    else if (path === '/api/thread/rename') { await renameResult; threads.find(item => item.id === body.threadId).name = body.name; }
    else assert.fail(path);
    return {};
  };
  chat = mountChat({ api, viewId: 'view', uploadLimitBytes: 32 }); chat.connection(true); await chat.load(); chat.getState().draft = 'keep my current draft';
  const menu = id => { const row = dom.get('threads').children.find(node => node.dataset.threadId === id); assert.ok(row, 'Conversation row has its own action menu'); row.children[1].click(); };
  const rename = id => { menu(id); const button = dom.get('thread-menu-rename'); assert.ok(button, 'Conversation options include Rename'); button.click(); };
  return { dom, chat, calls, menu, rename };
}

test('row menu copies the full clicked ID and supports keyboard dismissal without changing selection', async t => {
  const f = await fixture(t); f.menu(other);
  assert.equal(f.dom.get('thread-menu').hidden, false); assert.equal(f.dom.document.activeElement, f.dom.get('thread-menu-copy'));
  f.dom.get('thread-menu-copy').click(); await delay(0);
  assert.deepEqual(f.dom.clipboardWrites, [other]); assert.equal(f.chat.getState().threadId, 'current'); assert.equal(f.chat.getState().draft, 'keep my current draft'); assert.deepEqual(f.calls, []);
  f.menu(other); f.dom.event('thread-menu', 'keydown', { key: 'ArrowDown' }); assert.equal(f.dom.document.activeElement, f.dom.get('thread-menu-rename'));
  f.dom.event('thread-menu', 'keydown', { key: 'ArrowDown' }); assert.equal(f.dom.document.activeElement, f.dom.get('thread-menu-archive'));
  f.dom.event('thread-menu', 'keydown', { key: 'Escape' }); assert.equal(f.dom.get('thread-menu').hidden, true);
  assert.equal(f.dom.document.activeElement.getAttribute('aria-expanded'), 'false');
});

test('row rename changes the clicked conversation and preserves the selected chat draft', async t => {
  const f = await fixture(t); window.prompt = (_label, value) => { assert.equal(value, other); return '  新标题  '; };
  f.rename(other); await delay(0);
  assert.deepEqual(f.calls, [{ path: '/api/thread/rename', body: { viewId: 'view', threadId: other, name: '新标题' } }]);
  assert.equal(f.dom.get('threads').children.find(row => row.dataset.threadId === other).children[0].children[0].textContent, '新标题');
  assert.equal(f.chat.getState().threadId, 'current'); assert.equal(f.chat.getState().draft, 'keep my current draft');
  window.prompt = () => 'Current title'; f.rename('current'); await delay(0);
  assert.equal(f.dom.get('thread-title').textContent, 'Current title'); assert.equal(f.chat.getState().draft, 'keep my current draft');
});

test('cancelled empty and offline row renames do not send a native write', async t => {
  const f = await fixture(t);
  for (const answer of [null, '   ']) { window.prompt = () => answer; f.rename(other); await delay(0); }
  f.chat.connection(false); f.menu(other); assert.equal(f.dom.get('thread-menu-rename').disabled, true);
  f.dom.get('thread-menu-rename').click(); await delay(0);
  assert.deepEqual(f.calls, []); assert.equal(f.chat.getState().draft, 'keep my current draft');
});

test('pending row rename cannot submit twice or replace newer navigation', async t => {
  let finish; const f = await fixture(t, false, undefined, new Promise(resolve => { finish = resolve; }));
  window.prompt = () => 'Later title'; f.rename(other); f.rename(other); await delay(0);
  assert.equal(f.calls.length, 1); assert.equal(f.dom.get('thread-menu-rename').disabled, true);
  await f.chat.open('later'); f.chat.getState().draft = 'newer draft'; finish(); await delay(0);
  assert.equal(f.chat.getState().threadId, 'later'); assert.equal(f.chat.getState().draft, 'newer draft');
  assert.equal(new URL(f.dom.location.href).searchParams.get('thread'), 'later');
});

test('rename failure retains the original name and draft and reports the native error', async t => {
  let fail; const f = await fixture(t, false, undefined, new Promise((_resolve, reject) => { fail = reject; }));
  const name = f.chat.getState().thread.name; window.prompt = () => 'Rejected title'; f.rename('current'); fail(new Error('Rename rejected')); await delay(0);
  assert.equal(f.chat.getState().thread.name, name); assert.equal(f.dom.get('thread-title').textContent, name);
  assert.equal(f.chat.getState().draft, 'keep my current draft'); assert.match(f.dom.get('chat-error').textContent, /Rename rejected/);
});

test('slash rename uses the same native action and immediately updates the selected title', async t => {
  const f = await fixture(t); f.dom.get('draft').value = '/rename Slash title'; f.dom.event('draft', 'input'); f.dom.event('composer', 'submit'); await delay(0);
  assert.deepEqual(f.calls, [{ path: '/api/thread/rename', body: { viewId: 'view', threadId: 'current', name: 'Slash title' } }]);
  assert.equal(f.dom.get('thread-title').textContent, 'Slash title'); assert.equal(f.chat.getState().draft, '');
});

test('archive restore and delete operate on the clicked row and preserve another chat draft', async t => {
  const f = await fixture(t); f.menu(other); f.dom.get('thread-menu-archive').click(); await delay(0);
  assert.deepEqual(f.calls[0], { path: '/api/thread/archive', body: { viewId: 'view', threadId: other, confirmed: true } });
  assert.equal(f.chat.getState().threadId, 'current'); assert.equal(f.chat.getState().draft, 'keep my current draft');
  f.dom.get('show-archived-threads').checked = true; f.dom.event('show-archived-threads', 'change'); await delay(0);
  f.menu(other); assert.equal(f.dom.get('thread-menu-archive').textContent, '恢复会话'); f.dom.get('thread-menu-archive').click(); await delay(0);
  assert.equal(f.calls[1].path, '/api/thread/unarchive'); assert.equal(f.calls[1].body.threadId, other);
  assert.equal(f.chat.getState().threadId, 'current'); assert.equal(f.chat.getState().draft, 'keep my current draft');
  assert.equal(f.dom.get('show-archived-threads').checked, true);
  f.dom.get('show-archived-threads').checked = false; f.dom.event('show-archived-threads', 'change'); await delay(0);
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

test('pending menu restore preserves newer navigation and cannot submit twice', async t => {
  let finish; const f = await fixture(t, false, new Promise(resolve => { finish = resolve; }));
  f.menu(other); f.dom.get('thread-menu-archive').click(); await delay(0);
  f.dom.get('show-archived-threads').checked = true; f.dom.event('show-archived-threads', 'change'); await delay(0);
  f.menu(other); f.dom.get('thread-menu-archive').click();
  f.menu(other); f.dom.get('thread-menu-archive').click();
  assert.equal(f.calls.filter(call => call.path === '/api/thread/unarchive').length, 1);
  await f.chat.open('later'); f.chat.getState().draft = 'newer draft'; finish({}); await delay(0);
  assert.equal(f.chat.getState().threadId, 'later'); assert.equal(f.chat.getState().draft, 'newer draft');
  assert.equal(new URL(f.dom.location.href).searchParams.get('thread'), 'later');
});

test('clicking an archived row opens it unless another navigation supersedes the restore', async t => {
  for (const navigate of [false, true]) await t.test(navigate ? 'newer navigation wins' : 'explicit row selection opens', async t => {
    let finish; const f = await fixture(t, false, new Promise(resolve => { finish = resolve; }));
    f.menu(other); f.dom.get('thread-menu-archive').click(); await delay(0);
    f.dom.get('show-archived-threads').checked = true; f.dom.event('show-archived-threads', 'change'); await delay(0);
    f.dom.get('threads').children.find(node => node.dataset.threadId === other).children[0].click();
    if (navigate) await f.chat.open('later');
    finish({}); await delay(0);
    assert.equal(f.chat.getState().threadId, navigate ? 'later' : other);
    assert.equal(f.dom.get('show-archived-threads').checked, navigate);
  });
});
