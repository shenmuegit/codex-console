# 故障排查

[English](../troubleshooting.md) · [返回首页](../../README.zh-CN.md) · [部署与维护](deployment.md)

## 先检查配置和日志

```bash
./console.sh doctor
systemctl --user status codex-console.service --no-pager
journalctl --user -u codex-console.service -n 100 --no-pager
```

`doctor` 只读检查，显示当前配置、应用路径、监听地址、显示号和数据目录。手动会话使用 `./console.sh status` 并检查数据目录下的 `xpra.log`。请关注命令退出状态；登录页面生成成功，并不意味着桌面应用已经启动。

## 安装问题

| 现象 | 处理方法 |
| --- | --- |
| 提示需要普通用户 | 去掉整个脚本前的 sudo，脚本只会为系统包操作提权 |
| 找不到应用 | 提前安装兼容应用，再传入 `--app /absolute/path/to/chatgpt` |
| 系统不受支持 | 手动安装依赖后使用 `--skip-deps`，参考支持列表 |
| APT 下载失败 | 检查到软件源的网络连通性，解决后重新部署 |
| Ubuntu 找不到多媒体包 | 检查 `universe` 是否启用，以及 Xpra 源是否匹配系统代号 |
| Xpra 低于 6.5 或为 7.x | 选择受支持的 6.x 包，不要跳过版本检查 |
| 缺少 HTML5 资源 | 安装 `xpra-html5`，或把 `XPRA_HTML_DIR` 设为实际 web 根目录 |
| HTML5 页面结构不支持 | 使用已验证的 `19-r1`，或验证并适配新版本再升级 |
| 配置解析失败 | 对配置运行 `bash -n`，路径加引号，应用参数用 Bash 数组 |

已有 Xpra 软件源会保留；旧源导致版本不兼容时，按[官方指南](https://github.com/Xpra-org/xpra/wiki/Download)修正后重新部署。

## 用户服务无法启动

如果 `systemctl --user` 无法连接用户总线，请在目标普通用户的正常登录会话中执行。没有用户服务管理器的主机可以使用 `--no-service`，另行管理进程。

显示号被占用时先查看已有会话：

```bash
xpra list
./console.sh status
```

启用服务前，使用原配置停止之前手动启动的会话。不要停止无关会话；也可选择未占用的 `CONSOLE_DISPLAY` 和端口。

如果登录后才启动，检查 `loginctl show-user "$(id -un)" -p Linger`，按部署文档启用 lingering。项目移动后，从新目录重新部署。直接复制仓库中的服务模板会保留未替换的路径标记，无法正常启动。

## 浏览器无法访问

1. 检查服务是否运行，地址与端口是否和 `doctor` 输出一致。
2. 默认使用 `http://`，配置 TLS 后使用 `https://`；确认手机能够到达主机，检查 VPN 路由、Wi-Fi 客户端隔离和主机防火墙。
3. 执行 `ss -ltn` 查看监听；绑定 `127.0.0.1` 时手机不能直接连接。
4. 浏览器协议需与配置一致：默认使用 HTTP，填写两个 TLS 证书路径后使用 HTTPS。HTTPS 证书需被浏览器信任并匹配访问的主机名。

登录页面可打开但连接失败时，查看浏览器控制台和 Xpra 日志中的 WebSocket/TLS 或认证错误。页面请求和 WS/WSS 连接使用同一个配置端口。

## 密码验证失败

在主机上使用与服务相同的配置，执行 `./console.sh password`。不要输入桌面应用的账号密码。使用多份配置时，可通过 `systemctl --user cat codex-console.service` 核对实际配置路径。

修改密码文件后重启服务并刷新页面。访问密码不会持久保存在浏览器中；验证失败会清除当前页面缓存的密码，以便重新输入。

## 已连接但没有应用窗口

检查应用是否可执行，并符合[窗口身份要求](deployment.md#桌面应用兼容性)。保留 X11 启动参数，检查 `xpra.log` 中的应用启动错误或缺失动态库。窗口类名或数据目录身份不匹配的应用会被过滤。

正常关闭主窗口后，监控进程会再次打开。维护时停止服务或手动 Xpra 会话。独立的数据目录单独保存登录信息，移动数据或更换目录后可能需要再次登录。

## 登录提示去浏览器验证，但没有显示浏览器

桌面应用会在主机的默认浏览器中打开登录页面。控制台允许转发 Firefox ESR
窗口，即使它由 `xdg-open` 启动、不是应用监控进程的直接子进程。浏览器放行
规则必须放在父进程过滤规则之前；其他桌面应用的数据目录仍会被排除。

在主机上将 Firefox ESR 设为默认 HTTP/HTTPS 浏览器。如果安装修复时服务已在
运行，请在合适的维护时间重启服务并重新连接控制台，然后在显示的 Firefox
窗口中完成账号登录。控制台访问密码和账号登录是两种不同的验证。

## 输入、手势与画面问题

| 现象 | 处理方法 |
| --- | --- |
| 确认的文本无法发送 | 聚焦远端输入框，确认连接就绪并启用剪贴板转发 |
| 断线后文本仍在输入框 | 重连后再提交；尚未提交的文本会保留在本地 |
| 滚动变成拖动 | 双指同时滑动；单指滑动执行拖动 |
| 意外出现右键菜单 | 右键使用双指轻点；单指连续轻点仍为左键点击 |
| 键盘挡住输入区域 | 使用原生键盘控制及支持 `visualViewport` 的浏览器 |
| 旧会话点击位置不准确 | 重启会话，使用新的 4096 × 4096 Xvfb 配置 |
| 操作或画面卡顿 | 切换到流畅，检查主机 CPU 与网络质量 |
| 更新后仍显示旧界面 | 重新部署以刷新资源，重启并刷新浏览器 |

## 客户端网络监控

运行 `./console.sh prepare` 后刷新浏览器。密码验证成功后，客户端每五秒通过现有 WS/WSS 连接上报一次网络数据。HTTPS/WSS 继续使用配置的端口（默认 15443），无需单独监听端口或开放 HTTP 收集接口。

在服务器读取每个客户端最近的一份报告：

```bash
./console.sh network | python3 -m json.tool
# 其他实例使用其原来的配置：
CONSOLE_CONFIG=/absolute/path/config.sh ./console.sh network
```

命令读取与该实例匹配的服务日志（最近十分钟，最多 1,000 条报告），或手动会话 `xpra.log` 的最后 1 MiB，只输出允许的诊断字段。`clients: []` 表示没有找到有效报告。`age_seconds` 从服务器收到报告时计算；`stale: true` 表示已超过 30 秒，不能据此认定客户端仍在线。在浏览器控制台运行 `window.codexConsoleNetwork.snapshot()` 可读取当前本地指标。

| 字段 | 含义 |
| --- | --- |
| `rtt_ms`、`rtt_p95_ms`、`jitter_ms`、`rtt_sample_age_ms` | 复用 Xpra 心跳测得的往返延迟、95 分位数、相邻样本差值的平均值和样本年龄，单位毫秒；最多保留最近 60 个心跳样本 |
| `image_kbps`、`draw_updates_per_sec` | 最近五秒的编码画面载荷速率和成功画面确认次数；不代表链路总带宽或屏幕 FPS |
| `decode_ms`、`decode_p95_ms`、`decode_errors`、`queued_paints` | 客户端最近的画面处理耗时（毫秒，每个上报周期最多保留 60 个样本）、处理失败次数和等待/正在绘制的画面数；处理耗时不是输入到显示的总延迟 |
| `event_loop_lag_ms`、`visible`、`online`、`reconnects` | 本周期前台定时器的最大延误、页面可见状态、浏览器在线提示和本次页面打开后的重连次数 |
| `encoding`、`render_width`、`render_height`、`render_density`、`scale` | 最近一次画面编码及当前渲染设置 |
| `secure_context`、`decode_worker`、`offscreen`、`webcodecs` | 安全上下文和解码 API/线程可用情况；不能据此确认硬件加速已经启用 |
| `network` | 可选的浏览器网络提示：有效网络类型、估计 RTT/下行速率和省流模式。不支持的值为 `null`，不能用这些提示判断手机是否经过 VPN 或代理 |

报告仅含随机客户端标识及数值、布尔值诊断信息，不含密码、文档正文、URL、窗口标题或图像内容。断线时停止上报，通过验证重新连接后恢复。空闲周期的画面流量为零，解码样本为空。报告沿用主机现有的日志保留策略。

## 音频问题

在工具栏开启音频，并点击页面以满足浏览器播放权限。检查设备音量，以及主机 PulseAudio、GStreamer 编解码器。`./console.sh status` 应能显示会话信息；完整的 `xpra info <显示号>` 可以辅助检查音频，但可能包含私人窗口元数据。

需要真实验证时，选择允许额外连接和短暂测试音的会话运行 `./scripts/check.sh --live`。此检查要求 Opus/WebM、AAC/MP4 支持。启动脚本默认禁用麦克风转发。

## 反馈问题

提供系统与架构、Xpra 与 HTML5 包版本、浏览器和设备版本、安装命令、复现步骤及相关错误。公开之前删除访问密码、私钥、账号、窗口标题、私人项目路径与包含私人内容的截图。普通问题提交到 [GitHub Issues](https://github.com/shenmuegit/codex-console/issues)，敏感漏洞按[安全说明](../../SECURITY.md)处理。
