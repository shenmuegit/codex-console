# Multi-client compatibility verification

[简体中文](zh-CN/multi-client-verification.md)

Checked on 2026-10-11 (Asia/Shanghai) against the running native Web deployment
from `codex/native-web-client`. This verifies several clients sharing **one
app-server**, including an actual Codex CLI. A central service that registers
and controls multiple hosts has not been implemented or tested by this check.

## Verified results

| Check | Result |
| --- | --- |
| Native handshake and reads | Initialized against the desktop-bundled `codex-cli 0.159.2`; account presence and model/project/thread reads succeeded. No credentials were printed. |
| Web access | HTTPS login and SSE worked; unauthenticated API access returned 401 and a foreign Origin returned 403. |
| Concurrent connections | Two independent native protocol connections and two authenticated Web event streams opened the same disposable thread. |
| Native → Web | A native thread rename reached the other native connection and both Web streams. |
| Web → native | A Web rename reached both native connections and the other Web stream. |
| Reconnection | A new native connection and a reopened Web stream recovered the same thread ID and authoritative name. |
| Separate threads | Changing the target thread's name left a second disposable thread's name unchanged; that second thread was then deleted. |
| Actual CLI | CLI `0.159.0` resumed the test thread on backend `0.159.2`. `/status` showed the expected server and thread ID. A Web rename updated its terminal title and `/status`; CLI `/rename` produced a native notification and the same name through the authenticated Web API. |
| Existing desktop | The installed Linux desktop process retained its TCP connection to the same backend. Its chat UI was not operated during this check. |

The protocol/CLI checks completed with six groups of assertions recorded in the
private proof. No model turns were requested. Only disposable thread metadata
was written; existing desktop/Web services were not restarted, their process
IDs remained unchanged, and the test CLI disconnected normally. The primary
test thread remains available for the owner's external-client test.

Probe scripts, proof, actual thread ID, and application data are kept outside
Git under `~/.local/state/codex-console-web/multi-client-verification-20261011/`.
The probe scripts are disposable experiment code, not a shipped gateway or
part of the regular regression suite.

## Reproduce the CLI and Web check

1. Reuse the configured shared backend without restarting active work. Open a
   dedicated test thread in the native Web client and copy its full thread ID.
2. With a CLI that exposes `--remote` in `codex --help`, connect locally:

   ```bash
   codex --remote ws://127.0.0.1:4500 --no-alt-screen resume <TEST_THREAD_ID>
   ```

3. Run `/status` and confirm the server version and thread ID. Rename the
   thread in Web and check its new name in the CLI terminal title and `/status`.
4. Run `/rename Multi-client verification` in the CLI and confirm the same
   thread name in Web.
5. Disconnect the test CLI normally and reconnect with the same command.
   Reopen the Web thread and confirm both still refer to the same thread.

**Observed CLI limitation:** adding `-s read-only` to the remote resume command
failed with `Permission overrides are not supported when resuming a remote
task.` Removing that explicit override allowed the same CLI to resume. Remote
resume uses backend permissions; do not add permission overrides to this
reproduction command.

## External-device test

Replace the placeholders below with the owner's existing SSH account, host,
and test thread ID. Keep app-server on loopback; reach it through SSH:

```bash
ssh -N -o ExitOnForwardFailure=yes \
  -L 127.0.0.1:14501:127.0.0.1:4500 <USER>@<HOST>
```

In another terminal on that device:

```bash
codex --remote ws://127.0.0.1:14501 resume <TEST_THREAD_ID>
```

Use the existing Web entry at
`https://<HOST>:15443/?thread=<TEST_THREAD_ID>` and its owner password. Record
the external device's OS and exact CLI/desktop version before testing.

For an official desktop build, verify that build's backend selection or
connection mechanism first. The previously tested local build supports
`CODEX_APP_SERVER_WS_URL`; this is not a promise that every official desktop
release exposes the same setting. See the earlier
[local desktop experiment](local-app-server-test.md).

The remaining manual acceptance checks are:

- Submit a fixed short reply request from the external client and observe its
  full reply and live updates in Web. Submit another from Web and observe it
  in the external client.
- Start work in a dedicated test thread and stop that same work from the other
  client; verify the interrupted status on both.
- Run two independent test threads concurrently and confirm commands, events,
  and history stay associated with the correct thread.
- Disconnect/reconnect the external client and Web; confirm the same thread
  and history without repeating an already submitted message.

Connecting another frontend uses the selected backend's account, filesystem,
and execution environment. This test does not register that frontend device's
own local Codex backend with a central service.

## Pending coverage

Windows/macOS official desktop builds, external-device UI behavior, live
message streaming and cross-client interruption in this round, IDE/third-party
clients, multiple independent hosts, and unattended reconnection remain
unverified. The WebSocket app-server transport remains experimental; these
results apply to the versions and operations above, not all Codex releases.
