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

Each host stream has its own UUID, sequence counters, pending request IDs, and
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
