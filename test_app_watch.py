"""Run the real supervisor with a controlled X11 probe and a real child process."""
import os
import json
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time

with tempfile.TemporaryDirectory() as directory:
    work = Path(directory)
    visible = work / "visible"
    alive = work / "display"
    launches = work / "launches"
    alive.touch()
    probe = work / "xprop"
    probe.write_text("""#!/usr/bin/env python3
import os, sys
from pathlib import Path
work = Path(os.environ['WATCH_TEST_DIR'])
if not (work / 'display').exists(): sys.exit(1)
if '-root' in sys.argv:
    print('_NET_CLIENT_LIST(WINDOW): window id # ' + ('0x123, ' if (work / 'visible').exists() else '') + '0x456')
else:
    instance = Path(os.environ['CONSOLE_STATE_DIR']) / 'profile' if sys.argv[2] == '0x123' else work / 'foreign-profile'
    print(f'WM_CLASS(STRING) = "chatgpt ({instance})", "Chatgpt"')
    print('_NET_WM_STATE(ATOM) = _NET_WM_STATE_FOCUSED')
""")
    probe.chmod(0o755)
    control = work / "xpra"
    control.write_text("""#!/usr/bin/env python3
import os, sys, json
from pathlib import Path
work = Path(os.environ['WATCH_TEST_DIR'])
with (work / 'filters').open('a') as output:
    output.write(json.dumps(sys.argv[1:]) + '\\n')
""")
    control.chmod(0o755)
    app = work / "app.py"
    app.write_text("""import os, time
from pathlib import Path
work = Path(os.environ['WATCH_TEST_DIR'])
with (work / 'launches').open('a') as output: output.write(str(os.getpid()) + '\\n')
(work / 'visible').touch()
while True: time.sleep(0.1)
""")
    command = ["bash", str(Path(__file__).with_name("app-watch.sh")), sys.executable, str(app)]
    env = dict(os.environ, PATH=f"{work}:{os.environ['PATH']}",
               XDG_STATE_HOME=str(work / "state"), CONSOLE_STATE_DIR=str(work / "custom state"),
               WATCH_TEST_DIR=str(work))
    watcher = subprocess.Popen(command, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               start_new_session=True)

    def pids():
        return launches.read_text().splitlines() if launches.exists() else []

    def wait_for_launch(count):
        deadline = time.monotonic() + 9
        while len(pids()) < count and time.monotonic() < deadline and watcher.poll() is None:
            time.sleep(0.05)
        assert len(pids()) == count, f"Missing window must reopen the app: wanted {count}, got {pids()}"

    try:
        wait_for_launch(1)
        calls = [json.loads(line) for line in (work / "filters").read_text().splitlines()]
        assert len(calls) == 1, "The window filter must be installed before launching the app"
        assert calls[0][2:6] == ["add-window-filter", "window", "class-instance", "!="]
        from xpra.server.window.filters import get_window_filter
        window_filter = get_window_filter(*calls[0][3:])
        assert not window_filter.evaluate((f"chatgpt ({work / 'custom state/profile'})", "Chatgpt"))
        assert window_filter.evaluate((f"chatgpt ({work / 'foreign-profile'})", "Chatgpt")), "Unrelated profiles must be excluded"
        duplicate = subprocess.run(command, env=env, capture_output=True, timeout=3)
        assert duplicate.returncode == 0, duplicate.stderr.decode()
        time.sleep(6)
        assert len(pids()) == 1, "A visible app must not be opened twice"
        visible.unlink()  # Closing a window can leave the desktop process running.
        wait_for_launch(2)
        visible.unlink()
        os.kill(int(pids()[-1]), signal.SIGTERM)  # The process can also exit completely.
        wait_for_launch(3)
        watcher.terminate()
        watcher.wait(timeout=2)
        assert watcher.returncode == 0, watcher.stderr.read().decode()
        for pid in pids():
            try:
                os.kill(int(pid), 0)
            except ProcessLookupError:
                continue
            raise AssertionError(f"Stopping the supervisor must not leave child {pid} running")
    finally:
        if watcher.poll() is None:
            os.killpg(watcher.pid, signal.SIGTERM)
            try:
                watcher.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(watcher.pid, signal.SIGKILL)
                watcher.wait()

print("PASS: missing windows and exited apps reopen, existing windows are reused, and shutdown cleans up")
