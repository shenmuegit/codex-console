import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { startRemoteAuthorization } from '../../web/remote-auth.mjs';

const callback = (session, values = {}) => {
  const url = new URL(session.redirectUri);
  url.searchParams.set('state', new URL(session.url).searchParams.get('state'));
  for (const [key, value] of Object.entries(values)) url.searchParams.set(key, value);
  return url;
};
const stopped = session => session.cancel();

test('official callback exchanges a code with its server-held PKCE verifier and closes the listener', async t => {
  let exchanged;
  const session = await startRemoteAuthorization({ accountId: 'workspace-one', fetchToken: async (url, options) => {
    exchanged = { url: String(url), options };
    return Response.json({ access_token: 'step-up-token' });
  } });
  t.after(() => stopped(session));
  const auth = new URL(session.url);
  assert.equal(auth.origin, 'https://auth.openai.com');
  assert.equal(auth.pathname, '/oauth/authorize');
  assert.equal(auth.searchParams.get('scope'), 'codex.remote_control.enroll');
  assert.equal(auth.searchParams.get('allowed_workspace_id'), 'workspace-one');
  assert.equal(auth.searchParams.get('current_workspace_id'), 'workspace-one');
  assert.equal(auth.searchParams.get('reauth'), 'remote_control');
  assert.equal(auth.searchParams.get('max_age'), '0');
  assert.equal(auth.searchParams.get('redirect_uri'), session.redirectUri);
  const response = await fetch(callback(session, { code: 'official-code' }));
  assert.equal(response.status, 200);
  assert.equal(await session.completion, 'step-up-token');
  assert.equal(exchanged.url, 'https://auth.openai.com/oauth/token');
  const form = new URLSearchParams(exchanged.options.body);
  assert.equal(form.get('grant_type'), 'authorization_code');
  assert.equal(form.get('code'), 'official-code');
  assert.equal(form.get('redirect_uri'), session.redirectUri);
  assert.equal(form.get('client_id'), auth.searchParams.get('client_id'));
  const verifier = form.get('code_verifier');
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(createHash('sha256').update(verifier).digest('base64url'), auth.searchParams.get('code_challenge'));
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  assert.notEqual(verifier, auth.searchParams.get('state'));
  await assert.rejects(fetch(session.redirectUri));
});

test('wrong state, duplicate parameters, missing code, and wrong paths cannot exchange a token', async t => {
  let exchanges = 0;
  const session = await startRemoteAuthorization({ accountId: 'workspace-one', fetchToken: async () => {
    ++exchanges; return Response.json({ access_token: 'token' });
  } });
  t.after(() => stopped(session));
  const bad = [callback(session, { state: 'wrong', code: 'code' }), callback(session), callback(session, { code: '' })];
  const duplicate = callback(session, { code: 'code' }); duplicate.searchParams.append('state', 'wrong'); bad.push(duplicate);
  const wrongPath = callback(session, { code: 'code' }); wrongPath.pathname = '/other';
  for (const url of bad) assert.equal((await fetch(url)).status, 400);
  assert.equal((await fetch(wrongPath)).status, 404);
  assert.equal(exchanges, 0);
  assert.deepEqual(session.submitCallback(callback(session, { code: 'good-code' }).href), { accepted: true });
  assert.equal(await session.completion, 'token');
  assert.equal(exchanges, 1);
});

test('a copied callback completes without contacting its URL and rejects foreign origins or replay', async t => {
  let exchanges = 0, release;
  const session = await startRemoteAuthorization({ accountId: 'workspace-one', fetchToken: async () => {
    ++exchanges;
    await new Promise(resolve => { release = resolve; });
    return Response.json({ access_token: 'token-from-copied-callback' });
  } });
  t.after(() => stopped(session));
  const good = callback(session, { code: 'copied-code' });
  for (const change of [url => { url.hostname = 'example.com'; }, url => { url.protocol = 'https:'; },
    url => { url.port = '9999'; }, url => { url.pathname = '/other'; }, url => { url.username = 'user'; },
    url => { url.hash = 'fragment'; }, url => { url.searchParams.set('state', 'wrong'); },
    url => { url.searchParams.set('state', 'ä'.repeat(43)); }]) {
    const bad = new URL(good); change(bad);
    assert.throws(() => session.submitCallback(bad.href), { code: 'INVALID_CALLBACK' });
  }
  assert.deepEqual(session.submitCallback(good.href), { accepted: true });
  assert.throws(() => session.submitCallback(good.href), { code: 'CALLBACK_USED' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(exchanges, 1);
  release();
  assert.equal(await session.completion, 'token-from-copied-callback');
});

test('provider rejection closes the attempt without exposing returned error descriptions', async t => {
  const session = await startRemoteAuthorization({ accountId: 'workspace-one', fetchToken: () => assert.fail('No token exchange') });
  t.after(() => stopped(session));
  const failure = assert.rejects(session.completion, error => error.code === 'AUTH_DENIED' && !error.message.includes('private-provider-message'));
  const response = await fetch(callback(session, { error: 'access_denied', error_description: 'private-provider-message' }));
  assert.equal(response.status, 400);
  await failure;
  await assert.rejects(fetch(session.redirectUri));
});

test('cancellation, external abort, and timeout release callback ports without a token exchange', async t => {
  const fetchToken = () => assert.fail('No token exchange');
  const cancelled = await startRemoteAuthorization({ accountId: 'workspace-one', fetchToken });
  t.after(() => stopped(cancelled));
  cancelled.cancel();
  await assert.rejects(cancelled.completion, { code: 'AUTH_CANCELLED' });
  await assert.rejects(fetch(cancelled.redirectUri));
  const abort = new AbortController();
  const interrupted = await startRemoteAuthorization({ accountId: 'workspace-one', fetchToken, signal: abort.signal });
  abort.abort();
  await assert.rejects(interrupted.completion, { code: 'AUTH_CANCELLED' });
  const expired = await startRemoteAuthorization({ accountId: 'workspace-one', fetchToken, timeoutMs: 25 });
  await assert.rejects(expired.completion, { code: 'AUTH_TIMEOUT' });
});

test('a busy official callback port falls back to 1457 and both busy ports fail without leaking a server', async t => {
  const first = http.createServer();
  await new Promise((resolve, reject) => { first.once('error', reject); first.listen(1455, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => first.close(resolve)));
  const session = await startRemoteAuthorization({ accountId: 'workspace-one' });
  assert.equal(new URL(session.redirectUri).port, '1457');
  await assert.rejects(startRemoteAuthorization({ accountId: 'workspace-one' }), { code: 'CALLBACK_PORTS_BUSY' });
  session.cancel();
  await assert.rejects(session.completion, { code: 'AUTH_CANCELLED' });
});

test('failed or malformed token responses fail without returning an access token', async t => {
  for (const response of [Response.json({ detail: 'private-error' }, { status: 403 }), Response.json({ access_token: '' }), Response.json({ token: 'wrong-field' })]) {
    const session = await startRemoteAuthorization({ accountId: 'workspace-one', fetchToken: async () => response });
    t.after(() => stopped(session));
    session.submitCallback(callback(session, { code: 'code' }).href);
    await assert.rejects(session.completion, error => error.code === 'TOKEN_EXCHANGE_FAILED' && !error.message.includes('private-error'));
  }
});

test('a token endpoint redirect cannot send the authorization code and verifier to another endpoint', async t => {
  let redirectedRequests = 0;
  const endpoint = http.createServer((req, res) => {
    if (req.url === '/token') { res.writeHead(307, { Location: '/capture' }); res.end(); }
    else { ++redirectedRequests; res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"access_token":"redirected-token"}'); }
  });
  await new Promise(resolve => endpoint.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { endpoint.close(resolve); endpoint.closeAllConnections(); }));
  const session = await startRemoteAuthorization({ accountId: 'workspace-one', fetchToken: (_url, options) =>
    fetch(`http://127.0.0.1:${endpoint.address().port}/token`, options) });
  t.after(() => stopped(session));
  session.submitCallback(callback(session, { code: 'private-code' }).href);
  await assert.rejects(session.completion, { code: 'TOKEN_EXCHANGE_FAILED' });
  assert.equal(redirectedRequests, 0);
});
