import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, stat, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, sign, verify, createPublicKey, createHash } from 'node:crypto';
import { createRemoteController } from '../remote-controller.mjs';

const jwt = claims => ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'fixture-signature'].join('.');
const accessClaims = (account = 'workspace-one', owner = 'owner-one') => ({ exp: Date.now() / 1000 + 3600,
  'https://api.openai.com/auth': { account_id: account, account_user_id: owner, user_id: 'login-user' } });
const stepUpClaims = () => ({ ...accessClaims(), scope: 'codex.remote_control.enroll',
  iat: Date.now() / 1000, pwd_auth_time: Date.now() });

async function fixture(t, options = {}) {
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

test('host codes cannot be claimed using a pending or absent controller identity', async t => {
  const f = await fixture(t);
  assert.equal((await f.controller.status()).enrolled, false);
  await assert.rejects(f.controller.pair('abcd1234'), { code: 'CONTROLLER_NOT_ENROLLED' });
  assert.equal(f.calls.length, 0);
  assert.equal(f.created, 0);
});

test('server enrollment signs its own challenge, atomically persists private state, and claims a host code', async t => {
  const f = await fixture(t);
  const originalAuth = await readFile(f.authFile, 'utf8');
  await f.authorize();
  const saved = JSON.parse(await readFile(join(f.stateDir, 'enrollment.json'), 'utf8'));
  assert.equal(saved.enrollment.clientId, 'server-created-client');
  assert.equal(saved.accountId, 'workspace-one');
  assert.equal((await stat(join(f.stateDir, 'enrollment.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(f.stateDir)).mode & 0o777, 0o700);
  await assert.rejects(access(join(f.stateDir, 'pending.json')));
  const state = await f.controller.status();
  assert.equal(state.enrolled, true);
  assert.equal(state.phase, 'ready');
  assert(!JSON.stringify(state).includes('fixture-relay-token'));
  assert(!JSON.stringify(state).includes('fixture-key'));
  assert.deepEqual(await f.controller.pair('aBcD1234'), { environmentId: 'host-one' });
  assert.deepEqual(f.calls.find(call => call.url.endsWith('/wham/remote/control/client/pair')).body,
    { client_id: 'server-created-client', manual_pairing_code: 'ABCD-1234' });
  assert.deepEqual(await f.controller.listHosts(), [{ id: 'host-one', name: 'Laptop', hostName: 'pc' }]);
  assert.equal(await readFile(f.authFile, 'utf8'), originalAuth);
  assert.equal(f.keys.size, 1);
});

test('wrong challenge account, client, purpose, target, nonce, and expiration fail before signing', async t => {
  for (const challenge of [{ account_user_id: 'different-owner' }, { client_id: 'another-client' },
    { purpose: 'another-purpose' }, { audience: 'another-audience' }, { target_origin: 'https://example.com' },
    { target_path: '/other' }, { nonce: 'short' }, { challenge_expires_at: 1 }]) {
    const f = await fixture(t, { challenge });
    await assert.rejects(f.controller.startAuthorization(), { code: 'INVALID_CHALLENGE' });
    assert.equal(f.signed, 0);
    assert.equal(f.keys.size, 0);
    assert.equal(f.calls.filter(call => call.method === 'DELETE').length, 1);
  }
});

test('wrong owner, scope, and stale or future account reauthentication cannot enroll a key', async t => {
  for (const stepUp of [{ ...stepUpClaims(), scope: 'openid' }, { ...stepUpClaims(), pwd_auth_time: Date.now() - 600_000 },
    { ...stepUpClaims(), iat: Date.now() / 1000 - 600 }, { ...stepUpClaims(), iat: Date.now() / 1000 + 600 },
    { ...stepUpClaims(), 'https://api.openai.com/auth': { account_user_id: 'different-owner' } }]) {
    const f = await fixture(t, { stepUp });
    await assert.rejects(f.authorize(), error => error.code === 'INVALID_STEP_UP');
    assert.equal(f.signed, 0);
    assert.equal(f.keys.size, 0);
    assert.equal((await f.controller.status()).enrolled, false);
    assert.equal(f.calls.filter(call => call.method === 'DELETE').length, 1);
  }
});

test('disk failure cannot leave a registered identity while deleting its key and cleanup still removes its pending client', async t => {
  const f = await fixture(t, { beforeFinish: async ({ stateDir }) => {
    await rm(stateDir, { recursive: true }); await writeFile(stateDir, 'blocking-file', { mode: 0o600 });
  } });
  await assert.rejects(f.authorize(), { code: 'STATE_WRITE_FAILED' });
  assert.equal(f.keys.size, 0);
  assert.equal(f.calls.filter(call => call.method === 'DELETE').length, 1);
  await assert.rejects(access(join(f.stateDir, 'enrollment.json')));
});

test('key cleanup failure cannot prevent remote cleanup and leaves only an owned retry marker', async t => {
  const f = await fixture(t, { stepUp: { ...stepUpClaims(), scope: 'openid' } });
  f.deviceKey.deleteDeviceKey = async () => { throw new Error('private-key-operation-detail'); };
  await assert.rejects(f.authorize(), { code: 'INVALID_STEP_UP' });
  assert.equal(f.calls.filter(call => call.method === 'DELETE').length, 1);
  const status = await f.controller.status();
  assert.equal(status.enrolled, false);
  assert.equal(status.phase, 'cleanupRequired');
  assert(!JSON.stringify(status).includes('private-key-operation-detail'));
  assert.equal((await stat(join(f.stateDir, 'pending.json'))).mode & 0o777, 0o600);
});

test('restarting refreshes an expired session with the original key and cannot borrow a missing or mismatched key', async t => {
  const f = await fixture(t);
  await f.authorize(); await f.controller.close();
  const path = join(f.stateDir, 'enrollment.json');
  const saved = JSON.parse(await readFile(path, 'utf8'));
  saved.session.expires_at = '2000-01-01T00:00:00Z';
  await writeFile(path, JSON.stringify(saved), { mode: 0o600 });
  const restarted = await createRemoteController({ authFile: f.authFile, stateDir: f.stateDir, deviceKey: f.deviceKey, fetch: f.fetch });
  t.after(() => restarted.close());
  const session = await restarted.session();
  assert.equal(session.response.remote_control_token, 'fixture-relay-token-2');
  assert.equal(f.created, 1);
  const actual = f.keys.values().next().value;
  const pub = actual.record.publicKeySpkiDerBase64;
  actual.record.publicKeySpkiDerBase64 = 'mismatched-key';
  await assert.rejects(restarted.pair('ABCD-1234'), { code: 'DEVICE_KEY_UNAVAILABLE' });
  actual.record.publicKeySpkiDerBase64 = pub;
  f.keys.clear();
  await assert.rejects(restarted.session(), { code: 'DEVICE_KEY_UNAVAILABLE' });
  assert.equal(JSON.parse(await readFile(path, 'utf8')).enrollment.keyId, saved.enrollment.keyId);
});

test('an account change preserves saved enrollment and prevents code claiming', async t => {
  const f = await fixture(t); await f.authorize();
  const path = join(f.stateDir, 'enrollment.json'), before = await readFile(path, 'utf8');
  await writeFile(f.authFile, JSON.stringify({ tokens: { account_id: 'workspace-two', access_token: jwt(accessClaims('workspace-two', 'owner-two')) } }), { mode: 0o600 });
  await assert.rejects(f.controller.pair('ABCD-1234'), { code: 'ACCOUNT_CHANGED' });
  assert.equal(await readFile(path, 'utf8'), before);
  assert.equal(f.keys.size, 1);
  assert.equal((await f.controller.status()).enrolled, false);
});

test('an invalid device signature never reaches enrollment finish', async t => {
  const f = await fixture(t);
  f.deviceKey.signDeviceKey = async () => ({ algorithm: 'ecdsa_p256_sha256', signatureDerBase64: Buffer.alloc(64).toString('base64') });
  await assert.rejects(f.authorize(), { code: 'INVALID_DEVICE_PROOF' });
  assert.equal(f.calls.filter(call => call.url.endsWith('/client/enroll/finish')).length, 0);
  assert.equal(f.keys.size, 0);
});

test('a concurrently created enrollment file is preserved instead of overwritten', async t => {
  const f = await fixture(t, { beforeFinish: async ({ stateDir }) =>
    writeFile(join(stateDir, 'enrollment.json'), '{"foreign":"preserve"}', { mode: 0o600 }) });
  await assert.rejects(f.authorize(), { code: 'STATE_WRITE_FAILED' });
  assert.equal(await readFile(join(f.stateDir, 'enrollment.json'), 'utf8'), '{"foreign":"preserve"}');
  assert.equal(f.keys.size, 0);
});

test('an unexpected relay session identity or scope cannot be saved as enrolled', async t => {
  for (const session of [{ client_id: 'another-client' }, { account_user_id: 'another-owner' },
    { scopes: ['other-scope'] }, { expires_at: '2000-01-01T00:00:00Z' }]) {
    const f = await fixture(t, { session });
    await assert.rejects(f.authorize(), { code: 'INVALID_RELAY_SESSION' });
    assert.equal(f.keys.size, 0);
    await assert.rejects(access(join(f.stateDir, 'enrollment.json')));
  }
});

test('concurrent setup clicks create only one candidate and closing cancels and cleans that candidate', async t => {
  const f = await fixture(t);
  const outcomes = await Promise.allSettled([f.controller.startAuthorization(), f.controller.startAuthorization()]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find(result => result.status === 'rejected').reason.code, 'AUTH_IN_PROGRESS');
  assert.equal(f.created, 1);
  assert.equal(f.calls.filter(call => call.url.endsWith('/client/enroll/start')).length, 1);
  await f.controller.close();
  assert.equal(f.keys.size, 0);
  assert.equal(f.calls.filter(call => call.method === 'DELETE').length, 1);
  await assert.rejects(access(join(f.stateDir, 'pending.json')));
});

test('a competing controller instance cannot delete a candidate while its owner is authorizing', async t => {
  const f = await fixture(t);
  await f.controller.startAuthorization();
  const second = await createRemoteController({ authFile: f.authFile, stateDir: f.stateDir, deviceKey: f.deviceKey, fetch: f.fetch });
  t.after(() => second.close());
  await assert.rejects(second.startAuthorization(), { code: 'AUTH_IN_PROGRESS' });
  assert.equal(f.keys.size, 1);
  assert.equal(f.calls.filter(call => call.method === 'DELETE').length, 0);
});
