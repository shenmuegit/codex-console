# Use the original Codex client

[中文](zh-CN/original-codex-client.md)

The installed client previously shown through Xpra uses `~/.codex` and the
Electron profile `~/.local/state/codex-console/profile`. The browser now uses
that original data directly through the installed `codex-cli 0.159.2` app-server.
Xpra stays disabled. HTTPS remains on port 15443; native WebSocket stays on
`127.0.0.1:4500`.

The owner requested no backup. No database, account or conversation copy is kept.
Configuration, runtime evidence and the desktop reload job live outside Git.

To repeat this connection change:

1. Edit the existing private web configuration; keep its credentials/TLS fields.
   Set `backendExecutable` to `/usr/lib/chatgpt/resources/codex`, `backendHome`
   to the original absolute Codex home, and `allowOriginalHome` to boolean `true`.
   Set `backendArgs` to the original native command arguments, including
   `app-server` and its existing `-c` overrides. `--listen` and the loopback URL
   are added by the service renderer. The default initializer continues to refuse
   the original home; do not run initialization against it.
2. Use the original desktop working directory as `workspace`. Scope
   `generatedRoots` to the existing workspace, managed worktrees, attachments
   and visualization directories; do not allow the whole Codex home.
3. Stop the two owned web/backend units, install the updated units, then start
   them with `node web/service.mjs stop`, `install`, and `start`. Verify the
   native handshake home, original project IDs, readable history, account and
   model catalog through the authenticated HTTPS API.
4. Set `CODEX_APP_SERVER_WS_URL=ws://127.0.0.1:4500` for the original desktop
   service and user launcher, retaining the original Electron profile. Reload
   the desktop after the current control turn completes, then verify its TCP
   connection to the shared backend. The one-shot reload reports its result in
   `~/.local/state/codex-console-web/original-client-switch/desktop-verification.json`.

The change requires no new native login and does not rewrite project directories.
Open the HTTPS home page and sign in again after the web service reload; an old
test-thread URL belongs to the retired isolated backend.

127 Node checks passed, including default original-home refusal, explicit reuse,
private-file protections and quoted native command arguments. The live HTTPS
check confirmed the original project set and conversation history, available
login, model catalog, and loopback-only native listener without inference.
