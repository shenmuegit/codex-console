# Deployment and maintenance

[中文](zh-CN/deployment.md) · [README](../README.md) · [Configuration](configuration.md)

All commands in this guide run from the repository in Bash as your regular user. Install the desktop app first. For automatic system packages, the supported targets are Debian 12/13 and Ubuntu 22.04/24.04. Minimal systems need a normal user account, Bash, Git, and sudo; other Linux distributions can use an already-prepared runtime with `--skip-deps`.

## Desktop app compatibility

The default executable is `/usr/bin/chatgpt`. The integration relies on these properties:

- The application can run on X11 using `--ozone-platform=x11`.
- It accepts a dedicated `--user-data-dir` and/or `CODEX_ELECTRON_USER_DATA_PATH`.
- Its `WM_CLASS` is `"chatgpt (<absolute profile path>)", "Chatgpt"`.
- Re-running the executable with the same profile reopens its main window.
- Launch wrappers preserve process ownership with `exec`. Upload uses the app's GTK file picker; the launcher adds `--xdg-portal-required-version=999` to make Electron fall back to its native picker.

The executable path is configurable, but mobile layout and app recovery rely on the main-window identity above. Window filtering uses XRes to match the supervisor's app children. A different app class requires changes to main-window detection and HTML instance metadata; changing only the path does not provide arbitrary-app compatibility. If the app package is only available for a particular CPU architecture, use a host that architecture supports.

The desktop app must already be installed from a source you trust. This repository does not bundle it, license it, or automate its account login.

## One-command installation

```bash
git clone https://github.com/shenmuegit/codex-console.git
cd codex-console
./deploy.sh
```

For a different installation path:

```bash
./deploy.sh --app /absolute/path/to/chatgpt
```

Do not run the whole script with sudo: the service and profile belong to your normal user. The script invokes sudo for APT packages when needed. If the app is missing, it stops with an actionable error before package installation.

### What the installer changes

1. Creates `${XDG_CONFIG_HOME:-$HOME/.config}/codex-console/config.sh` with mode `600` if missing. An explicit `--app` updates only the application setting.
2. Checks the existing runtime. If it is incomplete or incompatible, installs dependencies on a supported APT host. It downloads the official repository definition and signing key using HTTPS, retains an existing key/source, and adds `codex-console-xpra.sources` only when no Xpra source is present.
3. Runs `doctor`, prepares the private state directory, and creates credentials and browser assets. Saved configuration, passwords, and profiles are retained; legacy certificates are removed only when TLS is not configured.
4. Generates `${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/codex-console.service` using the actual checkout, configuration, and state-home paths. Registers it by absolute path so the user manager can also find a custom configuration home. Keep the checkout and config directory in place while the service uses them.
5. Enables and starts the service, or restarts an active service. It requests user lingering for startup before login. If the system denies lingering, it prints the administrator command required.
6. Checks the local HTTP or configured HTTPS page for up to 30 seconds. This confirms the login page is served; sign-in and mobile interaction still require a browser. See [TLS configuration](configuration.md#http-and-https-access).

The dependency packages include Xpra, `xpra-html5`, Xvfb, X11 utilities, Xauth, PulseAudio, D-Bus, Python, OpenSSL, GStreamer tools/plugins, and Latin/CJK fonts. Installation explicitly includes APT recommendations for Xpra's X11/audio split packages, even on minimal hosts. Preflight checks verify those modules and browser audio encoders. The source follows the [official Xpra APT instructions](https://github.com/Xpra-org/xpra/wiki/Download#debian-based-distributions).

An existing incompatible Xpra repository is not overwritten. Review that source or install a supported version manually if APT keeps selecting an old release. Ubuntu minimal installations may need the `universe` component enabled to resolve multimedia dependencies; see the official guide.

### Installer options

| Command / option | Result |
| --- | --- |
| `./deploy.sh` or `./deploy.sh install` | Full installation and startup |
| `--app PATH` | Save the compatible app's executable path |
| `--skip-deps` | Skip APT operations; runtime checks still run |
| `--no-service` | Prepare/start manually without writing a service or changing lingering |
| `--no-start` | Prepare files without starting or restarting; a generated service is still enabled |
| `./deploy.sh uninstall` | Disable, stop, and remove the generated user service; retain data |
| `--help` | Show syntax |

Options can be combined. A preparation-only installation:

```bash
./deploy.sh --skip-deps --no-service --no-start
./console.sh doctor
./console.sh start
```

Preparation regenerates browser assets. If a session is already running, `--no-start` leaves its processes running; restart later to apply launch settings.

## Manual runtime setup

On an unsupported host, install Xpra and its HTML5 client through the [official installation guide](https://github.com/Xpra-org/xpra/wiki/Download). Ensure Xpra is at least 6.5 and below 7.0, and provide the runtime tools listed above. The tested combination is Xpra `6.5.4` with `xpra-html5 19-r1`; the preflight check also validates required page hooks.

Then:

```bash
./deploy.sh --skip-deps --no-service --no-start --app /absolute/path/to/chatgpt
./console.sh doctor
./console.sh start
./console.sh status
```

`start` daemonizes; `run` stays in the foreground for troubleshooting or an external supervisor. `stop` terminates the configured Xpra session and its children. Manage a systemd installation with `systemctl --user`; starting it manually while the service manages the same display creates a conflict.

## Service and boot startup

```bash
systemctl --user status codex-console.service
systemctl --user restart codex-console.service
systemctl --user stop codex-console.service
systemctl --user disable codex-console.service
journalctl --user -u codex-console.service -n 100 --no-pager
```

The service uses foreground mode and restarts after the Xpra process exits. The app watcher reopens a missing main window, so closing that window does not stop the console. Use the service stop command to stop it.

Check boot behavior:

```bash
systemctl --user is-enabled codex-console.service
loginctl show-user "$(id -un)" -p Linger
```

If necessary, enable startup before login:

```bash
sudo loginctl enable-linger "$(id -un)"
```

After `--no-start`, explicitly start the prepared service with `systemctl --user start codex-console.service`. The included `.service` file is a template; use the installer to render it rather than copying it directly.

## Updating and moving the checkout

Back up data first. From a clean checkout:

```bash
git pull --ff-only
./deploy.sh --skip-deps
```

Use `./deploy.sh` without `--skip-deps` when runtime dependencies also need installation. If Git reports local changes or diverged history, resolve those before updating; the script does not reset your repository. For reproducible operation, keep the tested Xpra/HTML5 versions until you have run the upgrade checks in [Development](development.md).

Before moving the checkout, stop the service. Move the directory, then rerun deployment from its new location. The installer refreshes service paths and asset symlinks without replacing the profile. To roll back, stop the service, check out a previously tested commit or tag from a clean repository, and rerun deployment.

## Backup and restore

Backups contain credentials and account data. Store them privately. To capture a consistent service installation, stop it first, then load the same configuration the scripts use:

```bash
systemctl --user stop codex-console.service
source ./lib/config.sh
console_load_config
console_validate_config
backup_dir="$HOME/codex-console-backup-$(date +%Y%m%d-%H%M%S)"
mkdir -m 700 "$backup_dir"
umask 077
cp "$CONSOLE_CONFIG" "$backup_dir/config.sh"
tar -C "$CONSOLE_STATE_DIR" --exclude='./pulse-runtime' -czf "$backup_dir/state.tar.gz" .
systemctl --user start codex-console.service
```

For a manual session, substitute `./console.sh stop` and `./console.sh start`. To restore on a prepared host, set `backup_dir` to your saved directory, copy its config to the configuration location, adjust machine-specific app/data paths, load the config as above, and extract `state.tar.gz` into `CONSOLE_STATE_DIR` while the service is stopped. Restore only your own trusted archive. Set the state directory to `700`, the password to `600`, and rerun `./deploy.sh --skip-deps` to rebuild browser assets and the service.

The complete state includes `profile/` and `password`. Back up configured TLS certificates, private keys, and renewal settings separately when stored outside this directory. Generated `www/`, lock files, audio runtime files, and logs can be rebuilt and do not need to be restored.

## Uninstall

```bash
./deploy.sh uninstall
```

Use the same `XDG_CONFIG_HOME` as installation. This removes the generated user service and its registration links. Configuration, application data, the checkout, system packages, the Xpra APT source, and lingering are retained. A manually started session must be stopped with `./console.sh stop`.

After backing up anything you need, you may remove your configuration/state directories and checkout yourself. Do not disable lingering if other user services rely on it. System packages are shared with other applications; remove them through your package manager only if no longer needed.
