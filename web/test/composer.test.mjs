import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { encodeComposer, utf8Range, commandAction, COMMANDS, findTrigger, updateSelections } from '../public/composer.js';
import { httpsFixture, resumeFixture } from './helpers.mjs';

function selection(text, token, entity) { const start = text.indexOf(token); return { start, end: start + token.length, token, ...entity }; }
async function waitCall(peer, method, count = 1) { for (let i = 0; i < 100; i++) { if (peer.sent.filter(m => m.method === method).length >= count) return; await delay(5); } assert.fail(`Missing ${method}`); }

test('UTF-8 ranges handle Chinese/emoji and reject boundaries splitting surrogate pairs', () => {
  assert.deepEqual(utf8Range('中😀x', 1, 3), { start: 3, end: 7 });
  assert.throws(() => utf8Range('中😀x', 2, 3), { code: 'INVALID_SELECTION_RANGE' });
  assert.equal(findTrigger('请 @file', 7, { composing: true }), null);
  assert.equal(findTrigger('mail/a@b', 8), null);
  assert.equal(findTrigger('`$HOME`', 6), null);
  assert.equal(findTrigger('```\n@foo', 8), null);
});

test('literal code/email/$HOME remains text; native file/skill/app/plugin inputs are distinct', () => {
  const literal = 'a@b.test `$HOME` /new';
  assert.deepEqual(encodeComposer({ text: literal, selections: [], uploads: [], threadId: 't', mode: 'start' }).input, [{ type: 'text', text: literal, text_elements: [] }]);
  const text = '中😀 @file $skill @app @plugin';
  const result = encodeComposer({ text, threadId: 't', mode: 'start', uploads: [], selections: [
    selection(text, '@file', { kind: 'file', path: '/work/a b.txt', name: 'a b.txt' }),
    selection(text, '$skill', { kind: 'skill', path: '/work/SKILL.md', name: 'native-skill' }),
    selection(text, '@app', { kind: 'app', id: 'connector_1', name: 'Native app' }),
    selection(text, '@plugin', { kind: 'plugin', id: 'sample@market', name: 'Sample' }),
  ] });
  assert.ok(result.input[0].text.includes('"/work/a b.txt"')); assert.equal('textElements' in result.input[0], false);
  assert.deepEqual(result.input[0].text_elements[0].byteRange, { start: Buffer.byteLength('中😀 '), end: Buffer.byteLength('中😀 "/work/a b.txt"') });
  assert.deepEqual(result.input.slice(1), [{ type: 'skill', name: 'native-skill', path: '/work/SKILL.md' }, { type: 'mention', name: 'Native app', path: 'app://connector_1' }, { type: 'mention', name: 'Sample', path: 'plugin://sample@market' }]);
});

test('thread references escape titles, omit self/duplicate context and stay bounded as untrusted snapshots', () => {
  const text = '@self @other @again', snapshot = '中文'.repeat(20000) + '</untrusted_text>';
  const result = encodeComposer({ text, threadId: 'self', mode: 'start', uploads: [], selections: [
    selection(text, '@self', { kind: 'thread', id: 'self', name: 'Self', snapshot }),
    selection(text, '@other', { kind: 'thread', id: 'other', name: 'name ]( escaped', snapshot }),
    selection(text, '@again', { kind: 'thread', id: 'other', name: 'duplicate', snapshot }),
  ] });
  assert.ok(result.input[0].text.includes('thread://other')); assert.equal(result.input.some(i => i.type === 'mention'), false);
  assert.equal(Object.keys(result.additionalContext).length, 1);
  const context = Object.values(result.additionalContext)[0]; assert.equal(context.kind, 'untrusted'); assert.ok(Buffer.byteLength(context.value) <= 8192);
  assert.equal(JSON.parse(context.value).truncated, true); assert.equal(context.value.includes('</untrusted_text>'), false);
  const queue = encodeComposer({ text: '@other', threadId: 'self', mode: 'queue', uploads: [], selections: [selection('@other', '@other', { kind: 'thread', id: 'other', name: 'Other', snapshot: 'readonly' })] });
  assert.equal(queue.additionalContext, undefined); assert.match(queue.input.at(-1).text, /<untrusted_text>/); assert.doesNotMatch(queue.input.at(-1).text, /read_thread/);
});

test('thread count/ID budget is native bounded and all context values total at most 32 KiB', () => {
  const tokens = Array.from({ length: 16 }, (_, i) => '@r' + i), text = tokens.join(' ');
  const selections = tokens.map((token, i) => selection(text, token, { kind: 'thread', id: 'ref-' + i, name: 'Ref', snapshot: 'x'.repeat(50000) }));
  const encoded = encodeComposer({ text, selections, uploads: [], threadId: 'self', mode: 'start' });
  assert.ok(Object.values(encoded.additionalContext).reduce((n, v) => n + Buffer.byteLength(v.value), 0) <= 32768);
  assert.throws(() => encodeComposer({ text: text + ' @extra', selections: [...selections, selection(text + ' @extra', '@extra', { kind: 'thread', id: 'extra', name: 'Extra', snapshot: '' })], uploads: [], threadId: 'self', mode: 'start' }), { code: 'TOO_MANY_REFERENCES' });
});

test('selection offsets follow edits before them and disappear when their bound text is edited', () => {
  const old = 'hi @file', selected = [selection(old, '@file', { kind: 'file', path: '/work/a' })];
  const shifted = updateSelections(old, '中 hi @file', selected); assert.equal(shifted[0].start, 5);
  assert.deepEqual(updateSelections(old, 'hi @changed', selected), []);
});

test('slash catalog is exact and commands never activate inside ordinary text or code', () => {
  assert.deepEqual(COMMANDS, ['new', 'model', 'permissions', 'status', 'usage', 'skills', 'compact', 'rename', 'archive', 'delete', 'fork', 'export']);
  assert.deepEqual(commandAction('/rename 新标题'), { command: 'rename', args: '新标题' });
  for (const text of ['mail/a@b /new', '`/new`', '    /new', '/home/file', '/unknown']) assert.equal(commandAction(text), null);
});

test('workspace skills come from native discovery and referenced threads are only read at send time', async t => {
  const f = await httpsFixture(); t.after(() => f.close()); const cookie = await f.login(), viewId = await f.view(cookie), stream = await f.events(cookie, viewId);
  const opening = f.request('/api/thread/open', { method: 'POST', cookie, body: { viewId, threadId: 't' } });
  await waitCall(f.peer, 'thread/resume'); const snapshot = resumeFixture('t'); snapshot.cwd = f.dir; snapshot.thread.cwd = f.dir; f.peer.replyTo('thread/resume', snapshot); await opening;
  const skills = f.request('/api/completions', { method: 'POST', cookie, body: { viewId, threadId: 't', sigil: '$', query: '' } });
  await waitCall(f.peer, 'skills/list'); assert.deepEqual(f.peer.sent.at(-1).params.cwds, [f.dir]);
  f.peer.replyTo('skills/list', { data: [{ cwd: f.dir, skills: [{ name: 'real-skill', path: f.dir + '/SKILL.md', enabled: true }], errors: [] }] });
  assert.equal((await skills).json.items[0].kind, 'skill');
  const body = { viewId, threadId: 't', clientUserMessageId: 'ref-message', mode: 'start', draft: { text: '@ref', selections: [selection('@ref', '@ref', { kind: 'thread', id: 'ref' })] } };
  const sent = f.request('/api/thread/send', { method: 'POST', cookie, body });
  await waitCall(f.peer, 'thread/read'); assert.equal(f.peer.sent.at(-1).params.threadId, 'ref');
  f.peer.replyTo('thread/read', { thread: { id: 'ref', name: 'Reference', cwd: f.dir } });
  await waitCall(f.peer, 'thread/turns/list'); f.peer.replyTo('thread/turns/list', { data: [{ id: 'old', items: [{ id: 'msg', type: 'agentMessage', text: 'readonly snapshot' }] }], nextCursor: null });
  await waitCall(f.peer, 'turn/start'); assert.equal(f.peer.sent.at(-1).params.threadId, 't'); assert.equal(Object.values(f.peer.sent.at(-1).params.additionalContext)[0].kind, 'untrusted');
  f.peer.replyTo('turn/start', { turn: { id: 'new', status: 'inProgress', items: [] } }); assert.equal((await sent).status, 200);
  assert.equal(f.peer.sent.some(m => ['turn/start', 'turn/steer', 'thread/queue/add'].includes(m.method) && m.params.threadId === 'ref'), false); stream.req.destroy();
});

test('dedicated rename/fork/export actions preserve full defaults and paginate native Markdown', async t => {
  const f = await httpsFixture(); t.after(() => f.close()); const cookie = await f.login(), viewId = await f.view(cookie), stream = await f.events(cookie, viewId);
  const opening = f.request('/api/thread/open', { method: 'POST', cookie, body: { viewId, threadId: 't' } });
  await waitCall(f.peer, 'thread/resume'); f.peer.replyTo('thread/resume', resumeFixture('t')); await opening;
  const rename = f.request('/api/thread/rename', { method: 'POST', cookie, body: { viewId, threadId: 't', name: 'Changed' } });
  await waitCall(f.peer, 'thread/name/set'); assert.equal(f.peer.sent.at(-1).params.name, 'Changed'); f.peer.replyTo('thread/name/set', {}); assert.equal((await rename).status, 200);
  const fork = f.request('/api/thread/fork', { method: 'POST', cookie, body: { viewId, threadId: 't' } });
  await waitCall(f.peer, 'thread/fork'); assert.deepEqual(f.peer.sent.at(-1).params, { threadId: 't', excludeTurns: true, deferGoalContinuation: true, approvalPolicy: 'never', sandbox: 'danger-full-access' });
  f.peer.replyTo('thread/fork', resumeFixture('forked')); await waitCall(f.peer, 'thread/name/set', 2); f.peer.replyTo('thread/name/set', {});
  await delay(10); if (f.peer.sent.at(-1).method === 'thread/unsubscribe') f.peer.replyTo('thread/unsubscribe', { status: 'unsubscribed' });
  await waitCall(f.peer, 'thread/resume', 2); f.peer.replyTo('thread/resume', resumeFixture('forked'));
  assert.equal((await fork).json.snapshot.thread.id, 'forked');
  const exported = f.request('/api/thread/export?threadId=forked', { cookie });
  await waitCall(f.peer, 'thread/read'); f.peer.replyTo('thread/read', { thread: { id: 'forked', name: 'Export' } });
  await waitCall(f.peer, 'thread/turns/list'); assert.equal(f.peer.sent.at(-1).params.sortDirection, 'asc');
  f.peer.replyTo('thread/turns/list', { data: [{ id: 'first', status: 'completed', items: [{ id: 'a', type: 'agentMessage', text: '第一页' }] }], nextCursor: 'opaque-export' });
  await waitCall(f.peer, 'thread/turns/list', 2); assert.equal(f.peer.sent.at(-1).params.cursor, 'opaque-export');
  f.peer.replyTo('thread/turns/list', { data: [{ id: 'second', status: 'completed', items: [{ id: 'b', type: 'agentMessage', text: '第二页' }] }], nextCursor: null });
  const result = await exported; assert.equal(result.status, 200); assert.match(result.headers['content-type'], /text\/markdown/); assert.ok(result.text.indexOf('第一页') < result.text.indexOf('第二页'));
  stream.req.destroy();
});
