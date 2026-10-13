import { randomUUID } from 'node:crypto';

const endpoint = 'wss://chatgpt.com/backend-api/codex/remote/control/client';
const FRAME_LIMIT = 153_600, CHUNK_BYTES = 102_400, MESSAGE_LIMIT = 33_554_432, ASSEMBLY_LIMIT = 67_108_864;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\s\0]/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const fault = (code, message) => Object.assign(new Error(message), { code });

export function createRemoteRelay({ controller, openWebSocket = (url, headers) => new WebSocket(url, { headers }) }) {
  const streams = new Map();
  let wire, opening, authenticated = false, closed = false, heartbeat, lease, checking = false, session, assemblyBytes = 0;

  function disconnect() {
    const previous = wire; wire = null; authenticated = false;
    clearInterval(heartbeat); clearTimeout(lease); heartbeat = null; lease = null;
    previous?.close(4000, 'Relay connection closed');
    for (const stream of [...streams.values()]) stream.finish(true);
  }
  function send(packet) {
    if (!authenticated || wire?.readyState !== 1) throw fault('RELAY_DISCONNECTED', 'The relay is not connected.');
    if (wire.bufferedAmount > ASSEMBLY_LIMIT) { disconnect(); throw fault('RELAY_BACKPRESSURE', 'The relay cannot accept more data.'); }
    wire.send(JSON.stringify(packet));
  }
  async function ensureOpen() {
    if (authenticated && wire?.readyState === 1) return;
    if (closed) throw fault('RELAY_CLOSED', 'The relay is closed.');
    if (opening) return opening;
    opening = (async () => {
      const metadata = await controller.session();
      if (closed || !streams.size) throw fault('RELAY_CLOSED', 'No relay streams remain.');
      session = metadata;
      const socket = wire = openWebSocket(endpoint, { ...metadata.headers,
        'x-codex-client-id': metadata.enrollment.clientId, 'x-codex-protocol-version': '3' });
      socket.binaryType = 'arraybuffer';
      await new Promise((resolve, reject) => {
        let signed = false, signing = false;
        const timer = setTimeout(() => { reject(fault('RELAY_AUTH_TIMEOUT', 'The relay authentication timed out.')); disconnect(); }, 10_000);
        socket.addEventListener('message', async event => {
          if (wire !== socket) return;
          try {
            const raw = typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8');
            if (Buffer.byteLength(raw) > FRAME_LIMIT) throw new Error();
            const packet = JSON.parse(raw);
            if (!signed) {
              if (signing || packet.type !== 'device_key_challenge') return;
              signing = true;
              const proof = await metadata.signChallenge(packet);
              if (wire !== socket || closed) return;
              socket.send(JSON.stringify(proof)); signed = true; authenticated = true;
              clearTimeout(timer);
              lease = setTimeout(disconnect, Math.max(1000, metadata.tokenExpiresAt * 1000 - Date.now() - 5000));
              lease.unref?.();
              heartbeat = setInterval(async () => {
                if (checking || wire !== socket) return;
                checking = true;
                try {
                  const refreshed = await controller.session();
                  if (wire !== socket) return;
                  if (refreshed.response.remote_control_token !== metadata.response.remote_control_token) { disconnect(); return; }
                  for (const stream of [...streams.values()]) {
                    if (stream.readyState !== 1 || stream.nextClientSeq === 0) continue;
                    if (Date.now() - stream.lastPong > 600_000) { stream.finish(true); continue; }
                    send(stream.envelope('ping', { state: 'foreground', skip_history: true }));
                  }
                } catch { if (wire === socket) disconnect(); } finally { checking = false; }
              }, 30_000); heartbeat.unref?.();
              resolve();
            } else receive(packet);
          } catch {
            clearTimeout(timer); reject(fault('RELAY_PROTOCOL_ERROR', 'The relay authentication or frame was invalid.')); disconnect();
          }
        });
        socket.addEventListener('error', () => {
          clearTimeout(timer); reject(fault('RELAY_DISCONNECTED', 'The relay connection failed.')); if (wire === socket) disconnect();
        });
        socket.addEventListener('close', () => {
          clearTimeout(timer); reject(fault('RELAY_DISCONNECTED', 'The relay connection closed.')); if (wire === socket) disconnect();
        });
      });
    })().catch(error => { disconnect(); throw error; }).finally(() => { opening = null; });
    return opening;
  }
  function receive(packet) {
    if (!object(packet) || packet.client_id !== session.enrollment.clientId || !id(packet.env_id) ||
        !id(packet.stream_id) || !integer(packet.seq_id) || !['ack', 'server_message', 'server_message_chunk', 'pong'].includes(packet.type)) {
      throw fault('RELAY_PROTOCOL_ERROR', 'The relay frame has an invalid identity or type.');
    }
    const stream = streams.get(packet.stream_id);
    if (!stream || stream.envId !== packet.env_id) return;
    if (packet.type === 'ack') return;
    if (stream.lastServerSeq != null && packet.seq_id <= stream.lastServerSeq) return;
    if ((stream.lastServerSeq != null && packet.seq_id !== stream.lastServerSeq + 1) ||
        (stream.assembly && stream.assembly.seq !== packet.seq_id)) { stream.finish(true); return; }
    if (packet.type === 'pong') {
      if (packet.status !== 'active') { stream.finish(true); return; }
      stream.lastPong = Date.now(); stream.lastServerSeq = packet.seq_id; return;
    }
    let message = packet.message;
    if (packet.type === 'server_message_chunk') {
      if (!integer(packet.segment_id) || !integer(packet.segment_count) || packet.segment_count < 2 || packet.segment_count > 1024 ||
          packet.segment_id >= packet.segment_count || !integer(packet.message_size_bytes) || packet.message_size_bytes < 1 ||
          packet.message_size_bytes > MESSAGE_LIMIT || typeof packet.message_chunk_base64 !== 'string' ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(packet.message_chunk_base64)) {
        stream.finish(true); return;
      }
      let assembly = stream.assembly;
      if (!assembly) {
        if (packet.segment_id !== 0) { stream.finish(true); return; }
        stream.assembly = assembly = { seq: packet.seq_id, count: packet.segment_count, size: packet.message_size_bytes, chunks: [], bytes: 0 };
      }
      if (assembly.count !== packet.segment_count || assembly.size !== packet.message_size_bytes || packet.segment_id > assembly.chunks.length) {
        stream.finish(true); return;
      }
      if (packet.segment_id < assembly.chunks.length) return;
      const chunk = Buffer.from(packet.message_chunk_base64, 'base64');
      if (!chunk.length || assembly.bytes + chunk.length > assembly.size || assemblyBytes + chunk.length > ASSEMBLY_LIMIT) {
        stream.finish(true); return;
      }
      assembly.chunks.push(chunk); assembly.bytes += chunk.length; assemblyBytes += chunk.length;
      if (assembly.chunks.length !== assembly.count) return;
      if (assembly.bytes !== assembly.size) { stream.finish(true); return; }
      try { message = JSON.parse(Buffer.concat(assembly.chunks).toString('utf8')); }
      catch { stream.finish(true); return; }
      stream.releaseAssembly();
    }
    if (!object(message)) { stream.finish(true); return; }
    stream.releaseAssembly(); stream.lastServerSeq = packet.seq_id;
    if (message.type === 'error' && !message.method && !Object.hasOwn(message, 'id')) {
      stream.finish(true); return;
    }
    stream.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }));
  }

  class HostSocket extends EventTarget {
    readyState = 0;
    nextClientSeq = 0;
    lastServerSeq = null;
    lastPong = Date.now();
    assembly = null;
    streamId = randomUUID();
    constructor(envId) {
      super(); this.envId = envId; streams.set(this.streamId, this);
      queueMicrotask(async () => {
        try {
          await ensureOpen();
          if (this.readyState !== 0 || closed) return;
          this.readyState = 1; this.dispatchEvent(new Event('open'));
        } catch { this.finish(true); }
      });
    }
    envelope(type, data = {}) {
      return { type, client_id: session.enrollment.clientId, stream_id: this.streamId,
        env_id: this.envId, seq_id: this.nextClientSeq++, ...data };
    }
    send(raw) {
      if (this.readyState !== 1) throw fault('RELAY_DISCONNECTED', 'The host stream is not connected.');
      if (typeof raw !== 'string' || Buffer.byteLength(raw) > MESSAGE_LIMIT) throw fault('RELAY_MESSAGE_LIMIT', 'The host message exceeds the size limit.');
      const message = JSON.parse(raw);
      if (!object(message)) throw fault('RELAY_INVALID_RPC', 'Send a JSON-RPC object.');
      const packet = this.envelope('client_message', { skip_history: false, message });
      if (Buffer.byteLength(JSON.stringify(packet)) <= CHUNK_BYTES) { send(packet); return; }
      const body = Buffer.from(JSON.stringify(message)), count = Math.max(2, Math.ceil(body.length / CHUNK_BYTES)), size = Math.ceil(body.length / count);
      for (let index = 0; index < count; ++index) {
        const { message, ...metadata } = packet;
        const chunk = { ...metadata, type: 'client_message_chunk', segment_id: index, segment_count: count,
          message_size_bytes: body.length, message_chunk_base64: body.subarray(index * size, (index + 1) * size).toString('base64') };
        if (Buffer.byteLength(JSON.stringify(chunk)) > FRAME_LIMIT) throw fault('RELAY_MESSAGE_LIMIT', 'The relay chunk exceeds its size limit.');
        send(chunk);
      }
    }
    releaseAssembly() { if (this.assembly) { assemblyBytes -= this.assembly.bytes; this.assembly = null; } }
    finish(error = false) {
      if (this.readyState === 3) return;
      this.readyState = 3; this.releaseAssembly(); streams.delete(this.streamId);
      if (error) this.dispatchEvent(new Event('error'));
      this.dispatchEvent(new Event('close'));
      if (!streams.size) disconnect();
    }
    close() {
      if (this.readyState === 3) return;
      if (this.readyState === 1 && authenticated && this.nextClientSeq > 0) {
        try { send(this.envelope('client_closed')); } catch {}
      }
      this.finish();
    }
  }
  return {
    openHost(envId) {
      if (!id(envId) || closed) throw fault('INVALID_REMOTE_HOST', 'Select an available controlled host.');
      return new HostSocket(envId);
    },
    close() { if (!closed) { closed = true; disconnect(); } },
  };
}
