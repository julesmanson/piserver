#!/usr/bin/env python3
"""
PiServer 0.1.0 lovingly made with Python Pi (Pi for version 3.14.0)
=============================
Requires Python 3.10 or later (for X | Y union type hint syntax).
A minimalist singleton HTTP server with config-driven webroot and optional settings.
Complete client-side logging and an optional config-driven MIME whitelist.
HOW TO START — pick one:

  1. Double-click this file in File Explorer               <- easiest
     Opens its own window. Closing that window stops the server.
     Closing any other terminal you have open will NOT affect it.

  2. In any terminal:  python piserver.py
     Runs inside the terminal you typed it in.
     Keep that terminal open — closing it stops the server.
     Press Ctrl+C inside the terminal to stop cleanly.

  3. In PowerShell — starts in its own window, no terminal needed:
     Start-Process python -ArgumentList "piserver.py" -WorkingDirectory "<full path to this folder>"

  4. In PowerShell — silent, no window at all, runs in background:
     Start-Process pythonw -ArgumentList "piserver.py" -WorkingDirectory "<full path to this folder>" -WindowStyle Hidden
     Nothing visible while running. To stop it later:
     Get-Process pythonw | Stop-Process

HOW TO STOP:

  Double-clicking this file while the server is already running sends it a clean shutdown signal.
  Double-click is a toggle — starts if stopped, stops if running.
  You can also just close the window the server is running in, or press Ctrl+C in the terminal.

Route paths live in pi-config.json under "routes".
No route string is hardcoded in this file.
"""

import json
import mimetypes
import os
import shutil
import sys
import time
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
BASE_DIR = Path(__file__).resolve().parent
CONFIG_PATH = BASE_DIR / "pi-config.json"
LOCK_PATH = BASE_DIR / ".piserver.lock"

# Per-file write locks — keyed by resolved path string so concurrent writes
# to the same log file are always serialized without blocking other files.
_log_locks: dict = {}
_log_locks_guard = threading.Lock()

# Rate limiting — fixed window per IP address.
_rate_limit: dict = {}
_rate_lock = threading.Lock()

# Every active head's ThreadingHTTPServer — a /shutdown hit on any one of
# them tears down all of them, since they're one logical PiServer process.
ALL_SERVERS: list = []


def _lock_for(path: Path) -> threading.Lock:
    with _log_locks_guard:
        return _log_locks.setdefault(str(path), threading.Lock())


# ---------------------------------------------------------------------------
# User-facing alerts
# ---------------------------------------------------------------------------
def alert(message: str) -> None:
    try:
        import tkinter as tk
        from tkinter import messagebox
        root = tk.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        messagebox.showinfo("PiServer", message)
        root.destroy()
    except Exception:
        print(f"[PiServer] {message}")


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
def load_config() -> dict:
    if not CONFIG_PATH.exists():
        alert(f"PiServer could not find {CONFIG_PATH.name}. Aborting.")
        sys.exit(1)
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except json.JSONDecodeError as exc:
        alert(f"{CONFIG_PATH.name} is not valid JSON: {exc}")
        sys.exit(1)


# ---------------------------------------------------------------------------
# Singleton / start-stop toggle via lock file
# ---------------------------------------------------------------------------
def read_lock() -> dict | None:
    if not LOCK_PATH.exists():
        return None
    try:
        with open(LOCK_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def write_lock(pid: int, host: str, port: int) -> None:
    with open(LOCK_PATH, "w", encoding="utf-8") as f:
        json.dump({"pid": pid, "host": host, "port": port}, f)


def remove_lock() -> None:
    try:
        LOCK_PATH.unlink()
    except FileNotFoundError:
        pass


def trigger_remote_shutdown(lock: dict, shutdown_route: str) -> bool:
    url = f"http://{lock['host']}:{lock['port']}{shutdown_route}"
    try:
        req = urllib.request.Request(
            url, data=b"{}", method="POST",
            headers={"Content-Type": "application/json"},
        )
        urllib.request.urlopen(req, timeout=3)
        return True
    except (urllib.error.URLError, OSError):
        return False


# ---------------------------------------------------------------------------
# MIME resolution
# ---------------------------------------------------------------------------
class UnsupportedMediaType(Exception):
    pass


def resolve_content_type(path: Path, mime_cfg: dict) -> str:
    if mime_cfg.get("enabled", False):
        types = mime_cfg.get("types", {})
        ext = path.suffix.lower()
        if ext in types:
            return types[ext]
        raise UnsupportedMediaType(ext)
    ctype, _ = mimetypes.guess_type(str(path))
    return ctype or "application/octet-stream"


# ---------------------------------------------------------------------------
# Request handler
# ---------------------------------------------------------------------------
class PiServerHandler(BaseHTTPRequestHandler):
    server_version = "PiServer/1.0"

    # -- IO helpers ----------------------------------------------------------
    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        if length == 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return None

    def _resolve_log_path(self, relative_path: str, filename: str) -> Path | None:
        target = (BASE_DIR / relative_path / filename).resolve()
        if BASE_DIR not in target.parents:
            return None
        return target

    # -- security measures ---------------------------------------------------
    def _check_auth(self) -> bool:
        token = self.server.auth_token
        if not token:
            return True
        return self.headers.get("Authorization", "") == f"Bearer {token}"

    def _check_rate_limit(self) -> bool:
        ip = self.client_address[0]
        now = time.time()
        with _rate_lock:
            start, count = _rate_limit.get(ip, (now, 0))
            if now - start > 60:
                _rate_limit[ip] = (now, 1)
                return True
            if count >= self.server.rate_limit:
                return False
            _rate_limit[ip] = (start, count + 1)
            return True

    # -- shutdown ------------------------------------------------------------
    def _handle_shutdown(self) -> None:
        if self.client_address[0] not in ("127.0.0.1", "::1"):
            self._send_json(403, {"error": "forbidden"})
            return
        self._send_json(200, {"status": "shutting down"})

        def _shutdown_all() -> None:
            for httpd in ALL_SERVERS:
                httpd.shutdown()

        threading.Thread(target=_shutdown_all, daemon=True).start()

    # -- logging -------------------------------------------------------------
    def _handle_log_write(self) -> None:
        length = int(self.headers.get("Content-Length", 0) or 0)
        if length > self.server.max_content_bytes:
            self._send_json(413, {"error": "payload too large"})
            return
        data = self._read_json()
        if not isinstance(data, dict):
            self._send_json(400, {"error": "expected JSON object"})
            return

        # Directory toggle: create if absent, delete (with contents) if present
        if data.get("dirmode"):
            relative_path = str(data.get("relative_path", "")).strip()
            if not relative_path:
                self._send_json(400, {"error": "relative_path required for dirmode"})
                return
            target = (BASE_DIR / relative_path).resolve()
            if BASE_DIR not in target.parents:
                self._send_json(403, {"error": "forbidden"})
                return
            if target.exists() and target.is_dir():
                self._send_json(200, {"ok": True, "action": "exists"})
            else:
                target.mkdir(parents=True, exist_ok=True)
                self._send_json(200, {"ok": True, "action": "created"})
            return

        if not {"filename", "relative_path", "content"} <= data.keys():
            self._send_json(400, {"error": "expected filename, relative_path, content"})
            return
        target = self._resolve_log_path(data["relative_path"], data["filename"])
        if target is None:
            self._send_json(403, {"error": "forbidden"})
            return
        content = data["content"].replace("\r", "")
        target.parent.mkdir(parents=True, exist_ok=True)
        with _lock_for(target):
            with open(target, "a", encoding="utf-8") as f:
                f.write(content + "\n")
        self._send_json(200, {"ok": True})

    def _handle_log_read(self) -> None:
        qs = parse_qs(urlparse(self.path).query)

        # Directory existence check
        if qs.get("dirmode", [None])[0]:
            relative_path = (qs.get("relative_path", [None])[0] or "").strip()
            if not relative_path:
                self._send_json(400, {"error": "relative_path required"})
                return
            target = (BASE_DIR / relative_path).resolve()
            if BASE_DIR not in target.parents:
                self._send_json(403, {"error": "forbidden"})
                return
            if target.exists() and target.is_dir():
                self._send_json(200, {"ok": True, "exists": True})
            else:
                self._send_json(404, {"error": "not found"})
            return

        filename = qs.get("filename", [None])[0]
        relative_path = qs.get("relative_path", [None])[0]
        if not filename or relative_path is None:
            self._send_json(400, {"error": "filename and relative_path query params required"})
            return
        target = self._resolve_log_path(relative_path, filename)
        if target is None:
            self._send_json(403, {"error": "forbidden"})
            return
        if not target.exists():
            self._send_json(404, {"error": "log file not found"})
            return
        with _lock_for(target):
            content = target.read_text(encoding="utf-8")
        self._send_json(200, {"ok": True, "content": content})

    def _handle_log_delete(self) -> None:
        qs = parse_qs(urlparse(self.path).query)
        filename = qs.get("filename", [None])[0]
        relative_path = qs.get("relative_path", [None])[0]
        if not filename or relative_path is None:
            self._send_json(400, {"error": "filename and relative_path query params required"})
            return
        target = self._resolve_log_path(relative_path, filename)
        if target is None:
            self._send_json(403, {"error": "forbidden"})
            return
        with _lock_for(target):
            try:
                target.unlink()
            except FileNotFoundError:
                pass
        with _log_locks_guard:
            _log_locks.pop(str(target), None)
        self._send_json(200, {"ok": True, "deleted": True})

    # -- static file serving -------------------------------------------------
    def _serve_static(self) -> None:
        webroot = Path(self.server.webroot).resolve()
        req_path = urlparse(self.path).path
        if req_path in ("", "/"):
            req_path = "/index.html"
        target = (webroot / req_path.lstrip("/")).resolve()
        if webroot != target and webroot not in target.parents:
            self._send_json(403, {"error": "forbidden"})
            return
        if not target.exists() or not target.is_file():
            self._send_json(404, {"error": "not found"})
            return
        try:
            content_type = resolve_content_type(target, self.server.mime_whitelist)
        except UnsupportedMediaType as exc:
            self._send_json(415, {"error": f"unsupported media type '{exc}'"})
            return
        data = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    # -- routing -------------------------------------------------------------
    def do_POST(self) -> None:
        routes = self.server.routes
        if self.path == routes.get("shutdown"):
            self._handle_shutdown()
            return
        if not self._check_rate_limit():
            self._send_json(429, {"error": "rate limit exceeded"})
            return
        if self.path == routes.get("log"):
            if not self._check_auth():
                self._send_json(401, {"error": "unauthorized"})
                return
            self._handle_log_write()
            return
        self._send_json(404, {"error": "not found"})

    def do_GET(self) -> None:
        routes = self.server.routes
        if urlparse(self.path).path == routes.get("log"):
            self._handle_log_read()
            return
        self._serve_static()

    def do_DELETE(self) -> None:
        routes = self.server.routes
        if urlparse(self.path).path == routes.get("log"):
            length = int(self.headers.get("Content-Length", 0) or 0)
            if length > 0:
                # Peek at body to check for dirmode without consuming for log delete
                data = self._read_json()
                if isinstance(data, dict) and data.get("dirmode"):
                    relative_path = str(data.get("relative_path", "")).strip()
                    if not relative_path:
                        self._send_json(400, {"error": "relative_path required"})
                        return
                    target = (BASE_DIR / relative_path).resolve()
                    if BASE_DIR not in target.parents:
                        self._send_json(403, {"error": "forbidden"})
                        return
                    if not target.exists():
                        self._send_json(404, {"error": "not found"})
                        return
                    if not target.is_dir():
                        self._send_json(400, {"error": "not a directory"})
                        return
                    try:
                        shutil.rmtree(target)
                        self._send_json(200, {"ok": True, "deleted": True})
                    except OSError as e:
                        self._send_json(500, {"error": str(e)})
                    return
            self._handle_log_delete()
            return
        self._send_json(404, {"error": "not found"})

    def log_message(self, fmt, *args) -> None:
        pass


# ---------------------------------------------------------------------------
# Head resolution — up to 3 heads (url1/url2/url3). url2 and url3 inherit any
# key they omit from url1 except project-name and webroot, which are never
# inherited. port is never copied verbatim either (two heads can't share a
# host:port) — an omitted port defaults to url1.port + its index instead.
# ---------------------------------------------------------------------------
def resolve_heads(config: dict) -> list[dict]:
    urls_cfg = config.get("urls", {})
    url1_cfg = urls_cfg.get("url1", {})
    base_host = url1_cfg.get("host", "127.0.0.1")
    base_port = int(url1_cfg.get("port", 8000))

    heads = []
    for i, key in enumerate(("url1", "url2", "url3")):
        cfg = urls_cfg.get(key, {})
        default_active = key == "url1"
        heads.append({
            "key": key,
            "active": bool(cfg.get("active", default_active)),
            "host": cfg.get("host", base_host),
            "port": int(cfg.get("port", base_port + i)),
            "project_name": cfg.get("project-name", ""),
            "webroot": cfg.get("webroot", ""),
        })
    return heads


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
def main() -> None:
    config = load_config()
    routes = config.get("routes", {})

    existing_lock = read_lock()
    if existing_lock:
        ok = trigger_remote_shutdown(existing_lock, routes.get("shutdown", "/pi/shutdown"))
        remove_lock()
        if ok:
            alert("PiServer is now shutting down.")
        else:
            alert("PiServer did not respond; stale lock cleared.")
        return

    mime_whitelist = config.get("mime_whitelist", {"enabled": False, "types": {}})
    security_cfg = config.get("security", {})
    auth_token = security_cfg.get("auth_token", "")
    rate_limit = int(security_cfg.get("rate_limit_per_minute", 60))
    max_content_bytes = int(security_cfg.get("max_content_bytes", 65536))

    active_heads = []
    for head in resolve_heads(config):
        if not head["active"]:
            continue
        if not head["project_name"] or not head["webroot"]:
            alert(f'PiServer: {head["key"]} is active but missing "project-name" or '
                  f'"webroot" in pi-config.json — skipping that head.')
            continue
        active_heads.append(head)

    if not active_heads:
        alert('PiServer: no valid active heads in pi-config.json\'s "urls" section. Aborting.')
        sys.exit(1)

    for head in active_heads:
        Path(BASE_DIR / head["webroot"]).mkdir(parents=True, exist_ok=True)
        httpd = ThreadingHTTPServer((head["host"], head["port"]), PiServerHandler)
        httpd.webroot = str((BASE_DIR / head["webroot"]).resolve())
        httpd.mime_whitelist = mime_whitelist
        httpd.routes = routes
        httpd.auth_token = auth_token
        httpd.rate_limit = rate_limit
        httpd.max_content_bytes = max_content_bytes
        httpd.project_name = head["project_name"]
        ALL_SERVERS.append(httpd)

    primary = active_heads[0]
    write_lock(os.getpid(), primary["host"], primary["port"])
    alert("PiServer is now running:\n" + "\n".join(
        f'{h["project_name"]}: http://{h["host"]}:{h["port"]}' for h in active_heads
    ))

    threads = [
        threading.Thread(target=httpd.serve_forever, daemon=True)
        for httpd in ALL_SERVERS[1:]
    ]
    for t in threads:
        t.start()

    try:
        ALL_SERVERS[0].serve_forever()
    finally:
        remove_lock()


if __name__ == "__main__":
    main()
