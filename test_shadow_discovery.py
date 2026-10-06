"""Check discovery after an empty shadow session starts, without launching Codex."""
import os
from pathlib import Path
import secrets
import socket
import subprocess
import tempfile
import time


with tempfile.TemporaryDirectory(prefix='codex-shadow-discovery-') as directory:
    work = Path(directory)
    display = f':{1000 + secrets.randbelow(29000)}'
    while Path(f'/tmp/.X11-unix/X{display[1:]}').exists():
        display = f':{1000 + secrets.randbelow(29000)}'
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    auth = work / 'xauthority'
    auth.touch(mode=0o600)
    subprocess.run(['xauth', '-f', str(auth), 'add', display, '.', secrets.token_hex(16)], check=True)
    password = work / 'password'
    password.write_text(secrets.token_hex(16))
    password.chmod(0o600)
    env = dict(os.environ, DISPLAY=display, XAUTHORITY=str(auth), NO_AT_BRIDGE='1')
    processes = []
    with (work / 'server.log').open('w') as log:
        try:
            processes.append(subprocess.Popen(['Xvfb', display, '-screen', '0', '800x600x24',
                                               '-nolisten', 'tcp', '-auth', str(auth)],
                                              stdout=log, stderr=log))
            deadline = time.monotonic() + 5
            while not Path(f'/tmp/.X11-unix/X{display[1:]}').exists() and time.monotonic() < deadline:
                time.sleep(0.05)
            processes.append(subprocess.Popen([
                'xpra', 'shadow', display + ',windows=class=^shadow-discovery-fixture$',
                f'--bind-ws=127.0.0.1:{port},auth=file:filename={password}', '--ssl=no',
                '--daemon=no', '--attach=no', '--systemd-run=no', '--start-via-proxy=no',
                '--tray=no', '--notifications=no', '--mdns=no', '--audio=no', '--pulseaudio=no',
                '--webcam=no', '--printing=no', '--file-transfer=no', '--open-url=no',
                '--start-new-commands=no', '--shell=no', '--exit-with-client=no',
                '--exit-with-children=no', '--terminate-children=no',
            ], env=env, stdout=log, stderr=log))
            probe = ['xpra', 'info', f'ws://127.0.0.1:{port}/',
                     f'--password-file={password}', '--splash=no']
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                result = subprocess.run(probe, env=env, capture_output=True, text=True, timeout=15)
                if result.returncode == 0:
                    break
                time.sleep(0.1)
            assert result.returncode == 0, 'Shadow server did not become ready'
            assert 'windows.1.title=' not in result.stdout, 'The fixture must not exist at startup'
            processes.append(subprocess.Popen(['python3', '-c', """
import warnings
warnings.filterwarnings('ignore', category=DeprecationWarning)
import gi
gi.require_version('Gtk', '3.0')
from gi.repository import Gtk
window = Gtk.Window(title='Shadow discovery fixture')
window.set_wmclass('shadow-discovery-fixture', 'ShadowDiscoveryFixture')
window.set_default_size(160, 80)
window.show_all()
Gtk.main()
"""], env=env, stdout=log, stderr=log))
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                result = subprocess.run(probe, env=env, capture_output=True, text=True, timeout=3)
                if 'title=Shadow discovery fixture' in result.stdout:
                    break
                time.sleep(0.2)
            assert 'title=Shadow discovery fixture' in result.stdout, 'A window opened after shadow startup must be discovered without restarting Xpra'
        except Exception as error:
            log.flush()
            details = '\n'.join((work / 'server.log').read_text(errors='replace').splitlines()[-25:])
            raise AssertionError(str(error) + '\nShadow log:\n' + details) from error
        finally:
            for process in reversed(processes):
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()

print('PASS: an initially empty shadow session discovers a later window; all test processes closed')
