import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mountChat } from '../public/chat.js';
import { domFixture } from './dom.mjs';
import { resumeFixture } from './helpers.mjs';

const project = { id: 'p', name: 'Demo', roots: [{ path: '/workspace' }], metadata: {}, position: 0, createdAt: 1, updatedAt: 1 };
async function fixture(t, create = async () => ({ project })) {
  const dom = domFixture(), calls = []; let saved = false, seq = 0;
  const api = async (path, body) => {
    calls.push({ path, body });
    if (path === '/api/project/create') { const response = await create(body); saved = true; return response; }
    if (path === '/api/rpc') return { result: { data: body.method === 'project/list' && saved ? [project] : [], nextCursor: null } };
    if (path === '/api/thread/open' || path === '/api/thread/start') return { snapshot: resumeFixture(path.endsWith('/start') ? 'new' : body.threadId), cursor: { generation: 1, seq: ++seq } };
    assert.fail(path);
  };
  const chat = mountChat({ api, viewId: 'view', uploadLimitBytes: 32 }); chat.connection(true);
  t.after(() => { chat.dispose(); dom.restore(); }); await chat.load();
  assert.ok(dom.get('new-project'), 'Native project creation has its own project entry');
  dom.get('new-project').click(); dom.get('project-name').value = ' Demo '; dom.get('project-root').value = '/workspace';
  return { dom, chat, calls, submit: () => dom.event('project-form', 'submit') };
}

test('creating a project selects its native scope and new conversations inherit its ID', async t => {
  let finish; const f = await fixture(t, () => new Promise(resolve => { finish = resolve; }));
  assert.equal(f.dom.get('project-dialog').open, true); f.submit(); f.submit();
  assert.equal(f.calls.filter(call => call.path === '/api/project/create').length, 1);
  assert.equal(f.dom.get('project-submit').disabled, true);
  const body = f.calls.at(-1).body; assert.equal(body.name, 'Demo'); assert.equal(body.rootPath, '/workspace'); assert.match(body.idempotencyKey, /^[a-f0-9-]{36}$/);
  finish({ project }); await delay(0);
  assert.equal(f.dom.get('project-dialog').open, false); assert.equal(f.dom.get('project-title').textContent, '项目：Demo');
  f.dom.get('new-thread').click(); await delay(0);
  assert.deepEqual(f.calls.findLast(call => call.path === '/api/thread/start').body, { viewId: 'view', projectId: 'p' });
});

test('uncertain creation retries the same native request after closing and reopening the form', async t => {
  let first = true; const f = await fixture(t, async () => { if (first) { first = false; throw Object.assign(new Error('Unknown outcome'), { status: 502, outcome: 'unknown' }); } return { project }; });
  f.submit(); await delay(0); assert.equal(f.dom.get('project-name').disabled, true); assert.equal(f.dom.get('project-root').disabled, true);
  f.dom.get('close-project').click(); f.dom.get('new-project').click(); f.submit(); await delay(0);
  const creates = f.calls.filter(call => call.path === '/api/project/create'); assert.equal(creates.length, 2); assert.deepEqual(creates[1].body, creates[0].body);
  assert.equal(f.dom.get('project-dialog').open, false);
});

test('known validation failure keeps inputs editable and a corrected request gets its own idempotency key', async t => {
  const f = await fixture(t, async () => { throw Object.assign(new Error('Directory unavailable'), { status: 400 }); });
  f.submit(); await delay(0); assert.ok(!f.dom.get('project-root').disabled); assert.match(f.dom.get('project-error').textContent, /Directory unavailable/);
  f.dom.get('project-root').value = '/corrected'; f.submit(); await delay(0);
  const creates = f.calls.filter(call => call.path === '/api/project/create'); assert.notEqual(creates[0].body.idempotencyKey, creates[1].body.idempotencyKey);
});

test('a late creation updates projects without replacing a newer conversation or draft', async t => {
  let finish; const f = await fixture(t, () => new Promise(resolve => { finish = resolve; })); f.submit();
  f.dom.get('close-project').click(); await f.chat.open('other'); f.chat.getState().draft = 'keep this draft'; finish({ project }); await delay(0);
  assert.equal(f.chat.getState().threadId, 'other'); assert.equal(f.chat.getState().draft, 'keep this draft');
  assert.equal(f.dom.get('project-title').textContent, '全部项目'); assert.equal(f.dom.get('projects').children.length, 1);
});
