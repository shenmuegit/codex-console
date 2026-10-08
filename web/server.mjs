import https from 'node:https';
import { readFileSync, mkdirSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { parseArgs, isDeepStrictEqual } from 'node:util';
import { createAuth, checkOrigin } from './auth.mjs';
import { createCodexClient } from './codex.mjs';

const BODY_LIMIT = 1_048_576, STREAM_LIMIT = 1_048_576;
const COOKIE = '__Host-codex_console';
const publicDir = join(dirname(fileURLToPath(import.meta.url)), 'public');
const assets = new Map([['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']], ['/styles.css', ['styles.css', 'text/css; charset=utf-8']]]);
const error = (status, code, message) => Object.assign(new Error(message), { status, code });
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (v, max = 8192) => typeof v === 'string' && v.length <= max && !v.includes('\0');
const id = v => text(v, 128) && /^[A-Za-z0-9_-]+$/.test(v);
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
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 }); chmodSync(config.stateDir, 0o700);
  const prefsPath = join(config.stateDir, 'preferences.json');
  if (!existsSync(prefsPath)) writeFileSync(prefsPath, JSON.stringify({ archivedProjectIds: [], ui: {} }), { mode: 0o600 });
  chmodSync(prefsPath, 0o600);
  let checkpoint = { generation: codex.status().generation, seq: 0 };
  const reply = (res, status, value, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers }); res.end(JSON.stringify(value));
  };
  const publicStatus = () => ({ online: codex.status().online, generation: codex.status().generation });
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
  }
  function broadcast(event) {
    for (const view of views.values()) for (const res of view.streams) writeEvent(res, event);
  }
  const off = codex.onEvent(event => {
    checkpoint = event.cursor;
    if (event.kind === 'status') {
      pending.clear();
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
      broadcast({ ...event, native });
    } else if (event.kind === 'snapshot') broadcast({ ...event, native: safe(event.native) });
    else if (/^(thread\/|turn\/|item\/|project\/|account\/rateLimits\/)/.test(event.native?.method) ||
             ['warning', 'error', 'serverRequest/resolved', 'account/updated'].includes(event.native?.method)) {
      if (event.native.method === 'serverRequest/resolved') {
        // The native client also invalidates its original request ID; HTTP races then return 409.
        for (const [key] of pending) if (key === `${checkpoint.generation}:${JSON.stringify(event.native.params.requestId)}`) pending.delete(key);
      }
      broadcast({ ...event, native: safe(event.native) });
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
          if (!view.streams.size && view.threadId) { const previous = view.threadId; view.threadId = null; codex.releaseThread(previous, url.searchParams.get('viewId')).catch(() => {}); }
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
        const result = await codex.rpc(body.method, body.params); reply(res, 200, { ...result, result: safe(result.result) });
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
  server.on('close', () => { off(); for (const [key, view] of views) releaseView(key, view); });
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
