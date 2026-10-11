import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, stat, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, verify } from 'node:crypto';
import { createRemoteController } from '../remote-controller.mjs';
import { fixture, jwt, accessClaims, stepUpClaims } from './remote-controller-fixture.mjs';

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

test('relay proof is bound to the enrolled server, session token, target, expiration, and scopes', async t => {
  const f = await fixture(t); await f.authorize();
  const session = await f.controller.session();
  assert.equal(typeof session.signChallenge, 'function');
  assert.match(session.headers.Authorization, /^Bearer e30\./);
  assert.equal(session.headers['ChatGPT-Account-Id'], 'workspace-one');
  assert.equal(session.headers['x-codex-client-session-token'], 'Bearer fixture-relay-token-1');
  const challenge = { type: 'device_key_challenge', purpose: 'remote_control_client_websocket', audience: 'remote_control_client_websocket',
    sessionId: 'relay-session-one', targetOrigin: 'https://chatgpt.com', targetPath: '/backend-api/codex/remote/control/client',
    accountUserId: 'owner-one', clientId: 'server-created-client', nonce: Buffer.alloc(32, 9).toString('base64url'),
    tokenSha256Base64url: createHash('sha256').update('fixture-relay-token-1').digest('base64url'),
    tokenExpiresAt: session.tokenExpiresAt, scopes: ['remote_control_controller_websocket'] };
  for (const change of [{ targetOrigin: 'https://example.com' }, { targetPath: '/other' }, { clientId: 'another-client' },
    { accountUserId: 'another-owner' }, { tokenSha256Base64url: Buffer.alloc(32).toString('base64url') },
    { tokenExpiresAt: 1 }, { scopes: ['another-scope'] }, { nonce: 'short' }]) {
    await assert.rejects(session.signChallenge({ ...challenge, ...change }), { code: 'INVALID_DEVICE_CHALLENGE' });
  }
  const signed = await session.signChallenge(challenge), payload = Buffer.from(signed.signedPayloadBase64, 'base64');
  assert.equal(signed.type, 'device_key_proof');
  assert.equal(signed.keyId, session.enrollment.keyId);
  assert(verify('sha256', payload, f.keys.get(signed.keyId).publicKey, Buffer.from(signed.signatureDerBase64, 'base64')));
  const decoded = JSON.parse(payload);
  assert.equal(decoded.domain, 'codex-device-key-sign-payload/v1');
  assert.equal(decoded.payload.type, 'remoteControlClientConnection');
  assert.deepEqual(Object.keys(decoded.payload), ['accountUserId', 'audience', 'clientId', 'nonce', 'scopes', 'sessionId',
    'targetOrigin', 'targetPath', 'tokenExpiresAt', 'tokenSha256Base64url', 'type']);
});
