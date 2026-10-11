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
