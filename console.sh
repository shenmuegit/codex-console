#!/usr/bin/env bash
set -euo pipefail

case "${1:-start}" in
  stop) exec xpra stop :100 ;;
  status) exec xpra info :100 windows ;;
  start) ;;
  *) printf 'Usage: %s [start|stop|status]\n' "$0" >&2; exit 2 ;;
esac

if (( EUID == 0 )); then
  printf 'Run this as the desktop user, not root.\n' >&2
  exit 1
fi

state="${XDG_STATE_HOME:-$HOME/.local/state}/codex-console"
umask 077
mkdir -p "$state"
chmod 700 "$state"
if [[ ! -s "$state/password" ]]; then
  openssl rand -hex 24 | tr -d '\n' > "$state/password"
fi
if [[ ! -s "$state/cert.pem" || ! -s "$state/key.pem" ]]; then
  # ponytail: self-signed certificate for IP access; use a trusted certificate when needed.
  openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 365 \
    -subj /CN=localhost -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' \
    -keyout "$state/key.pem" -out "$state/cert.pem" 2>/dev/null
fi
chmod 600 "$state/password" "$state/key.pem" "$state/cert.pem"
export CODEX_ELECTRON_USER_DATA_PATH="$state/profile"

web="$state/www"
python3 - "$web" "$(dirname "$(readlink -f "$0")")/mobile.js" <<'PY'
from pathlib import Path
import hashlib
import sys

web, mobile = map(Path, sys.argv[1:])
web.mkdir(exist_ok=True)
assets = Path('/usr/share/xpra/www')
for asset in assets.iterdir():
    if asset.name.startswith('index.html'):
        continue
    target = web / asset.name
    if not target.exists():
        target.symlink_to(asset, target_is_directory=asset.is_dir())
target = web / 'mobile.js'
if not target.exists():
    target.symlink_to(mobile)
target = web / 'default-settings.txt'
target.unlink(missing_ok=True)
target.write_text((assets / 'default-settings.txt').read_text() +
                  '\ntoolbar_position = novnc\nautohide = true\nkeyboard = false\n')
version = hashlib.sha256(mobile.read_bytes()).hexdigest()[:12]
html = (assets / 'index.html').read_text()
html = html.replace('float_menu_element.on("mouseover", expand_float_menu);', '')
html = html.replace('float_menu_element.on("mouseout", retract_float_menu);', '')
html = html.replace('init_keyboard(client);', 'window.init_mobile_keyboard(client);')
html = html.replace('toggle_keyboard();', 'window.toggle_mobile_keyboard();')
html = html.replace('enable_clipboard_autofocus();', '')
html = html.replace('class="simple-keyboard" style="display: block;', 'class="simple-keyboard" style="display: none;')
html = html.replace('<ul id="menu_list">', '''<ul id="menu_list">
            <li><label for="performance_profile">画质与流畅度</label>
              <select id="performance_profile" title="切换立即生效，高清会增加流量">
                <option value="smooth">流畅</option>
                <option value="balanced" selected>均衡</option>
                <option value="sharp">高清</option>
              </select>
            </li>''')
extra = '''<style>
body {overscroll-behavior: none}
#screen {touch-action: none}
#float_menu {top: 0 !important; left: 0 !important}
#float_menu_button {width: 44px; height: 44px}
#float_menu_arrow {right: 0; top: 0; display: flex; align-items: center; justify-content: center; height: 100%}
#performance_profile {font: inherit; min-height: 36px; margin: 4px 10px}
#menu_list label {display: block; padding: 8px 10px 0}
#mobile-ime {position: fixed; top: 0; left: 0; width: 1px; height: 1px; padding: 0; border: 0; opacity: 0; pointer-events: none; font-size: 16px}
</style>'''
extra += f'<script src="mobile.js?v={version}"></script>\n'
(web / 'index.html').write_text(html.replace('</head>', extra + '</head>'))
PY

exec xpra seamless :100 \
  --bind-wss="0.0.0.0:15443,auth=file:filename=$state/password" \
  --ssl-cert="$state/cert.pem" --ssl-key="$state/key.pem" \
  --html="$web" --http-scripts=off --mdns=no \
  --start-child="/usr/bin/chatgpt --user-data-dir=\"$state/profile\" --proxy-server=http://127.0.0.1:7890 --ozone-platform=x11 --disable-gpu" \
  --use-display=no --resize-display=no --dpi=96 \
  --xvfb='Xvfb -screen 0 1280x900x24 -dpi 96 -nolisten tcp -noreset +extension Composite +extension RANDR +extension RENDER -auth $XAUTHORITY' \
  --daemon=yes --attach=no --systemd-run=no --start-via-proxy=no \
  --exit-with-children=yes --terminate-children=yes \
  --start-new-commands=no --shell=no \
  --audio=yes --pulseaudio=yes --speaker=on --microphone=disabled \
  --webcam=no --printing=no --file-transfer=no \
  --open-files=no --open-url=no --session-name='Codex Console' \
  --log-dir="$state" --log-file=xpra.log
