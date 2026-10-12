# Local source app-server and an additional desktop client

[中文](zh-CN/local-app-server-test.md)

Verified on 2026-10-08 (Asia/Shanghai). The official source checkout built
successfully, and an additional desktop instance connected to that binary over
WebSocket. A separate protocol client submitted one model turn to the test thread;
the desktop displayed its streamed reply, `LOCAL_APP_SERVER_OK`.

## Verified configuration

| Item | Result |
| --- | --- |
| Official source | `ff9ab4aed96aa2e105f78b9521dbbd3a6b329dc8`, clean checkout |
| Rust | `1.95.0`, minimal toolchain installed for this test |
| Build | `codex-app-server` binary, `dev-small`, one build job, exit 0; 20m 33s |
| Binary version | `codex-app-server 0.0.0`; the source workspace uses this development version, so identify the build by commit and hash |
| Binary SHA-256 | `b81339baaec5735b317fd725fe8319b892aa94b633219d0957a22a661eed83ca` |
| Desktop | Installed build `26.928.21956`; its bundled CLI remains `0.159.2` |
| Test endpoint | `ws://127.0.0.1:4500` |
| Desktop handshake | Server identified `Codex Desktop`; desktop `local` state became `connected`, `initialized=true`, transport `websocket` |
| Protocol reads | Model, project, thread, loaded-thread and account reads succeeded; four catalog models and the existing login snapshot were available |
| Generation | Catalog default `gpt-6-astra`, low effort; completed with `LOCAL_APP_SERVER_OK`, visible in the additional desktop |

The original desktop and its stdio app-server remained running. The test used a
separate Codex home and Electron profile; no original conversation database was
opened or migrated. A private copy of the existing login file was used. The new
desktop did update its own test configuration and install its default plugins.

## Reproduce

These commands describe the original experiment. Its temporary build/data
directories are no longer present; the browser implementation reconstructs them
in the persistent paths documented in [the operator guide](native-web-client.md).
Build only the standalone
app-server binary; replacing the installed desktop binary is unnecessary.

```bash
export PATH="$HOME/.cargo/bin:$PATH"
cd /home/desktop/Documents/Codex/codex-console/codex/codex-rs
CARGO_HTTP_MULTIPLEXING=false \
CARGO_TARGET_DIR="$HOME/.cache/codex-console-shared-server-test/target" \
CARGO_INCREMENTAL=0 \
cargo +1.95.0 build --locked --profile dev-small -j 1 \
  -p codex-app-server --bin codex-app-server
```

The first dependency-index download repeatedly timed out with HTTP multiplexing;
disabling it allowed the locked dependencies to download. No source or lockfile
changes were needed. Build artifacts stay outside the checkout.

In one shell, prepare private test directories and start both processes:

```bash
test_root="$HOME/.local/state/codex-console-tests/source-app-server-20261007"
test_codex_home="$test_root/codex-home"
test_desktop_profile="$test_root/desktop-profile"
test_workspace="$test_root/workspace"
install -d -m 700 "$test_root" "$test_codex_home" "$test_desktop_profile" "$test_workspace"
if [ ! -f "$test_codex_home/auth.json" ]; then
  install -m 600 "$HOME/.codex/auth.json" "$test_codex_home/auth.json"
fi
cat > "$test_codex_home/config.toml" <<'TOML'
cli_auth_credentials_store = "file"
[analytics]
enabled = false
TOML
chmod 600 "$test_codex_home/config.toml"
cd "$test_workspace"
env CODEX_HOME="$test_codex_home" \
  "$HOME/.cache/codex-console-shared-server-test/target/dev-small/codex-app-server" \
  --listen ws://127.0.0.1:4500 > "$test_root/server.log" 2>&1 &
curl --fail --retry 10 --retry-connrefused --retry-delay 1 http://127.0.0.1:4500/readyz
env -u CODEX_APP_SERVER_FORCE_CLI \
  CODEX_HOME="$test_codex_home" \
  CODEX_ELECTRON_USER_DATA_PATH="$test_desktop_profile" \
  CODEX_APP_SERVER_WS_URL=ws://127.0.0.1:4500 \
  /usr/lib/chatgpt/ChatGPT --user-data-dir="$test_desktop_profile" \
  > "$test_root/desktop.log" 2>&1 &
```

`CODEX_APP_SERVER_WS_URL` selects the backend in the installed desktop code.
`CODEX_ELECTRON_USER_DATA_PATH` isolates the profile and its single-instance lock;
`CODEX_HOME` isolates native IPC, configuration, plugins and conversation storage.
The dated directory was created on October 7; verification finished after midnight.

## Evidence and scope

The private experiment directory
`~/.cache/codex-console-shared-server-test/` contains `runtime.json`,
`verification.json`, `socket-proof.json`, `desktop-proof.json`, `turn-result.json`,
the launch/probe scripts and build logs. A window capture is stored at
`~/.local/state/codex-console-tests/source-app-server-20261007/desktop.png`.
Credentials, logs, screenshots and application data are not committed.

Verification combined HTTP readiness, JSON-RPC initialization and reads, an
established TCP connection owned by the extra desktop and the compiled server,
the desktop's initialized local connection state, one completed model turn and
visual inspection of the same reply in the desktop. The turn was sent through
the protocol probe; keyboard sending in the desktop was not exercised.

The fresh desktop also attempted its separate cloud `durable` host, which logged
connection failures. Its `local` connection remained initialized and usable.
Cloud-host connectivity is outside this local-backend result.

This validates a shared app-server route for subsequent browser-client work.
Browser authentication, browser-compatible transport, files and full feature
coverage still require implementation and their own checks. The original
desktop's running tasks were not transferred to the test server.
