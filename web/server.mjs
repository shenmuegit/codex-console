import https from 'node:https';
import { readFileSync, mkdirSync, writeFileSync, existsSync, chmodSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { parseArgs, isDeepStrictEqual } from 'node:util';
import { createAuth, checkOrigin } from './auth.mjs';
import { createCodexClient } from './codex.mjs';
import { realpath, stat } from 'node:fs/promises';
import { createChatState, installSnapshot, applyNativeEvent, buildTurnParams, activeTurn } from './public/chat.js';
import { renderTranscript } from './transcript.mjs';

const BODY_LIMIT = 1_048_576, STREAM_LIMIT = 1_048_576;
const COOKIE = '__Host-codex_console';
const publicDir = join(dirname(fileURLToPath(import.meta.url)), 'public');
const assets = new Map([['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']], ['/chat.js', ['chat.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']]]);
const error = (status, code, message) => Object.assign(new Error(message), { status, code });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (v, max = 8192) => typeof v === 'string' && v.length <= max && !v.includes('\0');
const id = v => text(v, 128) && /^[A-Za-z0-9_-]+$/.test(v);
const absolutePath = path => text(path) && path.startsWith('/') && !path.split('/').includes('..');
const secretKeys = new Set(['accesstoken', 'refreshtoken', 'idtoken', 'apikey', 'authorization', 'authtoken', 'bearertoken', 'password', 'passwordhash', 'tokens']);
function safe(value) {
  if (Array.isArray(value)) return value.map(safe);
  if (!object(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !secretKeys.has(key.replace(/[_-]/g, '').toLowerCase())).map(([k, v]) => [k, safe(v)]));
}
function fields(params, allowed) {
  if (!object(params) || Object.keys(params).some(k => !allowed.includes(k))) throw error(400, 'INVALID_PARAMS', '参数不受支持。');
}

function validateRead(method, p) {
  const lists = ['model/list', 'project/list', 'thread/list'];
  if (lists.includes(method)) {
    fields(p, method === 'thread/list' ? ['cursor', 'limit', 'projectId', 'archived', 'cwd', 'searchTerm', 'sortKey', 'sortDirection', 'modelProviders'] :
      method === 'project/list' ? ['cursor', 'limit', 'sortKey', 'sortDirection'] : ['cursor', 'limit', 'includeHidden']);
    if ((p.cursor != null && !text(p.cursor)) || (p.limit != null && (!Number.isInteger(p.limit) || p.limit < 1 || p.limit > 100)) ||
        (p.projectId != null && !id(p.projectId)) || (p.archived != null && typeof p.archived !== 'boolean') ||
        (p.cwd != null && (!text(p.cwd) || !p.cwd.startsWith('/'))) ||
        (p.searchTerm != null && !text(p.searchTerm, 256)) || (p.sortDirection != null && !['asc', 'desc'].includes(p.sortDirection)) ||
        (p.sortKey != null && !['created_at', 'updated_at', 'recency_at', 'position', 'recencyAt', 'createdAt', 'updatedAt'].includes(p.sortKey)) ||
        (p.includeHidden != null && typeof p.includeHidden !== 'boolean') ||
        (p.modelProviders != null && (!Array.isArray(p.modelProviders) || p.modelProviders.some(v => !text(v, 128))))) throw error(400, 'INVALID_PARAMS', '列表参数不正确。');
  } else if (method === 'account/read') {
    fields(p, ['refreshToken']);
    if (p.refreshToken !== undefined && p.refreshToken !== false) throw error(400, 'INVALID_PARAMS', '网页登录不读取或刷新原生凭据。');
  } else if (['fs/readDirectory', 'fs/getMetadata'].includes(method)) {
    fields(p, ['path']); if (!absolutePath(p.path)) throw error(400, 'INVALID_PATH', '请选择绝对主机路径，不能包含上级跳转。');
  } else if (method === 'account/rateLimits/read') fields(p, []);
  else if (method === 'project/read') {
    fields(p, ['projectId']); if (!id(p.projectId)) throw error(400, 'INVALID_PARAMS', '项目 ID 不正确。');
  } else if (['thread/read', 'thread/turns/list'].includes(method)) {
    fields(p, method === 'thread/read' ? ['threadId', 'includeTurns'] : ['threadId', 'cursor', 'limit', 'sortDirection', 'itemsView']);
    if (!id(p.threadId) || (p.includeTurns != null && p.includeTurns !== false) || (p.cursor != null && !text(p.cursor)) ||
        (p.limit != null && (!Number.isInteger(p.limit) || p.limit < 1 || p.limit > 100)) ||
        (p.sortDirection != null && !['asc', 'desc'].includes(p.sortDirection)) ||
        (p.itemsView != null && p.itemsView !== 'full')) throw error(400, 'INVALID_PARAMS', '会话参数不正确。');
  } else throw error(403, 'RPC_DENIED', '浏览器不能调用这个原生接口。');
}

export async function saveProject(codex, { projectId, name, rootPath, idempotencyKey }) {
  if ((projectId != null && !id(projectId)) || !text(name, 160) || !name.trim() || !absolutePath(rootPath) ||
      (!projectId && !id(idempotencyKey))) throw error(400, 'INVALID_PROJECT', '项目名称、目录或操作标识不正确。');
  const metadata = (await codex.rpc('fs/getMetadata', { path: rootPath })).result;
  if (!metadata.isDirectory) throw error(400, 'INVALID_DIRECTORY', '项目根目录必须是可访问的目录。');
  let canonical;
  try { canonical = await realpath(rootPath); } catch { throw error(400, 'INVALID_DIRECTORY', '无法访问项目根目录。'); }
  if (projectId) {
    const { project } = (await codex.rpc('project/read', { projectId })).result;
    // Native owns metadata and additional roots; editing one primary root must not erase them.
    return (await codex.rpc('project/update', { projectId, name: name.trim(), roots: [{ path: canonical }, ...project.roots.slice(1)] })).result.project;
  }
  return (await codex.rpc('project/create', { name: name.trim(), roots: [{ path: canonical }], idempotencyKey })).result.project;
}

export async function deleteThread(codex, { threadId, confirmed }) {
  if (!id(threadId) || confirmed !== true) throw error(400, 'CONFIRM_REQUIRED', '请确认删除会话记录。');
  const watcher = `delete:${randomBytes(16).toString('hex')}`;
  let timer, currentTurnId, expected, completed;
  const generation = codex.status().generation;
  const off = codex.onEvent(event => {
    const p = event.native?.params;
    if (event.cursor.generation !== generation) return;
    if (event.kind === 'snapshot' && event.native.thread.id === threadId) {
      currentTurnId = (event.native.initialTurnsPage?.data ?? event.native.thread.turns).find(turn => turn.status === 'inProgress')?.id;
    }
    if (p?.threadId !== threadId) return;
    if (event.native.method === 'turn/started') currentTurnId = p.turn.id;
    if (event.native.method === 'turn/completed' && p.turn.id === currentTurnId) currentTurnId = null;
    if (event.native.method === 'turn/completed' && p.turn.id === expected && p.turn.status !== 'inProgress') completed?.();
  });
  try {
    await codex.retainThread(threadId, watcher);
    if (currentTurnId) {
      expected = currentTurnId;
      const completion = new Promise((resolve, reject) => {
        completed = resolve;
        timer = setTimeout(() => reject(error(409, 'INTERRUPT_TIMEOUT', '停止尚未完成，会话未删除。')), 30_000);
      });
      await Promise.all([codex.rpc('turn/interrupt', { threadId, turnId: expected }), completion]);
      if (currentTurnId) throw error(409, 'TURN_CHANGED', '其他客户端已启动新轮次，会话未删除。');
    }
    await codex.rpc('thread/delete', { threadId });
  } finally { clearTimeout(timer); off?.(); await codex.releaseThread(threadId, watcher).catch(() => {}); }
}

const requestFields = new Map([
  ['item/commandExecution/requestApproval', ['threadId', 'turnId', 'itemId', 'kind', 'reason', 'command', 'cwd', 'availableDecisions', 'networkApprovalContext', 'additionalPermissions']],
  ['item/fileChange/requestApproval', ['threadId', 'turnId', 'itemId', 'reason', 'grantRoot']],
  ['item/tool/requestUserInput', ['threadId', 'turnId', 'itemId', 'questions']],
  ['item/permissions/requestApproval', ['threadId', 'turnId', 'itemId', 'cwd', 'reason', 'permissions']],
  ['mcpServer/elicitation/request', ['threadId', 'turnId', 'serverName', 'requestId', 'message', 'mode', 'requestedSchema', 'url']],
]);

function validateAnswer(request, answer) {
  fields(answer, ['result']);
  if (!object(answer.result)) throw error(400, 'INVALID_ANSWER', '回答格式不正确。');
  if (request.method.endsWith('/requestApproval') && request.method !== 'item/permissions/requestApproval') {
    fields(answer.result, ['decision']);
    if (!['accept', 'decline', 'cancel', 'acceptForSession'].includes(answer.result.decision)) throw error(400, 'INVALID_ANSWER', '审批选项不正确。');
    if (answer.result.decision.startsWith('accept') && Array.isArray(request.params.availableDecisions) &&
        !request.params.availableDecisions.includes(answer.result.decision)) throw error(400, 'INVALID_ANSWER', '此审批选项不可用。');
  } else if (request.method === 'item/tool/requestUserInput') {
    fields(answer.result, ['answers']);
    const answers = answer.result.answers;
    if (!object(answers) || Object.keys(answers).length > 50) throw error(400, 'INVALID_ANSWER', '回答格式不正确。');
    for (const [key, value] of Object.entries(answers)) {
      if (!request.params.questions?.some(q => q.id === key) || !object(value) || !Array.isArray(value.answers) ||
          value.answers.length > 20 || value.answers.some(a => !text(a, 8192))) throw error(400, 'INVALID_ANSWER', '问题回答不正确。');
    }
  } else if (request.method === 'mcpServer/elicitation/request') {
    fields(answer.result, ['action', 'content', '_meta']);
    if (!['accept', 'decline', 'cancel'].includes(answer.result.action)) throw error(400, 'INVALID_ANSWER', '请选择接受、拒绝或取消。');
  } else {
    fields(answer.result, ['permissions', 'scope']);
    if (!object(answer.result.permissions) || !['turn', 'session'].includes(answer.result.scope)) throw error(400, 'INVALID_ANSWER', '权限回答不正确。');
    fields(answer.result.permissions, ['network', 'fileSystem']);
    for (const [key, value] of Object.entries(answer.result.permissions)) {
      if (value != null && !isDeepStrictEqual(value, request.params.permissions?.[key])) throw error(400, 'INVALID_ANSWER', '只能授予原生请求中的权限。');
    }
  }
}

async function readJson(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw error(415, 'JSON_REQUIRED', '请发送 JSON。');
  return new Promise((resolve, reject) => {
    let size = 0, failed = false; const chunks = [];
    req.on('data', chunk => {
      if (failed) return;
      size += chunk.length;
      if (size > BODY_LIMIT) { failed = true; chunks.length = 0; reject(error(413, 'BODY_TOO_LARGE', '请求内容过大。')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (failed) return;
      try { const value = JSON.parse(Buffer.concat(chunks).toString()); if (!object(value)) throw new Error(); resolve(value); }
      catch { reject(error(400, 'INVALID_JSON', 'JSON 格式不正确。')); }
    });
    req.on('error', reject);
    req.on('aborted', () => reject(error(400, 'ABORTED', '请求已取消。')));
  });
}

export function writeEvent(res, event) {
  const data = `id: ${event.cursor.generation}:${event.cursor.seq}\ndata: ${JSON.stringify(event)}\n\n`;
  if (res.destroyed) return false;
  if (res.writableLength + Buffer.byteLength(data) > STREAM_LIMIT) { res.destroy(); return false; }
  res.write(data); return true;
}

export function createWebServer({ config, codex }) {
  const origin = new URL(config.origin);
  if (origin.protocol !== 'https:' || origin.origin !== config.origin) throw error(500, 'INVALID_ORIGIN', '配置须包含完整 HTTPS 来源地址。');
  const auth = createAuth({ passwordHash: config.passwordHash }), views = new Map(), pending = new Map();
  const chats = new Map(), snapshots = new WeakMap(), renderTimers = new Map(), writes = new Map(), deleting = new Set();
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 }); chmodSync(config.stateDir, 0o700);
  const prefsPath = join(config.stateDir, 'preferences.json');
  if (!existsSync(prefsPath)) writeFileSync(prefsPath, JSON.stringify({ archivedProjectIds: [], ui: {} }), { mode: 0o600 });
  chmodSync(prefsPath, 0o600);
  let preferences = JSON.parse(readFileSync(prefsPath, 'utf8'));
  if (!Array.isArray(preferences.archivedProjectIds) || preferences.archivedProjectIds.some(value => !id(value))) throw error(500, 'INVALID_PREFERENCES', '网页偏好文件无效。');
  async function setProjectArchived(projectId, archived) {
    if (!id(projectId) || typeof archived !== 'boolean') throw error(400, 'INVALID_PROJECT', '归档参数不正确。');
    const ids = new Set(preferences.archivedProjectIds); if (archived) ids.add(projectId); else ids.delete(projectId);
    const next = { ...preferences, archivedProjectIds: [...ids] }, temp = prefsPath + '.' + randomBytes(8).toString('hex');
    writeFileSync(temp, JSON.stringify(next), { mode: 0o600, flag: 'wx' }); renameSync(temp, prefsPath); preferences = next;
  }
  let checkpoint = { generation: codex.status().generation, seq: 0 };
  const reply = (res, status, value, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers }); res.end(JSON.stringify(value));
  };
  const publicStatus = () => ({ online: codex.status().online, generation: codex.status().generation,
    defaultCwd: config.workspace ?? config.generatedRoots?.[0] ?? '' });
  const cookieToken = req => (req.headers.cookie ?? '').split(';').map(v => v.trim()).find(v => v.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
  const cookie = (token, age) => `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${age}`;
  function requireView(viewId, session) {
    const view = views.get(viewId);
    if (!view || view.session !== session) throw error(403, 'VIEW_DENIED', '页面已失效，请重新打开。');
    return view;
  }
  function releaseView(viewId, view) {
    for (const res of view.streams) res.destroy();
    views.delete(viewId);
    if (view.threadId) codex.releaseThread(view.threadId, viewId).catch(() => {});
    discardIdle(view.threadId);
  }
  function broadcast(event) {
    for (const view of views.values()) for (const res of view.streams) writeEvent(res, event);
  }
  function discardIdle(threadId) {
    if (!threadId || activeTurn(chats.get(threadId) ?? { turns: [] }) || [...views.values()].some(v => v.threadId === threadId)) return;
    clearTimeout(renderTimers.get(threadId)?.timer); renderTimers.delete(threadId); chats.delete(threadId);
  }
  function snapshotReply(result) {
    const snapshot = snapshots.get(result.result);
    if (!snapshot) throw error(503, 'SNAPSHOT_MISSING', '请重新打开会话。');
    return { snapshot, cursor: result.cursor };
  }
  async function openThread(viewId, view, threadId) {
    const version = view.openVersion = (view.openVersion ?? 0) + 1;
    const previous = view.threadId; view.threadId = threadId;
    if (previous && previous !== threadId) { await codex.releaseThread(previous, viewId); discardIdle(previous); }
    if (version !== view.openVersion) throw error(409, 'VIEW_CHANGED', '已切换到其他会话。');
    try {
      const result = await codex.retainThread(threadId, viewId);
      if (version !== view.openVersion || views.get(viewId) !== view) throw error(409, 'VIEW_CHANGED', '页面已切换，请重新打开会话。');
      return snapshotReply(result);
    }
    catch (e) { if (view.threadId === threadId) view.threadId = null; await codex.releaseThread(threadId, viewId).catch(() => {}); discardIdle(threadId); throw e; }
  }
  function renderedLater(threadId, itemIds) {
    let pending = renderTimers.get(threadId);
    if (!pending) {
      pending = { ids: new Set() };
      pending.timer = setTimeout(() => {
        renderTimers.delete(threadId);
        const state = chats.get(threadId);
        if (!state?.ready) return;
        const turns = state.turns.map(t => ({ ...t, items: t.items.filter(i => pending.ids.has(i.id)) }));
        broadcast({ kind: 'render', cursor: state.cursor, native: { threadId, items: renderTranscript(state.thread, turns).items } });
        discardIdle(threadId);
      }, 100); pending.timer.unref(); renderTimers.set(threadId, pending);
    }
    for (const id of itemIds.filter(Boolean)) pending.ids.add(id);
  }
  function reconcileWrites(state) {
    for (const turn of state.turns) for (const item of turn.items ?? []) {
      if (item.type !== 'userMessage' || !item.clientId) continue;
      const record = writes.get(`${state.threadId}:${item.clientId}`);
      if (record?.state === 'unknown') {
        record.state = 'done'; record.result = { result: { turnId: turn.id, reconciled: true }, cursor: state.cursor, effectiveSettings: state.settings };
      }
    }
  }
  function updateChat(event) {
    const threadId = event.kind === 'snapshot' ? event.native.thread.id : event.native.params?.threadId;
    if (!threadId) return;
    if (event.kind === 'snapshot') {
      let state = chats.get(threadId);
      if (!state) chats.set(threadId, state = createChatState(threadId));
      installSnapshot(state, { snapshot: event.native, cursor: event.cursor });
      snapshots.set(event.native, { ...safe(event.native), transcript: renderTranscript(state.thread, state.turns) });
      reconcileWrites(state);
    } else {
      const state = chats.get(threadId);
      if (!state) return;
      applyNativeEvent(state, event); reconcileWrites(state);
      const p = event.native.params;
      renderedLater(threadId, [p.itemId, p.item?.id, ...(p.turn?.items ?? []).map(i => i.id)]);
    }
  }
  async function setNextSettings(threadId, changes) {
    const generation = codex.status().generation;
    let off, timer;
    const notification = new Promise((resolve, reject) => {
      off = codex.onEvent(event => {
        const p = event.native?.params;
        if (event.cursor.generation === generation && event.native?.method === 'thread/settings/updated' && p.threadId === threadId &&
            Object.entries(changes).every(([key, value]) => isDeepStrictEqual(p.threadSettings[key], value))) resolve();
      });
      timer = setTimeout(() => reject(error(504, 'SETTINGS_TIMEOUT', '尚未确认下轮设置，消息未排队。')), 30_000);
    });
    try { await Promise.all([codex.rpc('thread/settings/update', { threadId, ...changes }), notification]); }
    finally { clearTimeout(timer); off?.(); }
  }
  async function sendOnce(body, view) {
    fields(body, ['viewId', 'threadId', 'draft', 'mode', 'model', 'effort', 'clientUserMessageId']);
    if (!id(body.threadId) || !id(body.clientUserMessageId) || view.threadId !== body.threadId) throw error(403, 'THREAD_NOT_OPEN', '请先打开目标会话。');
    if (deleting.has(body.threadId)) throw error(409, 'THREAD_DELETING', '会话正在删除。');
    fields(body.draft, ['text', 'selections', 'uploadIds']);
    if (!text(body.draft.text, 500_000) || !body.draft.text.trim() ||
        (body.draft.selections?.length ?? 0) || (body.draft.uploadIds?.length ?? 0) ||
        !['start', 'steer', 'queue'].includes(body.mode) ||
        (body.model != null && !text(body.model, 128)) || (body.effort != null && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(body.effort))) throw error(400, 'INVALID_DRAFT', '消息或发送选项不正确。');
    const key = `${body.threadId}:${body.clientUserMessageId}`;
    const fingerprint = JSON.stringify([body.draft, body.mode, body.model, body.effort]);
    const previous = writes.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw error(409, 'MESSAGE_ID_REUSED', '这条消息的内容已经改变，请重新确认发送。');
      if (previous.state === 'unknown') throw Object.assign(error(409, 'OUTCOME_UNKNOWN', '发送状态未知，请先刷新会话核对。'), { outcome: 'unknown' });
      return previous.state === 'done' ? previous.result : previous.promise;
    }
    for (const [key, record] of writes) if (record.state === 'done' && record.time + 600_000 < Date.now()) writes.delete(key);
    if (writes.size >= 1024) throw error(429, 'PENDING_LIMIT', '待确认消息过多，请先核对会话。');
    const state = chats.get(body.threadId);
    if (!state?.ready) throw error(409, 'RESYNC_REQUIRED', '请先刷新会话。');
    const active = activeTurn(state);
    if (body.mode === 'start' && active) throw error(409, 'ACTIVE_TURN', '会话正在运行，请选择补充或排队。');
    if (body.mode !== 'start' && !active) throw error(409, 'TURN_CHANGED', '当前轮次已结束，请选择直接发送。');
    if (body.mode === 'steer' && (body.model != null || body.effort != null)) throw error(400, 'STEER_SETTINGS', '补充输入沿用当前轮次设置。');
    const input = [{ type: 'text', text: body.draft.text, text_elements: [] }];
    const record = { state: 'pending', fingerprint, time: Date.now() }; writes.set(key, record);
    record.promise = (async () => {
      try {
        if (body.mode === 'queue') {
          const changes = { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' },
            ...(body.model ? { model: body.model } : {}), ...(body.effort ? { effort: body.effort } : {}) };
          if (state.settings.approvalPolicy !== 'never' || state.settings.sandbox?.type !== 'dangerFullAccess' ||
              (body.model && state.settings.model !== body.model) || (body.effort && state.settings.effort !== body.effort)) {
            try { await setNextSettings(body.threadId, changes); }
            catch (e) { e.outcome = 'not-sent'; throw e; }
          }
        }
        const method = { start: 'turn/start', steer: 'turn/steer', queue: 'thread/queue/add' }[body.mode];
        let params = buildTurnParams({ threadId: body.threadId, input, model: body.model, effort: body.effort, clientUserMessageId: body.clientUserMessageId });
        if (body.mode !== 'start') params = { threadId: body.threadId, input, clientUserMessageId: body.clientUserMessageId,
          ...(body.mode === 'steer' ? { expectedTurnId: active.id } : {}) };
        const response = await codex.rpc(method, params);
        record.state = 'done'; record.result = { ...response, result: safe(response.result), effectiveSettings: safe(state.settings) };
        return record.result;
      } catch (e) {
        if (e.outcome === 'unknown') record.state = 'unknown'; else writes.delete(key);
        throw e;
      }
    })();
    return record.promise;
  }
  const off = codex.onEvent(event => {
    checkpoint = event.cursor;
    if (event.kind === 'status') {
      pending.clear();
      for (const state of chats.values()) applyNativeEvent(state, event);
      broadcast({ ...event, native: publicStatus() });
      broadcast({ kind: 'resync', cursor: checkpoint, native: { reason: 'connection-changed' } });
    } else if (event.kind === 'request') {
      const { method, params } = event.native, allowed = requestFields.get(method);
      if (!allowed) {
        codex.respond(event.requestKey, { error: { code: -32601, message: 'Unsupported by this browser client.' } }).catch(() => {});
        return;
      }
      const native = { method, params: safe(Object.fromEntries(allowed.filter(key => Object.hasOwn(params, key)).map(key => [key, params[key]]))) };
      pending.set(event.requestKey, native);
      updateChat({ ...event, native });
      broadcast({ ...event, native });
    } else if (event.kind === 'snapshot') { updateChat(event); broadcast({ ...event, native: snapshots.get(event.native) }); }
    else if (/^(thread\/|turn\/|item\/|project\/|account\/rateLimits\/)/.test(event.native?.method) ||
             ['warning', 'error', 'serverRequest/resolved', 'account/updated'].includes(event.native?.method)) {
      if (event.native.method === 'serverRequest/resolved') {
        // The native client also invalidates its original request ID; HTTP races then return 409.
        for (const [key] of pending) if (key === `${checkpoint.generation}:${JSON.stringify(event.native.params.requestId)}`) pending.delete(key);
      }
      updateChat(event); broadcast({ ...event, native: safe(event.native) });
    }
  });
  const server = https.createServer({ cert: readFileSync(config.tlsCert), key: readFileSync(config.tlsKey), minVersion: 'TLSv1.2' }, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const url = new URL(req.url, config.origin), mutation = !['GET', 'HEAD'].includes(req.method);
      if (req.headers.host !== new URL(config.origin).host) throw error(403, 'HOST_DENIED', '请使用配置中的地址。');
      if (mutation || req.headers.origin) checkOrigin(req.headers.origin, config.origin);
      if (!mutation && assets.has(url.pathname)) {
        const [file, type] = assets.get(url.pathname);
        res.writeHead(200, { 'Content-Type': type }); res.end(req.method === 'HEAD' ? undefined : readFileSync(join(publicDir, file))); return;
      }
      if (req.method === 'POST' && url.pathname === '/api/login') {
        const body = await readJson(req); fields(body, ['password']);
        const result = await auth.login(body.password, req.socket.remoteAddress);
        reply(res, 200, { expiresAt: result.expiresAt }, { 'Set-Cookie': cookie(result.token, 43200) }); return;
      }
      const token = cookieToken(req), session = auth.verifySession(token);
      if (!session) throw error(401, 'LOGIN_REQUIRED', '请先登录。');
      if (req.method === 'GET' && url.pathname === '/api/status') { reply(res, 200, publicStatus()); return; }
      if (req.method === 'GET' && url.pathname === '/api/preferences') { reply(res, 200, safe(preferences)); return; }
      if (req.method === 'GET' && url.pathname === '/api/events') {
        const view = requireView(url.searchParams.get('viewId'), session);
        if (view.streams.size >= 2) throw error(429, 'TOO_MANY_STREAMS', '请关闭重复页面。');
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' }); res.flushHeaders();
        view.streams.add(res);
        writeEvent(res, { kind: 'status', cursor: checkpoint, native: publicStatus() });
        writeEvent(res, { kind: 'resync', cursor: checkpoint, native: { reason: 'snapshot-required' } });
        const heartbeat = setInterval(() => {
          if (!auth.verifySession(token)) { res.destroy(); return; }
          if (res.writableLength > STREAM_LIMIT) { res.destroy(); return; }
          res.write(': heartbeat\n\n');
        }, 15_000); heartbeat.unref();
        res.on('close', () => {
          clearInterval(heartbeat); view.streams.delete(res);
          if (!view.streams.size && view.threadId) { const previous = view.threadId; view.threadId = null; ++view.openVersion; codex.releaseThread(previous, url.searchParams.get('viewId')).catch(() => {}); discardIdle(previous); }
        });
        return;
      }
      if (req.method !== 'POST') throw error(404, 'NOT_FOUND', '没有这个页面。');
      const body = await readJson(req);
      if (url.pathname === '/api/logout') {
        auth.revoke(token);
        for (const [key, view] of views) if (view.session === session) releaseView(key, view);
        reply(res, 200, {}, { 'Set-Cookie': cookie('', 0) });
      } else if (url.pathname === '/api/view') {
        fields(body, []);
        for (const [key, view] of views) if (view.session.expiresAt <= Date.now()) releaseView(key, view);
        if (views.size >= 1024) throw error(429, 'TOO_MANY_VIEWS', '页面数量过多，请退出后重新登录。');
        const viewId = randomBytes(24).toString('base64url');
        views.set(viewId, { session, threadId: null, streams: new Set() }); reply(res, 200, { viewId });
      } else if (url.pathname === '/api/rpc') {
        fields(body, ['method', 'params']); validateRead(body.method, body.params);
        const result = await codex.rpc(body.method, body.params);
        if (body.method === 'thread/turns/list') {
          const turns = structuredClone(result.result.data);
          for (const turn of turns) for (const item of turn.items) item._cursor = result.cursor;
          reply(res, 200, { ...result, result: { ...safe(result.result), transcript: renderTranscript({ id: body.params.threadId }, turns) } });
        } else if (body.method === 'project/list') reply(res, 200, { ...result, result: { ...safe(result.result),
          data: result.result.data.map(project => ({ ...safe(project), webArchived: preferences.archivedProjectIds.includes(project.id) })) } });
        else reply(res, 200, { ...result, result: safe(result.result) });
      } else if (url.pathname === '/api/project/save') {
        fields(body, ['viewId', 'projectId', 'name', 'rootPath', 'idempotencyKey']); requireView(body.viewId, session);
        const project = await saveProject(codex, body);
        reply(res, 200, { project: { ...safe(project), webArchived: preferences.archivedProjectIds.includes(project.id) } });
      } else if (url.pathname === '/api/project/archive') {
        fields(body, ['viewId', 'projectId', 'archived']); requireView(body.viewId, session);
        await setProjectArchived(body.projectId, body.archived); reply(res, 200, { archivedProjectIds: preferences.archivedProjectIds });
        broadcast({ kind: 'preferences', cursor: checkpoint, native: { archivedProjectIds: preferences.archivedProjectIds } });
      } else if (url.pathname === '/api/directory/create') {
        fields(body, ['viewId', 'path']); requireView(body.viewId, session);
        if (!absolutePath(body.path) || body.path === '/') throw error(400, 'INVALID_DIRECTORY', '请输入有效目录路径。');
        if (!(await codex.rpc('fs/getMetadata', { path: dirname(body.path) })).result.isDirectory) throw error(400, 'INVALID_DIRECTORY', '父目录不存在。');
        reply(res, 200, await codex.rpc('fs/createDirectory', { path: body.path, recursive: false }));
      } else if (url.pathname === '/api/thread/delete') {
        fields(body, ['viewId', 'threadId', 'confirmed']); requireView(body.viewId, session);
        if (!id(body.threadId) || body.confirmed !== true) throw error(400, 'CONFIRM_REQUIRED', '请确认删除会话记录。');
        if (deleting.has(body.threadId)) throw error(409, 'THREAD_DELETING', '会话正在删除。');
        deleting.add(body.threadId);
        try {
          await deleteThread(codex, body);
          for (const [key, view] of views) if (view.threadId === body.threadId) { view.threadId = null; ++view.openVersion; codex.releaseThread(body.threadId, key).catch(() => {}); }
          discardIdle(body.threadId); reply(res, 200, {});
        } finally { deleting.delete(body.threadId); }
      } else if (url.pathname === '/api/thread/open') {
        fields(body, ['viewId', 'threadId']); const view = requireView(body.viewId, session);
        if (!id(body.threadId)) throw error(400, 'INVALID_THREAD', '会话 ID 不正确。');
        reply(res, 200, await openThread(body.viewId, view, body.threadId));
      } else if (url.pathname === '/api/thread/start') {
        fields(body, ['viewId', 'projectId', 'cwd', 'name']); const view = requireView(body.viewId, session);
        if (!text(body.cwd) || !body.cwd.startsWith('/') || (body.projectId != null && !id(body.projectId)) ||
            (body.name != null && (!text(body.name, 160) || !body.name.trim()))) throw error(400, 'INVALID_THREAD', '会话目录或名称不正确。');
        let cwd;
        try { cwd = await realpath(body.cwd); if (!(await stat(cwd)).isDirectory()) throw new Error(); }
        catch { throw error(400, 'INVALID_DIRECTORY', '请选择存在且可访问的主机目录。'); }
        if (body.projectId) {
          const { project } = (await codex.rpc('project/read', { projectId: body.projectId })).result;
          const roots = await Promise.all(project.roots.map(root => realpath(root.path).catch(() => null)));
          if (!roots.includes(cwd)) throw error(400, 'PROJECT_ROOT_MISMATCH', '请选择该项目已登记的根目录。');
        }
        const fingerprint = JSON.stringify([cwd, body.projectId, body.name]);
        if (view.creation?.fingerprint !== fingerprint && view.creation) throw error(409, 'CREATE_PENDING', '上一会话尚未确认，请先核对列表。');
        if (view.creation?.unknown) throw Object.assign(error(409, 'OUTCOME_UNKNOWN', '创建状态未知，请先核对会话列表。'), { outcome: 'unknown' });
        if (!view.creation) view.creation = { fingerprint, threadId: null, promise: null };
        const creation = view.creation;
        if (!creation.promise) creation.promise = (async () => {
          try {
            if (!creation.threadId) creation.threadId = (await codex.rpc('thread/start', { cwd, approvalPolicy: 'never', sandbox: 'danger-full-access',
              ...(body.projectId ? { projectId: body.projectId } : {}) })).result.thread.id;
            await codex.rpc('thread/name/set', { threadId: creation.threadId, name: body.name?.trim() || '新会话' });
            const result = await openThread(body.viewId, view, creation.threadId);
            view.creation = null; return result;
          } catch (e) { creation.promise = null; if (!creation.threadId && e.outcome === 'unknown') creation.unknown = true; throw e; }
        })();
        reply(res, 200, await creation.promise);
      } else if (url.pathname === '/api/thread/send') {
        reply(res, 200, await sendOnce(body, requireView(body.viewId, session)));
      } else if (url.pathname === '/api/thread/stop') {
        fields(body, ['viewId', 'threadId', 'turnId']); const view = requireView(body.viewId, session);
        if (!id(body.threadId) || !id(body.turnId) || view.threadId !== body.threadId || activeTurn(chats.get(body.threadId) ?? { turns: [] })?.id !== body.turnId) throw error(409, 'TURN_CHANGED', '目标轮次已变化，请刷新会话。');
        reply(res, 200, await codex.rpc('turn/interrupt', { threadId: body.threadId, turnId: body.turnId }));
      } else if (url.pathname === '/api/request/respond') {
        fields(body, ['viewId', 'requestKey', 'answer']); requireView(body.viewId, session);
        const request = pending.get(body.requestKey);
        if (!request) throw error(409, 'STALE_NATIVE_REQUEST', '请求已被回答或已失效。');
        validateAnswer(request, body.answer); pending.delete(body.requestKey);
        await codex.respond(body.requestKey, body.answer); reply(res, 200, {});
      } else throw error(404, 'NOT_FOUND', '没有这个操作。');
    } catch (e) {
      if (res.headersSent) { res.destroy(); return; }
      const status = e.status ?? ({ ORIGIN_DENIED: 403, LOGIN_DENIED: 401, LOGIN_THROTTLED: 429, STALE_NATIVE_REQUEST: 409, NATIVE_DISCONNECTED: 503, NATIVE_TIMEOUT: 504 }[e.code] ?? (typeof e.code === 'number' ? 422 : 500));
      reply(res, status, { error: { code: e.code ?? 'INTERNAL', message: status === 500 ? '操作失败，请查看服务状态。' : e.message, ...(e.outcome ? { outcome: e.outcome } : {}) } }, status === 413 ? { Connection: 'close' } : {});
    }
  });
  server.requestTimeout = 30_000; server.headersTimeout = 10_000;
  server.on('close', () => { off(); for (const [key, view] of views) releaseView(key, view); for (const value of renderTimers.values()) clearTimeout(value.timer); });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: { config: { type: 'string' } } });
    if (!values.config) throw error(500, 'CONFIG_REQUIRED', '请指定私有配置文件。');
    const config = JSON.parse(readFileSync(values.config, 'utf8'));
    const codex = createCodexClient({ url: config.backendUrl });
    const server = createWebServer({ config, codex });
    server.listen(config.port, config.listenHost, () => console.log('Codex browser service ready.'));
    server.on('error', () => { codex.close(); process.exitCode = 1; console.error('Browser service could not listen.'); });
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { server.closeAllConnections(); server.close(() => codex.close()); });
  } catch (e) { console.error(`Browser service startup failed (${e.code ?? e.name}).`); process.exitCode = 1; }
}
