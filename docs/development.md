# Development and verification

[README](../README.md) · [Contributing](../CONTRIBUTING.md)

## Components

```mermaid
flowchart LR
    Browser["Browser<br/>Xpra HTML5 + mobile.js + console.css"]
    Server["Linux host<br/>Xpra HTTP / WS session"]
    Watch["app-watch.sh"]
    App["Dedicated desktop app profile"]
    Browser <-->|"Password-authenticated WS"| Server
    Server -->|"Starts on Xvfb"| Watch
    Watch -->|"Reopens missing main window"| App
    Server <-->|"X11 window / input / audio"| App
```

| File | Responsibility |
| --- | --- |
| `deploy.sh` | Dependency installation, user config, service generation, readiness check, uninstall |
| `lib/config.sh` | Configuration defaults, validation, read-only preflight |
| `console.sh` | Credentials, HTML5 adaptation, Xpra launch and session commands |
| `app-watch.sh` | Single supervisor lock, dedicated-window filter, app recovery and cleanup |
| `mobile.js` | Touch, native IME, scaling, quality, authentication/reconnect behavior |
| `upload.py` | Completed-upload validation, original filename and targeted browser callback |
| `keyboard.py` | Loopback CDP DOM hit regions and focus, delivered through Xpra notifications |
| `console.css` | Login, connection, and toolbar layout |
| `codex-console.service` | User-service template rendered by deployment |
| `scripts/check.sh` | Standard isolated checks and optional live endpoint verification |
| `tests/` | Desktop transport tests, with native Web client tests and fixtures in `tests/web/` |

There is no Node build or package installation for the frontend. The browser runs `mobile.js` directly against the system Xpra HTML5 client. The adapted HTML/Client.js are generated in the private state directory. Only the adapted index page is published; upstream HTML pages and their compressed copies are excluded and cleaned up on upgrades. Host-installed upstream assets remain untouched. The launcher includes a content-derived cache version in the page.

## Local checks

Install the normal runtime and Node.js 20+; Python must be able to import the installed Xpra modules. Prefer the OS Python used by your Xpra packages instead of an isolated interpreter missing those modules.

```bash
./scripts/check.sh
```

All tests and fixtures live under `tests/`. For the native Web client suite, use Node.js 24+ and run `npm --prefix web ci` followed by `npm --prefix web test` from the repository root. Individual Web tests use `node --test tests/web/<name>.test.mjs`.

| Check | Coverage |
| --- | --- |
| Bash syntax | All shell entry points and config example |
| `tests/test_startup.py` | Foreground service launch vs daemonized manual launch |
| `tests/test_deploy.py` | Config validation, argument quoting, alternate state/port/display, HTTP startup, configured TLS and certificate preservation, service rendering, repeat install, dependency installation boundary, relocation, uninstall |
| `tests/test_app_watch.py` | Reopening closed/exited app, avoiding duplicates, excluding foreign profiles, cleaning up children |
| `tests/test_mobile.cjs` | Browser authentication, retry/reconnect, gestures, scaling, quality, IME and UTF-8 clipboard behavior |
| `tests/test_upload.py` | Real Xpra save completion, private original filenames, request and client isolation |

Isolated tests use temporary directories and controlled command boundaries. They do not install packages or modify your user service, and they do not start your desktop app. They still load the real installed Xpra client code and selected server modules. The watcher test takes roughly 20 seconds because it exercises the actual recovery intervals.

## Temporary integration session

Use the runtime's GTK 3 Python bindings, then run:

```bash
python3 tests/test_integration.py
CONSOLE_TEST_TLS=1 python3 tests/test_integration.py
```

This runs the real one-command deployment in manual mode with a temporary config, state directory, local port, and unused X11 display. A GTK fixture supplies the app identity, text field, and native file picker without a profile class or transient parent. It verifies HTTP, correct and rejected passwords, window isolation, decoded WS audio, uploads, immediate Unicode clipboard/key packets, and sequential text commits followed by Enter. The TLS variant generates a temporary identity, explicitly trusts it for the test, and checks HTTPS/WSS. Both stop their sessions and use no desktop-app account or service; compatibility with a particular app build still needs that app.

With the installed Electron app and Node.js 22+, run `node tests/test_keyboard.cjs` to check the DOM keyboard bridge in a disposable Xvfb/profile. It covers editable fields, readonly/disabled controls, noneditable children, composer padding/buttons, clipping, overlays, focus and streaming updates without using an account. `CONSOLE_TEST_DPR=1.5 node tests/test_keyboard.cjs` also checks fractional-DPI native coordinates and scrollbars. `CONSOLE_TEST_APP_BIN` overrides the test executable.

The supervisor starts `keyboard.py` beside the app. Electron's `--remote-debugging-port=0` publishes an ephemeral port in the private profile's `DevToolsActivePort`; the endpoint stays on `127.0.0.1` and must not be exposed publicly. The probe uses native mouse-pixel `elementFromPoint` tests, sends geometry/focus only, and resynchronizes after navigation or reconnect. Web clients focus the existing IME receiver synchronously in the editable tap gesture. Stale or mismatched window geometry is ignored; the manual keyboard button remains available for unsupported/custom editors and large regions above the one-million-pixel scan limit. Restart the console and reload the Web page after installing this change. A real phone is still needed to verify its OS keyboard and input method.

## Existing-app live check

After starting a compatible app session:

```bash
./scripts/check.sh --live
```

This uses the selected configuration, attaches additional Xpra clients, and plays a brief 440 Hz test tone into the session's audio server. Use a session where that interaction is acceptable. The live check requires `xrdb`, `xdpyinfo`, `gst-launch-1.0`, and GStreamer Opus/WebM/AAC plugins in addition to the normal runtime. It verifies the actual app's forwarded windows, audio codecs, display bounds, private file permissions, and authentication behavior.

## Upgrading Xpra or the HTML5 client

The supported baseline is Xpra `6.5.4` and HTML5 `19-r1`. Required upstream page hooks are checked before preparation; this is not a guarantee of compatibility with every client release.

Before adopting another release:

1. Prepare a separate test config, state, display, and port; retain a package rollback path.
2. Run `doctor`, isolated checks, and the temporary integration session.
3. Check touch gestures, composition/candidate selection, paste, portrait/landscape behavior, and on-screen keyboard movement in a real mobile browser.
4. Check password entry, rejected passwords, disconnect/reconnect, drawer toggles, quality profiles, fullscreen, and audio.
5. Verify only the intended profile is forwarded and that closing/reopening the app still works.
6. Record the tested app/browser/package versions before changing the documented baseline or preflight rules.

## Local checks and release preparation

This repository does not include GitHub Actions workflows. Pushes and pull requests do not start repository-defined automatic checks. Run the applicable checks locally before a release.

For a release, run the checks on the supported runtime, confirm both README languages and linked guides match the script behavior, review the diff for private data, move relevant `Unreleased` entries into a versioned changelog section, and create the corresponding tag/release. Published tags should identify the exact source commit.
