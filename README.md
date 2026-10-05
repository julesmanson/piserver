# PiServer 0.5.8-beta

> The world's only 3-headed headless monster in which a head emergeces from an included vsix for VS Code extensions.

A minimalist, config-driven HTTP server (Python 3.14.0 — Pi, hence the name), built to serve up to three independent local sites (3 heads) at once, with a VS Code statusbar extension that gives it a face. Functionality is built on Python's proven standard-library `http.server`.

> **This is a minimalist *development* server** — built for local work, not hardened for production or public internet exposure. "Minimalist" describes the codebase, not the feature list, though: it packs more than its size suggests. Configurable through `pi-config.json`:

## Features

- **Up to 3 heads, one process.** Serve up to three separate projects simultaneously — each its own host, port, and webroot (a display name is optional) — from a single `piserver.py` run. Scales down to one with zero extra config.
- **Everything config-driven.** Routes, ports, webroots, security, and MIME handling all live in `pi-config.json`. Nothing is hardcoded in `piserver.py`.
- **Self-healing paths.** The project can be moved without breaking anything — `pi-config.json` carries its own pointer to `piserver.py` and the Python interpreter to launch it with, and the VS Code extension falls back to a bounded filesystem search (and writes the answer back) if that pointer ever goes stale.
- **Built-in client-side logging.** Drop `clientside-logging.js` into any page — it auto-activates, catches JS errors (`TypeError`, `ReferenceError`, unhandled rejections, and more), and POSTs them back to the server to log.
- **Security by default.** Bearer-token auth on log writes, per-IP rate limiting, request size caps, log-injection stripping, and path-traversal checks on every file and log operation.
- **MIME whitelist, config-driven.** Serve only explicitly declared file extensions with their declared `Content-Type`, or open it up to everything — your call, one flag.
- **A face on a headless server.** The VS Code statusbar extension shows live Python/server status on two LED lights, a start/stop toggle, and a clickable LCD-style readout — click it to copy the current head's URL to your clipboard; with more than one head active, it also cycles through each head's host:port (and name, if you set one) with a soft pseudo-fade.

## Default Behaviors

| Feature | Default behavior |
|---|---|
| Multiple heads | Only `head1` is active. `head2`/`head3` exist in config but are off until you flip `"active": true`. |
| Host | No default — required explicitly for every active head. |
| Port | No default — required explicitly for every active head; two heads sharing a host:port get a named warning instead of colliding. |
| Webroot | No default — required explicitly for every active head, and never inherited from `head1`. |
| MIME whitelist | Disabled — serves every file type. Enable it to restrict serving to only the extensions you've declared. |
| Log auth token | Empty — disabled. Set one to require `Authorization: Bearer <token>` on log writes. |
| Rate limiting | 60 log-write requests per IP per minute. |
| Max request size | 65536 bytes (64KB) per log write. |
| `piserver.py` location | Self-healing — `pi-config.json`'s own `path-to-server` key, auto-repaired by the VS Code extension if the project moves and that key goes stale. |
| Python interpreter | Plain `python` on PATH, unless `path-to-python` in `pi-config.json` points somewhere specific. |
| Client-side logging | Off until you `import` or `<script>`-load `clientside-logging.js` into a page — then it auto-activates with no setup. |
| Statusbar extension | Not installed by default — see [Installation](#installation) below. Once installed, shows live status for every active head, cycling between them if more than one is on. |

## Installation

### Server

1. Requires Python 3.10+ (developed on 3.14).
2. Copy `piserver.py` and `pi-config.json` wherever you want the server to live.
3. Edit `pi-config.json`'s `body.head1` (at minimum) to set `host`, `port`, and `webroot` for the project you want served.
4. **Start:** double-click `piserver.py`. **Stop:** double-click it again — it's a toggle, and it'll ask before shutting down.

To serve a second or third project at the same time, add `head2` / `head3` entries under `body` in `pi-config.json` (each with its own `host`/`port`/`webroot`) and set `"active": true`. See the `_readme` block at the top of `pi-config.json` for every key.

### VS Code extension

Skipping the Marketplace for now — install straight from the bundled `.vsix`:

1. Grab the latest file from [`piserver-vscode-extension/vsix/`](piserver-vscode-extension/vsix/).
2. In VS Code: Extensions panel → `...` menu → **Install from VSIX...** → select the file.
   - Or from a terminal: `code --install-extension path\to\piserver-statusbar-<version>.vsix`
3. Reload or restart VS Code. The statusbar grows its LEDs, a clickable display (click to copy the current head's URL), and a Start/Stop button.

## License

MIT — see [LICENSE](LICENSE).
