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
| `CONSOLE_HOST` | `0.0.0.0` | IPv4 address or hostname for the browser listener |
| `CONSOLE_PORT` | `15443` | TCP port, integer `1024`–`65535` |
| `CONSOLE_DISPLAY` | `:100` | Dedicated X11 display; must not conflict with another session |
| `CONSOLE_STATE_DIR` | `${XDG_STATE_HOME:-$HOME/.local/state}/codex-console` | Password, profile, generated pages, logs |
| `XPRA_HTML_DIR` | `/usr/share/xpra/www` | System-installed Xpra HTML5 assets |
| `CONSOLE_TLS_CERT` | Empty | Readable absolute path to a PEM certificate/full chain; enables HTTPS/WSS with the key |
| `CONSOLE_TLS_KEY` | Empty | Readable absolute path to the matching PEM private key |
| `CONSOLE_CONFIG` | `${XDG_CONFIG_HOME:-$HOME/.config}/codex-console/config.sh` | Entry-point environment selector for the config file |

`0.0.0.0` listens on all IPv4 interfaces; use `127.0.0.1` for local-only access or a specific LAN interface address. The current listener configuration does not accept IPv6 bind addresses.

The service captures the selected config path and `XDG_STATE_HOME` when deployed. Put persistent settings in the configuration file: shell-only environment overrides are not automatically carried into the service.

Example configuration:

```bash
CONSOLE_APP_BIN='/opt/desktop app/chatgpt'
CONSOLE_APP_ARGS=(--ozone-platform=x11 --disable-gpu)
CONSOLE_HOST=192.0.2.10
CONSOLE_PORT=15443
CONSOLE_DISPLAY=:100
```

Replace the documentation address `192.0.2.10` with an address assigned to your host. The launcher adds `--user-data-dir=<state>/profile` automatically. Keep the X11 argument unless your compatible build selects X11 another way. Arguments are quoted individually; do not insert shell commands or combine all flags into one array element.

If you need a proxy, configure it in `CONSOLE_APP_ARGS` in the user configuration file, or in the desktop app's own network settings.

## Data layout

| Path under the state directory | Purpose |
| --- | --- |
| `password` | Random browser access password |
| `profile/` | Application settings, sign-in information, session data |
| `www/` | Generated/adapted HTML5 entry and links to installed assets |
| `xpra.log` | Xpra session log |
| `app-watch.lock` | Prevents duplicate app supervisors |
| `pulse-runtime/` | Private PulseAudio runtime/PID files, recreated on launch |

The state directory has mode `700`; the password has mode `600`. The launcher exports `CODEX_ELECTRON_USER_DATA_PATH=<state>/profile` to the app. Browser passwords remain in page memory for reconnects and are requested again after reloading or closing the page.

Each configured state directory has its own profile. For multiple installations, use distinct config paths, state directories, ports, and displays. The installer manages one unit named `codex-console.service` per user; independently supervised instances require separately named units or manual operation.

## HTTP and HTTPS access

By default, open `http://HOST_IP:15443/` using the configured host and port. Pages use HTTP and the password-authenticated session uses WS. Preparation removes legacy `cert.pem` and `key.pem` files only in this default mode. Passwords and app profiles are retained.

HTTP provides no transport encryption; use a trusted network or VPN.

To enable Xpra's native HTTPS/WSS listener on the same port, set both paths in your configuration:

```bash
CONSOLE_TLS_CERT=/absolute/path/to/fullchain.pem
CONSOLE_TLS_KEY=/absolute/path/to/privkey.pem
```

Use a certificate trusted by the browser for the hostname you visit, keep the key private, and restart the service. Open `https://YOUR_HOSTNAME:15443/`; HTTP/WS is replaced by HTTPS/WSS. The launcher retains configured certificates and never generates an identity automatically. Paths must contain no commas or line breaks.

The supported HTML5 client's [Chrome offscreen/video decoder](https://github.com/Xpra-org/xpra-html5/blob/master/html5/js/OffscreenDecodeWorkerHelper.js) requires HTTPS. Browser codec support still determines the decoder; HTTPS alone does not guarantee H.264 or hardware acceleration, and Safari may use the fallback path.

The last quality preset is saved in this browser for this server address and restored when reopening the page. An explicit `performance` URL parameter takes priority. Without either choice, phones default to Smooth and desktops to Balanced.

### Public IP certificates

Let’s Encrypt supports [public IP certificates with the `shortlived` profile](https://letsencrypt.org/2026/03/11/shorter-certs-certbot). Use Certbot 5.4 or newer. HTTP-01 validation must reach this server on public TCP port **80**, even when the console listens on 15443; changing Certbot's local challenge port does not change the CA's port.

A standalone issuance command, with private account/certificate files outside the repository:

```bash
certbot certonly --standalone --ip-address YOUR_PUBLIC_IP \
  --cert-name codex-console --required-profile shortlived \
  --non-interactive --agree-tos --register-unsafely-without-email \
  --keep-until-expiring \
  --config-dir "$HOME/.local/state/codex-console/tls/acme" \
  --work-dir "$HOME/.local/state/codex-console/tls/work" \
  --logs-dir "$HOME/.local/state/codex-console/tls/logs"
```

Port 80 requires administrator assistance. A systemd **system** service can run Certbot as the console user with `AmbientCapabilities=CAP_NET_BIND_SERVICE`, `CapabilityBoundingSet=CAP_NET_BIND_SERVICE`, and `UMask=0077`; this keeps certificates readable by the console without running the app as root. Keep the certificate directories private (`700`) and the key private (`600`).

After issuance, set the two TLS paths to `tls/acme/live/codex-console/fullchain.pem` and `privkey.pem` under the private state directory, then restart the user service. Validate trust and the IP SAN with `openssl verify -verify_ip YOUR_PUBLIC_IP -untrusted fullchain.pem fullchain.pem`, and check `https://YOUR_PUBLIC_IP:15443/` without disabling certificate verification.

IP certificates last about six days. Run the same `--keep-until-expiring` command from a persistent system timer every eight hours (`OnCalendar=*-*-* 00,08,16:00:00`). Use a successful-issuance deploy hook to restart `codex-console.service`; set `XDG_RUNTIME_DIR=/run/user/UID` and `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/UID/bus` for that user's manager. If binding or validation fails, keep the existing console configuration and inspect the certificate service log before enabling HTTPS. Certificate renewal and activation must both succeed before reporting the deployment complete.

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
