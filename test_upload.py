"""Check Xpra's completed-file callback, original names and notification isolation."""
import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import time

from xpra.net.common import Packet
from xpra.net.file_transfer import FileTransferHandler
from xpra.util.objects import typedict

root = Path(__file__).resolve().parent
with tempfile.TemporaryDirectory(prefix="console upload '") as directory:
    work = Path(directory)
    inbox = work / "uploads"
    inbox.mkdir(mode=0o700)
    record = work / "notification.json"
    xpra = work / "xpra"
    xpra.write_text("#!/usr/bin/env python3\nimport json, os, sys\n"
                    "from pathlib import Path\n"
                    "Path(os.environ['UPLOAD_TEST_RECORD']).write_text(json.dumps(sys.argv[1:]))\n")
    xpra.chmod(0o755)
    env = dict(os.environ, PATH=f"{work}:{os.environ['PATH']}",
               XPRA_DOWNLOAD_DIR=str(inbox), UPLOAD_TEST_RECORD=str(record), DISPLAY=":12345")
    command = ["python3", str(root / "upload.py"), str(inbox)]
    assert (root / "upload.py").is_file(), "Uploads need a completion handler before selecting them in Codex"
    os.environ.update(env)
    transfer = FileTransferHandler()
    transfer.init_attributes('yes', '1M', 'no', 'yes', 'no', shlex.join(command), False)
    client = "a" * 32
    request = "b" * 32
    name = f"cc-{client}-{request}--测试 空格.txt"
    contents = "上传完成后才可选择\n".encode()
    transfer._process_file_send(Packet("send-file", name, "text/plain", False, True,
                                      len(contents), contents, typedict(), ""))
    deadline = time.monotonic() + 5
    while not record.exists() and time.monotonic() < deadline:
        time.sleep(.02)
    assert record.exists(), "Xpra's completion must notify the originating browser"
    args = json.loads(record.read_text())
    assert args[:3] == ["control", ":12345", "send-notification"], args
    assert args[-1] == client, "Completion must target only the sending client"
    assert args[4] == "codex-console-upload"
    result = json.loads(args[5])
    saved = inbox / request / "测试 空格.txt"
    assert result == {"request": request, "path": str(saved)}, result
    assert saved.read_bytes() == contents, "Only a completely saved file may be selected"
    assert not (inbox / name).exists(), "Codex must receive the original filename"
    assert saved.stat().st_mode & 0o077 == 0, "Uploaded files must stay private"
    for source in (work / name, inbox / "unrelated.txt"):
        source.write_bytes(b"keep me")
        record.unlink(missing_ok=True)
        invalid = subprocess.run(command + [str(source)], env=env, capture_output=True, timeout=5)
        assert invalid.returncode != 0, "Unrelated files must not invoke the native picker"
        assert source.read_bytes() == b"keep me"
        assert not record.exists(), "Invalid completion must not emit a notification"
    transfer.cleanup()

print("PASS: real Xpra upload completion, private original filenames and targeted notification")
