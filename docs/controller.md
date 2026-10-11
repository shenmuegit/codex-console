# Independent remote controller

The intended flow is Web → this server → the official relay → controlled Codex
hosts. This server owns the controller identity and receives each controlled
host's code. A server desktop Codex application is not a runtime requirement.
The code-based official workflow uses a relay, not a custom server address.
See [Remote connections](https://learn.chatgpt.com/docs/remote-connections).

## Server-side browser authorization

`web/remote-auth.mjs` implements the observed enrollment authorization-code flow
with Node crypto/http. It does not load desktop application code, launch a GUI,
or write credentials. The selected ChatGPT workspace is bound in the official
authorization link, and the PKCE verifier stays on the server.

Its internal interface is:

```js
const attempt = await startRemoteAuthorization({ accountId });
// Show attempt.url to the authenticated owner.
// On another browser computer, accept a pasted localhost callback as data:
attempt.submitCallback(callbackUrl);
const stepUpToken = await attempt.completion;
```

The owner's one-time account confirmation remains an official prerequisite for
controller enrollment. A browser on the server can return directly to the
loopback callback. With a browser on another computer, the server can validate
a copied callback URL without fetching it or using an SSH tunnel. The Web setup
entry and controller enrollment are separate implementation steps; neither is
claimed complete by this authorization module alone.

The listener binds only IPv4 loopback, using official callback ports 1455 then
1457. It rejects wrong state, duplicate state/code, absent code, foreign copied
callback origins/paths, and replay. Token exchange refuses redirects, uses a
20-second request deadline, and closes the callback listener on completion,
cancellation, denial, or timeout. Authorization expires after ten minutes.
Returned credentials are only available to the server caller.

Verify from `web/` with `node --test test/remote-auth.test.mjs` and `npm test`.
The checks use real local callback listeners and a controlled token endpoint.
They establish the server flow's guards, not successful live OpenAI enrollment.
The public native OAuth client and enrollment scope were observed in installed
version 26.928.21956; custom-controller support is still unverified.

## Protected enrollment and host codes

`web/remote-controller.mjs` now owns enrollment, refresh, code submission, and
host listing. Supply an external private `authFile`, an external mode-700
`stateDir`, and the protected-key component's create/get/sign/delete methods.
The module preserves the ordinary auth file and does not use another device's
controller ID. It checks account, challenge purpose/audience/target/expiration,
key identity, fresh authorization scope, and its signature before registration.

One private `enrollment.json` stores the server identity and relay session
together. It is published atomically with mode 600; an existing record is not
overwritten by initial enrollment. `pending.json` identifies only this server's
candidate and its process owner. Duplicate setup clicks and another live
candidate's setup are rejected. Failures independently clean up this candidate's
key and remote identity; a failed cleanup keeps a private retry marker.
Account changes and missing/mismatched keys preserve the record and prevent
code claiming. Expired relay sessions refresh with the original protected key.

The native key component was copied, checksum-checked, and tested from the
private ignored installation at `.tools/controller-key/remote-control-device-key.node`.
Creating/getting/signing/verifying/deleting an isolated key passed there without
loading application JavaScript or launching a desktop process. The copy's
SHA-256 is `517ddc383936597370f731df1d64ba6bf97555756c1b770900db608911dad8ff`.
It requires the working Linux TPM resource manager. This server uses encrypted
software vTPM: its component reports `hardware_tpm`, but that is not evidence of
physical hardware protection. Reboot startup is not configured yet.

Verify from `web/` with `node --test test/remote-controller.test.mjs` and `npm test`.
The current checks cover 13 controller scenarios and 342 Web tests. Enrollment
fixtures use independent ECDSA verification; they do not prove acceptance by the
live official service. Owner authorization, live enrollment/pairing, relay/RPC
control, and the Web setup interface remain to be completed and verified.

## Relay transport and host isolation

`web/remote-relay.mjs` implements the observed protocol-v3 relay transport.
Node 24's built-in WebSocket sends the required authentication headers; a real
local handshake and a CONNECT proxy check passed without adding a dependency.
Run the service with `--use-env-proxy` when using this host's configured proxy.
The underlying [Undici WebSocket interface](https://github.com/nodejs/undici/blob/main/docs/docs/api/WebSocket.md)
supports headers in its Node-only initialization options.

The controller's server-only `session()` result now supplies private handshake
headers and `signChallenge()`. The proof checks client/account identity, session
token hash, target, expiration, nonce, and scopes before signing. This object
must never be serialized to a browser; use `status()` for public setup state.

Each host stream has its own UUID, sequence counters and
native client. Responses, notifications, and approval answers stay with that
host even when two hosts use the same RPC or approval IDs. Frames are limited
to 153,600 bytes, messages to 32 MiB, and aggregate partial-message storage to
64 MiB. UTF-8 data is chunked as bytes and reassembled before JSON parsing.
Duplicates are discarded; a stream sequence gap forces that host to reconnect.

Connection loss rejects pending calls with an unknown outcome. A new connection
initializes new host streams and resumes native snapshots rather than silently
replaying a mutation. Pings maintain stream liveness; account/key validation and
session refresh run with the heartbeat, and expired leases reconnect.

The transport checks use a real local WebSocket peer and independently verify
the device signature. They cover two hosts, colliding IDs, approval routing,
wrong challenges/identities, duplicates, chunks, sequence gaps, and reconnect
without mutation replay. They still do not establish live official-host
interoperability. Web setup/host routing and real owner authorization remain the
next integration gates.

## Web setup and device routing

The owner-authenticated Web now provides a **Connect devices** dialog, official
authorization link, copied callback input, controlled-host code input, and a
device selector. Setup and code submission require the existing owner login and
canonical origin. Only the authorization URL, expiration and public status are
returned; controller credentials and signing interfaces remain server-side.

Optional private configuration enables the controller:

```json
"remoteController": {
  "deviceKeyModule": "/absolute/private/remote-control-device-key.node",
  "stateDir": "/absolute/external/controller-state"
}
```

The key component must be owned by the service user with no group/other access.
Controller state must be outside the repository. Managed controller-enabled
units launch Node with `--use-env-proxy`. Existing local configurations work
without this option.

The server connects paired hosts through a pool with separate native clients,
view maps, event streams, and private state namespaces. Child Web handlers share
the owner's login and enforce it before routing. An unknown host never falls
back to the local backend; account changes close existing remote clients.
The local APIs remain available. The current full suite passes 374 tests.

Remote filesystem and browser host scoping are now implemented with fixture
coverage described below. This Web entry does not prove successful live
enrollment or pairing; owner authorization and tests against official hosts
remain mandatory completion gates.

Startup checks the owner login with an unscoped status request before initializing
the selected device. A removed/unknown host, unavailable controller enrollment or
account, or native startup failure stays in the workspace with its device error.
Both device pickers retain the selected host, including an unavailable placeholder;
choose **server 本机** (server local) explicitly to return to this server, or another listed
device. The startup recovery controls also appear inside the chat pane, where
mobile and side-chat users can reach them without the sidebar. **恢复设备连接** (Recover device connection) opens the existing setup/status dialog; after restoring the controller
or host, reload the page to retry that same device. Only an actual HTTP 401 opens
the owner login screen. Failed remote requests never fall back to local, and
switching devices closes the old view/stream without carrying its model or cursor
to the new device.

## Remote paths, attachments, and browser drafts

The selected host's native initialization supplies `platformFamily` and
`codexHome`. Unix and Windows paths use that host's path rules, including drive
and UNC paths; remote paths are never resolved or opened on the server filesystem.
Remote project creation, thread creation, completions, and composer references
use native filesystem RPCs. Creating a remote thread requires a selected native
project; the server's configured local workspace is not a remote default.

`fs/watch` currently echoes its requested path in the inspected native source,
despite the protocol comment describing a canonical path. We therefore check
`fs/getMetadata` on every ancestor and reject missing paths and symbolic links.
Downloads recheck scope and native timestamps before and after reading. The
native RPCs expose neither an inode nor an atomic no-follow file handle, so these
checks cannot provide the same atomic replacement protection as local downloads.
Remote files are read as complete Base64 RPC results rather than streamed from
a remote file descriptor. Large files can exceed the current relay implementation's
32 MiB message bound; such failures do not authorize a local-file fallback.

Uploads retain the existing bounded server staging, filename/image validation,
and local no-follow checks in a private state namespace per host. Sending an
attachment transfers its exact bytes through native `fs/writeFile` to
`<remote codexHome>/console-uploads/<opaque upload ID>/content[.ext]`, and passes
that remote path to the native composer. Transfer intent is persisted before
the first per-upload directory/file mutation.
After an interrupted or uncertain RPC, retries reconcile that owned directory
and exact bytes: a completed write with a lost reply is reused, missing bytes
are written once, and changed or unexpected content is rejected. Remote uploads
are capped at 24,000,000
bytes (or a lower configured cap) to fit Base64 and JSON inside our relay bound;
the existing local cap is unchanged. Completed staging and remote copies remain
for conversation reuse; no automatic remote deletion is implemented.

Native `fs/createDirectory`/`fs/writeFile` defaults alone do not guarantee private
permissions. Before attachment bytes are sent, a fixed server-owned
[`command/exec`](https://learn.chatgpt.com/docs/app-server) prepares and verifies
storage. It inherits the host's configured sandbox/permission profile without
an override, elevated roots, environment changes, or a `process/*` fallback.
Browsers cannot submit this command or supply a script. Every write also requires
a target-directory permission proof, including recorded empty directories after
a reconnect. Only this prewrite proof permits the target file to be absent; the
postwrite proof still requires and verifies the file.

Unix hosts need an already installed **Python 3**; it is not assumed on every
Mac and the server does not install it. Standard-library directory descriptors
with `O_NOFOLLOW` check ancestor ownership/write permissions and create
`console-uploads` with mode 0700 from the start. Existing storage must be owned
by the native execution user and disallow group/other access; attachments must
be regular files owned by that user with a single hard link. Preparation is
idempotent when its reply is lost. Missing Python, a denied sandbox operation,
unsafe existing storage, or changed permissions returns
`REMOTE_STORAGE_NOT_PRIVATE` and preserves browser/server staging.

Windows hosts need built-in **Windows PowerShell** and an ACL-capable filesystem.
A fixed encoded command passes paths as JSON data, rejects reparse points and
untrusted/writable ancestors, and uses
[`DirectoryInfo.Create(DirectorySecurity)`](https://learn.microsoft.com/en-us/dotnet/api/system.io.directoryinfo.create?view=netframework-4.8.1)
to apply a protected current-user-only inheritable DACL at creation. The base,
per-upload directory and any existing file ACL are verified; other principals'
allow entries are rejected. Existing unsafe permissions are not silently
rewritten. Missing runtime/APIs, inaccessible ACLs, or policies that prevent
verification fail closed. Windows ACL behavior has not been verified on a real
owner device; fixture checks are not that evidence.

Upload requests, reference downloads, photo previews, Markdown thread links,
subagent links, exports, and side chats retain `host`. Drafts, attachment IDs,
and pending recovery are stored under a host-specific browser key even when
thread IDs collide. Existing local draft keys remain readable. Unknown IDs on
another host fail closed; a remote path cannot authorize reading server files.

Run `node --test test/remote-filesystem.test.mjs test/remote-upload-storage.test.mjs test/host-scope-browser.test.mjs test/codex.test.mjs`
and `npm test` from `web/`. The Unix/Windows filesystem and browser tests use
fixtures, not paired official clients. Live read/write/event, concurrent-host,
and reconnect verification remains an owner-authorized gate.

Relay streams do not retain a second RPC request queue: native RPC timeouts
release the sole pending-call map. A relay error without a request ID closes
only its host stream and fails pending calls with an unknown outcome. It never
guesses an expired request ID or replays a mutation.

The candidate client ID and operation owner are journaled before challenge
validation or key creation; key identity is added before authorization. Failed
cleanup keeps a private retry marker for restart, without replacing another
operation’s marker. `CLEANUP_RECORD_FAILED` explicitly signals that storage
failed and administrator recovery is needed; do not start another enrollment
while the owned candidate remains unresolved.

Base account credentials are checked for a finite `exp` and renewed before
HTTP requests or relay handshakes. Production renewal uses the server’s existing
loopback native credential manager through a fixed internal `getAuthStatus`
call with `includeToken: false` and `refreshToken: true`; it neither runs desktop
JavaScript nor edits `auth.json` directly. Concurrent renewals share one operation.
The controller re-reads the private cache and verifies account/workspace and
owner before continuing with the original enrollment and key. Browsers cannot
call this legacy native method or obtain its token.

Expired/rejected credentials report `authenticationRequired`; a failed native
renewal reports `authenticationUnavailable`. The public `enrollmentPreserved`
flag disables another enrollment. Restore ordinary official server account
sign-in if it was revoked, then refresh the Web device dialog. A 401 rejects
the original request with an unknown outcome; renewal does not replay pairing
or another mutation. Reconcile before an explicit retry. Private enrollment
and protected keys survive account errors and account changes. Tests use fake
credentials; live owner login and official-device interoperability remain
separate verification gates.

For this local remote-controller identity binding, the JWT workspace claim
must match the selected workspace in the private cache before membership is
trusted, including after renewal. Matching-workspace legacy `user_id` remains
a fallback. This rule does not redefine ordinary Codex authentication or its
external-token workspace-header override; ordinary login files are preserved.
