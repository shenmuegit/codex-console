# Copy to ~/.config/codex-console/config.sh (deploy.sh does this automatically).
# This is a Bash file. Quote paths; use an array for application arguments.

CONSOLE_APP_BIN=/usr/bin/chatgpt
CONSOLE_APP_ARGS=(--ozone-platform=x11 --disable-gpu)

CONSOLE_HOST=0.0.0.0
CONSOLE_PORT=15443
CONSOLE_DISPLAY=:100

# Defaults follow XDG_STATE_HOME. Uncomment only to move the saved data.
# CONSOLE_STATE_DIR="$HOME/.local/state/codex-console"
XPRA_HTML_DIR=/usr/share/xpra/www

# Optional: browser-trusted certificate and private key enable native HTTPS/WSS.
# CONSOLE_TLS_CERT=/absolute/path/to/fullchain.pem
# CONSOLE_TLS_KEY=/absolute/path/to/privkey.pem
