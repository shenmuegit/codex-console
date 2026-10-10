import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mountChat } from '../public/chat.js';
import { domFixture } from './dom.mjs';
import { resumeFixture } from './helpers.mjs';

async function fixture(t, { failProjectRefresh = false, listThreads, roots = ['/demo'] } = {}) {
  const dom = domFixture(), reads = [];
  let projectReads = 0;
  const api = async (path, body) => {
    if (path === '/api/thread/open') return { snapshot: resumeFixture(body.threadId), cursor: { generation: 1, seq: 1 } };
    assert.equal(path, '/api/rpc'); reads.push(body);
    if (body.method === 'thread/list' && listThreads) return { result: await listThreads(body.params) };
    if (body.method === 'project/list' && ++projectReads > 1 && failProjectRefresh) throw new Error('Project list unavailable');
    const data = body.method === 'project/list' ? [{ id: 'p', name: 'Demo', roots: roots.map(path => ({ path })) }, { id: 'q', name: 'Other', roots: [{ path: '/other' }] }] :
      body.method === 'thread/list' && !body.params.archived && body.params.projectId !== null ? [{ id: body.params.projectId ? 'project-chat' : 'global-chat', name: 'Chat', updatedAt: 1 }] : [];
    return { result: { data, nextCursor: null } };
  };
  const chat = mountChat({ api, viewId: 'view', uploadLimitBytes: 32 }); chat.connection(true);
  t.after(() => { chat.dispose(); dom.restore(); }); await chat.load();
  const group = id => dom.get('projects').children.find(node => node.children[0]?.dataset.projectId === id);
  return { dom, reads, chat, group, row: id => group(id).children[0], list: id => group(id).children[1].children[0], more: id => group(id).children[1].children[1] };
}

test('expanding projects shows nested conversations and keeps the bottom list global and newest first', async t => {
  const f = await fixture(t);
  assert.equal(f.dom.get('projects').children.length, 2);
  assert.ok(f.reads.filter(call => call.method === 'thread/list').every(call => call.params.projectId === undefined), 'Collapsed projects do not fetch conversations');
  f.row('p').click(); await delay(0);
  assert.equal(f.row('p').getAttribute('aria-expanded'), 'true');
  assert.equal(f.group('p').children[1].hidden, false);
  assert.equal(f.list('p').children[0].dataset.threadId, 'project-chat');
  f.row('q').click(); await delay(0);
  assert.equal(f.group('p').children[1].hidden, false);
  assert.equal(f.group('q').children[1].hidden, false);
  assert.equal(f.dom.get('project-title').textContent, '全部会话');
  assert.equal(f.dom.get('threads').children[0].dataset.threadId, 'global-chat');
  assert.ok(f.reads.filter(call => call.method === 'thread/list').every(call => call.params.sortKey === 'updated_at' && call.params.sortDirection === 'desc'));
  f.row('p').click(); await delay(0);
  assert.equal(f.row('p').getAttribute('aria-expanded'), 'false');
  assert.equal(f.group('p').children[1].hidden, true);
  assert.equal(f.group('q').children[1].hidden, false);
});

test('archived filtering applies to all visible conversation lists without changing their scope', async t => {
  const f = await fixture(t);
  f.row('p').click(); await delay(0);
  f.dom.get('show-archived-threads').checked = true; f.dom.event('show-archived-threads', 'change'); await delay(0);
  assert.match(f.dom.get('threads').children[0].textContent, /已归档会话/);
  assert.match(f.list('p').children[0].textContent, /已归档会话/);
  assert.equal(f.dom.get('project-title').textContent, '全部会话');
});

test('expansion works without refetching the project catalog and a failed thread read can be retried', async t => {
  let fail = true;
  const f = await fixture(t, { failProjectRefresh: true, listThreads: async params => {
    if (params.projectId === 'p' && fail) throw Error('Project conversations unavailable');
    return { data: params.projectId === 'p' ? [{ id: 'project-chat', updatedAt: 1 }] : [], nextCursor: null };
  } });
  f.row('p').click(); await delay(0);
  assert.match(f.dom.get('chat-error').textContent, /Project conversations unavailable/);
  assert.equal(f.group('p').children[1].hidden, false);
  fail = false; f.row('p').click(); f.row('p').click(); await delay(0);
  assert.equal(f.list('p').children[0].dataset.threadId, 'project-chat');
  assert.equal(f.reads.filter(call => call.method === 'project/list').length, 1);
});

test('project conversations merge native membership with unassigned history from every exact registered root', async t => {
  const f = await fixture(t, { roots: ['/demo', '/secondary'], listThreads: async params => ({
    data: params.projectId === 'p' ? [{ id: 'assigned-moved-cwd', updatedAt: 10 }] :
      params.projectId === null ? [{ id: params.archived ? 'archived-legacy' : 'legacy-cwd', updatedAt: 20 }] : [], nextCursor: null,
  }) });
  f.row('p').click(); await delay(0);
  assert.deepEqual(f.list('p').children.map(row => row.dataset.threadId), ['legacy-cwd', 'assigned-moved-cwd']);
  assert.deepEqual(f.reads.find(call => call.params.projectId === null).params.cwd, ['/demo', '/secondary']);
  f.dom.get('show-archived-threads').checked = true; f.dom.event('show-archived-threads', 'change'); await delay(0);
  assert.equal(f.list('p').children[0].dataset.threadId, 'archived-legacy');
  assert.equal(f.reads.findLast(call => call.params.projectId === null).params.archived, true);
});

test('merged project and global pagination keep independent cursors and newer rows first', async t => {
  const entry = n => ({ id: 'chat-' + n, updatedAt: n });
  const f = await fixture(t, { listThreads: async params => {
    if (params.projectId === 'p') return params.cursor ? { data: [entry(20), entry(19)], nextCursor: null } :
      { data: Array.from({ length: 20 }, (_, i) => entry(40 - i)), nextCursor: 'native-next' };
    if (params.projectId === null) return { data: [entry(18), entry(17)], nextCursor: null };
    return params.cursor ? { data: [entry(80)], nextCursor: null } : { data: Array.from({ length: 20 }, (_, i) => entry(100 - i)), nextCursor: 'global-next' };
  } });
  f.row('p').click(); await delay(0);
  assert.equal(f.list('p').children.length, 20); assert.equal(f.more('p').hidden, false);
  f.more('p').click(); f.more('p').click(); await delay(0);
  assert.deepEqual(f.list('p').children.map(row => row.dataset.threadId), Array.from({ length: 24 }, (_, i) => 'chat-' + (40 - i)));
  assert.equal(f.reads.filter(call => call.params.projectId === null).length, 1);
  assert.equal(f.more('p').hidden, true);
  assert.equal(f.dom.get('threads').children.length, 20); assert.equal(f.dom.get('more-threads').hidden, false);
  f.dom.get('more-threads').click(); await delay(0);
  assert.deepEqual(f.dom.get('threads').children.map(row => row.dataset.threadId), Array.from({ length: 21 }, (_, i) => 'chat-' + (100 - i)));
  assert.equal(f.list('p').children.length, 24);
  assert.ok(f.reads.some(call => call.params.cursor === 'global-next' && call.params.projectId === undefined));
});

test('a collapsed project ignores its late response without replacing another expanded list', async t => {
  let finish;
  const f = await fixture(t, { listThreads: params => params.projectId === null && params.cwd.includes('/demo') ?
    new Promise(resolve => { finish = resolve; }) : Promise.resolve({ data: params.projectId === 'q' ? [{ id: 'other-chat', updatedAt: 1 }] : [], nextCursor: null }) });
  f.row('p').click(); await delay(0);
  f.row('p').click(); f.row('q').click(); await delay(0);
  finish({ data: [{ id: 'old-project-chat', updatedAt: 9 }], nextCursor: null }); await delay(0);
  assert.equal(f.group('p').children[1].hidden, true);
  assert.equal(f.row('p').getAttribute('aria-expanded'), 'false');
  assert.deepEqual(f.list('q').children.map(row => row.dataset.threadId), ['other-chat']);
  assert.equal(f.dom.get('project-title').textContent, '全部会话');
});

test('native updates refresh expanded lists and keep collapsed projects unloaded', async t => {
  const f = await fixture(t); f.row('p').click(); await delay(0);
  f.chat.onEvent({ kind: 'notification', cursor: { generation: 1, seq: 2 }, native: { method: 'project/changed', params: { projectId: 'p', changeType: 'updated' } } });
  await delay(0); assert.equal(f.row('p').getAttribute('aria-expanded'), 'true');
  f.reads.length = 0;
  f.chat.onEvent({ kind: 'notification', cursor: { generation: 1, seq: 3 }, native: { method: 'thread/name/updated', params: { threadId: 'project-chat', threadName: 'Updated' } } });
  await delay(350);
  assert.ok(f.reads.some(call => call.params.projectId === 'p'));
  assert.ok(f.reads.some(call => call.method === 'thread/list' && call.params.projectId === undefined));
  assert.ok(!f.reads.some(call => call.params.projectId === 'q'));
});

test('nested conversations use the existing open and conversation menu actions', async t => {
  const f = await fixture(t); f.row('p').click(); await delay(0);
  const conversation = f.list('p').children[0]; conversation.children[1].click();
  assert.equal(f.dom.get('thread-menu-copy').hidden, false);
  f.dom.get('thread-menu-copy').click(); await delay(0);
  assert.deepEqual(f.dom.clipboardWrites, ['project-chat']);
  conversation.children[0].click(); await delay(0);
  assert.equal(f.chat.getState().threadId, 'project-chat');
  assert.equal(f.dom.get('threads').children[0].dataset.threadId, 'global-chat');
});

test('a failed project next page keeps earlier rows and can retry the same native cursor', async t => {
  let fail = true;
  const f = await fixture(t, { listThreads: async params => {
    if (params.projectId !== 'p') return { data: [], nextCursor: null };
    if (!params.cursor) return { data: Array.from({ length: 20 }, (_, i) => ({ id: 'chat-' + i, updatedAt: 40 - i })), nextCursor: 'next-page' };
    if (fail) throw Error('Next page unavailable');
    return { data: [{ id: 'last-chat', updatedAt: 1 }], nextCursor: null };
  } });
  f.row('p').click(); await delay(0); f.more('p').click(); await delay(0);
  assert.equal(f.list('p').children.length, 20); assert.equal(f.more('p').hidden, false); assert.equal(f.more('p').disabled, false);
  assert.match(f.dom.get('chat-error').textContent, /Next page unavailable/);
  fail = false; f.more('p').click(); await delay(0);
  assert.equal(f.list('p').children.length, 21); assert.equal(f.list('p').children.at(-1).dataset.threadId, 'last-chat');
});

test('project context menus preserve disclosure state when opening and closing', async t => {
  const f = await fixture(t); f.row('p').click(); await delay(0);
  for (const id of ['p', 'q']) {
    const expanded = f.row(id).getAttribute('aria-expanded');
    f.row(id).dispatchEvent(new Event('contextmenu', { cancelable: true }));
    assert.equal(f.row(id).getAttribute('aria-expanded'), expanded);
    f.dom.event('thread-menu', 'keydown', { key: 'Escape' });
    assert.equal(f.row(id).getAttribute('aria-expanded'), expanded);
    assert.equal(f.dom.document.activeElement, f.row(id));
  }
});
