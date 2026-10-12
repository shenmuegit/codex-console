import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir, open, unlink, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { createFiles } from '../files.mjs';
import { formatNativePath, displayNativeText } from '../public/composer.js';
import { createChatState, beginSend, settleSend } from '../public/chat.js';
import { httpsFixture, resumeFixture, tinyPng } from './helpers.mjs';

const LIMIT = 33_554_432;
async function workspace(t) { const dir = await mkdtemp(join(tmpdir(), 'codex-files-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
async function fixture(t, uploadLimitBytes = LIMIT) { const dir = await workspace(t); return { dir, files: createFiles({ stateDir: dir, uploadLimitBytes, generatedRoots: [] }) }; }
async function* bytes(size) { const chunk = Buffer.alloc(65_536, 97); for (let left = size; left; left -= Math.min(left, chunk.length)) yield chunk.subarray(0, Math.min(left, chunk.length)); }
async function uploaded(files, name, content, mime = 'text/plain') { const begin = await files.beginUpload({ threadId: 't', name, size: content.length, mime }); return files.receiveUpload(begin.id, Readable.from([content])); }
async function openThread(f, cookie, viewId) {
  const pending = f.request('/api/thread/open', { method: 'POST', cookie, body: { viewId, threadId: 't' } });
  for (let i = 0; i < 100 && !f.peer.sent.some(m => m.method === 'thread/resume'); i++) await delay(5);
  f.peer.replyTo('thread/resume', resumeFixture('t')); assert.equal((await pending).status, 200);
}

test('native path formatting follows the composer and descriptors encode text files versus photos', async t => {
  assert.equal(formatNativePath('/a b/file.txt'), '"/a b/file.txt"');
  assert.equal(formatNativePath('/a "b"/file.txt'), '/a "b"/file.txt');
  const { files } = await fixture(t);
  const text = await uploaded(files, '测试 空格\'%.txt', Buffer.from('exact 中文 bytes\n'));
  const photo = await uploaded(files, '照片.png', tinyPng(), 'image/png');
  assert.equal('path' in text, false); assert.equal(text.name, '测试 空格\'%.txt');
  const input = await files.attachmentInputs([text.id, photo.id], 't');
  assert.equal(input[0].type, 'text'); assert.ok(input[0].text.includes('content.txt'));
  assert.equal(input[1].type, 'localImage'); assert.ok(input[1].path.endsWith('content.png'));
  await assert.rejects(files.attachmentInputs([text.id], 'another'), { code: 'UPLOAD_THREAD_MISMATCH' });
  await assert.rejects(files.attachmentInputs(['forged'], 't'), { code: 'UNKNOWN_UPLOAD' });
  const prefix = '看这个 ', path = '/tmp/测试.txt';
  assert.equal(displayNativeText({ text: prefix + path, text_elements: [{ byteRange: { start: Buffer.byteLength(prefix), end: Buffer.byteLength(prefix + path) }, placeholder: '原文件名.txt' }] }), prefix + '原文件名.txt');
});

test('a failed send keeps attachments; acknowledgement removes only files in that submitted message', () => {
  const state = createChatState('t'); state.draft = '分析附件';
  state.attachments = [{ id: 'one', status: 'complete' }];
  const failed = beginSend(state); settleSend(state, failed.id, { ok: false });
  assert.equal(state.attachments.length, 1); assert.equal(state.draft, '分析附件');
  const sent = beginSend(state); state.attachments.push({ id: 'newer', status: 'complete' });
  settleSend(state, sent.id, { ok: true }); assert.deepEqual(state.attachments.map(a => a.id), ['newer']);
});

test('exact 33,554,432-byte cap is accepted, one byte excess and dishonest lengths are rejected with cleanup', async t => {
  const { files, dir } = await fixture(t);
  const exact = await files.beginUpload({ threadId: 't', name: 'exact.bin', size: LIMIT, mime: 'application/octet-stream' });
  const descriptor = await files.receiveUpload(exact.id, Readable.from(bytes(LIMIT))); assert.equal(descriptor.size, LIMIT);
  await assert.rejects(files.beginUpload({ threadId: 't', name: 'too-big.bin', size: LIMIT + 1, mime: '' }), { status: 413 });
  const chunked = await files.beginUpload({ threadId: 't', name: 'chunked.bin', size: LIMIT, mime: '' });
  await assert.rejects(files.receiveUpload(chunked.id, Readable.from(bytes(LIMIT + 1))), { status: 413 });
  const short = await files.beginUpload({ threadId: 't', name: 'short.txt', size: 4, mime: '' });
  const source = Readable.from([Buffer.from('a')]); source.headers = { 'content-length': '1' };
  await assert.rejects(files.receiveUpload(short.id, source), { code: 'UPLOAD_LENGTH_MISMATCH' });
  assert.deepEqual(await readdir(join(dir, 'uploads')), [exact.id]);
});

test('interrupted input and ENOSPC remove partial bytes but preserve already completed uploads', async t => {
  const { files, dir } = await fixture(t);
  const complete = await uploaded(files, 'keep.txt', Buffer.from('keep'));
  const interrupted = await files.beginUpload({ threadId: 't', name: 'interrupt.txt', size: 8, mime: '' });
  await assert.rejects(files.receiveUpload(interrupted.id, Readable.from((async function* () { yield Buffer.from('part'); throw new Error('interrupted'); })())));
  const sample = await open(join(dir, 'sample'), 'w'); const prototype = Object.getPrototypeOf(sample); await sample.close();
  const original = prototype.write;
  t.mock.method(prototype, 'write', async function (...args) { if ((await readFile(`/proc/self/fdinfo/${this.fd}`, 'utf8')).includes('flags:')) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); return original.apply(this, args); });
  const full = await files.beginUpload({ threadId: 't', name: 'full.txt', size: 4, mime: '' });
  await assert.rejects(files.receiveUpload(full.id, Readable.from([Buffer.from('data')])), { code: 'STORAGE_FULL' });
  t.mock.restoreAll();
  assert.deepEqual(await readdir(join(dir, 'uploads')), [complete.id]);
  const ref = await files.openReference(complete.refId); assert.equal((await ref.handle.readFile()).toString(), 'keep'); await ref.handle.close();
});

test('invalid declared photos fail; active formats stay ordinary downloads and completed uploads survive reload', async t => {
  const { files, dir } = await fixture(t);
  await assert.rejects(uploaded(files, 'fake.png', Buffer.from('<svg onload="evil()"/>'), 'image/png'), { code: 'INVALID_IMAGE' });
  const svg = await uploaded(files, '图.svg', Buffer.from('<svg onload="evil()"/>'), 'image/svg+xml');
  assert.equal(svg.imageHref, undefined);
  const reopened = createFiles({ stateDir: dir, uploadLimitBytes: LIMIT, generatedRoots: [] });
  assert.equal((await reopened.attachmentInputs([svg.id], 't'))[0].type, 'text');
  for (const name of ['../escape', 'bad/name', 'bad\nname', '..']) await assert.rejects(files.beginUpload({ threadId: 't', name, size: 0, mime: '' }), { code: 'INVALID_FILENAME' });
});

test('rebound_project_keeps_old_thread_reference with exact Unicode filename and bytes', async t => {
  const { files, dir } = await fixture(t);
  const old = join(dir, 'old'), next = join(dir, 'new'); await mkdir(old); await mkdir(next);
  const name = '报告 空格\'%.txt', content = Buffer.from('OLD\n真实目标'); await writeFile(join(old, name), content); await writeFile(join(next, name), 'WRONG');
  const thread = { id: 't', cwd: old, project: { roots: [{ path: next }] } };
  const refs = await files.issueTranscriptRefs(thread, [{ id: 'v', items: [{ id: 'a', type: 'agentMessage', text: `[下载](<${name}>)` }] }]);
  const ref = refs.get('a')[0]; assert.equal(ref.name, name);
  const download = await files.openReference(ref.id); assert.deepEqual(await download.handle.readFile(), content); await download.handle.close();
  await assert.rejects(files.openReference('../auth.json'), { status: 404 });
  const denied = await files.issueTranscriptRefs(thread, [{ id: 'v', items: [{ id: 'bad', type: 'agentMessage', text: '[secret](../auth.json)' }] }]);
  assert.equal(denied.get('bad')?.length ?? 0, 0);
});

test('file and ancestor symlink replacements after issuance cannot redirect a download', async t => {
  const { files, dir } = await fixture(t), root = join(dir, 'root'), outside = join(dir, 'outside'); await mkdir(root); await mkdir(outside);
  const file = join(root, 'report.txt'), secret = join(outside, 'report.txt'); await writeFile(file, 'allowed'); await writeFile(secret, 'PRIVATE');
  const refs = await files.issueTranscriptRefs({ id: 't', cwd: root }, [{ id: 'v', items: [{ id: 'a', type: 'fileChange', changes: [{ path: file }] }] }]);
  const ref = refs.get('a')[0]; await unlink(file); await symlink(secret, file);
  await assert.rejects(files.openReference(ref.id), { code: 'UNSAFE_REFERENCE' });
  await unlink(file); await rm(root, { recursive: true }); await symlink(outside, root);
  await assert.rejects(files.openReference(ref.id), { code: 'UNSAFE_REFERENCE' });
});

test('HTTPS uploads stream the cap and downloads preserve bytes, UTF-8 names and authentication', async t => {
  const f = await httpsFixture(); t.after(() => f.close()); const cookie = await f.login(), viewId = await f.view(cookie), stream = await f.events(cookie, viewId);
  await openThread(f, cookie, viewId);
  const begin = await f.request('/api/uploads', { method: 'POST', cookie, body: { viewId, threadId: 't', name: '测试 空格\'%.bin', size: LIMIT, mime: '' } });
  assert.equal(begin.status, 201);
  const uploaded = await f.putBytes(`/api/uploads/${begin.json.id}?viewId=${viewId}`, bytes(LIMIT), { cookie }); assert.equal(uploaded.status, 201);
  const denied = await f.request(uploaded.json.href); assert.equal(denied.status, 401);
  const download = await f.request(uploaded.json.href, { cookie }); assert.equal(download.status, 200);
  assert.equal(Buffer.byteLength(download.text), LIMIT); assert.match(download.headers['content-disposition'], /filename\*=UTF-8''%E6/);
  assert.equal(download.headers['content-type'], 'application/octet-stream');
  assert.equal((await f.request('/api/uploads', { method: 'POST', cookie, body: { viewId, threadId: 't', name: 'excess', size: LIMIT + 1, mime: '' } })).status, 413);
  const another = await f.request('/api/uploads', { method: 'POST', cookie, body: { viewId, threadId: 't', name: 'chunked', size: LIMIT, mime: '' } });
  assert.equal((await f.putBytes(`/api/uploads/${another.json.id}?viewId=${viewId}`, bytes(LIMIT + 1), { cookie })).status, 413);
  assert.equal((await f.request('/api/files/..%2Fauth.json', { cookie })).status, 404);
  stream.req.destroy();
});

test('large native snapshots recover through HTTPS without repeatedly closing the SSE page', async t => {
  const f = await httpsFixture(); t.after(() => f.close()); const cookie = await f.login(), viewId = await f.view(cookie), stream = await f.events(cookie, viewId);
  const text = 'x'.repeat(1_048_700);
  const pending = f.request('/api/thread/open', { method: 'POST', cookie, body: { viewId, threadId: 't' } });
  for (let i = 0; i < 100 && !f.peer.sent.some(m => m.method === 'thread/resume'); i++) await delay(5);
  f.peer.replyTo('thread/resume', resumeFixture('t', [{ id: 'v', status: 'completed', items: [{ id: 'a', type: 'agentMessage', text }] }]));
  assert.equal((await pending).status, 200); await delay(130);
  assert.equal(stream.res.destroyed, false); assert.doesNotMatch(stream.text(), /"kind":"(?:snapshot|checkpoint)"/);
  const rendered = await f.request('/api/thread/render', { method: 'POST', cookie, body: { viewId, threadId: 't' } });
  assert.equal(rendered.status, 200); assert.equal(rendered.json.native.items[0].text, text);
  assert.ok(stream.text().length < 5000); stream.req.destroy();
});
