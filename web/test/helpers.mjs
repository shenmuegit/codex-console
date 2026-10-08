import { setImmediate as tick } from 'node:timers/promises';
import { createCodexClient } from '../codex.mjs';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import https from 'node:https';
import { createWebServer } from '../server.mjs';
import { hashPassword } from '../auth.mjs';
import { once } from 'node:events';
import { crc32, deflateSync } from 'node:zlib';

export function resumeFixture(id = 'thread-1', turns = []) {
  return {
    thread: {
      id, sessionId: id, forkedFromId: null, parentThreadId: null,
      preview: '', ephemeral: false, section: null, sectionEnteredAt: null,
      projectId: null, historyMode: 'paginated', modelProvider: 'openai',
      model: 'fixture-model', reasoningEffort: 'low', createdAt: 1, updatedAt: 1,
      recencyAt: 1, status: { type: turns.some(t => t.status === 'inProgress') ? 'active' : 'idle', activeFlags: [] },
      path: null, cwd: '/tmp/codex-fixture', cliVersion: '0.0.0', originator: null,
      source: 'vscode', threadSource: null, agentNickname: null, agentRole: null,
      gitInfo: null, name: 'Fixture', turns: [],
    },
    model: 'fixture-model', modelProvider: 'openai', serviceTier: null,
    disabledPluginIds: [], cwd: '/tmp/codex-fixture', runtimeWorkspaceRoots: [],
    instructionSources: [], approvalPolicy: 'never', approvalsReviewer: 'user',
    sandbox: { type: 'dangerFullAccess' }, activePermissionProfile: null,
    reasoningEffort: 'low', collaborationMode: null, multiAgentMode: 'explicitRequestOnly',
    initialTurnsPage: { data: turns, nextCursor: null, backwardsCursor: null },
    turnsBackwardsCursor: null, itemsBackwardsCursor: null,
  };
}

export async function connectedFixture() {
  const sockets = [];
  class FakeSocket extends EventTarget {
    readyState = 0;
    bufferedAmount = 0;
    sent = [];
    constructor(url) {
      super();
      this.url = url;
      sockets.push(this);
      queueMicrotask(() => {
        if (this.readyState !== 0) return;
        this.readyState = 1;
        this.dispatchEvent(new Event('open'));
      });
    }
    send(raw) {
      if (this.readyState !== 1) throw new Error('Closed fixture socket');
      const message = JSON.parse(raw);
      this.sent.push(message);
      if (message.method === 'initialize') queueMicrotask(() => this.emit({
        id: message.id, result: {
          userAgent: 'codex-fixture/0.0.0', platformFamily: 'unix',
          platformOs: 'linux', codexHome: '/tmp/codex-fixture-home',
        },
      }));
    }
    emit(value) {
      this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }));
    }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.dispatchEvent(new Event('close'));
    }
  }
  const original = globalThis.WebSocket;
  let client;
  try {
    globalThis.WebSocket = FakeSocket;
    client = createCodexClient({ url: 'ws://127.0.0.1:4500' });
  } finally { globalThis.WebSocket = original; }
  await tick();
  await tick();
  const peer = {
    get sent() { return sockets.at(-1).sent; },
    get socketCount() { return sockets.length; },
    emit(message) { sockets.at(-1).emit(message); },
    notify(method, params) { this.emit({ method, params }); },
    request(id, method, params) { this.emit({ id, method, params }); },
    replyTo(method, result) {
      const request = this.sent.findLast(m => m.method === method && 'id' in m);
      if (!request) throw new Error(`No native request: ${method}`);
      this.emit({ id: request.id, result });
    },
    errorTo(method, error) {
      const request = this.sent.findLast(m => m.method === method && 'id' in m);
      if (!request) throw new Error(`No native request: ${method}`);
      this.emit({ id: request.id, error });
    },
    disconnect() { sockets.at(-1).close(); },
  };
  return { client, peer, flush: tick };
}

export async function httpsFixture() {
  const native = await connectedFixture();
  const dir = await mkdtemp(join(tmpdir(), 'codex-web-'));
  const tlsKey = join(dir, 'key.pem'), tlsCert = join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256',
    '-nodes', '-keyout', tlsKey, '-out', tlsCert, '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1', '-days', '1'], { stdio: 'ignore' });
  const config = { origin: 'https://127.0.0.1:0', listenHost: '127.0.0.1', port: 0,
    backendUrl: 'ws://127.0.0.1:4500', tlsKey, tlsCert, stateDir: join(dir, 'state'),
    passwordHash: await hashPassword('fixture-passphrase'), generatedRoots: [], uploadLimitBytes: 33_554_432 };
  const server = createWebServer({ config, codex: native.client });
  const eventResponses = [];
  server.on('request', (req, res) => { if (req.url.startsWith('/api/events?')) eventResponses.push(res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  config.origin = `https://127.0.0.1:${server.address().port}`;
  function request(path, { method = 'GET', body, cookie, origin = config.origin, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const req = https.request(config.origin + path, { method, rejectUnauthorized: false,
        headers: { ...(origin === null ? {} : { Origin: origin }), ...(cookie ? { Cookie: cookie } : {}),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers } }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          let json; try { json = JSON.parse(text); } catch {}
          resolve({ status: res.statusCode, headers: res.headers, json, text });
        });
      });
      req.on('error', reject);
      req.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
    });
  }
  async function login() {
    const r = await request('/api/login', { method: 'POST', body: { password: 'fixture-passphrase' } });
    if (r.status !== 200) throw new Error(`Fixture login failed: ${r.status}`);
    return r.headers['set-cookie'][0].split(';')[0];
  }
  function putBytes(path, source, { cookie, headers = {}, origin = config.origin } = {}) {
    return new Promise((resolve, reject) => {
      const req = https.request(config.origin + path, { method: 'PUT', rejectUnauthorized: false,
        headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), 'Content-Type': 'application/octet-stream', ...headers } }, res => {
        const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => {
          try { resolve({ status: res.statusCode, headers: res.headers, json: JSON.parse(Buffer.concat(chunks).toString()) }); } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      (async () => { for await (const chunk of source) if (!req.write(chunk)) await once(req, 'drain'); req.end(); })().catch(e => req.destroy(e));
    });
  }
  async function view(cookie) {
    return (await request('/api/view', { method: 'POST', cookie, body: {} })).json.viewId;
  }
  function events(cookie, viewId, pause = false) {
    return new Promise((resolve, reject) => {
      const req = https.get(config.origin + '/api/events?viewId=' + viewId,
        { rejectUnauthorized: false, headers: { Cookie: cookie, Origin: config.origin } }, res => {
          const chunks = [];
          if (pause) res.pause(); else res.on('data', c => chunks.push(c.toString()));
          const closed = new Promise(done => res.on('close', done));
          resolve({ req, res, chunks, closed, text: () => chunks.join('') });
        });
      req.on('error', reject);
    });
  }
  return { ...native, config, server, request, putBytes, login, view, events, eventResponses, dir,
    async close() {
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      native.client.close(); await rm(dir, { recursive: true, force: true });
    },
    async preferences() { return JSON.parse(await readFile(join(config.stateDir, 'preferences.json'), 'utf8')); },
  };
}

export function tinyPng() {
  const chunk = (type, data) => { const name = Buffer.from(type), size = Buffer.alloc(4), checksum = Buffer.alloc(4);
    size.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(Buffer.concat([name, data]))); return Buffer.concat([size, name, data, checksum]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0]))), chunk('IEND', Buffer.alloc(0))]);
}
