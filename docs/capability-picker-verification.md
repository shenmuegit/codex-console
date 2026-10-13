# Capability picker verification

The composer picker includes skill/plugin/connector discovery, purpose search,
details and plugin-linked skills, removable multi-selection tags, favorites and
the last 20 selections. Native identities remain authoritative at send time.

Initial feature verification used Superpowers regression-first development and read-only review,
with UI/UX Pro Max checks against the existing fonts, gray theme tokens, focus
states, touch targets and responsive layout. It adds no production dependency.

## Automated checks

```bash
node --test web/test/capabilities.test.mjs web/test/composer.test.mjs web/test/completion-interactions.test.mjs
cd web
npm test
```

The focused set covers opened-thread/actual-cwd restrictions, explicit native
refresh, workspace/app loading separation, all connector pages and partial page
failures, native loading errors,
typed inputs and send-time rejection, bindings before/after edits and duplicate
names, stale requests, IME, focus, shared preferences and blocked/corrupt/quota-
limited storage. Favorites and recent selections stay scoped to host and cwd;
unsaved memory preferences survive controller recreation within the page.

Loading regressions verify that skills never wait for app discovery, local plugins
stay usable during app loading, late app replies preserve plugin details and
accepted selections, and successful catalogs reopen without another request.
Cache isolation covers thread, cwd and native generation; account invalidation
discards pending replies. Explicit refresh still locks stale choices and failures
remove them. The browser fixture returns the requested catalog section.

Current results: 65 focused checks passed. The complete web suite passed 504
checks, with eight Windows-only ACL checks skipped on Linux and no failures.

## Direct endpoint timing

Before this fix, forced native discovery returned skills in 412 ms and installed
plugins in 52 ms, but the combined response waited for `app/list` to time out at
30,002 ms. After deployment, three authenticated direct HTTPS calls to
`/api/capabilities` with `section: "workspace"` returned in 169, 171 and 172 ms,
each with 180 skills, eight plugins and no source errors. Probes disabled proxy
environment variables and confirmed the served client files matched this change.
The existing native backend was not restarted; no model or plugin was invoked.
External app discovery remains subject to native service and network latency.

## Real-browser checks

Install Playwright as a verification tool, or use an existing installation. Its
Chromium may be installed with `python -m playwright install chromium`. This is
not an application dependency. The runner uses fixture catalogs and a temporary
localhost server; it never connects to an owner session or invokes a model.

```bash
uv run --with playwright python web/test/capabilities-browser.py
# Alternatively, use an already installed Chromium:
uv run --offline --with playwright python web/test/capabilities-browser.py \
  --chromium /absolute/path/to/chrome --output /tmp/codex-console-capability-qa
```

The initial feature's browser run captured 36 screenshots across these nine cases.
This loading optimization did not rerun that visual check; it updated and syntax-
checked the section-aware browser fixture and used the automated and direct
endpoint checks above.

| Viewport | Theme | Main check |
| --- | --- | --- |
| 1280 × 850 | light and dark | Dialog anchored above the composer |
| 375 × 812 | light and dark | Full-width bottom sheet and readable details |
| 667 × 375 | dark | Landscape scroll and reachable footer |
| 1024 × 500 | light | Short desktop window |
| 820 × 420 | dark | Short desktop window |
| 320 × 568 | light | Small phone and four long selected labels |
| 375 × 480 | dark | Reduced viewport, simulating keyboard space |

Each case checks purpose search, favorites/recent persistence and host isolation,
plugin-contained skills, selection/removal, preserved Chinese/emoji text, native
mention identity, Escape/focus restoration, long-label scrolling, horizontal
overflow, reachable actions and JavaScript/console errors. Screenshots include
the list, plugin details, ordinary selections and four long selected labels.
`report.json` records viewport metrics and artifact paths. The output directory
defaults to `/tmp/codex-console-capability-qa`, outside the repository.

Visual inspection confirmed typography and token consistency, wrapping and
focus visibility in both themes. Browser iterations corrected native dialog
insets/max-width, short-window footer clipping and unbounded selected labels.
The final browser result is `passed` with no console errors.

Physical mobile keyboards, Safari and live third-party plugin calls were not
exercised. The 375 × 480 case changes browser viewport height; it does not claim
to reproduce an operating-system keyboard or touch-device input method.
