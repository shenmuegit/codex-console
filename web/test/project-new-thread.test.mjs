import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mountChat } from '../public/chat.js';
import { domFixture } from './dom.mjs';
import { resumeFixture } from './helpers.mjs';

async function fixture(t, start = async () => {}) {
  const dom = domFixture(), calls = [], projects = ['p', 'q'].map(id => ({ id, name: id, roots: [{ path: '/' + id }], metadata: {} }));
  assert.ok(dom.get('thread-menu-new'), 'Context menus offer New conversation');
  dom.get('thread-menu').append(...['new', 'copy', 'rename', 'archive', 'delete'].map(action => dom.get('thread-menu-' + action)));
  const threads = [{ id: 'existing-p', projectId: 'p', name: 'Existing', updatedAt: 1 }]; let seq = 0, boundThread;
  const api = async (path, body) => {
    calls.push({ path, body });
    if (path === '/api/rpc') return { result: { data: body.method === 'project/list' ? projects : body.method === 'thread/list' ? threads.filter(thread => !body.params.archived && (body.params.projectId === undefined || thread.projectId === body.params.projectId)) : [], nextCursor: null } };
    if (path === '/api/thread/start') { await start(); threads.unshift({ id: 'new', projectId: body.projectId, name: 'New', updatedAt: 2 }); boundThread = 'new'; }
    else if (path === '/api/thread/open') boundThread = body.threadId;
    else assert.fail(path);
    const snapshot = resumeFixture(boundThread); snapshot.thread.projectId = body.projectId;
    return { snapshot, cursor: { generation: 1, seq: ++seq } };
  };
  const chat = mountChat({ api, viewId: 'view', uploadLimitBytes: 32 }); chat.connection(true);
  t.after(() => { chat.dispose(); dom.restore(); }); await chat.load(); chat.getState().draft = 'keep this draft';
  const group = id => dom.get('projects').children.find(node => node.children[0].dataset.projectId === id);
  const row = id => group(id).children[0], menu = id => row(id).dispatchEvent(new Event('contextmenu', { cancelable: true }));
  return { dom, chat, calls, projects, group, row, menu, get boundThread() { return boundThread; } };
}

test('project context creation expands the chosen project and places the native new conversation under it', async t => {
  const f = await fixture(t); f.dom.get('show-archived-threads').checked = true;
  f.menu('p'); f.dom.get('thread-menu-new').click(); await delay(0);
  assert.deepEqual(f.calls.find(call => call.path === '/api/thread/start').body, { viewId: 'view', projectId: 'p' });
  assert.equal(f.group('p').children[1].hidden, false); assert.equal(f.dom.get('show-archived-threads').checked, false);
  assert.equal(f.group('p').children[1].children[0].children[0].dataset.threadId, 'new');
  assert.equal(f.chat.getState().threadId, 'new'); assert.equal(f.dom.get('project-title').textContent, '全部会话');
  assert.equal(f.dom.get('threads').children[0].dataset.threadId, 'new');
  await f.chat.open('t'); assert.equal(f.chat.getState().draft, 'keep this draft');
});

test('conversation right-click and action menus keep the containing project despite another selected project', async t => {
  const f = await fixture(t); f.row('p').click(); await delay(0); f.row('q').click(); await delay(0);
  const conversation = f.group('p').children[1].children[0].children[0];
  const event = new Event('contextmenu', { cancelable: true }); conversation.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true); assert.equal(f.dom.get('thread-menu').hidden, false);
  f.dom.event('thread-menu', 'keydown', { key: 'Escape' });
  conversation.children[1].click(); f.dom.get('thread-menu-new').click(); await delay(0);
  assert.equal(f.calls.find(call => call.path === '/api/thread/start').body.projectId, 'p');
  assert.equal(f.group('p').children[1].children[0].children[0].dataset.threadId, 'new');
});

test('pending creation prevents duplicate requests and cannot replace a newer project selection or draft', async t => {
  let finish; const f = await fixture(t, () => new Promise(resolve => { finish = resolve; }));
  f.menu('p'); f.dom.get('thread-menu-new').click(); await delay(0);
  f.menu('p'); assert.equal(f.dom.get('thread-menu-new').disabled, true); f.dom.get('thread-menu-new').click();
  f.dom.event('thread-menu', 'keydown', { key: 'Escape' }); f.row('q').click(); await delay(0); finish(); await delay(0);
  assert.equal(f.calls.filter(call => call.path === '/api/thread/start').length, 1);
  assert.equal(f.chat.getState().threadId, 't'); assert.equal(f.chat.getState().draft, 'keep this draft');
  assert.equal(f.row('q').getAttribute('aria-current'), 'true'); assert.equal(f.boundThread, 't');
});

test('offline and archived project menus cannot start a native conversation', async t => {
  const f = await fixture(t); f.menu('p'); f.chat.connection(false);
  assert.equal(f.dom.get('thread-menu-new').disabled, true); f.dom.get('thread-menu-new').click();
  assert.equal(f.calls.some(call => call.path === '/api/thread/start'), false);
  f.chat.connection(true); f.projects[0].metadata['codex-console.archived'] = 'true';
  f.dom.get('show-archived-projects').click(); await delay(0); f.menu('p');
  assert.equal(f.dom.get('thread-menu-new').disabled, true); f.dom.get('thread-menu-new').click();
  assert.equal(f.calls.some(call => call.path === '/api/thread/start'), false);
});
