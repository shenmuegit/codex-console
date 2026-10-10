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
import { tinyPng } from './helpers.mjs';
import { weeklyUsage, contextUsage } from '../public/usage.js';
import { execFileSync } from 'node:child_process';

const { values } = parseArgs({ options: { config: { type: 'string' }, 'password-file': { type: 'string' },
  'exercise-chat': { type: 'boolean', default: false }, 'exercise-projects': { type: 'boolean', default: false },
  'exercise-attachments': { type: 'boolean', default: false }, 'exercise-usage': { type: 'boolean', default: false },
  'exercise-thread-menu': { type: 'boolean', default: false }, 'exercise-references': { type: 'boolean', default: false }, 'exercise-restarts': { type: 'boolean', default: false } } });
assert.ok(values.config && values['password-file'], 'Supply --config and --password-file.');
assert.equal((await stat(values['password-file'])).mode & 0o077, 0, 'Keep the owner password file private.');
const config = JSON.parse(await readFile(values.config, 'utf8')), ca = await readFile(config.tlsCert);
const password = (await readFile(values['password-file'], 'utf8')).trim();
let cookie, viewId, threadId, projectThreadId, referenceThreadId, forkThreadId, state, actor, stream;
const events = [], menuThreads = new Set();
async function request(path, body, origin = config.origin) {
  return new Promise((resolve, reject) => {
    const req = https.request(config.origin + path, { ca, method: body === undefined ? 'GET' : 'POST',
      headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => { try { const bytes = Buffer.concat(chunks), text = bytes.toString(); resolve({ status: res.statusCode, headers: res.headers, bytes,
        data: res.headers['content-type']?.startsWith('application/json') ? JSON.parse(text) : text }); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
async function api(path, body, status = 200) { const r = await request(path, body); assert.equal(r.status, status, `${path}: ${r.data.error?.message}`); return r.data; }
async function upload(name, content, mime) {
  const begin = await api('/api/uploads', { viewId, threadId, name, size: content.length, mime }, 201);
  return new Promise((resolve, reject) => {
    const req = https.request(config.origin + `/api/uploads/${begin.id}?viewId=${viewId}`, { ca, method: 'PUT',
      headers: { Cookie: cookie, Origin: config.origin, 'Content-Type': 'application/octet-stream', 'Content-Length': content.length } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => { try { assert.equal(res.statusCode, 201); resolve(JSON.parse(Buffer.concat(chunks))); } catch (e) { reject(e); } });
    }); req.on('error', reject); req.end(content);
  });
}
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
  for (const path of ['/', '/app.js', '/chat.js', '/composer.js', '/usage.js', '/styles.css']) {
    const resource = await request(path); assert.equal(resource.status, 200, `UI resource ${path}`);
    assert.match(resource.headers['content-security-policy'], /frame-ancestors 'none'/);
  }
  assert.equal((await request('/api/login', { password: 'irrelevant' }, 'https://foreign.invalid')).status, 403);
  const login = await request('/api/login', { password }); assert.equal(login.status, 200);
  cookie = login.headers['set-cookie'][0].split(';')[0];
  let status = await api('/api/status');
  for (let attempt = 0; !status.online && attempt < 100; attempt++) { await delay(100); status = await api('/api/status'); }
  assert.equal(status.online, true);
  const models = (await api('/api/rpc', { method: 'model/list', params: {} })).result;
  ({ viewId } = await api('/api/view', {})); stream = await connectEvents();
  const report = { https: true, unauthenticated: 401, foreignOrigin: 403, nativeModels: models.data.length, sseRequiresSnapshot: true };
  if (values['exercise-projects']) {
    const projects = (await api('/api/rpc', { method: 'project/list', params: { limit: 100 } })).result;
    for (const [path, body] of [
      ['/api/project/save', { name: 'Forbidden browser mutation', rootPath: config.workspace, idempotencyKey: randomUUID() }],
      ['/api/project/archive', { projectId: projects.data[0]?.id ?? 'not-created', archived: true }],
      ['/api/directory/create', { path: join(config.workspace, 'must-not-be-created') }],
    ]) assert.equal((await request(path, { viewId, ...body })).status, 403);
    assert.equal((await request('/api/thread/start', { viewId, cwd: config.workspace })).status, 400);
    const project = projects.data.find(item => item.roots?.[0]?.path);
    if (project) {
      const created = await api('/api/thread/start', { viewId, projectId: project.id, name: 'Disposable read-only project probe' });
      projectThreadId = created.snapshot.thread.id;
      assert.equal(created.snapshot.thread.projectId, project.id); assert.equal(created.snapshot.thread.cwd, project.roots[0].path);
      await api('/api/thread/delete', { viewId, threadId: projectThreadId, confirmed: true }); projectThreadId = null;
      report.nativeProjectRootUsed = true;
    }
    report.projectEditsDenied = true; report.browserCwdOverridesDenied = true;
  }
  if (values['exercise-thread-menu']) {
    const target = (await api('/api/thread/start', { viewId, name: 'Disposable row-menu target' })).snapshot.thread.id; menuThreads.add(target);
    const current = (await api('/api/thread/start', { viewId, name: 'Disposable row-menu current' })).snapshot.thread.id; menuThreads.add(current);
    await api('/api/thread/archive', { viewId, threadId: target, confirmed: true });
    assert.equal((await api('/api/thread/render', { viewId, threadId: current })).native.threadId, current);
    const archived = (await api('/api/rpc', { method: 'thread/list', params: { limit: 100, archived: true, modelProviders: [] } })).result;
    assert.ok(archived.data.some(item => item.id === target));
    await api('/api/thread/unarchive', { viewId, threadId: target });
    await api('/api/thread/delete', { viewId, threadId: target, confirmed: true }); menuThreads.delete(target);
    assert.equal((await api('/api/thread/render', { viewId, threadId: current })).native.threadId, current);
    await api('/api/thread/delete', { viewId, threadId: current, confirmed: true }); menuThreads.delete(current);
    report.threadMenuTargetScope = true; report.nativeArchiveRestoreDelete = true;
  }
  if (values['exercise-chat']) {
    const created = await api('/api/thread/start', { viewId, name: 'Disposable HTTPS integration probe' });
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
    const history = (await api('/api/rpc', { method: 'thread/turns/list', params: { threadId, limit: 20, sortDirection: 'desc', itemsView: 'summary' } })).result;
    assert.equal(history.data.flatMap(t => t.items).filter(i => i.type === 'userMessage' && i.clientId === id).length, 1);
    report.webSend = true; report.secondNativeClient = true; report.closeReopenDuringWork = true;
    report.interrupt = true; report.stableMessageIdOnce = true; report.realThreadId = threadId;
    await actor.rpc('thread/delete', { threadId }); threadId = null; report.disposableThreadDeleted = true;
  }
  if (values['exercise-attachments']) {
    const created = await api('/api/thread/start', { viewId, name: 'Disposable native attachment probe' });
    threadId = created.snapshot.thread.id; state = createChatState(threadId); installSnapshot(state, created);
    const content = Buffer.from(`NATIVE_ATTACHMENT:${randomUUID()}\n真实文件字节\n`), photo = tinyPng();
    const document = await upload('附件 测试\'%.txt', content, 'text/plain'), image = await upload('照片 测试.png', photo, 'image/png');
    assert.deepEqual((await request(document.href)).bytes, content);
    const preview = await request(image.imageHref); assert.equal(preview.headers['content-type'], 'image/png'); assert.deepEqual(preview.bytes, photo);
    const target = join(config.workspace ?? config.generatedRoots[0], `生成 文件-${randomUUID()}.txt`);
    const sent = await api('/api/thread/send', { viewId, threadId, mode: 'start', clientUserMessageId: randomUUID(),
      draft: { text: `Read the attached UTF-8 text file. Use a filesystem or command tool to copy its exact bytes to ${JSON.stringify(target)}. The photo is also an input validation check. Do not modify other files. Reply with a Markdown download link to that exact output file.`, uploadIds: [document.id, image.id] } });
    await waitFor(() => completion(sent.result.turn.id), 'Native attachment turn completed.'); assert.equal(completion(sent.result.turn.id).status, 'completed');
    const history = (await api('/api/rpc', { method: 'thread/turns/list', params: { threadId, limit: 20, sortDirection: 'desc', itemsView: 'summary' } })).result;
    const user = history.data.flatMap(t => t.items).find(i => i.type === 'userMessage');
    assert.ok(user.content.some(p => p.type === 'localImage' && p.path.endsWith('content.png')));
    assert.ok(user.content.some(p => p.type === 'text' && p.text.includes('content.txt')));
    const presentation = await api('/api/thread/render', { viewId, threadId });
    const file = presentation.native.items.flatMap(i => i.files ?? []).find(f => f.name === target.split('/').at(-1));
    assert.ok(file, 'A generated target link was issued from the native transcript.');
    assert.deepEqual((await request(file.href)).bytes, content);
    await api('/api/thread/delete', { viewId, threadId, confirmed: true }); threadId = null;
    assert.deepEqual((await request(document.href)).bytes, content);
    report.nativeTextAndPhotoInputs = true; report.generatedDownloadExactBytes = true; report.uploadSurvivesThreadDelete = true;
  }
  if (values['exercise-usage']) {
    const quota = await api('/api/rpc', { method: 'account/rateLimits/read', params: {} });
    report.nativeWeeklyBuckets = weeklyUsage(quota.result).length;
    const model = models.data.find(m => m.isDefault && m.supportedReasoningEfforts.length >= 2) ?? models.data.find(m => m.supportedReasoningEfforts.length >= 2);
    assert.ok(model, 'A native model has two supported efforts.');
    const created = await api('/api/thread/start', { viewId, name: 'Disposable native settings probe' });
    threadId = created.snapshot.thread.id; state = createChatState(threadId); installSnapshot(state, created);
    for (const option of model.supportedReasoningEfforts.slice(0, 2)) {
      const result = await api('/api/thread/settings', { viewId, threadId, model: model.model, effort: option.reasoningEffort });
      assert.equal(result.settings.model, model.model); assert.equal(result.settings.effort, option.reasoningEffort);
    }
    const sent = await api('/api/thread/send', { viewId, threadId, mode: 'start', clientUserMessageId: randomUUID(), draft: { text: 'Reply exactly NATIVE_SETTINGS_OK.' } });
    await waitFor(() => completion(sent.result.turn.id), 'Native settings turn completed.'); assert.equal(completion(sent.result.turn.id).status, 'completed');
    const metadata = (await api('/api/rpc', { method: 'thread/read', params: { threadId, includeTurns: false } })).result.thread;
    assert.equal(metadata.model, model.model); assert.equal(metadata.reasoningEffort, model.supportedReasoningEfforts[1].reasoningEffort);
    await waitFor(() => state.tokenUsage?.last, 'Latest native context notification arrived.');
    assert.notEqual(contextUsage(state.tokenUsage).tokens, null);
    const usageUpdates = events.filter(e => e.native?.method === 'thread/tokenUsage/updated' && e.native.params.threadId === threadId).length;
    await api('/api/thread/compact', { viewId, threadId });
    await waitFor(() => events.filter(e => e.native?.method === 'thread/tokenUsage/updated' && e.native.params.threadId === threadId).length > usageUpdates, 'Native compaction refreshed context.');
    await api('/api/thread/delete', { viewId, threadId, confirmed: true }); threadId = null;
    report.twoNativeEfforts = true; report.nativeContext = true; report.compactionContextRefresh = true;
  }
  if (values['exercise-references']) {
    const cwd = config.workspace ?? config.generatedRoots[0], marker = 'REF_' + randomUUID();
    const referenced = await api('/api/thread/start', { viewId, name: 'Disposable referenced conversation' });
    referenceThreadId = referenced.snapshot.thread.id; state = createChatState(referenceThreadId); installSnapshot(state, referenced);
    const seeded = await api('/api/thread/send', { viewId, threadId: referenceThreadId, mode: 'start', clientUserMessageId: randomUUID(), draft: { text: `The reference marker is ${marker}. Reply exactly that marker.` } });
    await waitFor(() => completion(seeded.result.turn.id), 'Referenced conversation seeded.'); assert.equal(completion(seeded.result.turn.id).status, 'completed');
    const created = await api('/api/thread/start', { viewId, name: 'Disposable composer probe' });
    threadId = created.snapshot.thread.id; state = createChatState(threadId); installSnapshot(state, created);
    const path = join(cwd, 'reference 文件-' + randomUUID() + '.txt'); await writeFile(path, 'REFERENCE_FILE\n', { mode: 0o600 });
    const choices = await api('/api/completions', { viewId, threadId, sigil: '@', query: '' });
    const skills = await api('/api/completions', { viewId, threadId, sigil: '$', query: '' });
    const skill = skills.items.find(item => !item.disabled), app = choices.items.find(item => item.kind === 'app' && !item.disabled), plugin = choices.items.find(item => item.kind === 'plugin' && !item.disabled);
    let text = 'Return exactly the marker from the referenced conversation. These references are validation inputs; do not change files or contact external services. @file @ref';
    const selected = [{ kind: 'file', path, token: '@file' }, { kind: 'thread', id: referenceThreadId, token: '@ref' }];
    for (const [entry, token] of [[skill, '$skill'], [app, '@app'], [plugin, '@plugin']]) if (entry) { text += ' ' + token; selected.push({ kind: entry.kind, ...(entry.id ? { id: entry.id } : {}), ...(entry.path ? { path: entry.path } : {}), token }); }
    const selections = selected.map(item => ({ ...item, start: text.indexOf(item.token), end: text.indexOf(item.token) + item.token.length }));
    const sent = await api('/api/thread/send', { viewId, threadId, mode: 'start', clientUserMessageId: randomUUID(), draft: { text, selections } });
    await waitFor(() => completion(sent.result.turn.id), 'Native composer turn completed.'); assert.equal(completion(sent.result.turn.id).status, 'completed');
    assert.ok(state.turns.flatMap(t => t.items).some(i => i.type === 'agentMessage' && i.text.includes(marker)));
    const history = (await api('/api/rpc', { method: 'thread/turns/list', params: { threadId, limit: 20, sortDirection: 'desc', itemsView: 'summary' } })).result;
    const user = history.data.flatMap(t => t.items).find(i => i.type === 'userMessage');
    assert.ok(user.content.some(p => p.type === 'text' && p.text.includes('thread://' + referenceThreadId)));
    if (skill) assert.ok(user.content.some(p => p.type === 'skill' && p.path === skill.path));
    if (app) assert.ok(user.content.some(p => p.type === 'mention' && p.path === 'app://' + app.id));
    if (plugin) assert.ok(user.content.some(p => p.type === 'mention' && p.path === 'plugin://' + plugin.id));
    const long = await api('/api/thread/send', { viewId, threadId, mode: 'start', clientUserMessageId: randomUUID(), draft: { text: 'Run sleep 15 using your command tool, then reply DONE.' } });
    await waitFor(() => events.some(e => e.native?.params?.turnId === long.result.turn.id && e.native.params.item?.type === 'commandExecution'), 'Disposable command started before queueing.');
    const queued = await api('/api/thread/send', { viewId, threadId, mode: 'queue', clientUserMessageId: randomUUID(), draft: { text: '@ref', selections: [{ kind: 'thread', id: referenceThreadId, start: 0, end: 4, token: '@ref' }] } });
    const queue = (await api('/api/rpc', { method: 'thread/queue/list', params: { threadId } })).result;
    assert.ok(queue.data.some(item => item.id === queued.result.queuedSubmission.id && item.input.some(input => input.type === 'text' && input.text.includes('<untrusted_text>'))));
    actor ??= createCodexClient({ url: config.backendUrl }); await waitFor(() => actor.status().online, 'Native cleanup client online.', 10_000);
    await actor.rpc('thread/queue/delete', { threadId, queuedSubmissionId: queued.result.queuedSubmission.id });
    await api('/api/thread/stop', { viewId, threadId, turnId: long.result.turn.id }); await waitFor(() => completion(long.result.turn.id), 'Disposable queue test interrupted.');
    await api('/api/thread/rename', { viewId, threadId, name: 'Renamed composer probe' });
    const exported = await request('/api/thread/export?threadId=' + threadId); assert.equal(exported.status, 200); assert.match(exported.headers['content-type'], /text\/markdown/); assert.ok(exported.data.includes('Renamed composer probe'));
    const fork = await api('/api/thread/fork', { viewId, threadId }); forkThreadId = fork.snapshot.thread.id;
    assert.equal(fork.snapshot.approvalPolicy, 'never'); assert.equal(fork.snapshot.sandbox.type, 'dangerFullAccess');
    await api('/api/thread/delete', { viewId, threadId: forkThreadId, confirmed: true }); forkThreadId = null;
    installSnapshot(state, await api('/api/thread/open', { viewId, threadId }));
    await api('/api/thread/archive', { viewId, threadId, confirmed: true });
    await api('/api/thread/unarchive', { viewId, threadId });
    await api('/api/thread/delete', { viewId, threadId, confirmed: true }); threadId = null;
    await api('/api/thread/delete', { viewId, threadId: referenceThreadId, confirmed: true }); referenceThreadId = null;
    report.nativeFileReference = true; report.nativeSkill = Boolean(skill); report.nativeApp = Boolean(app); report.nativePlugin = Boolean(plugin);
    report.readonlyThreadContext = true; report.queueSnapshot = true; report.renameForkArchiveExport = true;
  }
  if (values['exercise-restarts']) {
    const created = await api('/api/thread/start', { viewId, name: 'Disposable durable restart probe' });
    threadId = created.snapshot.thread.id; state = createChatState(threadId); installSnapshot(state, created);
    const messageId = randomUUID(), sent = await api('/api/thread/send', { viewId, threadId, mode: 'start', clientUserMessageId: messageId,
      draft: { text: 'Use your command tool to run sleep 12, then reply DURABLE_RESTART_OK. This is a disposable service-lifetime test.' } });
    const turnId = sent.result.turn.id;
    await waitFor(() => events.some(e => e.native?.params?.turnId === turnId && e.native.params.item?.type === 'commandExecution'), 'Work started before web restart.');
    const pid = unit => execFileSync('systemctl', ['--user', 'show', unit, '--property=MainPID', '--value'], { encoding: 'utf8' }).trim();
    const backendPid = pid('codex-console-native-backend.service'), webPid = pid('codex-console-native-web.service');
    stream.destroy(); execFileSync('systemctl', ['--user', 'restart', 'codex-console-native-web.service']);
    let loggedIn;
    for (let attempt = 0; attempt < 100; attempt++) { try { loggedIn = await request('/api/login', { password }); if (loggedIn.status === 200) break; } catch {} await delay(100); }
    assert.equal(loggedIn?.status, 200); cookie = loggedIn.headers['set-cookie'][0].split(';')[0];
    assert.equal(pid('codex-console-native-backend.service'), backendPid); assert.notEqual(pid('codex-console-native-web.service'), webPid);
    ({ viewId } = await api('/api/view', {})); stream = await connectEvents();
    installSnapshot(state, await api('/api/thread/open', { viewId, threadId }));
    await waitFor(() => completion(turnId), 'Accepted native work survived web process restart.');
    assert.equal(completion(turnId).status, 'completed');
    let history = (await api('/api/rpc', { method: 'thread/turns/list', params: { threadId, limit: 20, sortDirection: 'desc', itemsView: 'summary' } })).result;
    assert.equal(history.data.flatMap(t => t.items).filter(i => i.type === 'userMessage' && i.clientId === messageId).length, 1);
    const before = (await api('/api/status')).generation;
    execFileSync('systemctl', ['--user', 'restart', 'codex-console-native-backend.service']);
    let reconnected = false;
    for (let attempt = 0; attempt < 100; attempt++) { const status = await api('/api/status'); if (status.online && status.generation > before) { reconnected = true; break; } await delay(100); }
    assert.ok(reconnected, 'Gateway reinitialized against the restarted configured native backend.');
    installSnapshot(state, await api('/api/thread/open', { viewId, threadId }));
    history = (await api('/api/rpc', { method: 'thread/turns/list', params: { threadId, limit: 20, sortDirection: 'desc', itemsView: 'summary' } })).result;
    assert.equal(history.data.flatMap(t => t.items).filter(i => i.type === 'userMessage' && i.clientId === messageId).length, 1);
    await api('/api/thread/delete', { viewId, threadId, confirmed: true }); threadId = null;
    report.webRestartKeepsWork = true; report.backendRestartResync = true; report.restartDoesNotReplayWrites = true;
  }
  await api('/api/logout', {}); report.logout = true;
  console.log(JSON.stringify(report));
} finally {
  stream?.destroy();
  for (const id of menuThreads) if (cookie) await api('/api/thread/delete', { viewId, threadId: id, confirmed: true }).catch(() => {});
  if (projectThreadId && cookie) await api('/api/thread/delete', { viewId, threadId: projectThreadId, confirmed: true }).catch(() => {});
  for (const id of [forkThreadId, referenceThreadId]) if (id && cookie) await api('/api/thread/delete', { viewId, threadId: id, confirmed: true }).catch(() => {});
  if (threadId && actor?.status().online) {
    const active = state?.turns.findLast(t => t.status === 'inProgress');
    if (active) await actor.rpc('turn/interrupt', { threadId, turnId: active.id }).catch(() => {});
    else await actor.rpc('thread/delete', { threadId }).catch(() => {});
  }
  actor?.close();
}
