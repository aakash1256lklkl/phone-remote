<p align="center">
  <img src="https://img.shields.io/badge/Python-3.8%2B-3776AB?style=for-the-badge&logo=python&logoColor=white" />
  <img src="https://img.shields.io/badge/Platform-Windows-0078D6?style=for-the-badge&logo=windows&logoColor=white" />
  <img src="https://img.shields.io/badge/Input-WebSockets-2ea44f?style=for-the-badge&logo=websocket&logoColor=white" />
  <img src="https://img.shields.io/badge/Status-Working-success?style=for-the-badge" />
</p>

<h1 align="center">📱 Phone Remote</h1>

<p align="center">
  Turn your phone into a <strong>wireless mouse &amp; keyboard</strong> for your laptop.
  <br/>Tilt to move, drag like a real trackpad, pinch to zoom, and type with your normal GBoard keyboard.
</p>

<p align="center">
  <b>← Phone</b> &nbsp;⇄&nbsp; <b>Wi‑Fi / LAN</b> &nbsp;⇄&nbsp; <b>Laptop →</b>
</p>

---

## ✨ Features

| | Feature | What it does |
|---|---|---|
| 🖱️ | **Gyroscope mouse** | Tilt the phone like a remote control to move the cursor — no touchpad needed. |
| 🖐️ | **Trackpad mode** | A real-laptop-style relative trackpad: the cursor only moves as far as you drag. |
| 🔍 | **Pinch to zoom** | Two-finger pinch sends **Ctrl+wheel** — zooms in browsers, maps, PDFs, image viewers. |
| ⬆️⬇️ | **Scroll arrows** | Tap or hold ▲ / ▼ to scroll, with a speed slider up to **60 notches per press**. |
| ⌨️ | **GBoard keyboard** | Type with your normal phone keyboard — autocorrect and swipe-typing all work. |
| 🔢 | **Extended keys** | F1–F12, arrows, Ctrl‑combos, Alt+Tab, Win shortcuts, custom combos, Esc, Delete and more. |
| ⚡ | **Low latency** | Watch the real‑time round‑trip meter — typically well under 10 ms on Wi‑Fi. |
| 🔐 | **Pairing** | A fresh 4‑digit code is printed each run; the phone remembers it and auto‑reconnects. |

---

## 🚀 Quick start

### 1️⃣ On your laptop

```bash
git clone https://github.com/aakash1256lklkl/phone-remote.git
cd phone-remote

# Windows
pip install -r requirements.txt
python server.py
```

> 💡 No Python required to launch — just double‑click **`start.bat`** and it installs dependencies the first time for you.

The console prints a big **QR code**, the LAN URL, and a 4‑digit pairing code:

```
Pairing code:  4821
```

### 2️⃣ On your phone

1. Make sure the phone is on the **same Wi‑Fi** as the laptop.
2. **Scan the QR code** with the phone camera (it opens Chrome and connects automatically).
3. Or open the printed URL manually and type the pairing code.

That's it — the 🖱️ / ⌨️ tabs control your laptop.

---

## 🎮 How to use

### Mouse tab

When the gyroscope is available you get **tilt‑to‑move**:

| | |
|---|---|
| *Tilt the phone* | Move the cursor — tilt further for faster movement |
| **⌖ Recenter** | Snap the cursor back to the middle of the screen |
| **↔ / ↕ Invert** | Flip an axis if it feels backwards in your grip |
| **🖱️ Scroll** | Toggle tilt‑to‑scroll (bigger tilt = faster scroll) |

If the gyro is blocked (Android Chrome blocks it on plain `http`), the app **auto‑falls back to a trackpad**:

| Gesture | Action |
|---|---|
| 👆 **Tap** | Click — defaults to **right‑click**; the `Tap=Right / Tap=Left / Tap=Off` button changes it |
| 🖱️ **Drag** | Move the cursor (stays where you lift it — no jumping) |
| 🍀 **Two‑finger tap** | Always a right‑click |
| 🔍 **Two‑finger pinch** | Zoom in / out (spread apart / together) |
| ⬆️ **▲ / ▼ on the right** | Scroll — tap to nudge, **hold to repeat** |
| ⤵️ **Bottom corners** | L / R zones give a guaranteed left / right click |

**Scroll speed** is set by the **Scroll** slider (`5–60`, default `15`, step `5`) — each point is *one wheel notch per press*, so the top end flies. It applies to both the arrows and tilt‑to‑scroll.

> 💡 The pad dims while you touch it so every tap feels immediate.

### Keyboard tab

- Tap the **Type here…** box to open GBoard — your autocorrect and swipe‑typing go straight to the laptop.
- What you type stays visible in the box while you're typing and only clears when you **switch away** (or press ⏎).
- Tap **＋ Extended keys** for the full laptop‑keyboard overlay: F‑keys, arrows, Esc, Delete, Home/End/PgUp/PgDn, Ctrl‑combos, Alt+Tab, Win+D, PrtSc, Enter / Backspace / Tab, plus one‑tap **Win shortcuts** (Win+V clipboard, Win+E Explorer, Win+Tab, Win+⇧S screenshot, Ctrl+⇧Esc Task Manager, Win+I, Win+M, Win+L).
- **Any shortcut you want:** type it in the *Custom combo* box (e.g. `win+v`, `ctrl+shift+esc`, `alt+tab`) and hit **Send** — aliases like `windows`, `control`, `esc`, `del`, `pgup` all work, and Enter sends too.
- The **latency badge** in the toolbar shows round‑trip time — under 20 ms feels instant.

---

## 📡 How it works

```
┌─────────────┐         WebSocket (8765)         ┌──────────────────┐
│  Phone web  │  ──────────────────────────────▶ │   server.py      │
│  app (8080) │   JSON: move / click / text ...  │  PyAutoGUI input │──▶ Laptop OS
└─────────────┘                                  └──────────────────┘
```

- The server serves the phone web app and speaks a tiny JSON protocol over **WebSockets**.
- Input is simulated with **PyAutoGUI**; consecutive mouse moves are coalesced so a burst never lags.
- Call logs are written with `no-store` headers, so reloading the phone page always picks up the latest UI.

Control protocol (`WebSocket` text frames, JSON):

| Type | Payload | Does |
|---|---|---|
| `move` | `dx, dy` | Relative mouse move |
| `move_abs` | `x, y` (0–1) | Move to a screen position |
| `click` | `button, clicks` | Left / right / double click |
| `scroll` | `dy` | Wheel scroll (notches) |
| `zoom` | `dir` (±1) | Ctrl+wheel zoom in / out |
| `key` | `key` | Press a named key |
| `text` | `text` | Type a string |
| `hotkey` | `keys[]` | Press a combination |
| `ping` | — | Latency check |

---

## 🗂️ Project structure

```
phone-remote/
├── server.py          # WebSocket control server + phone app server + input simulation
├── phone/             # Web app served to the phone
│   ├── index.html
│   ├── app.js         # Gyro mouse, trackpad gestures, keyboard, protocol
│   └── style.css
├── requirements.txt   # websockets, PyAutoGUI, qrcode
├── start.bat          # One-click launcher (installs deps on first run)
└── README.md
```

---

## ⚠️ Notes

- **Gyro blocked?** Android Chrome disables sensors on plain `http`. The app auto‑falls back to touchpad mode. For true tilt control, run the page over HTTPS or use Firefox on the phone — the keyboard always works either way.
- **Security:** the pair code (printed each run) is the only gate; bind and run on your own trusted LAN. No encryption over plain `http` by default.
- **Other OSes:** PyAutoGUI works on macOS/Linux too, but the wheel/zoom helpers are tuned for Windows.

---

<p align="center">
  Made with ☕ and a phone.  ·  <a href="https://github.com/cli/cli">Built to scratch the "laptop on the couch, no mouse" itch.</a>
</p>