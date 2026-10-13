# Skill and Plugin Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let people discover and select skills, plugins and connectors visually, including favorites and recent selections in the first release.

**Architecture:** Add a composer picker using the existing native discovery and typed selection/send pipeline. A thread-scoped catalog reads skills, installed plugins and all connector pages without the file/thread completion limit. Browser preferences store identities only, scoped to host and actual working directory.

**Tech Stack:** Existing vanilla JavaScript, CSS, Node HTTPS gateway and node:test; existing Playwright/Chromium installation for browser QA. No new application dependencies.

**Spec:** The approved in-chat design: visible composer entry, skills/plugins tabs, name/purpose/source/status, purpose search, removable multi-selection tags, mobile bottom sheet and desktop anchored dialog; additionally favorites, recent selections and plugin-contained skills, as explicitly requested for the first release.

## Global Constraints

- Work, verify, commit and push only on `main`; preserve all pre-existing changes.
- Deliver this single feature in one commit and immediately push; stage explicit paths only.
- Keep native IDs/paths as identity and revalidate selections when sending.
- Selection affects the current draft; it does not change installation, authorization or enablement.
- Keep Chinese/emoji UTF-8 binding, IME and existing `@`/`$`/`/` behavior intact.
- Update English and Chinese native-client documentation.

## Review Focus

- Reconnection, thread/workspace switches and closed dialogs invalidate late results.
- Duplicate names use native identity; removing a tag preserves adjacent text and other bindings.
- Unavailable capabilities remain visible with truthful status; partial discovery failures retain usable results.
- Storage denied/corrupt preferences never block selection and cannot cross hosts/workspaces.
- Small/landscape viewports, long labels and keyboard focus remain usable in both themes.

### Task 1: Complete picker and acceptance checks

**Files:**
- Modify: `web/server.mjs`, `web/public/composer.js`, `web/public/chat.js`, `web/public/index.html`, `web/public/styles.css`.
- Create: `web/public/capabilities.js`, `web/test/capabilities.test.mjs`.
- Modify: `web/test/dom.mjs`, `docs/native-web-client.md`, `docs/zh-CN/native-web-client.md`.

**Interfaces:**
- `POST /api/capabilities { viewId, threadId }` returns `{ items, unavailable }`, restricted to the opened thread's actual working directory.
- Catalog items retain `kind`, `name`, `id`/`path`, `label`, plus display name, description, source, status, keywords and plugin-linked skills.
- `insertSelection(state, item, range)` reuses composer binding updates and returns the new caret.
- `mountCapabilities({ api, viewId, selectedHost, getState, onChange, onOpen })` exposes `render`, `close`, `remember`, `dispose`.

- [x] Write and run failing HTTPS/DOM checks for scoped discovery, metadata search, connector pagination, partial failures, insertion/removal, favorites/recent persistence, storage failure, keyboard/IME and stale responses.
- [x] Implement native catalog, shared insertion, picker UI and chat lifecycle integration; watch the focused checks pass.
- [x] Capture and inspect real-browser desktop/mobile screenshots; exercise search, favorites/recent, bundled skills, multi-selection/removal, Escape/focus and theme/viewport changes.
- [x] Update bilingual usage/verification documentation and record the browser evidence and its limits.
- [x] Run the web suite and `git diff --check`; obtain read-only Superpowers code review and resolve material findings.
- [ ] Stage only feature paths, commit the validated result, push `main` and confirm the remote contains the commit.
