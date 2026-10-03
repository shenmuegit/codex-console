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
  <img alt="HTTPS and WSS" src="https://img.shields.io/badge/Transport-HTTPS%20%2F%20WSS-24292f?style=flat-square" />
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-24292f?style=flat-square" /></a>
</p>

Codex Console streams a dedicated Codex / ChatGPT desktop app window from a Linux host through [Xpra](https://github.com/Xpra-org/xpra). Read tasks, enter instructions with your phone's input method, and control the app from a browser. Projects, computation, account sessions, and application processes stay on the host.

This repository provides the remote access layer. You must install a compatible Linux desktop app separately; the installer does not download the app or sign in to an account. The browser interface currently uses Simplified Chinese.

## Features

| Capability | Behavior |
| --- | --- |
| Mobile layout | Adapts to the visible browser area, orientation, and on-screen keyboard |
| Touch gestures | Tap, drag, double-tap for right-click, and tap-then-hold to scroll |
| Native text input | Compose locally with your phone's IME and paste committed text into the app |
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

The installer reuses an existing compatible runtime or installs the missing packages through the official Xpra APT repository. It creates a private configuration file, generates a random browser access password and self-signed TLS certificate, installs a service with your actual checkout path, enables it, and waits for the HTTPS page to respond. Review [what installation changes](docs/deployment.md#what-the-installer-changes).

Read the password on the host:

```bash
./console.sh password
```

Open `https://HOST_IP:15443/` in your browser and replace `HOST_IP` with the Linux host's address. Enter the access password, then sign in to the remote desktop app on first use. These are separate authentication steps. The dedicated profile may require a new app sign-in.

The generated certificate is self-signed, so the browser displays a trust warning. See [TLS setup](docs/configuration.md#tls-certificates) to add your access address to the certificate or install a trusted certificate. Keep access limited to a trusted network or VPN: anyone with the password can control the app with your host account's permissions.

## Everyday commands

```bash
./console.sh doctor                                # Check runtime and configuration
./console.sh status                                # Inspect the Xpra session
systemctl --user status codex-console.service      # Inspect the user service
systemctl --user restart codex-console.service     # Apply configuration changes
systemctl --user stop codex-console.service        # Stop the managed console
journalctl --user -u codex-console.service -n 100   # Read service logs
```

For manual operation, use `./deploy.sh --no-service --no-start`, then `./console.sh start` and `./console.sh stop`. Repeated installation retains existing configuration, credentials, certificates, and application data. A normal reinstall restarts the managed service; `--no-start` prepares changes without starting or restarting it.

## Mobile controls

| Action | Gesture |
| --- | --- |
| Left-click | Tap once |
| Drag / select | Touch and slide |
| Right-click | Quickly tap twice in the same place |
| Scroll | Tap, then touch again and slide while keeping the second touch held |
| Keyboard | Focus a remote text field, then open the keyboard button in the top-right drawer |
| Fullscreen / audio | Open the right-edge drawer and use the matching control |

Double-tap recognition uses a roughly 180 ms interval. A single touch-and-slide drags. Compose text using your phone's input method; committed text is sent through the remote clipboard and paste shortcut. The remote field must have focus and the Xpra clipboard must remain enabled. Committing text replaces the remote clipboard contents.

Choose **流畅** (Smooth), **均衡** (Balanced), or **高清** (Sharp) in the quality menu, or use `?performance=smooth`, `?performance=balanced`, or `?performance=sharp` in the URL. Balanced is the default. Audio playback may require a user gesture to satisfy browser permissions.

## Documentation

| Guide | Contents |
| --- | --- |
| [Deployment](docs/deployment.md) | Supported hosts, installer options, manual setup, boot startup, updates, backups, uninstall |
| [Configuration](docs/configuration.md) | Configuration file, every supported setting, paths, TLS, passwords, network binding |
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
