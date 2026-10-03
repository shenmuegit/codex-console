# Configuration reference

[中文](zh-CN/configuration.md) · [README](../README.md) · [Deployment](deployment.md)

## Configuration file

`deploy.sh` copies [config.example.sh](../config.example.sh) to `${XDG_CONFIG_HOME:-$HOME/.config}/codex-console/config.sh` on the first installation. This Bash file is private to your user and remains outside Git. Edit it in your text editor; do not edit the launch script for normal configuration.

Both entry scripts use `CONSOLE_CONFIG` to select another **absolute** configuration path:

```bash
CONSOLE_CONFIG="$HOME/.config/codex-console/lab.sh" ./deploy.sh --skip-deps
CONSOLE_CONFIG="$HOME/.config/codex-console/lab.sh" ./console.sh doctor
```

Create the custom file first or let the installer create it. An explicitly selected missing file is an error in `console.sh`. When no default file exists, `console.sh` uses built-in defaults.

Configuration assignments take precedence over environment variables; environment values supply settings the file leaves unset, then built-in defaults fill the remainder. `CONSOLE_APP_ARGS` must be a Bash indexed array and cannot be supplied as a single environment string. The configuration is sourced as Bash, so use only a file you trust. Paths must be absolute, without commas or line breaks.

After edits, check and restart:

```bash
./console.sh doctor
systemctl --user restart codex-console.service
```

For manual operation, stop and start instead. Keep the data directory unchanged to retain login information. If you change the display while a manual session is running, stop it using the old configuration first.

## Supported settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `CONSOLE_APP_BIN` | `/usr/bin/chatgpt` | Compatible desktop executable; prefer an absolute path |
| `CONSOLE_APP_ARGS` | `(--ozone-platform=x11 --disable-gpu)` | Additional app arguments as a Bash array |
| `CONSOLE_HOST` | `0.0.0.0` | IPv4 address or hostname for the HTTPS/WSS listener |
| `CONSOLE_PORT` | `15443` | TCP port, integer `1024`–`65535` |
| `CONSOLE_DISPLAY` | `:100` | Dedicated X11 display; must not conflict with another session |
| `CONSOLE_STATE_DIR` | `${XDG_STATE_HOME:-$HOME/.local/state}/codex-console` | Password, TLS files, profile, generated pages, logs |
| `XPRA_HTML_DIR` | `/usr/share/xpra/www` | System-installed Xpra HTML5 assets |
| `CONSOLE_TLS_NAME` | `localhost` | DNS name/IP added to a newly generated certificate |
| `CONSOLE_CONFIG` | `${XDG_CONFIG_HOME:-$HOME/.config}/codex-console/config.sh` | Entry-point environment selector for the config file |

`0.0.0.0` listens on all IPv4 interfaces; use `127.0.0.1` for local-only access or a specific LAN interface address. The current listener configuration does not accept IPv6 bind addresses. Certificate names may include an IPv6 address, but that does not enable an IPv6 listener.

The service captures the selected config path and `XDG_STATE_HOME` when deployed. Put persistent settings in the configuration file: shell-only environment overrides are not automatically carried into the service.

Example configuration:

```bash
CONSOLE_APP_BIN='/opt/desktop app/chatgpt'
CONSOLE_APP_ARGS=(--ozone-platform=x11 --disable-gpu)
CONSOLE_HOST=192.0.2.10
CONSOLE_PORT=15443
CONSOLE_DISPLAY=:100
CONSOLE_TLS_NAME=192.0.2.10
```

Replace the documentation address `192.0.2.10` with an address assigned to your host. The launcher adds `--user-data-dir=<state>/profile` automatically. Keep the X11 argument unless your compatible build selects X11 another way. Arguments are quoted individually; do not insert shell commands or combine all flags into one array element.

If you need a proxy, configure it in `CONSOLE_APP_ARGS` in the user configuration file, or in the desktop app's own network settings.

## Data layout

| Path under the state directory | Purpose |
| --- | --- |
| `password` | Random browser access password |
| `cert.pem` / `key.pem` | TLS certificate and private key |
| `profile/` | Application settings, sign-in information, session data |
| `www/` | Generated/adapted HTML5 entry and links to installed assets |
| `xpra.log` | Xpra session log |
| `app-watch.lock` | Prevents duplicate app supervisors |
| `pulse-runtime/` | Private PulseAudio runtime/PID files, recreated on launch |

The state directory has mode `700`; password, certificate, and key have mode `600`. The launcher exports `CODEX_ELECTRON_USER_DATA_PATH=<state>/profile` to the app. Browser passwords remain in page memory for reconnects and are requested again after reloading or closing the page.

Each configured state directory has its own profile. For multiple installations, use distinct config paths, state directories, ports, and displays. The installer manages one unit named `codex-console.service` per user; independently supervised instances require separately named units or manual operation.

## TLS certificates

On the first preparation, the launcher generates a 2048-bit RSA self-signed certificate valid for 365 days. It includes `localhost`, `127.0.0.1`, and `CONSOLE_TLS_NAME` in its subject alternative names. Self-signed certificates still require browser trust even when the hostname matches.

Set `CONSOLE_TLS_NAME` before first deployment to include your host's IP or DNS name. Existing certificates are reused, so changing that setting does not renew them.

For a trusted certificate, stop the service and install a certificate chain and its matching unencrypted private key at the state's `cert.pem` and `key.pem` paths. For example, after loading the config:

```bash
source ./lib/config.sh
console_load_config
console_validate_config
systemctl --user stop codex-console.service
install -m 600 /path/to/fullchain.pem "$CONSOLE_STATE_DIR/cert.pem"
install -m 600 /path/to/privkey.pem "$CONSOLE_STATE_DIR/key.pem"
systemctl --user start codex-console.service
```

Use certificate files your service user can read. Manage renewal separately and restart the service after replacing the pair. The installer does not obtain or renew public certificates. If only one nonempty TLS file exists, preparation fails instead of overwriting the remaining identity.

To renew a self-signed certificate, stop the service, move **both** existing TLS files to a private backup directory, update `CONSOLE_TLS_NAME`, run `./console.sh prepare`, and start the service. Inspect expiry with:

```bash
openssl x509 -in "$CONSOLE_STATE_DIR/cert.pem" -noout -dates -ext subjectAltName
```

## Access password

View it with `./console.sh password`. To rotate it, stop the session and write a fresh random value into the existing file:

```bash
source ./lib/config.sh
console_load_config
console_validate_config
systemctl --user stop codex-console.service
umask 077
openssl rand -hex 24 | tr -d '\n' > "$CONSOLE_STATE_DIR/password"
chmod 600 "$CONSOLE_STATE_DIR/password"
systemctl --user start codex-console.service
```

Reconnect using the new password. Rotation stops existing connections when the service restarts. Never place the password in a URL or public log. This password controls browser access; it does not change the app account password.
