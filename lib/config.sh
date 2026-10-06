#!/usr/bin/env bash
# Shared configuration and preflight checks. Sourced by the entry scripts.

console_error() {
  printf 'Error: %s\n' "$*" >&2
}

console_load_config() {
  local explicit_config=${CONSOLE_CONFIG:-}
  CONSOLE_CONFIG=${CONSOLE_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/codex-console/config.sh}
  if [[ -f "$CONSOLE_CONFIG" ]]; then
    bash -n "$CONSOLE_CONFIG" || return 1
    # The configuration belongs to the same user and is intentionally Bash.
    source "$CONSOLE_CONFIG"
  elif [[ -n "$explicit_config" ]]; then
    console_error "Configuration not found: $CONSOLE_CONFIG"
    return 1
  fi
  CONSOLE_APP_BIN=${CONSOLE_APP_BIN:-/usr/bin/chatgpt}
  if ! declare -p CONSOLE_APP_ARGS &>/dev/null; then
    CONSOLE_APP_ARGS=(--ozone-platform=x11 --disable-gpu)
  fi
  CONSOLE_HOST=${CONSOLE_HOST:-0.0.0.0}
  CONSOLE_PORT=${CONSOLE_PORT:-15443}
  CONSOLE_DISPLAY=${CONSOLE_DISPLAY:-:100}
  CONSOLE_STATE_DIR=${CONSOLE_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/codex-console}
  XPRA_HTML_DIR=${XPRA_HTML_DIR:-/usr/share/xpra/www}
  CONSOLE_TLS_CERT=${CONSOLE_TLS_CERT:-}
  CONSOLE_TLS_KEY=${CONSOLE_TLS_KEY:-}
  export CONSOLE_STATE_DIR
}

console_validate_config() {
  if [[ ! $CONSOLE_PORT =~ ^[0-9]{1,5}$ ]] || (( 10#$CONSOLE_PORT < 1024 || 10#$CONSOLE_PORT > 65535 )); then
    console_error 'CONSOLE_PORT must be an integer between 1024 and 65535.'
    return 1
  fi
  CONSOLE_PORT=$((10#$CONSOLE_PORT))
  if [[ ! $CONSOLE_DISPLAY =~ ^:[0-9]{1,5}$ ]]; then
    console_error 'CONSOLE_DISPLAY must be an X11 display such as :100.'
    return 1
  fi
  if [[ ! $CONSOLE_HOST =~ ^[a-zA-Z0-9.-]+$ ]]; then
    console_error 'CONSOLE_HOST must be an IPv4 address or hostname.'
    return 1
  fi
  local path
  for path in "$CONSOLE_CONFIG" "$CONSOLE_STATE_DIR" "$XPRA_HTML_DIR"; do
    if [[ $path != /* || $path == *$'\n'* || $path == *$'\r'* || $path == *,* ]]; then
      console_error 'Configuration, state and HTML paths must be absolute and contain no commas or line breaks.'
      return 1
    fi
  done
  CONSOLE_STATE_DIR=$(readlink -m "$CONSOLE_STATE_DIR")
  # Existing sessions remain manageable when their TLS files are moved or removed.
  if [[ -n $CONSOLE_TLS_CERT || -n $CONSOLE_TLS_KEY ]] && [[ ! ${1:-} =~ ^(stop|status|network|password)$ ]]; then
    for path in "$CONSOLE_TLS_CERT" "$CONSOLE_TLS_KEY"; do
      if [[ $path != /* || $path == *$'\n'* || $path == *$'\r'* || $path == *,* || ! -f $path || ! -s $path || ! -r $path ]]; then
        console_error 'CONSOLE_TLS_CERT and CONSOLE_TLS_KEY must both name readable, nonempty absolute files without commas or line breaks.'
        return 1
      fi
    done
  fi
  if [[ $(declare -p CONSOLE_APP_ARGS) != 'declare -a '* ]]; then
    console_error 'CONSOLE_APP_ARGS must be a Bash array, for example: (--ozone-platform=x11 --disable-gpu).'
    return 1
  fi
}

console_check_dependencies() {
  local executable missing=0
  for executable in xpra python3 openssl Xvfb pulseaudio pactl gst-launch-1.0 xprop flock xauth dbus-launch readlink; do
    if ! command -v "$executable" >/dev/null; then
      console_error "Missing dependency: $executable. Run ./deploy.sh or see docs/deployment.md."
      missing=1
    fi
  done
  if ! command -v "$CONSOLE_APP_BIN" >/dev/null || [[ ! -x $(command -v "$CONSOLE_APP_BIN") ]]; then
    console_error "Desktop app not found: $CONSOLE_APP_BIN. Install it separately and set CONSOLE_APP_BIN in $CONSOLE_CONFIG."
    missing=1
  fi
  (( missing == 0 )) || return 1
  local version
  version=$(xpra --version) || return 1
  if ! python3 - "$version" <<'VERSION'
import re
import sys
match = re.search(r'(\d+)\.(\d+)', sys.argv[1])
sys.exit(0 if match and (6, 5) <= tuple(map(int, match.groups())) < (7, 0) else 1)
VERSION
  then
    console_error "Xpra 6.5.x or newer 6.x is required; found: $version"
    return 1
  fi
  if ! python3 - 2>/dev/null <<'MODULES'
from xpra.x11.bindings.core import X11CoreBindings
from xpra.audio.gstreamer_util import get_encoders
import sys
sys.exit(0 if {'opus+mka', 'aac+mpeg4'} <= set(get_encoders()) else 1)
MODULES
  then
    console_error 'Xpra X11/audio modules and Opus/WebM/AAC encoders are required. Install the complete Xpra runtime with its recommended packages.'
    return 1
  fi
  local asset
  for asset in index.html default-settings.txt js/Client.js js/Window.js js/Utilities.js js/Constants.js js/Keycodes.js js/lib/rencode.js; do
    if [[ ! -r "$XPRA_HTML_DIR/$asset" ]]; then
      console_error "Missing Xpra HTML5 asset: $XPRA_HTML_DIR/$asset. Install xpra-html5 or set XPRA_HTML_DIR."
      return 1
    fi
  done
  if ! python3 - "$XPRA_HTML_DIR/index.html" <<'CLIENT'
from pathlib import Path
import sys
html = Path(sys.argv[1]).read_text()
required = ('id="screen"', '<div id="progress"', '<div id="float_menu"',
            'client.reconnect = reconnect;', 'function login_connect() {',
            'init_keyboard(client);', 'src="js/Client.js"', 'init_file_transfer(client);', 'id="upload"')
sys.exit(0 if all(token in html for token in required) else 1)
CLIENT
  then
    console_error 'Unsupported Xpra HTML5 page layout. The supported baseline is xpra-html5 19-r1; see docs/deployment.md.'
    return 1
  fi
  printf 'OK: %s; HTML5 client and runtime dependencies are available.\n' "$version"
}
