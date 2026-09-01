"""
Phone Remote - server for controlling the laptop mouse & keyboard from an Android phone.

Run:  python server.py
Then open the printed URL / QR code on the phone (phone and laptop on the SAME WiFi).
"""

import asyncio
import json
import secrets
import socket
import sys
import threading
from collections import deque
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pyautogui
import websockets

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
WEB_PORT = 8080          # serves the phone web app
WS_PORT = 8765           # websocket for control messages
PHONE_DIR = Path(__file__).parent / "phone"

# Smoother mouse movement
pyautogui.PAUSE = 0
pyautogui.FAILSAFE = False

# ---------------------------------------------------------------------------
# Security: pairing
# ---------------------------------------------------------------------------
PAIR_CODE = f"{secrets.randbelow(10000):04d}"
_AUTHENTICATED = set()   # websocket objects that passed the pairing check

# ---------------------------------------------------------------------------
# Input worker: decouples the network loop from pyautogui calls so bursts of
# mouse moves never stall the WebSocket (and vice-versa).
# ---------------------------------------------------------------------------
_IO = deque()
_IO_CV = threading.Condition()


def _io_put(item):
    with _IO_CV:
        _IO.append(item)
        _IO_CV.notify()

# ---------------------------------------------------------------------------
# Input simulation
# ---------------------------------------------------------------------------

def _press_key(key):
    try:
        pyautogui.keyDown(key)
        pyautogui.keyUp(key)
    except Exception as e:
        print(f"[key error] {key}: {e}")


def _type_text(text):
    pyautogui.write(text)


def _move(dx, dy):
    w, h = pyautogui.size()
    x, y = pyautogui.position()
    px = min(max(x + dx, 0), w - 1)
    py = min(max(y + dy, 0), h - 1)
    pyautogui.moveTo(int(px), int(py))


def _move_abs(x, y):
    w, h = pyautogui.size()
    x = min(max(float(x), 0.0), 1.0)
    y = min(max(float(y), 0.0), 1.0)
    pyautogui.moveTo(int(x * w), int(y * h))


def _click(btn="left", clicks=1):
    pyautogui.click(button=btn, clicks=clicks)


def _scroll(dy):
    pyautogui.scroll(int(-dy))


def _zoom(dir_: int):
    """Pinch zoom: Ctrl+wheel. dir > 0 zooms in, dir < 0 zooms out."""
    pyautogui.keyDown("ctrl")
    try:
        pyautogui.scroll(1 if dir_ > 0 else -1)
    finally:
        pyautogui.keyUp("ctrl")


def _handle_message(ws, msg) -> dict:
    """Dispatch a parsed control message. Returns {'ok': True} or {'ok': False, 'error': ...}"""
    cmd = msg.get("type")

    try:
        if cmd == "move":
            _move(int(msg.get("dx", 0)), int(msg.get("dy", 0)))
        elif cmd == "move_abs":
            _move_abs(float(msg.get("x", 0)), float(msg.get("y", 0)))
        elif cmd == "click":
            _click(msg.get("button", "left"), msg.get("clicks", 1))
        elif cmd == "scroll":
            _scroll(float(msg.get("dy", 0)))
        elif cmd == "zoom":
            _zoom(int(msg.get("dir", 0)))
        elif cmd == "key":
            _press_key(msg.get("key", ""))
        elif cmd == "text":
            _type_text(msg.get("text", ""))
        elif cmd == "hotkey":
            keys = msg.get("keys", [])
            if keys:
                pyautogui.hotkey(*keys)
        elif cmd == "ping":
            pass
        else:
            return {"ok": False, "error": f"Unknown command: {cmd}"}
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def _io_worker():
    """Runs pyautogui calls off the event loop. Consecutive mouse moves are
    coalesced so a burst never builds a backlog (last position wins)."""
    while True:
        with _IO_CV:
            while not _IO:
                _IO_CV.wait()
            op = _IO.popleft()
        kind = op[0]
        if kind in ("move", "move_abs"):
            dx, dy = op[1], op[2]
            while True:
                with _IO_CV:
                    nxt = _IO.popleft() if _IO and _IO[0][0] == kind else None
                if nxt is None:
                    break
                if kind == "move":
                    dx += nxt[1]
                    dy += nxt[2]
                else:
                    dx, dy = nxt[1], nxt[2]
            if kind == "move":
                _move(dx, dy)
            else:
                _move_abs(dx, dy)
        else:
            result = _handle_message(None, op[1])
            if not result.get("ok"):
                print(f"[error] {op[1].get('type')}: {result.get('error')}", flush=True)


# ---------------------------------------------------------------------------
# Websocket server
# ---------------------------------------------------------------------------

async def ws_handler(ws):
    await ws.send(json.dumps({"type": "hello", "pair_code": PAIR_CODE}))
    try:
        async for raw in ws:
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                await ws.send(json.dumps({"ok": False, "error": "bad json"}))
                continue

            # Pairing handshake
            if msg.get("type") == "pair":
                if str(msg.get("code", "")).strip() == PAIR_CODE:
                    _AUTHENTICATED.add(ws)
                    await ws.send(json.dumps({"type": "paired", "ok": True}))
                else:
                    await ws.send(json.dumps(
                        {"type": "paired", "ok": False, "error": "wrong pairing code"}))
                continue

            if ws not in _AUTHENTICATED:
                await ws.send(json.dumps(
                    {"type": "error", "error": "not paired"}))
                continue

            cmd = msg.get("type")
            if cmd == "ping":
                # latency probe: echo the client timestamp straight back
                await ws.send(json.dumps({"type": "pong", "t": msg.get("t", 0)}))
                continue
            if cmd == "move":
                _io_put(("move", int(msg.get("dx", 0)), int(msg.get("dy", 0))))
            elif cmd == "move_abs":
                _io_put(("move_abs", float(msg.get("x", 0)), float(msg.get("y", 0))))
            else:
                _io_put(("action", msg))
    except websockets.ConnectionClosed:
        pass
    finally:
        _AUTHENTICATED.discard(ws)


# ---------------------------------------------------------------------------
# HTTP file server (phone web app)
# ---------------------------------------------------------------------------

class QuietHandler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(PHONE_DIR), **kw)

    def end_headers(self):
        # never cache the phone app, so updates reach the phone immediately
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, format, *args):
        pass  # keep console clean


def _run_http():
    httpd = ThreadingHTTPServer(("0.0.0.0", WEB_PORT), QuietHandler)
    httpd.serve_forever()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _candidate_ips():
    """All usable LAN IPv4s, ranked: 192.168.* > 172.16-31.* > 10.* > other."""
    ips = []
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if isinstance(ip, str) and not ip.startswith("127.") and ip not in ips:
                ips.append(ip)
    except Exception:
        pass
    try:  # the IP actually used to reach the internet (picks VPN adapter if active)
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        if ip not in ips:
            ips.append(ip)
    except Exception:
        pass

    def rank(i):
        if i.startswith("192.168."):
            return 0
        parts = i.split(".")
        if len(parts) == 4 and parts[0] == "172" and 16 <= int(parts[1]) <= 31:
            return 1
        if parts and parts[0] == "10":
            return 2
        return 3

    ips.sort(key=rank)
    return ips or ["127.0.0.1"]


def _print_qr(data: str):
    """Print a scannable QR code to the terminal (best-effort)."""
    try:
        import qrcode
    except ImportError:
        return  # optional dependency; URL text fallback is printed anyway
    try:
        qr = qrcode.QRCode(border=2)
        qr.add_data(data)
        qr.make(fit=True)
        if sys.stdout.isatty():
            # black/white ANSI QR — crisp on any terminal theme
            qr.print_tty()
        else:
            # redirected output: light blocks on dark background
            qr.print_ascii(invert=True)
    except Exception:
        pass  # QR is best-effort; URL text fallback is printed anyway


def _print_banner():
    candidates = _candidate_ips()
    ip = candidates[0]
    url = f"http://{ip}:{WEB_PORT}"
    connect_url = f"{url}/?code={PAIR_CODE}"
    print("=" * 60, flush=True)
    print("  PHONE REMOTE", flush=True)
    print("=" * 60, flush=True)
    print("\n  On your phone (same WiFi), scan this QR:", flush=True)
    _print_qr(connect_url)
    print(f"\n      Or open:  {url}", flush=True)
    if len(candidates) > 1:
        print("\n  If the phone can't reach that address (VPN on?), try:", flush=True)
        for alt in candidates[1:]:
            print(f"       http://{alt}:{WEB_PORT}", flush=True)
    print(f"\n  Pairing code:  {PAIR_CODE}", flush=True)
    print("\n  (Press Ctrl+C to quit)", flush=True)
    print("=" * 60, flush=True)


def main():
    _reconfigure = getattr(sys.stdout, "reconfigure", None)
    if _reconfigure:
        try:
            _reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    _print_banner()

    threading.Thread(target=_io_worker, daemon=True).start()
    threading.Thread(target=_run_http, daemon=True).start()
    print(f"\n[Serving phone app on port {WEB_PORT}]", flush=True)

    try:
        asyncio.run(_ws_main())
    except KeyboardInterrupt:
        print("\nBye.")


async def _ws_main():
    async with websockets.serve(
        ws_handler, "0.0.0.0", WS_PORT,
        max_size=2 ** 22,  # allow long text strings
    ):
        await asyncio.Future()  # run forever


if __name__ == "__main__":
    main()
