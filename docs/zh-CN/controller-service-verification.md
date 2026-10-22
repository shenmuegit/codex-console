# 控制端服务验证

独立控制端复用现有的口令认证 HTTPS 入口。原私有配置和 unit 的备份及
测试后的替代文件保存在 Git 外。部署保留原所有者口令 hash、状态目录、
TLS 身份和原生后台/home，修改 Web 源码目录、可选控制端配置及 Node 代理参数；
不重启原生后台，原生会话保留；Web 重启后需用原口令重新登录。
回滚恢复私有配置/unit 备份，仅重启 Web 服务。

前置证据：所有者登录、本机原生状态、控制端状态通过实际请求检查；
未登录控制端请求返回 401，未登记时的远端请求返回 409，没有回退本机。
本机真实原生 fs 读写及符号链接元数据通过；原生 command/exec 在私有祖先
下的隔离目录创建 0700 所有者存储，并拒绝组可写祖先。
原生 getAuthStatus(includeToken:false, refreshToken:true) 通过，未返回令牌、
账号保持一致。这些是本机前置检查，不能代表远端配对或 Windows 实机证据。

所有者官方账号确认、实机登记和 Windows 桌面客户端配对已通过；实际远端
控制/事件及附件写入/读取已通过，两个真实官方实例的并发控制及隔离也已通过。
恢复检查记录见下文。公开文档未确立第三方控制端 SDK；
当前协议是特定版本的观察实现。软件 vTPM 是实验，不代表物理硬件保护；
现已配置开机启动，恢复记录见下文，机器重启仍未验证。不能依据夹具宣称总体完成。

## 当前部署（2026-10-12）

所有者入口：https://117.72.158.35:15443。Web 用户 unit 已使用经审查的 checkout
和 `--use-env-proxy`；原生后台 PID 保持不变。隔离的 15444 测试 unit 已停止。
本机防火墙允许流量，但 15444 从公网不可达，因此复用原入口，无需新公网端口。

代码提交 `0845aad` 的公网入口实测：使用配置 CA 验证 TLS 后，所有者登录 200、
本机原生在线、控制端状态 200/unconfigured、未知远端请求
409/CONTROLLER_NOT_ENROLLED、未登录控制端请求 401。
返回的 index/app/connections 内容与经审查的源码一致。
`591e6d6` 的完整检查 414/414 通过，最后启动/恢复改动的相关检查 41/41 通过；
整体审查和修复复审均通过。内置浏览器导航超时，未验证真实浏览器/移动端布局。

## 复现与回滚

实际路径、口令 hash、密码及状态均放在 Git 外私有配置中。修改前备份原配置和
受管理的 Web unit。保留 origin/port、passwordHash、stateDir、TLS、
backendHome/executable 和 workspace，将 repoDir 指向经审查的 checkout，
配置私有原生密钥组件与外部控制端状态。运行 `web/service.mjs` 的 validateConfig，
通过 renderUserUnits 仅生成 Web unit；reload 用户 systemd，只重启
codex-console-native-web.service。核验原生后台 PID 未变，使用配置 CA 验证
HTTPS（不禁用验证），检查登录/状态/未登录拒绝及静态资源与源码一致。
回滚时恢复私有配置/Web unit 备份，reload 后仅重启 Web，保留控制端及原生数据。

在 Web 选择“连接设备 → 授权控制端”，使用与被控端相同的 ChatGPT 账号/工作区
完成官方账户确认。另一台电脑的浏览器若到达无法打开的 localhost callback，
将该 URL 复制到 Web 的回调输入框；服务器只将它作为数据验证，无需 SSH 转发。
登记成功后再提交被控主机生成的新配对码，方向为被控端提供、服务器接收。
官方服务接受实机登记和 Windows 桌面客户端配对的记录见下文。

## 所有者配合的登记尝试（2026-10-12）

所有者已在浏览器完成确认，服务器收到回环回调；随后换取令牌失败。
实际公开状态为 `enrolled: false`、`phase: unconfigured`、
`errorCode: TOKEN_EXCHANGE_FAILED`。未执行登记 finish 或被控端配对码提交。

使用无效诊断码、没有真实凭据的检查复现：配置的 HTTP 代理在建立安全 TLS
连接前失败（Node 为 ECONNRESET，curl 为 unexpected EOF）；直连 POST 返回
HTTP 403 和 unsupported_country_region_territory。现有 SOCKS 代理的 GET
返回 405，仅能证明收到 HTTP 响应，不能证明服务资格或 OAuth 换取成功。
直连检查不能直接证明原代理路径失败的原因。本记录不包含真实回调 code、
verifier、access token 或账号 ID。应先确认服务端具备合法、受支持的访问环境，
再安排所有者确认；不以绕过地区限制作为回退。

## 仅 main 部署与连接复查（2026-10-12）

已有 Web 和控制端实现合入 `main`，运行中的 Web unit 和私有配置指向现有
`main` 工作目录，未创建或切换分支。原有无关未提交改动单独保留，私有配置和
unit 备份仍在 Git 外。完整 Web 检查 438/438 通过；使用配置 CA 验证 HTTPS 后，
所有者登录、控制端状态、未登录拒绝、未登记主机拒绝和静态资源内容一致性通过。
原生后台 PID 未变。

随后通过同一个现有 HTTP 代理、使用无效诊断凭据的 POST 已到达令牌接口，
返回 HTTP 401 和 `token_expired`；这次检查未复现先前 TLS 断连，但不能证明
有效 OAuth 授权或登记成功。上次授权尝试已经过期，配对前需要重新完成
所有者确认。

确认没有已登记身份或未完成候选记录后，新的授权开始请求返回 200，并在桌面
浏览器打开官方确认地址。08:18 UTC 实测状态为 `authorizing`；桌面 Codex unit
处于停止状态，单独 Node 进程通过原生组件成功读取服务器的候选公钥。
这证明登记准备可独立运行，不能代表登记或配对已被接受；软件 vTPM 的限制仍适用。

## Step-up 身份绑定修复（2026-10-12）

下一次所有者确认已到达回调并完成令牌交换，但本地校验返回 `INVALID_STEP_UP`。
观察到的官方登记流程用日常令牌中的工作区用户校验 step-up，同时让挑战和
登记记录保留服务返回的用户身份。一次实际 start 探测返回 200，确认服务用户
等于登录用户、不同于工作区用户；探测自己的候选身份通过 DELETE 204 清理。
本记录不含原始令牌或用户身份。

适配器现在用工作区用户校验 step-up，设备证明和登记记录继续使用独立的服务
身份。三个回归检查覆盖合法授权通过、拒绝用登录用户替换工作区用户，以及
拒绝缺少工作区身份。控制端检查 30/30、完整检查 441/441 通过。
实机登记被接受及主机控制仍需新的确认流程。

## 网页确认后获取新挑战（2026-10-12）

后一次所有者确认通过了 step-up 校验，但提前分配的设备挑战已过期，返回
`INVALID_CHALLENGE`。实际 start 探测发现挑战仅剩约 118 秒，而网页确认允许
600 秒；探测自己的候选身份通过 DELETE 204 清理。适配器现在先用本地记录
占用设置流程，等待官方确认后再申请挑战、创建密钥并完成登记。后端接口、
身份绑定、受保护签名和有效期检查保留。回归检查模拟三分钟确认与两分钟
挑战，并覆盖分配时机变化后的归属与清理。
完整检查 443/443 通过；实机登记仍需重新确认。

## 实机服务器登记被接受（2026-10-12）

12:27 UTC，完成官方网页确认后，HTTPS 所有者 API 返回 `enrolled: true`、
`phase: ready`。私人登记记录权限为 600，待处理归属记录已移除。仅重启 Web
后，登记记录和原生后台 PID 保持不变，桌面 Codex unit 仍处于停止状态。
重启后状态继续为 ready，官方设备清单请求返回 200，已配对主机数量为零。
这证明独立服务器登记被接受且能跨 Web 重启保留，尚不能证明被控端配对、
远端 RPC、主机并发或机器重启恢复。软件 vTPM 仍属实验。

## Windows 桌面控制及附件验证（2026-10-12）

12:36 UTC，录入所有者提供的被控端配对码返回 200。官方设备清单显示一台
在线 Windows 桌面客户端，原生 app-server 版本为 `0.162.0-alpha.17.2`。
经口令认证的 Web API 成功读取项目、会话和模型清单，文字测试任务完成并
收到原生流式事件。服务器桌面 Codex unit 保持停止状态。

附件准备起初误拒绝标准系统盘 ACL：目录所有者为 TrustedInstaller，其他
用户拥有 CreateDirectories 权限。适配器现在仅在祖先检查中信任准确的
TrustedInstaller 服务 SID，允许创建新子目录，仍拒绝修改/删除已有祖先及
改变其权限的授权。附件存储仍要求当前用户为唯一获准主体、基础目录 DACL
禁止继承，并拒绝重解析点。这些权限区别依据微软的
[SID 文档](https://learn.microsoft.com/en-us/windows-server/identity/ad-ds/manage/understand-security-identifiers)
和[文件系统权限定义](https://learn.microsoft.com/en-us/dotnet/api/system.security.accesscontrol.filesystemrights?view=net-10.0)。

14:27 UTC，复用现有测试会话，成功发送已暂存的文本附件。原生命令读取了
Windows 文件；任务完成后的助手回复和渲染记录均含文件内的随机标记，提示词
没有该标记。HTTPS 发送返回 200，SSE 记录 74 个事件，包括命令项和任务完成。
这次传输没有新建会话。私人测试证据及应用数据均保存在 Git 外。

Windows 回归检查实际运行 PowerShell：允许祖先拥有 CreateDirectories，
拒绝七种修改/删除/改变 ACL 的权限，拒绝共享存储和 junction。在 Windows
执行 `node --test --test-name-pattern="^Windows native ACL"
tests/web/remote-upload-storage.test.mjs` 可复现。Linux 完整检查 443 个通过、
零失败，八个 Windows 专用检查跳过。Windows 主机通过原生 command/exec
执行同一个测试文件，八个检查全部通过；原有实现未通过正向检查。
机器重启仍未验证。

## 两个官方实例同时控制（2026-10-12）

临时官方 CLI app-server `0.159.2` 使用同一个已授权账号、隔离的私有 Codex
home 和独立空工作目录。原生 `remoteControl/enable` 与
`remoteControl/pairing/start` 生成被控端代码，由现有 Web/控制端录入，
返回 HTTP 200。整个流程不依赖桌面 GUI；Windows 测试复用现有验证会话。

14:43 UTC，通过 Web 同时向 Windows 桌面和隔离 CLI 发送任务，均返回 200。
两个原生任务的执行时间重叠，且均完成。各自渲染记录包含自己的随机标记，
没有另一端的标记；两个 SSE 流互相隔离，分别记录 57 和 48 个事件。
将 Windows 附件按 CLI 主机读取返回 404。这是真实官方中继上的两个实例
并发证据，且远端工作目录独立。

复现时，使用独立官方 app-server、Git 外私有状态、已授权账号和回环连接。
启用原生远程控制，获取其人工配对码，再经现有控制端 API 录入。使用按主机
隔离的 view/事件及已有测试会话，比较原生任务时间区间、回复标记和跨主机
文件请求。配对码、身份、凭据和应用数据均放在 Git 外。

## Web 服务恢复（2026-10-13）

02:51 UTC，仅重启 Web 后，控制端登记身份、两个已配对主机身份及原生后台
进程保持不变。所有者登录后，用新的、按主机隔离的 view 打开两端已有测试
会话，两个渲染记录均恢复原有标记。无需新主机配对码或重新登记控制端。
服务器桌面 GUI 保持停止状态。

只读检查遇到上游设备清单的间歇性失败，并使用有限次重试；这仍是稳定性
限制。本项证明 Web 重启恢复，尚未验证被控客户端完整冷启动和机器重启；
软件 vTPM 尚未配置重启启动的限制仍然适用。

临时 CLI 主机按其明确的 environment ID 撤销控制端关系，禁用远程控制，
停止隔离运行实例，并删除复制的凭据文件。03:03 UTC，所有者 API 确认登记
仍为 ready，已配对设备只剩在线 Windows 桌面客户端，临时 CLI 主机已移除。
原生后台与 Web 保持运行，桌面 GUI 保持停止状态。

## TPM 缺失导致设备连接禁用（2026-10-22）

经所有者登录及证书校验的 HTTPS 控制端状态返回 200，内容为
`phase: unavailable`、`enrolled: false`、`enrollmentPreserved: true` 和
`errorCode: DEVICE_KEY_UNAVAILABLE`；设备清单返回
409/CONTROLLER_NOT_ENROLLED。私人注册记录和原生密钥封装文件仍在。
Web 日志显示 `/dev/tpmrm0` 无法打开，系统中没有运行中的 `swtpm`、TPM
设备或已加载的 `tpm_vtpm_proxy` 模块。原有实验性 vTPM 没有开机服务。
授权按钮禁用是为了保护已有注册身份，配对则需要能正常使用的密钥。

恢复必须使用原 vTPM 的加密持久状态和原加密密钥。首次初始化脚本会拒绝
已有状态，不能用它重新初始化替代身份。
[内核代理文档](https://cdn.kernel.org/doc/html/latest/security/tpm/tpm_vtpm_proxy.html)
说明如何创建设备并将文件描述符传给模拟器；
[swtpm 0.7.1 手册](https://github.com/stefanberger/swtpm/blob/v0.7.1/man/man8/swtpm.pod)
说明持久状态、加密及降低进程权限的选项。

私有恢复安装脚本、启动脚本和 systemd unit 保存在仓库外。它们要求已有
非空持久状态及 32 字节加密密钥，拒绝替换运行中的 TPM 进程或设备，启动前
备份原状态，将运行组件安装为 root 所有，并启用开机服务。原控制端注册
记录和密钥封装文件予以保留。在 root 终端执行已审阅的私有安装脚本，或由
可使用 sudo 的管理员执行：

```bash
sudo /bin/bash /absolute/private/path/install-recovery.sh
```

随后检查服务 active、`/dev/tpmrm0` 仅应用用户可访问、原密钥能签名、HTTPS
控制端状态为 ready、设备清单成功；在设备弹窗刷新清单，确认配对按钮可用。

安装脚本已通过 root 执行。系统服务 `codex-console-controller-vtpm.service`
为 active、enabled；`/dev/tpm0` 和 `/dev/tpmrm0` 权限为 600，属于应用用户。
原注册记录和密钥封装文件的校验和与恢复前一致，原公钥读取和新签名验证
均通过。Web 与原生后台 PID 保持不变。

经证书校验的 HTTPS 控制端接口随后返回 200、`enrolled: true`、`phase: ready`，
设备清单返回 200，保留一个已有配对设备。用这些实机响应挂载实际连接界面，
确认配对按钮启用、首次授权区域隐藏。用截图旧连接码进行一次配对，已到达
官方接口并返回 410 Gone（对外为 502/REMOTE_REQUEST_FAILED）；未重试，
需要被控客户端提供新码。已有配对设备当时未在线，因此本次恢复尚不能证明
远端客户端已实际连通。

Shell 及内嵌 Python 语法、状态保留断言、非 root 拒绝、备份顺序和 systemd
unit 检查均通过，控制端、HTTP 和连接界面回归检查通过 49/49。机器重启和
浏览器实际交互仍未验证；软件 vTPM 仍属实验。
