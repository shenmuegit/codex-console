# Troubleshooting

[中文](zh-CN/troubleshooting.md) · [README](../README.md) · [Deployment](deployment.md)

## Start with configuration and logs

```bash
./console.sh doctor
systemctl --user status codex-console.service --no-pager
journalctl --user -u codex-console.service -n 100 --no-pager
```

`doctor` performs read-only checks and prints the selected config, app, listener, display, and state path. For manual sessions, use `./console.sh status` and the state's `xpra.log`. Check each command's exit status; a generated login page alone does not prove the app launched.

## Installation problems

| Symptom | Resolution |
| --- | --- |
| Asked to run as desktop user | Run `./deploy.sh` without sudo; it elevates only package operations |
| App not found | Install the compatible desktop app, then pass `--app /absolute/path/to/chatgpt` |
| Unsupported distribution | Install the runtime manually and use `--skip-deps`; read the supported-host list |
| APT cannot download | Check connectivity to the configured package repositories; rerun after resolving it |
| APT cannot find codecs/packages on Ubuntu | Check that `universe` is enabled and the Xpra repository matches the OS codename |
| Xpra older than 6.5 or version 7.x | Select a supported 6.x package version; do not bypass the version check |
| Missing HTML5 assets | Install `xpra-html5`, or set `XPRA_HTML_DIR` to the installation's web root |
| Unsupported HTML5 layout | Use the tested `19-r1` client, or validate/adapt the integration before upgrading |
| Configuration parsing fails | Run `bash -n` on the config; quote paths and use a Bash array for app arguments |

The installer retains existing Xpra package sources. If an old source selects incompatible packages, fix it using the [official guide](https://github.com/Xpra-org/xpra/wiki/Download), then retry deployment.

## Service does not start

If `systemctl --user` cannot connect to its bus, run from a normal login for the target user. For a host without a user service manager, use `--no-service` and manage the process separately.

If the display is occupied, check existing sessions:

```bash
xpra list
./console.sh status
```

Stop a previous manual console using its original configuration before enabling the service. Do not stop an unrelated display. You can assign another unused `CONSOLE_DISPLAY` and port.

If the service starts only after login, check `loginctl show-user "$(id -un)" -p Linger` and enable lingering as described in the deployment guide. If you moved the checkout, rerun deployment from its current location. Copying the `.service` template directly leaves unresolved tokens and cannot start the app.

## Browser cannot connect

1. Confirm the service is running and the host address/port match `doctor`.
2. Use `https://`, and ensure the browser device can reach the host. Check VPN routing, Wi-Fi client isolation, and the host firewall.
3. Inspect the listener with `ss -ltn`; local-only binding to `127.0.0.1` cannot accept connections from your phone.
4. Check certificate trust and the hostname in the certificate. The default self-signed certificate is not automatically trusted by a browser.

If the login page opens but the connection fails, inspect browser console errors and Xpra logs for WebSocket/TLS or authentication errors. Both page requests and the WSS connection use the same configured port.

## Password rejected

Run `./console.sh password` on the host using the same config path as the service. Do not use your desktop app account password. Check `systemctl --user cat codex-console.service` if you have multiple config files.

After changing the password file, restart the managed service and reload the browser page. Passwords are not stored persistently in the browser. An authentication rejection clears the page's cached password so you can enter the correct one.

## Connected, but no app window

Check that the app is executable and matches the [window-class integration](deployment.md#desktop-app-compatibility). Keep the X11 argument in the app's arguments. Read `xpra.log` for the app's startup errors and missing shared libraries. A build using a different class or profile identity is intentionally filtered out.

Closing the app window normally triggers reopening. To stop the application for maintenance, stop the service or the manual Xpra session. The dedicated profile stores login state separately; account login may be needed again after moving data or changing the profile directory.

## Sign-in waits for a browser that never appears

The desktop app opens its login page in the host's default browser. On this
console, Firefox ESR windows are forwarded even when `xdg-open` launches them
outside the app supervisor. The browser allowance must precede the parent
process filter; other desktop app profiles remain excluded.

Use Firefox ESR as the default HTTP/HTTPS handler on the host. If the service
was already running when this fix was installed, restart it during a suitable
maintenance window and reconnect the console. Complete the account login in
the displayed Firefox window. The console access password and account login
are separate.

## Input, gestures, or display problems

| Symptom | Resolution |
| --- | --- |
| Composed text not submitted | Focus the remote text field, confirm the connection is ready and clipboard forwarding is enabled |
| Text held during disconnection | Reconnect and submit again; unsubmitted input remains in the local field |
| Drag happens instead of scroll | Tap once, then hold the second touch while sliding |
| Right-click triggers unexpectedly | Avoid a second rapid tap when you intend a single click; the double-tap interval is about 180 ms |
| Keyboard covers the field | Use the native keyboard control and a browser supporting `visualViewport` |
| Incorrect taps on an older small display | Restart the session to use the 4096 × 4096 Xvfb configuration |
| UI slow over the network | Choose Smooth; check host CPU load and link quality |
| Old UI after updating | Rerun deployment to rebuild assets, restart, and refresh the browser |

## Audio problems

Enable audio in the toolbar and tap the page to allow browser playback. Check device volume, PulseAudio, and GStreamer codecs on the host. `./console.sh status` should include session/window information; detailed `xpra info <display>` can show audio initialization but may also contain private metadata.

For a live check, use `./scripts/check.sh --live` when the session can tolerate an additional client and a brief test tone. The check requires Opus/WebM and AAC/MP4 support. Microphone forwarding is disabled by the launcher.

## Reporting a problem

Include OS/architecture, Xpra and HTML5 package versions, browser/device versions, installation command, reproduction steps, and relevant errors. Remove access passwords, private keys, account details, window titles, project paths, and screenshots containing private work before sharing. Use [GitHub Issues](https://github.com/shenmuegit/codex-console/issues) for ordinary bugs; follow [Security](../SECURITY.md) for sensitive reports.
