import https from 'node:https';
import { readFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { parseArgs, isDeepStrictEqual } from 'node:util';
import { createAuth, checkOrigin } from './auth.mjs';
import { createCodexClient } from './codex.mjs';
import { realpath, stat } from 'node:fs/promises';
import { createChatState, installSnapshot, applyNativeEvent, buildTurnParams, activeTurn } from './public/chat.js';
import { renderTranscript, boundedHistoryItem } from './transcript.mjs';
import { createFiles } from './files.mjs';
import { pipeline } from 'node:stream/promises';
import { modelChoice } from './public/usage.js';
import { encodeComposer, utf8Range } from './public/composer.js';
import { itemText } from './public/chat.js';
import { validateConfig } from './service.mjs';

const BODY_LIMIT = 1_048_576, STREAM_LIMIT = 1_048_576;
const COOKIE = '__Host-codex_console';
const publicDir = join(dirname(fileURLToPath(import.meta.url)), 'public');
const assets = new Map([['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']], ['/chat.js', ['chat.js', 'text/javascript; charset=utf-8']],
  ['/composer.js', ['composer.js', 'text/javascript; charset=utf-8']],
  ['/usage.js', ['usage.js', 'text/javascript; charset=utf-8']],
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
        (p.cwd != null && (Array.isArray(p.cwd) ? !p.cwd.length || p.cwd.length > 100 || p.cwd.some(path => !absolutePath(path)) : !absolutePath(p.cwd))) ||
        (p.searchTerm != null && !text(p.searchTerm, 256)) || (p.sortDirection != null && !['asc', 'desc'].includes(p.sortDirection)) ||
        (p.sortKey != null && !['created_at', 'updated_at', 'recency_at', 'position', 'recencyAt', 'createdAt', 'updatedAt'].includes(p.sortKey)) ||
        (p.includeHidden != null && typeof p.includeHidden !== 'boolean') ||
        (p.modelProviders != null && (!Array.isArray(p.modelProviders) || p.modelProviders.some(v => !text(v, 128))))) throw error(400, 'INVALID_PARAMS', '列表参数不正确。');
  } else if (method === 'account/read') {
    fields(p, ['refreshToken']);
    if (p.refreshToken !== undefined && p.refreshToken !== false) throw error(400, 'INVALID_PARAMS', '网页登录不读取或刷新原生凭据。');
  } else if (['skills/list', 'plugin/installed'].includes(method)) {
    fields(p, ['cwds']); if (!Array.isArray(p.cwds) || p.cwds.length > 8 || p.cwds.some(path => !absolutePath(path))) throw error(400, 'INVALID_PARAMS', '工作目录参数不正确。');
  } else if (['app/list', 'app/installed'].includes(method)) {
    fields(p, method === 'app/list' ? ['threadId', 'limit', 'cursor'] : ['threadId']);
    if ((p.threadId != null && !id(p.threadId)) || (p.limit != null && (!Number.isInteger(p.limit) || p.limit < 1 || p.limit > 100)) || (p.cursor != null && !text(p.cursor))) throw error(400, 'INVALID_PARAMS', '应用目录参数不正确。');
  } else if (method === 'thread/queue/list') {
    fields(p, ['threadId']); if (!id(p.threadId)) throw error(400, 'INVALID_PARAMS', '会话 ID 不正确。');
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
        (p.itemsView != null && !['summary', 'full'].includes(p.itemsView))) throw error(400, 'INVALID_PARAMS', '会话参数不正确。');
  } else throw error(403, 'RPC_DENIED', '浏览器不能调用这个原生接口。');
}

export async function deleteThread(codex, { threadId, confirmed }) {
  return removeThread(codex, { threadId, confirmed }, 'thread/delete');
}
async function removeThread(codex, { threadId, confirmed }, method) {
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
    await codex.rpc(method, { threadId });
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
    const timer = setTimeout(() => { failed = true; chunks.length = 0; reject(error(408, 'BODY_TIMEOUT', '请求接收超时。')); }, 30_000);
    req.on('data', chunk => {
      if (failed) return;
      size += chunk.length;
      if (size > BODY_LIMIT) { failed = true; clearTimeout(timer); chunks.length = 0; reject(error(413, 'BODY_TOO_LARGE', '请求内容过大。')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      clearTimeout(timer);
      if (failed) return;
      try { const value = JSON.parse(Buffer.concat(chunks).toString()); if (!object(value)) throw new Error(); resolve(value); }
      catch { reject(error(400, 'INVALID_JSON', 'JSON 格式不正确。')); }
    });
    req.on('error', e => { clearTimeout(timer); reject(e); });
    req.on('aborted', () => { clearTimeout(timer); reject(error(400, 'ABORTED', '请求已取消。')); });
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
  const initialHistory = new WeakMap();
  const files = createFiles(config);
  let accountEpoch = 0;
  async function nativeModels() {
    const models = []; let cursor;
    do { const page = (await codex.rpc('model/list', { limit: 100, ...(cursor ? { cursor } : {}) })).result; models.push(...page.data); cursor = page.nextCursor; } while (cursor);
    return models;
  }
  const nativeRead = async (method, params) => (await codex.rpc(method, params)).result;
  async function skillsAt(cwd) { return (await nativeRead('skills/list', { cwds: [cwd] })).data.flatMap(entry => entry.skills); }
  async function pluginsAt(cwd) { return (await nativeRead('plugin/installed', { cwds: [cwd] })).marketplaces.flatMap(market => market.plugins); }
  async function appsAt(threadId) {
    const [catalog, runtime] = await Promise.all([nativeRead('app/list', { threadId, limit: 100 }), nativeRead('app/installed', { threadId })]);
    const installed = new Map(runtime.apps.map(app => [app.id, app]));
    return catalog.data.map(app => ({ ...app, callable: Boolean(installed.get(app.id)?.callable && installed.get(app.id)?.enabled && app.isAccessible && app.isEnabled) }));
  }
  async function referenceSnapshot(threadId) {
    const { thread } = await nativeRead('thread/read', { threadId, includeTurns: false });
    const pieces = []; let cursor, length = 0, truncated = false;
    do {
      const page = await nativeRead('thread/turns/list', { threadId, limit: 20, sortDirection: 'desc', itemsView: 'summary', ...(cursor ? { cursor } : {}) });
      for (const turn of page.data) for (const item of [...turn.items].reverse()) {
        const value = `${item.type}: ${itemText(item)}\n`, bytes = Buffer.from(value), left = 8192 - length;
        if (bytes.length > left) { pieces.push(bytes.subarray(0, left).toString('utf8')); truncated = true; length = 8192; break; }
        pieces.push(value); length += bytes.length;
      }
      cursor = page.nextCursor;
      if (length >= 8192) { if (cursor) truncated = true; break; }
    } while (cursor);
    return { name: thread.name || thread.preview || threadId, snapshot: pieces.reverse().join(''), truncated };
  }
  async function resolveSelections(draft, state) {
    const selections = draft.selections ?? [];
    if (!Array.isArray(selections) || selections.length > 256) throw error(400, 'INVALID_SELECTIONS', '引用数量不正确。');
    const resolved = [], contexts = new Map(); let skills, plugins, apps;
    for (const selection of selections) {
      fields(selection, ['kind', 'id', 'path', 'start', 'end', 'token']); utf8Range(draft.text, selection.start, selection.end);
      if (draft.text.slice(selection.start, selection.end) !== selection.token) throw error(400, 'STALE_SELECTION', '引用文本已变化，请重新选择。');
      let entity;
      if (['file', 'directory'].includes(selection.kind)) {
        if (!absolutePath(selection.path)) throw error(400, 'INVALID_PATH', '引用路径不正确。');
        const cwd = await realpath(state.thread.cwd), path = await realpath(selection.path);
        if (path !== cwd && !path.startsWith(cwd === '/' ? '/' : cwd + '/')) throw error(403, 'REFERENCE_SCOPE', '文件引用须在会话实际工作目录中。');
        const metadata = await nativeRead('fs/getMetadata', { path });
        if (selection.kind === 'file' ? !metadata.isFile : !metadata.isDirectory) throw error(409, 'REFERENCE_CHANGED', '引用文件或目录已变化。');
        entity = { path, name: path.split('/').at(-1) };
      } else if (selection.kind === 'skill') {
        skills ??= await skillsAt(state.thread.cwd); const skill = skills.find(skill => skill.enabled && skill.path === selection.path);
        if (!skill) throw error(422, 'SKILL_UNAVAILABLE', '技能不在当前工作目录的原生目录中。'); entity = { name: skill.name, path: skill.path };
      } else if (selection.kind === 'plugin') {
        plugins ??= await pluginsAt(state.thread.cwd); const plugin = plugins.find(plugin => plugin.id === selection.id && plugin.installed && plugin.enabled && plugin.availability !== 'DISABLED_BY_ADMIN');
        if (!plugin) throw error(422, 'PLUGIN_UNAVAILABLE', '原生插件不可用。'); entity = { id: plugin.id, name: plugin.name };
      } else if (selection.kind === 'app') {
        apps ??= await appsAt(state.threadId); const app = apps.find(app => app.id === selection.id && app.callable);
        if (!app) throw error(422, 'APP_UNAVAILABLE', '原生应用工具不可用。'); entity = { id: app.id, name: app.name };
      } else if (selection.kind === 'thread') {
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(selection.id)) throw error(400, 'INVALID_THREAD_REFERENCE', '会话引用 ID 不正确。');
        if (selection.id === state.threadId) entity = { id: selection.id, name: state.thread.name ?? '' };
        else {
          if (!contexts.has(selection.id)) {
            if (contexts.size >= 16 || [...contexts.keys(), selection.id].join('').length > 768) throw error(400, 'TOO_MANY_REFERENCES', '会话引用超过原生上限。');
            contexts.set(selection.id, await referenceSnapshot(selection.id));
          }
          entity = { id: selection.id, ...contexts.get(selection.id) };
        }
      } else throw error(400, 'INVALID_SELECTION', '引用类型不受支持。');
      resolved.push({ ...selection, ...entity });
    }
    return resolved;
  }
  async function completions(state, sigil, query) {
    if (!['@', '$'].includes(sigil) || !text(query, 256)) throw error(400, 'INVALID_COMPLETION', '补全查询不正确。');
    const match = name => name.toLocaleLowerCase().includes(query.toLocaleLowerCase()), items = [], unavailable = [];
    if (sigil === '$') {
      for (const skill of await skillsAt(state.thread.cwd)) if (match(skill.name)) items.push({ kind: 'skill', path: skill.path, name: skill.name, label: '$' + skill.name, disabled: !skill.enabled });
      return { items, unavailable };
    }
    const cwd = state.thread.cwd, slash = query.lastIndexOf('/');
    const path = slash < 0 ? cwd : resolve(cwd, query.slice(0, slash + 1)), needle = slash < 0 ? query : query.slice(slash + 1);
    const calls = await Promise.allSettled([
      path === cwd || path.startsWith(cwd === '/' ? '/' : cwd + '/') ? nativeRead('fs/readDirectory', { path }) : Promise.reject(new Error('目录不在当前工作区。')),
      nativeRead('thread/list', { limit: 20, modelProviders: [], ...(query ? { searchTerm: query } : {}) }), appsAt(state.threadId), pluginsAt(cwd),
    ]);
    for (let index = 0; index < calls.length; index++) if (calls[index].status === 'rejected') unavailable.push({ kind: ['文件', '会话', '应用', '插件'][index], message: calls[index].reason.message });
    if (calls[0].status === 'fulfilled') for (const entry of calls[0].value.entries) if (entry.fileName.toLocaleLowerCase().includes(needle.toLocaleLowerCase())) items.push({ kind: entry.isDirectory ? 'directory' : 'file', path: join(path, entry.fileName), name: entry.fileName, label: '@' + entry.fileName });
    if (calls[1].status === 'fulfilled') for (const thread of calls[1].value.data) if (thread.id !== state.threadId) items.push({ kind: 'thread', id: thread.id, name: [...(thread.name || thread.preview || thread.id)].slice(0, 160).join(''), label: '@' + (thread.name || thread.preview || thread.id) });
    if (calls[2].status === 'fulfilled') for (const app of calls[2].value) if (match(app.name)) items.push({ kind: 'app', id: app.id, name: app.name, label: '@' + app.name, disabled: !app.callable });
    if (calls[3].status === 'fulfilled') for (const plugin of calls[3].value) if (match(plugin.name)) items.push({ kind: 'plugin', id: plugin.id, name: plugin.name, label: '@' + plugin.name, disabled: !plugin.installed || !plugin.enabled || plugin.availability === 'DISABLED_BY_ADMIN' });
    return { items: items.slice(0, 100), unavailable };
  }
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 }); chmodSync(config.stateDir, 0o700);
  let checkpoint = { generation: codex.status().generation, seq: 0 };
  const reply = (res, status, value, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers }); res.end(JSON.stringify(value));
  };
  const publicStatus = () => ({ online: codex.status().online, generation: codex.status().generation,
    uploadLimitBytes: config.uploadLimitBytes ?? 33_554_432 });
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
    if (Buffer.byteLength(JSON.stringify(event)) + 64 > STREAM_LIMIT) {
      const threadId = event.threadId ?? event.native?.thread?.id ?? event.native?.threadId ?? event.native?.params?.threadId;
      event = { cursor: event.cursor, kind: event.kind === 'render' ? 'renderRequired' : 'resync',
        native: { threadId, reason: 'large-event-use-https' } };
    }
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
    if (!chats.has(threadId)) chats.set(threadId, createChatState(threadId));
    if (previous && previous !== threadId) { await codex.releaseThread(previous, viewId); discardIdle(previous); }
    if (version !== view.openVersion) throw error(409, 'VIEW_CHANGED', '已切换到其他会话。');
    try {
      const result = await codex.retainThread(threadId, viewId);
      if (version !== view.openVersion || views.get(viewId) !== view) throw error(409, 'VIEW_CHANGED', '页面已切换，请重新打开会话。');
      const history = initialHistory.get(result.result);
      const reply = snapshotReply(history ? await history : result);
      const snapshot = reply.snapshot;
      const references = await files.issueTranscriptRefs(snapshot.thread, snapshot.initialTurnsPage?.data ?? snapshot.thread.turns ?? []);
      if (version !== view.openVersion || views.get(viewId) !== view) throw error(409, 'VIEW_CHANGED', '已切换到其他会话。');
      return { ...reply, snapshot: { ...snapshot, transcript: renderTranscript(snapshot.thread, [...(snapshot.initialTurnsPage?.data ?? snapshot.thread.turns ?? [])].reverse(), references) } };
    }
    catch (e) {
      if (version === view.openVersion || view.threadId !== threadId) {
        if (version === view.openVersion) view.threadId = null;
        await codex.releaseThread(threadId, viewId).catch(() => {}); discardIdle(threadId);
      }
      throw e;
    }
  }
  function renderedLater(threadId, itemIds) {
    let pending = renderTimers.get(threadId);
    if (!pending) {
      pending = { ids: new Set() };
      pending.timer = setTimeout(async () => {
        renderTimers.delete(threadId);
        const state = chats.get(threadId);
        if (!state?.ready) return;
        const turns = structuredClone(state.turns.map(t => ({ ...t, items: t.items.filter(i => pending.ids.has(i.id)) }))), cursor = state.cursor;
        const references = await files.issueTranscriptRefs(state.thread, turns).catch(() => new Map());
        broadcast({ kind: 'render', cursor, native: { threadId, items: renderTranscript(state.thread, turns, references).items } });
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
      if (!event.native.historyKind) state.resumeCursor = event.cursor;
      const pendingRequests = [...pending].filter(([, request]) => request.params.threadId === threadId);
      installSnapshot(state, { snapshot: { ...event.native, pendingRequests: event.native.pendingRequests ?? pendingRequests }, cursor: event.cursor });
      const snapshot = { ...safe(event.native), pendingRequests: [...state.requests], tokenUsage: state.tokenUsage, nativeError: state.error,
        historyKind: event.native.historyKind ?? (event.native.itemsBackwardsCursor ? 'items' : 'turns'), transcript: renderTranscript(state.thread, state.turns) };
      if (event.native.itemsBackwardsCursor) snapshot.initialTurnsPage = { ...snapshot.initialTurnsPage, nextCursor: null };
      snapshots.set(event.native, snapshot);
      renderedLater(threadId, state.turns.flatMap(turn => turn.items.map(item => item.id)));
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
    if (!text(body.draft.text, 500_000) || (!body.draft.text.trim() && !body.draft.uploadIds?.length) ||
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
    let attached, encoded;
    try {
      attached = await files.attachmentInputs(body.draft.uploadIds ?? [], body.threadId);
      encoded = encodeComposer({ text: body.draft.text, selections: await resolveSelections(body.draft, state), uploads: attached, threadId: body.threadId, mode: body.mode });
    } catch (e) { if (e.outcome) e.outcome = 'not-sent'; throw e; }
    if (body.model || body.effort || attached.some(item => item.type === 'localImage')) {
      const model = modelChoice(await nativeModels(), body.model || state.settings.model, body.effort);
      if (attached.some(item => item.type === 'localImage') && !model.inputModalities?.includes('image')) throw error(422, 'MODEL_NO_IMAGES', '所选模型不支持照片，附件和草稿已保留。');
    }
    // Recheck after file validation: another HTTP request may already own this UUID.
    if (writes.has(key)) return sendOnce(body, view);
    if (writes.size >= 1024) throw error(429, 'PENDING_LIMIT', '待确认消息过多，请先核对会话。');
    const input = encoded.input;
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
        if (encoded.additionalContext) params.additionalContext = encoded.additionalContext;
        if (body.mode !== 'start') params = { threadId: body.threadId, input, clientUserMessageId: body.clientUserMessageId,
          ...(body.mode === 'steer' ? { expectedTurnId: active.id, ...(encoded.additionalContext ? { additionalContext: encoded.additionalContext } : {}) } : {}) };
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
    if (event.kind === 'status' || event.native?.method === 'account/updated') ++accountEpoch;
    if (event.native?.method === 'thread/settings/updated' && chats.get(event.native.params.threadId)?.settings.model !== event.native.params.threadSettings.model) ++accountEpoch;
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
    } else if (event.kind === 'snapshot') {
      updateChat(event);
      const kind = event.native.thread.historyMode === 'legacy' ? 'turns' : event.native.itemsBackwardsCursor ? 'items' : null;
      if (kind && [...views.values()].some(view => view.threadId === event.native.thread.id)) {
        const history = codex.history(kind, { threadId: event.native.thread.id, limit: 20, sortDirection: 'desc', ...(kind === 'turns' ? { itemsView: 'summary' } : {}) });
        initialHistory.set(event.native, history); history.catch(() => {});
      }
    } else if (event.kind === 'history') {
      const state = chats.get(event.threadId); if (!state?.ready) return;
      const turns = new Map();
      const entries = event.historyKind === 'items' ? [...event.native.data].reverse() :
        [...event.native.data].reverse().flatMap(turn => turn.items.map(item => ({ turnId: turn.id, item })));
      for (const entry of entries) {
        let turn = turns.get(entry.turnId);
        if (!turn) { const known = (event.historyKind === 'turns' ? event.native.data : state.turns).find(turn => turn.id === entry.turnId); turns.set(entry.turnId, turn = { ...(known ?? { id: entry.turnId, status: 'completed' }), items: [] }); }
        turn.items.push({ ...boundedHistoryItem(entry.item), _cursor: event.cursor, _incomplete: false });
      }
      if (event.initial) for (const live of state.turns) {
        const current = live.items.filter(item => (item._cursor?.seq ?? 0) > (state.resumeCursor?.seq ?? 0) || live.status === 'inProgress' && (item._incomplete || item.type === 'agentMessage'));
        if (!current.length && live.status !== 'inProgress') continue;
        let turn = turns.get(live.id); if (!turn) turns.set(live.id, turn = { ...live, items: [] });
        for (const item of current) {
          const index = turn.items.findIndex(existing => existing.id === item.id);
          if (index < 0) turn.items.push(boundedHistoryItem(item));
          else if ((item._cursor?.seq ?? 0) > (state.resumeCursor?.seq ?? 0)) turn.items[index] = boundedHistoryItem(item);
        }
      }
      const snapshot = { thread: structuredClone(state.thread), model: state.settings.model, reasoningEffort: state.settings.effort,
        cwd: state.settings.cwd, approvalPolicy: state.settings.approvalPolicy, sandbox: state.settings.sandbox, activePermissionProfile: state.settings.activePermissionProfile,
        historyKind: event.historyKind, pendingRequests: [...state.requests], tokenUsage: state.tokenUsage, nativeError: state.error,
        initialTurnsPage: { data: [...turns.values()].reverse(), nextCursor: event.native.nextCursor } };
      if (event.initial) {
        const enriched = { kind: 'snapshot', cursor: event.cursor, threadId: event.threadId, native: snapshot };
        updateChat(enriched); snapshots.set(event.native, snapshots.get(snapshot));
      } else snapshots.set(event.native, { ...safe(snapshot), transcript: renderTranscript(snapshot.thread, [...turns.values()]) });
    }
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
      if (req.method === 'GET' && url.pathname === '/api/thread/export') {
        const threadId = url.searchParams.get('threadId'); if (!id(threadId)) throw error(400, 'INVALID_THREAD', '会话 ID 不正确。');
        const { thread } = await nativeRead('thread/read', { threadId, includeTurns: false });
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="conversation.md"; filename*=UTF-8''${encodeURIComponent(threadId + '.md')}` });
        res.write(`# ${(thread.name || threadId).replace(/[\r\n]/g, ' ')}\n\nThread: ${threadId}\n\n`);
        let cursor, previousTurn;
        do {
          const legacy = thread.historyMode === 'legacy';
          const page = await nativeRead(legacy ? 'thread/turns/list' : 'thread/items/list', { threadId, limit: 20, sortDirection: 'asc', ...(legacy ? { itemsView: 'summary' } : {}), ...(cursor ? { cursor } : {}) });
          const entries = legacy ? page.data.flatMap(turn => turn.items.map(item => ({ turnId: turn.id, item }))) : page.data;
          for (const entry of entries) {
            if (res.destroyed) return;
            const item = boundedHistoryItem(entry.item), value = itemText(item);
            const fence = '`'.repeat((value.match(/`+/g) ?? []).reduce((length, run) => Math.max(length, run.length + 1), 3));
            let chunk = previousTurn === entry.turnId ? '' : `## Turn ${entry.turnId}\n\n`; previousTurn = entry.turnId;
            chunk += `### ${item.type}${item._historyTruncated ? ' · 部分输出' : ''}\n\n${fence}\n${value}\n${fence}\n\n`;
            if (!res.write(chunk)) await new Promise((resolve, reject) => {
              const cleanup = () => { res.off('drain', drained); res.off('close', closed); };
              const drained = () => { cleanup(); resolve(); }, closed = () => { cleanup(); reject(error(400, 'ABORTED', '导出已取消。')); };
              res.once('drain', drained); res.once('close', closed);
            });
          }
          cursor = page.nextCursor;
        } while (cursor && !res.destroyed);
        res.end(); return;
      }
      const download = url.pathname.match(/^\/api\/(files|images)\/([A-Za-z0-9_-]{20,64})$/);
      if (req.method === 'GET' && download) {
        const file = await files.openReference(download[2]);
        if (download[1] === 'images' && !file.imageMime) { await file.handle.close(); throw error(404, 'NOT_IMAGE', '此文件不能作为照片预览。'); }
        const name = encodeURIComponent(file.name).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
        res.writeHead(200, { 'Content-Type': download[1] === 'images' ? file.imageMime : 'application/octet-stream',
          'Content-Length': file.size, 'Content-Disposition': `${download[1] === 'images' ? 'inline' : 'attachment'}; filename="download"; filename*=UTF-8''${name}` });
        if (!file.size) { await file.handle.close(); res.end(); }
        else await pipeline(file.handle.createReadStream({ start: 0, end: file.size - 1, autoClose: true }), res);
        return;
      }
      const uploadPath = url.pathname.match(/^\/api\/uploads\/([A-Za-z0-9_-]{20,64})$/);
      if (req.method === 'GET' && uploadPath) { reply(res, 200, await files.describeUpload(uploadPath[1], url.searchParams.get('threadId'))); return; }
      if (req.method === 'PUT' && uploadPath) {
        requireView(url.searchParams.get('viewId'), session);
        req.setTimeout(30_000, () => req.destroy());
        reply(res, 201, await files.receiveUpload(uploadPath[1], req)); return;
      }
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
      if (['/api/project/save', '/api/directory/create'].includes(url.pathname)) throw error(403, 'WORKSPACE_MANAGED_BY_CODEX', '项目和工作目录由 Codex 管理。');
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
      } else if (url.pathname === '/api/project/create') {
        fields(body, ['viewId', 'name', 'rootPath', 'idempotencyKey']); requireView(body.viewId, session);
        if (!text(body.name, 160) || !body.name.trim() || !absolutePath(body.rootPath) || !id(body.idempotencyKey)) throw error(400, 'INVALID_PROJECT', '请输入项目名称、服务器绝对目录和有效操作标识。');
        const metadata = (await codex.rpc('fs/getMetadata', { path: body.rootPath })).result;
        if (!metadata.isDirectory) throw error(400, 'INVALID_DIRECTORY', '请选择服务器上可访问的已有目录。');
        let canonical;
        try { canonical = await realpath(body.rootPath); } catch { throw error(400, 'INVALID_DIRECTORY', '请选择服务器上可访问的已有目录。'); }
        const result = await codex.rpc('project/create', { name: body.name.trim(), roots: [{ path: canonical }], idempotencyKey: body.idempotencyKey });
        reply(res, 200, { project: safe(result.result.project) });
      } else if (url.pathname === '/api/project/archive') {
        fields(body, ['viewId', 'projectId', 'archived']); requireView(body.viewId, session);
        if (!id(body.projectId) || typeof body.archived !== 'boolean') throw error(400, 'INVALID_PROJECT', '请选择项目和归档状态。');
        const project = (await codex.rpc('project/read', { projectId: body.projectId })).result.project;
        const metadata = { ...project.metadata };
        if (body.archived) metadata['codex-console.archived'] = 'true'; else delete metadata['codex-console.archived'];
        // shortcut: native project/update replaces metadata, use a native archive or atomic patch when available.
        const result = await codex.rpc('project/update', { projectId: body.projectId, metadata });
        reply(res, 200, { project: safe(result.result.project) });
      } else if (url.pathname === '/api/project/delete') {
        fields(body, ['viewId', 'projectId', 'confirmed']); requireView(body.viewId, session);
        if (!id(body.projectId) || body.confirmed !== true) throw error(400, 'CONFIRM_REQUIRED', '请确认移除项目登记。');
        await codex.rpc('project/delete', { projectId: body.projectId }); reply(res, 200, {});
      } else if (url.pathname === '/api/completions') {
        fields(body, ['viewId', 'threadId', 'sigil', 'query']); const view = requireView(body.viewId, session), state = chats.get(body.threadId);
        if (view.threadId !== body.threadId || !state?.ready) throw error(403, 'THREAD_NOT_OPEN', '请先打开目标会话。');
        reply(res, 200, await completions(state, body.sigil, body.query));
      } else if (url.pathname === '/api/rpc') {
        fields(body, ['method', 'params']); validateRead(body.method, body.params);
        const epoch = accountEpoch;
        // Old tabs may request full history; never hydrate huge persisted tool outputs for display.
        const params = body.method === 'thread/turns/list' ? { ...body.params, itemsView: 'summary' } : body.params;
        const result = await codex.rpc(body.method, params);
        if (body.method === 'account/rateLimits/read' && epoch !== accountEpoch) throw error(409, 'USAGE_SUPERSEDED', '账号或模型已变化，请重新读取额度。');
        if (body.method === 'thread/turns/list') {
          const turns = structuredClone(result.result.data);
          for (const turn of turns) for (const item of turn.items) item._cursor = result.cursor;
          const thread = chats.get(body.params.threadId)?.thread ?? (await codex.rpc('thread/read', { threadId: body.params.threadId, includeTurns: false })).result.thread;
          const references = await files.issueTranscriptRefs(thread, turns);
          reply(res, 200, { ...result, result: { ...safe(result.result), transcript: renderTranscript(thread, turns, references) } });
        } else reply(res, 200, { ...result, result: safe(result.result) });
      } else if (url.pathname === '/api/uploads') {
        fields(body, ['viewId', 'threadId', 'name', 'size', 'mime']); const view = requireView(body.viewId, session);
        if (!id(body.threadId)) throw error(400, 'INVALID_THREAD', '附件所属会话不正确。');
        if (view.threadId !== body.threadId || !chats.get(body.threadId)?.ready) await codex.rpc('thread/read', { threadId: body.threadId, includeTurns: false });
        reply(res, 201, await files.beginUpload(body));
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
      } else if (url.pathname === '/api/thread/render') {
        fields(body, ['viewId', 'threadId']); const view = requireView(body.viewId, session), state = chats.get(body.threadId);
        if (view.threadId !== body.threadId || !state?.ready) throw error(409, 'RESYNC_REQUIRED', '请先打开会话。');
        const turns = structuredClone(state.turns), thread = structuredClone(state.thread), cursor = state.cursor;
        const references = await files.issueTranscriptRefs(thread, turns);
        reply(res, 200, { kind: 'render', cursor, native: { threadId: body.threadId, items: renderTranscript(thread, turns, references).items } });
      } else if (url.pathname === '/api/thread/history') {
        fields(body, ['viewId', 'threadId', 'cursor']); const view = requireView(body.viewId, session);
        if (!id(body.threadId) || !text(body.cursor) || !body.cursor) throw error(400, 'INVALID_HISTORY', '历史游标不正确。');
        if (view.threadId !== body.threadId) throw error(403, 'THREAD_NOT_OPEN', '请先打开目标会话。');
        const result = await codex.history('items', { threadId: body.threadId, cursor: body.cursor, limit: 20, sortDirection: 'desc' });
        const response = snapshotReply(result), snapshot = response.snapshot;
        const references = await files.issueTranscriptRefs(snapshot.thread, snapshot.initialTurnsPage.data);
        reply(res, 200, { ...response, snapshot: { ...snapshot, transcript: renderTranscript(snapshot.thread, [...snapshot.initialTurnsPage.data].reverse(), references) } });
      } else if (url.pathname === '/api/thread/start') {
        fields(body, ['viewId', 'projectId', 'name']); const view = requireView(body.viewId, session);
        if ((body.projectId != null && !id(body.projectId)) ||
            (body.name != null && (!text(body.name, 160) || !body.name.trim()))) throw error(400, 'INVALID_THREAD', '项目或会话名称不正确。');
        let rootPath = config.workspace ?? config.generatedRoots?.[0];
        if (body.projectId) {
          const { project } = (await codex.rpc('project/read', { projectId: body.projectId })).result;
          rootPath = project.roots?.[0]?.path;
        }
        let cwd;
        try { if (!text(rootPath) || !rootPath.startsWith('/')) throw new Error(); cwd = await realpath(rootPath); if (!(await stat(cwd)).isDirectory()) throw new Error(); }
        catch { throw error(400, 'INVALID_DIRECTORY', 'Codex 项目或默认工作目录不可用。'); }
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
      } else if (url.pathname === '/api/thread/settings') {
        fields(body, ['viewId', 'threadId', 'model', 'effort']); const view = requireView(body.viewId, session);
        if (!id(body.threadId) || view.threadId !== body.threadId) throw error(403, 'THREAD_NOT_OPEN', '请先打开目标会话。');
        if (!text(body.effort, 16) || !body.effort) throw error(400, 'INVALID_EFFORT', '请选择原生支持的思考强度。');
        modelChoice(await nativeModels(), body.model, body.effort);
        await setNextSettings(body.threadId, { model: body.model, effort: body.effort });
        reply(res, 200, { settings: safe(chats.get(body.threadId).settings) });
      } else if (url.pathname === '/api/thread/compact') {
        fields(body, ['viewId', 'threadId']); const view = requireView(body.viewId, session);
        if (!id(body.threadId) || view.threadId !== body.threadId) throw error(403, 'THREAD_NOT_OPEN', '请先打开目标会话。');
        reply(res, 200, await codex.rpc('thread/compact/start', { threadId: body.threadId }));
      } else if (url.pathname === '/api/thread/rename') {
        fields(body, ['viewId', 'threadId', 'name']); requireView(body.viewId, session);
        if (!id(body.threadId)) throw error(400, 'INVALID_THREAD', '会话 ID 不正确。');
        if (!text(body.name, 160) || !body.name.trim()) throw error(400, 'INVALID_NAME', '会话名称须为 1–160 个字符。');
        reply(res, 200, await codex.rpc('thread/name/set', { threadId: body.threadId, name: body.name.trim() }));
      } else if (url.pathname === '/api/thread/archive') {
        fields(body, ['viewId', 'threadId', 'confirmed']); requireView(body.viewId, session);
        if (deleting.has(body.threadId)) throw error(409, 'THREAD_DELETING', '会话正在归档或删除。'); deleting.add(body.threadId);
        try { await removeThread(codex, body, 'thread/archive'); reply(res, 200, {}); } finally { deleting.delete(body.threadId); }
      } else if (url.pathname === '/api/thread/unarchive') {
        fields(body, ['viewId', 'threadId']); requireView(body.viewId, session); if (!id(body.threadId)) throw error(400, 'INVALID_THREAD', '会话 ID 不正确。');
        reply(res, 200, await codex.rpc('thread/unarchive', { threadId: body.threadId }));
      } else if (url.pathname === '/api/thread/fork') {
        fields(body, ['viewId', 'threadId']); const view = requireView(body.viewId, session);
        if (!id(body.threadId) || view.threadId !== body.threadId) throw error(403, 'THREAD_NOT_OPEN', '请先打开目标会话。');
        const result = await codex.rpc('thread/fork', { threadId: body.threadId, excludeTurns: true, deferGoalContinuation: true, approvalPolicy: 'never', sandbox: 'danger-full-access' });
        await codex.rpc('thread/name/set', { threadId: result.result.thread.id, name: [...(result.result.thread.name || '新会话')].slice(0, 150).join('') + ' · 分支' });
        reply(res, 200, await openThread(body.viewId, view, result.result.thread.id));
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
      reply(res, status, { error: { code: e.code ?? 'INTERNAL', message: status === 500 ? '操作失败，请查看服务状态。' : e.message, ...(e.outcome ? { outcome: e.outcome } : {}) } }, [400, 401, 403, 408, 413, 415, 507].includes(status) ? { Connection: 'close' } : {});
    }
  });
  server.requestTimeout = 600_000; server.headersTimeout = 10_000;
  server.on('close', () => { off(); for (const [key, view] of views) releaseView(key, view); for (const value of renderTimers.values()) clearTimeout(value.timer); });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({ options: { config: { type: 'string' } } });
    if (!values.config) throw error(500, 'CONFIG_REQUIRED', '请指定私有配置文件。');
    const config = JSON.parse(readFileSync(values.config, 'utf8'));
    await validateConfig(config, values.config);
    const codex = createCodexClient({ url: config.backendUrl, expectedHome: config.backendHome });
    const server = createWebServer({ config, codex });
    server.listen(config.port, config.listenHost, () => console.log('Codex browser service ready.'));
    server.on('error', () => { codex.close(); process.exitCode = 1; console.error('Browser service could not listen.'); });
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { server.closeAllConnections(); server.close(() => codex.close()); });
  } catch (e) { console.error(`Browser service startup failed (${e.code ?? e.name}).`); process.exitCode = 1; }
}
