"""Network reports must be bounded, fresh, isolated and safe to print."""
import json
import os
from pathlib import Path
import random
import shlex
import socket
import ssl
import http.client
import subprocess
import sys
import tempfile
import time
from unittest.mock import patch
from types import SimpleNamespace

from network import collect, read_reports, journal_pid


def message(client, **fields):
    return 'client 4 @01.000 codex-console-network ' + json.dumps({
        'version': 1, 'client': client, 'connected': True,
        'rtt_ms': 80, 'decode_ms': 5, 'network': None, **fields})


records = [(100, message('a' * 32)), (110, message('b' * 32, rtt_ms=200)),
           (120, message('a' * 32, rtt_ms=100, password='do-not-print',
                         window_title='private title', network={'effective_type': '4g', 'url': 'private'})),
           (125, 'ordinary log'), (125, 'codex-console-network {broken'),
           (125, message('invalid-id')), (125, message('c' * 32, rtt_ms=-1))]
reports = collect(records, now=125)
assert len(reports) == 3
first = next(report for report in reports if report['client'] == 'a' * 32)
assert first['rtt_ms'] == 100 and first['age_seconds'] == 5 and not first['stale']
assert first['network'] == {'effective_type': '4g'}
assert 'do-not-print' not in json.dumps(reports) and 'private title' not in json.dumps(reports)
assert next(report for report in reports if report['client'] == 'c' * 32)['rtt_ms'] is None
assert collect([(100, message('a' * 32))], now=140)[0]['stale']
assert collect([(130, message('a' * 32)), (120, message('a' * 32))], now=140)[0]['age_seconds'] == 10
assert collect([(100, message('a' * 32, rtt_ms=True))], now=100)[0]['rtt_ms'] is None
assert collect([(100, message('a' * 32, encoding=[]))], now=100)[0]['encoding'] is None

with patch('network.subprocess.run', return_value=SimpleNamespace(returncode=0, stdout='123\n')), \
        patch('network.Path.read_bytes', return_value=b'xpra seamless :100 --html=/tmp/live state/www --daemon=no\0'):
    assert journal_pid(Path('/tmp/live state')) == '123'
    assert journal_pid(Path('/tmp/other-state')) is None, 'An alternate instance must not read service reports'

with tempfile.TemporaryDirectory() as directory:
    state = Path(directory)
    logfile = state / 'xpra.log'
    logfile.write_text('old unrelated log\n' * 100000 +
                       '2026-10-06 16:00:00,000 ' + message('a' * 32) + '\n')
    result = read_reports(state, journal=False)
    assert len(result) == 1 and result[0]['client'] == 'a' * 32
    logfile.unlink()
    assert read_reports(state, journal=False) == []
    config = state / 'config.sh'
    config.write_text(f'CONSOLE_STATE_DIR={shlex.quote(str(state))}\n'
                      'CONSOLE_TLS_CERT=/missing-cert\nCONSOLE_TLS_KEY=/missing-key\n')
    env = {name: value for name, value in os.environ.items() if not name.startswith('CONSOLE_')}
    checked = subprocess.run([str(Path(__file__).with_name('console.sh')), 'network'],
        env=dict(env, CONSOLE_CONFIG=str(config)), capture_output=True, text=True, timeout=15)
    assert checked.returncode == 0 and json.loads(checked.stdout) == {'clients': []}, checked.stderr

print('PASS: latest reports per client, stale/unknown values, private-field filtering and bounded manual-log reads')


def live():
    """An isolated real TLS session accepts the browser report after password authentication."""
    root = Path(__file__).resolve().parent
    with tempfile.TemporaryDirectory(prefix='console-network-') as directory:
        work = Path(directory)
        state = work / 'state'
        certificate, key = work / 'cert.pem', work / 'key.pem'
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
                        '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1',
                        '-keyout', str(key), '-out', str(certificate)], check=True, capture_output=True, timeout=20)
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            port = listener.getsockname()[1]
        display = random.randrange(1000, 30000)
        while Path(f'/tmp/.X11-unix/X{display}').exists() or Path(f'/tmp/.X{display}-lock').exists():
            display = random.randrange(1000, 30000)
        config = work / 'config.sh'
        config.write_text(f'CONSOLE_STATE_DIR={state}\nCONSOLE_APP_BIN=/usr/bin/true\n'
                          f'CONSOLE_DISPLAY=:{display}\nCONSOLE_HOST=127.0.0.1\nCONSOLE_PORT={port}\n'
                          f'CONSOLE_TLS_CERT={certificate}\nCONSOLE_TLS_KEY={key}\n')
        env = {name: value for name, value in os.environ.items() if not name.startswith('CONSOLE_')}
        env.update(CONSOLE_CONFIG=str(config))
        prepared = subprocess.run([str(root / 'console.sh'), 'prepare'], env=env,
                                  capture_output=True, text=True, timeout=30)
        assert prepared.returncode == 0, prepared.stdout + prepared.stderr
        report_file = work / 'report.txt'
        subprocess.run(['node', str(root / 'test_network.cjs')],
                       env=dict(env, CONSOLE_TEST_NETWORK_REPORT=str(report_file)),
                       check=True, capture_output=True, timeout=30)
        try:
            started = subprocess.run(['xpra', 'seamless', f':{display}',
                f'--bind-wss=127.0.0.1:{port},auth=file:filename={state / "password"}',
                '--ssl=on', f'--ssl-cert={certificate}', f'--ssl-key={key}',
                f'--html={state / "www"}', '--http-scripts=off', '--mdns=no', '--audio=no',
                '--daemon=yes', '--attach=no', '--systemd-run=no', '--start-via-proxy=no',
                '--use-display=no', f'--log-dir={state}', '--log-file=xpra.log'],
                env=env, capture_output=True, text=True, timeout=30)
            assert started.returncode == 0, started.stdout + started.stderr
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                with socket.socket() as probe:
                    if probe.connect_ex(('127.0.0.1', port)) == 0:
                        break
                time.sleep(0.1)
            else:
                raise AssertionError('TLS listener did not start: ' + (state / 'xpra.log').read_text())
            connection = http.client.HTTPSConnection('127.0.0.1', port, timeout=10,
                                               context=ssl.create_default_context(cafile=certificate))
            connection.request('GET', '/')
            page = connection.getresponse()
            assert page.status == 200 and b'network.js?v=' in page.read()
            connection.request('GET', '/network.js')
            asset = connection.getresponse()
            assert asset.status == 200 and asset.read() == (root / 'network.js').read_bytes()
            connection.request('GET', '/Info')
            info = connection.getresponse()
            assert info.status == 404, 'Network diagnostics must not enable public session metadata'
            info.read()
            connection.close()

            from xpra.client.base.command import CommandConnectClient
            from xpra.scripts.config import make_defaults_struct
            from xpra.scripts.parsing import do_parse_cmdline, parse_display_name
            from xpra.net.connect import connect_to
            from xpra.net import packet_encoding, compression
            from xpra.os_util import gi_import
            GLib = gi_import('GLib')
            packet_encoding.init_all()
            compression.init_all()
            args = ['xpra', 'info', f'wss://127.0.0.1:{port}/', '--challenge-handlers=file',
                    f'--password-file={state / "password"}', f'--ssl-ca-certs={certificate}', '--splash=no']
            options, _ = do_parse_cmdline(args, make_defaults_struct())
            received = []

            class NetworkCheck(CommandConnectClient):
                def do_command(self, caps):
                    assert caps['remote-logging']['receive'], 'The authenticated collector is unavailable'
                    received.append(True)
                    for name in ('startup-complete', 'encodings'):
                        self.add_packet_handler(name, lambda packet: None)
                    self.send('logging', 20, report_file.read_text())
                    GLib.timeout_add(500, self.quit, 0)

            client = NetworkCheck(options)
            client.hello_extra['wants'] = ['features']
            client.hello_extra['uuid'] = 'a' * 32
            def connection_error(message):
                raise RuntimeError(message)
            client.make_protocol(connect_to(parse_display_name(connection_error, options, args[2]), options))
            assert client.run() == 0 and received, 'The report was not authenticated and sent'
            deadline = time.monotonic() + 5
            reports = []
            while not reports and time.monotonic() < deadline:
                checked = subprocess.run([str(root / 'console.sh'), 'network'], env=env,
                                         capture_output=True, text=True, timeout=15)
                assert checked.returncode == 0, checked.stderr
                reports = json.loads(checked.stdout)['clients']
                if not reports:
                    time.sleep(0.1)
            assert len(reports) == 1 and reports[0]['client'] == 'a' * 32, (state / 'xpra.log').read_text()
            assert reports[0]['rtt_ms'] == 120 and reports[0]['decode_ms'] == 5 and not reports[0]['stale']
            wrong = work / 'wrong-password'
            wrong.write_text('incorrect-password')
            rejected = subprocess.run([arg if not arg.startswith('--password-file=') else f'--password-file={wrong}'
                                       for arg in args], capture_output=True, text=True, timeout=20)
            assert rejected.returncode != 0 and 'authentication failed' in rejected.stderr.lower(), rejected.stderr
            print('PASS: trusted HTTPS assets → password-authenticated WSS browser report → isolated CLI JSON; wrong password rejected')
        finally:
            stopped = subprocess.run(['xpra', 'stop', f':{display}'], env=env,
                                     capture_output=True, text=True, timeout=30)
            assert stopped.returncode == 0, stopped.stderr


if __name__ == '__main__' and '--live' in sys.argv[1:]:
    live()
