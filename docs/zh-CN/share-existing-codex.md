# 共享 KDE 中已经打开的 Codex 窗口

[English](../share-existing-codex.md)

默认控制台在独立 X11 显示会话里启动另一份 Codex，使用单独的 Electron
配置目录。需要控制 KDE 中已经打开的 Codex 时，可切换到 Xpra 的
[shadow 模式](https://xpra-org.github.io/xpra/Usage/Shadow.html)，共享现有窗口，
不再启动另一份 Codex。

## 准备与切换

仓库中的 drop-in 使用当前桌面用户的 KDE 显示号 `:10`、名称以 `Codex`
结尾的默认 Electron 配置目录，以及原控制台的 HTTP 端口、网页资源和访问
密码文件。实际安装不同时，请调整显示号、监听地址、路径或 TLS 参数。
KDE 需保持登录并解锁；此服务不会启动 KDE 或 Codex。重启主机后，服务会
按重试策略等待 KDE 显示会话可用。

已测试的 Xpra 6.5.4 版本在单窗口共享时，向 `X11ShadowModel` 多传了一个
参数。先备份已安装的模块，仅当该处确实存在相同的不兼容调用时，应用
`scripts/xpra-6.5-shadow-constructor.patch`。此补丁同时使用 X11 绝对坐标，
避免 KDE 窗口边框造成捕获区域和鼠标位置偏移。系统包升级可能覆盖这处本地
修正；重新应用前应再次检查构造函数。

单窗口模式还会每秒检查一次窗口，即使手机尚未连接或 Codex 尚未打开。
因此开机服务能发现随后打开的 Codex，并在窗口恢复或重新打开后再次识别。
可运行 `python3 test_shadow_discovery.py` 验证；它会自动关闭临时显示会话
和测试窗口，不启动 Codex。

验证共享画面后，以桌面用户执行：

```bash
./console.sh prepare
mkdir -p ~/.config/systemd/user/codex-console.service.d
cp codex-console-shadow.conf ~/.config/systemd/user/codex-console.service.d/share-kde.conf
systemctl --user daemon-reload
systemctl --user restart codex-console.service
```

重启会关闭独立控制台中的 Codex，请先结束该实例中的工作。KDE 中的 Codex
进程继续运行。切换后刷新手机控制台页面；现有桌面窗口保持原尺寸，按比例
缩放，不拉伸。手机输入可点击键盘按钮。原生文件选择框的手机上传浮层属于
独立会话模式，shadow 模式中不提供此浮层。

## 只捕获 Codex 自身的画面

已测试的 Xpra 6.5.4 在选择窗口后，仍然截取该窗口所在位置的桌面像素。
因此，即使窗口元数据选中了 Codex，其他应用或 KDE 锁屏遮住它时，画面
也会被替换。该版本的截图请求还会捕获整个桌面。

应用前述兼容补丁后，备份已安装的模块，再应用
`scripts/xpra-6.5-window-pixels.patch`。此修正直接读取所选窗口自身的
XComposite 像素缓冲，截图也仅由所选窗口组成；窗口消失时不会退回截取
桌面。重启共享服务后生效，系统包升级可能覆盖此修正。

`python3 test_shadow_capture.py` 在独立 Xvfb 显示会话上检查真实像素：
蓝色窗口盖住绿色目标窗口后，捕获画面和截图仍须只包含绿色目标窗口。
它还检查窗口移动、调整尺寸和关闭的情况。测试窗口和临时显示会话会
自动关闭。

修正后，KDE 锁屏画面不会传到手机上。鼠标和键盘操作仍需要 KDE 解锁。
需要明确选择关闭远程桌面账号的自动锁屏，或在需要时手动解锁；像素
捕获修正本身不会更改账号的锁屏设置。

## 验证与恢复

检查 `server.type=Python/bindings/x11-shadow`、`features.shadow=True`，
并对照捕获窗口的 `xid` 与 KDE 中的 Codex 窗口。确认只剩一个 Codex 主进程，
Xpra 服务命令中没有 `--start-child`。在同一显示号启动正式服务前，先停止
临时共享测试服务。

Debian 13 与 Xpra 6.5.4 上的切换使用经过密码验证的 WebSocket 窗口元数据
进行了检查：捕获原 KDE Codex 的 XID，排除桌面任务栏。手机尺寸回归检查
和现有 `scripts/check.sh` 覆盖客户端改动。

恢复独立会话配置：

```bash
rm ~/.config/systemd/user/codex-console.service.d/share-kde.conf
systemctl --user daemon-reload
systemctl --user restart codex-console.service
```

旧 Electron 配置目录和项目数据保留，可用于恢复。关闭或最小化共享的 Codex
窗口后，Xpra 不再显示它，请在 KDE 中重新打开。KDE 显示号变化时，更新
drop-in 中的显示号并重启服务。停止 Xpra 共享不会关闭桌面应用。
