"""Xpra open-command: report a completed upload without opening its contents."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys


def complete(inbox, filename):
    inbox = Path(inbox).resolve(strict=True)
    source = Path(filename)
    if source.is_symlink() or source.resolve(strict=True).parent != inbox or not source.is_file():
        raise ValueError("Upload is outside the inbox")
    match = re.fullmatch(r"cc-([a-f0-9]{32})-([a-f0-9]{32})--([^/\x00-\x1f]+)", source.name)
    if not match or match[3] in (".", ".."):
        raise ValueError("Unrecognized upload")
    client, request, name = match.groups()
    destination = inbox / request
    destination.mkdir(mode=0o700)  # Never overwrite an earlier request's attachment.
    saved = destination / name
    source.chmod(0o600)
    source.rename(saved)
    body = json.dumps({"request": request, "path": str(saved)}, ensure_ascii=False)
    subprocess.run(["xpra", "control", os.environ["DISPLAY"], "send-notification", "7271",
                    "codex-console-upload", body, client], check=True, timeout=15,
                   stdout=subprocess.DEVNULL)


if __name__ == "__main__":
    try:
        complete(*sys.argv[1:])
    except (ValueError, OSError, KeyError, subprocess.SubprocessError) as error:
        print(f"Upload completion failed: {error}", file=sys.stderr)
        sys.exit(1)
