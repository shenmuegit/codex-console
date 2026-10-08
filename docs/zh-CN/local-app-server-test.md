# 本地源码 app-server 与额外桌面客户端测试

[English](../local-app-server-test.md)

于 2026-10-08（Asia/Shanghai）验证：官方源码编译成功，额外桌面实例通过
WebSocket 连接到了该编译产物。独立协议客户端向测试会话发送了一轮请求，
桌面显示了流式回复 `LOCAL_APP_SERVER_OK`。

## 已验证配置

| 项目 | 结果 |
| --- | --- |
| 官方源码 | `ff9ab4aed96aa2e105f78b9521dbbd3a6b329dc8`，工作区干净 |
| Rust | 本次安装 `1.95.0` 最小工具链 |
| 编译 | 单独构建 `codex-app-server`；`dev-small`、单任务、退出码 0，耗时 20m 33s |
| 产物版本 | `codex-app-server 0.0.0`；上游工作区使用开发版本号，具体构建以 commit 和哈希识别 |
| 产物 SHA-256 | `b81339baaec5735b317fd725fe8319b892aa94b633219d0957a22a661eed83ca` |
| 桌面 | 已安装版本 `26.928.21956`，其自带 CLI 仍为 `0.159.2` |
| 测试地址 | `ws://127.0.0.1:4500` |
| 桌面握手 | 服务端识别到 `Codex Desktop`；桌面 `local` 状态为 `connected`、`initialized=true`、`websocket` |
| 接口读取 | 模型、项目、会话、已加载会话和账号读取通过；模型目录返回四个模型，已有登录快照可用 |
| 生成 | 目录默认模型 `gpt-6-astra`、low 强度；轮次完成，额外桌面显示 `LOCAL_APP_SERVER_OK` |

原桌面和原 stdio 后端保持运行。测试使用独立 Codex 数据目录和 Electron
配置目录，没有打开或迁移原会话数据库。已有登录文件复制到私有测试目录；
额外桌面正常更新了自己的测试配置，并安装了默认插件。

## 复现

以下记录原实验步骤；当时的临时构建和数据目录现已不在。浏览器实现按
[操作说明](native-web-client.md)中的持久路径重建环境。仅编译独立 app-server，
无需替换安装包内的桌面程序。

```bash
export PATH="$HOME/.cargo/bin:$PATH"
cd /home/desktop/Documents/Codex/codex-console/codex/codex-rs
CARGO_HTTP_MULTIPLEXING=false \
CARGO_TARGET_DIR="$HOME/.cache/codex-console-shared-server-test/target" \
CARGO_INCREMENTAL=0 \
cargo +1.95.0 build --locked --profile dev-small -j 1 \
  -p codex-app-server --bin codex-app-server
```

首次依赖索引下载开启 HTTP 多路复用时反复超时；关闭后锁定依赖下载成功。
没有修改源码或锁文件，编译产物位于仓库外。

在同一个终端准备私有测试目录并启动两个进程：

```bash
test_root="$HOME/.local/state/codex-console-tests/source-app-server-20261007"
test_codex_home="$test_root/codex-home"
test_desktop_profile="$test_root/desktop-profile"
test_workspace="$test_root/workspace"
install -d -m 700 "$test_root" "$test_codex_home" "$test_desktop_profile" "$test_workspace"
if [ ! -f "$test_codex_home/auth.json" ]; then
  install -m 600 "$HOME/.codex/auth.json" "$test_codex_home/auth.json"
fi
cat > "$test_codex_home/config.toml" <<'TOML'
cli_auth_credentials_store = "file"
[analytics]
enabled = false
TOML
chmod 600 "$test_codex_home/config.toml"
cd "$test_workspace"
env CODEX_HOME="$test_codex_home" \
  "$HOME/.cache/codex-console-shared-server-test/target/dev-small/codex-app-server" \
  --listen ws://127.0.0.1:4500 > "$test_root/server.log" 2>&1 &
curl --fail --retry 10 --retry-connrefused --retry-delay 1 http://127.0.0.1:4500/readyz
env -u CODEX_APP_SERVER_FORCE_CLI \
  CODEX_HOME="$test_codex_home" \
  CODEX_ELECTRON_USER_DATA_PATH="$test_desktop_profile" \
  CODEX_APP_SERVER_WS_URL=ws://127.0.0.1:4500 \
  /usr/lib/chatgpt/ChatGPT --user-data-dir="$test_desktop_profile" \
  > "$test_root/desktop.log" 2>&1 &
```

安装包代码中的 `CODEX_APP_SERVER_WS_URL` 选择后端；
`CODEX_ELECTRON_USER_DATA_PATH` 隔离桌面配置与单实例锁；`CODEX_HOME` 隔离
原生 IPC、配置、插件与会话存储。目录在 10 月 7 日建立，验证跨过了午夜。

## 证据与范围

私有实验目录 `~/.cache/codex-console-shared-server-test/` 保留
`runtime.json`、`verification.json`、`socket-proof.json`、
`desktop-proof.json`、`turn-result.json`、启动/探针脚本与编译日志。
窗口截图位于
`~/.local/state/codex-console-tests/source-app-server-20261007/desktop.png`。
凭据、日志、截图和应用数据均未提交。

验证包括 HTTP 就绪检查、JSON-RPC 握手与读取、由额外桌面和源码后端持有的
真实 TCP 连接、桌面本地连接已初始化、一轮模型生成完成，以及目视确认桌面
显示同一条回复。生成请求通过协议探针发送；未测试桌面键盘发送操作。

新桌面还尝试连接独立的云端 `durable` 主机，并记录了连接失败；本地 `local`
连接保持已初始化且可用。云端连接不属于本次本地后端的验证结果。

该结果验证了后续浏览器客户端可以优先采用共享 app-server 路线。浏览器鉴权、
浏览器兼容入口、文件和完整功能仍需实现与单独验证。原桌面的运行中任务没有
迁移到测试后端。
