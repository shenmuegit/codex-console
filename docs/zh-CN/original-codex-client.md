# 接入原来的 Codex 客户端

[English](../original-codex-client.md)

之前通过 Xpra 显示的客户端使用 `~/.codex`，Electron 配置目录为
`~/.local/state/codex-console/profile`。网页现通过已安装的 `codex-cli 0.159.2`
后端直接使用这些原有数据。Xpra 保持关闭，HTTPS 使用 15443，原生 WebSocket
仅监听 `127.0.0.1:4500`。

按所有者要求不保留备份，不复制数据库、账号或聊天记录。配置、验证结果和桌面重载任务
均存放在 Git 仓库之外。

复现连接切换的步骤：

1. 修改已有私有网页配置，保留凭据和 TLS 字段。`backendExecutable` 使用
   `/usr/lib/chatgpt/resources/codex`，`backendHome` 使用原 Codex home 的绝对路径，
   `allowOriginalHome` 明确设为布尔值 `true`。`backendArgs` 保留原生启动参数中的
   `app-server` 和原有 `-c` 设置；服务生成器会添加 `--listen` 及回环地址。
   默认初始化仍拒绝原 home，不要对原目录重新执行初始化。
2. `workspace` 使用原桌面工作目录。`generatedRoots` 只允许已有工作区、托管工作树、
   附件和可视化目录，不放开整个 Codex home。
3. 依次使用 `node web/service.mjs stop`、`install`、`start` 重载两个自有网页/后端服务。
   通过已登录 HTTPS API 验证原生握手 home、原项目 ID、可读取的历史、账号和模型目录。
4. 为原桌面服务及用户启动器设置 `CODEX_APP_SERVER_WS_URL=ws://127.0.0.1:4500`，
   保留原 Electron 配置目录。当前控制轮次结束后重载桌面，再检查它到共享后端的 TCP
   连接。一次性重载任务将结果写入
   `~/.local/state/codex-console-web/original-client-switch/desktop-verification.json`。
   只有核对重启后进程的配置目录才能确认保留成功；超时或目录不匹配时不报告为已验证。

切换不需要重新登录原生账号，不改写项目目录。网页服务重载后请从 HTTPS 首页重新登录；
旧测试会话的 URL 属于已停用的隔离后端。

127 项 Node 检查通过，覆盖默认拒绝原 home、明确复用、私有文件保护和原生参数引用。
真实 HTTPS 检查已确认原项目集合及聊天历史、已有登录、模型目录，以及仅回环监听的原生
后端；没有请求推理。
