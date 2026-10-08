# Native browser client

[中文](zh-CN/native-web-client.md)

Implementation is in progress on `codex/native-web-client`, following the
[approved plan](superpowers/plans/2026-10-08-native-web-client.md). The first
components are the shared native connection and HTTPS owner login/event stream.
Conversation controls follow in subsequent commits. It uses Node.js 24's native WebSocket, with no transport dependency.

## Native connection

`web/codex.mjs` accepts only a configured loopback WebSocket endpoint with an
explicit port. It initializes the native experimental API, correlates replies,
preserves native errors and times out RPC calls after 30 seconds. Connection
opening and initialization have a 10-second deadline.

Every native frame receives a generation/sequence cursor. An atomic native
resume snapshot is published before later deltas or waiting HTTP handlers run.
Each page obtains its own snapshot; closing the last page only unsubscribes an
idle thread. Running work stays subscribed until its matching turn completes.
Reconnection restores subscriptions and snapshots, never submitted writes.

A write interrupted after sending has an **unknown** outcome: inspect native
history before deciding to retry. Calls made while offline are **not sent**.
Native approval/input answers are consumed once and expire on native resolution
or reconnection, including requests whose native ID is numeric zero.

## Private integration environment

The official source is pinned at `ff9ab4aed96aa2e105f78b9521dbbd3a6b329dc8`.
Build the standalone app-server using Rust 1.95.0, locked dependencies and
`dev-small`. Install the official desktop's existing `codex-code-mode-host`
companion beside it. This source version needs the companion for default tool
execution; an echo-only turn does not detect its absence. The attempted companion
source build encountered an unavailable V8 sandbox prebuilt archive; this feature
has no prebuilt archives in the crate's README and [release assets](https://github.com/denoland/rusty_v8/releases/expanded_assets/v150.4.0).
The app-server itself remains the pinned source build, with no source/config
feature changes. Both executables live outside Git at
`~/.local/lib/codex-console-web/bin/`.

```bash
cd /home/desktop/Documents/Codex/codex-console/codex/codex-rs
CARGO_HTTP_MULTIPLEXING=false CARGO_INCREMENTAL=0 \
CARGO_TARGET_DIR="$HOME/.cache/codex-console-web-build" \
  "$HOME/.cargo/bin/cargo" +1.95.0 build --locked --profile dev-small -j 2 \
  -p codex-app-server --bin codex-app-server
install -d -m 700 "$HOME/.local/lib/codex-console-web/bin"
install -m 700 "$HOME/.cache/codex-console-web-build/dev-small/codex-app-server" \
  /usr/lib/chatgpt/resources/codex-code-mode-host "$HOME/.local/lib/codex-console-web/bin/"
```

Integration data lives under
`~/.local/state/codex-console-web/integration/{codex-home,desktop-profile,workspace}`.
Directories are private (0700); the existing file login can be copied as 0600.
Do not copy the original desktop's chat/account databases. The separate desktop
connects to the same source-built backend at `ws://127.0.0.1:4500` using
`CODEX_APP_SERVER_WS_URL`, with its own Codex home and Electron profile.
The original desktop and active conversations stay on their existing backend.

The two transient user units are `codex-console-native-backend-test` and
`codex-console-native-desktop-test`. Only stop/restart these owned test units.
GUI/proxy/TLS environment is forwarded through a private environment file using
explicit variable names; credentials and logs are never committed.

## Verification

```bash
npm --prefix web test
node web/test/native-probe.mjs --url ws://127.0.0.1:4500 \
  --workspace "$HOME/.local/state/codex-console-web/integration/workspace" \
  --exercise-files
```

The automatic tests use synthetic native WebSocket events and never touch your
account. The opt-in probe reads the native model/project/thread catalogs and
login availability without printing account values. Its file flag creates a
disposable native thread, requires a real filesystem/command tool call, compares
exact private-file bytes and deletes that thread after completion.

Name a newly created empty native thread before resuming it. Native
`thread/name/set` materializes its empty paginated history; otherwise immediate
resume can fail with “no rollout found”. This is the upstream test's own flow.

Projects, conversation controls, attachments, usage and deployment are subsequent
steps of this same plan; no Xpra connection is used by this client.

Current verification: source app-server build exit 0 in 11m 13s; 10 native-client checks and the legacy isolated suite passed. Native reads returned four models, zero isolated projects/threads and an available login; the extra desktop initialized its WebSocket connection. The real filesystem probe passed: a native tool wrote the exact expected bytes and its disposable thread was deleted. The official desktop companion is compatible with this tested execution path.

Verified executable SHA-256: app-server `85ef3000722cab4fdb576ab5cfdce0e8e791641641a671a7593e6b23b7334431`; desktop companion `5b2c075ac2380fa04d76d7313fbc044d29c8d0a0d0b9138415acd4610211ca03`. Identify the development build by source commit and hash, not its `0.0.0` version.


## HTTPS owner access

`web/server.mjs` serves fixed local assets, accepts only the configured HTTPS
Host/Origin and uses a 12-hour, absolute `HttpOnly; Secure; SameSite=Strict`
session cookie. Passwords use async native scrypt (16-byte salt, 64-byte key,
N=16384/r=8/p=1); login throttles after five failed guesses per IP per minute.
The password, its hash, TLS files and configuration stay outside Git. No request
bodies or cookies are logged.

Browser RPC is a fixed read allowlist. Arbitrary process/config/auth-token APIs
and raw thread creation are rejected. Native credentials are filtered from reads
and events. Unsupported credential-refresh/attestation/dynamic-tool requests
receive an explicit unsupported response. Native approval/input forms have one
responder; permission grants cannot exceed the corresponding native request.

Each browser page gets a session-bound view ID. Events arrive over authenticated
SSE with 15-second heartbeats and a 1 MiB per-stream queue cap. A slow reader is
disconnected; every new/reconnected stream requests an authoritative snapshot.
Logging out revokes that session and closes its streams without affecting other
sessions or the persistent native connection.

The isolated HTTPS test unit is `codex-console-native-web-test`, listening only
on `https://127.0.0.1:8443`. Its temporary integration configuration and private
owner password are in `~/.config/codex-console-web/integration/`; generated TLS
files are self-signed for loopback. Durable host-IP setup is delivered in Task 8.
Run `node --test web/test/auth-server.test.mjs` for the isolated HTTPS/auth suite.
Nine checks passed, including a paused real TLS/SSE reader while another page
continued receiving events. A live HTTPS smoke against the source backend also
passed: unauthenticated 401, foreign Origin 403, four native catalog models,
snapshot-required SSE and logout. Password values were not printed.
