import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mountChat } from '../public/chat.js';
import { resumeFixture } from './helpers.mjs';
import { domFixture } from './dom.mjs';

async function fixture(t, width = 390) {
  const dom = domFixture(); dom.resize(width);
  dom.get('sidebar').append(...['back-projects', 'new-thread', 'new-project', 'show-archived-projects', 'projects', 'more-projects', 'show-archived-threads', 'threads', 'more-threads', 'show-usage'].map(id => dom.get(id)));
  let seq = 0;
  const api = async (path, body) => {
    if (path === '/api/thread/open') return { snapshot: resumeFixture(body.threadId), cursor: { generation: 1, seq: ++seq } };
    assert.equal(path, '/api/rpc');
    return { result: { data: body.method === 'thread/list' ? [{ id: 't', name: 'Current', updatedAt: 1 }] : [], nextCursor: null } };
  };
  const chat = mountChat({ api, viewId: 'view', uploadLimitBytes: 32 }); chat.connection(true);
  t.after(() => { chat.dispose(); dom.restore(); }); await chat.open('t');
  assert.ok(dom.get('sidebar-backdrop'), 'The drawer needs an outside dismissal target');
  return { dom, chat };
}

test('mobile drawer contains keyboard focus and keeps the covered chat inactive', async t => {
  const { dom } = await fixture(t);
  dom.get('back-threads').click();
  assert.equal(dom.get('sidebar-backdrop').hidden, false); assert.equal(dom.get('chat-pane').inert, true);
  assert.equal(dom.get('sidebar').inert, false); assert.equal(dom.get('sidebar').getAttribute('aria-modal'), 'true');
  assert.equal(dom.get('back-threads').getAttribute('aria-expanded'), 'true');
  dom.get('show-usage').focus(); assert.equal(dom.event('sidebar', 'keydown', { key: 'Tab' }).defaultPrevented, true);
  assert.equal(dom.document.activeElement, dom.get('back-projects'));
  dom.event('sidebar', 'keydown', { key: 'Tab', shiftKey: true }); assert.equal(dom.document.activeElement, dom.get('show-usage'));
});

test('outside click and Escape close the drawer and return focus to its opener', async t => {
  const { dom } = await fixture(t);
  for (const action of ['outside', 'escape']) {
    dom.get('back-threads').click();
    if (action === 'outside') dom.get('sidebar-backdrop').click(); else dom.event('sidebar', 'keydown', { key: 'Escape' });
    assert.equal(dom.get('sidebar-backdrop').hidden, true); assert.equal(dom.get('chat-pane').inert, false);
    assert.equal(dom.get('sidebar').inert, true); assert.equal(dom.get('back-threads').getAttribute('aria-expanded'), 'false');
    assert.equal(dom.document.activeElement, dom.get('back-threads'));
  }
});

test('selecting a conversation closes the mobile drawer while preserving its draft', async t => {
  const { dom, chat } = await fixture(t); chat.getState().draft = 'keep my draft';
  dom.get('back-threads').click(); dom.get('threads').children[0].children[0].click(); await delay(0);
  assert.equal(dom.get('sidebar-backdrop').hidden, true); assert.equal(dom.get('chat-pane').inert, false);
  assert.equal(chat.getState().draft, 'keep my draft'); assert.equal(dom.document.activeElement, dom.get('thread-title'));
});

test('resizing between drawer and desktop sidebar restores normal chat interaction', async t => {
  const { dom } = await fixture(t); dom.get('back-threads').click(); dom.resize(1280);
  assert.equal(dom.get('chat-pane').inert, false); assert.equal(dom.get('sidebar-backdrop').hidden, true);
  assert.equal(dom.get('sidebar').getAttribute('aria-modal'), null);
  assert.equal(dom.event('sidebar', 'keydown', { key: 'Tab' }).defaultPrevented, false);
  dom.resize(390); assert.equal(dom.get('sidebar-backdrop').hidden, false);
  dom.get('sidebar-backdrop').click(); dom.resize(1280); dom.get('back-threads').click();
  assert.equal(dom.get('chat-pane').inert, false); assert.equal(dom.get('sidebar-backdrop').hidden, true);
  dom.get('threads').children[0].children[0].click(); await delay(0);
  dom.get('new-thread').focus(); dom.resize(390);
  assert.equal(dom.document.activeElement, dom.get('back-threads'));
  assert.equal(dom.get('chat-pane').inert, false);
});
