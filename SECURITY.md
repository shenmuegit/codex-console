# Security

## Access boundaries

Codex Console exposes a remote desktop application session through HTTPS/WSS with file-based password authentication. The default bind address is all IPv4 interfaces. Use a trusted network/VPN and host firewall, or select a narrower `CONSOLE_HOST`.

An authenticated user can control the app and access the files, projects, accounts, and tools available to your host user. This is a single-user console; it does not provide role separation, app-level sandboxing, or a shared team permission model. Run as a regular user, keep the OS/app/Xpra patched, and use a trusted certificate for ongoing access.

Remote shell, starting new commands, printing, webcam, opening URLs through Xpra, and microphone forwarding are disabled in the launcher. Authenticated file upload is enabled into the private state directory's `uploads/`. Xpra's open-file hook runs only `upload.py`, which validates the completed path and request, preserves the original filename, and notifies the originating browser; it does not execute or open uploaded contents. Files are retained for the app to read. These restrictions do not limit what the authenticated desktop app itself can do.

Window filtering uses XRes process ownership: only windows belonging to the app processes launched directly by `app-watch.sh` are forwarded. This includes their native GTK file pickers, which lack the dedicated profile's window class. Other application processes remain excluded.

## Sensitive data

The private state directory contains an access password, TLS private key, and app profile with sign-in/session information. The config file is Bash and runs with your user permissions. Store both outside version control and load only your own trusted configuration.

Keep backups private. Redact credentials, window metadata, project paths, and account content before sharing diagnostics. To revoke access, stop the session, rotate the browser access password as described in [Configuration](docs/configuration.md#access-password), and restart. Revoking an app account session is a separate action within the app/account.

## Reporting vulnerabilities

Use the repository's GitHub **Security → Report a vulnerability** feature if private reporting is available. If it is unavailable, open an ordinary issue requesting a private contact channel without including exploit details, credentials, or sensitive data. Do not place a working sensitive exploit or private logs in a public issue.

Include affected source/package versions, the relevant configuration with secrets removed, reproduction steps, and the impact. Current development targets the `main` branch and the documented Xpra/HTML5 baseline; older combinations may require upgrading before a fix can be verified.

## 中文说明

本项目是单用户远程应用控制台。持有访问密码的人可以利用主机用户权限操作桌面应用。建议使用可信网络或 VPN、主机防火墙，并按需收窄监听地址。上传文件保存在私有状态目录的 `uploads/` 中；完成回调仅验证路径、恢复文件名并通知原浏览器，不执行上传文件。文件不会自动清理。窗口过滤按应用进程归属放行其原生选择框，并继续排除其他应用。应用内可执行的操作不受这些 Xpra 限制约束。

密码、私钥、登录数据和个人配置应保存在仓库外，备份需私密保存。配置按 Bash 加载，仅使用可信文件。公开日志前删除账号、窗口元数据、私人路径和凭据。敏感漏洞优先使用 GitHub 私密报告；没有该入口时，仅公开询问私密联系方式，不披露利用细节。
