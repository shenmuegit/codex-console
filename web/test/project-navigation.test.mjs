import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mountChat } from '../public/chat.js';
import { domFixture } from './dom.mjs';
import { resumeFixture } from './helpers.mjs';

async function fixture(t, { failProjectRefresh = false } = {}) {
  const dom = domFixture(), reads = [];
  let projectReads = 0;
  const api = async (path, body) => {
    if (path === '/api/thread/open') return { snapshot: resumeFixture(body.threadId), cursor: { generation: 1, seq: 1 } };
    assert.equal(path, '/api/rpc'); reads.push(body);
    if (body.method === 'project/list' && ++projectReads > 1 && failProjectRefresh) throw new Error('Project list unavailable');
    const data = body.method === 'project/list' ? [{ id: 'p', name: 'Demo', roots: [{ path: '/demo' }] }, { id: 'q', name: 'Other', roots: [{ path: '/other' }] }] :
      body.method === 'thread/list' && !body.params.archived ? [{ id: body.params.projectId ? 'project-chat' : 'global-chat', name: 'Chat', updatedAt: 1 }] : [];
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
  assert.equal(reads.findLast(call => call.method === 'thread/list').params.projectId, 'p');
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
  assert.equal(reads.findLast(call => call.method === 'thread/list').params.projectId, 'p');
  assert.equal(dom.get('project-title').textContent, 'Demo 的会话');
  assert.equal(dom.get('project-title').title, 'Demo 的会话');
  assert.equal(dom.get('all-threads').hidden, false);
  assert.match(dom.get('chat-error').textContent, /Project list unavailable/);
  dom.get('all-threads').click(); await delay(0);
  assert.equal(dom.get('threads').children[0].dataset.threadId, 'global-chat');
  assert.equal(dom.get('project-title').textContent, '全部会话');
  assert.equal(dom.get('all-threads').hidden, true);
});
