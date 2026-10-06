"""Deploy a temporary Xpra session with an X11 fixture, then check HTTP/WS.

Set CONSOLE_TEST_TLS=1 to check HTTPS/WSS. Uses no app account or service.
"""
import os
import json
from pathlib import Path
import random
import shlex
import socket
import subprocess
import tempfile
import time
import uuid


root = Path(__file__).resolve().parent
tls = os.environ.get('CONSOLE_TEST_TLS') == '1'
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
    fixture = work / "app.py"
    selection = work / "selection.json"
    ready = work / 'fixture.ready'
    fixture.write_text('''import gi, json, os, warnings
from pathlib import Path
gi.require_version('Gtk', '3.0')
from gi.repository import Gtk
warnings.filterwarnings('ignore', category=DeprecationWarning)
main = Gtk.Window(title='Codex test fixture')
main.set_wmclass(f"chatgpt ({os.environ['CONSOLE_STATE_DIR']}/profile)", 'Chatgpt')
main.set_default_size(800, 600)
main.show_all()
chooser = Gtk.FileChooserDialog(title='Upload fixture', action=Gtk.FileChooserAction.OPEN)
chooser.set_wmclass('ChatGPT', 'Chatgpt')
chooser.set_role('GtkFileChooserDialog')
chooser.add_buttons('Cancel', Gtk.ResponseType.CANCEL, '_Open', Gtk.ResponseType.ACCEPT)
chooser.set_default_response(Gtk.ResponseType.CANCEL)
def selected(dialog, response):
    result = Path(os.environ['UPLOAD_TEST_SELECTION'])
    temporary = result.with_suffix('.tmp')
    temporary.write_text(json.dumps({
        'response': int(response), 'path': dialog.get_filename()}))
    temporary.replace(result)
    dialog.destroy()
chooser.connect('response', selected)
chooser.show_all()
Path(os.environ['TEST_APP_READY']).touch()
Gtk.main()
''')
    app.write_text(f'#!/usr/bin/env bash\nexec python3 {shlex.quote(str(fixture))}\n')
    app.chmod(0o755)
    state = work / "state"
    config = work / "config.sh"
    config.write_text(f"CONSOLE_APP_BIN={shlex.quote(str(app))}\n"
                      f"CONSOLE_STATE_DIR={shlex.quote(str(state))}\n"
                      f"CONSOLE_DISPLAY={display}\nCONSOLE_PORT={port}\nCONSOLE_HOST=127.0.0.1\n")
    certificate = work / 'tls-cert.pem'
    if tls:
        private_key = work / 'tls-key.pem'
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
                        '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost',
                        '-keyout', str(private_key), '-out', str(certificate)],
                       check=True, capture_output=True, timeout=20)
        with config.open('a') as output:
            output.write(f'CONSOLE_TLS_CERT={shlex.quote(str(certificate))}\n'
                         f'CONSOLE_TLS_KEY={shlex.quote(str(private_key))}\n')
    inherited = {name: value for name, value in os.environ.items()
                 if not name.startswith("CONSOLE_")}
    env = dict(inherited, CONSOLE_CONFIG=str(config), XDG_RUNTIME_DIR=runtime,
               UPLOAD_TEST_SELECTION=str(selection), TEST_APP_READY=str(ready),
               XDG_CONFIG_HOME=str(work / 'desktop-config'),
               XDG_DATA_HOME=str(work / 'desktop-data'), XDG_CACHE_HOME=str(work / 'desktop-cache'))
    try:
        deployment = subprocess.run([str(root / "deploy.sh"), "--skip-deps", "--no-service"],
                                    env=env, capture_output=True, text=True, timeout=60)
        assert deployment.returncode == 0, deployment.stdout + deployment.stderr
        # Page readiness precedes app-watch's first window; wait for this fixture.
        deadline = time.monotonic() + 15
        while not ready.exists() and time.monotonic() < deadline:
            time.sleep(0.1)
        assert ready.exists(), (state / 'xpra.log').read_text(errors='replace')
        live_env = dict(env, CONSOLE_STATE_DIR=str(state), CONSOLE_PORT=str(port),
                        CONSOLE_DISPLAY=display, CONSOLE_HOST="127.0.0.1",
                        CONSOLE_TLS_CERT=str(certificate) if tls else '')
        check = subprocess.run(["python3", str(root / "test_console.py")], env=live_env,
                               capture_output=True, text=True, timeout=90)
        if check.returncode != 0:
            log = (state / "xpra.log").read_text(errors="replace")
            raise AssertionError(check.stdout + check.stderr + '\nSession log:\n' + '\n'.join(log.splitlines()[-100:]))
        print(check.stdout.strip())
        # Use the actual HTML5 hello. A Python UI client implicitly requests
        # features, masking a missing request in the browser's handshake.
        browser_hello = work / 'browser-hello.json'
        server_hello = work / 'server-hello.json'
        browser_check = subprocess.run(['node', str(root / 'test_mobile.cjs')],
            env=dict(env, CONSOLE_TEST_CLIENT_HELLO=str(browser_hello)),
            capture_output=True, text=True, timeout=60)
        assert browser_check.returncode == 0, browser_check.stdout + browser_check.stderr
        browser_caps = json.loads(browser_hello.read_text())
        # A real WS client uploads, receives the helper notification, then uses
        # the same clipboard/key packets as mobile.js in the original GTK chooser.
        from xpra.client.base.command import CommandConnectClient
        from xpra.scripts.config import make_defaults_struct
        from xpra.scripts.parsing import do_parse_cmdline, parse_display_name
        from xpra.net.connect import connect_to
        from xpra.net import packet_encoding, compression
        from xpra.os_util import gi_import
        GLib = gi_import('GLib')
        packet_encoding.init_all()
        compression.init_all()
        transport = 'wss' if tls else 'ws'
        args = ['xpra', 'info', f'{transport}://127.0.0.1:{port}/',
                '--challenge-handlers=file', f'--password-file={state / "password"}', '--splash=no']
        if tls:
            args.append(f'--ssl-ca-certs={certificate}')
            args.append('--ssl-check-hostname=no')
        options, _ = do_parse_cmdline(args, make_defaults_struct())
        request, client_id = uuid.uuid4().hex, uuid.uuid4().hex
        filename = f'cc-{client_id}-{request}--测试 空格.txt'
        contents = '原生选择框上传\n'.encode()
        completed, windows = [], {}

        class UploadCheck(CommandConnectClient):
            def make_hello(self):
                # Command clients disable keyboard in their final hello by default.
                return {'keyboard': True}

            def do_command(self, caps):
                assert caps['bandwidth']['detection'], 'Congestion detection is disabled on the actual server'
                server_hello.write_text(json.dumps({name: caps[name] for name in
                    ('version', 'rencodeplus', 'readonly', 'clipboard', 'file', 'actual_desktop_size') if name in caps}))
                assert caps['file']['enabled'] and caps['file']['open'], 'The upload completion bridge is disabled'
                self.add_packet_handler('new-window', self.window)
                self.add_packet_handler('notify_show', self.complete)
                self.add_packet_handler('clipboard-request', self.clipboard_request)
                for name in ('draw', 'window-icon', 'window-metadata', 'lost-window',
                             'encodings', 'startup-complete', 'raise-window', 'clipboard-token',
                             'clipboard-pending-requests', 'set-clipboard-enabled'):
                    self.add_packet_handler(name, lambda packet: None)
                self.path = ''
                GLib.timeout_add(12000, self.quit, 1)

            def window(self, packet):
                windows[packet[1]] = packet[6]
                self.send('map-window', packet[1], packet[2], packet[3], packet[4], packet[5], {})
                if packet[6].get('role') == 'GtkFileChooserDialog':
                    self.wid = packet[1]
                    self.send('send-file', filename, '', False, True, len(contents), contents, {})

            def key(self, name, value, code, modifiers=()):
                self.send('key-action', self.wid, name, True, list(modifiers), value, '', code, 0)
                self.send('key-action', self.wid, name, False, list(modifiers), value, '', code, 0)

            def control(self, name, value, code):
                self.send('key-action', self.wid, 'Control_L', True, [], 0xffe3, '', 17, 0)
                self.key(name, value, code, ['control'])
                self.send('key-action', self.wid, 'Control_L', False, [], 0xffe3, '', 17, 0)

            def complete(self, packet):
                assert packet[6] == 'codex-console-upload', packet
                result = json.loads(packet[7])
                self.path = result['path']
                completed.append(result)
                assert result == {'request': request, 'path': str(state / 'uploads' / request / '测试 空格.txt')}
                assert Path(self.path).read_bytes() == contents
                self.send('focus', self.wid, [])
                self.control('l', 108, 76)
                self.send('clipboard-token', 'CLIPBOARD', ['text/plain', 'UTF8_STRING'],
                          'UTF8_STRING', 'UTF8_STRING', 8, 'bytes', self.path.encode(), True, True, True)
                GLib.timeout_add(100, self.paste)

            def clipboard_request(self, packet):
                self.send('clipboard-contents', packet[1], 'CLIPBOARD', 'UTF8_STRING', 8, 'bytes', self.path.encode())

            def paste(self):
                self.control('v', 118, 86)
                GLib.timeout_add(500, self.confirm)
                return False

            def confirm(self):
                self.send('key-action', self.wid, 'Alt_L', True, [], 0xffe9, '', 18, 0)
                self.key('o', 111, 79, ['mod1'])
                self.send('key-action', self.wid, 'Alt_L', False, [], 0xffe9, '', 18, 0)
                GLib.timeout_add(100, self.selected)
                return False

            def selected(self):
                if not selection.exists():
                    return True
                self.quit(0)
                return False

        client = UploadCheck(options)
        client.hello_extra.pop('ui_client', None)
        client.hello_extra.update({'uuid': client_id, 'windows': True,
                                  'keyboard': True, 'notifications': {'enabled': True},
                                  'keymap': {'layout': 'us', 'keycodes': [[65293, 'Return', 13, 0, 0],
                                      [65507, 'Control_L', 17, 0, 0], [108, 'l', 76, 0, 0], [118, 'v', 86, 0, 0],
                                      [65513, 'Alt_L', 18, 0, 0], [111, 'o', 79, 0, 0]]},
                                  'clipboard': {'enabled': True, 'selections': ['CLIPBOARD'], 'greedy': True},
                                  'file': {'enabled': True, 'size-limit': 32 * 1024 * 1024},
                                  'encodings': {'': ['png'], 'core': ['png'], 'rgb_formats': ['RGB', 'RGBX', 'RGBA']},
                                  'metadata.supported': ['class-instance', 'pid', 'role'],
                                  'wants': browser_caps['wants'], 'sharing': True})
        client.hello_extra.update({name: browser_caps[name] for name in ('bandwidth', 'bandwidth-detection')})
        def connection_error(message):
            raise RuntimeError(message)
        client.make_protocol(connect_to(parse_display_name(connection_error, options, args[2]), options))
        code = client.run()
        if code or not completed:
            print('Server log:', '\n'.join((state / 'xpra.log').read_text().splitlines()[-40:]))
        assert code == 0 and completed, f'Upload did not reach its native chooser: {windows!r}, completions={completed!r}'
        selected = json.loads(selection.read_text())
        assert selected == {'response': -3, 'path': completed[0]['path']}, selected
        chooser = next(metadata for metadata in windows.values() if metadata.get('role') == 'GtkFileChooserDialog')
        assert chooser['class-instance'] != (f'chatgpt ({state / "profile"})', 'Chatgpt'), 'Exercise the native chooser without a profile class'
        browser_check = subprocess.run(['node', str(root / 'test_mobile.cjs')],
            env=dict(env, CONSOLE_TEST_SERVER_HELLO=str(server_hello)),
            capture_output=True, text=True, timeout=60)
        assert browser_check.returncode == 0, browser_check.stdout + browser_check.stderr
        print('PASS: browser hello → real server upload capabilities → browser native file input')
        print(f'PASS: real {transport.upper()} upload → targeted completion → Unicode clipboard → original native chooser accepts file')
    finally:
        stopped = subprocess.run([str(root / "console.sh"), "stop"], env=env,
                                 capture_output=True, text=True, timeout=30)
        if stopped.returncode != 0 and (state / "xpra.log").exists():
            raise AssertionError("Could not stop the temporary Xpra session: " + stopped.stderr)

print("PASS: one-command manual deployment on an isolated display and port; cleanup completed")
