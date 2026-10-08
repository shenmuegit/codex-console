# Native Web Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the approved browser client against the same native app-server used by the extra desktop.
**Architecture:** One Node service authenticates the owner, forwards native RPC through one persistent WebSocket and publishes SSE. Codex owns projects, threads and execution; the browser owns its view and drafts.
**Tech Stack:** Node.js 24, native HTTPS/crypto/WebSocket/fetch/EventSource, `node:test`, `markdown-it` 15.0.2; plain HTML/CSS/ES modules.
**Spec:** [Approved design](../specs/2026-10-07-native-web-client-design.md), approved by the user on 2026-10-08.
**中文:** [Chinese implementation plan](../../zh-CN/superpowers/plans/2026-10-08-native-web-client.md).

Status: approved for Native execution by the user’s continuation on 2026-10-08; implementation runs in the isolated `codex/native-web-client` worktree. Completed steps are checked below.

## Global Constraints

- One owner, one host; initial integration uses same-host loopback `ws://127.0.0.1:4500`.
- Node.js 24; the only runtime package is `markdown-it`. Pin `15.0.2` and commit its lockfile.
- No frontend build tool, desktop IPC adapter, second chat/project database, source patch or Xpra dependency.
- Reuse verified experiment artifacts when present. Current preflight found its temporary build/data directories absent, with Rust still installed: Task 1 must reconstruct the isolated environment from [the pinned build recipe](../../local-app-server-test.md), not substitute an installed backend. Keep the original desktop/backend and active tasks untouched.
- Default `sandbox: "danger-full-access"`, `approvalPolicy: "never"`; turns use native `sandboxPolicy`. Never combine named `permissions` with sandbox fields; honor managed restrictions.
- Default per-file limit 32 MiB = 33,554,432 bytes; obey lower native/model limits.
- Seven-day usage is weekly quota, `windowDurationMins == 10080`, not cost or token activity.
- Latest context is `last.totalTokens`, not accumulated `total.totalTokens`; unavailable stays unavailable.
- Config/TLS/passwords: `~/.config/codex-console-web/`; preferences/uploads: `~/.local/state/codex-console-web/`, respecting XDG overrides. Directories 0700, private files 0600.
- Product UI uses system fonts, native dialogs/pickers/clipboard, visible focus and labels. Desktop three columns; mobile one navigation level at a time. Do not show unfinished action buttons.
- At execution, use `superpowers:using-git-worktrees` to reuse/create an isolated worktree; use branch `codex/native-web-client` if creating a branch. The ignored source checkout/build cache remain at their existing absolute locations.
- Every task updates `docs/native-web-client.md`, `docs/zh-CN/native-web-client.md` and both plans’ completed checkboxes, verifies its deliverable, stages only its files, commits, pushes immediately and verifies remote containment before the next task. First push sets upstream if needed. Preserve all pre-existing dirty files.
- Use TDD for product behavior and the skill's execution/review workflow. Do not build or install dependencies until this written plan is reviewed and an execution method is chosen.

## Review Focus

1. Joining a running thread while snapshot/deltas overlap: native resume ordering and gateway cursors must prevent repeated/lost text. Task 1 and 3 tests.
2. Last page closes or two pages answer one pending request: keep active work alive and consume a native answer exactly once. Task 1–3 tests.
3. Symlink/path replacement, Unicode download names, project rebinding: validate the opened object and retain the thread's actual directory. Task 4–5 tests.
4. Account/model changes during an in-flight quota read: discard the superseded result, keep nulls honest and use the 12,000-token baseline. Task 6 tests.
5. Service paths containing spaces or `%`, and backend restart after an uncertain write: correct unit escaping, no accidental original-backend launch and no write replay. Task 7–8 tests.

## Files and interfaces

| Files | Boundary |
| --- | --- |
| `web/codex.mjs` | Native connection, RPC, frame cursors, thread watchers, pending server requests. |
| `web/auth.mjs`, `web/server.mjs` | Credentials/session checks; HTTPS routes, SSE, web preferences and orchestration. |
| `web/transcript.mjs` | Native-item normalization and safe server-side Markdown; stream text immediately, update safe HTML at most 10 Hz. |
| `web/files.mjs` | Upload lifecycle and transcript-derived download references. |
| `web/public/index.html`, `styles.css`, `app.js` | Login/navigation, projects, settings and page bootstrap. |
| `web/public/chat.js`, `composer.js`, `usage.js` | Chat/cursor state; input/attachments/completions; pure native usage calculations. |
| `web/service.mjs` | Generate/install the two owner user-service units and TLS/config initialization. |
| `web/test/helpers.mjs`, `*.test.mjs` | Built-in Node tests, synthetic WebSocket events and private temporary HTTPS/filesystem fixtures. Never implement a WebSocket frame parser for tests. |
| `docs/native-web-client.md`, `docs/zh-CN/native-web-client.md` | Incremental usage/configuration/verification instructions. |

Shared types: `Cursor = {generation:number, seq:number}`; `RpcResult = {result:JSON, cursor:Cursor}`.
Increment `seq` for every received upstream frame, including responses. SSE sequence gaps are therefore valid; only generation changes or an explicit resync event invalidate a view.

`createCodexClient({url})` produces `rpc(method,params):Promise<RpcResult>`, `retainThread(threadId,viewId):Promise<RpcResult>`, `releaseThread(threadId,viewId):Promise<void>`, `respond(requestKey,answer):Promise<void>`, `onEvent(fn):unsubscribe`, `status():{online:boolean,generation:number,endpoint:string}` and `close():void`. The factory returns a client synchronously; callers wait for an online status event for probes, while the HTTPS service can start and show offline status immediately.
`requestKey` includes the connection generation and original native request ID. A disconnected sent mutation rejects with `outcome:"unknown"`; an unsent call uses `outcome:"not-sent"`.

`createWebServer({config,codex}):https.Server` consumes that client. Server config fields are `origin`, `listenHost`, `port`, `backendUrl`, `tlsCert`, `tlsKey`, `passwordHash`, `stateDir`, `generatedRoots`, `uploadLimitBytes`. The same private file also stores installer fields `repoDir`, `nodePath`, `backendExecutable`, `backendHome`, `workspace`, `environmentFile`. Bootstrap validates them; backend URLs accept loopback WS only.

HTTP boundary (authenticated unless stated; mutations also require exact configured Origin):

| Endpoint | Payload/result |
| --- | --- |
| `POST /api/login`, `/api/logout` | Password → session cookie; logout revokes the session and its views. Login is the sole unauthenticated mutation. |
| `POST /api/view`; `GET /api/events?viewId=…` | Issue a session-bound view ID; SSE envelopes `{cursor,kind,native}` plus safe `status`/`resync` events. |
| `GET /api/status` | Safe backend online/generation/capability state; no tokens or credential paths. |
| `POST /api/rpc` | `{method,params}` → `RpcResult`; fixed read/action allowlist only. Never raw account-token/config/process APIs or raw thread/turn creation/deletion. |
| `POST /api/thread/start`, `/open`, `/send`, `/stop`, `/delete`, `/fork` | Validated native-thread actions defined in Tasks 3–4 and 7; `viewId` binds page ownership. |
| `POST /api/request/respond` | `{requestKey,answer}`; duplicate/stale answers return 409. |
| `POST /api/project/save`, `/archive` | Native name/root registration; archive only changes web preferences. |
| `POST /api/uploads`; `PUT /api/uploads/:id` | Metadata → upload ID; raw bounded bytes → completed descriptor. |
| `GET /api/files/:refId`; `/api/images/:refId` | Only issued transcript/upload references; byte stream or validated image. |
| `GET /api/thread/export?threadId=…` | Authenticated, paginated Markdown export; no host-file write. |

Thread payloads: start `{viewId,projectId?,cwd,name?}`; open `{viewId,threadId}` → `{snapshot,cursor}`; send `{viewId,threadId,draft:{text,selections?,uploadIds?},mode:"start"|"steer"|"queue",model?,effort?,clientUserMessageId}`; stop `{viewId,threadId,turnId}`; delete `{viewId,threadId,confirmed:true}`; fork `{viewId,threadId}`. The service validates selections/upload IDs and builds native inputs; it never accepts arbitrary native turn settings from a browser. A native start/steer race is reported with its actual returned turn ID and effective settings.

Native bindings: `thread/resume` with only `threadId`, `excludeTurns:true`, `initialTurnsPage:{limit:20,sortDirection:"desc",itemsView:"full"}`; history uses `thread/turns/list` with full items and opaque cursors. Create uses `projectId` and the selected root as `cwd`; turns use `{sandboxPolicy:{type:"dangerFullAccess"},approvalPolicy:"never"}`. Steer requires `expectedTurnId`; queue uses `thread/queue/add` and `clientUserMessageId`.

Source authority is commit `ff9ab4a`: `app-server-protocol/src/protocol/{common.rs,v2/thread.rs,v2/turn.rs,v2/item.rs,v2/project.rs,v2/fs.rs,v2/account.rs}`, under the ignored `codex/codex-rs/` checkout. Atomic running-thread resume is documented and implemented in `app-server/src/{thread_state.rs,request_processors/thread_lifecycle.rs}`. Input reference behavior is in `tui/src/{task_mentions.rs,bottom_pane/chat_composer.rs,chatwidget/input_submission.rs}`; context math in `tui/src/token_usage.rs`.

## Task 1: A resilient native client with ordered subscriptions

**Files:** Create `web/package.json`, `web/codex.mjs`, `web/test/helpers.mjs`, `web/test/codex.test.mjs`, `web/test/native-probe.mjs`; create the two operator docs.
**Interfaces:** Produce `createCodexClient` and `RpcResult` above. Test helper `connectedFixture()` returns `{client,peer,flush}`; `peer` can `replyTo(method,result)`, `notify(method,params)`, `request(id,method,params)`, `disconnect()`, and exposes sent JSON objects. It mocks the native WebSocket API with EventTarget, not wire frames. The opt-in `native-probe.mjs --url URL --workspace PATH [--exercise-files]` waits up to 10 s for online status, emits safe read counts and exits nonzero on failure; its file flag creates/deletes only a disposable native thread, checks a private file’s exact bytes and allows at most 180 s for that turn. It is not part of the automatic test glob.

- [x] **1. Write failing tests** for out-of-order responses, notifications versus server requests, native errors/timeouts, reconnect without replay, and generation-scoped answers. Example assertion contract:
  ```js
  const {client,peer,flush} = await connectedFixture();
  const models = client.rpc('model/list', {});
  const account = client.rpc('account/read', {refreshToken:false});
  await flush(); peer.replyTo('account/read', {account:null}); peer.replyTo('model/list', {data:[]});
  assert.deepEqual((await models).result, {data:[]});
  assert.deepEqual((await account).result, {account:null});
  ```
  Add `resume_checkpoint_orders_snapshot_and_deltas`, `active_thread_survives_last_view_close`, `idle_thread_unsubscribes`, and `stale_answer_after_reconnect_is_rejected` with exact sent-message assertions.
- [x] **2. Verify RED:** `node --test web/test/codex.test.mjs`; initially fail with the missing native-client module/export.
- [x] **3. Implement** one persistent connection; `initialize`/`initialized` with `experimentalApi:true`, no attestation capability. RPC timeout 30 s; opening/initialize timeout 10 s; reconnect backoff 0.5–10 s with jitter. Stamp each response with its frame cursor synchronously. Publish a resume snapshot event synchronously before resolving RPC awaiters or processing later frames; async rendering/file enrichment cannot replace newer native text. Every retain obtains native atomic resume; release unsubscribes only with zero watchers and no active turn. Preserve original native errors and never replay mutations.
- [x] **4. Verify GREEN and real reads:** run the test file. Preflight the source commit and binary; if missing, use Rust 1.95.0 and the documented locked dev-small build. Install the verified binary at `~/.local/lib/codex-console-web/bin/codex-app-server` (outside Git), and create `~/.local/state/codex-console-web/integration/{codex-home,desktop-profile,workspace}`. Only copy an existing login snapshot privately (0600), never a chat/account database. Restore only the isolated backend and extra desktop through named transient user units `codex-console-native-backend-test` and `codex-console-native-desktop-test`, using the existing binary/home/profile and loopback port. Pass GUI/proxy/TLS environment only by explicit variable names; secrets stay out of command arguments and tracked files. Run `node web/test/native-probe.mjs --url ws://127.0.0.1:4500 --workspace "$HOME/.local/state/codex-console-web/integration/workspace" --exercise-files`; expect exit 0, initialized read counts and matching private-file bytes, followed by deletion of the probe thread. Record safe results, not account values or logs, in the operator docs.
- [x] **5. Commit/push:** `feat: connect the web client to the shared native app server`; stage Task 1 files and both docs only, push current branch immediately and verify its remote commit before Task 2.

## Task 2: HTTPS owner login and bounded event delivery

**Files:** Create `web/auth.mjs`, `web/server.mjs`, `web/test/auth-server.test.mjs`; extend `web/test/helpers.mjs`; initial `web/public/index.html`, `app.js`, `styles.css` show only login, safe connection status and logout.
**Interfaces:** Consume Task 1. Produce `createWebServer`, `checkOrigin(actual,expected):void`, `hashPassword(password):Promise<string>`, `createAuth({passwordHash,now?})` with `login(password,ip):Promise<{token,expiresAt}>`, `verifySession(token):object|null`, `revoke(token):void`; private `preferences.json = {archivedProjectIds:[],ui:{}}`. Test helper `httpsFixture()` supplies temporary cert/config/server/request helpers without real credentials.

- [x] **1. Write failing tests** for missing/expired cookies, cross-Origin login and mutations, exact cookie flags, session-bound view IDs, unknown RPCs, response-token filtering and slow SSE readers. Assertions include:
  ```js
  assert.throws(() => checkOrigin('https://evil.test','https://127.0.0.1:8443'), {code:'ORIGIN_DENIED'});
  assert.doesNotThrow(() => checkOrigin('https://127.0.0.1:8443','https://127.0.0.1:8443'));
  ```
  Include `two_pages_cannot_answer_one_request_twice` and `logout_closes_only_that_sessions_streams` using Task 1's fake peer.
- [x] **2. Verify RED:** `node --test web/test/auth-server.test.mjs`; fail on missing auth/server behavior.
- [x] **3. Implement** async native scrypt password hashes (`scrypt:<saltBase64>:<keyBase64>`, 16-byte salt, 64-byte key, N=16384/r=8/p=1), maximum password length 256, and random 32-byte session tokens. Absolute session TTL 12 h; login limit five failures/IP/minute with bounded expiry state; JSON body cap 1 MiB. Cookies are HttpOnly/Secure/SameSite=Strict/Path=/; no CORS wildcard. SSE heartbeat 15 s, per-stream queued-byte cap 1 MiB; overflow closes and demands resync. New/reconnected streams require a snapshot. Routes validate method-specific fields; log neither bodies nor tokens.
- [x] **4. Verify GREEN and HTTPS smoke:** run auth/server and native-client tests; confirm unauthenticated API/SSE 401, foreign Origin 403, authenticated fixed status/RPC reads succeed, and a full/stalled reader cannot stall other pages. Only show safe native request schemas; auth refresh/attestation/dynamic-tool requests receive an explicit unsupported-client response, never fabricated credentials.
- [x] **5. Commit/push:** `feat: protect browser access and stream native events`; include both operator docs and verify remote containment before Task 3.

## Task 3: A working browser conversation loop

**Files:** Create `web/transcript.mjs`, `web/public/chat.js`, `web/test/chat.test.mjs`; update server/public files, `web/package.json`, create `web/package-lock.json`.
**Interfaces:** `createChatState(threadId)`, `applyNativeEvent(state,envelope):state`, `installSnapshot(state,{snapshot,cursor}):state`, `buildTurnParams({threadId,input,model?,effort?,clientUserMessageId}):object`; `renderTranscript(thread,turns):{items,html}`. UI state uses item IDs and frame cursors, never text equality for delta deduplication.

- [x] **1. Write failing tests** for duplicated SSE IDs, identical text in distinct deltas, atomic mid-turn joining, history pagination, unknown write outcomes, effective permission display and draft preservation. Example:
  ```js
  const p = buildTurnParams({threadId:'t',input:[{type:'text',text:'测试'}],clientUserMessageId:'m'});
  assert.deepEqual(p.sandboxPolicy, {type:'dangerFullAccess'});
  assert.equal(p.approvalPolicy,'never'); assert.equal('permissions' in p,false);
  ```
  Also assert two distinct sequenced `哈` deltas render `哈哈`, a repeated cursor does not append again, and full completed items replace partial text.
- [x] **2. Verify RED:** `node --test web/test/chat.test.mjs`.
- [x] **3. Implement** project/thread lists and new/open/send/stop/copy ID. Create native threads with full defaults; open uses ordered resume, not a racy read-plus-subscribe. Buffer events until the snapshot cursor, drop older cursors and apply newer ones; generation changes force resync. Page size 20, prepend older pages while retaining scroll anchor. Send accepts the validated draft payload above and builds native input with a stable message UUID; explicit active-turn choices are steer or queue, not automatic replay. Synchronous submit guards and a 10-minute recent-write record capped at 1024 entries (reject excess unresolved writes rather than evicting them) prevent duplicate requests; unknown results remain locked for reconciliation/manual choice.
- [x] **4. Add the sole dependency** with `npm --prefix web install --save-exact markdown-it@15.0.2`. Render Markdown on the server with HTML disabled and URL rules; stream text immediately and coalesce safe-HTML updates to 100 ms. Add CSP, nosniff, safe external-link attributes and XSS assertions. Native approval/input forms follow `v2/item.rs`/`permissions.rs`; decline/unsupported states remain visible, with one generation-scoped responder.
- [x] **5. Verify GREEN and browser/desktop acceptance:** run all current tests; in an isolated real thread send a short reply from the browser, observe it in the extra desktop, send from desktop and observe browser updates, interrupt a disposable turn, copy the exact ID, close/reopen the page during work, and disconnect after an accepted send without an automatic duplicate. Verify the original desktop remains running.
- [x] **6. Commit/push:** `feat: add browser conversations with native live updates`; include bilingual instructions/evidence and confirm remote containment.

Acceptance ruling: no browser/native UI surface is enabled in this environment; the live HTTPS/native protocol probe replaces automated UI clicks here. Clipboard, desktop typing and mobile visual acceptance remain explicitly unverified.

## Task 4: Native workspace lifecycle and safe conversation deletion

**Files:** Update server/public files; create `web/test/projects.test.mjs`.
**Interfaces:** `saveProject(codex,{projectId?,name,rootPath,idempotencyKey}):Promise<Project>`, `setProjectArchived(projectId,archived):Promise<void>`, `deleteThread(codex,{threadId,confirmed}):Promise<void>`; these are dedicated handlers, not unrestricted browser RPC forwarding.

- [x] **1. Write failing tests** for host directory picking/creation, project pagination, preserve-secondary-roots editing, idempotency keys, archive/restore without native deletion, old-thread `cwd` after rebinding, and active-thread deletion. Example:
  ```js
  assert.deepEqual(await fixtureArchive('p'), {archivedProjectIds:['p'],nativeCalls:[]});
  assert.deepEqual(await fixtureUnarchive('p'), {archivedProjectIds:[],nativeCalls:[]});
  ```
  `fixtureArchive`/`fixtureUnarchive` are test-only HTTP helpers in this test file. Assert native delete is not sent before the matching interruption completion or after a timeout/refusal.
- [x] **2. Verify RED:** `node --test web/test/projects.test.mjs`.
- [x] **3. Implement** native project CRUD/list and FS directory APIs. Editing the primary root preserves additional native roots and metadata; existing thread paths are never rewritten. Serialize atomic preference-file writes. Archive affects only web visibility, with explicit UI wording. Confirm thread deletion once, read actual active state, interrupt/wait up to 30 s, then call native `thread/delete`; preserve files and uploads on every path. Do not expose native project deletion.
- [x] **4. Verify GREEN and disposable native lifecycle:** create a private directory/project, create a member thread, rebind the project, verify the old thread path, archive/restore the web list and delete only the disposable thread. Run all current tests and update both docs with the desktop-archive limitation.
- [x] **5. Commit/push:** `feat: manage native projects and delete conversations safely`; verify remote containment.

## Task 5: Files, photos and authenticated transcript downloads

**Files:** Create `web/files.mjs`, `web/public/composer.js`, `web/test/files.test.mjs`; update server/transcript/public modules.
**Interfaces:** `createFiles({stateDir,uploadLimitBytes,generatedRoots})` produces `beginUpload({threadId,name,size,mime})`, `receiveUpload(uploadId,readable)`, `attachmentInputs(ids,threadId)`, `issueTranscriptRefs(thread,turns)`, `openReference(refId)`. Completed descriptors retain original names and stored paths privately; browsers submit IDs, not host upload paths.

- [ ] **1. Write failing tests** for exact 33,554,432-byte cap, one-byte excess, false Content-Length/chunked excess, interruption/ENOSPC cleanup, Unicode names, invalid images, forged IDs and symlink replacement after validation. Assertions include:
  ```js
  assert.equal(await fixtureUploadBytes(33554432), 201);
  assert.equal(await fixtureUploadBytes(33554433), 413);
  assert.equal(await fixtureDownload('../auth.json'), 404);
  ```
  The file's HTTP fixtures allocate streaming chunks, not a disk-filling file. Add `rebound_project_keeps_old_thread_reference` and exact downloaded-byte/name assertions.
- [ ] **2. Verify RED:** `node --test web/test/files.test.mjs`.
- [ ] **3. Implement** metadata then raw-byte upload, exclusive partial files, streamed size checks and cleanup. Mark complete atomically; removing a completed attachment from the draft does not delete historical bytes. Native photo input is `{type:'localImage',path}`; ordinary files are native text paths, quoted using the native composer's path rule. No binary UserInput variant. Preview only validated raster MIME types; active formats download as octet-stream.
- [ ] **4. Implement reference downloads** derived only from native transcript targets/known uploads. Allowed roots are actual thread `cwd`, upload storage and configured generated roots; never use the project's later binding. Realpath, no-follow open and opened-fd/stat checks reject traversal and symlink races. Only issued opaque references reach GET routes; no arbitrary path/URL endpoint. Preserve UTF-8 filenames with Content-Disposition and exact bytes.
- [ ] **5. Verify GREEN and native attachment round trip:** all tests; upload a Unicode-named text file and photo from the browser, verify native thread inputs, generate a small file inside the private test workspace and download it byte-for-byte. Interrupted upload retains the draft/previous completed files. Update both docs.
- [ ] **6. Commit/push:** `feat: upload attachments and download referenced chat files`; verify remote containment.

## Task 6: Native model, context and weekly-usage controls

**Files:** Create `web/public/usage.js`, `web/test/usage.test.mjs`; update server/public modules.
**Interfaces:** `contextUsage(tokenUsage):{tokens,window,remainingPercent,usedPercent}` with nullable values; `weeklyUsage(response):Array<{limitId,usedPercent,remainingPercent,resetsAt}>`. Model options come from native `model/list`, including supported/default effort.

- [ ] **1. Write failing tests** for the fixed native baseline, accumulated-token confusion, null windows, multiple quota buckets, primary-only weekly windows, unsupported efforts, and superseded account reads. Example:
  ```js
  const v = contextUsage({last:{totalTokens:112000},total:{totalTokens:900000},modelContextWindow:200000});
  assert.equal(v.remainingPercent,47); assert.equal(v.tokens,112000);
  assert.equal(contextUsage({last:{totalTokens:5},modelContextWindow:null}).remainingPercent,null);
  ```
  Assert stale account-generation results never repopulate the cleared cache.
- [ ] **2. Verify RED:** `node --test web/test/usage.test.mjs`.
- [ ] **3. Implement** next-turn-only model/effort overrides and actual native-policy/model display. A steer inherits the active turn; do not send model/sandbox fields unsupported by `turn/steer`. Before queueing, apply future defaults with native `thread/settings/update` and await its matching settings notification; queued items use those shared future defaults, not invented per-item settings. Display that subsequent setting changes can affect queued work, and never use running-turn `turn/settings/update` for this selector. Context formula: window ≤ 12000 → remaining 0; otherwise round/clamp `100 * max(0,(window-12000)-max(0,last.totalTokens-12000))/(window-12000)`. Unknown window remains null. Merge native quota notifications or refetch; select duration 10080 in either window, separate buckets, compute remaining `max(0,100-usedPercent)`, and convert reset seconds correctly. Account changes invalidate older requests/caches.
- [ ] **4. Verify GREEN and native settings/usage:** all tests; select two supported efforts, verify the next native turn settings while preserving drafts, trigger compaction in a disposable thread, verify context refresh, and read real weekly metadata without committing its values. UI missing-data tests use explicit null fixtures. Update both docs.
- [ ] **5. Commit/push:** `feat: expose native models context and weekly usage`; verify remote containment.

## Task 7: Native references, skills and slash actions

**Files:** Update composer/server/transcript/public modules; create `web/test/composer.test.mjs`.
**Interfaces:** `encodeComposer({text,selections,uploads,threadId,mode}):{input,additionalContext?}`, `utf8Range(text,start,end):{start,end}`, `commandAction(text):{command,args}|null`. These functions use native encodings, not a generic mention or command RPC.

- [ ] **1. Write failing tests** for Chinese/emoji offsets, composition confirmation, literal code/email/`$HOME`, paths with spaces, typed skill/plugin/app inputs, self/duplicate thread references, invalid split-surrogate ranges, and slash mappings. Example:
  ```js
  assert.deepEqual(utf8Range('中😀x',1,3), {start:3,end:7});
  assert.equal(commandAction('mail/a@b /new'),null);
  ```
  Also pin `text_elements` (snake case) containing `{byteRange:{start,end},placeholder}` (camel case inside), not `textElements`.
- [ ] **2. Verify RED:** `node --test web/test/composer.test.mjs`.
- [ ] **3. Implement** skill discovery (`skills/list`, workspace scoped), native `{type:'skill',name,path}`, app/plugin catalogs and `{type:'mention',name,path:'app://…'|'plugin://…'}`. Files/directories insert native quoted text paths. Thread references use escaped `[@title](thread://id)` and UTF-8 TextElements; exclude self/duplicates, max 16 references and 768 ID bytes, native title cap 160 characters.
- [ ] **4. Add bounded read-only referenced context:** read only selected native threads at send time; max 8 KiB UTF-8 per thread and 32 KiB total, mark truncation. Start/steer use native `additionalContext` entries `{kind:'untrusted',value:quotedSnapshot}`. Queue/add has no such field: use a separate native text item with a JSON-quoted `<untrusted_text>` snapshot and label this as a send-time snapshot. Do not inject a nonexistent `read_thread` tool/instruction or send messages to referenced threads.
- [ ] **5. Implement the exact slash catalog** from the spec: new/model/permissions/status/usage/skills UI actions; compact/name-set/archive/delete native actions and dedicated `/api/thread/fork` with full defaults; `/export` streams a paginated Markdown export. Use existing confirmation rules, no `commands/list`. IME Enter never submits/selects; Enter sends, Shift+Enter inserts newline; changing model/menu retains drafts.
- [ ] **6. Verify GREEN and real references:** all tests; on disposable threads select a real skill, file, app/plugin if available, and another thread; inspect native input/history and context, including queue mode. Execute each supported slash action and compare effects. Unsupported native catalog entries are visibly unavailable, not fabricated. Update both docs.
- [ ] **7. Commit/push:** `feat: add native mentions skills and slash actions`; verify remote containment.

## Task 8: Durable startup, mobile acceptance and release review

**Files:** Create `web/service.mjs`, `web/test/service.test.mjs`; finish public layout and the two operator docs. Installed units/config/certs/data are generated outside Git.
**Interfaces:** `renderUserUnits({repoDir,nodePath,backendExecutable,backendHome,workspace,configPath,environmentFile}):{backend,web}`; CLI `node web/service.mjs init|install|start|stop|status` manages only `codex-console-native-backend.service` and `codex-console-native-web.service` for this owner. `init --origin URL --backend-bin PATH --backend-home PATH --workspace PATH [--cert PATH --key PATH]` writes private config; all commands accept `--config PATH` with an XDG default.

- [ ] **1. Write failing tests** for spaces/Unicode/percent signs in unit paths, missing binary/cert, config ownership, refusal to replace the original desktop/backend, offline status and redacted status output. Assertions include no reference to `console.sh`/Xpra, exact explicit backend/home and correct systemd escaping; stopping these units never stops the original app.
- [ ] **2. Verify RED:** `node --test web/test/service.test.mjs`.
- [ ] **3. Implement** native user units with Restart=on-failure, private umask and the configured source binary/home. Web startup does not spawn a fallback engine. Units use the verified persistent binary installed in Task 1, not a cache target. Initialize owner password/hash and TLS material privately using Node crypto and installed OpenSSL; SAN matches the configured host/IP. Default preview is loopback HTTPS port 8443 (choose another configured free port on conflict); non-loopback access requires configured HTTPS origin/cert. Never overwrite existing credentials or print secrets in status/logs. Retain only required proxy/TLS variables in a private EnvironmentFile, excluding API-key/task-runtime overrides. Before permanent startup, stop only Task 1’s recorded transient test units; never kill an unidentified process holding the port.
- [ ] **4. Run complete checks:** `node --test web/test/*.test.mjs`, `npm --prefix web audit --omit=dev`, changed-file syntax/diff checks. Repair failures before claiming success. Use the browser tool for login, project/thread lifecycle, sending/steering/stopping, native forms, model/usage, copy ID, file/photo/download, mentions/skills/commands, reconnect/unknown outcomes and logout. Inspect responsive layouts at 390×844 and 1280×820; exercise a real mobile IME/picker/clipboard/download when available and explicitly record any unavailable hardware check.
- [ ] **5. Verify durable operation and documentation:** start only the test units, end the launching shell/session, verify readiness and desktop/client state again. Restart the web/backend separately and confirm authoritative resync with no automatic write replay. Document exact start/stop/status, private paths, archive scope, trust/cert setup, active-work limitations and rollback. Keep an implementation worktree while a unit references its code path; do not archive it until deployment paths are moved and reverified. Save runtime proofs/screenshots outside Git.
- [ ] **6. Request the chosen workflow's final fresh review**, repair findings, repeat only affected checks and review changed diff/staging. Do not move the original desktop onto this backend without a separate migration instruction.
- [ ] **7. Commit/push:** `feat: package the native browser client for durable owner access`; stage only owned files, push immediately and verify remote containment. Deliver the authenticated client URL, verified scope/limits, commit/push status and screenshots without credentials.

## Plan review and execution choice

Self-review: every spec feature maps to Tasks 1–8; the five Review Focus cases have
explicit owning tests; shared names/types above are consistent. Runtime proofs
remain future acceptance checks. No product code was created while writing this plan.

Recommended execution is **Native**: the tasks share a small RPC/router/input
surface and are mostly sequential, so one implementer preserves context with less
coordination cost. The final fresh reviewer still checks the complete result.
Alternative **Subagent-driven** uses a fresh implementer and reviewer per task,
then a whole-branch review; it costs more contexts and provides earlier independent
checks. Obtain the user's written-plan review and method choice before execution.

Package version was checked through npm metadata and the [official package manifest](https://raw.githubusercontent.com/markdown-it/markdown-it/master/package.json) on 2026-10-08; dependency installation belongs to Task 3, not this planning turn.
