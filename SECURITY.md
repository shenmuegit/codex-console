# Security

## Access boundaries

Codex Console exposes a remote desktop application session through HTTPS/WSS with file-based password authentication. The default bind address is all IPv4 interfaces. Use a trusted network/VPN and host firewall, or select a narrower `CONSOLE_HOST`.

An authenticated user can control the app and access the files, projects, accounts, and tools available to your host user. This is a single-user console; it does not provide role separation, app-level sandboxing, or a shared team permission model. Run as a regular user, keep the OS/app/Xpra patched, and use a trusted certificate for ongoing access.

Remote shell, starting new commands, file transfer, printing, webcam, opening files/URLs through Xpra, and microphone forwarding are disabled in the launcher. Those restrictions do not limit what the authenticated desktop app itself can do.

## Sensitive data

The private state directory contains an access password, TLS private key, and app profile with sign-in/session information. The config file is Bash and runs with your user permissions. Store both outside version control and load only your own trusted configuration.

Keep backups private. Redact credentials, window metadata, project paths, and account content before sharing diagnostics. To revoke access, stop the session, rotate the browser access password as described in [Configuration](docs/configuration.md#access-password), and restart. Revoking an app account session is a separate action within the app/account.

## Reporting vulnerabilities

Use the repository's GitHub **Security → Report a vulnerability** feature if private reporting is available. If it is unavailable, open an ordinary issue requesting a private contact channel without including exploit details, credentials, or sensitive data. Do not place a working sensitive exploit or private logs in a public issue.

Include affected source/package versions, the relevant configuration with secrets removed, reproduction steps, and the impact. Current development targets the `main` branch and the documented Xpra/HTML5 baseline; older combinations may require upgrading before a fix can be verified.

## 中文说明

本项目是单用户远程应用控制台。持有访问密码的人可以利用主机用户权限操作桌面应用。建议使用可信网络或 VPN、主机防火墙，并按需收窄监听地址。应用内可执行的操作不受 Xpra 文件传输等功能关闭的限制。

密码、私钥、登录数据和个人配置应保存在仓库外，备份需私密保存。配置按 Bash 加载，仅使用可信文件。公开日志前删除账号、窗口元数据、私人路径和凭据。敏感漏洞优先使用 GitHub 私密报告；没有该入口时，仅公开询问私密联系方式，不披露利用细节。
