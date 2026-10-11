import http from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

const issuer = 'https://auth.openai.com';
const clientId = 'app_EMoamEEZ73f0CkXaXp7hrann';
const fault = (code, message) => Object.assign(new Error(message), { code });

// Version-specific native enrollment OAuth flow; no desktop process is launched.
export async function startRemoteAuthorization({ accountId, fetchToken = fetch, timeoutMs = 600_000, signal }) {
  if (typeof accountId !== 'string' || !accountId || accountId.length > 256 || /[\s\0]/.test(accountId) ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) {
    throw fault('INVALID_AUTH_OPTIONS', 'A workspace and a bounded authorization timeout are required.');
  }
  signal?.throwIfAborted();
  const state = randomBytes(32).toString('base64url'), verifier = randomBytes(32).toString('base64url');
  const requestAbort = new AbortController();
  let resolveCode, rejectCode, server, redirectUri, timer, consumed = false, finished = false, cancellation;
  const authorizationCode = new Promise((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  authorizationCode.catch(() => {});
  const respond = (res, status, message) => {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close', 'Cache-Control': 'no-store' });
    res.end(message);
  };

  function consume(url) {
    const returned = url.searchParams.get('state');
    if (url.searchParams.getAll('state').length !== 1 || typeof returned !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(returned) ||
        !timingSafeEqual(Buffer.from(returned), Buffer.from(state))) {
      throw fault('INVALID_CALLBACK', 'The authorization state does not match.');
    }
    if (consumed) throw fault('CALLBACK_USED', 'This authorization callback was already consumed.');
    if (url.searchParams.has('error')) {
      consumed = true;
      const error = fault('AUTH_DENIED', 'Official account authorization was not granted.');
      rejectCode(error);
      throw error;
    }
    const code = url.searchParams.get('code');
    if (url.searchParams.getAll('code').length !== 1 || !code || code.length > 4096 || /[\s\0]/.test(code)) {
      throw fault('INVALID_CALLBACK', 'An authorization code is required.');
    }
    consumed = true;
    clearTimeout(timer);
    resolveCode(code);
    return { accepted: true };
  }

  for (const port of [1455, 1457]) {
    const candidate = http.createServer((req, res) => {
      try {
        if (req.method !== 'GET') { respond(res, 405, 'Method Not Allowed'); return; }
        if (!['localhost:' + port, '127.0.0.1:' + port].includes(req.headers.host)) {
          respond(res, 400, 'Invalid callback host'); return;
        }
        const url = new URL(req.url, `http://localhost:${port}`);
        if (url.pathname !== '/auth/callback') { respond(res, 404, 'Not Found'); return; }
        consume(url);
        respond(res, 200, 'Account authorization received. Return to Codex Console.');
      } catch (error) {
        respond(res, error.code === 'CALLBACK_USED' ? 409 : 400,
          error.code === 'AUTH_DENIED' ? 'Account authorization was not granted.' : 'Invalid authorization callback');
      }
    });
    try {
      await new Promise((resolve, reject) => {
        candidate.once('error', reject);
        candidate.listen(port, '127.0.0.1', resolve);
      });
      server = candidate;
      redirectUri = `http://localhost:${port}/auth/callback`;
      break;
    } catch (error) {
      candidate.close();
      if (error.code !== 'EADDRINUSE') throw error;
    }
  }
  if (!server) throw fault('CALLBACK_PORTS_BUSY', 'Authorization callback ports 1455 and 1457 are busy.');

  function cancel(error = fault('AUTH_CANCELLED', 'Account authorization was cancelled.')) {
    if (finished || cancellation) return;
    cancellation = error;
    requestAbort.abort(error);
    rejectCode(error);
  }
  const aborted = () => cancel();
  signal?.addEventListener('abort', aborted, { once: true });
  if (signal?.aborted) cancel();
  timer = setTimeout(() => cancel(fault('AUTH_TIMEOUT', 'Account authorization timed out.')), timeoutMs);

  const completion = authorizationCode.then(async code => {
    try {
      const response = await fetchToken(issuer + '/oauth/token', {
        method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri,
          client_id: clientId, code_verifier: verifier }).toString(),
        signal: AbortSignal.any([requestAbort.signal, AbortSignal.timeout(20_000)]),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw fault('TOKEN_EXCHANGE_FAILED', `Official token exchange failed (${response.status}).`);
      }
      const result = await response.json();
      if (typeof result?.access_token !== 'string' || !result.access_token || result.access_token.length > 65_536) {
        throw fault('TOKEN_EXCHANGE_FAILED', 'Official token exchange returned an invalid token.');
      }
      requestAbort.signal.throwIfAborted();
      return result.access_token;
    } catch (error) {
      throw cancellation ?? (error.code === 'TOKEN_EXCHANGE_FAILED' ? error :
        fault('TOKEN_EXCHANGE_FAILED', 'Official token exchange did not complete.'));
    }
  }).finally(async () => {
    finished = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', aborted);
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  });
  completion.catch(() => {});
  const url = new URL(issuer + '/oauth/authorize');
  url.search = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri,
    scope: 'codex.remote_control.enroll', code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256', state, originator: 'codex-console', reauth: 'remote_control', max_age: '0',
    codex_cli_simplified_flow: 'true', allowed_workspace_id: accountId, current_workspace_id: accountId }).toString();

  return { url: url.href, redirectUri, completion, cancel: () => cancel(), submitCallback(value) {
    let returned;
    try {
      if (typeof value !== 'string' || value.length > 8192) throw new Error();
      returned = new URL(value);
      const expected = new URL(redirectUri);
      if (returned.origin !== expected.origin || returned.pathname !== expected.pathname ||
          returned.username || returned.password || returned.hash) throw new Error();
    } catch { throw fault('INVALID_CALLBACK', 'Paste the localhost callback URL from this authorization attempt.'); }
    if (finished || cancellation) throw fault('CALLBACK_USED', 'This authorization attempt is closed.');
    return consume(returned);
  } };
}
