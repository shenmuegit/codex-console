// Opt-in live HTTPS/protocol acceptance. No browser UI or original desktop is controlled.
import https from 'node:https';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { createCodexClient } from '../codex.mjs';
import { createChatState, applyNativeEvent, installSnapshot } from '../public/chat.js';

const { values } = parseArgs({ options: { config: { type: 'string' }, 'password-file': { type: 'string' },
  'exercise-chat': { type: 'boolean', default: false }, 'exercise-projects': { type: 'boolean', default: false } } });
assert.ok(values.config && values['password-file'], 'Supply --config and --password-file.');
assert.equal((await stat(values['password-file'])).mode & 0o077, 0, 'Keep the owner password file private.');
const config = JSON.parse(await readFile(values.config, 'utf8')), ca = await readFile(config.tlsCert);
const password = (await readFile(values['password-file'], 'utf8')).trim();
let cookie, viewId, threadId, projectThreadId, state, actor, stream;
const events = [];
async function request(path, body, origin = config.origin) {
  return new Promise((resolve, reject) => {
    const req = https.request(config.origin + path, { ca, method: body === undefined ? 'GET' : 'POST',
      headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => { try { const text = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode, headers: res.headers,
        data: res.headers['content-type']?.startsWith('application/json') ? JSON.parse(text) : text }); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
async function api(path, body) { const r = await request(path, body); assert.equal(r.status, 200, `${path}: ${r.data.error?.message}`); return r.data; }
async function waitFor(predicate, description, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  while (!predicate() && Date.now() < deadline) await delay(50);
  assert.ok(predicate(), description);
}
async function connectEvents() {
  return new Promise((resolve, reject) => {
    let buffer = '', receivedResync = false;
    const req = https.get(config.origin + '/api/events?viewId=' + viewId, { ca, headers: { Cookie: cookie, Origin: config.origin } }, res => {
      assert.equal(res.statusCode, 200);
      res.setEncoding('utf8'); res.on('data', chunk => {
        buffer += chunk; let boundary;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          const data = block.split('\n').find(line => line.startsWith('data: '));
          if (!data) continue;
          const event = JSON.parse(data.slice(6)); events.push(event);
          if (state) applyNativeEvent(state, event);
          if (event.kind === 'resync' && !receivedResync) { receivedResync = true; resolve(req); }
        }
      });
      res.on('error', () => {});
    });
    req.on('error', reject);
  });
}
const completion = id => events.find(e => e.native?.method === 'turn/completed' && e.native.params.turn.id === id)?.native.params.turn;
try {
  let reachable = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { assert.equal((await request('/api/status')).status, 401); reachable = true; break; }
    catch (e) { if (e.code !== 'ECONNREFUSED') throw e; await delay(100); }
  }
  assert.ok(reachable, 'HTTPS service became ready.');
  for (const path of ['/', '/app.js', '/chat.js', '/styles.css']) {
    const resource = await request(path); assert.equal(resource.status, 200, `UI resource ${path}`);
    assert.match(resource.headers['content-security-policy'], /frame-ancestors 'none'/);
  }
  assert.equal((await request('/api/login', { password: 'irrelevant' }, 'https://foreign.invalid')).status, 403);
  const login = await request('/api/login', { password }); assert.equal(login.status, 200);
  cookie = login.headers['set-cookie'][0].split(';')[0];
  const status = await api('/api/status'); assert.equal(status.online, true);
  const models = (await api('/api/rpc', { method: 'model/list', params: {} })).result;
  ({ viewId } = await api('/api/view', {})); stream = await connectEvents();
  const report = { https: true, unauthenticated: 401, foreignOrigin: 403, nativeModels: models.data.length, sseRequiresSnapshot: true };
  if (values['exercise-projects']) {
    const root = join(config.workspace ?? config.generatedRoots[0], 'project-probe-' + randomUUID());
    for (const path of [root, join(root, 'old'), join(root, 'new')]) await api('/api/directory/create', { viewId, path });
    const old = join(root, 'old'), next = join(root, 'new'), marker = join(old, 'keep.txt');
    await writeFile(marker, 'PROJECT_FILES_PRESERVED\n', { mode: 0o600 });
    const body = { viewId, name: 'Disposable project probe', rootPath: old, idempotencyKey: randomUUID() };
    const { project } = await api('/api/project/save', body);
    assert.equal((await api('/api/project/save', body)).project.id, project.id);
    const created = await api('/api/thread/start', { viewId, projectId: project.id, cwd: old, name: 'Disposable project member' });
    projectThreadId = created.snapshot.thread.id;
    assert.equal(created.snapshot.thread.projectId, project.id);
    await api('/api/project/save', { viewId, projectId: project.id, name: 'Rebound disposable project', rootPath: next });
    const reopened = await api('/api/thread/open', { viewId, threadId: projectThreadId });
    assert.equal(reopened.snapshot.thread.cwd, old); assert.equal(reopened.snapshot.cwd, old);
    await api('/api/project/archive', { viewId, projectId: project.id, archived: true });
    assert.ok((await api('/api/preferences')).archivedProjectIds.includes(project.id));
    assert.equal((await api('/api/rpc', { method: 'project/read', params: { projectId: project.id } })).result.project.roots[0].path, next);
    await api('/api/project/archive', { viewId, projectId: project.id, archived: false });
    assert.equal((await api('/api/preferences')).archivedProjectIds.includes(project.id), false);
    await api('/api/thread/delete', { viewId, threadId: projectThreadId, confirmed: true }); projectThreadId = null;
    assert.equal(await readFile(marker, 'utf8'), 'PROJECT_FILES_PRESERVED\n');
    await api('/api/project/archive', { viewId, projectId: project.id, archived: true });
    report.projectLifecycle = true; report.projectCreateIdempotent = true; report.oldThreadCwdPreserved = true; report.projectFilesPreserved = true;
  }
  if (values['exercise-chat']) {
    const created = await api('/api/thread/start', { viewId, cwd: config.workspace ?? config.generatedRoots[0], name: 'Disposable HTTPS integration probe' });
    threadId = created.snapshot.thread.id; state = createChatState(threadId); installSnapshot(state, created);
    actor = createCodexClient({ url: config.backendUrl });
    await waitFor(() => actor.status().online, 'Second native protocol client initialized.', 10_000);
    await actor.retainThread(threadId, 'web-probe-observer');
    const id = randomUUID();
    const body = { viewId, threadId, draft: { text: 'Reply exactly WEB_NATIVE_OK.' }, mode: 'start', clientUserMessageId: id };
    const sent = await api('/api/thread/send', body), firstTurn = sent.result.turn.id;
    await waitFor(() => completion(firstTurn), 'HTTPS-submitted native turn completed.');
    assert.equal(completion(firstTurn).status, 'completed');
    assert.ok(state.turns.flatMap(t => t.items).some(i => i.type === 'agentMessage' && i.text.includes('WEB_NATIVE_OK')));
    await api('/api/thread/send', body); // Same UUID returns its receipt, never another mutation.
    const actorSent = await actor.rpc('turn/start', { threadId, clientUserMessageId: randomUUID(), approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' }, input: [{ type: 'text', text: 'Reply exactly SECOND_NATIVE_CLIENT_OK.', text_elements: [] }] });
    await waitFor(() => completion(actorSent.result.turn.id), 'Second-client turn reached the HTTPS event stream.');
    assert.ok(state.turns.flatMap(t => t.items).some(i => i.type === 'agentMessage' && i.text.includes('SECOND_NATIVE_CLIENT_OK')));
    const long = await api('/api/thread/send', { ...body, clientUserMessageId: randomUUID(),
      draft: { text: 'Use your command tool to run sleep 15. After it finishes reply SLEEP_COMPLETE. This is a disposable interruption test.' } });
    const longTurn = long.result.turn.id;
    await waitFor(() => events.some(e => e.native?.method === 'turn/started' && e.native.params.turn.id === longTurn), 'Disposable turn started.');
    stream.destroy(); await delay(100); stream = await connectEvents();
    installSnapshot(state, await api('/api/thread/open', { viewId, threadId }));
    await waitFor(() => events.some(e => e.native?.params?.turnId === longTurn && e.native.params.item?.type === 'commandExecution'), 'Native command tool actually started.');
    await api('/api/thread/stop', { viewId, threadId, turnId: longTurn });
    await waitFor(() => completion(longTurn), 'Interrupted native turn completed.');
    assert.equal(completion(longTurn).status, 'interrupted');
    const history = (await api('/api/rpc', { method: 'thread/turns/list', params: { threadId, limit: 20, sortDirection: 'desc', itemsView: 'full' } })).result;
    assert.equal(history.data.flatMap(t => t.items).filter(i => i.type === 'userMessage' && i.clientId === id).length, 1);
    report.webSend = true; report.secondNativeClient = true; report.closeReopenDuringWork = true;
    report.interrupt = true; report.stableMessageIdOnce = true; report.realThreadId = threadId;
    await actor.rpc('thread/delete', { threadId }); threadId = null; report.disposableThreadDeleted = true;
  }
  await api('/api/logout', {}); report.logout = true;
  console.log(JSON.stringify(report));
} finally {
  stream?.destroy();
  if (projectThreadId && cookie) await api('/api/thread/delete', { viewId, threadId: projectThreadId, confirmed: true }).catch(() => {});
  if (threadId && actor?.status().online) {
    const active = state?.turns.findLast(t => t.status === 'inProgress');
    if (active) await actor.rpc('turn/interrupt', { threadId, turnId: active.id }).catch(() => {});
    else await actor.rpc('thread/delete', { threadId }).catch(() => {});
  }
  actor?.close();
}
