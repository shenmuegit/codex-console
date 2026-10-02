"""Run after ./console.sh start; verifies the real remote-control endpoint."""
import http.client
import array
import cmath
import os
from pathlib import Path
import re
import socket
import ssl
import subprocess
import tempfile

state = Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local/state")) / "codex-console"
with socket.socket() as connection:
    assert connection.connect_ex(("127.0.0.1", 15443)) == 0, "Codex console is not listening"

context = ssl.create_default_context(cafile=str(state / "cert.pem"))
connection = http.client.HTTPSConnection("localhost", 15443, context=context, timeout=10)
connection.request("GET", "/")
response = connection.getresponse()
content = response.read()
assert response.status == 200 and b"Xpra" in content, "HTML5 client is unavailable"
assert b"mobile.js?v=" in content, "The touch and browser-size fix is not loaded"
assert b'id="performance_profile"' in content, "The quality and responsiveness selector is missing"
connection.request("GET", "/mobile.js")
response = connection.getresponse()
assert response.status == 200, "The touch and browser-size script is unavailable"
assert response.read() == Path(__file__).with_name("mobile.js").read_bytes(), "The server is serving an old fix"
connection.request("GET", "/Info")
response = connection.getresponse()
assert response.status == 404, "Session metadata is exposed without authentication"
response.read()
connection.close()

command = ["xpra", "info", "wss://localhost:15443/",
           f"--ssl-ca-certs={state / 'cert.pem'}", "--challenge-handlers=file", "--splash=no"]
result = subprocess.run(command + [f"--password-file={state / 'password'}"],
                        capture_output=True, text=True, timeout=20)
assert result.returncode == 0, result.stderr
assert re.search(r"windows\.\d+\.class-instance=.*(?:codex|chatgpt)", result.stdout, re.I), "Codex window is missing"
assert "audio.initialized=True" in result.stdout, "Audio forwarding is not initialized"
assert re.search(r"pulseaudio\.pid=[1-9]\d*", result.stdout), "The session audio server is missing"
assert all(codec in result.stdout for codec in ("opus+mka", "aac+mpeg4")), "Browser audio codecs are missing"
font_dpi = int(re.search(r"^display\.dpi\.value=(\d+)$", result.stdout, re.M)[1])
if font_dpi:
    resources = subprocess.run(["xrdb", "-display", ":100", "-query"], capture_output=True, text=True, timeout=10)
    assert resources.returncode == 0, resources.stderr
    assert re.search(rf"^Xft\.dpi:\s*{font_dpi}$", resources.stdout, re.M), "Font DPI does not match the selected rendering density"
audio_directory = re.search(r"^pulseaudio\.server-directory=(.+)$", result.stdout, re.M)
assert audio_directory, "The session audio socket is missing"
audio_server = f"unix:{audio_directory[1]}/native"
display_info = subprocess.run(["xdpyinfo", "-display", ":100"], capture_output=True, text=True, timeout=10)
assert display_info.returncode == 0, display_info.stderr
assert "1280x900 pixels" in display_info.stdout, "The virtual screen should remain fixed while the webpage scales"
assert "96x96 dots per inch" in display_info.stdout, "The virtual screen DPI is incorrect"
with tempfile.NamedTemporaryFile(mode="w") as wrong_password:
    wrong_password.write("incorrect-password")
    wrong_password.flush()
    result = subprocess.run(command + [f"--password-file={wrong_password.name}"],
                            capture_output=True, text=True, timeout=20)
    assert result.returncode != 0 and "authentication failed" in result.stderr.lower(), result.stderr

for name in ("password", "key.pem"):
    assert (state / name).stat().st_mode & 0o077 == 0, f"{name} must be private"

# Receive the same Opus/WebM stream as the HTML5 client and decode a known test tone.
from xpra.client.base.command import CommandConnectClient
from xpra.scripts.config import make_defaults_struct
from xpra.scripts.parsing import do_parse_cmdline, parse_display_name
from xpra.net.connect import connect_to
from xpra.net import packet_encoding, compression
from xpra.os_util import gi_import

GLib = gi_import("GLib")
packet_encoding.init_all()
compression.init_all()
options, _ = do_parse_cmdline(command + [f"--password-file={state / 'password'}"], make_defaults_struct())
chunks, playback = [], []

class AudioCheck(CommandConnectClient):
    def do_command(self, caps):
        assert caps["audio"]["send"], "Speaker forwarding is disabled"
        assert not caps["audio"]["receive"], "Microphone forwarding should be disabled"
        self.add_packet_handler("sound-data", self.receive_audio)
        self.add_packet_handler("audio-data", self.receive_audio)
        self.add_packet_handler("startup-complete", lambda packet: None)
        self.send("sound-control", "start", "opus+mka")
        GLib.timeout_add(1000, self.play_tone)
        GLib.timeout_add(5000, self.quit, 0)

    def play_tone(self):
        playback.append(subprocess.Popen([
            "gst-launch-1.0", "-q", "audiotestsrc", "freq=440", "volume=0.15",
            "num-buffers=150", "samplesperbuffer=441", "!", "audio/x-raw,rate=44100",
            "!", "audioconvert", "!", "pulsesink", f"server={audio_server}", "device=Xpra-Speaker",
        ], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE))
        return False

    def receive_audio(self, packet):
        assert packet[1] == "opus+mka", "Unexpected audio codec"
        if len(packet) > 4:
            chunks.extend(bytes(chunk) for chunk in packet[4])
        if packet[2]:
            chunks.append(bytes(packet[2]))
        if packet[3].get("end-of-stream"):
            self.quit(1)

client = AudioCheck(options)
client.hello_extra.update({"audio": {"receive": True, "send": False, "decoders": ["opus+mka"]},
                          "wants": ["audio"], "sharing": True})
def connection_error(message):
    raise RuntimeError(message)
client.make_protocol(connect_to(parse_display_name(connection_error, options, command[2]), options))
GLib.timeout_add(12000, client.quit, 1)
exit_code = client.run()
for process in playback:
    _, errors = process.communicate(timeout=5)
    assert process.returncode == 0, errors.decode()
assert exit_code == 0 and chunks, "No audio received over the authenticated connection"
decoded = subprocess.run([
    "gst-launch-1.0", "-q", "fdsrc", "!", "decodebin", "!", "audioconvert", "!", "audioresample",
    "!", "audio/x-raw,format=S16LE,channels=1,rate=48000", "!", "fdsink", "fd=1",
], input=b"".join(chunks), capture_output=True, timeout=10)
assert decoded.returncode == 0, decoded.stderr.decode()
samples = array.array("h")
samples.frombytes(decoded.stdout)
assert samples, "The received stream could not be decoded"
amplitude = 2 * abs(sum(value * cmath.exp(-2j * cmath.pi * 440 * i / 48000)
                        for i, value in enumerate(samples))) / len(samples)
assert amplitude > 100, "The session's 440 Hz test tone was not transmitted"
print("PASS: HTTPS, authentication, Codex window, and decoded session audio over WSS")
