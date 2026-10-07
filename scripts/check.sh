#!/usr/bin/env bash
set -euo pipefail
script_dir=$(dirname "$(readlink -f "$0")")
root=$(dirname "$script_dir")
cd "$root"
case "${1:-}" in
  '') ;;
  --live) ;;
  *) printf 'Usage: %s [--live]\n' "$0" >&2; exit 2 ;;
esac
bash -n console.sh app-watch.sh deploy.sh lib/config.sh config.example.sh scripts/check.sh
python3 test_startup.py
python3 test_deploy.py
python3 test_app_watch.py
python3 test_upload.py
node test_mobile.cjs
node test_audio.cjs
node test_network.cjs
python3 test_network.py
if [[ ${1:-} == --live ]]; then
  source "$root/lib/config.sh"
  console_load_config
  console_validate_config
  export CONSOLE_STATE_DIR CONSOLE_HOST CONSOLE_PORT CONSOLE_DISPLAY CONSOLE_TLS_CERT
  python3 test_console.py
fi
