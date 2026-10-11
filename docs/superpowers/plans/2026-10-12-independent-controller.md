# Independent Codex Controller Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Our server accepts official host pairing codes and lets our Web control multiple Codex hosts without a server desktop Codex process.

**Architecture:** Add a server-owned controller next to the existing native Web backend. Reuse its Codex JSON-RPC client and authenticated Web routes; keep controller credentials and the protected-key component outside Git. Use the official relay with separate streams per host.

**Tech Stack:** Node.js 24, existing Node test runner and HTTPS Web server, native protected-key component; add a WebSocket dependency only if no existing transport can supply required headers.

**Spec:** `docs/superpowers/specs/2026-10-12-independent-controller.md`

## Global Constraints

- Web → our server → controlled Codex clients, including the official desktop.
- The owner supplies the controlled client's code; the server submits it.
- No running server desktop Codex application and no per-device SSH commands.
- Application data, keys, passwords, tokens, and account identifiers stay outside Git.
- Preserve ordinary login, other device identities, existing sessions, and unrelated work.
- Same ChatGPT account/workspace; different project directories are allowed.
- Each independent change is verified, committed, pushed, and confirmed remotely before the next.
- Live official-client and concurrent-host evidence is required for completion.

## Review Focus

- A copied callback from another browser must retain PKCE/state and cannot trigger arbitrary URL fetching.
- Cancellation or disk failure must not leave a falsely registered controller or delete another controller's key.
- Changed account or missing protected key must fail closed before code claiming or relay connection.
- Duplicate/chunked/reordered relay frames must not mix hosts, repeat commands, or grow memory without a bound.
- A remote project path, approval, upload, or event must retain its host identity across selection and reconnect.

---

### Task 1: Independent browser authorization

**Files:** Create `web/remote-auth.mjs`, `web/test/remote-auth.test.mjs`, `docs/controller.md`, `docs/zh-CN/controller.md`.

**Interfaces:** `startRemoteAuthorization({accountId, fetchToken = fetch, timeoutMs = 600000, signal})` returns `{url, redirectUri, completion, submitCallback(url), cancel()}`. `completion` resolves to a step-up access token; it never launches an application or writes credentials.

- [ ] Write failing tests for callback state/code rejection, PKCE token exchange, copied callback origin/path rejection, replay, OAuth rejection, cancellation, timeout, and fallback when port 1455 is occupied.
- [ ] Run `node --test test/remote-auth.test.mjs`; expected: missing authorization behavior fails.
- [ ] Implement the observed authorization-code flow using Node crypto/http; bind loopback ports 1455/1457, keep the verifier on the server, accept copied localhost callback data without fetching its URL, and close all resources on completion/cancellation.
- [ ] Run the focused tests and `npm test`; expected: all pass. Document the one-time owner action and remaining live verification.
- [ ] Inspect/stage only this task's files, including the plan/spec; commit, push, and confirm the remote commit.

### Task 2: Protected enrollment and code claiming

**Files:** Create `web/remote-controller.mjs`, `web/test/remote-controller.test.mjs`; update both controller documents.

**Interfaces:** `createRemoteController({authFile, stateDir, deviceKey, fetch = globalThis.fetch})` returns controller methods `status()`, `startAuthorization()`, `submitCallback(url)`, `pair(code)`, `listHosts()`, `session()`, `close()`. Authorization uses Task 1; deviceKey implements create/get/sign/delete against the native component. `session()` returns the server enrollment and validated relay session for Task 3, never for browser serialization.

- [ ] Write/run failing tests for challenge account/purpose/origin/path binding, account/scope/freshness checks, atomic state persistence, cleanup failure, missing/mismatched keys, and rejection of code claiming before enrollment. Expected: missing controller behavior fails.
- [ ] Implement own-key enrollment/refresh, exact canonical proof serialization, independent signature verification, atomic private state, code normalization, and host listing. Delete only a candidate created by this operation.
- [ ] Run focused tests and `npm test`; expected: all pass. Run the native key adapter guard check using an isolated temporary key; expected: sign/verify/delete succeeds.
- [ ] Document runtime prerequisites and the software-vTPM limit; commit, push, and confirm remotely.

### Task 3: Relay streams and native RPC

**Files:** Create `web/remote-relay.mjs`, `web/test/remote-relay.test.mjs`; modify `web/codex.mjs`, `web/test/codex.test.mjs`, and both controller documents.

**Interfaces:** `createRemoteRelay({controller, openWebSocket})` returns `openHost(envId)` as a WebSocket-compatible host stream and `close()`. Extend `createCodexClient` with an internal socket factory while keeping existing loopback URL validation. One native client belongs to one host.

- [ ] Write/run failing tests for token-bound device proof, invalid challenges, two independent host streams, response/approval routing, duplicate frames, chunk bounds, disconnect outcomes, and fresh initialization after reconnect.
- [ ] Implement protocol-v3 client headers, session-token/device-key proof, host envelopes/acks/pings, bounded chunk handling, and native-client transport injection. Never silently replay a mutation after connection loss.
- [ ] Run focused tests and `npm test`; expected: all pass. Commit, push, and confirm remotely.

### Task 4: Web control and live interoperability

**Files:** Modify `web/server.mjs`, `web/service.mjs`, `web/public/index.html`, `web/public/app.js`, and existing styles only as needed; create `web/public/connections.js` and corresponding Web tests; update English/Chinese controller and service documentation.

**Interfaces:** Owner-authenticated `/api/controller/*` routes provide status, authorization start/callback submission, code pairing, and hosts. Host selection routes to its own native client and preserves view/cursor/approval identity. Credentials remain server-side.

- [ ] Write/run failing authenticated-route and host-isolation tests, including cross-origin calls, account change, callbacks, two hosts with colliding thread/request IDs, stale events, remote filesystem handling, and existing local behavior.
- [ ] Implement controller configuration, connection setup UI, host pool and routing, and necessary remote path/upload handling. Reuse existing auth, native state, and interface components.
- [ ] Run `npm test` and browser verification; expected: setup/status/code input and local/remote selection work without credential disclosure or local regressions.
- [ ] Start the isolated server configuration; obtain owner confirmation through its Web authorization flow, then claim a fresh controlled-host code. Expected: official service accepts enrollment/pairing; remote read/write/event checks pass.
- [ ] Validate two independent controlled endpoints and reconnect. Expected: concurrent commands and notifications stay with their host; no duplicate mutation.
- [ ] Review the whole branch, fix meaningful findings with regression tests, document observed compatibility and limits, commit/push/confirm, and integrate the verified service while preserving other work.

Only mark the overall goal complete after every live gate above is satisfied.
