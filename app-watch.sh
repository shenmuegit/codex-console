#!/usr/bin/env bash
set -euo pipefail

if (( $# == 0 )); then
  printf 'Usage: %s command [arguments...]\n' "$0" >&2
  exit 2
fi
umask 077
state="${CONSOLE_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/codex-console}"
mkdir -p "$state"
exec 9>"$state/app-watch.lock"
flock -n 9 || exit 0
trap 'jobs -pr | xargs -r kill 2>/dev/null || true; wait || true' EXIT
trap 'exit 0' INT TERM

# Login opens Firefox through xdg-open, outside the app's direct child processes.
# Xpra uses the first matching rule; allow it before excluding other parents.
xpra control "${DISPLAY:-:100}" add-window-filter window class-instance '=' "('Navigator', 'firefox-esr')" '*' 9>&- >/dev/null

# Native Electron choosers have no profile class or transient parent. XRes gives
# their owning process: forward only windows from this supervisor's app children.
xpra control "${DISPLAY:-:100}" add-window-filter window ppid '!=' "$$" 9>&- >/dev/null

while windows=$(xprop -root _NET_CLIENT_LIST 2>/dev/null); do
  visible=false
  for wid in $(printf '%s\n' "$windows" | grep -oE '0x[[:xdigit:]]+' || true); do
    properties=$(xprop -id "$wid" WM_CLASS _NET_WM_STATE 2>/dev/null) || continue
    if [[ $properties == *"\"chatgpt ($state/profile)\""* && $properties != *_NET_WM_STATE_HIDDEN* ]]; then
      visible=true
      break
    fi
  done
  delay=2
  if [[ $visible == false ]]; then
    # Electron's single-instance handler also reopens a closed main window.
    "$@" 9>&- &
    delay=5
  fi
  # Wait on a background timer so server shutdown interrupts it immediately.
  sleep "$delay" 9>&- &
  wait $! || true
done
