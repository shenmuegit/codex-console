"""Regression: selected-window capture must exclude an overlapping window."""
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import time


def check_pixels():
    import warnings
    warnings.filterwarnings('ignore', category=DeprecationWarning)
    import gi
    gi.require_version('Gtk', '3.0')
    from gi.repository import Gtk
    from xpra.x11.gtk.display_source import init_gdk_display_source
    init_gdk_display_source()
    from xpra.codecs.image import to_pil_image
    from xpra.x11.error import xsync
    from xpra.x11.shadow.backends import setup_xshm_capture
    from xpra.x11.shadow.filter import window_matches
    from xpra.x11.shadow.model import X11ShadowModel
    from xpra.x11.shadow.server import ShadowX11Server

    def settle():
        deadline = time.monotonic() + 0.2
        while time.monotonic() < deadline:
            while Gtk.events_pending():
                Gtk.main_iteration_do(False)
            time.sleep(0.01)

    def solid_window(name, colour):
        window = Gtk.Window(title=name)
        window.set_wmclass(name, name)
        window.move(70, 90)
        window.set_default_size(160, 80)
        def draw(_widget, context):
            context.set_source_rgb(*colour)
            context.paint()
            return True
        window.connect('draw', draw)
        window.show_all()
        settle()
        return window

    target = solid_window('shadow-pixels-fixture', (0, 1, 0))
    capture = setup_xshm_capture()
    with xsync:
        models = list(window_matches(['class=^shadow-pixels-fixture$'],
                                    lambda title, geometry: X11ShadowModel(capture, title, geometry)))
    assert len(models) == 1, 'Only the selected fixture must be discovered'
    model = models[0]
    overlay = None
    try:
        capture.refresh()
        image = model.get_image(0, 0, 160, 80)
        assert image is not None, 'Initial fixture capture must succeed'
        assert to_pil_image(image).convert('RGB').getpixel((80, 40)) == (0, 255, 0)
        image.free()
        overlay = solid_window('unrelated-blue-overlay', (0, 0, 1))
        capture.refresh()
        image = model.get_image(0, 0, 160, 80)
        assert image is not None, 'An overlapping window must not prevent capture'
        pixels = to_pil_image(image).convert('RGB')
        image.free()
        assert pixels.getpixel((80, 40)) == (0, 255, 0), (
            'Selected-window capture leaked an unrelated overlay instead of the green target: '
            + repr(pixels.getpixel((80, 40))))

        server = ShadowX11Server({})
        server.window_matches = ['class=^shadow-pixels-fixture$']
        server._id_to_window = {1: model}
        packet = server.do_make_screenshot_packet()
        assert packet[1:3] == (160, 80), 'Selected-window screenshots must not include the desktop'
        from io import BytesIO
        from PIL import Image
        screenshot = Image.open(BytesIO(bytes(packet[5].data))).convert('RGB')
        assert screenshot.getpixel((80, 40)) == (0, 255, 0), 'Screenshots must exclude the overlay too'

        target.move(310, 220)
        target.resize(240, 120)
        settle()
        with xsync:
            updated = list(window_matches(['class=^shadow-pixels-fixture$'],
                                          lambda title, geometry: X11ShadowModel(capture, title, geometry)))
        model.geometry = updated[0].geometry
        assert model.get_dimensions() == (240, 120), 'Fixture resize must be observed'
        image = model.get_image(0, 0, 240, 120)
        assert image is not None, 'Capture must survive moving and resizing'
        resized = to_pil_image(image).convert('RGB')
        image.free()
        assert resized.size == (240, 120) and resized.getpixel((200, 90)) == (0, 255, 0)

        target.destroy()
        settle()
        assert model.get_image(0, 0, 240, 120) is None, 'A closed window must never fall back to desktop capture'
    finally:
        model.unmanage()
        capture.clean()
        if overlay:
            overlay.destroy()
        target.destroy()
        settle()


if '--fixture' in sys.argv:
    check_pixels()
else:
    with tempfile.TemporaryDirectory(prefix='codex-shadow-pixels-') as directory:
        work = Path(directory)
        display = f':{1000 + secrets.randbelow(29000)}'
        while Path(f'/tmp/.X11-unix/X{display[1:]}').exists():
            display = f':{1000 + secrets.randbelow(29000)}'
        auth = work / 'xauthority'
        auth.touch(mode=0o600)
        subprocess.run(['xauth', '-f', str(auth), 'add', display, '.', secrets.token_hex(16)], check=True)
        env = dict(os.environ, DISPLAY=display, XAUTHORITY=str(auth), NO_AT_BRIDGE='1')
        with (work / 'display.log').open('w') as log:
            display_process = subprocess.Popen([
                'Xvfb', display, '-screen', '0', '800x600x24', '-nolisten', 'tcp', '-auth', str(auth),
            ], stdout=log, stderr=log)
            try:
                deadline = time.monotonic() + 5
                while not Path(f'/tmp/.X11-unix/X{display[1:]}').exists() and time.monotonic() < deadline:
                    time.sleep(0.05)
                subprocess.run(['/usr/bin/python3', str(Path(__file__).resolve()), '--fixture'],
                               env=env, check=True, timeout=20)
            finally:
                display_process.terminate()
                try:
                    display_process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    display_process.kill()
                    display_process.wait()
    print('PASS: capture and screenshots exclude overlapping windows; test display closed')
