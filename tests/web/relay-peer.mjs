import http from 'node:http';
import { createHash, verify } from 'node:crypto';
import assert from 'node:assert/strict';

function frame(body, opcode = 1) {
  const bytes = Buffer.from(body), header = Buffer.alloc(bytes.length < 126 ? 2 : bytes.length < 65536 ? 4 : 10);
  header[0] = 0x80 | opcode;
  if (header.length === 2) header[1] = bytes.length;
  else if (header.length === 4) { header[1] = 126; header.writeUInt16BE(bytes.length, 2); }
  else { header[1] = 127; header.writeBigUInt64BE(BigInt(bytes.length), 2); }
  return Buffer.concat([header, bytes]);
}

/** Real local WebSocket peer; only the OpenAI service is replaced. */
export async function relayPeer(t, { session, key, challenge: changed = {} }) {
  const sockets = new Set(), messages = [], headers = [], sequences = new Map();
  const server = http.createServer();
  let proofCount = 0, onMessage = () => {}, current;
  const send = value => current.write(frame(JSON.stringify(value)));
  const reply = (request, message) => {
    const id = request.stream_id, seq = sequences.get(id) ?? 0; sequences.set(id, seq + 1);
    send({ type: 'server_message', client_id: session.enrollment.clientId, stream_id: id, env_id: request.env_id,
      seq_id: seq, cursor: `cursor-${seq}`, message });
  };
  server.on('upgrade', (request, socket) => {
    current = socket; sockets.add(socket); headers.push(request.headers);
    const accepted = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accepted + '\r\n\r\n');
    let buffered = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 2) {
        const opcode = buffered[0] & 0x0f; let size = buffered[1] & 0x7f, start = 2;
        if (size === 126) { if (buffered.length < 4) return; size = buffered.readUInt16BE(2); start = 4; }
        else if (size === 127) { if (buffered.length < 10) return; size = Number(buffered.readBigUInt64BE(2)); start = 10; }
        const maskSize = buffered[1] & 0x80 ? 4 : 0;
        if (buffered.length < start + maskSize + size) return;
        const mask = buffered.subarray(start, start + maskSize), body = Buffer.from(buffered.subarray(start + maskSize, start + maskSize + size));
        for (let i = 0; maskSize && i < body.length; ++i) body[i] ^= mask[i % 4];
        buffered = buffered.subarray(start + maskSize + size);
        if (opcode === 8) { socket.end(frame(body, 8)); continue; }
        if (opcode !== 1) continue;
        const packet = JSON.parse(body); messages.push(packet);
        if (packet.type === 'device_key_proof') {
          assert(verify('sha256', Buffer.from(packet.signedPayloadBase64, 'base64'), key,
            Buffer.from(packet.signatureDerBase64, 'base64'))); ++proofCount;
        } else { assert(proofCount > 0, 'Host RPC must follow device authentication'); onMessage(packet); }
      }
    });
    socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
    socket.write(frame(JSON.stringify({ type: 'device_key_challenge', purpose: 'remote_control_client_websocket',
      audience: 'remote_control_client_websocket', accountUserId: session.enrollment.accountUserId, clientId: session.enrollment.clientId,
      sessionId: 'fixture-relay-session', nonce: Buffer.alloc(32, 9).toString('base64url'), targetOrigin: 'https://chatgpt.com',
      targetPath: '/backend-api/codex/remote/control/client', tokenExpiresAt: session.tokenExpiresAt,
      tokenSha256Base64url: createHash('sha256').update(session.response.remote_control_token).digest('base64url'),
      scopes: ['remote_control_controller_websocket'], ...changed })));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); return new Promise(resolve => server.close(resolve)); });
  return { messages, headers, send, reply, get proofCount() { return proofCount; },
    onMessage(handler) { onMessage = handler; },
    openWebSocket(_url, headers) { return new WebSocket(`ws://127.0.0.1:${server.address().port}`, { headers }); },
    disconnect() { for (const socket of sockets) socket.destroy(); },
  };
}
