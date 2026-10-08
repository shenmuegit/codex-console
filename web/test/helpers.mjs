import { setImmediate as tick } from 'node:timers/promises';
import { createCodexClient } from '../codex.mjs';

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
