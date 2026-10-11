import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32, posix } from 'node:path';
import { Readable } from 'node:stream';
import { createFiles } from '../files.mjs';
import { tinyPng } from './helpers.mjs';

function host(windows = false) {
  const paths = windows ? win32 : posix, cwd = windows ? 'C:\\projects\\demo' : '/remote/demo';
  const home = windows ? 'C:\\Users\\owner\\.codex' : '/remote/.codex';
  const nodes = new Map(), calls = [];
  const addDirectory = path => { for (;;) { if (!nodes.has(path)) nodes.set(path, { isDirectory: true }); const parent = paths.dirname(path); if (parent === path) break; path = parent; } };
  addDirectory(cwd); addDirectory(home);
  const metadata = node => ({ isFile: false, isDirectory: false, isSymlink: false, createdAtMs: 1, modifiedAtMs: 1, ...node });
  const codex = { info: () => ({ platformFamily: windows ? 'windows' : 'unix', codexHome: home }), async rpc(method, params) {
    calls.push({ method, params }); let result = {};
    if (method === 'fs/createDirectory') { if (params.recursive === false && nodes.has(params.path)) throw new Error('Already exists'); addDirectory(params.path); }
    else if (method === 'fs/writeFile') nodes.set(params.path, { isFile: true, dataBase64: params.dataBase64 });
    else if (method === 'fs/unwatch') {}
    else { const node = nodes.get(params.path); if (!node) throw new Error('Not found');
      if (method === 'fs/watch') result = { path: params.path };
      else if (method === 'fs/getMetadata') result = metadata(node);
      else if (method === 'fs/readDirectory') result = { entries: [...nodes.keys()].filter(path => paths.dirname(path) === params.path).map(path => ({ fileName: paths.basename(path), isDirectory: Boolean(nodes.get(path).isDirectory), isFile: Boolean(nodes.get(path).isFile) })) };
      else if (method === 'fs/readFile') result = { dataBase64: node.dataBase64 };
      else throw new Error(method);
    } return { result };
  } };
  return { codex, calls, cwd, home, paths, nodes, addDirectory };
}
async function filesAt(t, h, id) {
  const stateDir = await mkdtemp(join(tmpdir(), 'remote-files-')); t.after(() => rm(stateDir, { recursive: true, force: true }));
  return createFiles({ stateDir, remoteHost: { id }, codex: h.codex });
}
async function upload(files, content, name = 'photo.png', mime = 'image/png') {
  const meta = await files.beginUpload({ threadId: 'collision', name, size: content.length, mime });
  return files.receiveUpload(meta.id, Readable.from([content]));
}
for (const windows of [false, true]) test(`remote ${windows ? 'Windows' : 'Unix'} attachments use host private paths and transcript downloads stay scoped`, async t => {
  const h = host(windows), files = await filesAt(t, h, 'host-a');
  const image = await upload(files, tinyPng()), text = await upload(files, Buffer.from('hello'), 'report.txt', 'text/plain');
  const input = await files.attachmentInputs([image.id, text.id], 'collision');
  assert.ok(input[0].path.startsWith(h.home + h.paths.sep)); assert.equal(h.nodes.get(input[0].path).dataBase64, tinyPng().toString('base64'));
  assert.ok(input[1].text.includes(h.home)); assert.match(image.href, /host=host-a/);
  const again = await files.attachmentInputs([image.id], 'collision'); assert.equal(again[0].path, input[0].path);
  assert.equal(h.calls.filter(call => call.method === 'fs/writeFile').length, 2);
  const generated = h.paths.join(h.cwd, 'result.txt'); h.nodes.set(generated, { isFile: true, dataBase64: Buffer.from('REMOTE bytes').toString('base64') });
  const refs = await files.issueTranscriptRefs({ cwd: h.cwd }, [{ items: [{ id: 'result', type: 'fileChange', changes: [{ path: generated }] }] }]);
  assert.equal(refs.get('result').length, 1); const ref = refs.get('result')[0]; assert.match(ref.href, /host=host-a/);
  const opened = await files.openReference(ref.id); assert.equal((await opened.handle.readFile()).toString(), 'REMOTE bytes'); await opened.handle.close();
  h.nodes.get(generated).isSymlink = true;
  await assert.rejects(files.openReference(ref.id), { code: 'UNSAFE_REFERENCE' });
  const denied = await files.issueTranscriptRefs({ cwd: h.cwd }, [{ items: [{ id: 'outside', type: 'fileChange', changes: [{ path: h.paths.join(h.home, 'secret.txt') }] }] }]);
  assert.deepEqual(denied.get('outside'), []);
  const other = await filesAt(t, host(windows), 'host-b'); await assert.rejects(other.openReference(ref.id), { code: 'UNKNOWN_REFERENCE' });
  await assert.rejects(other.attachmentInputs([image.id], 'collision'), { code: 'UNKNOWN_UPLOAD' });
});

import { createRemoteHostPool } from '../remote-hosts.mjs';
import { createWebServer } from '../server.mjs';
import { createAuth, hashPassword } from '../auth.mjs';
import { httpsFixture, resumeFixture } from './helpers.mjs';
for (const windows of [false, true]) test(`remote ${windows ? 'Windows' : 'Unix'} projects, thread cwd, selections and completion use native paths`, async t => {
  const h = host(windows), file = h.paths.join(h.cwd, 'result.txt'); h.nodes.set(file, { isFile: true });
  const rpc = h.codex.rpc; let seq = 1; const listeners = new Set();
  Object.assign(h.codex, { status: () => ({ online: true, generation: 1 }), onEvent: fn => { listeners.add(fn); return () => listeners.delete(fn); }, close() {},
    releaseThread: async () => {}, retainThread: async () => { const result = { ...resumeFixture('collision'), thread: { ...resumeFixture('collision').thread, cwd: h.cwd } }, cursor = { generation: 1, seq: ++seq }; for (const fn of listeners) fn({ kind: 'snapshot', threadId: 'collision', cursor, native: result }); return { result, cursor }; },
    async rpc(method, params) {
      if (method.startsWith('fs/')) return rpc(method, params);
      h.calls.push({ method, params }); let result = {};
      if (method === 'project/create' || method === 'project/read') result = { project: { id: 'p', roots: [{ path: h.cwd }] } };
      else if (method === 'thread/read') result = { thread: { ...resumeFixture('collision').thread, cwd: h.cwd, name: 'Host A transcript' } };
      else if (method === 'thread/items/list') result = { data: [], nextCursor: null };
      else if (method === 'thread/start') result = { thread: { id: 'collision' } };
      else if (method === 'turn/start') result = { turn: { id: 'turn', status: 'inProgress', items: [] } };
      else if (method === 'fuzzyFileSearch') result = { files: [{ file_name: 'result.txt', path: 'result.txt', match_type: 'file' }] };
      else if (method === 'thread/list' || method === 'app/list') result = { data: [] };
      else if (method === 'app/installed') result = { apps: [] };
      else if (method === 'plugin/installed') result = { marketplaces: [] };
      return { result, cursor: { generation: 1, seq: ++seq } };
    } });
  let pool; const sharedAuth = createAuth({ passwordHash: await hashPassword('fixture-passphrase') });
  const controller = { status: async () => ({ enrolled: true }), listHosts: async () => [{ id: 'host-a' }, { id: 'host-b' }] };
  const f = await httpsFixture({ sharedAuth, routeHost: id => pool.server(id) }); t.after(() => f.close());
  pool = createRemoteHostPool({ config: f.config, sharedAuth, controller, createClient: host => host.id === 'host-a' ? h.codex : { ...h.codex, onEvent: () => () => {}, async rpc(method) { return { result: method === 'thread/read' ? { thread: { ...resumeFixture('collision').thread, name: 'Host B transcript' } } : { data: [], nextCursor: null } }; } }, createServer: createWebServer }); t.after(() => pool.close());
  const cookie = await f.login(), request = (path, body) => f.request(path + '?host=host-a', { method: 'POST', cookie, body });
  const viewId = (await request('/api/view', {})).json.viewId;
  assert.equal((await request('/api/project/create', { viewId, name: 'Demo', rootPath: h.cwd, idempotencyKey: 'new-project' })).status, 200);
  assert.equal((await request('/api/thread/start', { viewId, projectId: 'p' })).status, 200);
  assert.equal(h.calls.find(call => call.method === 'thread/start').params.cwd, h.cwd);
  assert.equal((await f.request('/api/status?host=host-a', { cookie })).json.uploadLimitBytes, 24_000_000);
  const upload = await request('/api/uploads', { viewId, threadId: 'collision', name: 'document.txt', size: 5, mime: 'text/plain' });
  const stored = await f.putBytes(`/api/uploads/${upload.json.id}?viewId=${viewId}&host=host-a`, [Buffer.from('bytes')], { cookie });
  assert.equal(stored.status, 201); assert.match(stored.json.href, /host=host-a/);
  const downloaded = await f.request(stored.json.href, { cookie }); assert.equal(downloaded.text, 'bytes');
  assert.equal((await f.request(stored.json.href.replace('host-a', 'host-b'), { cookie })).status, 404);
  const exportA = await f.request('/api/thread/export?threadId=collision&host=host-a', { cookie });
  const exportB = await f.request('/api/thread/export?threadId=collision&host=host-b', { cookie });
  assert.match(exportA.text, /Host A transcript/); assert.doesNotMatch(exportA.text, /Host B transcript/);
  assert.match(exportB.text, /Host B transcript/); assert.doesNotMatch(exportB.text, /Host A transcript/);

  const completed = await request('/api/completions', { viewId, threadId: 'collision', sigil: '@', query: 'result' });
  assert.equal(completed.json.items[0].path, file);
  const nested = h.paths.join(h.cwd, 'nested'); h.addDirectory(nested); h.nodes.set(h.paths.join(nested, 'child.txt'), { isFile: true });
  const listed = await request('/api/completions', { viewId, threadId: 'collision', sigil: '@', query: 'nested' + h.paths.sep });
  assert.equal(listed.json.items[0].path, h.paths.join(nested, 'child.txt'));
  assert.equal(h.calls.findLast(call => call.method === 'fs/readDirectory').params.path, nested);
  assert.equal((await request('/api/rpc', { method: 'fs/getMetadata', params: { path: h.cwd + h.paths.sep + '..' + h.paths.sep + 'outside' } })).status, 400);
  const sent = await request('/api/thread/send', { viewId, threadId: 'collision', mode: 'start', clientUserMessageId: 'send-one', draft: { text: '@result', selections: [{ kind: 'file', path: file, start: 0, end: 7, token: '@result' }] } });
  assert.equal(sent.status, 200, JSON.stringify(sent.json));
  h.nodes.get(file).isSymlink = true;
  const denied = await request('/api/thread/send', { viewId, threadId: 'collision', mode: 'start', clientUserMessageId: 'send-two', draft: { text: '@result', selections: [{ kind: 'file', path: file, start: 0, end: 7, token: '@result' }] } });
  assert.notEqual(denied.status, 200);
});

test('remote uploads respect the relay base64 envelope and fail closed without platform info', async t => {
  const h = host(), files = await filesAt(t, h, 'host-a');
  await assert.rejects(files.beginUpload({ threadId: 'collision', name: 'large.bin', size: 24_000_001, mime: '' }), { code: 'FILE_TOO_LARGE' });
  const meta = await upload(files, Buffer.from('text'), 'report.txt', 'text/plain');
  h.codex.info = () => undefined;
  await assert.rejects(files.attachmentInputs([meta.id], 'collision'), { code: 'UNSAFE_REFERENCE' });
  assert.equal(h.calls.some(call => call.method === 'fs/writeFile'), false);
});

test('a native watch echo never authorizes a symlinked ancestor or a server-local path', async t => {
  const h = host(), files = await filesAt(t, h, 'host-a'), directory = h.paths.join(h.cwd, 'linked'), file = h.paths.join(directory, 'secret.txt');
  h.nodes.set(directory, { isDirectory: true, isSymlink: true }); h.nodes.set(file, { isFile: true, dataBase64: Buffer.from('SECRET').toString('base64') });
  const refs = await files.issueTranscriptRefs({ cwd: h.cwd }, [{ items: [{ id: 'unsafe', type: 'fileChange', changes: [{ path: file }, { path: '/tmp/server-auth.json' }] }] }]);
  assert.deepEqual(refs.get('unsafe'), []); assert.equal(h.calls.some(call => call.method === 'fs/readFile'), false);
});

test('remote transfer rejects a symlinked upload parent before creating anything below it', async t => {
  const h = host(), files = await filesAt(t, h, 'host-a'), meta = await upload(files, Buffer.from('safe'), 'note.txt', 'text/plain');
  h.nodes.set(h.paths.join(h.home, 'console-uploads'), { isDirectory: true, isSymlink: true });
  await assert.rejects(files.attachmentInputs([meta.id], 'collision'), { code: 'UNSAFE_REFERENCE' });
  assert.equal(h.calls.some(call => call.method === 'fs/createDirectory' || call.method === 'fs/writeFile'), false);
});
