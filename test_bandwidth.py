"""The real browser hello and launcher must enable Xpra congestion feedback."""
import json
import os
from pathlib import Path
import subprocess
import tempfile

from test_deploy import DeploymentTests

ROOT = Path(__file__).resolve().parent
with tempfile.TemporaryDirectory(prefix='console-bandwidth-') as directory:
    hello = Path(directory) / 'hello.json'
    browser = subprocess.run(['node', str(ROOT / 'test_mobile.cjs')],
        env=dict(os.environ, CONSOLE_TEST_CLIENT_HELLO=str(hello)),
        capture_output=True, text=True, timeout=30)
    assert browser.returncode == 0, browser.stdout + browser.stderr
    caps = json.loads(hello.read_text())
    from xpra.server.source.bandwidth import BandwidthConnection
    from xpra.util.objects import typedict
    assert BandwidthConnection.is_needed(typedict(caps)), 'HTML5 hello skips the bandwidth management module'
    assert caps.get('bandwidth-detection') is True, 'HTML5 hello declines congestion feedback'

    fixture = DeploymentTests()
    fixture.setUp()
    try:
        fixture.env.pop('XPRA_MIN_BANDWIDTH', None)
        fixture.env['CONSOLE_APP_BIN'] = str(fixture.app)
        fixture.stub('xpra', '''import json, os, sys
if sys.argv[1:] == ['--version']:
    print('xpra v6.5.4-r0')
else:
    print(json.dumps({'args': sys.argv[1:], 'minimum': os.environ.get('XPRA_MIN_BANDWIDTH')}))
''')
        launch = json.loads(fixture.run_script('console.sh', 'run').stdout)
        assert '--bandwidth-detection=yes' in launch['args'], 'The server disables congestion feedback by default'
        assert launch['minimum'] == '524288', 'The default 5 Mi bit/s floor defeats detection on slow mobile links'
        fixture.env['XPRA_MIN_BANDWIDTH'] = '1048576'
        assert json.loads(fixture.run_script('console.sh', 'run').stdout)['minimum'] == '1048576', \
            'An administrator-supplied detection floor must be preserved'
    finally:
        fixture.doCleanups()

    native = '''import json, sys
from types import SimpleNamespace
from xpra.scripts.config import make_defaults_struct
from xpra.scripts.parsing import do_parse_cmdline
from xpra.server.source.bandwidth import BandwidthConnection
from xpra.util.objects import typedict
data = json.load(sys.stdin)
opts, _ = do_parse_cmdline(['xpra', *data['args']], make_defaults_struct())
assert opts.bandwidth_detection
connection = BandwidthConnection()
connection.init_from(None, SimpleNamespace(bandwidth_limit=0, bandwidth_detection=opts.bandwidth_detection))
connection.init_state()
connection.protocol = SimpleNamespace(get_info=lambda: {})
connection.parse_client_caps(typedict(data['caps']))
assert connection.bandwidth_detection
window = SimpleNamespace(suspended=False, window_dimensions=(480, 928), bandwidth_limit=0,
                         statistics=SimpleNamespace(get_damage_pixels=lambda: 0))
connection.window_sources = {1: window}
connection.statistics = SimpleNamespace(avg_congestion_send_speed=750000)
connection.update_bandwidth_limits()
assert connection.soft_bandwidth_limit == 750000
assert window.bandwidth_limit == 750000, 'Congestion must lower the window budget below 1 Mbps'
connection.statistics.avg_congestion_send_speed = 50000000
connection.update_bandwidth_limits()
assert window.bandwidth_limit == 0, 'A recovered fast link must not retain a stale low bandwidth budget'
'''
    checked = subprocess.run(['python3', '-c', native], input=json.dumps({'caps': caps, 'args': launch['args']}),
        env=dict(os.environ, XPRA_MIN_BANDWIDTH=launch['minimum']),
        capture_output=True, text=True, timeout=15)
    assert checked.returncode == 0, checked.stdout + checked.stderr

print('PASS: actual HTML5 hello + launcher enable native congestion feedback, slow-link budgets and recovery')
