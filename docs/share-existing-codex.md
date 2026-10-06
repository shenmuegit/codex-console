# Share the Codex window already open in KDE

[中文](zh-CN/share-existing-codex.md)

The normal console starts a separate Codex process on its own X11 display and
uses a dedicated Electron profile. To control the Codex process already open
in KDE, use Xpra's [shadow mode](https://xpra-org.github.io/xpra/Usage/Shadow.html)
instead. This shares the existing window and does not launch another Codex.

## Prepare and switch

The included drop-in targets the existing desktop user's KDE display `:10`,
the default Electron profile ending in `Codex`, and the normal console's HTTP
port, assets, and password file. Adjust its display, binding, paths, or TLS
arguments when your installation differs. Keep KDE logged in and unlocked;
this service does not start KDE or Codex. After a reboot, its restart policy
waits for the KDE display to become available.

On the tested Xpra 6.5.4 build, selected-window shadowing passed one extra
argument to `X11ShadowModel`. Back up the installed module, then apply
`scripts/xpra-6.5-shadow-constructor.patch` only if that exact incompatible
call is present. The patch also uses absolute X11 coordinates so KDE's window
frames do not shift the captured region or pointer position. Package upgrades
may replace these local corrections; check
the constructor again before reapplying the patch.

Selected windows are also polled once per second, even before a phone connects
or a Codex window exists. This lets the boot service discover Codex when it is
opened later, and rediscover it after it is restored or reopened. Verify this
with `python3 test_shadow_discovery.py`; its temporary display and fixture are
closed automatically and it never launches Codex.

Run the following as the desktop user after verifying shadow capture:

```bash
./console.sh prepare
mkdir -p ~/.config/systemd/user/codex-console.service.d
cp codex-console-shadow.conf ~/.config/systemd/user/codex-console.service.d/share-kde.conf
systemctl --user daemon-reload
systemctl --user restart codex-console.service
```

The restart closes the separate console process, so finish its work first.
The KDE Codex process remains running. Refresh the phone's console page after
the switch. The existing desktop window keeps its dimensions and is scaled
without stretching. Use the keyboard button for phone input. The native
picker upload overlay belongs to the separate-session mode and is not
available in shadow mode.

## Capture only Codex pixels

On the tested Xpra 6.5.4 build, selecting a window still crops pixels from the
desktop at that window's position. Another application or KDE's screen locker
can therefore replace the Codex picture even when the window metadata is correct.
The screenshot request also captures the full desktop in that build.

After the compatibility patch above, back up the installed modules and apply
`scripts/xpra-6.5-window-pixels.patch`. This reads the selected window's own
XComposite pixmap and constructs screenshots only from selected windows. It
does not fall back to desktop pixels when the window disappears. Restart the
sharing service to load the correction. Package upgrades can overwrite it.

`python3 test_shadow_capture.py` verifies real pixels on a private Xvfb display:
a blue window covering the green selected window must not appear in its capture
or screenshot. It also checks moving, resizing, and closing the selected window.
All fixture windows and the temporary display close automatically.

The KDE lock screen is excluded from the picture after this correction. KDE
still needs to be unlocked to accept mouse and keyboard input. Decide whether
to disable automatic locking for the remote desktop account or unlock it when
needed; the pixel correction does not change the account's lock settings.

## Verify and recover

Verify `server.type=Python/bindings/x11-shadow`, `features.shadow=True`, and
the captured window's `xid` against the KDE Codex window. Confirm that only
one Codex main process remains and no `--start-child` argument is present
in the Xpra service command. A temporary shadow test must be stopped before
starting the managed service on the same display.

On Debian 13 with Xpra 6.5.4, the switch was checked through authenticated
WebSocket window metadata: it captured the original KDE Codex XID and
excluded the desktop panel. The phone sizing regression and existing
`scripts/check.sh` checks cover the client change.

To return to the separate-session configuration:

```bash
rm ~/.config/systemd/user/codex-console.service.d/share-kde.conf
systemctl --user daemon-reload
systemctl --user restart codex-console.service
```

The old Electron profile and project data are retained for recovery. Closing
or minimizing the shared Codex window hides it from Xpra; reopen it in KDE.
If KDE moves to another display, update the display in the drop-in and restart
the service. Stopping Xpra shadowing leaves the desktop application running.
