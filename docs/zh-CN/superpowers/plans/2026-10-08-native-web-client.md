# 原生浏览器客户端实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付已批准的浏览器客户端，与额外桌面使用同一个原生 app-server。
**Architecture:** 一个 Node 服务验证用户，以持久 WebSocket 转发原生 RPC，以 SSE 推送事件。项目、线程和执行由 Codex 持有，网页管理视图与草稿。
**Tech Stack:** Node.js 24、原生 HTTPS/crypto/WebSocket/fetch/EventSource、`node:test`、`markdown-it` 15.0.2；普通 HTML/CSS/ES 模块。
**Spec:** [已批准设计](../specs/2026-10-07-native-web-client-design.md)，用户于 2026-10-08 批准。
**English:** [English implementation plan](../../../superpowers/plans/2026-10-08-native-web-client.md)。

状态：用户于 2026-10-08 通过“继续”批准按推荐的 Native 方式执行；在隔离 `codex/native-web-client` 工作树实现，已完成步骤在下方勾选。

## Global Constraints / 全局约束

- 单用户、单主机，初始连接同机回环 `ws://127.0.0.1:4500`。
- Node.js 24；唯一运行依赖为 `markdown-it`，固定 `15.0.2` 并提交锁文件。
- 不增加前端构建工具、桌面 IPC 适配器、第二套项目/聊天库、源码补丁或 Xpra 依赖。
- 实验产物存在时复用；本轮前置检查发现临时产物/数据目录已不在，Rust 已安装。任务 1 按[固定编译步骤](../../local-app-server-test.md)重建独立环境，不替换为安装包后端；保留原桌面、原后端和活动任务。
- 默认 `sandbox: "danger-full-access"`、`approvalPolicy: "never"`，轮次使用原生 `sandboxPolicy`。命名 `permissions` 不与 sandbox 字段并用；服从托管限制。
- 默认单文件 32 MiB = 33,554,432 字节，遵循更低的原生/模型限制。
- 七天使用量为周额度，`windowDurationMins == 10080`，不是费用或 token 活动。
- 最新上下文是 `last.totalTokens`，不是累计 `total.totalTokens`；不可用不伪装为 0。
- 配置/TLS/密码在 `~/.config/codex-console-web/`，偏好/上传在 `~/.local/state/codex-console-web/`，遵循 XDG；目录 0700、私有文件 0600。
- 系统字体、原生对话框/选择器/剪贴板、可见焦点和标签；桌面三栏、手机逐级导航，不展示未实现按钮。
- 执行阶段按 `superpowers:using-git-worktrees` 复用/创建隔离工作树；需要新分支时使用 `codex/native-web-client`。忽略的源码目录和编译缓存沿用现有绝对路径。
- 每项任务同步 `docs/native-web-client.md`、`docs/zh-CN/native-web-client.md` 和两份计划的完成勾选，验证后仅暂存本任务文件、commit、立即 push 并确认远端包含，随后才开始下一项；首次推送按需设置 upstream，保留全部既有未提交改动。
- 行为实现遵循 TDD 和所选执行/审查流程；书面计划审核并选择执行方式前，不编写产品代码或安装依赖。

## Review Focus / 重点审查

1. 运行中加入线程，快照与增量相交：复用原生 resume 顺序与服务游标，避免重复/漏字；任务 1、3。
2. 最后页面关闭、两个页面同时回答一个原生请求：活动任务继续，应答只消费一次；任务 1–3。
3. 符号链接/路径替换、中文文件名、项目改绑定：验证打开后的对象，保留线程真实目录；任务 4–5。
4. 额度读取未返回时切账号/模型：丢弃旧结果，保留 null，使用 12,000-token 基线；任务 6。
5. 服务路径有空格或 `%`、写入不确定后后端重启：正确转义 unit，不误启动原后端，不重放写入；任务 7–8。

## 文件与接口

| 文件 | 边界 |
| --- | --- |
| `web/codex.mjs` | 原生连接/RPC、帧游标、线程订阅、原生待应答请求。 |
| `web/auth.mjs`、`web/server.mjs` | 凭据/会话校验，HTTPS 路由、SSE、网页偏好与编排。 |
| `web/transcript.mjs` | 原生消息归一化和服务端安全 Markdown；文本立即推送，安全 HTML 最多每秒 10 次。 |
| `web/files.mjs` | 上传生命周期与从聊天生成的下载引用。 |
| `web/public/index.html`、`styles.css`、`app.js` | 登录/导航、项目、设置和页面启动。 |
| `web/public/chat.js`、`composer.js`、`usage.js` | 聊天/游标状态；输入/附件/补全；原生用量的纯计算。 |
| `web/service.mjs` | 生成/安装两个属主用户服务及 TLS/配置初始化。 |
| `web/test/helpers.mjs`、`*.test.mjs` | 内置 Node 测试、合成 WebSocket 事件、私有临时 HTTPS/文件样本；不为测试手写 WebSocket 帧解析器。 |
| `docs/native-web-client.md`、`docs/zh-CN/native-web-client.md` | 分阶段使用、配置、验证说明。 |

共享类型：`Cursor = {generation:number, seq:number}`，`RpcResult = {result:JSON, cursor:Cursor}`。
每个后端帧（包括响应）递增 `seq`；SSE 序号跳跃合法，只有代次变化或显式 resync 事件使视图失效。

`createCodexClient({url})` 提供 `rpc(method,params):Promise<RpcResult>`、`retainThread(threadId,viewId):Promise<RpcResult>`、`releaseThread(threadId,viewId):Promise<void>`、`respond(requestKey,answer):Promise<void>`、`onEvent(fn):unsubscribe`、`status():{online:boolean,generation:number,endpoint:string}`、`close():void`。工厂同步返回客户端，探针等待在线状态事件；HTTPS 服务可立即启动并显示离线状态。
`requestKey` 包含连接代次与原生请求 ID；已发送的写入断线后以 `outcome:"unknown"` 拒绝，未发送为 `outcome:"not-sent"`。

`createWebServer({config,codex}):https.Server` 使用上述客户端。服务器配置字段为 `origin`、`listenHost`、`port`、`backendUrl`、`tlsCert`、`tlsKey`、`passwordHash`、`stateDir`、`generatedRoots`、`uploadLimitBytes`；同一私有文件保存安装字段 `repoDir`、`nodePath`、`backendExecutable`、`backendHome`、`workspace`、`environmentFile`。启动验证，后端只接受回环 WS。

HTTP 边界：除注明外均需认证，写入还须匹配配置的 Origin。

| 入口 | 输入/结果 |
| --- | --- |
| `POST /api/login`、`/api/logout` | 密码换 Cookie；退出撤销会话及其视图。登录是唯一未认证写入。 |
| `POST /api/view`；`GET /api/events?viewId=…` | 签发绑定登录会话的视图 ID；SSE 为 `{cursor,kind,native}`，另有安全 status/resync。 |
| `GET /api/status` | 后端在线/代次/能力，不返回令牌或凭据路径。 |
| `POST /api/rpc` | `{method,params}` → `RpcResult`，固定读取/动作白名单；不透传令牌/配置/进程 API，也不直接透传线程/轮次新建或删除。 |
| `POST /api/thread/start`、`/open`、`/send`、`/stop`、`/delete`、`/fork` | 任务 3–4、7 定义的原生线程操作，`viewId` 绑定页面属主。 |
| `POST /api/request/respond` | `{requestKey,answer}`，重复/过期应答返回 409。 |
| `POST /api/project/save`、`/archive` | 原生名称/目录登记；归档仅修改网页偏好。 |
| `POST /api/uploads`；`PUT /api/uploads/:id` | 元数据换上传 ID；受限原始字节换完成描述。 |
| `GET /api/files/:refId`、`/api/images/:refId` | 仅已签发的聊天/上传引用，返回字节或已验证图片。 |
| `GET /api/thread/export?threadId=…` | 认证后分页导出 Markdown，不在主机写文件。 |

线程请求：start `{viewId,projectId?,cwd,name?}`；open `{viewId,threadId}` → `{snapshot,cursor}`；send `{viewId,threadId,draft:{text,selections?,uploadIds?},mode:"start"|"steer"|"queue",model?,effort?,clientUserMessageId}`；stop `{viewId,threadId,turnId}`；delete `{viewId,threadId,confirmed:true}`；fork `{viewId,threadId}`。服务端验证选择项/上传 ID 并生成原生输入，不接受任意原生轮次设置；原生 start/steer 竞态按实际返回的轮次 ID 与生效设置显示。

原生绑定：`thread/resume` 仅传 `threadId`、`excludeTurns:true`、`initialTurnsPage:{limit:20,sortDirection:"desc",itemsView:"full"}`；旧历史用 `thread/turns/list`、完整 items 和不透明游标。创建传 `projectId` 和选定根目录 `cwd`；轮次传 `{sandboxPolicy:{type:"dangerFullAccess"},approvalPolicy:"never"}`。steer 必须有 `expectedTurnId`，queue 用 `thread/queue/add` 和 `clientUserMessageId`。

依据固定源码 `ff9ab4a`：忽略目录 `codex/codex-rs/` 下的 `app-server-protocol/src/protocol/{common.rs,v2/thread.rs,v2/turn.rs,v2/item.rs,v2/project.rs,v2/fs.rs,v2/account.rs}`。运行中原子 resume 在 `app-server/src/{thread_state.rs,request_processors/thread_lifecycle.rs}`；输入在 `tui/src/{task_mentions.rs,bottom_pane/chat_composer.rs,chatwidget/input_submission.rs}`；上下文口径在 `tui/src/token_usage.rs`。

## 任务 1：具备顺序订阅和重连的原生客户端

**文件：** 新建 `web/package.json`、`web/codex.mjs`、`web/test/helpers.mjs`、`web/test/codex.test.mjs`、`web/test/native-probe.mjs` 及两份使用文档。
**接口：** 提供上文 `createCodexClient`、`RpcResult`。测试辅助 `connectedFixture()` 返回 `{client,peer,flush}`，peer 支持 `replyTo(method,result)`、`notify(method,params)`、`request(id,method,params)`、`disconnect()` 和已发送 JSON 数组，以 EventTarget 模拟原生 API，不模拟帧协议。显式运行 `native-probe.mjs --url URL --workspace PATH [--exercise-files]`，最多等 10 秒在线、输出安全读取计数，失败退出非零；文件选项只建/删临时原生线程，核对私有文件字节，轮次最多 180 秒；不纳入自动测试 glob。

- [x] **1. 写失败测试：** 乱序响应、通知/服务端请求区分、原生错误/超时、重连不重放、代次应答。断言示例：
  ```js
  const {client,peer,flush} = await connectedFixture();
  const models = client.rpc('model/list', {});
  const account = client.rpc('account/read', {refreshToken:false});
  await flush(); peer.replyTo('account/read', {account:null}); peer.replyTo('model/list', {data:[]});
  assert.deepEqual((await models).result, {data:[]});
  assert.deepEqual((await account).result, {account:null});
  ```
  增加 `resume_checkpoint_orders_snapshot_and_deltas`、`active_thread_survives_last_view_close`、`idle_thread_unsubscribes`、`stale_answer_after_reconnect_is_rejected`，检查准确的原生发送序列。
- [x] **2. 确认 RED：** `node --test web/test/codex.test.mjs`，初始因缺少模块/导出失败。
- [x] **3. 最小实现：** 一个持久连接，`initialize`/`initialized`、`experimentalApi:true`，不声明 attestation。RPC 30 秒、连接/初始化 10 秒，0.5–10 秒带抖动退避。同步给每个响应记录帧游标；resume 快照事件在唤醒 RPC 等待者或处理后续帧之前同步发布，异步渲染/文件补充不能覆盖较新的原生文本；每次 retain 获取原生原子快照，零查看者且无活动任务时才 unsubscribe；保留原生错误，不重放写入。
- [x] **4. 确认 GREEN 与真实读取：** 跑测试；检查固定源码与产物，缺失时用 Rust 1.95.0 和文档中的 locked dev-small 配方重建，验证后安装到 Git 外的 `~/.local/lib/codex-console-web/bin/codex-app-server`；建立 `~/.local/state/codex-console-web/integration/{codex-home,desktop-profile,workspace}`，仅私有复制已有登录快照（0600），不复制聊天/账号数据库；用命名临时用户服务 `codex-console-native-backend-test`、`codex-console-native-desktop-test` 和现有产物/数据/配置、回环端口恢复独立后端与额外桌面；GUI/代理/TLS 环境仅明确按变量名传递，秘密不进命令参数或跟踪文件。执行 `node web/test/native-probe.mjs --url ws://127.0.0.1:4500 --workspace "$HOME/.local/state/codex-console-web/integration/workspace" --exercise-files`，预期退出 0、读取握手计数及匹配私有文件字节，再删除探针线程；两份文档记录安全结果，不记录账号值或日志。
- [x] **5. 提交推送：** `feat: connect the web client to the shared native app server`，仅暂存本任务文件和双语说明，立即推送当前分支并确认远端包含后进入任务 2。

## 任务 2：HTTPS 登录与有界事件推送

**文件：** 新建 `web/auth.mjs`、`web/server.mjs`、`web/test/auth-server.test.mjs`，扩展测试 helpers；初始 `web/public/index.html`、`app.js`、`styles.css` 仅显示登录、安全连接状态及退出。
**接口：** 使用任务 1；提供 `createWebServer`、`checkOrigin(actual,expected):void`、`hashPassword(password):Promise<string>`、`createAuth({passwordHash,now?})` 的 `login(password,ip):Promise<{token,expiresAt}>`、`verifySession(token):object|null`、`revoke(token):void`，私有 `preferences.json = {archivedProjectIds:[],ui:{}}`；`httpsFixture()` 提供临时证书/配置/服务器/请求辅助，不用真实凭据。

- [x] **1. 写失败测试：** 无/过期 Cookie、跨来源登录/写入、Cookie 标志、视图绑定、未知 RPC、令牌过滤和慢 SSE。断言示例：
  ```js
  assert.throws(() => checkOrigin('https://evil.test','https://127.0.0.1:8443'), {code:'ORIGIN_DENIED'});
  assert.doesNotThrow(() => checkOrigin('https://127.0.0.1:8443','https://127.0.0.1:8443'));
  ```
  通过任务 1 的 peer 测 `two_pages_cannot_answer_one_request_twice`、`logout_closes_only_that_sessions_streams`。
- [x] **2. 确认 RED：** `node --test web/test/auth-server.test.mjs`。
- [x] **3. 最小实现：** 异步原生 scrypt（`scrypt:<saltBase64>:<keyBase64>`，盐 16 字节、键 64 字节、N=16384/r=8/p=1），密码最长 256，随机 32 字节会话令牌，绝对有效期 12 小时；每 IP 每分钟最多五次失败，限速状态有上限且过期清理；JSON 上限 1 MiB。Cookie 为 HttpOnly/Secure/SameSite=Strict/Path=/，无通配 CORS。SSE 每 15 秒心跳，单流积压上限 1 MiB，超限断开要求重同步，新/重连流必须取快照。按方法验证字段，不记录请求体和令牌。
- [x] **4. 确认 GREEN 与 HTTPS：** 跑认证/服务器/原生测试，验证 API/SSE 未登录 401、跨来源 403、认证读取成功、慢接收端不拖住其他页面。只发布安全原生请求 schema；账号刷新、attestation、动态工具请求明确回复客户端不支持，绝不伪造凭据。
- [x] **5. 提交推送：** `feat: protect browser access and stream native events`，同步双语说明，确认远端包含后进入任务 3。

## 任务 3：可用的浏览器聊天闭环

**文件：** 新建 `web/transcript.mjs`、`web/public/chat.js`、`web/test/chat.test.mjs`；更新服务器/页面/`web/package.json`，新建 `web/package-lock.json`。
**接口：** `createChatState(threadId)`、`applyNativeEvent(state,envelope):state`、`installSnapshot(state,{snapshot,cursor}):state`、`buildTurnParams({threadId,input,model?,effort?,clientUserMessageId}):object`、`renderTranscript(thread,turns):{items,html}`。按原生 item ID 与帧游标更新，不按文本相等去重。

- [x] **1. 写失败测试：** 重复 SSE ID、不同事件的相同文字、运行中原子接入、分页、不确定写入、实际权限和草稿保留。示例：
  ```js
  const p = buildTurnParams({threadId:'t',input:[{type:'text',text:'测试'}],clientUserMessageId:'m'});
  assert.deepEqual(p.sandboxPolicy, {type:'dangerFullAccess'});
  assert.equal(p.approvalPolicy,'never'); assert.equal('permissions' in p,false);
  ```
  两个不同游标的 `哈` 应是 `哈哈`，重复游标不能追加，完成 item 的全文替换增量文本。
- [x] **2. 确认 RED：** `node --test web/test/chat.test.mjs`。
- [x] **3. 最小实现：** 项目/会话列表、新建/打开/发送/停止/复制 ID；新线程带最大授权。打开走顺序 resume；快照未返回先缓冲事件，丢弃旧游标并应用新游标，代次变化重同步。每页 20 条，前插旧页保留滚动锚点。按上述验证后的草稿生成原生输入及稳定消息 UUID，活动轮次明确选择 steer 或 queue，不自动重放。同步提交锁和最多 1024 条的 10 分钟近期写入记录（未决写入超额时拒绝新增，不淘汰未决记录）防重；不确定结果等待核对/人工选择。
- [x] **4. 安装唯一依赖：** `npm --prefix web install --save-exact markdown-it@15.0.2`。服务端禁用 HTML、验证 URL，立即推文字、100 毫秒合并安全 HTML 更新。添加 CSP、nosniff、安全外链属性与 XSS 断言。原生应答表单按 `v2/item.rs`/`permissions.rs`，拒绝/不支持须可见，每个代次请求只有一个应答者。
- [x] **5. 确认 GREEN 与双端：** 跑当前全部测试；浏览器发短回复、额外桌面显示，桌面发送、网页更新，中断临时轮次，复制真实 ID；运行中关闭/重开网页，接受写入后断线不得自动重复。确认原桌面仍运行。
- [x] **6. 提交推送：** `feat: add browser conversations with native live updates`，同步双语说明/证据并确认远端。

验收裁定：当前环境未启用浏览器/原生界面控制，以真实 HTTPS 和原生协议探针替代自动界面点击；剪贴板、桌面键盘操作及手机视觉验收明确尚未验证。

## 任务 4：原生工作目录生命周期与安全删除会话

**文件：** 更新服务端/页面，新建 `web/test/projects.test.mjs`。
**接口：** `saveProject(codex,{projectId?,name,rootPath,idempotencyKey}):Promise<Project>`、`setProjectArchived(projectId,archived):Promise<void>`、`deleteThread(codex,{threadId,confirmed}):Promise<void>`；使用专用 handler，不放开任意浏览器 RPC。

- [ ] **1. 写失败测试：** 主机目录选择/创建、项目分页、编辑保留次级根目录、幂等键、归档不做原生删除、改绑定不改旧 `cwd`、运行中删除。示例：
  ```js
  assert.deepEqual(await fixtureArchive('p'), {archivedProjectIds:['p'],nativeCalls:[]});
  assert.deepEqual(await fixtureUnarchive('p'), {archivedProjectIds:[],nativeCalls:[]});
  ```
  此测试文件定义 HTTP 辅助 `fixtureArchive`/`fixtureUnarchive`；断言匹配的中断完成前、超时/拒绝后都不发送原生 delete。
- [ ] **2. 确认 RED：** `node --test web/test/projects.test.mjs`。
- [ ] **3. 最小实现：** 原生项目 CRUD/list 与 FS 目录 API；仅改主根目录，保留其他 roots/metadata，不改旧线程路径。偏好串行原子写入；明确归档仅网页可见。会话删除确认一次，读真实活动状态、中断并最多等 30 秒后才 `thread/delete`；所有路径保留项目文件/上传，不开放原生项目删除。
- [ ] **4. 确认 GREEN 与原生：** 建私有临时目录/项目及成员会话，改绑定验证旧路径，网页归档/恢复，仅删除临时线程；跑全部当前测试，双语记录桌面归档限制。
- [ ] **5. 提交推送：** `feat: manage native projects and delete conversations safely`，确认远端包含。

## 任务 5：文件、照片与聊天文件下载

**文件：** 新建 `web/files.mjs`、`web/public/composer.js`、`web/test/files.test.mjs`，更新服务端/聊天/页面模块。
**接口：** `createFiles({stateDir,uploadLimitBytes,generatedRoots})` 提供 `beginUpload({threadId,name,size,mime})`、`receiveUpload(uploadId,readable)`、`attachmentInputs(ids,threadId)`、`issueTranscriptRefs(thread,turns)`、`openReference(refId)`。完成描述私有保存原名/路径，浏览器提交 ID，不提交主机上传路径。

- [ ] **1. 写失败测试：** 精确 33,554,432 字节、超一字节、伪 Content-Length/分块超限、中断/ENOSPC 清理、中文名称、无效图片、伪造 ID、验证后符号链接替换。示例：
  ```js
  assert.equal(await fixtureUploadBytes(33554432), 201);
  assert.equal(await fixtureUploadBytes(33554433), 413);
  assert.equal(await fixtureDownload('../auth.json'), 404);
  ```
  HTTP 样本流式供块，不填满真实磁盘；添加 `rebound_project_keeps_old_thread_reference` 及名称/字节断言。
- [ ] **2. 确认 RED：** `node --test web/test/files.test.mjs`。
- [ ] **3. 最小实现：** 元数据、原始字节、排他半文件、流式上限与清理，原子标记完成；草稿移除完成附件不删历史文件。图片为 `{type:'localImage',path}`，普通文件按原生输入框路径规则作为文本引用，不造二进制 UserInput。仅预览验证过的光栅图片，活动格式作为 octet-stream 下载。
- [ ] **4. 下载实现：** 只从原生聊天目标/已知上传签发引用，根目录为线程实际 `cwd`、上传目录和配置生成目录，不能用项目后续绑定。realpath、no-follow open、打开后的 fd/stat 校验拒绝逃逸/竞态。GET 仅收不透明引用，不能任意路径/URL；Content-Disposition 保留 UTF-8 文件名，字节不变。
- [ ] **5. 确认 GREEN 与附件：** 全部测试；浏览器上传中文文本/照片并核对原生输入，在私有工作目录生成小文件并逐字节下载；中断保留草稿/旧完成文件，更新双语说明。
- [ ] **6. 提交推送：** `feat: upload attachments and download referenced chat files`，确认远端包含。

## 任务 6：原生模型、上下文和周额度

**文件：** 新建 `web/public/usage.js`、`web/test/usage.test.mjs`，更新服务端/页面。
**接口：** `contextUsage(tokenUsage):{tokens,window,remainingPercent,usedPercent}`，值可为 null；`weeklyUsage(response):Array<{limitId,usedPercent,remainingPercent,resetsAt}>`。模型/支持和默认强度来自 `model/list`。

- [ ] **1. 写失败测试：** 原生基线、误用累计量、null 窗口、多额度桶、仅 primary 为周窗口、不支持强度和账号切换。示例：
  ```js
  const v = contextUsage({last:{totalTokens:112000},total:{totalTokens:900000},modelContextWindow:200000});
  assert.equal(v.remainingPercent,47); assert.equal(v.tokens,112000);
  assert.equal(contextUsage({last:{totalTokens:5},modelContextWindow:null}).remainingPercent,null);
  ```
  断言旧账号代次的读取结果不回填已清空缓存。
- [ ] **2. 确认 RED：** `node --test web/test/usage.test.mjs`。
- [ ] **3. 最小实现：** 模型/强度只对下一轮生效，显示真实权限/模型。steer 沿用活动轮次，不传 `turn/steer` 不支持的模型/sandbox 字段；入队前通过 `thread/settings/update` 设置未来默认值并等匹配通知，队列使用共享未来默认值，不造逐条设置；提示后续设置变化会影响队列，不用活动轮次的 `turn/settings/update` 实现该选择器。上下文窗口 ≤12000 时剩余 0，否则取整并限定 `100 * max(0,(window-12000)-max(0,last.totalTokens-12000))/(window-12000)`；未知窗口保持 null。合并原生额度通知或重读，在任一窗口找 10080，分桶、剩余 `max(0,100-usedPercent)`，重置秒正确转换。账号变化淘汰旧请求/缓存。
- [ ] **4. 确认 GREEN 与原生：** 全测试；选两个支持强度、核对下一轮并保留草稿；临时线程压缩验证上下文更新；读真实周额度元数据但不提交其值；缺失场景用 null 样本。更新双语说明。
- [ ] **5. 提交推送：** `feat: expose native models context and weekly usage`，确认远端包含。

## 任务 7：原生引用、技能与斜杠命令

**文件：** 更新输入/服务端/聊天/页面，新建 `web/test/composer.test.mjs`。
**接口：** `encodeComposer({text,selections,uploads,threadId,mode}):{input,additionalContext?}`、`utf8Range(text,start,end):{start,end}`、`commandAction(text):{command,args}|null`，不造通用 mention 或命令 RPC。

- [ ] **1. 写失败测试：** 中文/emoji 范围、输入法确认、代码/邮箱/`$HOME` 原文、带空格路径、原生 skill/plugin/app、引用自身/重复会话、拆开代理对的无效范围、斜杠映射。示例：
  ```js
  assert.deepEqual(utf8Range('中😀x',1,3), {start:3,end:7});
  assert.equal(commandAction('mail/a@b /new'),null);
  ```
  固定外层 `text_elements` 为下划线，内层 `{byteRange:{start,end},placeholder}` 为驼峰，不写成 `textElements`。
- [ ] **2. 确认 RED：** `node --test web/test/composer.test.mjs`。
- [ ] **3. 最小实现：** 工作目录 `skills/list` 与 `{type:'skill',name,path}`；应用/插件目录与 `{type:'mention',name,path:'app://…'|'plugin://…'}`；文件/目录插原生引用文本。会话为转义 `[@title](thread://id)`、UTF-8 TextElement，排除自身/重复，最多 16 条、ID 总计 768 字节、标题原生上限 160 字符。
- [ ] **4. 只读引用上下文：** 发送时仅读选择的原生会话，每条最多 8 KiB UTF-8、总计 32 KiB，标出截断。start/steer 使用原生 `additionalContext` 的 `{kind:'untrusted',value:quotedSnapshot}`；queue/add 没有该字段，单独原生文本项承载 JSON 引用的 `<untrusted_text>` 快照，界面标明发送时快照。不注入不存在的 `read_thread` 工具/指令，不向引用线程发消息。
- [ ] **5. 精确命令表：** new/model/permissions/status/usage/skills 为界面动作；compact/name-set/archive/delete 为原生动作，fork 走携带最大授权的专用 `/api/thread/fork`；`/export` 分页流式 Markdown 导出。复用确认规则，无 `commands/list`。输入法 Enter 不发送/选择，Enter 发送、Shift+Enter 换行，换模型/菜单保留草稿。
- [ ] **6. 确认 GREEN 与引用：** 全测试；临时线程选真实技能、文件、可用应用/插件、其他会话，检查原生输入/历史/上下文，覆盖 queue；逐个核对命令效果。原生目录不可用时明确显示，不伪造。更新双语说明。
- [ ] **7. 提交推送：** `feat: add native mentions skills and slash actions`，确认远端包含。

## 任务 8：长期运行、手机验收与最终审查

**文件：** 新建 `web/service.mjs`、`web/test/service.test.mjs`，完成页面布局和双语说明。安装的 unit、配置、证书、数据均在 Git 外。
**接口：** `renderUserUnits({repoDir,nodePath,backendExecutable,backendHome,workspace,configPath,environmentFile}):{backend,web}`；CLI `node web/service.mjs init|install|start|stop|status` 只管理当前用户的 `codex-console-native-backend.service`、`codex-console-native-web.service`。`init --origin URL --backend-bin PATH --backend-home PATH --workspace PATH [--cert PATH --key PATH]` 写私有配置，全部命令支持 `--config PATH`，默认取 XDG 路径。

- [ ] **1. 写失败测试：** unit 路径空格/中文/百分号、缺产物/证书、配置属主、拒绝替换原桌面/后端、离线状态、脱敏状态输出。断言不引用 `console.sh`/Xpra，显式后端/数据目录正确转义，停止测试 unit 不停止原应用。
- [ ] **2. 确认 RED：** `node --test web/test/service.test.mjs`。
- [ ] **3. 最小实现：** 用户服务 Restart=on-failure、私有 umask、明确编译产物/数据目录；网页启动不生成备用引擎，unit 使用任务 1 验证安装的持久产物，不引用缓存 target。Node crypto 和现有 OpenSSL 私有初始化密码/哈希/TLS，SAN 匹配配置 IP/主机；预览默认回环 HTTPS 8443，冲突选另一个配置空闲端口；非回环须有 HTTPS origin/证书。不得覆盖已有凭据，状态/日志不得输出秘密；只在私有 EnvironmentFile 保留必需的代理/TLS 环境，排除 API 密钥与任务运行覆盖值。正式启动前仅停止任务 1 记录的临时测试 unit，不杀占用端口的未知进程。
- [ ] **4. 完整检查：** `node --test web/test/*.test.mjs`、`npm --prefix web audit --omit=dev`、改动文件语法/差异。修复失败后才报告通过。用浏览器工具验证登录、项目/会话、发送/追问/停止、原生表单、模型/用量、复制、文件/照片/下载、引用/技能/命令、重连/不确定写入和退出。检查 390×844、1280×820；有真实手机时检查输入法/选择器/剪贴板/下载，缺硬件检查须明确记录。
- [ ] **5. 保活与文档：** 仅启动测试 unit，结束启动终端/会话后再次验证就绪和桌面/网页状态；分别重启网页/后端，验证权威重同步且不重放写入。双语写明启停/状态、私有路径、归档范围、证书信任、活动任务限制和回滚；unit 仍引用代码路径时保留实现工作树，迁移部署路径并重验后才可归档；证据/截图留在 Git 外。
- [ ] **6. 请求所选流程的最终独立审查：** 修复问题，仅重跑受影响检查，复核差异/暂存。没有单独迁移指示，不改接原桌面。
- [ ] **7. 提交推送：** `feat: package the native browser client for durable owner access`，仅暂存本任务文件、立即推送并确认远端；交付认证访问地址、已验范围/限制、commit/push 状态及截图，不交付凭据。

## 计划审核与执行方式

自审：设计全部功能对应任务 1–8，五项重点都有明确测试，接口名/类型一致；
运行验收均是未来检查，本次编写计划没有生成产品代码。

推荐 **Native（当前会话亲自实现）**：任务共享小型 RPC/路由/输入接口，主要
顺序推进，单人保留上下文的协调成本更低；完成后仍有一次完整独立审查。
**Subagent-driven（逐任务多代理）** 每项使用新实现者和审查者，最后再审全分支，
花费更多上下文，能更早获得独立检查。执行前请用户审核计划并选择方式。

2026-10-08 已通过 npm 元数据和[官方包清单](https://raw.githubusercontent.com/markdown-it/markdown-it/master/package.json)核对版本，安装依赖属于任务 3，不属于本次规划。
