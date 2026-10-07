# Codex 官方源码目录

[English](../codex-source.md) · [开发说明](../development.md)

本地 `codex/` 目录保存官方
[`openai/codex`](https://github.com/openai/codex) 源码，用于研究。
根目录 `.gitignore` 的 `/codex/` 规则忽略整个目录及其独立 Git 仓库。

在 Codex Console 仓库根目录执行以下命令可复现：

```bash
git clone --depth 1 https://github.com/openai/codex.git codex
git -C codex rev-parse HEAD
git check-ignore -v codex/ codex/README.md
```

2026-10-07 创建的源码目录位于 `main` 分支，提交为
`ff9ab4aed96aa2e105f78b9521dbbd3a6b329dc8`。这是浅克隆；需要历史时可执行
`git -C codex fetch --unshallow`。

Codex Console 只提交忽略规则和说明文档。源码目录与本机已安装的 Codex
可执行文件、控制台使用的桌面应用分别独立。

## GitNexus 索引

官方源码与 Codex Console 分别索引。本次索引生产源码，排除测试套件、
夹具、快照和基准测试。已安装 GitNexus 1.6.12 时，以下命令把过滤配置和
索引放在仓库外，建立本地过滤配置的软链接，不生成代理指令文件，并限制
内存和解析并发。定期垃圾回收用于降低大型 Rust 工作区的内存压力，
保留默认的内存作用域模式，避免 1.6.12 在本工作区反复解码磁盘分片：

```bash
cd codex
codex_index_filter="${XDG_CACHE_HOME:-$HOME/.cache}/codex-console-investigation/codex.gitnexusignore"
mkdir -p "$(dirname "$codex_index_filter")"
cat > "$codex_index_filter" <<'EOF'
**/tests/**
**/test_fixtures/**
**/fixtures/**
**/snapshots/**
**/testdata/**
**/test_data/**
**/benches/**
**/*_tests.rs
**/tests.rs
**/tests_*.rs
**/test_*.py
**/*.test.ts
**/*.test.tsx
**/*.spec.ts
**/*.snap
EOF
test -e .gitnexusignore || ln -s "$codex_index_filter" .gitnexusignore
grep -qxF .gitnexusignore .git/info/exclude || printf '\n.gitnexusignore\n' >> .git/info/exclude
GITNEXUS_STORAGE_ROOT="${XDG_CACHE_HOME:-$HOME/.cache}/gitnexus" \
  node --max-old-space-size=4096 --max-semi-space-size=32 --stack-size=4096 \
  --gc-interval=100000 "$(command -v gitnexus)" analyze --index-only --workers 2
gitnexus status
```

GitNexus 查询指定 `repo: "codex"`；`codex-console` 是另一份知识图。
本机源码索引保存在 `~/.cache/gitnexus/codex-580cf2dcfd56/`。默认的 512 KB
文件上限会跳过两个生成的协议 schema 汇总文件，Rust 协议定义仍可查询。

2026-10-07 已核验发布的索引与源码 HEAD 一致：纳入分析的文件 4,993 个，
节点 103,042 个，关系 268,000 条，枚举流程 864 条。流程枚举受预算限制，
部分 Rust 方法链接不完整；下文关键连接已回读源码并通过传输层检查确认。

## 远程连接 Codex CLI

最小方案是远端回环监听的 app-server、SSH 隧道和现有 CLI 终端界面。
先在远端安装并登录 Codex，然后在远端项目目录运行：

```bash
codex app-server --listen ws://127.0.0.1:4500
```

在客户端保持下面的隧道运行，将 `user@HOST` 换成实际远端账号和地址：

```bash
ssh -N -o ExitOnForwardFailure=yes \
  -L 127.0.0.1:14500:127.0.0.1:4500 user@HOST
```

再打开一个客户端终端：

```bash
codex --remote ws://127.0.0.1:14500
```

工作目录、模型访问凭据和执行过程都在服务端，客户端渲染终端界面，连接的是
上述命令启动的服务端。复用桌面应用中正在执行的任务，需要确认该应用实际
使用的 app-server 进程和数据目录。
两端分别检查 `codex --help` 与 `codex app-server --help`，旧版本可能缺少
这些参数。app-server 的 WebSocket 传输仍属实验功能，详见
[官方 App Server 文档](https://learn.chatgpt.com/docs/app-server)。

## 带认证的 WebSocket 连接

通过 TLS 代理连接时，使用独立的高熵传输令牌，将其存入仓库外的私有文件：

```bash
codex app-server --listen ws://127.0.0.1:4500 \
  --ws-auth capability-token \
  --ws-token-file /absolute/private/path/transport-token
```

代理终止 TLS，并把 WebSocket 升级请求转发到上述回环监听器。
客户端在升级请求中发送 `Authorization: Bearer <transport-token>`。
从客户端私有存储把令牌读入 `CODEX_REMOTE_TOKEN` 后，可执行：

```bash
codex --remote wss://HOST:443/ \
  --remote-auth-token-env CODEX_REMOTE_TOKEN
```

监听器也支持令牌的 SHA-256 校验值或签名 bearer token。此次固定的源码
版本会拒绝未配置认证的非回环监听；CLI 仅允许通过 `wss://` 或回环 `ws://`
发送传输令牌。传输认证与服务端登录 OpenAI 是两层独立认证。
此版本 CLI 要求显式端口和根路径端点；`wss://HOST/codex` 或 `wss://HOST`
这样的地址会在连接前被拒绝。

## 浏览器与桌面客户端

浏览器前端应通过经过认证的后端连接 app-server。监听器对所有带 `Origin`
的请求返回 HTTP 403，包括 WebSocket 升级请求。后端验证浏览器会话和来源，
在服务端保存传输令牌，再建立不携带 `Origin` 的上游连接。每个上游
WebSocket 文本帧承载一条 JSON-RPC 消息。

客户端发送 `initialize`，等待响应后发送 `initialized`，再调用
`thread/start` 或 `thread/resume`、`turn/start`。持续处理
`item/agentMessage/delta`、`turn/completed`，并响应服务端审批请求。
这是给 Codex Console 增加原生浏览器界面的接入路线。

桌面应用已有 SSH 接入：在 `~/.ssh/config` 配置明确的主机别名，验证 SSH
可用，在远端安装并登录 Codex，再到 Settings > Connections > SSH
添加主机、选择远端项目目录。详见
[官方远程连接说明](https://learn.chatgpt.com/docs/remote-connections#connect-to-an-ssh-host)。
可用性取决于桌面应用构建；本次未验证 Codex Console 使用的兼容 Linux
桌面应用是否提供这些 SSH 设置。

源码还提供实验性的 `codex remote-control start` 和
`codex remote-control pair` 命令，用于把主机注册到 ChatGPT 中继并申请
短期手动配对码。本次核对了 help 和实现，未进行账号注册或手机配对；
当前官方手机接入说明从桌面应用开始设置。

## 源码依据与验证

以下链接固定到本次研究的源码提交：

| 入口 | 源码 |
| --- | --- |
| CLI 远程参数 | [InteractiveRemoteOptions](https://github.com/openai/codex/blob/ff9ab4aed96aa2e105f78b9521dbbd3a6b329dc8/codex-rs/cli/src/main.rs#L964) |
| 远端连接与握手 | [RemoteAppServerClient](https://github.com/openai/codex/blob/ff9ab4aed96aa2e105f78b9521dbbd3a6b329dc8/codex-rs/app-server-client/src/remote.rs#L180) |
| CLI 端点校验 | [resolve_remote_addr](https://github.com/openai/codex/blob/ff9ab4aed96aa2e105f78b9521dbbd3a6b329dc8/codex-rs/tui/src/lib.rs#L451) |
| Origin 拒绝与监听认证 | [WebSocket transport](https://github.com/openai/codex/blob/ff9ab4aed96aa2e105f78b9521dbbd3a6b329dc8/codex-rs/app-server-transport/src/transport/websocket.rs#L89) |
| Bearer 令牌校验 | [authorize_upgrade](https://github.com/openai/codex/blob/ff9ab4aed96aa2e105f78b9521dbbd3a6b329dc8/codex-rs/websocket-auth/src/lib.rs#L288) |
| 远程中继 CLI | [remote_control_cmd](https://github.com/openai/codex/blob/ff9ab4aed96aa2e105f78b9521dbbd3a6b329dc8/codex-rs/cli/src/remote_control_cmd.rs#L70) |

本地使用已安装的 `codex-cli 0.159.0`，创建临时 Codex 数据目录和令牌，
不使用账号凭据、不启动模型轮次，验证结果如下：

| 检查 | 结果 |
| --- | --- |
| `GET /readyz` | 200 |
| 缺失或错误令牌的升级请求 | 401 |
| 正确令牌且带 `Origin` 的升级请求 | 403 |
| 正确令牌且不带 `Origin` 的升级请求 | 101 |
| JSON-RPC `initialize` 后发送 `initialized` | 通过 |
| CLI 拒绝路径后缀或省略端口的地址 | 通过 |

官方源码目录保持干净，父仓库的忽略规则已验证。跨机器 SSH、TLS 部署、
模型推理以及桌面/手机配对需要目标机器和账号，本地检查未覆盖这些环节。
