import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, stat, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, sign, verify, createPublicKey, createHash } from 'node:crypto';
import { createRemoteController } from '../remote-controller.mjs';

export const jwt = claims => ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'fixture-signature'].join('.');
export const accessClaims = (account = 'workspace-one', owner = 'owner-one') => ({ exp: Date.now() / 1000 + 3600,
  'https://api.openai.com/auth': { account_id: account, account_user_id: owner, user_id: 'login-user' } });
export const stepUpClaims = () => ({ ...accessClaims(), scope: 'codex.remote_control.enroll',
  iat: Date.now() / 1000, pwd_auth_time: Date.now() });

export async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'codex-controller-test-'));
  const authFile = join(root, 'auth.json'), stateDir = join(root, 'state'), calls = [], keys = new Map();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(authFile, JSON.stringify({ tokens: { account_id: 'workspace-one', access_token: jwt(accessClaims()) } }), { mode: 0o600 });
  let serial = 0, tokenSerial = 0, signs = 0, deletes = 0;
  const deviceKey = {
    async createDeviceKey(policy) {
      assert.equal(policy, 'allow_os_protected_nonextractable');
      const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const record = { keyId: `fixture-key-${++serial}`, algorithm: 'ecdsa_p256_sha256', protectionClass: 'hardware_tpm',
        publicKeySpkiDerBase64: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
      keys.set(record.keyId, { ...pair, record }); return record;
    },
    async getDeviceKeyPublic(id) { const key = keys.get(id); if (!key) throw new Error('Fixture key absent'); return key.record; },
    async signDeviceKey(id, message) { ++signs; return { algorithm: 'ecdsa_p256_sha256', signatureDerBase64: sign('sha256', message, keys.get(id).privateKey).toString('base64') }; },
    async deleteDeviceKey(id) { ++deletes; keys.delete(id); },
  };
  const challenge = (path, refresh = false) => ({ type: 'device_key_challenge', purpose: 'remote_control_client_enrollment',
    audience: 'remote_control_client_enrollment', account_user_id: 'owner-one', client_id: 'server-created-client',
    nonce: Buffer.alloc(32, 7).toString('base64url'), challenge_id: 'fixture-challenge', challenge_expires_at: Math.floor(Date.now() / 1000) + 600,
    target_origin: 'https://chatgpt.com', target_path: '/backend-api' + path, challenge_token: 'fixture-challenge-token',
    device_identity_hash: refresh ? (() => {
      const r = keys.values().next().value.record;
      return createHash('sha256').update(JSON.stringify({ algorithm: r.algorithm, keyId: r.keyId,
        protectionClass: r.protectionClass, publicKeySpkiDerBase64: r.publicKeySpkiDerBase64 })).digest('base64url');
    })() : null,
    ...(options.challenge ?? {}) });
  function checkProof(body, path) {
    const proof = body.device_key_proof;
    const payload = Buffer.from(proof.signed_payload_base64, 'base64');
    const decoded = JSON.parse(payload);
    const key = keys.get(proof.key_id);
    assert(verify('sha256', payload, key.publicKey, Buffer.from(proof.signature_der_base64, 'base64')));
    assert.equal(decoded.domain, 'codex-device-key-sign-payload/v1');
    assert.equal(decoded.payload.type, 'remoteControlClientEnrollment');
    assert.equal(decoded.payload.accountUserId, 'owner-one');
    assert.equal(decoded.payload.clientId, 'server-created-client');
    assert.equal(decoded.payload.targetOrigin, 'https://chatgpt.com');
    assert.equal(decoded.payload.targetPath, '/backend-api' + path);
    assert.equal(decoded.payload.nonce, Buffer.alloc(32, 7).toString('base64url'));
    assert.deepEqual(Object.keys(decoded.payload), ['accountUserId', 'audience', 'challengeExpiresAt', 'challengeId',
      'clientId', 'deviceIdentitySha256Base64url', 'nonce', 'targetOrigin', 'targetPath', 'type']);
    assert.equal(proof.challenge_token, 'fixture-challenge-token');
  }
  const fetch = async (value, request = {}) => {
    const url = new URL(value), body = request.body ? (url.pathname === '/oauth/token' ? Object.fromEntries(new URLSearchParams(request.body)) : JSON.parse(request.body)) : null;
    calls.push({ url: url.href, method: request.method ?? 'GET', body, headers: request.headers });
    assert.equal(request.redirect, 'error');
    if (url.origin === 'https://auth.openai.com' && url.pathname === '/oauth/token') {
      return Response.json({ access_token: jwt(options.stepUp ?? stepUpClaims()) });
    }
    assert.equal(url.origin, 'https://chatgpt.com');
    assert.equal(request.headers['ChatGPT-Account-Id'], 'workspace-one');
    if (url.pathname.endsWith('/client/enroll/start')) return Response.json({ client_id: 'server-created-client', account_user_id: 'owner-one', device_key_challenge: challenge('/codex/remote/control/client/enroll/finish') });
    if (url.pathname.endsWith('/client/refresh/start')) return Response.json({ client_id: 'server-created-client', account_user_id: 'owner-one', device_key_challenge: challenge('/codex/remote/control/client/refresh/finish', true) });
    if (url.pathname.endsWith('/client/enroll/finish') || url.pathname.endsWith('/client/refresh/finish')) {
      checkProof(body, url.pathname.replace('/backend-api', ''));
      await options.beforeFinish?.({ stateDir });
      return Response.json({ client_id: 'server-created-client', account_user_id: 'owner-one',
        expires_at: new Date(Date.now() + 600_000).toISOString(), scopes: ['remote_control_controller_websocket'],
        remote_control_token: `fixture-relay-token-${++tokenSerial}`, ...(options.session ?? {}) });
    }
    if (url.pathname === '/backend-api/wham/remote/control/client/pair') return Response.json({ environment_id: 'host-one' });
    if (url.pathname.endsWith('/clients/server-created-client/environments')) return Response.json({ items: [
      { env_id: 'host-one', display_name: 'Laptop', host_name: 'pc', private_field: 'must-not-reach-browser' }], cursor: null });
    if (request.method === 'DELETE' && url.pathname.endsWith('/clients/server-created-client')) return new Response(null, { status: 204 });
    assert.fail('Unexpected official endpoint: ' + url.pathname);
  };
  const controller = await createRemoteController({ authFile, stateDir, deviceKey, fetch });
  t.after(() => controller.close());
  async function authorize(instance = controller) {
    const attempt = await instance.startAuthorization();
    const returned = new URL(attempt.redirectUri);
    returned.searchParams.set('state', new URL(attempt.url).searchParams.get('state'));
    returned.searchParams.set('code', 'approved-on-browser');
    instance.submitCallback(returned.href);
    return attempt.completion;
  }
  return { root, authFile, stateDir, calls, keys, deviceKey, fetch, controller, authorize,
    get created() { return serial; }, get signed() { return signs; }, get deleted() { return deletes; } };
}

