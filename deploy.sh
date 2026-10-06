#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'HELP'
Usage: ./deploy.sh [install|uninstall] [options]

Install is the default. Run as your regular desktop user.
  --app PATH       Set the installed desktop app executable
  --skip-deps      Use dependencies already installed on the host
  --no-service     Prepare a manually managed console without systemd
  --no-start       Install and prepare without starting or restarting
  -h, --help       Show this help

Automatic dependency installation supports Debian 12/13 and Ubuntu 22.04/24.04.
Uninstall removes the user service; configuration and saved data are preserved.
HELP
}

action=install
skip_deps=false
use_service=true
start=true
app=
if [[ ${1:-} == install || ${1:-} == uninstall ]]; then
  action=$1
  shift
fi
while (( $# )); do
  case "$1" in
    --app)
      (( $# >= 2 )) && [[ -n $2 ]] || { printf 'Error: --app requires a path.\n' >&2; exit 2; }
      app=$2
      shift 2 ;;
    --skip-deps) skip_deps=true; shift ;;
    --no-service) use_service=false; shift ;;
    --no-start) start=false; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Error: unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done
if (( EUID == 0 )); then
  printf 'Error: run ./deploy.sh as your desktop user, without sudo. It uses sudo only for system dependencies.\n' >&2
  exit 1
fi

script_dir=$(dirname "$(readlink -f "$0")")
source "$script_dir/lib/config.sh"
config_home=${XDG_CONFIG_HOME:-$HOME/.config}
state_home=${XDG_STATE_HOME:-$HOME/.local/state}
CONSOLE_CONFIG=${CONSOLE_CONFIG:-$config_home/codex-console/config.sh}
unit=$config_home/systemd/user/codex-console.service

if [[ $action == uninstall ]]; then
  if [[ -f "$unit" ]]; then
    # Stop before unlinking registration; inactive linked units may otherwise
    # become unresolvable during disable --now's automatic reload.
    systemctl --user stop codex-console.service
    systemctl --user disable codex-console.service
    rm "$unit"
    systemctl --user daemon-reload
  fi
  printf 'User service removed. Configuration and application data are preserved.\n'
  printf 'Manually launched sessions can be stopped with ./console.sh stop.\n'
  exit 0
fi

umask 077
mkdir -p "$(dirname "$CONSOLE_CONFIG")"
if [[ ! -e "$CONSOLE_CONFIG" ]]; then
  cp "$script_dir/config.example.sh" "$CONSOLE_CONFIG"
  printf 'Created configuration: %s\n' "$CONSOLE_CONFIG"
fi
chmod 600 "$CONSOLE_CONFIG"
if [[ -n $app ]]; then
  # Store an exact quoted argument, including spaces and shell metacharacters.
  sed -i '/^CONSOLE_APP_BIN=/d' "$CONSOLE_CONFIG"
  printf '\nCONSOLE_APP_BIN=%q\n' "$app" >> "$CONSOLE_CONFIG"
fi
console_load_config
console_validate_config
export CONSOLE_CONFIG
if ! command -v "$CONSOLE_APP_BIN" >/dev/null || [[ ! -x $(command -v "$CONSOLE_APP_BIN") ]]; then
  console_error "Install the desktop app first, then run ./deploy.sh --app /absolute/path/to/app. Current CONSOLE_APP_BIN: $CONSOLE_APP_BIN"
  exit 1
fi

if [[ $skip_deps == false ]] && ! console_check_dependencies >/dev/null 2>&1; then
  [[ -f /etc/os-release ]] || { console_error 'Unknown distribution. Install dependencies manually and use --skip-deps.'; exit 1; }
  source /etc/os-release
  case "$ID:${VERSION_ID:-}" in
    debian:12|debian:13|ubuntu:22.04|ubuntu:24.04) ;;
    *) console_error 'Automatic dependencies support Debian 12/13 and Ubuntu 22.04/24.04. See docs/deployment.md and use --skip-deps.'; exit 1 ;;
  esac
  command -v sudo >/dev/null || { console_error 'Install sudo, or ask an administrator to install the dependencies and use --skip-deps.'; exit 1; }
  sudo -v
  sudo apt-get update
  sudo apt-get install -y ca-certificates curl
  download=$(mktemp -d)
  trap 'rm -rf "$download"' EXIT
  # Follow the official Xpra repository instructions; download data, not scripts.
  curl --fail --location --retry 2 --connect-timeout 10 --max-time 60 \
    https://xpra.org/xpra.asc -o "$download/xpra.asc"
  curl --fail --location --retry 2 --connect-timeout 10 --max-time 60 \
    "https://raw.githubusercontent.com/Xpra-org/xpra/master/packaging/repos/$VERSION_CODENAME/xpra.sources" \
    -o "$download/xpra.sources"
  if [[ ! -e /usr/share/keyrings/xpra.asc ]]; then
    sudo install -m 644 "$download/xpra.asc" /usr/share/keyrings/xpra.asc
  fi
  if ! grep -qsE 'xpra\.org' /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources; then
    sudo install -m 644 "$download/xpra.sources" /etc/apt/sources.list.d/codex-console-xpra.sources
  fi
  sudo apt-get update
  sudo apt-get install -y --install-recommends xpra xpra-html5 xvfb xauth x11-utils x11-xserver-utils \
    pulseaudio dbus-x11 python3 openssl coreutils util-linux \
    gstreamer1.0-tools gstreamer1.0-plugins-base gstreamer1.0-plugins-good \
    gstreamer1.0-plugins-bad gstreamer1.0-plugins-ugly gstreamer1.0-libav \
    fonts-dejavu-core fonts-noto-cjk
fi
"$script_dir/console.sh" doctor

if [[ $use_service == true ]]; then
  command -v systemctl >/dev/null || { console_error 'systemd is unavailable. Use --no-service.'; exit 1; }
  systemctl --user show-environment >/dev/null || { console_error 'No systemd user session. Run from a normal user login, or use --no-service.'; exit 1; }
fi
"$script_dir/console.sh" prepare

if [[ $use_service == true ]]; then
  mkdir -p "$(dirname "$unit")"
  python3 - "$script_dir" "$CONSOLE_CONFIG" "$state_home" "$unit" <<'UNIT'
from pathlib import Path
import sys
repo, config, state, output = sys.argv[1:]
def quote(value):
    if '\n' in value or '\r' in value:
        raise SystemExit('Service paths must contain no line breaks')
    return value.replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%')
text = (Path(repo) / 'codex-console.service').read_text()
for token, value in {
    '@REPO_DIR@': repo.replace('%', '%%'), '@EXEC_DIR@': quote(repo).replace('$', '$$'),
    '@CONFIG_FILE@': quote(config), '@STATE_HOME@': quote(state),
}.items():
    text = text.replace(token, value)
Path(output).write_text(text)
UNIT
  chmod 644 "$unit"
  systemctl --user daemon-reload
  if [[ $start == true ]]; then
    if systemctl --user is-active --quiet codex-console.service; then
      systemctl --user enable "$unit"
      systemctl --user restart codex-console.service
    else
      if xpra info "$CONSOLE_DISPLAY" >/dev/null 2>&1; then
        console_error "Display $CONSOLE_DISPLAY already has a session. Stop the manually launched console first, or choose another CONSOLE_DISPLAY."
        exit 1
      fi
      systemctl --user enable --now "$unit"
    fi
    if command -v loginctl >/dev/null; then
      if ! loginctl enable-linger "$(id -un)"; then
        printf 'Boot startup needs lingering. Run: sudo loginctl enable-linger %q\n' "$(id -un)" >&2
      fi
    fi
  else
    systemctl --user enable "$unit"
  fi
elif [[ $start == true ]]; then
  "$script_dir/console.sh" start
fi

scheme=http
if [[ -n $CONSOLE_TLS_CERT ]]; then scheme=https; fi
if [[ $start == true ]]; then
  # Trust the configured identity for this local readiness probe.
  if ! python3 - "$CONSOLE_HOST" "$CONSOLE_PORT" "$scheme" "$CONSOLE_TLS_CERT" <<'READY'
import ssl
import sys
import time
import urllib.request
host = '127.0.0.1' if sys.argv[1] == '0.0.0.0' else sys.argv[1]
url = f'{sys.argv[3]}://{host}:{sys.argv[2]}/'
handlers = [urllib.request.ProxyHandler({})]
if sys.argv[4]:
    context = ssl.create_default_context(cafile=sys.argv[4])
    context.check_hostname = False  # Local address may differ from the public certificate hostname.
    context.verify_flags |= ssl.VERIFY_X509_PARTIAL_CHAIN
    handlers.append(urllib.request.HTTPSHandler(context=context))
opener = urllib.request.build_opener(*handlers)
deadline = time.monotonic() + 30
while time.monotonic() < deadline:
    try:
        request = urllib.request.Request(url)
        with opener.open(request, timeout=2) as response:
            page = response.read()
            if response.status == 200 and b'id="login-overlay"' in page and b'mobile.js?v=' in page:
                sys.exit(0)
    except (OSError, ValueError):
        pass
    time.sleep(0.5)
sys.exit(1)
READY
  then
    console_error "The browser page did not become ready. Inspect $CONSOLE_STATE_DIR/xpra.log and journalctl --user -u codex-console.service."
    exit 1
  fi
fi
printf '\nInstallation complete.\n'
if [[ $CONSOLE_HOST == 0.0.0.0 ]]; then
  printf 'Browser address: %s://HOST_IP:%s/ (replace HOST_IP with this host address)\n' "$scheme" "$CONSOLE_PORT"
else
  printf 'Browser address: %s://%s:%s/\n' "$scheme" "$CONSOLE_HOST" "$CONSOLE_PORT"
fi
printf 'Access password: %q password\n' "$script_dir/console.sh"
printf 'Configuration: %s\n' "$CONSOLE_CONFIG"
if [[ $start == false ]]; then
  printf 'The console was prepared without starting or restarting.\n'
fi
