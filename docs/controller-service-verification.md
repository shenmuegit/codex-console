# Controller service verification

The existing authenticated HTTPS entry is reused for the independent controller.
Private config/unit backups and the tested replacement stay outside Git. The
replacement retains the original owner password hash, state directory, TLS
identity, native backend/home and durable native chats; only the Web source
checkout, optional controller configuration and Node proxy flag change. The
native backend is not restarted. The Web restart requires signing in again with
the existing owner password. Rollback restores the private config/unit backup
and restarts only the Web service.

Prerequisite evidence: owner login/local native status/controller status passed;
anonymous controller access returns 401 and an unenrolled remote host request
returns 409 rather than the local backend. Real local native fs read/write and
symlink metadata passed. Native command/exec prepared owner-only 0700 upload
storage under an isolated private ancestor and refused group-writable ancestors.
Native getAuthStatus(includeToken:false, refreshToken:true) passed without
returning a token or changing account. These are local prerequisites, not real
remote pairing/control or Windows hardware evidence.

Official owner account confirmation, live enrollment and Windows desktop pairing
have passed. Real remote control/events and attachment write/read have passed;
two real official runtimes have also passed concurrent control and isolation.
Recovery checks are recorded below. Public documentation does not establish a supported third-party
controller SDK; the observed protocol is version-specific. Software vTPM is an
experiment and does not prove physical hardware protection. Boot startup is now
configured as recorded below; machine reboot remains unverified. Do not claim
overall completion from fixtures.

## Current deployment (2026-10-12)

Owner entry: https://117.72.158.35:15443. The Web user unit now launches this
reviewed checkout with `--use-env-proxy`; the original native backend PID stayed
unchanged. The isolated 15444 test unit is stopped. The host firewall allowed
traffic, but 15444 was unreachable publicly, so no extra public port was needed.

At code commit `0845aad`, pinned-CA requests through the public entry confirmed:
owner login 200, local native online, controller status 200/unconfigured, unknown
remote request 409/CONTROLLER_NOT_ENROLLED, and anonymous controller access 401.
Served index/app/connections bytes match the reviewed checkout. The latest full
suite at `591e6d6` passed 414/414; the final startup/recovery change passed its
41/41 relevant checks. Whole-branch review and scoped re-review passed. In-app
browser navigation timed out, so rendered browser/mobile layout is not verified.

## Reproduce and roll back

Keep all real paths, hashes, passwords and state in private external config.
Back up the existing config and managed Web unit before applying changes. Retain
origin/port, passwordHash, stateDir, TLS, backendHome/executable and workspace;
set repoDir to the reviewed checkout and configure the private native key module
and external controller state. Run `validateConfig` and generate only the Web
unit with `renderUserUnits` from `web/service.mjs`. Reload user systemd and restart
only `codex-console-native-web.service`. Verify the backend PID remains unchanged,
HTTPS with the configured CA (never disable verification), owner login/public
status/anonymous rejection, and that served assets match the reviewed files.
For rollback, restore the private config/Web unit backups, reload user systemd,
and restart only the Web unit. Preserve controller/native application data.

In Web, choose **Connect devices → Authorize controller** and finish the official
account confirmation using the same ChatGPT account/workspace as the controlled
host. If a browser on another computer reaches an unavailable localhost callback,
copy that URL into the Web callback input; it is validated as data, with no SSH
forwarding. After enrollment succeeds, submit the controlled host's fresh code.
The server receives the host code; it does not generate a host code for the owner.
Accepted live enrollment and Windows desktop pairing are recorded below.

## Owner-assisted enrollment attempt (2026-10-12)

The owner completed the browser confirmation and the server received its
loopback callback. The token exchange then failed; live public status returned
`enrolled: false`, `phase: unconfigured`, `errorCode: TOKEN_EXCHANGE_FAILED`.
Enrollment finish and host-code claiming did not run.

Non-credential diagnostics reproduced a TLS failure before a secure connection
through the configured HTTP proxy (`ECONNRESET` in Node; unexpected EOF in curl).
A direct POST with a deliberately invalid diagnostic code returned HTTP 403 and
`unsupported_country_region_territory`. An existing SOCKS-proxy GET returned 405;
that only proves an HTTP response, not eligibility or a successful OAuth grant.
The direct diagnostic does not establish the cause of the original proxy-path
failure. No real callback code, verifier, access token or account ID is included
in these notes. Do not retry owner confirmation until legitimate supported
server access is established; do not bypass region restrictions as a fallback.

## Main-only deployment and transport recheck (2026-10-12)

The existing Web and controller implementation is integrated into `main`, and
the running Web unit and private config point to the existing `main` checkout.
No branch is created or switched. Pending unrelated edits are kept separate;
private config/unit backups remain outside Git. The full Web suite passed
438/438. Pinned-CA HTTPS checks passed for owner login, controller status,
anonymous rejection, unenrolled host rejection and exact served asset contents.
The native backend PID is unchanged.

A later POST through the same existing HTTP proxy, using deliberately invalid
diagnostic credentials, reached the token endpoint and returned HTTP 401
`token_expired`. The earlier TLS failure is no longer reproduced by this check;
it does not prove a valid OAuth grant or enrollment. The previous authorization
attempt has expired, so fresh owner confirmation is required before pairing.

After verifying that neither an enrollment nor a pending candidate remained, a
fresh authorization start returned 200 and opened the official confirmation URL
in the desktop browser. At 08:18 UTC, status was `authorizing`; the desktop Codex
unit was inactive and the server's pending public key was readable by the native
component in a separate Node process. This proves independent preparation, not
accepted enrollment or pairing. The software vTPM limitation still applies.

## Step-up identity binding correction (2026-10-12)

The next owner confirmation reached the callback and token exchange, but the
local check rejected it with `INVALID_STEP_UP`. The observed native enrollment
flow validates step-up against the ordinary token's workspace user, while its
challenge and enrollment record retain the service-returned account user.
A live start probe returned 200 and confirmed that the service user matches
the login user and differs from the workspace user; the probe's own candidate
was removed with DELETE 204. No raw tokens or identities are in this record.

The adapter now uses the workspace user for step-up validation and preserves
the separate service identity for proofs and enrollment. Three regressions
cover acceptance, login-user substitution rejection and missing workspace
identity rejection. Controller checks passed 30/30 and the full suite 441/441.
Accepted live enrollment and host control still require a fresh confirmation.

## Fresh challenge after browser confirmation (2026-10-12)

The following owner confirmation passed step-up validation but the previously
allocated device challenge had expired, producing `INVALID_CHALLENGE`. A live
start probe observed about 118 seconds remaining, while the browser flow allows
600 seconds; its own probe candidate was cleaned with DELETE 204. The adapter
now reserves local setup ownership first, waits for official confirmation, then
allocates the challenge/key and finishes promptly. The backend endpoints,
identity binding, protected signature and expiration checks stay intact.
A regression simulates a three-minute confirmation with two-minute challenges;
ownership and cleanup regressions also cover the changed allocation timing.
The full suite passed 443/443; live enrollment still needs fresh confirmation.

## Accepted live server enrollment (2026-10-12)

At 12:27 UTC, after official browser confirmation, the HTTPS owner API returned
`enrolled: true`, `phase: ready`. The private enrollment record has mode 600 and
the pending marker is removed. Restarting only the Web preserved the enrollment
record and native backend PID. The desktop Codex unit stayed inactive. After
restart, status remained ready and the official inventory request returned 200
with zero paired hosts. This proves accepted independent server registration
and persistence across a Web restart. It does not yet prove host pairing,
remote RPC, concurrent hosts or reboot recovery. Software vTPM remains experimental.

## Windows desktop control and attachment verification (2026-10-12)

At 12:36 UTC, claiming the owner-supplied host code returned 200. The official
inventory identified one online Windows desktop, with native app-server
`0.162.0-alpha.17.2`. Through the authenticated Web API, project/thread/model
listing succeeded, and a text-only test turn completed with streamed native
events. The server desktop Codex unit remained inactive.

Attachment preparation initially refused the standard system-volume ACL:
its owner is TrustedInstaller and an unrelated principal has CreateDirectories.
The adapter now trusts the exact TrustedInstaller service SID only for ancestor
checks and permits creating new subdirectories, while still rejecting rights
that mutate/delete existing ancestors. Attachment storage still requires the
current user as its sole allowed principal, a protected base DACL, and no reparse
points. These distinctions follow Microsoft's
[SID documentation](https://learn.microsoft.com/en-us/windows-server/identity/ad-ds/manage/understand-security-identifiers)
and [filesystem rights definitions](https://learn.microsoft.com/en-us/dotnet/api/system.security.accesscontrol.filesystemrights?view=net-10.0).

At 14:27 UTC, the existing test conversation accepted the already staged text
attachment. A native command read the Windows file; the completed assistant
response and rendered transcript contained its random marker, which was absent
from the prompt. HTTPS send returned 200 and SSE recorded 74 events, including
the command item and turn completion. No new conversation was created for this
transfer. Private test evidence and application data stay outside Git.

The Windows regression executes actual PowerShell ACL checks: allow an ancestor
with CreateDirectories, reject seven mutation/deletion/ACL rights, reject shared
storage, and reject a junction. Run it on Windows with `node --test
--test-name-pattern="^Windows native ACL" tests/web/remote-upload-storage.test.mjs`.
The full Linux suite has 443 passes, zero failures and eight Windows-only skips.
The Windows host ran the same test file through native command/exec: all eight
checks passed; the previous helper failed the positive case. Machine reboot
remains unverified.

## Two official runtimes concurrently (2026-10-12)

A temporary official CLI app-server `0.159.2` used the same authorized account,
an isolated private Codex home and a separate empty workspace. Its native
`remoteControl/enable` and `remoteControl/pairing/start` generated the host's
code, which the existing Web/controller claimed with HTTP 200. No desktop GUI
was involved. The Windows test reused the existing verification conversation.

At 14:43 UTC, simultaneous Web sends to the Windows desktop and isolated CLI
both returned 200. Native turn lifetimes overlapped and both completed. Each
rendered conversation contained its own random marker and excluded the other;
the two SSE streams were isolated (57 and 48 events). Requesting the Windows
attachment under the CLI host returned 404. This is real two-runtime evidence
through the official relay, including independent remote workspaces.

To reproduce, use a separate official app-server with private external state,
authorized account credentials and a loopback transport. Enable native remote
control, obtain its manual pairing code, and claim it through the existing
controller API. Use separate host-scoped views/events and existing test chats.
Compare concurrent native turn intervals, reply markers and a cross-host file
request. Keep codes, identities, credentials and application data outside Git.

## Web service recovery (2026-10-13)

At 02:51 UTC, restarting only the Web preserved the controller enrollment
identity, both paired host identities and the native backend process. After
owner login, new host-scoped views opened both existing test conversations;
both rendered transcripts recovered their original markers. No new host code
or controller enrollment was needed. The server desktop GUI stayed inactive.

Read-only checks encountered intermittent upstream inventory failures and used
bounded retries; this remains a reliability limitation. This check covers Web
restart recovery. A complete controlled-client cold start and machine reboot
are not verified; the software vTPM startup limitation still applies.

The temporary CLI host's controller relationship was revoked using its explicit
environment ID; remote control was disabled, its isolated runtime stopped and
its copied credential file removed. At 03:03 UTC, the owner API confirmed ready
enrollment, one paired online Windows desktop and no temporary CLI host. The
native backend and Web remained active; the desktop GUI remained inactive.

## Disabled device connection with a missing TPM (2026-10-22)

The authenticated, certificate-verified HTTPS controller status returned 200
with `phase: unavailable`, `enrolled: false`, `enrollmentPreserved: true`, and
`errorCode: DEVICE_KEY_UNAVAILABLE`. The host inventory returned
409/CONTROLLER_NOT_ENROLLED. The saved enrollment and native wrapped-key record
were still present. The Web journal reported failure to open `/dev/tpmrm0`;
there was no running `swtpm`, TPM device, or loaded `tpm_vtpm_proxy` module.
The previous experimental vTPM had no boot service. The disabled authorization
button protects the existing enrollment, and pairing requires a usable key.

Recovery must restore the original encrypted vTPM persistent state with its
original encryption key. The initial provisioning script refuses existing
state and must not be reused to initialize a replacement. The
[kernel proxy documentation](https://cdn.kernel.org/doc/html/latest/security/tpm/tpm_vtpm_proxy.html)
describes creating the device and passing its descriptor to the emulator; the
[swtpm 0.7.1 manual](https://github.com/stefanberger/swtpm/blob/v0.7.1/man/man8/swtpm.pod)
documents the persistent state, encryption and privilege-drop options.

A private recovery installer, launcher and systemd unit remain outside the
repository. They require the existing nonempty persistent state and 32-byte
encryption key, refuse an existing TPM process/device, back up state before
starting it, install root-owned runtime copies, and enable a boot service.
They preserve the controller enrollment and wrapped-key files. Run the reviewed
private installer from a root shell, or use a sudo-enabled administrator account:

```bash
sudo /bin/bash /absolute/private/path/install-recovery.sh
```

Then verify the service is active, `/dev/tpmrm0` is accessible only to the
application user, the original key can sign, HTTPS controller status is ready,
and host inventory succeeds. In the device dialog, refresh the device list and
confirm pairing is enabled.

The installer was executed as root. The system service
`codex-console-controller-vtpm.service` is active and enabled; `/dev/tpm0` and
`/dev/tpmrm0` have mode 600 and belong to the application user. The original
enrollment and wrapped-key file checksums matched their pre-recovery values.
Reading the original public key and verifying a fresh signature both passed.
The Web and native backend PIDs remained unchanged.

Certificate-verified HTTPS then returned 200 with `enrolled: true`,
`phase: ready`; host inventory returned 200 with one existing paired device.
Mounting the real connection UI with these live responses enabled the pairing
button and hid first-time authorization. A single pairing attempt using the
old screenshot's code reached the official service and returned 410 Gone
(exposed as 502/REMOTE_REQUEST_FAILED). It was not retried; a fresh code from
the controlled client is required. The existing paired device was offline, so
this recovery does not establish a live remote client connection.

Shell syntax, embedded Python syntax, state-preservation assertions, non-root
refusal, backup ordering and systemd unit validation passed. The controller,
HTTP and connection UI regressions passed 49/49. Machine reboot and rendered
browser interaction remain unverified; software vTPM remains experimental.
