import { readFile, mkdir, lstat, open, link, rename, rm, realpath } from 'node:fs/promises';
import { join, isAbsolute, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash, createPublicKey, verify } from 'node:crypto';
import { startRemoteAuthorization } from './remote-auth.mjs';

const base = 'https://chatgpt.com/backend-api';
const enrollmentPath = '/codex/remote/control/client/enroll/finish';
const refreshPath = '/codex/remote/control/client/refresh/finish';
const scope = 'remote_control_controller_websocket';
const fault = (code, message) => Object.assign(new Error(message), { code });
const text = (value, max = 256) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\s\0]/.test(value);
const digest = value => createHash('sha256').update(value).digest('base64url');
const keyIdentity = key => ({ algorithm: key.algorithm, keyId: key.keyId,
  protectionClass: key.protectionClass, publicKeySpkiDerBase64: key.publicKeySpkiDerBase64 });
const keyHash = key => digest(JSON.stringify(keyIdentity(key)));

function claims(token) {
  try {
    if (!text(token, 65_536) || token.split('.').length !== 3) throw new Error();
    const value = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw fault('AUTH_REQUIRED', 'The server needs valid Codex account credentials.'); }
}
function owners(auth) {
  const value = auth.claims['https://api.openai.com/auth'] ?? {};
  const principal = value.chatgpt_account_user_id ?? value.account_user_id;
  const account = value.chatgpt_account_id ?? value.account_id;
  const result = text(principal) ? [principal] : [];
  if (account === auth.accountId && text(value.user_id) && !result.includes(value.user_id)) result.push(value.user_id);
  return result;
}
function publicKey(record) {
  if (!record || !text(record.keyId) || record.algorithm !== 'ecdsa_p256_sha256' || !text(record.protectionClass) ||
      !text(record.publicKeySpkiDerBase64, 4096)) throw fault('DEVICE_KEY_UNAVAILABLE', 'A protected device key is required.');
  try {
    const key = createPublicKey({ key: Buffer.from(record.publicKeySpkiDerBase64, 'base64'), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error();
    return key;
  } catch { throw fault('DEVICE_KEY_UNAVAILABLE', 'The protected device public key is invalid.'); }
}
function validateSession(response, record, allowExpired = false) {
  const expires = Date.parse(response?.expires_at);
  if (response?.client_id !== record.clientId || response?.account_user_id !== record.accountUserId ||
      !Array.isArray(response.scopes) || response.scopes.length !== 1 || response.scopes[0] !== scope ||
      !text(response.remote_control_token, 65_536) || !Number.isFinite(expires) || (!allowExpired && expires <= Date.now())) {
    throw fault('INVALID_RELAY_SESSION', 'The relay session does not match this server controller.');
  }
  return Math.floor(expires / 1000);
}
function validateChallenge(challenge, record, path, requireHash = false) {
  const target = new URL(base + path), c = challenge;
  const expiry = typeof c?.challenge_expires_at === 'number' ? c.challenge_expires_at * (c.challenge_expires_at < 1e11 ? 1000 : 1) : NaN;
  if (c?.purpose !== 'remote_control_client_enrollment' || c?.audience !== 'remote_control_client_enrollment' ||
      c?.account_user_id !== record.accountUserId || c?.client_id !== record.clientId || c?.target_origin !== target.origin ||
      c?.target_path !== target.pathname || !text(c.challenge_id) || !text(c.challenge_token, 16_384) ||
      !text(c.nonce, 512) || !/^[A-Za-z0-9_-]+$/.test(c.nonce) || Buffer.from(c.nonce, 'base64url').length < 32 ||
      !Number.isFinite(expiry) || expiry <= Date.now() || (requireHash && !text(c.device_identity_hash, 128))) {
    throw fault('INVALID_CHALLENGE', 'The enrollment challenge does not match this server.');
  }
}
function validateStepUp(token, record, accountId) {
  let c;
  try { c = claims(token); } catch { throw fault('INVALID_STEP_UP', 'Fresh official account authorization is required.'); }
  const identity = c['https://api.openai.com/auth'] ?? {}, now = Date.now();
  const scopes = new Set([...(typeof c.scope === 'string' ? c.scope.split(/\s+/).filter(Boolean) : []), ...(Array.isArray(c.scp) ? c.scp : [])]);
  const account = identity.chatgpt_account_id ?? identity.account_id;
  if ((identity.chatgpt_account_user_id ?? identity.account_user_id) !== record.accountUserId ||
      (account != null && account !== accountId) || scopes.size !== 1 || !scopes.has('codex.remote_control.enroll') ||
      !Number.isFinite(c.iat) || now / 1000 - c.iat > 300 || c.iat > now / 1000 + 60 ||
      !Number.isFinite(c.pwd_auth_time) || now - c.pwd_auth_time > 300_000 || c.pwd_auth_time > now + 60_000) {
    throw fault('INVALID_STEP_UP', 'Authorization must match this account, scope, and fresh reauthentication.');
  }
}

export async function createRemoteController({ authFile, stateDir, deviceKey, fetch: requestFetch = globalThis.fetch }) {
  const repo = dirname(dirname(fileURLToPath(import.meta.url)));
  const external = path => {
    if (typeof path !== 'string' || !isAbsolute(path)) return false;
    const location = relative(repo, resolve(path));
    return location === '..' || location.startsWith('../');
  };
  if (!external(authFile) || !external(stateDir) ||
      !['createDeviceKey', 'getDeviceKeyPublic', 'signDeviceKey', 'deleteDeviceKey'].every(name => typeof deviceKey?.[name] === 'function')) {
    throw fault('INVALID_CONTROLLER_CONFIG', 'Use external private state and a protected device-key component.');
  }
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const directory = await lstat(stateDir);
  if (!directory.isDirectory() || !external(await realpath(stateDir)) || directory.uid !== process.getuid() || (directory.mode & 0o077)) {
    throw fault('STATE_INSECURE', 'The controller state directory must be private and owned by this user.');
  }
  const recordPath = join(stateDir, 'enrollment.json'), pendingPath = join(stateDir, 'pending.json');
  const stopped = new AbortController();
  const instanceId = randomUUID();
  const bootId = await readFile('/proc/sys/kernel/random/boot_id', 'utf8').catch(() => null);
  const processStart = async pid => {
    try { const data = await readFile(`/proc/${pid}/stat`, 'utf8'); return data.slice(data.lastIndexOf(')') + 2).split(' ')[19]; }
    catch { return null; }
  };
  const owner = { pid: process.pid, bootId, started: await processStart(process.pid) };
  let state = await load(recordPath), pending = await load(pendingPath), attempt, authorizing, refreshing, closed = false;
  let starting = false, startingDone, finishStarting, closing;
  let phase = state ? 'ready' : pending ? 'cleanupRequired' : 'unconfigured', errorCode;

  async function load(path) {
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) || info.size > 1_048_576) throw new Error();
      return JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw fault('STATE_INVALID', 'Controller state is unreadable or not private.');
    }
  }
  async function save(path, data, replace = false) {
    const temporary = join(stateDir, '.write-' + randomUUID());
    let created = false;
    try {
      const file = await open(temporary, 'wx', 0o600); created = true;
      try { await file.writeFile(JSON.stringify(data)); await file.sync(); } finally { await file.close(); }
      if (replace) await rename(temporary, path);
      else await link(temporary, path);
    } catch { throw fault('STATE_WRITE_FAILED', 'The controller state could not be saved atomically.'); }
    finally { if (created) await rm(temporary, { force: true }).catch(() => {}); }
  }
  async function auth() {
    try {
      const info = await lstat(authFile);
      if (!info.isFile() || !external(await realpath(authFile)) || info.uid !== process.getuid() || (info.mode & 0o077) || info.size > 1_048_576) throw new Error();
      const value = JSON.parse(await readFile(authFile, 'utf8'));
      if (!text(value.tokens?.account_id) || !text(value.tokens?.access_token, 65_536)) throw new Error();
      const current = { accountId: value.tokens.account_id, token: value.tokens.access_token, claims: claims(value.tokens.access_token) };
      if (!owners(current).length) throw new Error();
      return current;
    } catch { throw fault('AUTH_REQUIRED', 'The server needs private Codex account credentials.'); }
  }
  async function request(path, current, { body, method = body ? 'POST' : 'GET', cleanup = false } = {}) {
    let response;
    try {
      response = await requestFetch(base + path, { method, redirect: 'error',
        headers: { Authorization: `Bearer ${current.token}`, 'ChatGPT-Account-Id': current.accountId,
          originator: 'codex-console', 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
        signal: cleanup ? AbortSignal.timeout(20_000) : AbortSignal.any([stopped.signal, AbortSignal.timeout(20_000)]) });
      if (cleanup && (response.ok || response.status === 404)) { await response.body?.cancel(); return { removed: true }; }
      if (!response.ok) { await response.body?.cancel(); throw fault('REMOTE_REQUEST_FAILED', `Official remote-control request failed (${response.status}).`); }
      const reader = response.body.getReader(), chunks = []; let length = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          length += value.length;
          if (length > 1_048_576) { await reader.cancel(); throw new Error(); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (error) {
      if (error.code === 'REMOTE_REQUEST_FAILED') throw error;
      throw fault('REMOTE_REQUEST_FAILED', 'The official remote-control request did not complete.');
    }
  }
  async function matchingKey(record) {
    try {
      publicKey(record);
      const actual = await deviceKey.getDeviceKeyPublic(record.keyId);
      if (keyHash(actual) !== keyHash(record)) throw new Error();
    } catch { throw fault('DEVICE_KEY_UNAVAILABLE', 'This server controller has no matching protected key.'); }
  }
  async function enrolled() {
    if (closed) throw fault('CONTROLLER_CLOSED', 'The controller is closed.');
    if (!state) throw fault('CONTROLLER_NOT_ENROLLED', 'Complete server controller enrollment first.');
    const current = await auth(), record = state.enrollment;
    if (state.version !== 1 || state.accountId !== current.accountId || !owners(current).includes(record?.accountUserId) || !text(record?.clientId)) {
      throw fault('ACCOUNT_CHANGED', 'The saved controller belongs to another server account.');
    }
    await matchingKey(record);
    return { current, record };
  }
  async function proof(challenge, record, path, requireHash) {
    validateChallenge(challenge, record, path, requireHash);
    const hash = keyHash(record);
    if (challenge.device_identity_hash != null && challenge.device_identity_hash !== hash) {
      throw fault('INVALID_CHALLENGE', 'The enrollment challenge has a different device identity.');
    }
    const payload = Buffer.from(JSON.stringify({ domain: 'codex-device-key-sign-payload/v1', payload: {
      accountUserId: record.accountUserId, audience: challenge.audience, challengeExpiresAt: challenge.challenge_expires_at,
      challengeId: challenge.challenge_id, clientId: record.clientId, deviceIdentitySha256Base64url: hash,
      nonce: challenge.nonce, targetOrigin: challenge.target_origin, targetPath: challenge.target_path, type: 'remoteControlClientEnrollment',
    } }));
    const signed = await signPayload(record, payload);
    return { challenge_token: challenge.challenge_token, key_id: record.keyId, signature_der_base64: signed.signatureDerBase64,
      signed_payload_base64: payload.toString('base64'), algorithm: signed.algorithm };
  }
  async function signPayload(record, payload) {
    let signed;
    try {
      signed = await deviceKey.signDeviceKey(record.keyId, payload);
      if (signed.algorithm !== record.algorithm || !verify('sha256', payload, publicKey(record), Buffer.from(signed.signatureDerBase64, 'base64'))) throw new Error();
    } catch { throw fault('INVALID_DEVICE_PROOF', 'The protected key did not produce a valid enrollment proof.'); }
    return signed;
  }
  function relaySession(current, record, response) {
    const tokenExpiresAt = validateSession(response, record);
    return { enrollment: record, response, tokenExpiresAt,
      headers: { Authorization: `Bearer ${current.token}`, 'ChatGPT-Account-Id': current.accountId,
        originator: 'codex-console', 'x-codex-client-session-token': `Bearer ${response.remote_control_token}` },
      async signChallenge(challenge) {
        await enrolled();
        const c = challenge;
        if (c?.type !== 'device_key_challenge' || c?.purpose !== 'remote_control_client_websocket' || c?.audience !== 'remote_control_client_websocket' ||
            c?.accountUserId !== record.accountUserId || c?.clientId !== record.clientId ||
            c?.targetOrigin !== 'https://chatgpt.com' || c?.targetPath !== '/backend-api/codex/remote/control/client' ||
            !text(c.sessionId) || !text(c.nonce, 512) || !/^[A-Za-z0-9_-]+$/.test(c.nonce) || Buffer.from(c.nonce, 'base64url').length < 32 ||
            c?.tokenSha256Base64url !== digest(response.remote_control_token) || c?.tokenExpiresAt !== tokenExpiresAt || tokenExpiresAt <= Date.now() / 1000 ||
            !Array.isArray(c.scopes) || c.scopes.length !== 1 || c.scopes[0] !== scope) {
          throw fault('INVALID_DEVICE_CHALLENGE', 'The relay device challenge does not match this server session.');
        }
        const payload = Buffer.from(JSON.stringify({ domain: 'codex-device-key-sign-payload/v1', payload: {
          accountUserId: record.accountUserId, audience: c.audience, clientId: record.clientId, nonce: c.nonce,
          scopes: [scope], sessionId: c.sessionId, targetOrigin: c.targetOrigin, targetPath: c.targetPath,
          tokenExpiresAt, tokenSha256Base64url: c.tokenSha256Base64url, type: 'remoteControlClientConnection',
        } }));
        const signed = await signPayload(record, payload);
        return { type: 'device_key_proof', keyId: record.keyId, signatureDerBase64: signed.signatureDerBase64,
          signedPayloadBase64: payload.toString('base64'), algorithm: signed.algorithm };
      },
    };
  }
  async function cleanup(candidate, current) {
    let keyRemoved = !candidate.enrollment?.keyId, clientRemoved = !candidate.enrollment?.clientId;
    if (!keyRemoved) { try { await deviceKey.deleteDeviceKey(candidate.enrollment.keyId); keyRemoved = true; } catch {} }
    if (!clientRemoved) {
      try { clientRemoved = (await request('/wham/remote/control/clients/' + encodeURIComponent(candidate.enrollment.clientId), current,
        { method: 'DELETE', cleanup: true })).removed; } catch {}
    }
    let ownedMarker;
    try {
      const saved = await load(pendingPath);
      if (saved?.instanceId === candidate.instanceId && saved?.enrollment?.clientId === candidate.enrollment?.clientId &&
          saved?.enrollment?.keyId === candidate.enrollment?.keyId) ownedMarker = saved;
    } catch {}
    let journalRemoved = !ownedMarker;
    if (keyRemoved && clientRemoved && ownedMarker) {
      try { await rm(pendingPath, { force: true }); journalRemoved = true; } catch {}
    }
    if (keyRemoved && clientRemoved && journalRemoved) { if (pending?.instanceId === candidate.instanceId) pending = null; }
    else {
      pending = { ...candidate, inProgress: false }; phase = 'cleanupRequired';
      if (ownedMarker) await save(pendingPath, pending, true).catch(() => {});
    }
    return keyRemoved && clientRemoved && journalRemoved;
  }
  async function candidateActive(candidate) {
    if (candidate.instanceId === instanceId || candidate.inProgress === false) return false;
    if (!Number.isInteger(candidate.owner?.pid) || candidate.owner.pid < 1) return true;
    if (bootId && candidate.owner.bootId && bootId !== candidate.owner.bootId) return false;
    try { process.kill(candidate.owner.pid, 0); } catch (error) { return error.code !== 'ESRCH'; }
    const started = await processStart(candidate.owner.pid);
    // shortcut: without /proc, a reused live PID needs manual cleanup; add platform identity if deployed there.
    return !started || !candidate.owner.started || started === candidate.owner.started;
  }

  return {
    async status() {
      if (starting || authorizing) return { enrolled: false, phase, ...(errorCode ? { errorCode } : {}) };
      if (state) {
        try { await enrolled(); return { enrolled: true, phase: 'ready' }; }
        catch (error) { return { enrolled: false, phase: 'unavailable', errorCode: error.code }; }
      }
      return { enrolled: false, phase, ...(errorCode ? { errorCode } : {}) };
    },
    async startAuthorization() {
      if (closed) throw fault('CONTROLLER_CLOSED', 'The controller is closed.');
      if (state) throw fault('CONTROLLER_EXISTS', 'The existing controller enrollment is preserved.');
      if (starting || authorizing) throw fault('AUTH_IN_PROGRESS', 'Server authorization is already in progress.');
      starting = true; startingDone = new Promise(resolve => { finishStarting = resolve; });
      let current, candidate, committed = false;
      phase = 'starting'; errorCode = undefined;
      try {
        current = await auth();
        if (pending) {
          if (await candidateActive(pending)) throw fault('AUTH_IN_PROGRESS', 'This server candidate is still authorizing in another process.');
          if (pending.accountId !== current.accountId || !await cleanup(pending, current)) {
            throw fault('CLEANUP_REQUIRED', 'Clean up this server candidate before starting another enrollment.');
          }
        }
        candidate = { version: 1, accountId: current.accountId, instanceId, owner, inProgress: true, enrollment: {} };
        const started = await request('/codex/remote/control/client/enroll/start', current, { body: {} });
        if (!text(started.client_id)) throw fault('INVALID_CHALLENGE', 'The service returned an invalid server identity.');
        candidate.enrollment = { clientId: started.client_id, accountUserId: started.account_user_id };
        if (!owners(current).includes(started.account_user_id)) throw fault('INVALID_CHALLENGE', 'The server account does not match the enrollment challenge.');
        validateChallenge(started.device_key_challenge, candidate.enrollment, enrollmentPath);
        const key = await deviceKey.createDeviceKey('allow_os_protected_nonextractable');
        candidate.enrollment = { ...candidate.enrollment, ...keyIdentity(key) };
        await matchingKey(candidate.enrollment);
        await save(pendingPath, candidate); pending = candidate;
        attempt = await startRemoteAuthorization({ accountId: current.accountId, fetchToken: requestFetch, signal: stopped.signal });
        phase = 'authorizing';
        authorizing = attempt.completion.then(async token => {
          validateStepUp(token, candidate.enrollment, current.accountId);
          if ((await auth()).accountId !== current.accountId) throw fault('ACCOUNT_CHANGED', 'The server account changed during authorization.');
          phase = 'enrolling';
          const device_key_proof = await proof(started.device_key_challenge, candidate.enrollment, enrollmentPath, false);
          const key = candidate.enrollment;
          const response = await request(enrollmentPath, current, { body: { client_id: key.clientId, step_up_token: token,
            device_identity: { key_id: key.keyId, public_key_spki_der_base64: key.publicKeySpkiDerBase64, algorithm: key.algorithm, protection_class: key.protectionClass }, device_key_proof } });
          validateSession(response, key);
          const latest = await auth();
          if (latest.accountId !== current.accountId || !owners(latest).includes(key.accountUserId)) throw fault('ACCOUNT_CHANGED', 'The server account changed during enrollment.');
          const saved = { version: 1, accountId: current.accountId, enrollment: key, session: response };
          await save(recordPath, saved); committed = true; state = saved; pending = null;
          await rm(pendingPath, { force: true }).catch(() => {});
          phase = 'ready'; return { enrolled: true };
        }).catch(async error => {
          errorCode = error.code ?? 'CONTROLLER_ERROR';
          if (!committed && await cleanup(candidate, current)) phase = 'unconfigured';
          throw error;
        }).finally(() => { authorizing = null; attempt = null; });
        authorizing.catch(() => {});
        return { url: attempt.url, redirectUri: attempt.redirectUri, expiresAt: Date.now() + 600_000, completion: authorizing };
      } catch (error) {
        errorCode = error.code ?? 'CONTROLLER_ERROR';
        if (candidate && !committed && await cleanup(candidate, current)) phase = pending ? 'cleanupRequired' : 'unconfigured';
        throw error;
      } finally { starting = false; finishStarting(); startingDone = null; }
    },
    submitCallback(url) {
      if (!attempt) throw fault('AUTH_NOT_STARTED', 'Start server authorization before submitting its callback.');
      return attempt.submitCallback(url);
    },
    async pair(code) {
      if (typeof code !== 'string' || !/^[a-z0-9]{4}-?[a-z0-9]{4}$/i.test(code.trim())) throw fault('INVALID_PAIRING_CODE', 'Enter the controlled host’s eight-character code.');
      const { current, record } = await enrolled(), compact = code.trim().replace('-', '').toUpperCase();
      const result = await request('/wham/remote/control/client/pair', current, { body: { client_id: record.clientId,
        manual_pairing_code: compact.slice(0, 4) + '-' + compact.slice(4) } });
      if (!text(result.environment_id)) throw fault('INVALID_PAIR_RESULT', 'The pairing response did not identify a controlled host.');
      return { environmentId: result.environment_id };
    },
    async listHosts() {
      const { current, record } = await enrolled(), result = [], cursors = new Set(); let cursor;
      do {
        const query = new URLSearchParams({ limit: '100', ...(cursor ? { cursor } : {}) });
        const page = await request('/codex/remote/control/clients/' + encodeURIComponent(record.clientId) + '/environments?' + query, current);
        if (!Array.isArray(page.items) || page.items.length > 100) throw fault('INVALID_HOST_LIST', 'The service returned an invalid host list.');
        for (const host of page.items) {
          if (!text(host.env_id)) throw fault('INVALID_HOST_LIST', 'The service returned an invalid host identity.');
          const name = host.display_name ?? host.name ?? host.host_name ?? host.env_id;
          if (typeof name !== 'string' || name.length > 512) throw fault('INVALID_HOST_LIST', 'The service returned an invalid host name.');
          result.push({ id: host.env_id, name, hostName: typeof host.host_name === 'string' && host.host_name.length <= 512 ? host.host_name : null });
        }
        cursor = page.cursor;
        if (cursor != null && (!text(cursor, 4096) || cursors.has(cursor) || cursors.size >= 100)) throw fault('INVALID_HOST_LIST', 'Host pagination did not complete.');
        if (cursor) cursors.add(cursor);
      } while (cursor);
      return result;
    },
    async session() {
      const { current, record } = await enrolled();
      const expires = validateSession(state.session, record, true);
      if (expires > Date.now() / 1000 + 30) return relaySession(current, record, state.session);
      if (!refreshing) {
        refreshing = (async () => {
          const started = await request('/codex/remote/control/client/refresh/start', current, { body: { client_id: record.clientId } });
          if (started.client_id !== record.clientId || started.account_user_id !== record.accountUserId) throw fault('INVALID_CHALLENGE', 'The refresh belongs to another controller.');
          const response = await request(refreshPath, current, { body: { client_id: record.clientId,
            device_key_proof: await proof(started.device_key_challenge, record, refreshPath, true) } });
          validateSession(response, record);
          const latest = await auth(), persisted = await load(recordPath);
          if (latest.accountId !== current.accountId || !owners(latest).includes(record.accountUserId) ||
              persisted?.accountId !== current.accountId || persisted?.enrollment?.clientId !== record.clientId || keyHash(persisted.enrollment) !== keyHash(record)) {
            throw fault('ACCOUNT_CHANGED', 'The server identity changed during session refresh.');
          }
          const saved = { ...state, session: response }; await save(recordPath, saved, true); state = saved;
        })().finally(() => { refreshing = null; });
      }
      await refreshing;
      return relaySession(current, record, state.session);
    },
    async close() {
      if (closing) return closing;
      closed = true; stopped.abort(); attempt?.cancel();
      closing = (async () => {
        if (startingDone) await startingDone;
        await Promise.allSettled([authorizing, refreshing].filter(Boolean));
      })();
      return closing;
    },
  };
}
