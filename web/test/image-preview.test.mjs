import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mountChat, itemText, createChatState, installSnapshot, applyNativeEvent } from '../public/chat.js';
import { renderTranscript } from '../transcript.mjs';
import { domFixture } from './dom.mjs';
import { resumeFixture } from './helpers.mjs';

const user = { id: 'user', type: 'userMessage', content: [{ type: 'text', text: '看这张图', text_elements: [] }, { type: 'localImage', path: '/private/photo.png' }] };
const files = [{ name: '图片.png', href: '/api/files/photo', imageHref: '/api/images/photo' }, { name: 'notes.txt', href: '/api/files/notes' }];
async function fixture(t) {
  const dom = domFixture(), snapshot = resumeFixture('t', [{ id: 'turn', status: 'completed', items: [user] }]);
  snapshot.transcript = renderTranscript(snapshot.thread, snapshot.initialTurnsPage.data, new Map([[user.id, files]]));
  const api = async (path, body) => path === '/api/thread/open' ? { snapshot, cursor: { generation: 1, seq: 1 } } : { result: { data: [], nextCursor: null } };
  const chat = mountChat({ api, viewId: 'view', uploadLimitBytes: 32 }); t.after(() => { chat.dispose(); dom.restore(); });
  chat.connection(true); await chat.open('t');
  return { dom, chat, picture: dom.get('messages').children[0].children[2].children[0] };
}
function pictureEvent(dom, picture, type, key) {
  const event = new Event(type, { cancelable: true }); Object.defineProperty(event, 'target', { value: picture });
  if (key) Object.assign(event, { key }); dom.document.body.dispatchEvent(event); return event;
}

test('photo messages show pictures without generated image labels or download text, while raw context stays intact', async t => {
  const f = await fixture(t), message = f.dom.get('messages').children[0];
  assert.equal(message.children[1].innerHTML, '<pre>看这张图</pre>');
  assert.equal(message.children[2].children.length, 2); assert.equal(f.picture.tagName, 'IMG');
  assert.equal(f.picture.src, '/api/images/photo'); assert.equal(f.picture.getAttribute('role'), 'button');
  assert.equal(message.children[2].children[1].textContent, '下载 notes.txt'); assert.match(itemText(user), /［图片］/);
});

test('click and keyboard activation enlarge photos; close returns focus without altering drafts', async t => {
  const f = await fixture(t); f.chat.getState().draft = '保留草稿';
  assert.equal(pictureEvent(f.dom, f.picture, 'click').defaultPrevented, true);
  assert.equal(f.dom.get('image-viewer').open, true); assert.equal(f.dom.get('image-viewer-image').src, 'https://fixture.test/api/images/photo');
  f.dom.get('close-image-viewer').click(); assert.equal(f.dom.get('image-viewer').open, false);
  assert.equal(f.dom.document.activeElement, f.picture); assert.equal(f.chat.getState().draft, '保留草稿');
  for (const key of ['Enter', ' ']) {
    assert.equal(pictureEvent(f.dom, f.picture, 'keydown', key).defaultPrevented, true);
    assert.equal(f.dom.get('image-viewer').open, true); f.dom.get('image-viewer').close();
  }
  f.picture.src = 'https://external.invalid/image.png'; pictureEvent(f.dom, f.picture, 'click');
  assert.equal(f.dom.get('image-viewer').open, false, 'Preview must not fetch arbitrary external images');
  await delay(0);
});

test('delayed photo presentations remain eligible after later native events advance the cursor', () => {
  const state = createChatState('t'); installSnapshot(state, { snapshot: resumeFixture('t', [{ id: 'turn', status: 'completed', items: [user] }]), cursor: { generation: 1, seq: 1 } });
  applyNativeEvent(state, { kind: 'notification', cursor: { generation: 1, seq: 3 }, native: { method: 'thread/name/updated', params: { threadId: 't', threadName: 'Later' } } });
  const rendered = renderTranscript(state.thread, state.turns, new Map([[user.id, files]])).items[0]; rendered.cursor = { generation: 1, seq: 2 };
  applyNativeEvent(state, { kind: 'render', cursor: rendered.cursor, native: { threadId: 't', items: [rendered] } });
  assert.equal(state.turns[0].items[0]._presentation.text, '看这张图');
});

test('Markdown pictures support the same accessible preview and keep literal image words in user text', () => {
  const items = renderTranscript({ id: 't' }, [{ id: 'turn', items: [{ id: 'a', type: 'agentMessage', text: '![图片](photo.png)' },
    { id: 'u', type: 'userMessage', content: [{ type: 'text', text: '［图片］是我输入的文字', text_elements: [] }] }] }], new Map([['a', [{ ...files[0], target: 'photo.png' }]]])).items;
  assert.match(items[0].html, /role="button"/); assert.match(items[0].html, /tabindex="0"/);
  assert.match(items[1].html, /［图片］是我输入的文字/);
});
