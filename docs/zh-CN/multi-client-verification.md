# 多客户端兼容性验证

[English](../multi-client-verification.md)

2026-10-11（Asia/Shanghai）对 `codex/native-web-client` 的现有原生网页部署进行
验证。本轮验证多个客户端共享**同一个 app-server**，包含实际 Codex CLI。
登记和控制多台主机的中心服务尚未实现，本轮也未验证该能力。

## 已验证结果

| 检查 | 结果 |
| --- | --- |
| 原生握手与读取 | 连接桌面自带的 `codex-cli 0.159.2`；已登录状态、模型、项目和会话读取通过，没有输出凭据。 |
| 网页访问 | HTTPS 登录及 SSE 通过；未登录 API 返回 401，外来 Origin 返回 403。 |
| 并发连接 | 两个独立原生协议连接、两个已认证网页事件流打开同一条临时会话。 |
| 原生 → 网页 | 原生会话重命名到达另一原生连接及两个网页事件流。 |
| 网页 → 原生 | 网页重命名到达两个原生连接及另一网页事件流。 |
| 重连 | 新建原生连接、重新打开网页事件流后，恢复同一会话 ID 和权威名称。 |
| 独立会话 | 修改目标会话名称没有改变第二条临时会话的名称；之后删除了第二条会话。 |
| 实际 CLI | CLI `0.159.0` 恢复后端 `0.159.2` 上的测试会话，`/status` 显示正确的服务端和线程 ID。网页重命名实时更新 CLI 终端标题与 `/status`；CLI `/rename` 产生原生通知，已认证网页 API 读取到相同名称。 |
| 原桌面 | 已安装的 Linux 桌面进程继续通过 TCP 连接同一后端；本轮没有操作其聊天界面。 |

私有证明记录了六组协议/CLI 检查通过。没有请求模型轮次，只写入临时会话
元数据；没有重启原桌面或网页服务，服务进程 ID 保持不变，测试 CLI 正常断开。
主测试会话保留，供所有者在其他设备上配合测试。

探针脚本、证明、实际线程 ID 和应用数据均保存在仓库外的
`~/.local/state/codex-console-web/multi-client-verification-20261011/`。
探针是一次性实验代码，不是已交付的中心服务，也不属于常规回归套件。

## 复现 CLI 与网页检查

1. 复用配置好的共享后端，不重启活动工作。通过原生网页打开专用测试会话，
   复制完整线程 ID。
2. 确认 `codex --help` 包含 `--remote`，在本机运行：

   ```bash
   codex --remote ws://127.0.0.1:4500 --no-alt-screen resume <TEST_THREAD_ID>
   ```

3. 执行 `/status`，核对服务端版本与线程 ID。通过网页重命名会话，确认 CLI
   终端标题和 `/status` 显示新名称。
4. 在 CLI 执行 `/rename Multi-client verification`，确认网页显示同一会话名称。
5. 正常退出测试 CLI，再用同一命令连接。重新打开网页会话，确认两端仍指向
   同一条线程。

**已发现的 CLI 限制：**远程恢复命令额外传入 `-s read-only` 时，返回
`Permission overrides are not supported when resuming a remote task.`。
移除该显式覆盖后，同一 CLI 可以恢复会话。远程恢复沿用后端权限，复现命令
不要额外设置权限覆盖。

## 其他设备配合测试

将下面的占位符替换为所有者已有的 SSH 账号、主机和测试线程 ID。app-server
保持回环监听，通过 SSH 访问：

```bash
ssh -N -o ExitOnForwardFailure=yes \
  -L 127.0.0.1:14501:127.0.0.1:4500 <USER>@<HOST>
```

在该设备的另一个终端执行：

```bash
codex --remote ws://127.0.0.1:14501 resume <TEST_THREAD_ID>
```

网页使用已有入口 `https://<HOST>:15443/?thread=<TEST_THREAD_ID>` 和所有者访问
密码。测试前记录其他设备的操作系统及准确的 CLI/桌面版本。

官方桌面构建须先确认该版本选择后端或建立连接的方式。此前验证的本机构建
支持 `CODEX_APP_SERVER_WS_URL`，不能据此承诺每个官方桌面版本都有相同设置。
参见之前的[本地桌面实验](local-app-server-test.md)。

待人工完成的验收：

- 从其他客户端发送只要求固定短回复的消息，在网页观察完整回复与实时变化；
  再从网页发送另一条，确认其他客户端同步显示。
- 在专用测试会话启动工作，由另一端停止同一轮次，两端均确认中断状态。
- 并行运行两条独立测试会话，核对命令、事件和历史归属正确。
- 断开并重新连接其他客户端及网页，确认会话与历史恢复，已经发送的消息
  没有重复提交。

接入另一个前端后，使用的是所选后端的账号、文件系统和执行环境。本轮没有
把该前端设备自己的本地 Codex 后端登记到中心服务。

## 尚未覆盖

Windows/macOS 官方桌面构建、其他设备的实际界面、本轮真实消息流式同步与
跨端停止、IDE/第三方客户端、多台独立主机及无人值守重连尚未验证。
app-server 的 WebSocket 传输仍属实验功能；结果只适用于上述版本和操作，
不能外推为所有 Codex 版本均兼容。

## 官方配对路线：server 作为控制端

所有者明确的目标是 **Web → Codex Console server → 官方中继 → 已配对的
Codex 设备**。控制端注册、配对、连接和 RPC 路由均由 server 负责，网页操作
这个 server。前面的本地共享 app-server 检查不能作为官方中继路线的验证结果。

提供的桌面版本为 `26.1007.21434`。服务器已安装的桌面包是 `26.928.21956`，
本轮检查的是该包中的控制端实现，没有核验更新的外部构建。该实现需要注册
控制端、完成账户二次授权、创建受保护设备密钥，并在注册和中继连接时提供
设备密钥证明。CLI `remote-control pair` 用于生成被控主机的配对码，其帮助
没有提供接收另一主机配对码的控制端命令。

2026-10-11 新的前置检查：

- 原生 `remoteControl/status/read` 返回 `disabled`，没有环境注册；本地
  桌面状态中的控制端注册记录为零。
- 官方 `native/remote-control-device-key.node` 组件可在 Node 24 加载。
  异步调用 `createDeviceKey("allow_os_protected_nonextractable")` 时，返回
  `remote_control_device_key_tpm_unavailable` 和 `cannot open Linux TPM device`。
  没有返回或登记任何设备密钥。
- 当前 KVM server 没有 `/dev/tpm0`、`/dev/tpmrm0`，`/sys/class/tpm` 下也没有
  设备。已有网页和后端服务继续运行，进程 ID 未变。

下一项前置条件是为这台 Linux 控制端提供可用的 TPM/vTPM，或者使用官方
组件能够创建所需受保护密钥的控制端环境。实际配对前，还要确认账号与工作区
一致，并完成必要的账户授权。不以可导出密钥替代，也不把软件密钥冒充为
受保护设备密钥。

本轮没有注册官方中继控制端，也没有领取提供的配对码。server 是否能被接受为
控制端、与外部新版桌面配对、多主机控制和网页动作到达被控主机均待验证。
解决密钥前置条件本身不能证明这些能力，也不能证明官方支持第三方 server
控制端。

参见[官方远程连接要求](https://learn.chatgpt.com/docs/remote-connections)和
[CLI 远程控制命令](https://learn.chatgpt.com/docs/developer-commands#codex-remote-control)。

### 后续：组件更新与 vTPM 实验

已从签名的 OpenAI APT 仓库下载 Linux 包 `26.928.31416`，没有安装。软件包
SHA-256 与 APT 元数据一致，设备密钥组件与已安装的 `26.928.21956` 组件字节
完全相同。这项比较没有覆盖外部 Windows/macOS 的 `26.1007.21434` 构建。

server 内核启用了 `CONFIG_TCG_VTPM_PROXY=m`，包含
`tpm_vtpm_proxy.ko.xz`，驱动尚未加载。`swtpm` 安装模拟结果为新增三个包，
没有升级或删除。sudo 能力检查和具体的 `modprobe` 尝试都要求密码，因此
本轮没有安装软件包或加载模块。

两个一次性助手已放在仓库外的
`~/.local/state/codex-console-web/official-controller-test/`：
`prepare-vtpm-test.sh` 准备隔离软件 vTPM，加密状态由 `tss` 独立持有；
`check-device-key.cjs` 检查原生密钥创建、公钥读取、SHA-256 签名验签和临时
密钥清理。语法检查通过；普通用户执行准备脚本在写入前被拒绝，缺少设备时
密钥检查在创建前正确报告失败。实际 vTPM 启动及签名成功路径仍待管理员执行。

sudo 认证用于取得这一步所需的 OS 管理员权限。官方账号授权、控制端注册和
设备配对是随后独立的步骤。软件 vTPM 实验不能证明物理 TPM 的保护能力，
也不能证明官方中继会接受此控制端。参见
[Linux vTPM 驱动](https://docs.kernel.org/security/tpm/tpm_vtpm_proxy.html)和
[swtpm 文档](https://github.com/stefanberger/swtpm/blob/master/man/man8/swtpm.pod)。

### 项目内安装，仅当前用户使用

按所有者要求，已下载 `swtpm`、`swtpm-libs`、`libtpms0` 三个包，核对 APT
SHA-256 后解包到 `.tools/vtpm/root/`。`.tools/` 已加入 Git 忽略，目录权限为
700；没有安装系统软件包。在项目根目录可以运行：

```bash
env LD_LIBRARY_PATH="$PWD/.tools/vtpm/root/usr/lib/x86_64-linux-gnu:$PWD/.tools/vtpm/root/usr/lib/x86_64-linux-gnu/swtpm" \
  .tools/vtpm/root/usr/bin/swtpm --version
```

本地程序返回版本 `0.7.1`。UID 1000 的 socket 模式实验通过 TPM 2 GetRandom
命令收到 16 字节，Unix socket 权限为 600。临时状态在仓库外，进程和状态已
清理。Unix socket 需要短路径；首个路径超过长度限制，改用私有临时目录后
检查通过。

此结果验证用户级模拟器，没有验证官方控制端的设备密钥接口。官方组件直接
把固定的 `/dev/tpmrm0` 传入 `Tss2_Tcti_Device_Init`，移动程序文件不能让它
改用项目内 socket。建立内核 TPM 接口仍需要管理员权限；已准备的设备初始化
助手现使用项目内运行库，不再安装系统包。密钥、配置、TPM 状态继续按
AGENTS.md 保存在 Git 仓库外，设备访问可以限制为应用用户。
