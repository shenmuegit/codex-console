import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mountChat } from '../public/chat.js';
import { domFixture } from './dom.mjs';
import { resumeFixture } from './helpers.mjs';

async function fixture(t, mutation, listProjects) {
  const dom = domFixture(), calls = [];
  dom.get('thread-menu').append(...['new', 'copy', 'rename', 'archive', 'delete'].map(action => dom.get('thread-menu-' + action)));
  const nav = dom.get('projects'), replace = nav.replaceChildren.bind(nav);
  nav.replaceChildren = (...items) => { if (nav.contains(dom.document.activeElement)) dom.document.activeElement = dom.document.body; replace(...items); };
  const projects = ['p', 'q'].map(id => ({ id, name: id === 'p' ? 'Demo' : 'Other', roots: [{ path: '/' + id }], metadata: {} }));
  const api = async (path, body) => {
    if (path === '/api/thread/open') return { snapshot: resumeFixture(body.threadId), cursor: { generation: 1, seq: 1 } };
    if (path === '/api/rpc') return { result: body.method === 'project/list' && listProjects ? await listProjects(body.params) : { data: body.method === 'project/list' ? projects : [], nextCursor: null } };
    calls.push({ path, body }); await mutation;
    const project = projects.find(p => p.id === body.projectId);
    if (path === '/api/project/archive') project.metadata = body.archived ? { 'codex-console.archived': 'true' } : {};
    else if (path === '/api/project/delete') projects.splice(projects.indexOf(project), 1);
    else assert.fail(path);
    return {};
  };
  const chat = mountChat({ api, viewId: 'view', uploadLimitBytes: 32 }); chat.connection(true);
  t.after(() => { chat.dispose(); dom.restore(); }); await chat.load(); chat.getState().draft = 'keep my draft';
  const row = id => dom.get('projects').children.map(node => node.children[0]).find(node => node.dataset.projectId === id);
  const menu = (id, type = 'contextmenu', fields = {}) => { const target = row(id); assert.ok(target, 'Native project row has its project ID'); const event = Object.assign(new Event(type, { cancelable: true }), fields); target.dispatchEvent(event); return event; };
  return { dom, chat, calls, row, menu };
}

test('project right-click and keyboard menus target the clicked project without switching conversations', async t => {
  const f = await fixture(t); assert.equal(f.menu('q', 'contextmenu', { clientX: 1250, clientY: 800 }).defaultPrevented, true);
  assert.equal(f.dom.get('thread-menu').getAttribute('aria-label'), '项目选项');
  assert.equal(f.dom.get('thread-menu-copy').hidden, true); assert.equal(f.dom.get('thread-menu-rename').hidden, true);
  assert.equal(f.dom.get('thread-menu-archive').textContent, '归档项目'); assert.equal(f.dom.get('thread-menu-delete').textContent, '删除项目');
  assert.equal(f.dom.document.activeElement, f.dom.get('thread-menu-new'));
  assert.ok(parseFloat(f.dom.get('thread-menu').style.left) <= 1048);
  f.dom.event('thread-menu', 'keydown', { key: 'ArrowDown' }); assert.equal(f.dom.document.activeElement, f.dom.get('thread-menu-archive'));
  f.dom.event('thread-menu', 'keydown', { key: 'ArrowDown' }); assert.equal(f.dom.document.activeElement, f.dom.get('thread-menu-delete'));
  f.dom.event('thread-menu', 'keydown', { key: 'Escape' }); assert.equal(f.dom.document.activeElement, f.row('q'));
  for (const key of ['ContextMenu', 'F10']) {
    assert.equal(f.menu('q', 'keydown', { key, shiftKey: key === 'F10' }).defaultPrevented, true);
    assert.equal(f.dom.get('thread-menu').hidden, false); f.dom.event('thread-menu', 'keydown', { key: 'Escape' });
  }
  assert.equal(f.chat.getState().threadId, 't'); assert.equal(f.chat.getState().draft, 'keep my draft'); assert.deepEqual(f.calls, []);
});

test('project archive and restore keep chat history and drafts and expose a recoverable project list', async t => {
  const f = await fixture(t); f.row('p').click(); await delay(0); f.menu('p'); f.dom.get('thread-menu-archive').click(); await delay(0);
  assert.deepEqual(f.calls[0], { path: '/api/project/archive', body: { viewId: 'view', projectId: 'p', archived: true } });
  assert.equal(f.row('p'), undefined); assert.equal(f.dom.get('project-title').textContent, '全部会话');
  assert.equal(f.dom.document.activeElement, f.dom.get('new-project'));
  f.dom.get('show-archived-projects').click(); await delay(0); assert.ok(f.row('p'));
  f.menu('p'); assert.equal(f.dom.get('thread-menu-archive').textContent, '恢复项目'); f.dom.get('thread-menu-archive').click(); await delay(0);
  assert.equal(f.calls[1].body.archived, false); assert.equal(f.row('p'), undefined);
  f.dom.get('show-archived-projects').click(); await delay(0); assert.ok(f.row('p'));
  assert.equal(f.chat.getState().draft, 'keep my draft'); assert.equal(f.chat.getState().threadId, 't');
});

test('project deletion confirms once, blocks duplicates and preserves a newer project selection', async t => {
  let finish; const f = await fixture(t, new Promise(resolve => { finish = resolve; }));
  window.confirm = () => false; f.menu('p'); f.dom.get('thread-menu-delete').click(); await delay(0); assert.deepEqual(f.calls, []);
  window.confirm = label => { assert.match(label, /目录和会话.*保留/); return true; };
  f.menu('p'); f.dom.get('thread-menu-delete').click(); f.menu('p'); assert.equal(f.dom.get('thread-menu-delete').disabled, true);
  f.dom.get('thread-menu-delete').click(); assert.equal(f.calls.length, 1);
  f.row('q').click(); await delay(0); finish(); await delay(0);
  assert.deepEqual(f.calls[0], { path: '/api/project/delete', body: { viewId: 'view', projectId: 'p', confirmed: true } });
  assert.equal(f.row('p'), undefined); assert.equal(f.dom.get('project-title').textContent, '全部会话'); assert.equal(f.row('q').getAttribute('aria-current'), 'true');
  assert.equal(f.chat.getState().draft, 'keep my draft'); assert.equal(f.chat.getState().threadId, 't');
});

test('project mutation errors and disconnects retain the project and selected conversation', async t => {
  let fail; const f = await fixture(t, new Promise((_resolve, reject) => { fail = reject; }));
  f.row('p').click(); await delay(0); f.menu('p'); f.dom.get('thread-menu-archive').click(); fail(Error('Project update rejected')); await delay(0);
  assert.ok(f.row('p')); assert.equal(f.dom.get('project-title').textContent, '全部会话'); assert.equal(f.row('p').getAttribute('aria-current'), 'true'); assert.match(f.dom.get('chat-error').textContent, /Project update rejected/);
  f.menu('p'); f.chat.connection(false); assert.equal(f.dom.get('thread-menu-archive').disabled, true); assert.equal(f.dom.get('thread-menu-delete').disabled, true);
  f.dom.get('thread-menu-delete').click(); assert.equal(f.calls.length, 1); assert.equal(f.chat.getState().draft, 'keep my draft');
});

test('project deletion from another native client clears stale scope while keeping the current chat draft', async t => {
  const f = await fixture(t); f.row('p').click(); await delay(0);
  f.chat.onEvent({ kind: 'notification', cursor: { generation: 1, seq: 2 }, native: { method: 'project/changed', params: { projectId: 'p', changeType: 'deleted' } } });
  await delay(0); assert.equal(f.dom.get('project-title').textContent, '全部会话');
  assert.equal(f.chat.getState().threadId, 't'); assert.equal(f.chat.getState().draft, 'keep my draft');
});

test('project refresh preserves row or menu keyboard focus without stealing newer composer focus', async t => {
  const f = await fixture(t);
  const refresh = () => f.chat.onEvent({ kind: 'notification', cursor: { generation: 1, seq: 2 }, native: { method: 'project/changed', params: { projectId: 'q', changeType: 'updated' } } });
  f.row('q').focus(); refresh(); await delay(0); assert.equal(f.dom.document.activeElement, f.row('q'));
  f.menu('q'); refresh(); await delay(0); assert.equal(f.dom.get('thread-menu').hidden, true); assert.equal(f.dom.document.activeElement, f.row('q'));
  f.row('q').focus(); refresh(); f.dom.get('draft').focus(); await delay(0); assert.equal(f.dom.document.activeElement, f.dom.get('draft'));
});

test('archive filtering skips empty native pages and preserves the next native cursor', async t => {
  const reads = [];
  const f = await fixture(t, undefined, async params => {
    reads.push(params);
    return params.cursor === 'last-page' ? { data: [{ id: 'q', name: 'Archived', metadata: { 'codex-console.archived': 'true' } }], nextCursor: null } :
      { data: [{ id: 'p', name: 'Demo', metadata: {} }], nextCursor: 'last-page' };
  });
  assert.ok(f.row('p')); assert.equal(f.dom.get('more-projects').hidden, false);
  f.dom.get('show-archived-projects').click(); await delay(0);
  assert.ok(f.row('q')); assert.equal(f.row('p'), undefined); assert.equal(f.dom.get('more-projects').hidden, true);
  assert.equal(reads.at(-1).cursor, 'last-page');
});

test('native conversation refresh leaves an open project menu available', async t => {
  const f = await fixture(t); f.menu('q');
  f.chat.onEvent({ kind: 'notification', cursor: { generation: 1, seq: 2 }, native: { method: 'thread/name/updated', params: { threadId: 't', threadName: 'Updated' } } });
  await delay(350); assert.equal(f.dom.get('thread-menu').hidden, false);
  assert.equal(f.dom.get('thread-menu').getAttribute('aria-label'), '项目选项');
  f.dom.get('thread-menu-archive').click(); await delay(0); assert.equal(f.calls[0].body.projectId, 'q');
});
