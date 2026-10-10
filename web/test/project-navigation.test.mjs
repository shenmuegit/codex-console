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
  return { dom, reads };
}

test('project navigation contains only native projects and conversation scope belongs to the conversation area', async t => {
  const { dom } = await fixture(t);
  assert.equal(dom.get('projects').children.length, 2);
  assert.equal(dom.get('project-title').tagName, 'H2');
  assert.equal(dom.get('all-threads').hidden, true);
  assert.equal(dom.get('project-title').textContent, '全部会话');
});

test('project selection labels and filters conversations while archived empty results explain the filter', async t => {
  const { dom, reads } = await fixture(t);
  dom.get('projects').children.find(row => row.children.some(node => node.textContent === 'Demo')).click(); await delay(0);
  assert.equal(dom.get('project-title').textContent, 'Demo 的会话');
  assert.equal(dom.get('all-threads').hidden, false);
  assert.ok(reads.some(call => call.method === 'thread/list' && call.params.projectId === 'p'));
  assert.equal(dom.get('threads').children[0].dataset.threadId, 'project-chat');
  dom.get('all-threads').focus(); dom.get('all-threads').click(); await delay(0);
  assert.equal(dom.get('project-title').textContent, '全部会话');
  assert.equal(dom.get('all-threads').hidden, true);
  assert.equal(dom.document.activeElement, dom.get('project-title'));
  assert.equal(reads.findLast(call => call.method === 'thread/list').params.projectId, undefined);
  dom.get('show-archived-threads').checked = true; dom.event('show-archived-threads', 'change'); await delay(0);
  assert.match(dom.get('threads').children[0].textContent, /已归档会话/);
});

test('conversation scope stays accurate when the project list cannot refresh', async t => {
  const { dom, reads } = await fixture(t, { failProjectRefresh: true });
  dom.get('projects').children[0].click(); await delay(0);
  assert.equal(dom.get('threads').children[0].dataset.threadId, 'project-chat');
  assert.ok(reads.some(call => call.method === 'thread/list' && call.params.projectId === 'p'));
  assert.equal(dom.get('project-title').textContent, 'Demo 的会话');
  assert.equal(dom.get('project-title').title, 'Demo 的会话');
  assert.equal(dom.get('all-threads').hidden, false);
  assert.match(dom.get('chat-error').textContent, /Project list unavailable/);
  dom.get('all-threads').click(); await delay(0);
  assert.equal(dom.get('threads').children[0].dataset.threadId, 'global-chat');
  assert.equal(dom.get('project-title').textContent, '全部会话');
  assert.equal(dom.get('all-threads').hidden, true);
});

test('project conversations merge native membership with unassigned history from every exact registered root', async t => {
  const { dom, reads } = await fixture(t, { roots: ['/demo', '/secondary'], listThreads: async params => ({
    data: params.projectId === 'p' ? [{ id: 'assigned-moved-cwd', updatedAt: 10 }] :
      params.projectId === null ? [{ id: params.archived ? 'archived-legacy' : 'legacy-cwd', updatedAt: 20 }] : [], nextCursor: null,
  }) });
  dom.get('projects').children[0].click(); await delay(0);
  assert.deepEqual(dom.get('threads').children.map(row => row.dataset.threadId), ['legacy-cwd', 'assigned-moved-cwd']);
  assert.deepEqual(reads.find(call => call.params.projectId === null).params.cwd, ['/demo', '/secondary']);
  dom.get('show-archived-threads').checked = true; dom.event('show-archived-threads', 'change'); await delay(0);
  assert.equal(dom.get('threads').children[0].dataset.threadId, 'archived-legacy');
  assert.equal(reads.findLast(call => call.params.projectId === null).params.archived, true);
});

test('merged project pagination keeps newer native history ahead of older legacy pages without losing buffered rows', async t => {
  const entry = n => ({ id: 'chat-' + n, updatedAt: n });
  const { dom, reads } = await fixture(t, { listThreads: async params => {
    if (params.projectId === 'p') return params.cursor ? { data: [entry(20), entry(19)], nextCursor: null } :
      { data: Array.from({ length: 20 }, (_, i) => entry(40 - i)), nextCursor: 'native-next' };
    if (params.projectId === null) return { data: [entry(18), entry(17)], nextCursor: null };
    return { data: [], nextCursor: null };
  } });
  dom.get('projects').children[0].click(); await delay(0);
  assert.equal(dom.get('threads').children.length, 20); assert.equal(dom.get('more-threads').hidden, false);
  dom.get('more-threads').click(); await delay(0);
  assert.deepEqual(dom.get('threads').children.map(row => row.dataset.threadId), Array.from({ length: 24 }, (_, i) => 'chat-' + (40 - i)));
  assert.equal(reads.filter(call => call.params.projectId === null).length, 1);
  assert.equal(dom.get('more-threads').hidden, true);
});

test('a late legacy-history response cannot replace the newly selected project scope', async t => {
  let finish;
  const { dom } = await fixture(t, { listThreads: params => params.projectId === null && params.cwd.includes('/demo') ?
    new Promise(resolve => { finish = resolve; }) : Promise.resolve({ data: params.projectId === 'q' ? [{ id: 'other-chat', updatedAt: 1 }] : [], nextCursor: null }) });
  dom.get('projects').children[0].click(); await delay(0);
  dom.get('projects').children[1].click(); await delay(0);
  finish({ data: [{ id: 'old-project-chat', updatedAt: 9 }], nextCursor: null }); await delay(0);
  assert.equal(dom.get('project-title').textContent, 'Other 的会话');
  assert.deepEqual(dom.get('threads').children.map(row => row.dataset.threadId), ['other-chat']);
});
