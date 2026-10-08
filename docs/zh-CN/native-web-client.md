# 原生浏览器客户端

[English](../native-web-client.md)

按照[已批准的计划](superpowers/plans/2026-10-08-native-web-client.md)，在
`codex/native-web-client` 分支实现。已实现共享原生连接及 HTTPS 登录和事件推送，后续提交接入聊天操作。
使用 Node.js 24 自带 WebSocket，无需传输依赖。

## 原生连接

`web/codex.mjs` 只连接配置中指定的回环 WebSocket 地址，必须明确端口。
连接会初始化原生实验接口、对应请求与回复、保留原生错误，单次请求超时为 30 秒，
建立连接及初始化超时为 10 秒。

每个原生消息都有连接代次和顺序游标。原子恢复得到的历史快照，会在后续增量消息
及等待中的接口处理程序之前发布。每个页面获取自己的快照；最后一个页面关闭时，
仅取消空闲会话的订阅。运行中的工作保持订阅，直到对应轮次结束。
重连后恢复订阅与快照，不会重发已提交的操作。

发送后断线的操作结果为**未知**，应先查看原生历史再决定是否重试；离线时调用则为
**未发送**。审批或输入请求只能回答一次，在原生请求解决或重连时失效，原生请求 ID
为数字零也能正常处理。

## 隔离测试环境

官方源码固定在 `ff9ab4aed96aa2e105f78b9521dbbd3a6b329dc8`，使用 Rust 1.95.0、
锁定依赖及 `dev-small` 配置，编译独立 app-server，将桌面自带的官方
`codex-code-mode-host` 组件安装在旁边。本源码版本的默认工具执行需要后者，
仅测试文字回复无法发现它缺失。尝试从源码编译组件时，遇到 V8 sandbox 预编译库缺失；
该特性在依赖库说明及[上游发布资产](https://github.com/denoland/rusty_v8/releases/expanded_assets/v150.4.0)中没有对应预编译产物。
app-server 仍使用固定源码构建，没有修改源码或功能配置。
两个程序一起安装到仓库外的 `~/.local/lib/codex-console-web/bin/`。

```bash
cd /home/desktop/Documents/Codex/codex-console/codex/codex-rs
CARGO_HTTP_MULTIPLEXING=false CARGO_INCREMENTAL=0 \
CARGO_TARGET_DIR="$HOME/.cache/codex-console-web-build" \
  "$HOME/.cargo/bin/cargo" +1.95.0 build --locked --profile dev-small -j 2 \
  -p codex-app-server --bin codex-app-server
install -d -m 700 "$HOME/.local/lib/codex-console-web/bin"
install -m 700 "$HOME/.cache/codex-console-web-build/dev-small/codex-app-server" \
  /usr/lib/chatgpt/resources/codex-code-mode-host "$HOME/.local/lib/codex-console-web/bin/"
```

测试数据位于
`~/.local/state/codex-console-web/integration/{codex-home,desktop-profile,workspace}`。
目录权限为 0700；现有文件登录信息可复制为 0600。不要复制原桌面的聊天或账号数据库。
额外桌面使用独立 Codex home 和 Electron 配置，通过 `CODEX_APP_SERVER_WS_URL`
连接同一个源码编译后端 `ws://127.0.0.1:4500`。原桌面与运行中的会话继续使用原后端。

两个临时用户服务为 `codex-console-native-backend-test` 和
`codex-console-native-desktop-test`，仅停止或重启这两个自有测试服务。
界面、代理和证书环境按明确的变量名写入私有环境文件传递；凭据及日志不提交。

## 验证

```bash
npm --prefix web test
node web/test/native-probe.mjs --url ws://127.0.0.1:4500 \
  --workspace "$HOME/.local/state/codex-console-web/integration/workspace" \
  --exercise-files
```

自动测试使用模拟原生 WebSocket 事件，不访问账号。手动集成探针读取原生模型、项目、
会话及登录可用性，不输出账号内容。文件验证会新建一次性原生会话，要求实际调用文件或
命令工具，逐字节检查私有文件，完成后删除该测试会话。

新建空原生会话后，先命名再恢复。原生 `thread/name/set` 会持久化空会话的分页历史，
否则立即恢复可能返回“no rollout found”；这沿用官方测试流程。

项目、聊天操作、附件、用量及部署继续在同一计划后续步骤实现，客户端不使用 Xpra 连接。

本轮实测：源码 app-server 编译退出码 0，耗时 11m 13s；10 项原生连接检查和原项目隔离检查通过。原生目录读取返回 4 个模型，隔离项目/会话均为 0，已有登录可用；额外桌面的 WebSocket 连接已初始化。真实文件探针通过：原生工具写入的字节完全一致，一次性测试会话已删除；桌面官方组件与本次工具调用兼容。

已验证程序 SHA-256：app-server 为 `85ef3000722cab4fdb576ab5cfdce0e8e791641641a671a7593e6b23b7334431`，桌面组件为 `5b2c075ac2380fa04d76d7313fbc044d29c8d0a0d0b9138415acd4610211ca03`。开发版本号为 `0.0.0`，以源码 commit 和哈希识别构建。


## HTTPS 用户访问

`web/server.mjs` 提供固定本地页面，只接受配置中的 HTTPS Host/Origin。
登录使用有效期固定为 12 小时的 `HttpOnly; Secure; SameSite=Strict` Cookie。
密码采用异步原生 scrypt，盐为 16 字节、密钥为 64 字节，N=16384/r=8/p=1；
每 IP 每分钟失败五次后限流。密码、哈希、TLS 文件及配置保存在仓库外，
不记录请求正文或 Cookie。

浏览器只能调用固定读取接口；任意进程、配置、凭据接口及原始新建会话请求被拒绝。
读取和事件中过滤原生凭据。暂不支持的登录刷新、证明或动态工具请求明确返回
“不支持”。审批和输入请求只能回答一次；权限回答不能超过对应原生请求。

每个页面获得属于当前登录会话的视图 ID，通过认证的 SSE 接收事件，每 15 秒保活，
每条流排队上限为 1 MiB。慢速页面会断开，新建或重连的流均要求重新获取权威快照。
退出登录只撤销当前登录会话及其事件流，不影响其他登录会话或持久原生连接。

隔离 HTTPS 测试服务为 `codex-console-native-web-test`，仅监听
`https://127.0.0.1:8443`。临时集成配置及私有访问密码位于
`~/.config/codex-console-web/integration/`，TLS 证书为回环地址的自签名证书。
主机 IP 的持久部署在任务 8 交付。
运行 `node --test web/test/auth-server.test.mjs` 可执行隔离 HTTPS/认证检查。
九项检查通过，包含真实 TLS/SSE 慢速页面暂停读取时，另一页面继续接收事件。
连接源码后端的 HTTPS 实测也通过：未登录 401、其他来源 403、读取四个原生模型、
SSE 要求获取快照、退出登录；没有输出密码内容。
