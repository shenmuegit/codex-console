# Share Codex data and login with the KDE client

[中文](zh-CN/shared-data-and-login.md)

Run the KDE client and the Xpra console as the same desktop user. Both use
`~/.codex` for project and conversation data, configuration, and the cached
ChatGPT login. The console keeps its own X11 display, so KDE locking does not
interrupt the console.

Install the explicit data-directory setting as that desktop user:

```bash
mkdir -p ~/.config/systemd/user/codex-console.service.d
cp codex-console-shared-data.conf ~/.config/systemd/user/codex-console.service.d/shared-data.conf
systemctl --user daemon-reload
systemctl --user restart codex-console.service
```

The setting pins `CODEX_HOME` to that user's `~/.codex`. The KDE client defaults
to the same directory when it runs as the same user; remove any different
`CODEX_HOME` override from its launcher. A client run as another Linux user
defaults to that other user's directory.

For file credential storage, the shared login is `~/.codex/auth.json`. See
[OpenAI's authentication documentation](https://learn.chatgpt.com/docs/auth#login-caching).
Check the credential-store setting if the installation uses a keyring or
ephemeral storage. A client that was already running when login changed may
need to be restarted to load the current cached credentials.

The KDE Electron profile and console Electron profile remain separate. These
contain window state and browser caches and are used by running Electron
processes. Reuse the Codex data directory through `CODEX_HOME`; sharing a live
Electron profile can hit its single-instance lock and move control back to
the other display.

## Verification on the installed system

On Debian 13, the console was checked on display `:100` while the KDE session
on `:10` remained locked. Both app-server processes opened
`/home/desktop/.codex/state_5.sqlite`. The console inherited
`CODEX_HOME=/home/desktop/.codex`, `codex login status` reported ChatGPT login,
and its existing renderer showed the project composer without a login prompt.
The check did not launch an additional GUI client or request another login.
