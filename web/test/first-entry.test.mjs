import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mountChat } from '../public/chat.js';
import { resumeFixture } from './helpers.mjs';
import { domFixture } from './dom.mjs';

function fixture(t, url = 'https://fixture.test/', before = async () => {}) {
  const dom = domFixture(), calls = []; let seq = 0, boundThread;
  dom.location.href = url;
  const api = async (path, body) => {
    calls.push({ path, body }); await before(path, body);
    if (path === '/api/rpc') return { result: { data: body.method === 'model/list' ? [
      { model: 'fixture-model', displayName: 'Fixture', defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] },
      { model: 'other-model', displayName: 'Other', defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] },
    ] : [], nextCursor: null } };
    if (path === '/api/thread/start' || path === '/api/thread/open') {
      boundThread = path.endsWith('/start') ? 'new' : body.threadId;
      return { snapshot: resumeFixture(boundThread), cursor: { generation: 1, seq: ++seq } };
    }
    if (path === '/api/thread/settings') return { settings: { model: 'other-model', effort: 'high', approvalPolicy: 'never', sandbox: { type: 'dangerFullAccess' } } };
    assert.fail('Unexpected API: ' + path);
  };
  const chat = mountChat({ api, viewId: 'view', uploadLimitBytes: 32 }); chat.connection(true);
  t.after(() => { chat.dispose(); dom.restore(); });
  return { dom, chat, calls, get boundThread() { return boundThread; } };
}

test('first entry enables file photo model and effort controls on a native blank conversation', async t => {
  const f = fixture(t); await f.chat.load();
  for (const id of ['choose-files', 'choose-photos', 'model', 'effort', 'draft']) assert.ok(!f.dom.get(id).disabled, id + ' is usable on first entry');
  assert.equal(f.chat.getState()?.ready, true); assert.equal(f.chat.getState().threadId, 'new');
  assert.equal(f.calls.filter(call => call.path === '/api/thread/start').length, 1);
  let files = 0, photos = 0;
  f.dom.get('file-input').addEventListener('click', () => files++); f.dom.get('photo-input').addEventListener('click', () => photos++);
  f.dom.get('choose-files').click(); f.dom.get('choose-photos').click(); assert.equal(files, 1); assert.equal(photos, 1);
  f.dom.get('model').value = 'other-model'; f.dom.event('model', 'change'); await delay(0);
  f.dom.get('effort').value = 'high'; f.dom.event('effort', 'change'); await delay(0);
  assert.deepEqual(f.calls.at(-1), { path: '/api/thread/settings', body: { viewId: 'view', threadId: 'new', model: 'other-model', effort: 'high' } });
  assert.equal(f.chat.getState().settings.effort, 'high'); assert.equal(f.dom.get('send').disabled, true);
  assert.equal(new URL(f.dom.location.href).searchParams.get('thread'), 'new');
});

test('an existing thread link opens that thread without creating another conversation', async t => {
  const f = fixture(t, 'https://fixture.test/?thread=existing'); await f.chat.load();
  assert.equal(f.chat.getState().threadId, 'existing'); assert.equal(f.calls.some(call => call.path === '/api/thread/start'), false);
});

test('navigating while the initial catalog loads takes priority over automatic creation', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const f = fixture(t, undefined, async (path, body) => { if (body?.method === 'model/list') await gate; });
  const loading = f.chat.load(); await f.chat.open('chosen'); f.chat.getState().draft = 'keep this draft'; release(); await loading;
  assert.equal(f.chat.getState().threadId, 'chosen'); assert.equal(f.chat.getState().draft, 'keep this draft');
  assert.equal(f.calls.some(call => call.path === '/api/thread/start'), false);
});

test('a pending initial conversation cannot replace a newer selection', async t => {
  let release, started = false; const gate = new Promise(resolve => { release = resolve; });
  const f = fixture(t, undefined, async path => { if (path === '/api/thread/start') { started = true; await gate; } });
  const loading = f.chat.load();
  for (let i = 0; i < 20 && !started; i++) await delay(0);
  assert.equal(started, true, 'First entry prepares a native conversation');
  await f.chat.open('chosen'); f.chat.getState().draft = 'newer draft'; release(); await loading;
  assert.equal(f.chat.getState().threadId, 'chosen'); assert.equal(f.chat.getState().draft, 'newer draft');
  assert.equal(new URL(f.dom.location.href).searchParams.get('thread'), 'chosen');
  assert.equal(f.boundThread, 'chosen', 'The gateway view must also follow the newer selection');
});

test('initial creation failure stays visible and the existing new-conversation button can retry', async t => {
  let fail = true;
  const f = fixture(t, undefined, async path => { if (path === '/api/thread/start' && fail) throw new Error('Native creation failed'); });
  await f.chat.load(); assert.match(f.dom.get('chat-error').textContent, /Native creation failed/);
  assert.equal(f.dom.get('new-thread').disabled, false); fail = false; f.dom.get('new-thread').click(); await delay(0);
  assert.equal(f.chat.getState()?.ready, true); assert.ok(!f.dom.get('choose-files').disabled);
});
