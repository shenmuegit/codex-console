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
bash -n desktop/console.sh desktop/app-watch.sh scripts/deploy.sh desktop/lib/config.sh config/config.example.sh scripts/check.sh
python3 tests/test_startup.py
python3 tests/test_deploy.py
python3 tests/test_app_watch.py
python3 tests/test_upload.py
node tests/test_mobile.cjs
node tests/test_audio.cjs
node tests/test_network.cjs
python3 tests/test_network.py
if [[ ${1:-} == --live ]]; then
  source "$root/desktop/lib/config.sh"
  console_load_config
  console_validate_config
  export CONSOLE_STATE_DIR CONSOLE_HOST CONSOLE_PORT CONSOLE_DISPLAY CONSOLE_TLS_CERT
  python3 tests/test_console.py
fi
