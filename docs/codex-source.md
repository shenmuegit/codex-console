# Official Codex source checkout

[中文](zh-CN/codex-source.md) · [Development](development.md)

The local `codex/` directory contains the official
[`openai/codex`](https://github.com/openai/codex) source for investigation.
The root `.gitignore` excludes `/codex/`, including its nested Git repository.

From the Codex Console repository root, reproduce the checkout with:

```bash
git clone --depth 1 https://github.com/openai/codex.git codex
git -C codex rev-parse HEAD
git check-ignore -v codex/ codex/README.md
```

The checkout created on 2026-10-07 is on `main` at
`ff9ab4aed96aa2e105f78b9521dbbd3a6b329dc8`. It is a shallow clone;
`git -C codex fetch --unshallow` retrieves its history if needed.

Only the ignore rule and documentation belong in Codex Console commits.
The source checkout is independent of the installed Codex executable and the
desktop application used by the console.

## GitNexus index

Index the official checkout separately from Codex Console. This investigation
indexes production sources, excluding test suites, fixtures, snapshots, and
benchmarks. With GitNexus 1.6.12 installed, the commands below store the filter
and index outside the repository, link the local filter, skip generated agent
instructions, and limit memory and parsing concurrency. Periodic garbage
collection reduces memory pressure in the large Rust workspace. The default
memory-resident scopes avoid repeated disk-shard decoding observed with 1.6.12:

```bash
cd codex
codex_index_filter="${XDG_CACHE_HOME:-$HOME/.cache}/codex-console-investigation/codex.gitnexusignore"
mkdir -p "$(dirname "$codex_index_filter")"
cat > "$codex_index_filter" <<'EOF'
**/tests/**
**/test_fixtures/**
**/fixtures/**
**/snapshots/**
**/testdata/**
**/test_data/**
**/benches/**
**/*_tests.rs
**/tests.rs
**/tests_*.rs
**/test_*.py
**/*.test.ts
**/*.test.tsx
**/*.spec.ts
**/*.snap
EOF
test -e .gitnexusignore || ln -s "$codex_index_filter" .gitnexusignore
grep -qxF .gitnexusignore .git/info/exclude || printf '\n.gitnexusignore\n' >> .git/info/exclude
GITNEXUS_STORAGE_ROOT="${XDG_CACHE_HOME:-$HOME/.cache}/gitnexus" \
  node --max-old-space-size=4096 --max-semi-space-size=32 --stack-size=4096 \
  --gc-interval=100000 "$(command -v gitnexus)" analyze --index-only --workers 2
gitnexus status
```

Use `repo: "codex"` for GitNexus queries; `codex-console` is a separate graph.
On this host the source index is stored under
`~/.cache/gitnexus/codex-580cf2dcfd56/`. The normal 512 KB file cap skips two
generated protocol schema bundles; the Rust protocol definitions remain available.

On 2026-10-07, the published index matched the checkout's HEAD: 4,993 covered
files, 103,042 nodes, 268,000 relationships, and 864 enumerated flows. Flow
enumeration is budget-limited, and some Rust method links are incomplete; key
connections below were confirmed by reading source and checking the transport.

## Connect a remote Codex CLI

The smallest route is an app-server bound to remote localhost, an SSH tunnel,
and the existing CLI terminal interface. Install and authenticate Codex on the
remote machine first. Run in the remote project's directory:

```bash
codex app-server --listen ws://127.0.0.1:4500
```

On the client machine, keep this tunnel running, replacing `user@HOST`:

```bash
ssh -N -o ExitOnForwardFailure=yes \
  -L 127.0.0.1:14500:127.0.0.1:4500 user@HOST
```

In another client terminal:

```bash
codex --remote ws://127.0.0.1:14500
```

The server owns the workspace, inference credentials, and execution. The client
renders the terminal interface and connects to the server started above. Reusing
tasks already running in a desktop app requires identifying that app's actual
app-server process and data directory. Check `codex --help` and
`codex app-server --help` on both machines; older releases may lack these flags.
The app-server WebSocket transport is experimental. See the
[official App Server documentation](https://learn.chatgpt.com/docs/app-server).

## Authenticated WebSocket connections

For a connection through a TLS proxy, use a separate high-entropy transport token
stored in a private file outside the repository:

```bash
codex app-server --listen ws://127.0.0.1:4500 \
  --ws-auth capability-token \
  --ws-token-file /absolute/private/path/transport-token
```

The proxy terminates TLS and forwards WebSocket upgrades to this loopback listener.
The client presents `Authorization: Bearer <transport-token>` during the upgrade.
Once `CODEX_REMOTE_TOKEN` contains the token from the client's private secret store:

```bash
codex --remote wss://HOST:443/ \
  --remote-auth-token-env CODEX_REMOTE_TOKEN
```

The listener also supports a token SHA-256 verifier and signed bearer tokens.
At the pinned source commit, a non-loopback listener without authentication is
refused. The CLI accepts transport tokens only with `wss://` or loopback `ws://`.
Transport authentication is separate from the server's OpenAI sign-in.
This version's CLI requires an explicit port and a root-path endpoint; addresses
such as `wss://HOST/codex` or `wss://HOST` are rejected before connecting.

## Browser and desktop clients

For a browser frontend, put an authenticated backend between the browser and
app-server. The listener rejects any request containing `Origin`, including a
WebSocket upgrade, with HTTP 403. The backend validates the browser session and
origin, keeps the transport token server-side, then connects upstream without
an `Origin` header. Each upstream WebSocket text frame carries one JSON-RPC message.

The client sends `initialize`, waits for its result, sends `initialized`, then
uses `thread/start` or `thread/resume` and `turn/start`. Stream
`item/agentMessage/delta` and `turn/completed`, and handle server approval requests.
This is the integration route for a native browser UI in Codex Console.

The desktop app's existing SSH route is Settings > Connections > SSH: configure
a concrete host alias in `~/.ssh/config`, verify SSH access, install and sign in
to Codex on that host, and select its remote project folder. See
[official remote connection instructions](https://learn.chatgpt.com/docs/remote-connections#connect-to-an-ssh-host).
Availability depends on the desktop build; this investigation did not verify
the SSH settings in Codex Console's compatible Linux desktop application.

The source also contains experimental `codex remote-control start` and
`codex remote-control pair` commands. They enroll a host with the ChatGPT relay
and request a short-lived manual pairing code. Their help and implementation
were inspected; account enrollment and phone pairing were not exercised.
The current official mobile setup instructions start in the desktop app.

## Source evidence and validation

The links below are pinned to the investigated commit:

| Entry | Source |
| --- | --- |
| CLI remote flags | [InteractiveRemoteOptions](https://github.com/openai/codex/blob/ff9ab4aed96aa2e105f78b9521dbbd3a6b329dc8/codex-rs/cli/src/main.rs#L964) |
| Remote connection and handshake | [RemoteAppServerClient](https://github.com/openai/codex/blob/ff9ab4aed96aa2e105f78b9521dbbd3a6b329dc8/codex-rs/app-server-client/src/remote.rs#L180) |
| CLI endpoint validation | [resolve_remote_addr](https://github.com/openai/codex/blob/ff9ab4aed96aa2e105f78b9521dbbd3a6b329dc8/codex-rs/tui/src/lib.rs#L451) |
| Origin rejection and listener authentication | [WebSocket transport](https://github.com/openai/codex/blob/ff9ab4aed96aa2e105f78b9521dbbd3a6b329dc8/codex-rs/app-server-transport/src/transport/websocket.rs#L89) |
| Bearer token validation | [authorize_upgrade](https://github.com/openai/codex/blob/ff9ab4aed96aa2e105f78b9521dbbd3a6b329dc8/codex-rs/websocket-auth/src/lib.rs#L288) |
| Remote relay CLI | [remote_control_cmd](https://github.com/openai/codex/blob/ff9ab4aed96aa2e105f78b9521dbbd3a6b329dc8/codex-rs/cli/src/remote_control_cmd.rs#L70) |

Local transport checks used the installed `codex-cli 0.159.0` with a temporary
Codex home and token, without account credentials or a model turn:

| Check | Result |
| --- | --- |
| `GET /readyz` | 200 |
| Upgrade with missing or incorrect token | 401 |
| Upgrade with valid token and `Origin` | 403 |
| Upgrade with valid token, no `Origin` | 101 |
| JSON-RPC `initialize` followed by `initialized` | Passed |
| CLI rejects a path suffix or omitted port | Passed |

The upstream checkout remained clean and its parent ignore rule was verified.
Cross-machine SSH, TLS deployment, model inference, and desktop/mobile pairing
require the target machines and accounts and were not part of the local check.
