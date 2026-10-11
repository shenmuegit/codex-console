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

Official owner account confirmation, accepted enrollment, fresh host-code claim,
real remote read/write/events and two independent real hosts/reconnect remain
required. Public documentation does not establish a supported third-party
controller SDK; the observed protocol is version-specific. Software vTPM is an
experiment and does not prove physical hardware protection. Reboot startup is
not configured. Do not claim overall completion from fixtures.

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
This deployment currently has no accepted live enrollment/pairing evidence.
