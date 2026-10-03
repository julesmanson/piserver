# PiServer

> The world's only 3-headed headless monster that grows a head with an included vsix for VS Code extensions.

A minimalist, config-driven HTTP server (Python 3.14 — Pi, hence the name), built to serve up to three independent local sites at once, with a VS Code statusbar extension that gives it a face. Functionality is built on Python's proven standard-library `http.server`.

> **This is a minimalist *development* server** — built for local work, not hardened for production or public internet exposure. "Minimalist" describes the codebase, not the feature list, though: it packs more than its size suggests. What it has, and how it behaves out of the box, if you don't touch `pi-config.json`:

## Features

- **Up to 3 heads, one process.** Serve up to three separate projects simultaneously — each its own port, webroot, and name — from a single `piserver.py` run. Scales down to one with zero extra config.
- **Everything config-driven.** Routes, ports, webroots, security, and MIME handling all live in `pi-config.json`. Nothing is hardcoded in `piserver.py`.
- **Self-healing paths.** The project can be moved without breaking anything — `pi-config.json` carries its own pointer to `piserver.py` and the Python interpreter to launch it with, and the VS Code extension falls back to a bounded filesystem search (and writes the answer back) if that pointer ever goes stale.
- **Built-in client-side logging.** Drop `clientside-logging.js` into any page — it auto-activates, catches JS errors (`TypeError`, `ReferenceError`, unhandled rejections, and more), and POSTs them back to the server to log.
- **Security by default.** Bearer-token auth on log writes, per-IP rate limiting, request size caps, log-injection stripping, and path-traversal checks on every file and log operation.
- **MIME whitelist, config-driven.** Serve only explicitly declared file extensions with their declared `Content-Type`, or open it up to everything — your call, one flag.
- **A face on a headless server.** The VS Code statusbar extension shows live Python/server status as two LEDs, a start/stop toggle, and an LCD-style readout — which, with more than one head active, cycles through each head's port and project name with a soft pseudo-fade.

## Default Behaviors

| Feature | Default behavior |
|---|---|
| Multiple heads | Only `url1` is active. `url2`/`url3` exist in config but are off until you flip `"active": true`. |
| Host | `127.0.0.1` — loopback only. Set `0.0.0.0` on a head to accept connections from your network. |
| Port | `8000` for `url1`. An active `url2`/`url3` with no port set auto-increments (`+1`/`+2`) rather than colliding. |
| Webroot | No default — required explicitly for every active head, and never inherited from `url1`. |
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
3. Edit `pi-config.json`'s `urls.url1` (at minimum) to point `webroot` at the project you want served.
4. **Start:** double-click `piserver.py`. **Stop:** double-click it again — it's a toggle, and it'll ask before shutting down.

To serve a second or third project at the same time, add `url2` / `url3` entries under `urls` in `pi-config.json` and set `"active": true`. See the `_readme` block at the top of `pi-config.json` for every key.

### VS Code extension

Skipping the Marketplace for now — install straight from the bundled `.vsix`:

1. Grab the latest file from [`piserver-vscode-extension/vsix/`](piserver-vscode-extension/vsix/).
2. In VS Code: Extensions panel → `...` menu → **Install from VSIX...** → select the file.
   - Or from a terminal: `code --install-extension path\to\piserver-statusbar-<version>.vsix`
3. Reload or restart VS Code. The statusbar grows its LEDs, display, and Start/Stop button.

## License

MIT — see [LICENSE](LICENSE).
