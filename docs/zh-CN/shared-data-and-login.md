# 与 KDE 客户端共用 Codex 数据和登录

[English](../shared-data-and-login.md)

KDE 客户端和 Xpra 控制台使用同一个桌面用户运行，两边通过 `~/.codex`
共用项目和会话数据、配置，以及缓存的 ChatGPT 登录。控制台仍使用独立
X11 显示会话，KDE 锁屏不会阻断控制台。

以该桌面用户安装明确的数据目录设置：

```bash
mkdir -p ~/.config/systemd/user/codex-console.service.d
cp codex-console-shared-data.conf ~/.config/systemd/user/codex-console.service.d/shared-data.conf
systemctl --user daemon-reload
systemctl --user restart codex-console.service
```

此设置将 `CODEX_HOME` 固定为该用户的 `~/.codex`。KDE 客户端以同一用户
运行时，默认使用这个目录；如果其启动器设置了不同的 `CODEX_HOME`，需要
移除该覆盖。其他 Linux 用户运行的客户端默认使用各自的用户目录。

使用文件凭据存储时，两边共用的登录文件是 `~/.codex/auth.json`，参见
[OpenAI 身份验证文档](https://learn.chatgpt.com/docs/auth#login-caching)。
如果安装配置使用密钥环或临时存储，应检查对应的凭据存储设置。登录发生
变化时，之前已经运行的客户端可能需要重启才能读取当前缓存的凭据。

KDE 的 Electron 配置目录和控制台的 Electron 配置目录各自保存窗口状态
与浏览器缓存，供运行中的 Electron 进程使用。通过 `CODEX_HOME` 共用
Codex 数据目录；同时共用运行中的 Electron 配置目录可能触发单实例锁，
使操作回到另一个显示会话。

## 本机验证

在 Debian 13 上，KDE 的 `:10` 会话保持锁屏，控制台在 `:100` 上接受
连接。两边的 app-server 进程均打开
`/home/desktop/.codex/state_5.sqlite`。控制台继承
`CODEX_HOME=/home/desktop/.codex`，`codex login status` 显示使用 ChatGPT
登录，现有渲染器进入项目输入界面，没有出现登录提示。检查未额外启动
GUI 客户端，也未发起新的登录。
