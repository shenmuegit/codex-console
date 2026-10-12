import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mountChat } from '../public/chat.js';
import { resumeFixture } from './helpers.mjs';
import { domFixture } from './dom.mjs';

async function fixture(t, { hold = false, limit = 1024 } = {}) {
  const dom = domFixture(), calls = [], transfers = [], originals = new Map(); let chat, seq = 0;
  const globals = {
    createImageBitmap: async () => ({ close() {} }),
    XMLHttpRequest: class {
      upload = {};
      open(method, url) { this.method = method; this.url = url; }
      setRequestHeader(name, value) { this.header = [name, value]; }
      send(file) { this.file = file; transfers.push(this); if (!hold) queueMicrotask(() => this.finish()); }
      finish() { this.status = 201; this.response = { id: decodeURIComponent(this.url.split('/').at(-1).split('?')[0]) }; this.onload(); }
      abort() { this.onabort?.(); }
    },
  };
  for (const [name, value] of Object.entries(globals)) { originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { configurable: true, writable: true, value }); }
  t.after(() => { chat?.dispose(); dom.restore(); for (const [name, value] of originals) { if (value) Object.defineProperty(globalThis, name, value); else delete globalThis[name]; } });
  const api = async (path, body) => {
    calls.push({ path, body });
    if (path === '/api/thread/open') return { snapshot: resumeFixture(body.threadId), cursor: { generation: 1, seq: ++seq } };
    if (path === '/api/rpc') return { result: { data: [], nextCursor: null } };
    assert.equal(path, '/api/uploads'); return { id: 'upload-' + calls.filter(call => call.path === '/api/uploads').length };
  };
  chat = mountChat({ api, viewId: 'view', uploadLimitBytes: limit }); chat.connection(true); await chat.open('t');
  const state = chat.getState(); state.draft = 'keep this draft'; chat.connection(true);
  return { dom, chat, state, calls, transfers, paste: clipboardData => dom.event('draft', 'paste', { clipboardData }) };
}
async function settled(state) { for (let i = 0; i < 100 && state.attachments.some(record => ['pending', 'uploading'].includes(record.status)); i++) await delay(0); }
const textFile = name => new File(['exact 中文 bytes'], name, { type: 'text/plain' });
const png = () => new File([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWHsAAAAASUVORK5CYII=', 'base64')], 'clipboard.png', { type: 'image/png' });

test('pasted files use the existing owner upload flow with exact bytes and keep the draft', async t => {
  const f = await fixture(t), file = textFile('notes.txt');
  assert.equal(f.paste({ files: [file], items: [] }).defaultPrevented, true); await settled(f.state);
  assert.equal(f.state.attachments[0].status, 'complete'); assert.equal(f.state.draft, 'keep this draft');
  assert.deepEqual(f.calls.find(call => call.path === '/api/uploads').body, { viewId: 'view', threadId: 't', name: 'notes.txt', size: file.size, mime: 'text/plain' });
  assert.equal(f.transfers[0].method, 'PUT'); assert.equal(f.transfers[0].withCredentials, true);
  assert.deepEqual(f.transfers[0].header, ['Content-Type', 'application/octet-stream']);
  assert.equal(await f.transfers[0].file.text(), 'exact 中文 bytes');
});

test('clipboard image items fall back to getAsFile and display the existing image preview', async t => {
  const f = await fixture(t), file = png();
  assert.equal(f.paste({ files: [], items: [{ kind: 'file', getAsFile: () => file }] }).defaultPrevented, true); await settled(f.state);
  assert.equal(f.state.attachments[0].status, 'complete'); assert.match(f.state.attachments[0].previewUrl, /^blob:/);
  assert.equal(f.dom.get('attachments').children[0].children[0].tagName, 'IMG');
  assert.deepEqual(Buffer.from(await f.transfers[0].file.arrayBuffer()), Buffer.from(await file.arrayBuffer()));
});

test('multiple pasted files upload once each even when items exposes the same files', async t => {
  const f = await fixture(t), files = [textFile('one.txt'), png()];
  f.paste({ files, items: files.map(file => ({ kind: 'file', getAsFile: () => file })) }); await settled(f.state);
  assert.deepEqual(f.state.attachments.map(record => record.name), ['one.txt', 'clipboard.png']);
  assert.equal(f.transfers.length, 2); assert.ok(f.state.attachments.every(record => record.status === 'complete'));
});

test('ordinary text and unavailable clipboard files retain normal browser paste behavior', async t => {
  const f = await fixture(t);
  for (const clipboard of [null, { files: [], items: [{ kind: 'string', type: 'text/plain' }] }, { files: [], items: [{ kind: 'file', getAsFile: () => null }] }]) {
    assert.equal(f.paste(clipboard).defaultPrevented, false);
  }
  assert.equal(f.state.attachments.length, 0); assert.equal(f.calls.some(call => call.path === '/api/uploads'), false);
});

test('disabled and disposed composers do not consume paste or create uploads', async t => {
  const f = await fixture(t), clipboard = { files: [textFile('notes.txt')] };
  f.chat.connection(false); assert.equal(f.dom.get('draft').disabled, true);
  assert.equal(f.paste(clipboard).defaultPrevented, false);
  f.chat.connection(true); f.chat.dispose(); assert.equal(f.paste(clipboard).defaultPrevented, false);
  assert.equal(f.calls.some(call => call.path === '/api/uploads'), false);
});

test('a pasted upload remains attached to its original conversation after navigation', async t => {
  const f = await fixture(t, { hold: true }); f.paste({ files: [textFile('notes.txt')] });
  for (let i = 0; i < 100 && !f.transfers.length; i++) await delay(0);
  assert.equal(f.transfers.length, 1); await f.chat.open('other'); f.chat.getState().draft = 'other draft';
  f.transfers[0].finish(); await settled(f.state);
  assert.equal(f.state.attachments[0].status, 'complete'); assert.equal(f.state.draft, 'keep this draft');
  assert.equal(f.chat.getState().attachments.length, 0); assert.equal(f.chat.getState().draft, 'other draft');
  assert.equal(f.calls.find(call => call.path === '/api/uploads').body.threadId, 't');
});

test('pasted files retain existing size validation and fail without sending bytes', async t => {
  const f = await fixture(t, { limit: 1 }); assert.equal(f.paste({ files: [textFile('large.txt')] }).defaultPrevented, true); await settled(f.state);
  assert.equal(f.state.attachments[0].status, 'error'); assert.match(f.state.attachments[0].error, /单文件不能超过/);
  assert.equal(f.transfers.length, 0); assert.equal(f.calls.some(call => call.path === '/api/uploads'), false);
  assert.equal(f.state.draft, 'keep this draft');
});
