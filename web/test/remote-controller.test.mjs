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

test('browser confirmation taking three minutes enrolls with a fresh two-minute device challenge', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = await fixture(t, { challengeTTLSeconds: 120 });
  const attempt = await f.controller.startAuthorization();
  t.mock.timers.tick(180_000);
  const returned = new URL(attempt.redirectUri);
  returned.searchParams.set('state', new URL(attempt.url).searchParams.get('state'));
  returned.searchParams.set('code', 'approved-after-three-minutes');
  f.controller.submitCallback(returned.href);
  await attempt.completion;
  assert.equal((await f.controller.status()).enrolled, true);
  assert.equal(f.keys.size, 1);
  await assert.rejects(access(join(f.stateDir, 'pending.json')));
});

test('wrong challenge account, client, purpose, target, nonce, and expiration fail before signing', async t => {
  for (const challenge of [{ account_user_id: 'different-owner' }, { client_id: 'another-client' },
    { purpose: 'another-purpose' }, { audience: 'another-audience' }, { target_origin: 'https://example.com' },
    { target_path: '/other' }, { nonce: 'short' }, { challenge_expires_at: 1 }]) {
    const f = await fixture(t, { challenge });
    await assert.rejects(f.authorize(), { code: 'INVALID_CHALLENGE' });
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
    assert.equal(f.calls.filter(call => call.method === 'DELETE').length, 0);
  }
});

test('step-up authorization uses the current workspace user when enrollment identifies the login user', async t => {
  const f = await fixture(t, { serviceAccountUserId: 'login-user' });
  await f.authorize();
  assert.equal((await f.controller.status()).enrolled, true);
  const saved = JSON.parse(await readFile(join(f.stateDir, 'enrollment.json'), 'utf8'));
  assert.equal(saved.enrollment.accountUserId, 'login-user');
  assert.equal(saved.accountId, 'workspace-one');
  assert.deepEqual(await f.controller.pair('ABCD-1234'), { environmentId: 'host-one' });
});

test('the enrollment login user cannot replace the workspace user in a step-up token', async t => {
  const stepUp = { ...stepUpClaims(), 'https://api.openai.com/auth': {
    account_id: 'workspace-one', account_user_id: 'login-user', user_id: 'login-user' } };
  const f = await fixture(t, { serviceAccountUserId: 'login-user', stepUp });
  await assert.rejects(f.authorize(), { code: 'INVALID_STEP_UP' });
  assert.equal((await f.controller.status()).enrolled, false);
  assert.equal(f.signed, 0);
  assert.equal(f.keys.size, 0);
});

test('a login identity without a workspace user cannot authorize controller enrollment', async t => {
  const identity = { account_id: 'workspace-one', user_id: 'login-user' };
  const f = await fixture(t, { serviceAccountUserId: 'login-user',
    stepUp: { ...stepUpClaims(), 'https://api.openai.com/auth': identity } });
  await writeFile(f.authFile, JSON.stringify({ tokens: { account_id: 'workspace-one',
    access_token: jwt({ ...accessClaims(), 'https://api.openai.com/auth': identity }) } }), { mode: 0o600 });
  await assert.rejects(f.authorize(), { code: 'INVALID_STEP_UP' });
  assert.equal((await f.controller.status()).enrolled, false);
  assert.equal(f.keys.size, 0);
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
  const f = await fixture(t, { beforeFinish: () => { throw new Error('fixture finish failure'); } });
  f.deviceKey.deleteDeviceKey = async () => { throw new Error('private-key-operation-detail'); };
  await assert.rejects(f.authorize(), { code: 'REMOTE_REQUEST_FAILED' });
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
  assert.equal(f.created, 0);
  assert.equal(f.calls.filter(call => call.url.endsWith('/client/enroll/start')).length, 0);
  await f.controller.close();
  assert.equal(f.keys.size, 0);
  assert.equal(f.calls.filter(call => call.method === 'DELETE').length, 0);
  await assert.rejects(access(join(f.stateDir, 'pending.json')));
});

test('a competing controller instance cannot delete a candidate while its owner is authorizing', async t => {
  const f = await fixture(t);
  await f.controller.startAuthorization();
  const second = await createRemoteController({ authFile: f.authFile, stateDir: f.stateDir, deviceKey: f.deviceKey, fetch: f.fetch });
  t.after(() => second.close());
  await assert.rejects(second.startAuthorization(), { code: 'AUTH_IN_PROGRESS' });
  assert.equal(f.keys.size, 0);
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

test('invalid challenge and failed DELETE retain the candidate before key creation and restart retries cleanup', async t => {
  const options = { challenge: { purpose: 'invalid-purpose' }, deleteStatus: 503 };
  const f = await fixture(t, options);
  await assert.rejects(f.authorize(), { code: 'INVALID_CHALLENGE' });
  const marker = JSON.parse(await readFile(join(f.stateDir, 'pending.json'), 'utf8'));
  assert.equal(marker.enrollment.clientId, 'server-created-client');
  assert.equal(marker.enrollment.keyId, undefined);
  assert.equal(marker.inProgress, false);
  await f.controller.close();
  options.deleteStatus = 204; delete options.challenge;
  const restarted = await createRemoteController({ authFile: f.authFile, stateDir: f.stateDir, deviceKey: f.deviceKey, fetch: f.fetch });
  t.after(() => restarted.close());
  assert.equal((await restarted.status()).phase, 'cleanupRequired');
  await f.authorize(restarted);
  assert.equal(f.calls.filter(c => c.method === 'DELETE').length, 2);
  assert.equal((await restarted.status()).phase, 'ready');
});

test('key creation failure with failed DELETE retains a durable owned candidate', async t => {
  const f = await fixture(t, { deleteStatus: 503 });
  f.deviceKey.createDeviceKey = async () => { throw new Error('fixture key creation failed'); };
  await assert.rejects(f.authorize(), /fixture key creation failed/);
  const marker = JSON.parse(await readFile(join(f.stateDir, 'pending.json'), 'utf8'));
  assert.equal(marker.enrollment.clientId, 'server-created-client');
  assert.equal(marker.inProgress, false);
  assert.equal((await f.controller.status()).phase, 'cleanupRequired');
});

test('failed cleanup reports inability to persist when candidate storage becomes unavailable', async t => {
  const f = await fixture(t, { deleteStatus: 503 });
  f.deviceKey.createDeviceKey = async () => {
    await rm(f.stateDir, { recursive: true }); await writeFile(f.stateDir, 'blocked', { mode: 0o600 });
    throw new Error('fixture key creation failed');
  };
  await assert.rejects(f.authorize(), { code: 'CLEANUP_RECORD_FAILED' });
  assert.deepEqual(await f.controller.status(), { enrolled: false, phase: 'cleanupRequired', errorCode: 'CLEANUP_RECORD_FAILED' });
});

test('candidate key update and cleanup never overwrite a competing owner marker', async t => {
  const f = await fixture(t, { deleteStatus: 503 });
  const create = f.deviceKey.createDeviceKey;
  const foreign = JSON.stringify({ instanceId: 'competing-owner', enrollment: { clientId: 'another-client' }, inProgress: true });
  f.deviceKey.createDeviceKey = async policy => {
    const key = await create(policy);
    await writeFile(join(f.stateDir, 'pending.json'), foreign, { mode: 0o600 });
    return key;
  };
  await assert.rejects(f.authorize(), { code: 'CLEANUP_RECORD_FAILED' });
  assert.equal(await readFile(join(f.stateDir, 'pending.json'), 'utf8'), foreign);
  assert.equal(f.keys.size, 0);
  assert.equal(f.calls.filter(c => c.method === 'DELETE').length, 1);
});

test('challenge allocation never overwrites authorization ownership from a competing controller', async t => {
  const f = await fixture(t, { deleteStatus: 503 });
  const foreign = JSON.stringify({ instanceId: 'competing-owner', enrollment: { clientId: 'another-client' }, inProgress: true });
  const controller = await createRemoteController({ authFile: f.authFile, stateDir: f.stateDir, deviceKey: f.deviceKey,
    fetch: async (url, request) => {
      const response = await f.fetch(url, request);
      if (url.endsWith('/client/enroll/start')) await writeFile(join(f.stateDir, 'pending.json'), foreign, { mode: 0o600 });
      return response;
    } });
  t.after(() => controller.close());
  await assert.rejects(f.authorize(controller), { code: 'CLEANUP_RECORD_FAILED' });
  assert.equal(await readFile(join(f.stateDir, 'pending.json'), 'utf8'), foreign);
  assert.equal(f.created, 0);
});

test('allocated candidate disk failure reports lost cleanup persistence and never creates a key', async t => {
  const f = await fixture(t, { deleteStatus: 503 });
  const controller = await createRemoteController({ authFile: f.authFile, stateDir: f.stateDir, deviceKey: f.deviceKey,
    fetch: async (url, request) => {
      const response = await f.fetch(url, request);
      if (url.endsWith('/client/enroll/start')) {
        await rm(f.stateDir, { recursive: true }); await writeFile(f.stateDir, 'blocked', { mode: 0o600 });
      }
      return response;
    } });
  t.after(() => controller.close());
  await assert.rejects(f.authorize(controller), { code: 'CLEANUP_RECORD_FAILED' });
  assert.equal(f.created, 0);
  assert.equal(f.calls.filter(c => c.method === 'DELETE').length, 1);
  assert.equal((await controller.status()).errorCode, 'CLEANUP_RECORD_FAILED');
});

const writeAccount = (authFile, token, account = 'workspace-one') => writeFile(authFile,
  JSON.stringify({ tokens: { account_id: account, access_token: token } }), { mode: 0o600 });

test('expired base credentials join one renewal and refresh the original relay identity from the renewed cache', async t => {
  let renewals = 0, release;
  const renewed = jwt({ ...accessClaims(), exp: Date.now() / 1000 + 7200 });
  const f = await fixture(t);
  await f.authorize(); await f.controller.close();
  const path = join(f.stateDir, 'enrollment.json'), saved = JSON.parse(await readFile(path, 'utf8'));
  saved.session.expires_at = '2000-01-01T00:00:00Z'; await writeFile(path, JSON.stringify(saved), { mode: 0o600 });
  await writeAccount(f.authFile, jwt({ ...accessClaims(), exp: 1 }));
  const controller = await createRemoteController({ authFile: f.authFile, stateDir: f.stateDir, deviceKey: f.deviceKey, fetch: f.fetch,
    refreshAccount: async () => { ++renewals; await new Promise(resolve => { release = resolve; }); await writeAccount(f.authFile, renewed); } });
  t.after(() => controller.close());
  const before = f.calls.length;
  const operations = Promise.all([controller.session(), controller.pair('ABCD-1234'), controller.listHosts()]);
  const deadline = Date.now() + 1000;
  while (!release && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof release, 'function', 'Expired credentials must invoke the native account renewal hook');
  await new Promise(resolve => setImmediate(resolve)); release();
  const [session, pair, hosts] = await operations;
  assert.equal(renewals, 1);
  assert.equal(session.headers.Authorization, 'Bearer ' + renewed);
  assert.equal(session.enrollment.keyId, saved.enrollment.keyId);
  assert.equal(session.response.remote_control_token, 'fixture-relay-token-2');
  assert.equal(pair.environmentId, 'host-one'); assert.equal(hosts.length, 1);
  assert(f.calls.slice(before).every(call => call.headers.Authorization === 'Bearer ' + renewed));
  assert.equal(f.created, 1);
});

test('expired or missing token expiry cannot be transmitted without account renewal', async t => {
  for (const exp of [1, undefined, '9999999999']) {
    const f = await fixture(t); await f.authorize();
    const before = f.calls.length, record = await readFile(join(f.stateDir, 'enrollment.json'), 'utf8');
    await writeAccount(f.authFile, jwt({ ...accessClaims(), exp }));
    await assert.rejects(f.controller.pair('ABCD-1234'), { code: 'AUTH_REQUIRED' });
    await assert.rejects(f.controller.session(), { code: 'AUTH_REQUIRED' });
    assert.equal(f.calls.length, before);
    assert.deepEqual(await f.controller.status(), { enrolled: false, enrollmentPreserved: true, phase: 'authenticationRequired', errorCode: 'AUTH_REQUIRED' });
    assert.equal(await readFile(join(f.stateDir, 'enrollment.json'), 'utf8'), record);
    assert.equal(f.keys.size, 1);
  }
});

test('renewal denial, transport failure, stale cache, and account switch preserve enrollment and fail closed', async t => {
  for (const scenario of ['denied', 'failed', 'stale', 'switched']) {
    const f = await fixture(t, { refreshAccount: async ({ authFile }) => {
      if (scenario === 'denied') throw Object.assign(new Error('private rejection'), { code: 'AUTH_REQUIRED' });
      if (scenario === 'failed') throw new Error('private transport detail');
      if (scenario === 'switched') await writeAccount(authFile, jwt(accessClaims('workspace-two', 'owner-two')), 'workspace-two');
    } });
    await f.authorize(); const before = f.calls.length, record = await readFile(join(f.stateDir, 'enrollment.json'), 'utf8');
    await writeAccount(f.authFile, jwt({ ...accessClaims(), exp: 1 }));
    const code = scenario === 'switched' ? 'ACCOUNT_CHANGED' : scenario === 'failed' ? 'AUTH_REFRESH_FAILED' : 'AUTH_REQUIRED';
    await assert.rejects(f.controller.pair('ABCD-1234'), { code });
    const status = await f.controller.status();
    assert.equal(status.enrolled, false); assert.equal(status.enrollmentPreserved, true); assert.equal(status.errorCode, code);
    assert(!JSON.stringify(status).includes('private'));
    assert.equal(f.calls.length, before); assert.equal(f.keys.size, 1);
    assert.equal(await readFile(join(f.stateDir, 'enrollment.json'), 'utf8'), record);
  }
});

test('official 401 marks account authentication unavailable without replaying a possibly accepted pairing request', async t => {
  const f = await fixture(t); await f.authorize(); await f.controller.close();
  let pairCalls = 0, recover = false;
  const controller = await createRemoteController({ authFile: f.authFile, stateDir: f.stateDir, deviceKey: f.deviceKey,
    fetch: async (url, request) => {
      if (url.endsWith('/client/pair')) { ++pairCalls; return new Response(null, { status: 401 }); }
      return f.fetch(url, request);
    }, refreshAccount: async () => {
      if (!recover) throw Object.assign(new Error('official sign-in needed'), { code: 'AUTH_REQUIRED' });
      if (recover !== 'stale') await writeAccount(f.authFile, jwt({ ...accessClaims(), exp: Date.now() / 1000 + 7200 }));
    } });
  t.after(() => controller.close());
  const record = await readFile(join(f.stateDir, 'enrollment.json'), 'utf8');
  await assert.rejects(controller.pair('ABCD-1234'), e => e.code === 'AUTH_REQUIRED' && e.outcome === 'unknown');
  assert.equal((await controller.status()).phase, 'authenticationRequired');
  assert.equal(pairCalls, 1);
  recover = 'stale';
  assert.equal((await controller.status()).phase, 'authenticationRequired');
  recover = true;
  assert.deepEqual(await controller.status(), { enrolled: true, phase: 'ready' });
  assert.equal(pairCalls, 1); assert.equal(f.keys.size, 1);
  assert.equal(await readFile(join(f.stateDir, 'enrollment.json'), 'utf8'), record);
});

test('credentials are rechecked immediately before an HTTP request after key validation', async t => {
  const f = await fixture(t); await f.authorize();
  const get = f.deviceKey.getDeviceKeyPublic, before = f.calls.length;
  f.deviceKey.getDeviceKeyPublic = async id => {
    const key = await get(id); await writeAccount(f.authFile, jwt({ ...accessClaims(), exp: 1 })); return key;
  };
  await assert.rejects(f.controller.pair('ABCD-1234'), { code: 'AUTH_REQUIRED' });
  assert.equal(f.calls.length, before);
});

test('remote membership rejects a same-owner workspace claim mismatch without altering ordinary login', async t => {
  for (const refreshed of [false, true]) {
    const mismatch = jwt({ ...accessClaims(), 'https://api.openai.com/auth': {
      chatgpt_account_id: 'workspace-two', chatgpt_account_user_id: 'owner-one', user_id: 'login-user' } });
    const f = await fixture(t, { refreshAccount: async ({ authFile }) => writeAccount(authFile, mismatch) });
    await f.authorize(); const before = f.calls.length, record = await readFile(join(f.stateDir, 'enrollment.json'), 'utf8');
    await writeAccount(f.authFile, refreshed ? jwt({ ...accessClaims(), exp: 1 }) : mismatch);
    await assert.rejects(f.controller.pair('ABCD-1234'), { code: 'AUTH_REQUIRED' });
    assert.equal(JSON.parse(await readFile(f.authFile, 'utf8')).tokens.access_token, mismatch);
    assert.equal((await f.controller.status()).phase, 'authenticationRequired');
    assert.equal(f.calls.length, before); assert.equal(f.keys.size, 1);
    assert.equal(await readFile(join(f.stateDir, 'enrollment.json'), 'utf8'), record);
  }
});

test('matching-workspace legacy user_id remains a usable remote membership fallback', async t => {
  const f = await fixture(t);
  await f.authorize();
  await writeAccount(f.authFile, jwt({ exp: Date.now() / 1000 + 3600,
    'https://api.openai.com/auth': { account_id: 'workspace-one', user_id: 'owner-one' } }));
  assert.equal((await f.controller.status()).phase, 'ready');
  assert.equal((await f.controller.pair('ABCD-1234')).environmentId, 'host-one');
});

test('expired account credentials during initial setup report recoverable authentication instead of remaining starting', async t => {
  const f = await fixture(t); await writeAccount(f.authFile, jwt({ ...accessClaims(), exp: 1 }));
  await assert.rejects(f.controller.startAuthorization(), { code: 'AUTH_REQUIRED' });
  assert.deepEqual(await f.controller.status(), { enrolled: false, phase: 'authenticationRequired', errorCode: 'AUTH_REQUIRED' });
  assert.equal(f.calls.length, 0); assert.equal(f.created, 0);
});
