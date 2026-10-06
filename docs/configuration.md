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

## Automatic congestion feedback

The launcher enables Xpra's bandwidth detection, and the browser requests the bandwidth management module during authentication. Slow draw acknowledgments can then reduce the window's bandwidth budget; the budget can recover when congestion clears. This is separate from the Smooth/Balanced/Sharp quality choice and does not impose a fixed global bitrate.

`XPRA_MIN_BANDWIDTH` defaults to `524288` bits per second (about 0.52 Mbps), so Xpra's automatic detection can operate below its upstream 5 Mi bit/s floor. To override that floor, set `XPRA_MIN_BANDWIDTH=1048576` in your private Bash configuration; the launcher exports it to Xpra. Restart the service after updating the launcher, and refresh the browser to use the new handshake. Use the [client network diagnostics](troubleshooting.md#client-network-diagnostics) to verify RTT and actual image traffic; automatic feedback cannot remove propagation delay or repair packet loss.

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

### HTTPS using only port 15443

Xpra serves HTTPS and WSS directly on `CONSOLE_PORT=15443`; it needs no reverse proxy or privileged listener. For a public IP, Let's Encrypt's [HTTP-01 and TLS-ALPN-01 challenges](https://letsencrypt.org/docs/challenge-types/) require inbound port 80 or 443 respectively. DNS-01 cannot validate an IP address. Changing a local challenge port to 15443 does not change the CA's validation port.

When both validation ports must remain unused, use a local CA and install its public certificate on each client device. This encrypts the connection, but browsers trust it only after that installation. A domain you control can instead use DNS-01 for a publicly trusted certificate without opening either validation port; visit that domain on port 15443.

Create the local CA once, outside Git. Replace the example IP with the address you visit. These commands are for a new certificate directory; retain the CA and its key for subsequent server-certificate renewals.

```bash
umask 077
tls="${CONSOLE_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/codex-console}/tls/local"
public_ip=192.0.2.10
mkdir -p "$tls"
chmod 700 "$tls"
openssl req -x509 -newkey rsa:3072 -nodes -sha256 -days 3650 \
  -subj '/CN=Codex Console Local CA' \
  -addext 'basicConstraints=critical,CA:TRUE,pathlen:0' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign' \
  -keyout "$tls/ca-key.pem" -out "$tls/ca.crt"
openssl req -new -newkey rsa:2048 -nodes -sha256 \
  -subj "/CN=$public_ip" -keyout "$tls/server-key.pem" -out "$tls/server.csr"
cat > "$tls/server.ext" <<EOF
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=IP:$public_ip
EOF
openssl x509 -req -sha256 -days 365 -in "$tls/server.csr" \
  -CA "$tls/ca.crt" -CAkey "$tls/ca-key.pem" -CAcreateserial \
  -extfile "$tls/server.ext" -out "$tls/server.crt"
cat "$tls/server.crt" "$tls/ca.crt" > "$tls/fullchain.pem"
openssl x509 -in "$tls/ca.crt" -outform DER -out "$tls/console-ca.cer"
openssl verify -CAfile "$tls/ca.crt" -verify_ip "$public_ip" "$tls/server.crt"
openssl x509 -in "$tls/ca.crt" -noout -sha256 -fingerprint
```

Set `CONSOLE_PORT=15443`, `CONSOLE_TLS_CERT` to this directory's `fullchain.pem` and `CONSOLE_TLS_KEY` to `server-key.pem` in the private configuration, then run `./console.sh doctor` and restart the user service. Verify `https://YOUR_PUBLIC_IP:15443/` with `curl --noproxy '*' --cacert "$tls/ca.crt"`; do not disable certificate verification. Certificate directories remain `700` and private keys `600`.

Transfer only `console-ca.cer` or `ca.crt` to the phone and check its SHA-256 fingerprint against the server's output. On iPhone/iPad, install the certificate profile, then enable it under Settings → General → About → Certificate Trust Settings, as described by [Apple](https://support.apple.com/en-us/102390). On Android, import it as a **CA certificate** under the device's certificate/credential settings; menu names vary by manufacturer. Reopen the HTTPS address after trusting the CA. A browser certificate-warning bypass alone is insufficient to confirm the secure context required by the video decoder. Never publish or transfer either private key.

To offer a download from the same port, copy only `console-ca.cer` into the generated state directory's `www/` directory. It is then available at `https://YOUR_PUBLIC_IP:15443/console-ca.cer`; the existing asset preparation preserves this file. Verify its fingerprint before installing it.

The server certificate lasts 365 days; the CA lasts ten years. Renew the server certificate with the existing CSR, extension file and CA, verify the candidate's chain and IP SAN, replace `server.crt` and `fullchain.pem`, then restart the user service. An unattended installation can use a persistent daily **user** timer that renews when less than 30 days remain (`openssl x509 -checkend 2592000 -noout -in server.crt`). Local signing requires no network validation or extra listener. Replacing the CA requires reinstalling its public certificate on every client. Do not run an earlier standalone Certbot installer when ports 80 and 443 must remain unused.

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
