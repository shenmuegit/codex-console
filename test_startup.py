"""Check launch modes without creating another X11 session."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import shlex

root = Path(__file__).resolve().parent
with tempfile.TemporaryDirectory() as directory:
    work = Path(directory)
    state = work / "state" / "codex-console"
    state.mkdir(parents=True)
    for name in ("password", "cert.pem", "key.pem"):
        (state / name).write_text("test-only")
    xpra = work / "xpra"
    xpra.write_text("#!/usr/bin/env python3\nimport json, sys\nprint('xpra v6.5.4-r0' if sys.argv[1:] == ['--version'] else json.dumps(sys.argv[1:]))\n")
    xpra.chmod(0o755)
    config = work / "config/codex-console/config.sh"
    config.parent.mkdir(parents=True)
    config.write_text("CONSOLE_APP_BIN=/usr/bin/true\n")
    inherited = {name: value for name, value in os.environ.items()
                 if not name.startswith("CONSOLE_")}
    env = dict(inherited, PATH=f"{work}:{os.environ['PATH']}",
               XDG_STATE_HOME=str(work / "state"), XDG_CONFIG_HOME=str(work / "config"))
    web = state / 'www'
    web.mkdir()
    for name in ('connect.html', 'connect.html.gz', 'connect.html.br', 'clipboard.html',
                 'crypto.html', 'digest.html', 'mitm.html', 'index.html.gz', 'legacy.html'):
        (web / name).write_text('old upstream page')
    for mode, daemon in (("run", "no"), ("start", "yes")):
        result = subprocess.run([str(root / "console.sh"), mode], env=env,
                                capture_output=True, text=True, timeout=10)
        assert result.returncode == 0, f"Launch mode {mode} failed: {result.stderr}"
        arguments = json.loads(result.stdout)
        assert f"--daemon={daemon}" in arguments, "Systemd must supervise the foreground server"
        assert arguments[:2] == ["seamless", ":100"]
        child = shlex.split(next(argument.split('=', 1)[1] for argument in arguments if argument.startswith('--start-child=')))
        assert '--xdg-portal-required-version=999' in child, "Native upload must use the app-owned GTK picker"
        assert sorted(path.name for path in web.glob('*.html*')) == ['index.html'], \
            'Only the custom page may be served, including after upgrading existing assets'

print("PASS: systemd launch stays in the foreground; manual start still daemonizes")
