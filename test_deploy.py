"""Exercise installation and configuration without changing the host's services."""
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parent


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="console deploy ")
        self.addCleanup(self.temp.cleanup)
        self.work = Path(self.temp.name)
        self.repo = self.work / "checkout with spaces"
        self.repo.mkdir()
        for name in ("console.sh", "deploy.sh", "config.example.sh", "app-watch.sh",
                     "mobile.js", "console.css", "codex-console.service", "lib", "assets"):
            source = ROOT / name
            if source.is_dir():
                shutil.copytree(source, self.repo / name)
            elif source.exists():
                shutil.copy2(source, self.repo / name)
        self.bin = self.work / "bin"
        self.bin.mkdir()
        self.events = self.work / "events.jsonl"
        runtime = self.work / "runtime"
        runtime.mkdir(mode=0o700)
        inherited = {name: value for name, value in os.environ.items()
                     if not name.startswith("CONSOLE_")}
        self.env = dict(inherited, PATH=f"{self.bin}:{os.environ['PATH']}",
                        XDG_CONFIG_HOME=str(self.work / "config"),
                        XDG_STATE_HOME=str(self.work / "state"),
                        XDG_RUNTIME_DIR=str(runtime),
                        DEPLOY_TEST_EVENTS=str(self.events))
        for name in ("CONSOLE_CONFIG", "CONSOLE_APP_BIN", "CONSOLE_STATE_DIR",
                     "CONSOLE_PORT", "CONSOLE_DISPLAY", "XPRA_HTML_DIR"):
            self.env.pop(name, None)
        self.stub("xpra", """import json, os, sys
if sys.argv[1:] == ['--version']:
    print('xpra v6.5.4-r0')
elif sys.argv[1] in ('seamless', 'info', 'stop'):
    print(json.dumps(sys.argv[1:]))
else:
    sys.exit(1)
""")
        self.stub("systemctl", """import json, os, sys
with open(os.environ['DEPLOY_TEST_EVENTS'], 'a') as out:
    out.write(json.dumps(sys.argv[1:]) + '\\n')
if 'is-active' in sys.argv or 'is-enabled' in sys.argv:
    sys.exit(1)
""")
        self.stub("loginctl", """import json, os, sys
with open(os.environ['DEPLOY_TEST_EVENTS'], 'a') as out:
    out.write(json.dumps(['loginctl'] + sys.argv[1:]) + '\\n')
""")
        self.app = self.bin / "desktop app"
        self.app.write_text("#!/bin/sh\nexit 0\n")
        self.app.chmod(0o755)

    def stub(self, name, body):
        executable = self.bin / name
        executable.write_text("#!/usr/bin/env python3\n" + body)
        executable.chmod(0o755)

    @property
    def config(self):
        return self.work / "config/codex-console/config.sh"

    def run_script(self, name, *args, success=True):
        result = subprocess.run(["bash", str(self.repo / name), *args], env=self.env,
                                capture_output=True, text=True, timeout=20)
        if success:
            self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        else:
            self.assertNotEqual(result.returncode, 0, result.stdout)
        return result

    def write_config(self, content):
        self.config.parent.mkdir(parents=True, exist_ok=True)
        self.config.write_text(content)

    def test_config_controls_endpoint_state_and_argument_boundaries(self):
        state = self.work / "private state"
        self.write_config(f"CONSOLE_APP_BIN={shlex.quote(str(self.app))}\n"
                          f"CONSOLE_STATE_DIR={shlex.quote(str(state))}\n"
                          "CONSOLE_HOST=127.0.0.1\nCONSOLE_PORT=16443\nCONSOLE_DISPLAY=:123\n"
                          "CONSOLE_TLS_NAME=192.0.2.10\n"
                          "CONSOLE_APP_ARGS=(--ozone-platform=x11 '--title=a b' '--literal=$HOME; echo nope')\n")
        args = json.loads(self.run_script("console.sh", "run").stdout)
        self.assertEqual(args[:2], ["seamless", ":123"])
        self.assertIn(f"--bind-wss=127.0.0.1:16443,auth=file:filename={state}/password", args)
        child = shlex.split(next(arg.split("=", 1)[1] for arg in args if arg.startswith("--start-child=")))
        self.assertEqual(child[:2], [str(self.repo / "app-watch.sh"), str(self.app)])
        self.assertIn("--title=a b", child)
        self.assertIn("--literal=$HOME; echo nope", child)
        self.assertFalse(any(arg.startswith("--proxy-server") for arg in child))
        certificate = subprocess.run(["openssl", "x509", "-in", str(state / "cert.pem"),
                                      "-noout", "-ext", "subjectAltName"], capture_output=True, text=True)
        self.assertIn("IP Address:192.0.2.10", certificate.stdout)
        for name in ("password", "key.pem", "cert.pem"):
            self.assertEqual((state / name).stat().st_mode & 0o777, 0o600)
        self.assertEqual(json.loads(self.run_script("console.sh", "status").stdout)[:2], ["info", ":123"])
        self.assertEqual(json.loads(self.run_script("console.sh", "stop").stdout), ["stop", ":123"])

    def test_bad_config_fails_before_writing_credentials(self):
        self.write_config(f"CONSOLE_APP_BIN={shlex.quote(str(self.app))}\nCONSOLE_PORT=70000\n")
        result = self.run_script("console.sh", "start", success=False)
        self.assertIn("CONSOLE_PORT", result.stderr)
        self.assertFalse((self.work / "state/codex-console/password").exists())

    def test_doctor_reports_missing_app_without_creating_state(self):
        self.write_config("CONSOLE_APP_BIN=/missing/desktop-app\n")
        result = self.run_script("console.sh", "doctor", success=False)
        self.assertIn("CONSOLE_APP_BIN", result.stderr)
        self.assertFalse((self.work / "state").exists())

    def test_partial_xpra_installation_fails_preflight(self):
        self.write_config(f"CONSOLE_APP_BIN={shlex.quote(str(self.app))}\n")
        package = self.work / "python/xpra"
        package.mkdir(parents=True)
        (package / "__init__.py").touch()
        self.env['PYTHONPATH'] = str(package.parent)
        result = self.run_script("console.sh", "doctor", success=False)
        self.assertIn("Xpra X11/audio", result.stderr)
        self.assertFalse((self.work / "state").exists())

    def test_missing_certificate_half_does_not_replace_existing_identity(self):
        self.write_config(f"CONSOLE_APP_BIN={shlex.quote(str(self.app))}\n")
        state = self.work / "state/codex-console"
        state.mkdir(parents=True)
        (state / "cert.pem").write_text("existing certificate")
        result = self.run_script("console.sh", "prepare", success=False)
        self.assertIn("cert.pem", result.stderr)
        self.assertEqual((state / "cert.pem").read_text(), "existing certificate")

    def test_relocated_checkout_refreshes_generated_asset_links(self):
        self.run_script("deploy.sh", "--skip-deps", "--no-service", "--no-start", "--app", str(self.app))
        relocated = self.work / "relocated checkout"
        self.repo.rename(relocated)
        self.repo = relocated
        self.run_script("console.sh", "prepare")
        link = self.work / "state/codex-console/www/mobile.js"
        self.assertEqual(link.resolve(), self.repo / "mobile.js")
        self.assertEqual(link.read_bytes(), (self.repo / "mobile.js").read_bytes())

    def test_installing_dependencies_never_runs_console_as_root(self):
        self.stub("xpra", """import json, os, sys
from pathlib import Path
ready = Path(os.environ['DEPLOY_TEST_EVENTS'] + '.installed').exists()
if sys.argv[1:] == ['--version']:
    print('xpra v6.5.4-r0' if ready else 'xpra v6.3.0')
else:
    sys.exit(1)
""")
        self.stub("sudo", """import json, os, sys
from pathlib import Path
with open(os.environ['DEPLOY_TEST_EVENTS'], 'a') as out:
    out.write(json.dumps(['sudo'] + sys.argv[1:]) + '\\n')
if sys.argv[1:3] == ['apt-get', 'install'] and 'xpra' in sys.argv:
    Path(os.environ['DEPLOY_TEST_EVENTS'] + '.installed').touch()
elif sys.argv[1:2] not in (['-v'], ['apt-get'], ['install']):
    sys.exit(2)
""")
        self.stub("curl", """import sys
from pathlib import Path
Path(sys.argv[sys.argv.index('-o') + 1]).write_text('downloaded repository data')
""")
        self.run_script("deploy.sh", "--no-service", "--no-start", "--app", str(self.app))
        events = [json.loads(line) for line in self.events.read_text().splitlines()]
        installs = [event for event in events if event[:3] == ['sudo', 'apt-get', 'install'] and 'xpra' in event]
        self.assertEqual(len(installs), 1)
        self.assertIn('xpra-html5', installs[0])
        self.assertIn('--install-recommends', installs[0])
        self.assertIn('fonts-noto-cjk', installs[0])
        self.assertFalse(any('console.sh' in value for event in events for value in event))

    def test_install_generates_portable_service_and_keeps_user_data(self):
        self.run_script("deploy.sh", "--skip-deps", "--no-start", "--app", str(self.app))
        unit = self.work / "config/systemd/user/codex-console.service"
        self.assertTrue(unit.exists())
        self.assertIn(f'WorkingDirectory={self.repo}', unit.read_text())
        self.assertIn(f'ExecStart="{self.repo}/console.sh" run', unit.read_text())
        self.assertIn(str(self.config), unit.read_text())
        self.assertEqual(self.config.stat().st_mode & 0o777, 0o600)
        self.config.write_text(self.config.read_text() + "\nCONSOLE_PORT=17443\n")
        state = self.work / "state/codex-console"
        first_password = (state / "password").read_bytes()
        first_cert = (state / "cert.pem").read_bytes()
        profile = state / "profile"
        profile.mkdir()
        (profile / "keep").write_text("signed-in data")
        self.run_script("deploy.sh", "--skip-deps", "--no-start")
        self.assertIn("CONSOLE_PORT=17443", self.config.read_text())
        self.assertEqual((state / "password").read_bytes(), first_password)
        self.assertEqual((state / "cert.pem").read_bytes(), first_cert)
        self.assertEqual((profile / "keep").read_text(), "signed-in data")
        events = [json.loads(line) for line in self.events.read_text().splitlines()]
        self.assertFalse(any("restart" in event or "start" in event for event in events))
        enable_calls = [event for event in events if 'enable' in event]
        self.assertTrue(enable_calls)
        self.assertTrue(all(event[-1] == str(unit) for event in enable_calls),
                        'Custom XDG homes need registration using the absolute unit path')
        self.run_script("deploy.sh", "uninstall")
        events = [json.loads(line) for line in self.events.read_text().splitlines()]
        self.assertIn(['--user', 'stop', 'codex-console.service'], events)
        self.assertIn(['--user', 'disable', 'codex-console.service'], events)
        stop_index = next(index for index, event in enumerate(events) if event == ['--user', 'stop', 'codex-console.service'])
        disable_index = next(index for index, event in enumerate(events) if event == ['--user', 'disable', 'codex-console.service'])
        self.assertLess(stop_index, disable_index,
                        'Stop before disabling, so linked inactive units remain resolvable')
        self.assertFalse(unit.exists())
        self.assertTrue(self.config.exists())
        self.assertEqual((state / "password").read_bytes(), first_password)
        self.assertTrue((profile / "keep").exists())

    def test_no_service_install_never_calls_systemd(self):
        self.run_script("deploy.sh", "--skip-deps", "--no-service", "--no-start", "--app", str(self.app))
        self.assertFalse(self.events.exists())
        self.assertFalse((self.work / "config/systemd/user/codex-console.service").exists())
        self.assertTrue((self.work / "state/codex-console/password").exists())

    @unittest.skipUnless(shutil.which("systemd-analyze"), "systemd-analyze is not installed")
    def test_generated_unit_is_accepted_by_systemd(self):
        self.run_script("deploy.sh", "--skip-deps", "--no-start", "--app", str(self.app))
        unit = self.work / "config/systemd/user/codex-console.service"
        result = subprocess.run(["systemd-analyze", "--user", "verify", str(unit)], env=self.env,
                                capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
