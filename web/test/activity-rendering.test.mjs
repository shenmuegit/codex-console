import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mountChat, prependHistory } from '../public/chat.js';
import { renderTranscript } from '../transcript.mjs';
import { resumeFixture } from './helpers.mjs';
import { domFixture } from './dom.mjs';

async function fixture(t, items, status = 'completed') {
  const dom = domFixture(), snapshot = resumeFixture('t', [{ id: 'turn', status, items }]);
  snapshot.transcript = renderTranscript(snapshot.thread, snapshot.initialTurnsPage.data);
  const api = async (path, body) => {
    if (path === '/api/thread/open') return { snapshot, cursor: { generation: 1, seq: 1 } };
    assert.equal(path, '/api/rpc'); return { result: { data: [], nextCursor: null } };
  };
  const chat = mountChat({ api, viewId: 'view', uploadLimitBytes: 32 }); chat.connection(true);
  t.after(() => { chat.dispose(); dom.restore(); }); await chat.open('t');
  return { dom, chat, messages: dom.get('messages'), notify(seq, method, params) { chat.onEvent({ kind: 'notification', cursor: { generation: 1, seq }, native: { method, params: { threadId: 't', turnId: 'turn', ...params } } }); } };
}
const command = (id, status = 'completed') => ({ id, type: 'commandExecution', command: 'pwd', aggregatedOutput: '/project', status });
const reasoning = (id, summary = []) => ({ id, type: 'reasoning', summary, content: [] });

test('consecutive commands and reasoning form one compact expandable activity between assistant messages', async t => {
  const f = await fixture(t, [{ id: 'a', type: 'agentMessage', text: '开始检查。' }, command('c1'), reasoning('empty'), reasoning('r', ['已核对目录。']), command('c2'), { id: 'b', type: 'agentMessage', text: '完成。' }]);
  assert.equal(f.messages.children.length, 3, 'Only one activity row belongs between the two assistant messages');
  const activity = f.messages.children[1]; assert.equal(activity.tagName, 'DETAILS');
  assert.equal(activity.children[0].children[1].textContent, '运行了命令');
  assert.equal(activity.children[1].children.length, 3);
  const detail = activity.children[1].children[0]; assert.ok(detail.children[1].innerHTML.includes('/project'));
  assert.equal(f.chat.getState().turns[0].items.length, 6, 'Hidden reasoning stays in native state');
});

test('subagents render their desktop display names and lifecycle status as separate rows', async t => {
  const kinds = ['started', 'interacted', 'interrupted', 'completed'];
  const f = await fixture(t, kinds.flatMap((kind, index) => [command('cmd' + index), { id: 'agent' + index, type: 'subAgentActivity', kind, agentPath: '/root/nested_projects_review', agentThreadId: 'child-thread' }]));
  assert.equal(f.messages.children.length, 8);
  const labels = kinds.map((_, index) => f.messages.children[index * 2 + 1].children[0].children[1]);
  assert.deepEqual(labels.map(node => node.textContent), ['Nested projects review 开始工作', 'Nested projects review 已更新', 'Nested projects review 已中断', 'Nested projects review 已完成']);
  assert.equal(labels[2].href, '/?thread=child-thread');
  assert.ok(f.messages.children.every(node => node.children[0].textContent !== 'subAgentActivity'));
});

test('empty reasoning occupies no transcript row and becomes visible when its public text arrives', async t => {
  const f = await fixture(t, [reasoning('r')], 'inProgress'); assert.equal(f.messages.children.length, 0);
  f.notify(2, 'item/reasoning/summaryTextDelta', { itemId: 'r', summaryIndex: 0, delta: '检查目录结构。' }); await delay(0);
  assert.equal(f.messages.children.length, 1);
  assert.equal(f.messages.children[0].children[0].children[1].textContent, '检查目录结构。');
});

test('live command activity keeps its expanded details and uses completion and failure state', async t => {
  const f = await fixture(t, [command('c', 'inProgress')], 'inProgress');
  const activity = f.messages.children[0]; activity.open = true;
  assert.equal(activity.children[0].children[1].textContent, '正在运行命令');
  f.notify(2, 'item/commandExecution/outputDelta', { itemId: 'c', delta: '\nnext line' }); await delay(0);
  assert.equal(f.messages.children[0], activity); assert.equal(activity.open, true);
  f.notify(3, 'item/completed', { item: { ...command('c', 'failed'), aggregatedOutput: 'failed <script>bad</script>', exitCode: 1 } }); await delay(0);
  assert.match(activity.children[0].children[1].textContent, /失败/); assert.equal(activity.open, true);
  const body = activity.children[1].children[0].children[1]; assert.equal(body.children[0].textContent, 'pwd\nfailed <script>bad</script>');
});

test('older history joins the existing expanded activity without losing its DOM or item order', async t => {
  const f = await fixture(t, [command('recent')]); const activity = f.messages.children[0]; activity.open = true;
  const state = f.chat.getState(); state.historyKind = 'items';
  prependHistory(state, { data: [{ id: 'turn', status: 'completed', items: [command('older')] }], nextCursor: null }); f.chat.connection(true);
  assert.equal(f.messages.children[0], activity); assert.equal(activity.open, true);
  assert.deepEqual(activity.children[1].children.map(node => node.dataset.itemId), ['older', 'recent']);
});

test('mixed file and tool activity preserves safe details and attachment downloads', async t => {
  const f = await fixture(t, [command('c'), { id: 'f', type: 'fileChange', status: 'completed', changes: [{ path: '/project/a.txt', diff: '+new <script>bad</script>' }] }, { id: 'm', type: 'mcpToolCall', status: 'completed', server: 'fixture', tool: 'lookup', arguments: {}, result: {} }]);
  const activity = f.messages.children[0]; assert.equal(f.messages.children.length, 1);
  assert.match(activity.children[0].children[1].textContent, /运行了命令.*编辑了文件.*调用了工具/);
  const item = f.chat.getState().turns[0].items[1]; item._presentation.files = [{ name: 'a.txt', href: '/api/files/allowed', imageHref: '/api/images/allowed' }]; f.chat.connection(true);
  const file = activity.children[1].children[1]; assert.ok(file.children[1].innerHTML.includes('&lt;script&gt;')); assert.equal(file.children[1].innerHTML.includes('<script>'), false);
  assert.equal(file.children[2].children[0].src, '/api/images/allowed'); assert.equal(file.children[2].children[1].href, '/api/files/allowed');
});
