# Native browser client

[中文](zh-CN/native-web-client.md)

The native client is implemented on `codex/native-web-client` and runs against the
isolated source-built app-server shared with the extra desktop. Projects, chats,
files/photos, model/usage controls and native `@`/`$`/`/` actions are available.
The original desktop's backend has not been migrated. Browser/hardware UI
acceptance is explicitly listed below.

## Codex desktop interface

The shell copies the installed Codex desktop's gray theme tokens, native system
font and current 290 px sidebar preference. One global sidebar contains native
projects/conversations; the conversation pane uses the desktop-style rounded
input surface. Model, effort, permissions and the read-only context indicator
are inside that surface. Context details retain native token/window values and
the native 12000-token percentage baseline; no custom context limit is added.

Projects and Conversations have separate headings. The project list contains
native projects only; All conversations is a conversation-scope control. The
conversation scope names its selected project even if the project list cannot
refresh, and archived empty results are labeled explicitly. Selecting a project
filters native conversations by its ID.
New project opens a name and existing-server-directory form. The directory is
checked through native metadata and canonicalized before native `project/create`.
Successful creation selects the project scope; New conversation then uses that
native project ID. Existing conversations keep their working directories.
Uncertain creation retries retain the native idempotency key and lock the input
values until the result is confirmed, even if a later retry is not sent. Closing
the form preserves newer navigation.

At widths of 760 CSS px or less, navigation opens as a left drawer capped at
290 px, leaving at least 48 px outside it. Chat keeps its full width behind the
backdrop. Outside click, Escape and the close control dismiss the drawer;
selecting a conversation closes it and focuses the chat heading. Keyboard focus
stays in the open drawer, and the covered chat is inert. Resizing restores the
normal desktop sidebar and chat interaction.

An authenticated visit without a thread ID prepares one native blank conversation
when the backend is online. File/photo pickers and model/effort selectors then
work without first clicking New conversation. Its ID is recorded in the URL,
so reload reopens it. Existing thread links and newer navigation take priority.
This preparation sends no model turn. Creation failures stay visible in chat;
the existing New conversation button can retry.

New turns request native automatic reasoning summaries because current model
catalogs can default to no summary. The reasoning panel displays native public
text as it arrives. An empty live item shows a waiting state; a completed empty
item explains that no summary was provided. Older messages with no returned
public text cannot be backfilled from their encrypted records.

The sidebar footer opens account-wide seven-day usage, including when no
conversation is selected. Switching conversations does not change its scope.
The attachment plus opens the existing file/photo pickers. Existing-project
editing/archiving, directory mutation, logout and manual conversation refresh
controls remain absent. The owner-only project-create endpoint requires its own
session view; raw project mutation RPCs and browser thread-cwd overrides remain denied.
Native row menus require a current browser with Popover API support.
Archive always asks for confirmation that any running work will stop, including
when the conversation list has not yet received its latest status.
Restoring from a row menu preserves the current conversation, draft and archive
filter. Clicking the archived row itself restores and opens it unless a newer
navigation supersedes that action; repeated restores share the row's busy guard.

## Install and operate

Requires Linux with a user systemd manager, Node.js 24+, OpenSSL and the verified
persistent native executables described below. Install the single package first:

```bash
npm --prefix web ci
node web/service.mjs init --origin https://127.0.0.1:15443 \
  --backend-bin "$HOME/.local/lib/codex-console-web/bin/codex-app-server" \
  --backend-home "$HOME/.local/state/codex-console-web/native-home" \
  --workspace "$HOME/.local/state/codex-console-web/workspace"
node web/service.mjs install
node web/service.mjs start
node web/service.mjs status
node web/service.mjs stop
```

All commands accept `--config /absolute/private/config.json`; defaults follow
XDG_CONFIG_HOME/XDG_STATE_HOME. Initialization refuses existing credentials and
the original Codex home. It copies only an existing file login when needed,
never conversation/account databases. Password/hash, certificate/key and the
explicit proxy/TLS environment file are owner-private. API-key/task overrides
are excluded. The owner password is in `owner-password` beside the config and
is never printed. `--cert` and `--key` copy an existing pair into private storage;
otherwise init generates a 30-day self-signed SAN certificate for the origin.
Trust/import that certificate on the accessing device, or provide a trusted pair.
Browser security interstitials require the owner to act.

Private destinations are checked through their real existing ancestors before
initialization writes anything, then checked again when configuration is loaded.
A symlinked directory cannot redirect credentials or application data into the checkout.
An existing project workspace keeps its permissions; only newly created workspaces
and private application storage receive owner-only permissions.
Initialization checks the native executables before creating credentials. A later
failure removes files created by that attempt, preserves pre-existing material,
and allows the corrected initialization command to be retried.

The only managed units are `codex-console-native-backend.service` and
`codex-console-native-web.service`. Native startup uses the configured persistent
source executable and isolated home. The web handshake checks that native home;
there is no fallback engine. Unit paths preserve spaces/Unicode/%/$ without a
shell. A worktree referenced by an installed unit must stay present.
Installation checks both existing unit owners before changing either file.
Start/stop verify the OS-user owner and managed marker of both loaded unit files;
an unrelated service with the same name is preserved.
Stopping owned units does not require a working TLS/configuration installation.
Status still reports unit state after certificate expiry or executable removal,
with HTTPS unavailable; installation and startup retain full validation.

## Current verified deployment

- Entry: `https://117.72.158.35:15443`, with HTTPS listening on `0.0.0.0:15443`; native WS stays loopback
  `ws://127.0.0.1:4500`.
- Private config/password/cert/env: `~/.config/codex-console-web/`.
- Existing isolated native home/profile/workspace: `~/.local/state/codex-console-web/integration/`;
  web preferences/uploads remain under its `web/` child.
- Code: native managed worktree `/home/desktop/.codex/worktrees/native-web-client/codex-console`.
- The old Xpra service `codex-console.service` is stopped and disabled by owner
  request to release port 15443; its original desktop/backend processes have ended.
  The independent native backend continues to serve the browser client.

The public entry was verified with direct HTTPS login, rejected foreign Host/Origin,
native model reads, SSE snapshot recovery and logout. Password, private key and
native/upload data are retained in the same private locations.

The canonical Host/Origin is `https://117.72.158.35:15443`. The private config uses
`cert-public-117.72.158.35.pem`, whose SAN matches the public IP. It is self-signed;
trust/import the current certificate on the accessing device. Checks disable proxy
variables and connect directly to the public IP. External-device acceptance is
still manual. If the public IP or hostname changes, update both the configured
origin and matching certificate; arbitrary Host/Origin values remain rejected.

## Restart and rollback

For an existing installation, change the private config's `origin` and `port`
together to use another HTTPS port, for example `https://117.72.158.35:15443` and
`15443`. The current certificate remains valid when the hostname/IP is unchanged.
Confirm the target port is free before restarting the web unit. The old Xpra
service can contain the original desktop and its active backend; stopping that
whole service ends those processes and requires an agreed desktop shutdown.

```bash
systemctl --user restart codex-console-native-web.service
systemctl --user restart codex-console-native-backend.service
node web/service.mjs status
```

Web-only restart preserves native work and requires browser login again because
owner sessions are in memory. Backend restart uses native persistence and reloads
authoritative state; active tasks are not promised a seamless transfer and sent
mutations are never replayed. Stop/restart only these owned units. Moving the
original desktop to this backend requires a separate migration instruction after
its active work finishes.

Rollback keeps all native/upload data intact:

```bash
node web/service.mjs stop
systemctl --user disable codex-console-native-web.service codex-console-native-backend.service
```

## Release verification and UI limits

118 Node checks passed; the production dependency audit reported zero vulnerabilities.
The initial native web release's six Important findings and three findings
promoted from Minor were fixed in nine independently verified and pushed commits.
Mounted event checks cover duplicate commands, modified Enter and conversation
reload identity; a real HTTPS/native check also confirms nested Unicode completion.
All opt-in HTTPS/native checks passed against the durable services, including
projects, two-client chat, interruption, file/photo round trip, exact downloads,
model/effort/context/compaction, weekly metadata, references and command effects.
Separate web/backend restart checks proved accepted work survives web restart,
authoritative resync after backend restart and one native user message per UUID.
Runtime proof files stay outside Git.
First-entry checks also exercised the mounted controllers against real HTTPS and
the native backend: both settings were saved and text/PNG uploads retained exact
bytes. The disposable conversation and uploads were removed; no inference ran.
The reasoning check received native summary deltas through the real HTTPS/SSE
path and retained the public summary after reopening its disposable conversation.
Native project acceptance created a disposable project through the mounted form,
replayed its key to the same project, and opened a chat using the native primary
root. The original chat cwd and host files were preserved; fixtures were cleaned.

The UI tool reported no enabled browser/native surfaces. No login click,
authenticated app screenshot, real mobile IME/picker/clipboard/download or desktop
keyboard acceptance is claimed. Those are manual release checks: log in, open
the sidebar and choose a native project/conversation on a phone, confirm IME
Enter, choose/remove/retry files, copy
the full ID, download exact bytes, open the same thread in the extra desktop and
send in both directions. The CSS uses visible focus, native controls, safe areas
and the visual viewport for the keyboard; physical-device behavior remains unverified.
An offline static Firefox fixture at 390×844 with 430 px of visible app height
confirmed that the empty welcome area shrinks and the send button stays visible.
Static drawer renders at 320, 390, 706 and 1280 CSS px confirmed the width cap,
outside close area, visible chat and absence of horizontal page overflow.
The project form also fits a 390 px layout with 430 px of visible keyboard height.

Known presentation limit: another page opening the same conversation can reset
already loaded older pages to the latest 20-turn snapshot. Use **Load earlier
history** again; the native history remains intact. This review minor is deferred.

## Native connection

`web/codex.mjs` accepts only a configured loopback WebSocket endpoint with an
explicit port. It initializes the native experimental API, correlates replies,
preserves native errors and times out RPC calls after 30 seconds. Connection
opening and initialization have a 10-second deadline.

Every native frame receives a generation/sequence cursor. An atomic native
resume snapshot is published before later deltas or waiting HTTP handlers run.
Each page obtains its own snapshot; closing the last page only unsubscribes an
idle thread. There are no manual project/conversation refresh buttons. Native
events update the lists, and reconnection rereads both catalogs even when no
conversation is selected. Running work stays subscribed until its matching turn completes.
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
The app-server remains the pinned source build with unchanged feature code.
Temporarily stamp `0.159.2-dev.ff9ab4a` release metadata to match the installed
Codex version: the development default `0.0.0` receives a reduced compatible
model catalog. Cargo updates only workspace versions offline, third-party locked
dependencies are checked unchanged, and both source metadata files are restored
after building. Models and reasoning efforts remain native; hidden internal
models are not added to the desktop picker. Both executables live outside Git at
`~/.local/lib/codex-console-web/bin/`.

```bash
cd /home/desktop/Documents/Codex/codex-console/codex/codex-rs
(
  set -e
  codex_build_backup=$(mktemp -d)
  cp Cargo.toml Cargo.lock "$codex_build_backup/"
  trap 'cp "$codex_build_backup/Cargo.toml" Cargo.toml; cp "$codex_build_backup/Cargo.lock" Cargo.lock; rm -rf "$codex_build_backup"' EXIT
  python3 - <<'STAMP'
from pathlib import Path
import tomllib
p = Path('Cargo.toml')
text = p.read_text()
assert tomllib.loads(text)['workspace']['package']['version'] == '0.0.0'
start = text.index('[workspace.package]')
p.write_text(text[:start] + text[start:].replace('version = "0.0.0"', 'version = "0.159.2-dev.ff9ab4a"', 1))
STAMP
  "$HOME/.cargo/bin/cargo" +1.95.0 update --offline --workspace
  python3 - "$codex_build_backup/Cargo.lock" <<'LOCK'
from pathlib import Path
import sys, tomllib
old = tomllib.loads(Path(sys.argv[1]).read_text())['package']
new = tomllib.loads(Path('Cargo.lock').read_text())['package']
assert [p for p in old if 'source' in p] == [p for p in new if 'source' in p]
LOCK
  CARGO_HTTP_MULTIPLEXING=false CARGO_INCREMENTAL=0 \
  CARGO_TARGET_DIR="$HOME/.cache/codex-console-web-build" \
    "$HOME/.cargo/bin/cargo" +1.95.0 build --offline --locked --profile dev-small -j 2 \
    -p codex-app-server --bin codex-app-server
)
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

The corrected build returns the same seven visible models as the desktop, including GPT-6.1-Sol, GPT-6-Sol and GPT-6-Luna. A real GPT-6.1 native filesystem turn and the public HTTPS/model/SSE smoke passed; the disposable thread/file were removed.

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

The remaining sections document the implemented components; no Xpra connection is used by this client.

Task 1 verification: source app-server build exit 0 in 11m 13s; 10 native-client checks and the legacy isolated suite passed. Native reads returned four models, zero isolated projects/threads and an available login; the extra desktop initialized its WebSocket connection. The real filesystem probe passed: a native tool wrote the exact expected bytes and its disposable thread was deleted. The official desktop companion is compatible with this tested execution path.

Current executable: app-server `0.159.2-dev.ff9ab4a`, SHA-256 `060d8d708d00c10b50d16620c9c63374c2ceb262f482163e3dbdac81110c7c37`; desktop companion SHA-256 `5b2c075ac2380fa04d76d7313fbc044d29c8d0a0d0b9138415acd4610211ca03`. The original Task 1 `0.0.0` build is historical. Keep the source commit, release metadata and binary hash together when reproducing model discovery.


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
The UI has no logout control; the existing secure owner session is reused until
its absolute expiry requires the password again. Internal session cleanup closes
only its own streams, preserving other sessions and the native connection.

The isolated HTTPS test unit is `codex-console-native-web-test`, listening only
on `https://127.0.0.1:8443`. Its temporary integration configuration and private
owner password are in `~/.config/codex-console-web/integration/`; generated TLS
files are self-signed for loopback. The durable host-IP deployment is described above.
Run `node --test web/test/auth-server.test.mjs` for the isolated HTTPS/auth suite.
Nine checks passed, including a paused real TLS/SSE reader while another page
continued receiving events. A live HTTPS smoke against the source backend also
passed: unauthenticated 401, foreign Origin 403, four native catalog models,
snapshot-required SSE and logout. Password values were not printed.


## Browser conversations

Choose a native project or all conversations; list pages contain 20 entries.
New conversations use the selected host directory, full access and no execution
approvals, subject to native managed restrictions. Each new empty thread is named
before its atomic resume. The header displays the real thread ID for copying and
native conversation defaults. Reading a thread leaves its execution permissions
unchanged.

The composer keeps a stable message UUID, preserves failed/uncertain drafts and
retains drafts in browser session storage when available. During active work,
choose **Supplement current turn** or **Queue for the next turn** explicitly.
Steering keeps current-turn settings; queued work uses native future defaults.
Queueing waits for the native settings notification before applying full future
permission defaults. Stop targets the actual active turn ID.

Opening/switching pages uses native atomic resume and ordered cursors. Native
completion summaries preserve previously streamed tool items. Older full history
pages prepend without overwriting current items; delayed safe HTML cannot replace
newer text. Markdown uses the pinned sole dependency `markdown-it` 15.0.2 with raw
HTML disabled, restricted URL schemes and no automatic external image loads.
Text streams immediately; safe HTML updates coalesce to 100 ms.

Native approvals, permission requests, questions and MCP form/URL elicitations
have explicit response controls. Resolved/stale forms cannot answer again.
Chinese IME confirmation, Shift+Enter and mobile Enter do not send drafts;
desktop Enter sends, and the Send button is available on all devices.

Opt-in live acceptance (uses the private owner password without printing it):

```bash
node web/test/web-probe.mjs \
  --config "$HOME/.config/codex-console-web/integration/config.json" \
  --password-file "$HOME/.config/codex-console-web/integration/owner-password" \
  --exercise-chat
```

Verified against the source-built backend: HTTPS send, a second native protocol
client's reply arriving over SSE, close/reopen during a real command, interruption,
one native message per repeated UUID and deletion of only the disposable test
thread. The original desktop remained running. No UI automation surface was
available; browser/desktop keyboard actions, actual clipboard copying and mobile
visual layout await manual acceptance. Use the extra desktop to open the same
real thread ID, send in both directions, then verify mobile navigation and copy.


## Native projects and working directories

Projects and roots are read from Codex and shown without web archive overrides.
The owner can create a native project from its name and an existing server
directory. Existing-project editing, folder creation and directory picking remain
unavailable. Retired project/folder mutation routes return
`WORKSPACE_MANAGED_BY_CODEX` before any native write; raw mutation RPCs stay denied.

Creating a conversation sends the selected native project ID. The gateway reads
its primary registered root, or uses its configured default when no project is
selected. Browser-supplied `cwd` overrides are rejected. Existing conversations
keep the actual working directory reported by their native snapshots.

Each conversation row has a three-line options button with **Copy thread ID**, **Archive/Restore**, and **Delete**. The header no longer displays copy/delete controls. Actions use the clicked row's full native ID and preserve another selected conversation and its draft. Native popovers support arrow keys, Escape/Tab dismissal and focus return; a running archive can be cancelled before interruption.

Conversation deletion still confirms once, reads fresh native active state,
interrupts its matching turn and waits up to 30 seconds. Refusal, timeout or a
new different turn prevents deletion; workspace files and uploads are retained.
The project checks cover read-only boundaries, authoritative roots, opaque
pagination and the existing interruption/deletion regressions.

## Files, photos and downloads

Use **Files** or **Photos** to select multiple attachments. Uploads run serially
with native browser progress and removable previews; sending waits for completion.
The default exact per-file cap is 33,554,432 bytes (32 MiB), configurable up to the
pinned native image-input ceiling of 1 GiB. Both metadata and actual streamed
bytes are checked. A cancelled, short, over-limit or failed upload removes its
partial files; existing completed attachments and the draft remain.

Completed metadata/files are private (0700 directories/0600 files) under the
configured state directory. Removing an attachment from the draft or deleting a
conversation does not delete its historical bytes. Native photos use local-image
inputs; documents use native text paths and UTF-8 text elements, never invented
binary input types. PNG/JPEG/WebP/GIF previews use raster signatures plus browser
and native image decoding. Active formats such as SVG remain ordinary downloads.

Download links are issued only for transcript targets and completed uploads,
using the thread's actual directory, known upload storage and configured generated
roots. Canonical paths, no-follow opens and opened descriptor/inode checks stop
symlink replacement. Links contain opaque IDs; arbitrary path/URL downloads are
not exposed. UTF-8 filenames use Content-Disposition and downloads stream the
opened file's bytes. Linux `/proc/self/fd` is required for this validation.

SSE keeps its 1 MiB queue bound. Large snapshots and presentations use authenticated
HTTPS with small SSE checkpoint signals; late file/HTML enrichment cannot replace
newer native text. JSON requests have a 30-second deadline; uploads have a
10-minute request deadline and a 30-second idle limit.

`web/test/files.test.mjs` verifies exact caps, chunked/dishonest lengths,
interruption/ENOSPC cleanup, Unicode names, invalid photos, forged IDs, symlink
races, project rebinding, authentication and large histories. Run the live probe
with `--exercise-attachments` to verify the native text/photo inputs and exact
model-generated download bytes. This passed against the source backend, including
successful download of an uploaded file after its disposable thread was deleted.
Browser picker/preview interaction still follows the manual UI acceptance note.


## Models and usage

The model menu and reasoning options come from the native catalog. Changes apply
to future turns through `thread/settings/update` and wait for its matching native
notification; they preserve the draft and never change a running turn through
`turn/settings/update`. Queued messages use shared future defaults, so subsequent
selector changes can affect them. Steering inherits the current turn. The header
reports native defaults and managed policy; unsupported model/effort/photo
combinations are rejected with the draft and attachments retained.

Context shows the latest `last.totalTokens`, available native window and the
native 12,000-token baseline percentage. Accumulated session totals are not used
as active context; missing windows/usage are explicitly unknown. Compaction and
model activity refresh this through native notifications. Execution/quota errors
arriving after an accepted send stay visible in chat.

Seven-day quota selects duration 10080 minutes in either native window, preferring
`rateLimitsByLimitId` when available. Buckets remain separate; reset seconds are
converted to local time. Account/model changes invalidate in-flight reads and
cached displays, including stale failures. No quota amounts or account values
are committed as test evidence.

Seven focused checks and the full current suite passed. Live
`web-probe.mjs --exercise-usage` verified two supported efforts, effective next
turn metadata, native context, compaction context refresh and real weekly
metadata against the source backend.


## Native @, $ and / actions

Type `@` to choose a file/directory in the conversation's actual workspace,
another conversation, or an available native app/plugin. Nested paths such as
`@src/` resolve from that conversation's directory. Type `$` for enabled
workspace skills. Picking binds the selected text; editing that token removes
the binding, while email, code and unselected `$HOME` remain literal text.
Chinese/emoji ranges use native UTF-8 offsets. IME confirmation never selects or
submits a completion. Unavailable native catalog entries stay visibly unavailable.
Shift+Enter keeps its newline behavior while the completion menu is open;
plain Enter accepts the highlighted choice.

Files/directories use native quoted paths, skills use typed skill inputs and
apps/plugins use typed mention identities. Thread links use the native escaped
format, with self/duplicate context excluded, at most 16 IDs and 768 ID bytes.
At send time only the selected threads are read. Snapshots are JSON-quoted,
marked untrusted and capped at 8 KiB each/32 KiB total. Queue mode uses a separate
quoted untrusted text input because native queue/add has no additionalContext
field. This is a send-time snapshot; it does not message the referenced thread.

Supported commands: `/new`, `/model [model effort]`, `/permissions`, `/status`,
`/usage`, `/skills`, `/compact`, `/rename [name]`, `/archive`, `/delete`, `/fork`,
`/export`. The first group opens existing UI/native controls. Rename/compact use
native actions; archive stops active work only after confirmation/interruption.
Enable **Show archived conversations** and click one to restore it. Delete keeps
its existing confirmation. Fork uses full defaults and defers automatic inherited
goal continuation. Export downloads paginated native history as Markdown without
writing a host file. There is no invented commands/list or read_thread tool.
Command submission locks before awaiting native work, so double Enter/click
cannot create duplicate forks or compactions. Failed commands preserve the draft;
editing while a command runs preserves the newer text.
Opening, creating or forking a conversation updates its thread ID in the page
address, so refresh reopens the conversation currently selected.

Task 7's eight focused checks and the full suite passed. Live
`web-probe.mjs --exercise-references` verified a file, real skill, real plugin,
read-only thread snapshot reaching the model, native queued snapshot data,
rename/fork/archive/restore/export and disposable cleanup. No callable native app
was available in this account/runtime, so that catalog remains unavailable;
its typed representation is covered by fixtures. UI clicks remain in the manual
acceptance scope stated above.
