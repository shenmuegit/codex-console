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

首次 server 检查确认内核启用了 `CONFIG_TCG_VTPM_PROXY=m`，包含
`tpm_vtpm_proxy.ko.xz`，当时驱动尚未加载。`swtpm` 安装模拟结果为新增三个包，
没有升级或删除。sudo 能力检查和具体的 `modprobe` 尝试都要求密码，因此
首次尝试没有安装软件包或加载模块。

两个一次性助手已放在仓库外的
`~/.local/state/codex-console-web/official-controller-test/`：
`prepare-vtpm-test.sh` 准备隔离软件 vTPM，加密状态由 `tss` 独立持有；
`check-device-key.cjs` 检查原生密钥创建、公钥读取、SHA-256 签名验签和临时
密钥清理。语法检查通过；普通用户执行准备脚本在写入前被拒绝，缺少设备时
密钥检查在创建前正确报告失败。当时实际 vTPM 启动及签名成功路径待管理员执行。

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

### 管理员初始化与官方设备密钥验证

2026-10-11 经授权使用管理员权限加载 `tpm_vtpm_proxy`，创建了 `/dev/tpm0`
和 `/dev/tpmrm0`。两个设备均归应用用户所有，权限为 600。项目内的模拟器以
`tss` 账号运行，有效 capabilities 为零；应用用户不能读取其加密状态的密钥。
没有安装系统软件包，也没有重启已有应用服务。

首次 `swtpm --vtpm-proxy --runas tss` 启动失败：该版本先降权，再打开
`/dev/vtpmx`，而创建代理还需要 `CAP_SYS_ADMIN`。修正后的助手由管理员通过
标准 `VTPM_PROXY_IOC_NEW_DEV` ioctl 创建 TPM 2 代理，把继承的文件描述符
传给 `swtpm chardev --fd`，再用 `--runas tss` 降权。首次失败的状态已另行
保留，没有覆盖已有 TPM 数据。参见
[内核实现](https://github.com/torvalds/linux/blob/v6.12/drivers/char/tpm/tpm_vtpm_proxy.c)和
[swtpm 初始化顺序](https://github.com/stefanberger/swtpm/blob/v0.7.1/src/swtpm/swtpm_chardev.c)。

已安装的官方组件通过了 `allow_os_protected_nonextractable` 模式的密钥创建、
公钥读取比对、ECDSA P-256 SHA-256 签名、独立验签以及临时密钥删除。
组件返回的保护类别标签为 `hardware_tpm`，但这里实际使用的是**软件 vTPM**，
该标签不能证明物理硬件保护能力或官方中继会接受控制端。安全证明保存在
仓库外的 `~/.local/state/codex-console-web/official-controller-test/device-key-proof.json`。

设备就绪后，以应用用户复现密钥检查：

```bash
node ~/.local/state/codex-console-web/official-controller-test/check-device-key.cjs
```

管理员初始化助手拒绝覆盖已有 TPM 或状态目录。目前是本次启动期间运行的
实验，尚未配置重启后自动启动。控制端的账号授权、注册、配对和网页命令到达
另一台主机仍待验证。

### 控制端账号授权探针

复用了已安装桌面的 OAuth 二次授权助手，探针放在仓库外的
`official-controller-test/authorize-controller.mjs`。本地检查确认官方授权
地址、远程控制注册 scope、PKCE S256、错误回调 state 拒绝、缺少授权码拒绝，
以及取消时不交换令牌。复现本地检查：

```bash
node ~/.local/state/codex-console-web/official-controller-test/authorize-controller.mjs --self-test
```

实际尝试仅在 localhost 监听回调，选择已有账号工作区。内置浏览器加载官方
登录页的操作超时，没有核验到可用的授权页面。随后取消探针，删除临时链接，
确认回调端口已释放。没有取得二次授权令牌，没有注册控制端，也没有配对设备。
服务器管理员密码与所需的 ChatGPT 账号重新认证相互独立。官方配对要求同一
ChatGPT 账号与工作区，项目目录可以不同。这个探针依赖指定版本的打包代码，
不能证明存在受官方支持的自定义控制端公开 API。

### server 提交所有者提供的配对码

已安装桌面的手动输入码流程调用
`POST /wham/remote/control/client/pair`，请求包含 `client_id` 和
`manual_pairing_code`。码由所有者的**被控设备**提供，server 是提交该码的
控制端。打包界面把八位字母数字规范化为 `XXXX-XXXX`，显示输入框之前要求
控制端已有 client ID。

2026-10-11，server 已将所有者提供的码提交到这个接口。先通过官方注册起始
请求取得新建的待注册控制端 ID，没有复用其他设备的 ID。配对请求返回 HTTP
403，`Remote-control client key material missing`，没有建立连接。随后以 HTTP
204 删除此次待注册测试身份，再次读取确认仍为原有四个已激活客户端，没有
遗留待注册测试身份。连接码、账号凭据和客户端标识均未写入 Git；脱敏证明
保存在仓库外的 `official-controller-test/pairing-code-proof.json`。

Node fetch 直连最初超时，原因是没有使用本机已配置的 HTTP 代理。启用已安装
Node 24 的 `--use-env-proxy` 参数后恢复后端访问，客户端列表读取返回 HTTP
200。server 端剩余缺口是完成受保护设备密钥的控制端注册，然后再试配对码并
验证中继与 RPC 控制。本地创建并验证 TPM 密钥，不等于官方服务已登记该密钥。

### 完成 server 的设备密钥注册

一次性助手 `official-controller-test/enroll-controller.mjs` 已能创建 server
自己的待注册控制端与受保护密钥，校验挑战的账号、client、用途、目标 origin
和 path，并准备原生 `codex-device-key-sign-payload/v1` 证明。nonce 长度、
audience、摘要长度、账号一致、注册 scope 和账号授权新鲜度的检查均通过。
实际注册起始请求返回 200，并创建了密钥；当前等待所有者完成 OpenAI 账号
授权，此时尚未宣称注册成功或建立连接。

不触发注册的回归检查：

```bash
node ~/.local/state/codex-console-web/official-controller-test/enroll-controller.mjs --self-test
```

准备进行账号授权时，以应用用户使用 `node --use-env-proxy` 运行助手。
在 server 的浏览器中完成生成的官方授权链接；若使用另一台电脑的浏览器，
从该电脑执行 `ssh -N -o ExitOnForwardFailure=yes -L 1455:localhost:1455 -L 1457:localhost:1457 <USER>@<HOST>`
转发原生回调端口。回调仍仅在回环地址监听。参见官方的
[SSH 回调转发说明](https://learn.chatgpt.com/docs/auth#fallback-forward-the-localhost-callback-over-ssh)。
待注册密钥、授权链接及最终控制端凭据均以 600 权限保存在 Git 外，不替换已有
Codex 日常登录凭据。

### server 独立承担控制端

要求的架构是 Web → 我们的 server → 被控 Codex 主机。server 必须自行实现
控制端注册、受保护密钥、提交连接码、中继连接以及各主机的命令路由；在
server 上运行官方桌面应用不属于这个要求。此前建议的桌面设置入口已在使用
前撤回并删除，不作为接入前提。上面的 SSH 回调转发只是实验中的无桌面认证
备用方案，不是每台设备配对时都要执行的步骤。

官方连接码流程通过安全中继通信，参见
[远程连接说明](https://learn.chatgpt.com/docs/remote-connections)。已安装桌面
把码提交到 OpenAI 后端，码中没有自定义 server 地址。独立 server 使用这种
流程，需要充当中继控制端；这与未修改的官方客户端直接连入任意自建 server
地址不同。尚未确认自定义中继控制端受到官方支持。

2026-10-12，已检查安装的 CLI 0.159.2 帮助及生成的实验协议 schema。
`remote-control` 提供启动、停止和生成被控主机配对码；`remoteControl/*`
方法管理被控主机，schema 没有控制端注册、接收配对码或连接远端主机的方法。
脱敏结果在仓库外的 `official-controller-test/controller-schema-proof.json`。
生成 schema 不会进行授权、注册或配对。

当前原生 Web server 用配置中的一个后端 URL 创建 `createCodexClient`，
尚无远端主机控制端或多主机路由模块。独立注册探针不会启动桌面 GUI，但仍
复用打包的助手及原生设备密钥组件，尚不是脱离桌面安装的正式实现。

共用一个 ChatGPT 账号及工作区时，控制端注册属于 server 初始化，每台被控
主机各自提供配对码，项目目录可以不同。最近一次授权尝试未收到回调，超时
后已删除临时密钥，并以 HTTP 204 移除待注册控制端。server 仍没有已注册
控制端记录或会话，新提供的主机码未在已知未注册的状态下重复提交。
独立中继控制和官方客户端直连自建 server 均未验证成功。
