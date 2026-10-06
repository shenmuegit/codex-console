# Changelog

## Unreleased

### Added

- One-command Linux deployment with dependency checks, user-service generation, optional manual operation, and data-preserving uninstall.
- Private user configuration, configurable app path, host, port, display, state directory, and HTML5 assets.
- `doctor`, `prepare`, and `password` commands, isolated deployment regression tests, and a unified verification script.
- English and Simplified Chinese onboarding, deployment, configuration, and troubleshooting guides.
- MIT license, contribution and security guides, issue templates, and continuous integration.
- Dedicated app supervision that reopens a missing window and cleans up children on shutdown.
- Responsive login and connection screens, connection retry, and a touch toolbar.
- Optional native HTTPS/WSS using a supplied certificate and key, including a TLS integration check.

### Changed

- Browser access defaults to HTTP/WS; startup removes legacy certificates only without configured TLS and never creates an identity automatically.
- Startup uses the user's configuration and has no machine-specific application network arguments.
- Systemd service paths are generated from the actual checkout location.
- Audio runtime files are isolated from the host desktop and other console sessions.
- Mobile input, clipboard UTF-8, reconnect handling, quality selection, and viewport bounds have additional regression coverage.
