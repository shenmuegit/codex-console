# Native browser client: design and delivery plan

[中文](../../zh-CN/superpowers/specs/2026-10-07-native-web-client-design.md)
· [Source investigation](../../codex-source.md)

Status: proposed design; no client implementation has started. The user requested
planning. Desktop IPC access is a required validation step, not a proven connection.

## Goal and scope

Use the existing Codex desktop account, projects, conversations, and running tasks
from a native browser interface at `https://HOST_IP:PORT`. One authenticated owner,
one host, one gateway process running as the desktop's OS user. Conversation state
and model execution remain owned by the desktop and its existing backend.

The full first release includes every capability in the table below. Delivery
phases sequence that scope; later phases are not optional feature deferrals.

Two planning assumptions await clarification:

- Seven-day usage means account weekly quota consumption and reset time. Token
  activity and monetary costs are different metrics.
- Editing a workspace means its display name and directory binding. Archiving
  preserves its directory and conversations. A code editor or physical repository
  move is additional scope.

## Feature contracts

| Capability | Required behavior |
| --- | --- |
| Workspace management | List desktop workspaces; register an existing host directory or create one; edit name/binding; archive and restore. The picker browses host directories, not the phone's filesystem. |
| Workspace history | Rebinding a workspace never moves files or rewrites existing threads' `cwd`. Existing threads retain their actual paths; new threads use the new binding. Archiving hides the workspace without stopping tasks or deleting files. |
| Conversation management | List by workspace; create, open, and delete conversations; show native running/idle/failed states. Use real native thread IDs and provide a copy action. |
| Read conversations | Paginate history; display user/assistant messages, visible tool activity, files, and live updates. Preserve scroll position when loading older messages. |
| Send and stop | Send to the selected native thread. Delegate running-turn steering/queuing to the desktop and display the result. Stop through the native interruption action; do not kill the desktop process. |
| Delete conversations | Use native deletion, not hidden archiving or direct database edits. Confirm once; if running, wait for interruption before deleting. Keep project files and completed uploads. Both clients must reflect deletion. |
| Files and photos | Native file/photo pickers, multiple selections, preview/removal, and a serial upload queue. Default cap: 32 MiB per file, configurable. Upload completes before its attachment is sent. |
| File downloads | Resolve file references shown in a conversation into authenticated download actions. Preserve original filenames and bytes. Resolve against the thread's actual workspace, including after a project binding changes. |
| Models and reasoning | Populate choices from native capabilities. Offer only that model's supported reasoning efforts. Changes apply to the next sent turn and retain the draft; display the effective model when the backend reroutes. |
| Default authorization | New threads and subsequent sends default to full filesystem/network access and no execution-approval prompts, subject to native managed restrictions. Show effective settings. |
| Context usage | Show the latest active-context tokens, model window when available, and the native used/remaining percentage. Update after compaction and model changes. Missing data is unavailable, never a fabricated zero. |
| Seven-day usage | Display account weekly used/remaining percentages and reset time, separated by quota bucket. It is account-wide, not a project total. |
| `@` | Search/select files, directories, conversations, and available applications/plugins. Preserve exact native reference descriptors and permissions. |
| `$` | List skills for the current workspace and send the selected native skill name/path with its visible invocation. |
| `/` | Display the installed desktop's supported command catalog. Route each entry as a native action, UI action, or prompt command; do not invent a `commands/list` RPC. |

## Minimal architecture

The browser talks to the authenticated HTTP/WebSocket gateway. A single desktop
adapter connects that gateway to the selected desktop instance's existing IPC
and native actions. The adapter translates protocol details; it does not own a
second chat database or start an independent Codex engine.

- Desktop is authoritative for conversations, running turns, account state,
  native project registrations, model capabilities, and usage.
- Browser-only aliases, project archive overlays where needed, and preferences
  fit in one small JSON file outside the repository. If project mutations are
  unavailable through a supported desktop interface, add that bridge capability
  explicitly; do not silently create an unrelated project registry.
- Only active conversation snapshots and pending request correlations are cached
  in memory. Reconnect obtains authoritative state before applying live changes.
- The adapter is for one verified desktop protocol/build. Record capabilities
  and reject unsupported operations visibly; no generic provider/plugin framework.

Proposed implementation boundary, after the connection gate passes:

| Files | Responsibility |
| --- | --- |
| `web/package.json`, lockfile | Node.js 24; [ws](https://github.com/websockets/ws) for WebSocket serving and [markdown-it](https://github.com/markdown-it/markdown-it) for safe Markdown. |
| `web/server.mjs` | HTTP/HTTPS, owner login, API allowlist, WebSocket sessions, project actions, preferences. |
| `web/desktop.mjs` | IPC framing, permitted handshake, request correlation, native action mapping, capabilities, snapshots/events. |
| `web/files.mjs` | Streaming uploads, native attachment descriptors, validated file-reference downloads. |
| `web/public/index.html`, `app.js`, `styles.css` | Responsive project list, conversation list, transcript, model/usage controls and status. |
| `web/public/composer.js` | Drafts, attachments, `@`, `$`, `/` menus, native input descriptors and IME handling. |
| `web/test/*.test.mjs` | Built-in `node:test`; synthetic protocol fixtures and HTTP/WS/file/composer checks. |

Serve static assets from the gateway, including only the fixed Markdown asset.
Use browser-native file pickers and clipboard APIs. No frontend build step is
required. Desktop/mobile navigation is project → conversation → chat; desktop
can show three columns, while mobile shows one level at a time.

## Authorization and data handling

The normalized web permission preset is `full`. The adapter maps it to native
`sandbox: "danger-full-access"` and `approvalPolicy: "never"` for thread creation;
turn requests use the native `sandboxPolicy` representation. Named `permissions`
profiles and sandbox fields are mutually exclusive. Reading a thread does not
escalate an already-running turn. A policy refusal is shown rather than bypassed.

Full execution authorization does not remove web login, OS ownership checks, or
native identity/tool verification. Native requests for user input and approvals
still need a visible response path with a single designated responder.

Configuration, TLS keys, login credentials and state live outside the repository:
`~/.config/codex-console-web/` and `~/.local/state/codex-console-web/`, respecting
XDG overrides. Initial deployment assumes an already-running, signed-in desktop.
Use HTTPS/WSS for the host-IP entry, authenticated cookies, origin validation,
and an explicit API allowlist. Do not expose arbitrary IPC methods.

Uploads use a metadata request followed by a raw binary body, avoiding a custom
multipart parser. Count streamed bytes, clean incomplete files after failure,
and retain completed attachments for later native reads. Downloads use issued
file-reference IDs bound to the native host/thread and validated real paths;
there is no arbitrary-path or arbitrary-URL fetch endpoint. Render Markdown with
raw HTML disabled and validate links; executable uploads are downloads, not pages.
Ordinary files must use the desktop's file-context/attachment representation;
photos use its image-input path. Do not invent a generic binary `UserInput` type.
Honor a lower native/model limit and retain the draft if an attachment is rejected.

## Input, settings and usage rules

- A selected `@` target remains a structured native reference. Application/plugin
  mentions, file context and conversation references have different native
  representations. Referencing a conversation grants no implicit right to send
  messages to it.
- A selected `$` skill includes a `skill` input item. Unknown dollar expressions,
  emails, paths, and text inside code remain literal. `/` completion is limited
  to the appropriate command position and the actual supported command catalog.
- Rich input spans use native UTF-8 byte offsets. JavaScript UTF-16 caret offsets
  must be converted correctly, including Chinese and emoji. IME confirmation
  never triggers send or a menu choice; Enter sends, Shift+Enter inserts a newline.
- Use a stable client message/request ID for correlation. Native support for
  `clientUserMessageId` is not proof of idempotency. Never automatically replay an
  uncertain send/create/delete after disconnect; reconcile with native state and
  preserve the draft/pending status.
- Prefer the desktop's computed context status. Public protocol reference data
  distinguishes `last.totalTokens` (latest active context) from accumulated
  `total.totalTokens`; native percentage calculation also accounts for its fixed
  baseline. Do not estimate context using accumulated conversation tokens.
- For weekly quota, prefer `rateLimitsByLimitId`; use the legacy snapshot only
  when needed. A seven-day window is `windowDurationMins == 10080`. Do not assume
  `secondary` always means weekly or add percentages across buckets. Clear cached
  account data on account changes. Null values are unavailable.
- Model and effort selections come from the native list and remain subject to
  account policy. A catalog entry is not an entitlement guarantee. Surface native
  rejection and retain the draft; do not silently select another model.

## Delivery sequence and acceptance gates

Every independently completed implementation problem must be verified, committed
and pushed before the next begins, as required by this repository's AGENTS.md.

| Phase | Deliverable | Acceptance gate |
| --- | --- | --- |
| 0 — Prove desktop access | Record IPC handshake/schema, instance identity and operation capabilities; a disposable bridge probe only. | Read a real existing desktop thread and receive matching live changes without creating another engine. Demonstrate create/send/stop/delete only on a disposable test thread. Determine the supported workspace, attachment, settings, usage and reference paths. |
| 1 — Usable core | Authenticated gateway, responsive navigation, project create/edit/archive/restore, conversation management, history/live chat, send/stop, copy ID, effective full permissions and native pending-input handling. | Desktop and browser refer to the same native thread; lifecycle changes are visible in both. Archiving retains files and threads; rebinding retains old thread paths. |
| 2 — Files | File/photo picker, progress/preview, native attachment delivery, transcript file downloads. | A Unicode-named document and photo reach the native thread; a generated local target downloads byte-for-byte with its original name. A failed upload leaves the draft and existing data intact. |
| 3 — Model and usage | Native model/effort controls, context meter, weekly quota and reset display. | Only supported efforts appear; next-turn settings are effective; compaction/model changes update context correctly; multiple/null quota windows are handled honestly. |
| 4 — Composer and release | `@`, `$`, `/` native references/commands, mobile/IME completion, reconnect recovery, packaging and bilingual operator documentation. | Selected references reach Codex with native identities; native commands have their real effects; a disconnect never duplicates a user message; desktop/mobile workflows pass. |

If phase 0 cannot expose an authorized write/subscribe path, stop the client build
at that gate and propose a desktop-side bridge change. A shared app-server is an
alternative only if the desktop itself can be made to use that same instance and
desktop-level behavior is verified. It must not masquerade as the existing desktop
while operating an independent backend or modifying private SQLite directly.

## Required verification

| Condition | Expected result |
| --- | --- |
| Desktop creates/messages a thread while the web view is open | Native IDs, message order and live state match; reconnect reloads on revision gaps. |
| Double click or disconnect after a write was accepted | Correlate/reconcile; no automatic duplicate turn or empty thread. |
| Delete a running thread | Interrupt first; refusal/timeout preserves history and project files. |
| Rebind/archive a project with existing threads | Old `cwd` and artifact references stay valid; archive preserves disk data and running tasks. |
| Chinese, emoji, IME, pasted code and email addresses | UTF-8 spans remain correct; no accidental send, skill expansion or command execution. |
| Oversized, interrupted, unreadable or disk-full upload; forged download target | Clear failure, partial-file cleanup, no cross-thread leak or arbitrary host-file fetch. |
| Model disappears, reasoning choice is unsupported, quota/context fields are null | Preserve the draft and report native status; never fabricate settings or zero usage. |
| Native permission restriction or pending verification | Show effective policy and the real pending action; never forge acceptance. |
| Unauthenticated/cross-origin request, unsafe Markdown link/HTML | Reject at the gateway or render safely; no IPC or credential exposure. |

Run `node --test web/test/*.test.mjs` once the implementation exists, then exercise
a real desktop with disposable fixtures and a real mobile browser for IME,
clipboard, photo upload, download and keyboard layout. Planning itself changes
documentation only and requires diff/link/coverage checks, not runtime tests.

## Evidence and remaining uncertainty

Reference source: official Codex checkout `ff9ab4aed96aa2e105f78b9521dbbd3a6b329dc8`;
GitNexus repository `codex`. Installed desktop inspected: `26.928.21956`.

| Evidence | What it establishes |
| --- | --- |
| [Thread/turn protocol](https://github.com/openai/codex/blob/ff9ab4aed96aa2e105f78b9521dbbd3a6b329dc8/codex-rs/app-server-protocol/src/protocol/common.rs) | Native thread deletion, model/skill/app lists, usage requests and events exist. Their presence does not prove they are callable through desktop IPC. |
| [Turn inputs/settings](https://github.com/openai/codex/blob/ff9ab4aed96aa2e105f78b9521dbbd3a6b329dc8/codex-rs/app-server-protocol/src/protocol/v2/turn.rs#L167) | Message ID correlation, model/effort and authorization overrides; typed local-image/skill/mention inputs. |
| [UTF-8 input spans](https://github.com/openai/codex/blob/ff9ab4aed96aa2e105f78b9521dbbd3a6b329dc8/codex-rs/protocol/src/user_input.rs#L16) | Rich input ranges are UTF-8 byte ranges. General files are not a generic binary `UserInput` variant. |
| [Context accounting](https://github.com/openai/codex/blob/ff9ab4aed96aa2e105f78b9521dbbd3a6b329dc8/codex-rs/tui/src/chatwidget.rs#L1122) and [quota windows](https://github.com/openai/codex/blob/ff9ab4aed96aa2e105f78b9521dbbd3a6b329dc8/codex-rs/app-server-protocol/src/protocol/v2/account.rs#L752) | Latest context versus accumulated usage; nullable quota durations/reset times. |
| Desktop distribution code | Local IPC, `thread-stream-state-changed` snapshots/patches and workspace-root actions exist in installed code. Runtime handshake, RPC reachability and permissions remain unverified. |
| [Official App Server documentation](https://learn.chatgpt.com/docs/app-server) | Published conversation, skill, account-usage and rate-limit protocol guidance. |

Inspected desktop bundle fingerprints:

- `.vite/build/bootstrap-B7ariqxX.js`: `ad9f3da3d96e6713c89b800d1e0c369f8fad1cc20af8233cf7bd906550a2a5fd`.
- `.vite/build/main-BbeJ4AAR.js`: `1ff5a43bde26ea6c1b77dbcf782625c890e35a836d489163c19d5ba9942d68b4`.

Open decisions are limited to the two user-facing assumptions above and the
phase-0 desktop contract. Live quota values, account credentials and real chat
contents are not collected or stored in this design.
