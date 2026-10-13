"""Read recent authenticated client network reports without exposing other logs."""
import datetime
import json
import math
from pathlib import Path
import re
import subprocess
import sys
import time

MARKER = 'codex-console-network '
NUMBERS = frozenset(('rtt_ms', 'rtt_p95_ms', 'rtt_sample_age_ms', 'jitter_ms',
    'image_kbps', 'draw_updates_per_sec', 'decode_ms', 'decode_p95_ms', 'decode_errors',
    'queued_paints', 'event_loop_lag_ms', 'reconnects', 'render_width', 'render_height',
    'render_density', 'scale'))
BOOLEANS = frozenset(('connected', 'visible', 'online', 'secure_context',
    'decode_worker', 'offscreen', 'webcodecs'))
ENCODINGS = frozenset(('rgb24', 'rgb32', 'png', 'png/P', 'png/L', 'jpeg', 'jpega',
    'webp', 'avif', 'h264', 'vp8', 'vp9', 'scroll', 'offscreen-painted'))


def number(value):
    return value if type(value) in (int, float) and math.isfinite(value) and 0 <= value <= 1e12 else None


def collect(records, now=None):
    now = time.time() if now is None else now
    latest = {}
    for timestamp, message in records:
        if not isinstance(message, str) or len(message) > 8192 or MARKER not in message:
            continue
        try:
            payload = json.loads(message.split(MARKER, 1)[1])
        except (ValueError, TypeError):
            continue
        if not isinstance(payload, dict) or type(payload.get('version')) is not int or payload['version'] != 1:
            continue
        client = payload.get('client')
        if not isinstance(client, str) or not re.fullmatch('[a-f0-9]{32}', client):
            continue
        if client in latest and latest[client][0] >= timestamp:
            continue
        report = {'version': 1, 'client': client}
        report.update((key, number(payload[key])) for key in NUMBERS if key in payload)
        report.update((key, payload[key] if type(payload[key]) is bool else None)
                      for key in BOOLEANS if key in payload)
        if 'encoding' in payload:
            coding = payload['encoding']
            report['encoding'] = coding if isinstance(coding, str) and coding in ENCODINGS else None
        hints = payload.get('network')
        report['network'] = None
        if isinstance(hints, dict):
            report['network'] = {}
            for key in ('rtt_ms', 'downlink_mbps'):
                if key in hints:
                    report['network'][key] = number(hints[key])
            if hints.get('effective_type') in ('slow-2g', '2g', '3g', '4g'):
                report['network']['effective_type'] = hints['effective_type']
            if type(hints.get('save_data')) is bool:
                report['network']['save_data'] = hints['save_data']
        age = round(max(0, now - timestamp), 2)
        report.update(age_seconds=age, stale=age > 30)
        latest[client] = timestamp, report
    return [item[1] for _, item in sorted(latest.items())]


def journal_pid(state):
    """Only use the managed service's journal when it serves this state directory."""
    try:
        result = subprocess.run(['systemctl', '--user', 'show', 'codex-console.service',
                                 '-p', 'MainPID', '--value'], capture_output=True, text=True, timeout=5)
        pid = result.stdout.strip()
        if result.returncode or not pid.isdecimal() or int(pid) <= 0:
            return None
        command = Path('/proc', pid, 'cmdline').read_bytes().decode().replace('\0', ' ')
        html = str(Path(state).resolve() / 'www')
        if re.search(r'(?:^|\s)--html=' + re.escape(html) + r'(?=\s--|\s*$)', command):
            return pid
    except (OSError, ValueError, subprocess.SubprocessError):
        pass
    return None


def read_reports(state, journal=True):
    records = []
    pid = journal_pid(state) if journal else None
    if pid:
        try:
            result = subprocess.run(['journalctl', '--user', '-u', 'codex-console.service',
                '_PID=' + pid, '--since', '-10min', '--grep', MARKER, '-n', '1000', '-o', 'json', '--no-pager'],
                capture_output=True, text=True, timeout=10)
            if result.returncode == 0:
                for line in result.stdout.splitlines():
                    try:
                        entry = json.loads(line)
                        records.append((int(entry['__REALTIME_TIMESTAMP']) / 1e6, entry['MESSAGE']))
                    except (KeyError, ValueError, TypeError):
                        continue
        except (OSError, subprocess.SubprocessError):
            pass
    logfile = Path(state) / 'xpra.log'
    try:
        with logfile.open('rb') as stream:
            stream.seek(max(0, logfile.stat().st_size - 1048576))
            for line in stream.read(1048576).decode('utf8', errors='replace').splitlines():
                if MARKER not in line:
                    continue
                try:
                    timestamp = datetime.datetime.fromisoformat(line[:23].replace(',', '.')).timestamp()
                    records.append((timestamp, line))
                except ValueError:
                    continue
    except OSError:
        pass
    return collect(records)


if __name__ == '__main__':
    print(json.dumps({'clients': read_reports(Path(sys.argv[1]))}, ensure_ascii=False, allow_nan=False))
