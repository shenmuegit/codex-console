# Independent Codex controller

The owner wants Web → our server → multiple controlled Codex clients, including
the official desktop client, using the controlled client's official pairing
code. The server submits that code and owns its controller identity. The server
must not require a running desktop Codex application. All application data and
credentials stay outside Git; the initial deployment serves this owner only.

The official workflow uses the OpenAI relay. A code does not contain a custom
server address. Keep that workflow; do not silently replace it with SSH, a new
host agent, a server-generated pairing code, or a borrowed device identity.
ChatGPT account/workspace matching is an official prerequisite; project
directories on the controlled computers may differ.

1. Server-side authorization uses PKCE and the observed official enrollment
   scope. The owner can authorize in a browser and submit the returned callback
   URL in our Web if that browser is on another computer. No SSH tunnel or
   desktop Codex process is required. State, callback origin/path, account,
   scope, and fresh reauthentication must be checked.
2. The server registers its own protected device key, saves only its own
   enrollment atomically, refreshes its relay session, and accepts host codes
   only after enrollment. Preserve ordinary Codex login and other devices.
3. The server authenticates relay WebSockets with the device key, opens separate
   host streams, and routes JSON-RPC responses, notifications, and approvals to
   the correct host. A disconnect must expose uncertain command outcomes rather
   than silently retrying mutations. Bound incoming frames and chunk assembly.
4. Our authenticated Web exposes controller setup, code input, device status,
   and selection/control of connected hosts. Existing local sessions continue
   to work; remote paths and host identities must not be treated as local ones.
5. Verify real pairing and a read/write/notification round trip against the
   owner's official client. Verify concurrent independent hosts and reconnect
   routing with two real endpoints. Unit fixtures alone cannot prove official
   interoperability or compatibility with every Codex version.

The observed endpoints and protocol are version-specific implementation details,
not an established public controller SDK. Software vTPM is an experiment and
must not be represented as physical hardware protection. Do not claim the goal
complete while authorization, official pairing, or concurrent control remains
unverified.
