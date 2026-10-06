#!/usr/bin/env bash
set -euo pipefail

case "${1:-start}" in
  help|-h|--help)
    printf 'Usage: %s [start|run|stop|status|network|doctor|prepare|password]\n' "$0"
    exit 0 ;;
  stop|status|network|doctor|prepare|password) daemon=no ;;
  start) daemon=yes ;;
  run) daemon=no ;;
  *) printf 'Usage: %s [start|run|stop|status|network|doctor|prepare|password]\n' "$0" >&2; exit 2 ;;
esac
(( $# <= 1 )) || { printf 'Too many arguments. Use --help.\n' >&2; exit 2; }

if (( EUID == 0 )); then
  printf 'Run this as the desktop user, not root.\n' >&2
  exit 1
fi

script_dir=$(dirname "$(readlink -f "$0")")
source "$script_dir/lib/config.sh"
console_load_config
console_validate_config "${1:-start}"
state=$CONSOLE_STATE_DIR
case "${1:-start}" in
  stop) exec xpra stop "$CONSOLE_DISPLAY" ;;
  status) exec xpra info "$CONSOLE_DISPLAY" windows ;;
  network) exec python3 "$script_dir/network.py" "$state" ;;
  password)
    [[ -s "$state/password" ]] || { console_error 'No access password yet. Run ./deploy.sh or ./console.sh prepare.'; exit 1; }
    cat "$state/password"
    printf '\n'
    exit 0 ;;
  doctor)
    console_check_dependencies
    printf 'Config: %s\nApp: %s\nListen: %s:%s\nDisplay: %s\nState: %s\n' \
      "$CONSOLE_CONFIG" "$CONSOLE_APP_BIN" "$CONSOLE_HOST" "$CONSOLE_PORT" "$CONSOLE_DISPLAY" "$state"
    exit 0 ;;
esac
console_check_dependencies >/dev/null
umask 077
mkdir -p "$state"
chmod 700 "$state"
if [[ -z $CONSOLE_TLS_CERT ]]; then
  rm -f "$state/cert.pem" "$state/key.pem"
fi
if [[ ! -s "$state/password" ]]; then
  openssl rand -hex 24 | tr -d '\n' > "$state/password"
fi
chmod 600 "$state/password"
export CODEX_ELECTRON_USER_DATA_PATH="$state/profile"
export XPRA_DOWNLOAD_DIR="$state/uploads"
mkdir -p "$XPRA_DOWNLOAD_DIR"
chmod 700 "$XPRA_DOWNLOAD_DIR"

web="$state/www"
python3 - "$web" "$script_dir/mobile.js" "$XPRA_HTML_DIR" <<'PY'
from pathlib import Path
from html import escape
import hashlib
import re
import sys

web, mobile = map(Path, sys.argv[1:3])
web.mkdir(exist_ok=True)
assets = Path(sys.argv[3] if len(sys.argv) > 3 else '/usr/share/xpra/www')
# Keep only our page, also removing upstream pages from previous deployments.
for target in web.glob('*.html*'):
    if target.name != 'index.html':
        target.unlink()
for asset in assets.iterdir():
    if '.html' in asset.suffixes:
        continue
    target = web / asset.name
    if target.is_symlink():
        target.unlink()
    if not target.exists():
        target.symlink_to(asset, target_is_directory=asset.is_dir())
for source in (mobile, mobile.with_name('network.js'), mobile.with_name('console.css'), mobile.parent / 'assets/codex-console-icon.png'):
    target = web / source.name
    if target.is_symlink():
        target.unlink()
    if not target.exists():
        target.symlink_to(source)
target = web / 'default-settings.txt'
target.unlink(missing_ok=True)
target.write_text((assets / 'default-settings.txt').read_text() +
                  '\ntoolbar_position = novnc\nautohide = true\nkeyboard = false\n')
# Xpra's legacy clipboard conversion double-encodes UTF-8 with rencodeplus.
client_js = (assets / 'js/Client.js').read_text()
client_js = client_js.replace('unescape(encodeURIComponent(e))', 'e')
client_js = client_js.replace('unescape(encodeURIComponent(text))', 'text')
# Empty typed arrays are truthy: stop after the last acknowledged upload chunk.
client_js = client_js.replace('if(packet=packet[1]){', 'if((packet=packet[1]).length){')
client_js = client_js.replace('SHOW_START_MENU=!0', 'SHOW_START_MENU=!1')
# Reconnection must keep the page's password dialog for file authentication.
client_js = client_js.replace('this.password_prompt_fn=null', 'this.password_prompt_fn??=null')
(web / 'Client.js').write_text(client_js)
version = hashlib.sha256(mobile.read_bytes() + mobile.with_name('network.js').read_bytes() + mobile.with_name('console.css').read_bytes() + client_js.encode()).hexdigest()[:12]
html = (assets / 'index.html').read_text()
# Upload uses Xpra; downloads and the synthetic mobile keyboard are omitted.
html = re.sub(r'^\s*<(?:script|link|div)\b[^>]*(?:simple-keyboard|FileSaver|StreamSaver|web-streams-ponyfill)[^>]*>.*$',
              '', html, flags=re.M)
instance = f"chatgpt ({web.parent / 'profile'})"
html = html.replace('id="screen"', f'id="screen" data-codex-instance="{escape(instance)}" data-codex-upload-dir="{escape(str(web.parent / "uploads"))}"')
html = html.replace('<html lang="en">', '<html lang="zh-CN">')
html = html.replace('<title>xpra websockets client</title>', '<title>Codex Console</title>')
html = html.replace('href="favicon.png" id="favicon"', 'href="codex-console-icon.png" id="favicon"')
html = html.replace('content="width=device-width, initial-scale=1"',
                    'content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content"')
html = html.replace('src="js/Client.js"', f'src="Client.js?v={version}"')
html = html.replace('<ul class="Menu -horizontal">', '<ul class="Menu -horizontal -alignRight">')
# Keep Xpra's event targets, but expose only the three mobile controls.
html = re.sub(r'(<li class="-hasSubmenu -noChevron")(?=>\s*<a[^>]*id="(?:open_windows|clipboard_button|cursor_lock_button)")',
              r'\1 hidden', html, flags=re.S)
html = re.sub(r'(<li class="-hasSubmenu -noChevron")(?=>\s*<a[^>]*id="xpramenu")',
              r'\1 style="display: contents"', html, flags=re.S)
html = html.replace('id="xpramenu"', 'id="xpramenu" hidden')
html = re.sub(r'var widget_ids = \[.*?\];',
              'var widget_ids = ["fullscreen_button", "keyboard_button", "sound_button"];', html, count=1, flags=re.S)
html = html.replace('float_menu_element.on("mouseover", expand_float_menu);', '')
html = html.replace('float_menu_element.on("mouseout", retract_float_menu);', '')
# Reconnection must replace the toggle handler, rather than accumulating toggles.
html = html.replace('float_menu_button_element.on("click", toggle_float_menu);',
                    'float_menu_button_element.off("click", toggle_float_menu).on("click", toggle_float_menu);')
html = html.replace('<div id="float_menu_button">', '<div id="float_menu_button" class="noDrag">')
html = html.replace('<div id="float_menu">', '<div id="float_menu" class="noDrag">')
html = html.replace('id="float_menu_arrow" title="Expand Menu" data-icon="chevron_right"',
                    'id="float_menu_arrow" title="Expand Menu" data-icon="chevron_left"')
html = html.replace('$("#float_menu_arrow").attr("data-icon", "chevron_right");',
                    '$("#float_menu_arrow").attr("data-icon", "chevron_left");')
html = html.replace('init_keyboard(client);', 'window.init_mobile_keyboard(client);')
html = html.replace('init_file_transfer(client);', 'window.init_mobile_upload(client);')
for item in ('upload_menu_entry', 'download_menu_entry'):
    html = html.replace(f'id="{item}"', f'id="{item}" hidden')
html = html.replace('    <div id="screen"', '''    <dialog id="mobile-upload" class="noDrag" hidden aria-labelledby="upload-title" aria-describedby="upload-status" onkeydown="event.stopPropagation()" onkeyup="event.stopPropagation()">
      <h2 id="upload-title">上传文件</h2>
      <p id="upload-status" role="status" aria-live="polite">请选择当前手机或电脑上的文件，上传后由 Codex 添加附件。</p>
      <label id="upload-local" for="upload"><span id="upload-local-caption">选择图片</span></label>
      <label id="upload-files" for="upload-file">选择文件<input id="upload-file" type="file" accept="application/octet-stream" aria-label="选择文件" /></label>
      <button id="upload-cancel" type="button">取消添加</button>
    </dialog>
    <div id="screen"''')
# Install the password dialog before connect() can request credentials.
html = html.replace('client.password_prompt_fn = password_prompt_fn;', '')
html = html.replace('client.reconnect = reconnect;', '''client.reconnect = reconnect;
        client.password_prompt_fn = password_prompt_fn;''')
html = html.replace('toggle_keyboard();', 'window.toggle_mobile_keyboard();')
html = html.replace('enable_clipboard_autofocus();', '')
html = html.replace('<ul id="menu_list">', '''<ul id="menu_list">
            <li id="performance_menu_entry" class="noDrag">
              <details>
                <summary>画质与流畅度</summary>
                <ul>
                  <li><button type="button" data-performance="smooth" aria-pressed="false">流畅</button></li>
                  <li><button type="button" data-performance="balanced" aria-pressed="true">均衡</button></li>
                  <li><button type="button" data-performance="sharp" aria-pressed="false">高清</button></li>
                </ul>
              </details>
            </li>''')
html = re.sub(r'<li\b[^>]*\bid="startmenuentry"[^>]*>.*?</li>', '', html, flags=re.S)
for icon in ('kitchen', 'info'):
    pattern = rf'<li class="-hasSubmenu">\s*<a href="#" data-icon="{icon}">[^<]+</a>\s*(<ul>.*?</ul>)\s*</li>'
    html = re.sub(pattern, '', html, flags=re.S)
html = html.replace('>Reload</a>', '>重新加载</a>').replace('>Disconnect</a>', '>断开连接</a>')
start, end = html.index('    <div id="progress"'), html.index('    <div id="float_menu"')
html = html[:start] + '''    <div id="progress" class="overlay" style="display: none" role="status" aria-live="polite">
      <div class="connection-panel">
        <div class="console-brand"><span class="console-mark" aria-hidden="true">›_</span>Codex Console</div>
        <p id="progress-label"></p>
        <p id="progress-details"></p>
        <progress id="progress-bar" max="100" value="10" aria-label="连接进度"></progress>
        <button id="connection-retry" type="button" hidden>重新连接</button>
      </div>
    </div>

    <div id="login-overlay" role="dialog" aria-modal="true" aria-labelledby="login-title">
      <div id="login-box">
        <form id="login_form" onsubmit="event.preventDefault(); window.login_connect();" onkeydown="event.stopPropagation()" onkeyup="event.stopPropagation()">
          <div id="login-innerbox">
            <div class="console-brand"><span class="console-mark" aria-hidden="true">›_</span>Codex Console</div>
            <h1 id="login-title">连接到你的工作区</h1>
            <p class="login-hint">输入服务器访问密码以继续。</p>
            <p id="login-header"></p>
            <input type="text" name="username" id="username" value="" autocomplete="username" style="display: none">
            <label for="password">访问密码</label>
            <div id="password-box">
              <input type="password" id="password" autocomplete="current-password" placeholder="输入访问密码" maxlength="256" required>
            </div>
            <div id="login-buttons">
              <button class="login-button" type="button" id="login_cancel" onclick="window.login_cancel()">取消</button>
              <button class="login-button" type="submit" id="login_connect">连接工作区</button>
            </div>
          </div>
        </form>
      </div>
    </div>

''' + html[end:]
# Native buttons handle Enter; retain Escape and the password field's shortcuts.
html = html.replace('document.querySelector("#login_connect").addEventListener("keyup", password_special_keys);', '')
html = html.replace('if (event.keyCode == 27 || event.keyCode == 13) {', 'if (event.keyCode == 27) {')
html = html.replace('function login_connect() {', 'function login_connect() {\n        if (!password_input.reportValidity()) return;')
html = html.replace('$("#login-header").text(heading);', '$("#login-header").text(window.location.host);')
extra = f'<link rel="stylesheet" href="console.css?v={version}">\n'
extra += f'<script src="mobile.js?v={version}"></script>\n'
extra += f'<script src="network.js?v={version}"></script>\n'
(web / 'index.html').write_text(html.replace('</head>', extra + '</head>'))
PY

if [[ ${1:-start} == prepare ]]; then
  printf 'Prepared browser assets and credentials in %s\n' "$state"
  exit 0
fi

# Let congestion feedback work below Xpra's upstream 5 Mi bit/s floor.
export XPRA_MIN_BANDWIDTH=${XPRA_MIN_BANDWIDTH:-524288}
# Isolate PulseAudio's PID/runtime files from the user's desktop and other sessions.
mkdir -p "$state/pulse-runtime"
chmod 700 "$state/pulse-runtime"
export PULSE_RUNTIME_PATH="$state/pulse-runtime"
export XPRA_PRIVATE_PULSEAUDIO=1

# Xpra parses this command into argv; quote each argument without evaluating it.
# Keep the native picker in the app process instead of an external XDG portal.
child=$(python3 - "$script_dir/app-watch.sh" "$CONSOLE_APP_BIN" "--user-data-dir=$state/profile" "${CONSOLE_APP_ARGS[@]}" --xdg-portal-required-version=999 <<'CHILD'
import shlex
import sys
print(shlex.join(sys.argv[1:]))
CHILD
)
upload_command=$(python3 - "$script_dir/upload.py" "$XPRA_DOWNLOAD_DIR" <<'UPLOAD'
import shlex
import sys
print(shlex.join(['python3', *sys.argv[1:]]))
UPLOAD
)
# ponytail: fixed 4096px Xvfb; use a resizable Xorg display for larger render sizes.
transport=("--bind-ws=$CONSOLE_HOST:$CONSOLE_PORT,auth=file:filename=$state/password" --ssl=no)
if [[ -n $CONSOLE_TLS_CERT ]]; then
  transport=("--bind-wss=$CONSOLE_HOST:$CONSOLE_PORT,auth=file:filename=$state/password" --ssl=on
             "--ssl-cert=$CONSOLE_TLS_CERT" "--ssl-key=$CONSOLE_TLS_KEY")
fi
exec xpra seamless "$CONSOLE_DISPLAY" \
  "${transport[@]}" \
  --html="$web" --http-scripts=off --mdns=no \
  --start-child="$child" \
  --use-display=no --resize-display=no --dpi=96 \
  --xvfb='Xvfb -screen 0 4096x4096x24 -dpi 96 -nolisten tcp -noreset +extension Composite +extension RANDR +extension RENDER -auth $XAUTHORITY' \
  --daemon="$daemon" --attach=no --systemd-run=no --start-via-proxy=no \
  --bandwidth-detection=yes \
  --exit-with-children=yes --terminate-children=yes \
  --start-new-commands=no --shell=no \
  --audio=yes --pulseaudio=yes --speaker=on --microphone=disabled \
  --webcam=no --printing=no --file-transfer=yes \
  --open-files=yes --open-command="$upload_command" --open-url=no --session-name='Codex Console' \
  --log-dir="$state" --log-file=xpra.log
