<p align="center">
  <img src="assets/codex-console-icon.png" width="128" height="128" alt="Codex Console" />
</p>

<h1 align="center">Codex Console</h1>
<p align="center"><strong>Your Codex workspace, in your mobile browser.</strong></p>
<p align="center">
  <a href="README.zh-CN.md">简体中文</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#documentation">Documentation</a> ·
  <a href="https://github.com/shenmuegit/codex-console/issues">Issues</a>
</p>
<p align="center">
  <img alt="Host: Linux" src="https://img.shields.io/badge/Host-Linux-24292f?style=flat-square" />
  <img alt="HTTP and WS" src="https://img.shields.io/badge/Transport-HTTP%20%2F%20WS-24292f?style=flat-square" />
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-24292f?style=flat-square" /></a>
</p>

Codex Console streams a dedicated Codex / ChatGPT desktop app window from a Linux host through [Xpra](https://github.com/Xpra-org/xpra). Read tasks, enter instructions with your phone's input method, and control the app from a browser. Projects, computation, account sessions, and application processes stay on the host.

This repository provides the remote access layer. You must install a compatible Linux desktop app separately; the installer does not download the app or sign in to an account. The browser interface currently uses Simplified Chinese.

## Features

| Capability | Behavior |
| --- | --- |
| Mobile layout | Adapts to the visible browser area, orientation, and on-screen keyboard |
| Touch gestures | Immediate taps, drag, two-finger right-click, and two-finger scrolling |
| Native text input | Compose locally with your phone's IME and paste committed text into the app |
| File upload | Open Codex's native attachment picker, then select a file from your phone or computer |
| Quality profiles | Smooth, Balanced, and Sharp; the selected profile is retained in the page URL |
| Audio | Host application audio plays in the browser; microphone forwarding is disabled |
| Dedicated profile | Separate application settings and sign-in data; unrelated windows are filtered out |
| App recovery | Reopens the main window after it is closed and restarts an exited app |
| One-command deployment | Checks dependencies, prepares credentials, and installs a user service |

## Requirements

| Item | Requirement |
| --- | --- |
| Host | Linux; automatic dependencies support Debian 12/13 and Ubuntu 22.04/24.04 |
| User | Regular user with `sudo` for missing system packages; systemd user session for automatic startup |
| Desktop app | Compatible Linux / X11 Codex / ChatGPT build, default `/usr/bin/chatgpt` |
| Runtime | Bash, Python 3.10+, OpenSSL, Xpra 6.5+ within the 6.x series, Xvfb, PulseAudio |
| HTML5 client | Tested baseline: `xpra-html5 19-r1` at `/usr/share/xpra/www` |
| Browser | Modern mobile or desktop browser with JavaScript and WebSocket support |
| Access | Browser can reach the host on TCP `15443` by default |

The development host runs Debian 13, Xpra `6.5.4`, and `xpra-html5 19-r1`. Other listed systems have installer support; they are not all covered by local live testing. Windows and macOS can be browser clients. Native hosting on those systems is outside the current installer.

The app integration currently expects the window class `Chatgpt` and the instance `chatgpt (<profile path>)`. Changing the executable path supports alternate installations of that compatible app. See [compatibility details](docs/deployment.md#desktop-app-compatibility) before using a different build.

## Quick start

Install your desktop app and Git first, then run as your regular user:

```bash
git clone https://github.com/shenmuegit/codex-console.git
cd codex-console
./deploy.sh
```

If your app is installed elsewhere:

```bash
./deploy.sh --app /absolute/path/to/chatgpt
```

The installer reuses an existing compatible runtime or installs the missing packages through the official Xpra APT repository. It creates a private configuration file, generates a random browser access password, installs a service with your actual checkout path, enables it, and waits for the HTTP page to respond. Review [what installation changes](docs/deployment.md#what-the-installer-changes).

Read the password on the host:

```bash
./console.sh password
```

Open `http://HOST_IP:15443/` in your browser and replace `HOST_IP` with the Linux host's address. Enter the access password, then sign in to the remote desktop app on first use. These are separate authentication steps. The dedicated profile may require a new app sign-in.

The console defaults to HTTP/WS without transport encryption. Configure a browser-trusted certificate and key for [native HTTPS/WSS](docs/configuration.md#http-and-https-access). Keep access limited to a trusted network or VPN: anyone with the password can control the app with your host account's permissions.

## Everyday commands

```bash
./console.sh doctor                                # Check runtime and configuration
./console.sh status                                # Inspect the Xpra session
systemctl --user status codex-console.service      # Inspect the user service
systemctl --user restart codex-console.service     # Apply configuration changes
systemctl --user stop codex-console.service        # Stop the managed console
journalctl --user -u codex-console.service -n 100   # Read service logs
```

For manual operation, use `./deploy.sh --no-service --no-start`, then `./console.sh start` and `./console.sh stop`. Repeated installation retains existing configuration, credentials, and application data. A normal reinstall restarts the managed service; `--no-start` prepares changes without starting or restarting it.

Only the custom Codex Console page is published. Upstream connection and diagnostic pages such as `connect.html`, including their compressed copies, return 404. Preparing assets also removes copies left by earlier deployments.

## Mobile controls

| Action | Gesture |
| --- | --- |
| Left-click | Tap once |
| Drag / select | Touch and slide |
| Right-click | Tap with two fingers together |
| Scroll | Slide with two fingers together |
| Keyboard | Focus a remote text field, then open the keyboard button in the top-right drawer |
| Fullscreen / audio | Open the right-edge drawer and use the matching control |

Single taps send when the finger lifts; consecutive one-finger taps stay left-clicks. A single touch-and-slide drags. Compose text using your phone's input method; committed text is sent through the remote clipboard and paste shortcut. The remote field must have focus and the Xpra clipboard must remain enabled. Committing text replaces the remote clipboard contents. Text pastes start immediately; consecutive pastes retain a 100 ms clipboard guard. Over HTTPS, input commits and uploads reuse their prepared clipboard contents so the device clipboard cannot substitute older text.

Choose **流畅** (Smooth), **均衡** (Balanced), or **高清** (Sharp) in the quality menu, or use `?performance=smooth`, `?performance=balanced`, or `?performance=sharp` in the URL. Balanced is the default. Audio playback may require a user gesture to satisfy browser permissions.

## Documentation

To upload, first click the attachment/upload action in the remote Codex composer. A browser upload dialog covers the Linux directory picker. Choose **选择图片** for photos, or **选择文件** for the device's general file picker. The file entry requests generic files without adding camera or video capture options in Chromium. The completed upload is passed to the original picker so Codex can add the attachment. Confirm it appears in the composer before sending. **取消添加** closes Codex's picker; disconnection or changing picker focus stops automatic attachment. Login and reconnect cancel leftover pickers; only a new upload action opens the browser dialog. If the phone reports neither a selection nor cancellation, tap the file control again to retry.

Uploads accept one file at a time, up to 32 MiB or the server limit, whichever is smaller. Unicode and spaces are supported; empty files, control characters, and filenames longer than 185 UTF-8 bytes are rejected. Files remain under the private state directory's `uploads/` so Codex can read them later; remove them when no longer needed. Restart the service and reload the browser after updating.

| Guide | Contents |
| --- | --- |
| [Deployment](docs/deployment.md) | Supported hosts, installer options, manual setup, boot startup, updates, backups, uninstall |
| [Configuration](docs/configuration.md) | Configuration file, every supported setting, paths, HTTP/HTTPS, passwords, network binding |
| [Troubleshooting](docs/troubleshooting.md) | Dependency, startup, authentication, window, input, audio, and performance problems |
| [Development](docs/development.md) | Components, tests, live checks, Xpra upgrade checks, release steps |
| [Contributing](CONTRIBUTING.md) | Local workflow, bug reports, pull requests |
| [Security](SECURITY.md) | Access boundaries, sensitive data, private vulnerability reporting |
| [Changelog](CHANGELOG.md) | Changes awaiting release |

Local configuration is stored at `~/.config/codex-console/config.sh`; application data defaults to `~/.local/state/codex-console`. Both follow the corresponding XDG environment variables. Keep passwords, private keys, profile data, and personal configuration outside the repository.

## Development

With the runtime installed and Node.js 20+ available:

```bash
./scripts/check.sh           # Isolated checks; does not start your desktop app
./scripts/check.sh --live    # Also checks an already-running console and plays a test tone
```

The live check requires a running session and GStreamer audio plugins. Read [the development guide](docs/development.md) before running it against a session in use.

## License and acknowledgements

Project code and included artwork are provided under the [MIT License](LICENSE). Xpra, its HTML5 client, and the desktop app are separate projects with their own licenses. Xpra HTML5 assets are linked from your system installation and adapted in the private runtime directory; they are not vendored into this repository.

This is an independent project and is not an official OpenAI product.
