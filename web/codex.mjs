const fault = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });

export function backendEndpoint(url) {
  let endpoint;
  try {
    endpoint = new URL(url);
    if (endpoint.protocol !== 'ws:' || !['127.0.0.1', '[::1]'].includes(endpoint.hostname) ||
        !endpoint.port || Number(endpoint.port) < 1 || endpoint.username || endpoint.password || endpoint.pathname !== '/' ||
        endpoint.search || endpoint.hash) throw new Error();
  } catch { throw fault('INVALID_BACKEND_URL', 'Configure a loopback ws:// address with an explicit port.'); }
  return endpoint;
}

/** One native connection; results carry the cursor of their upstream response frame. */
export function createCodexClient({ url, expectedHome }) {
  const endpoint = backendEndpoint(url);

  const Socket = globalThis.WebSocket;
  const pending = new Map(), requests = new Map(), threads = new Map(), listeners = new Set();
  let socket, closed = false, online = false, generation = 0, seq = 0, serial = 0;
  let opening, retry, backoff = 500;
  const cursor = () => ({ generation, seq });
  const status = () => ({ online, generation, endpoint: endpoint.href });
  const emit = event => {
    for (const listener of listeners) {
      try { listener(event); } catch { /* A failed consumer must not break native frame ordering. */ }
    }
  };

  function send(method, params, initializing = false) {
    if ((!online && !initializing) || socket?.readyState !== 1) {
      return Promise.reject(fault('NATIVE_DISCONNECTED', 'The native backend is offline.', { outcome: 'not-sent' }));
    }
    const id = `${generation}:${++serial}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(fault('NATIVE_TIMEOUT', 'The native reply timed out; reconcile before retrying.', { outcome: 'unknown' }));
      }, 30_000);
      pending.set(id, { resolve, reject, timer, method, params });
      try { socket.send(JSON.stringify({ id, method, params })); }
      catch {
        clearTimeout(timer); pending.delete(id);
        reject(fault('NATIVE_DISCONNECTED', 'Sending failed; reconcile before retrying.', { outcome: 'unknown' }));
      }
    });
  }

  function unsubscribe(threadId, entry) {
    if (entry.views.size || entry.activeTurnId || entry.releasing) return entry.releasing;
    if (entry.resumes.size) return Promise.allSettled([...entry.resumes]).then(() => unsubscribe(threadId, entry));
    if (!online) { threads.delete(threadId); return; }
    entry.releasing = send('thread/unsubscribe', { threadId }).finally(() => {
      entry.releasing = null;
      if (!entry.views.size && !entry.activeTurnId && threads.get(threadId) === entry) threads.delete(threadId);
    });
    return entry.releasing;
  }

  function resume(threadId) {
    const entry = threads.get(threadId);
    const operation = send('thread/resume', { threadId, excludeTurns: true,
      initialTurnsPage: { limit: 20, sortDirection: 'desc', itemsView: 'full' } })
      .finally(() => entry?.resumes.delete(operation));
    entry?.resumes.add(operation);
    return operation;
  }

  function receive(raw) {
    let native;
    try { native = JSON.parse(raw); } catch { socket.close(); return; }
    ++seq;
    const checkpoint = cursor();
    if (Object.hasOwn(native, 'id') && !native.method) {
      const call = pending.get(native.id);
      if (!call) return;
      pending.delete(native.id); clearTimeout(call.timer);
      if (native.error) {
        call.reject(fault(native.error.code, native.error.message, { data: native.error.data }));
        return;
      }
      if (call.method === 'thread/resume') {
        const threadId = native.result.thread.id;
        const entry = threads.get(threadId);
        if (entry) entry.activeTurnId = (native.result.initialTurnsPage?.data ?? native.result.thread.turns ?? [])
          .find(turn => turn.status === 'inProgress')?.id ?? null;
        // Install the atomic native history checkpoint before any later delta or RPC awaiter.
        emit({ kind: 'snapshot', cursor: checkpoint, threadId, native: native.result });
      }
      call.resolve({ result: native.result, cursor: checkpoint });
      return;
    }
    if (!native.method) return;
    const p = native.params ?? {}, entry = threads.get(p.threadId);
    if (native.method === 'turn/started' && entry) entry.activeTurnId = p.turn.id;
    if (native.method === 'turn/completed' && entry?.activeTurnId === p.turn.id) {
      entry.activeTurnId = null;
      unsubscribe(p.threadId, entry)?.catch(() => {});
    }
    if (native.method === 'serverRequest/resolved') {
      for (const [key, request] of requests) if (request.id === p.requestId) requests.delete(key);
    }
    if (Object.hasOwn(native, 'id')) {
      const requestKey = `${generation}:${JSON.stringify(native.id)}`;
      requests.set(requestKey, { id: native.id, generation });
      emit({ kind: 'request', cursor: checkpoint, requestKey, native });
    } else emit({ kind: 'notification', cursor: checkpoint, native });
  }

  function connect() {
    if (closed) return;
    ++generation; seq = 0;
    const connection = socket = new Socket(endpoint.href);
    opening = setTimeout(() => connection.close(), 10_000);
    connection.addEventListener('open', async () => {
      try {
        const initialized = await send('initialize', { clientInfo: { name: 'codex-console-web', title: 'Codex Console', version: '0.1.0' },
          capabilities: { experimentalApi: true } }, true);
        if (expectedHome && initialized.result.codexHome !== expectedHome) { connection.close(); return; }
        if (socket !== connection || connection.readyState !== 1 || closed) return;
        connection.send(JSON.stringify({ method: 'initialized', params: {} }));
        clearTimeout(opening); online = true; backoff = 500;
        emit({ kind: 'status', cursor: cursor(), native: status() });
        for (const [threadId, entry] of threads) {
          if (entry.views.size || entry.activeTurnId) resume(threadId).catch(() => {});
        }
      } catch { connection.close(); }
    });
    connection.addEventListener('message', event => {
      if (socket === connection && !closed) receive(event.data);
    });
    connection.addEventListener('error', () => connection.close());
    connection.addEventListener('close', () => {
      if (socket !== connection) return;
      clearTimeout(opening); online = false; requests.clear();
      for (const call of pending.values()) {
        clearTimeout(call.timer);
        call.reject(fault('NATIVE_DISCONNECTED', 'Connection lost; reconcile before retrying.', { outcome: 'unknown' }));
      }
      pending.clear();
      emit({ kind: 'status', cursor: cursor(), native: status() });
      if (!closed) {
        retry = setTimeout(connect, Math.min(10_000, backoff * (1 + Math.random() * 0.2)));
        retry.unref?.(); backoff = Math.min(10_000, backoff * 2);
      }
    });
  }

  connect();
  return {
    rpc: send, status,
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    retainThread(threadId, viewId) {
      let entry = threads.get(threadId);
      if (!entry) threads.set(threadId, entry = { views: new Set(), activeTurnId: null, releasing: null, resumes: new Set() });
      entry.views.add(viewId);
      return entry.releasing ? entry.releasing.catch(() => {}).then(() => resume(threadId)) : resume(threadId);
    },
    async releaseThread(threadId, viewId) {
      const entry = threads.get(threadId);
      if (!entry) return;
      entry.views.delete(viewId);
      await unsubscribe(threadId, entry);
    },
    async respond(requestKey, answer) {
      const request = requests.get(requestKey);
      if (!request || request.generation !== generation || !online) throw fault('STALE_NATIVE_REQUEST', 'This native request is no longer pending.');
      requests.delete(requestKey);
      socket.send(JSON.stringify({ id: request.id,
        ...(Object.hasOwn(answer, 'error') ? { error: answer.error } : { result: answer.result }) }));
    },
    close() {
      closed = true; clearTimeout(opening); clearTimeout(retry);
      socket?.close(); listeners.clear();
    },
  };
}
