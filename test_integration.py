"""Deploy a temporary Xpra session with an X11 fixture, then check HTTPS/WSS.

Requires xterm in addition to the normal runtime. Uses no app account or service.
"""
import os
from pathlib import Path
import random
import shlex
import socket
import subprocess
import tempfile


root = Path(__file__).resolve().parent
with tempfile.TemporaryDirectory(prefix="console integration ") as directory, \
        tempfile.TemporaryDirectory(prefix="console-runtime-") as runtime:
    work = Path(directory)
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    display_number = random.randrange(1000, 30000)
    while Path(f"/tmp/.X11-unix/X{display_number}").exists() or Path(f"/tmp/.X{display_number}-lock").exists():
        display_number = random.randrange(1000, 30000)
    display = f":{display_number}"
    app = work / "test app"
    app.write_text('#!/usr/bin/env bash\nexec xterm -name "chatgpt ($CONSOLE_STATE_DIR/profile)" -class Chatgpt -e sleep 120\n')
    app.chmod(0o755)
    state = work / "state"
    config = work / "config.sh"
    config.write_text(f"CONSOLE_APP_BIN={shlex.quote(str(app))}\n"
                      f"CONSOLE_STATE_DIR={shlex.quote(str(state))}\n"
                      f"CONSOLE_DISPLAY={display}\nCONSOLE_PORT={port}\nCONSOLE_HOST=127.0.0.1\n")
    inherited = {name: value for name, value in os.environ.items()
                 if not name.startswith("CONSOLE_")}
    env = dict(inherited, CONSOLE_CONFIG=str(config), XDG_RUNTIME_DIR=runtime)
    try:
        deployment = subprocess.run([str(root / "deploy.sh"), "--skip-deps", "--no-service"],
                                    env=env, capture_output=True, text=True, timeout=60)
        assert deployment.returncode == 0, deployment.stdout + deployment.stderr
        live_env = dict(env, CONSOLE_STATE_DIR=str(state), CONSOLE_PORT=str(port),
                        CONSOLE_DISPLAY=display, CONSOLE_HOST="127.0.0.1")
        check = subprocess.run(["python3", str(root / "test_console.py")], env=live_env,
                               capture_output=True, text=True, timeout=90)
        if check.returncode != 0:
            log = (state / "xpra.log").read_text(errors="replace")
            raise AssertionError(check.stdout + check.stderr + '\nSession log:\n' + '\n'.join(log.splitlines()[-100:]))
        print(check.stdout.strip())
    finally:
        stopped = subprocess.run([str(root / "console.sh"), "stop"], env=env,
                                 capture_output=True, text=True, timeout=30)
        if stopped.returncode != 0 and (state / "xpra.log").exists():
            raise AssertionError("Could not stop the temporary Xpra session: " + stopped.stderr)

print("PASS: one-command manual deployment on an isolated display and port; cleanup completed")
