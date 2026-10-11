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

## Official pairing route: server as controller

The owner's clarified goal is **Web → Codex Console server → official relay →
paired Codex devices**. The server owns controller enrollment, pairing,
connections, and RPC routing; Web operates that server. The shared local
app-server checks above do not verify this official relay route.

The supplied desktop reports `26.1007.21434`. The installed server-side desktop
package is `26.928.21956`; its packaged controller implementation was inspected,
not the newer external build. That implementation enrolls a controller,
requests step-up account authorization, creates a protected device key, and
uses device-key proofs for enrollment and relay connections. CLI
`remote-control pair` creates a host's pairing code; its help does not expose a
command that accepts another host's code as a controller.

Fresh prerequisite checks on 2026-10-11:

- Native `remoteControl/status/read` returned `disabled`, with no environment
  enrollment. The local desktop state contained zero controller enrollments.
- The official `native/remote-control-device-key.node` addon loaded under Node
  24. Its asynchronous `createDeviceKey("allow_os_protected_nonextractable")`
  failed with `remote_control_device_key_tpm_unavailable` and
  `cannot open Linux TPM device`. No device key was returned or registered.
- This KVM server exposed neither `/dev/tpm0` nor `/dev/tpmrm0`, and
  `/sys/class/tpm` contained no devices. Existing Web/backend services remained
  running with their original process IDs.

The next prerequisite is a usable TPM/vTPM for this Linux controller, or a
controller environment whose official component can create the required
protected key. Account/workspace matching and the required account
authorization must also be completed before a real pairing attempt. Do not
substitute an extractable key or falsely label software key material as a
protected device key.

No official relay controller was enrolled and no supplied pairing code was
claimed. Server enrollment acceptance, pairing with the external build,
multi-host control, and delivery of Web actions to those hosts remain pending.
Fixing the key prerequisite alone does not establish those results or official
support for a third-party server controller.

See [official remote connection requirements](https://learn.chatgpt.com/docs/remote-connections)
and [CLI remote-control commands](https://learn.chatgpt.com/docs/developer-commands#codex-remote-control).

### Follow-up: component update and vTPM experiment

The signed OpenAI APT repository's Linux package `26.928.31416` was downloaded
without installing it. Its package SHA-256 matched APT metadata, and its device
key addon was byte-identical to the installed `26.928.21956` addon. This component
comparison does not cover the external Windows/macOS `26.1007.21434` build.

The initial server check found `CONFIG_TCG_VTPM_PROXY=m` and
`tpm_vtpm_proxy.ko.xz`, with the driver not loaded. Installing `swtpm` was simulated:
three new packages, no upgrades or removals. Both the sudo capability check and
the scoped `modprobe` attempt required a password, so no package or module was
installed or loaded during that initial attempt.

Two disposable helpers are prepared outside Git under
`~/.local/state/codex-console-web/official-controller-test/`:
`prepare-vtpm-test.sh` provisions an isolated software vTPM with encrypted state
owned by `tss`; `check-device-key.cjs` checks native creation, public-key lookup,
SHA-256 signature verification, and temporary-key cleanup. Syntax checks passed.
The unprivileged setup invocation stopped before any state changes, and the
missing-device key check correctly failed before creating a key. Actual vTPM
startup and positive signing checks were pending administrator execution at that point.

Sudo authentication grants the OS privileges needed for that setup. Official
account authorization, controller enrollment, and device pairing are separate
later steps. A software vTPM experiment is not evidence of physical TPM protection
or acceptance by the official relay. See the
[Linux vTPM driver](https://docs.kernel.org/security/tpm/tpm_vtpm_proxy.html) and
[swtpm documentation](https://github.com/stefanberger/swtpm/blob/master/man/man8/swtpm.pod).

### Project-local, single-user installation

Following the owner's preference, `swtpm`, `swtpm-libs`, and `libtpms0` were
downloaded, checked against APT SHA-256 metadata, and extracted into
`.tools/vtpm/root/`. The `.tools/` directory is ignored by Git and uses mode 700.
No system packages were installed. From the checkout root:

```bash
env LD_LIBRARY_PATH="$PWD/.tools/vtpm/root/usr/lib/x86_64-linux-gnu:$PWD/.tools/vtpm/root/usr/lib/x86_64-linux-gnu/swtpm" \
  .tools/vtpm/root/usr/bin/swtpm --version
```

The local executable reported `0.7.1`. A UID 1000 socket-mode experiment returned
16 bytes through the TPM 2 GetRandom command; its Unix socket used mode 600.
Temporary state stayed outside the checkout, and the process/state were cleaned
up. Unix socket names need short paths; the first attempt exceeded their length
limit and the corrected experiment used a private temporary directory.

This verifies a user-local emulator, not the official controller's device-key
interface. The official addon passes the literal `/dev/tpmrm0` to
`Tss2_Tcti_Device_Init`; moving its files does not select a project-local socket.
Creating the kernel TPM interface still needs administrator privileges. The
prepared kernel-device helper now uses the local runtime and no longer installs
system packages. Keys, configuration, and TPM state remain outside Git as
required by AGENTS.md; the device can be restricted to the application user.

### Administrator provisioning and native device-key verification

On 2026-10-11, authorized administrator execution loaded `tpm_vtpm_proxy` and
created `/dev/tpm0` and `/dev/tpmrm0`. Both devices belong to the application
user and use mode 600. The project-local emulator runs as `tss`, with no
effective capabilities; the application user cannot read its encrypted-state
key. No system packages were installed or existing application services restarted.

The initial `swtpm --vtpm-proxy --runas tss` invocation failed because this
version drops privileges before opening `/dev/vtpmx`, and proxy creation also
requires `CAP_SYS_ADMIN`. The corrected helper creates the TPM 2 proxy with
the standard `VTPM_PROXY_IOC_NEW_DEV` ioctl as administrator, passes its inherited
descriptor to `swtpm chardev --fd`, and then uses `--runas tss`. The failed
initial state was preserved separately; existing TPM data was not overwritten.
See the [kernel implementation](https://github.com/torvalds/linux/blob/v6.12/drivers/char/tpm/tpm_vtpm_proxy.c)
and [swtpm initialization order](https://github.com/stefanberger/swtpm/blob/v0.7.1/src/swtpm/swtpm_chardev.c).

The installed official addon passed creation under
`allow_os_protected_nonextractable`, matching public-key lookup, ECDSA P-256
SHA-256 signing, independent signature verification, and temporary-key deletion.
Its returned protection-class label was `hardware_tpm`; the actual device here
is a **software vTPM**, so that label does not establish physical hardware
protection or relay acceptance. Safe proof is saved outside Git as
`~/.local/state/codex-console-web/official-controller-test/device-key-proof.json`.

With the device ready, reproduce the key check as the application user:

```bash
node ~/.local/state/codex-console-web/official-controller-test/check-device-key.cjs
```

The administrator setup helper refuses to replace an existing TPM or state
directory. This is a running experiment for the current boot; automatic startup
after reboot is not configured. Controller account authorization, enrollment,
pairing, and delivery of Web commands to another host remain unverified.

### Controller account authorization probe

The installed desktop's OAuth step-up helper was reused in a disposable probe
outside Git, `official-controller-test/authorize-controller.mjs`. Its guard
check confirmed the official issuer, remote-control enrollment scope, PKCE S256,
rejection of an incorrect callback state, rejection of a missing code, and
cancellation without a token exchange. Reproduce this local check with:

```bash
node ~/.local/state/codex-console-web/official-controller-test/authorize-controller.mjs --self-test
```

The real attempt bound only a localhost callback and selected the existing
account workspace. The in-app browser's attempts to load the official login
page timed out; no successful authorization page was verified. The probe was
cancelled, its temporary link removed, and the callback port verified free.
No step-up token was obtained, no controller was enrolled, and no device was
paired. The server administrator password is separate from this required
ChatGPT account reauthentication. Official pairing requires the same ChatGPT
account and workspace; project directories can differ. This probe reuses
version-specific packaged code and does not establish a supported public API
for a custom controller.

### Server submission of an owner-provided pairing code

The installed desktop's manual code input calls
`POST /wham/remote/control/client/pair` with `client_id` and
`manual_pairing_code`. The owner supplies the **controlled device's** code;
the server is the controller submitting it. The packaged UI normalizes eight
alphanumeric characters into `XXXX-XXXX` and requires a controller client ID
before showing this input.

On 2026-10-11, the server submitted an owner-provided code to this exact endpoint.
An official enrollment-start request first assigned a new pending controller ID;
no other device's ID was reused. The pairing request returned HTTP 403,
`Remote-control client key material missing`. It did not establish a connection.
The pending test controller was deleted with HTTP 204, and a subsequent read
confirmed the original four active clients with no pending test client.
The code, account credentials, and client identifiers are not recorded in Git.
Sanitized proof is outside Git in `official-controller-test/pairing-code-proof.json`.

Direct Node fetch initially timed out while ignoring this host's configured
HTTP proxy. Using the installed Node 24 `--use-env-proxy` option restored backend
access; reading the client list returned HTTP 200. The remaining server-side
gap is completion of protected-key controller enrollment, before retrying a
pairing code and validating relay/RPC control. Creating and testing a local TPM
key alone does not register that key with the official service.
