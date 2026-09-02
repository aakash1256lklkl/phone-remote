/* Phone Remote - client logic */

const $ = (id) => document.getElementById(id);

let ws = null;
let paired = false;
let gyroActive = false;
let tiltMode = true;          // true = gyroscope, false = touchpad fallback

/* ---- WebSocket connection ---- */
let pendingCode = null;
let reconnectTries = 0;
let userDisconnect = false;

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.hostname}:8765`;
  try {
    ws = new WebSocket(url);
  } catch (e) {
    setStatus('Connection error', true);
    return;
  }

  ws.onopen = () => {
    if (pendingCode) {
      setStatus('Pairing…');
      ws.send(JSON.stringify({ type: 'pair', code: pendingCode }));
      pendingCode = null;
    } else {
      setStatus('Connected — enter pairing code');
    }
  };
  ws.onerror = () => { setStatus('Cannot reach laptop. Same WiFi?', true); };
  ws.onclose = () => {
    paired = false;
    $('screen-connect').classList.remove('hidden');
    $('screen-control').classList.add('hidden');
    updateConnDot(false);
    if (userDisconnect) {
      userDisconnect = false;
      setStatus('Disconnected');
      return;
    }
    const code = $('pair-input').value.trim() || localStorage.getItem('pr_code') || '';
    if (reconnectTries < 20) {
      reconnectTries++;
      setStatus('Reconnecting…');
      setTimeout(() => {
        if (code) pendingCode = code;
        connect();
      }, 600 * Math.min(reconnectTries, 5));
    } else {
      setStatus('Disconnected — reload to reconnect');
    }
  };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.type === 'paired') {
      if (msg.ok) {
        paired = true;
        reconnectTries = 0;
        const code = $('pair-input').value.trim();
        if (code) localStorage.setItem('pr_code', code);
        $('screen-connect').classList.add('hidden');
        $('screen-control').classList.remove('hidden');
        updateConnDot(true);
        initGyro();
      } else {
        setStatus('Wrong code: ' + (msg.error || ''), true);
      }
    }
    if (msg.type === 'pong' && msg.t) {
      const el = $('lat');
      if (el) el.textContent = Math.max(1, Math.round(performance.now() - msg.t)) + 'ms';
    }
    if (msg.type === 'error') {
      setStatus('Error: ' + msg.error, true);
    }
  };
}

function send(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(obj));
}

/* ---- Pairing ---- */
function doPair() {
  const code = $('pair-input').value.trim();
  if (!code || code.length < 4) { setStatus('Enter the 4-digit code', true); return; }
  if (ws && ws.readyState === WebSocket.OPEN) {
    send({ type: 'pair', code });
  } else if (ws && ws.readyState === WebSocket.CONNECTING) {
    pendingCode = code;
    setStatus('Connecting…');
  } else {
    pendingCode = code;
    connect();
    setStatus('Connecting…');
  }
}
$('pair-btn').addEventListener('click', doPair);
$('pair-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') doPair(); });

function setStatus(text, isErr) {
  const el = $('pair-status');
  el.textContent = text;
  el.className = 'status' + (isErr ? ' error' : '');
}

function updateConnDot(on) {
  $('conn-dot').classList.toggle('off', !on);
}

/* ---- Latency meter ---- */
function pingLoop() {
  if (ws && ws.readyState === WebSocket.OPEN && paired) {
    send({ type: 'ping', t: performance.now() });
  }
  setTimeout(pingLoop, 2000);
}
pingLoop();

/* ---- Tabs ---- */
document.querySelectorAll('.tab[data-tab]').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab[data-tab]').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const panel = tab.dataset.tab;
    $('panel-mouse').classList.toggle('active', panel === 'mouse');
    $('panel-keyboard').classList.toggle('active', panel === 'keyboard');
    if (window.clearGbInput) clearGbInput();   // switching away erases the typing box
  });
});

$('disconnect').addEventListener('click', () => {
  userDisconnect = true;
  if (ws) ws.close();
});

/* =====================================================================
   MOUSE — Gyroscope (tilt to move) + touchpad fallback
   ===================================================================== */
let lastGyro = { px: 0, py: 0, ts: 0 };
let cursor = { x: 0.5, y: 0.5 };   // normalized 0..1

function initGyro() {
  if (!('DeviceOrientationEvent' in window)) {
    gyroUnavailable();
    return;
  }
  // iOS 13+ requires permission request
  if (typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission === 'function') {
    DeviceOrientationEvent.requestPermission()
      .then((state) => {
        if (state === 'granted') startGyro();
        else gyroUnavailable();
      })
      .catch(gyroUnavailable);
  } else {
    startGyro();
  }
}

function startGyro() {
  gyroActive = true;
  $('gyro-state').textContent = 'active';
  $('gyro-badge').classList.add('good');
  window.addEventListener('deviceorientation', onOrientation, true);
  // Android Chrome blocks generic sensors on insecure origins;
  // we give a fallback message but keep polling.
  setTimeout(() => {
    if (!lastGyro.ts) {
      // No events arriving (likely insecure-origin block). Switch to touch pad.
      touchFallback();
    }
  }, 1500);
}

function gyroUnavailable() {
  $('gyro-state').textContent = 'unavailable';
  touchFallback();
}

function touchFallback() {
  tiltMode = false;
  $('gyro-state').textContent = 'fallback (touchpad)';
  $('gyro-pad').classList.add('hidden');
  $('touch-pad-wrap').classList.remove('hidden');
}

const SENS_FACTOR = 0.00008;  // base tilt speed (scaled by slider & dt)
const DEAD_ZONE = 1.5;        // degrees of tilt ignored (prevents drift)

let invertX = false;
let invertY = false;

function onOrientation(e) {
  if (!gyroActive) return;
  const beta = e.beta;   // -180..180 front/back
  const gamma = e.gamma; // -90..90 left/right
  if (beta == null && gamma == null) return;

  const sens = parseInt($('sens').value, 10) / 10;
  const now = performance.now();
  const dt = Math.min(now - lastGyro.ts || 0, 60);

  // Velocity control: tilt away from rest to move, return to rest to stop
  const dGamma = lastGyro.ts ? gamma - lastGyro.px : 0;
  const dBeta = lastGyro.ts ? beta - lastGyro.py : 0;
  lastGyro.px = gamma;
  lastGyro.py = beta;
  lastGyro.ts = now;
  if (!dt) return;

  let vx = dGamma;              // tilt right (+) -> cursor right (+)
  let vy = -dBeta;              // tilt top-back (+) -> cursor up (-)
  if (invertX) vx = -vx;
  if (invertY) vy = -vy;
  if (Math.abs(dGamma) <= DEAD_ZONE) vx = 0;
  if (Math.abs(dBeta) <= DEAD_ZONE) vy = 0;

  if (wheelMode) {
    tiltToScroll(vy);
    return;
  }

  const k = SENS_FACTOR * sens;
  cursor.x += vx * k * dt;
  cursor.y += vy * k * dt;
  cursor.x = Math.max(0, Math.min(1, cursor.x));
  cursor.y = Math.max(0, Math.min(1, cursor.y));

  send({ type: 'move_abs', x: cursor.x, y: cursor.y });
  updateGyroHandle();
}

/* Tilt up/down scroll: accumulate tilt degrees into discrete wheel notches */
let scrollAccum = 0;
const SCROLL_SETPOINT = 22;   // degrees of tilt per wheel notch (at scroll speed 5)

function scrollSpeed() {
  return parseInt($('scrollsens').value, 10) || 5;
}

function tiltToScroll(vy) {
  const setpoint = Math.max(4, SCROLL_SETPOINT * 5 / scrollSpeed());
  scrollAccum += vy;
  while (scrollAccum > setpoint) {
    send({ type: 'scroll', dy: 1 });
    scrollAccum -= setpoint;
  }
  while (scrollAccum < -setpoint) {
    send({ type: 'scroll', dy: -1 });
    scrollAccum += setpoint;
  }
}

function recenter() {
  cursor.x = 0.5;
  cursor.y = 0.5;
  lastGyro.ts = 0;
  updateGyroHandle();
  send({ type: 'move_abs', x: 0.5, y: 0.5 });
}

function updateGyroHandle() {
  const h = $('gyro-handle');
  h.style.left = (cursor.x * 100) + '%';
  h.style.top = (cursor.y * 100) + '%';
}

/* Trackpad — RELATIVE drag like a real laptop pad: the cursor moves only as
   far as you drag, and when you lift your finger it stays exactly where you
   left it (no jumping). A quick tap clicks (Left or Right from the corner
   zones, Left anywhere else). Two fingers: tap = right-click, pinch = zoom. */
const padEl = $('touch-pad');
const PAD_GAIN = 0.6;       // screens per full pad swipe at sens=10
const TOUCH_ACCEL = 2.0;    // extra gain on fast flicks
const TAP_MOVE = 12;        // px of movement that turns a tap into a drag
const TAP_MS = 600;         // max tap duration (both presses must lift together)
const PINCH_STEP = 10;      // px of finger-spread change per zoom notch
let padPtrs = new Map();    // pointerId -> {entered, moved, x, y}
let padTouching = false;    // single finger dragging the cursor
let padPending = false;     // a move flush is scheduled
let padMulti = false;       // two fingers down -> gesture mode (tap = right-click)
let padPinch = null;        // last spacing between the two fingers (px)
let padPinchAccum = 0;      // un-sent pinch movement
let tapToClick = true;      // single-finger tap enabled
let tapBtn = 'right';       // what a pad tap clicks: 'left' or 'right'
let lastTapCheck = null;    // shared timing for two-finger tap detection

function padClamp(v) { return Math.max(0, Math.min(1, v)); }

// brief on-pad feedback so a pinch visibly registers
let zoomFlashTimer = null;
function zoomFlash(dir) {
  const b = $('zoom-badge');
  b.textContent = dir > 0 ? '🔍 +' : '🔍 −';
  b.classList.remove('hidden');
  clearTimeout(zoomFlashTimer);
  zoomFlashTimer = setTimeout(() => b.classList.add('hidden'), 260);
}

// stop the browser from hijacking two-finger gestures (page zoom / scroll).
// touch-action:none covers modern Chrome; these are belt-and-suspenders for
// iOS Safari and older WebViews that ignore it.
['gesturestart', 'gesturechange', 'gestureend'].forEach((evt) =>
  padEl.addEventListener(evt, (e) => e.preventDefault()));
padEl.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
padEl.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });

function flushPad() {
  padPending = false;
  if (!padTouching) return;
  cursor.x = padClamp(cursor.x);
  cursor.y = padClamp(cursor.y);
  send({ type: 'move_abs', x: cursor.x, y: cursor.y });
  updateGyroHandle();
}

function schedulePadFlush() {
  if (padPending) return;
  padPending = true;
  requestAnimationFrame(flushPad);
}

// which click zone a touch lands in: bottom-left / bottom-right corners
function padZone(clientX, clientY) {
  const rect = padEl.getBoundingClientRect();
  if (clientY < rect.bottom - rect.height * 0.38) return null;
  if (clientX < rect.left + rect.width * 0.32) return 'left';
  if (clientX > rect.right - rect.width * 0.32) return 'right';
  return null;
}

function padPress(e) {
  padPtrs.set(e.pointerId, { x: e.clientX, y: e.clientY, moved: 0, startT: performance.now() });
  if (padPtrs.size >= 2) {
    // two fingers: stop any cursor dragging; quick tap = right-click, pinch = zoom
    padMulti = true;
    padTouching = false;
    lastTapCheck = performance.now();
    const pts = [...padPtrs.values()];
    padPinch = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    padPinchAccum = 0;
    padEl.classList.add('pad-press');
  } else {
    padTouching = true;
    padEl.classList.add('pad-press');
  }
}

padEl.addEventListener('pointerdown', (e) => {
  try { padEl.setPointerCapture(e.pointerId); } catch (err) { /* already gone */ }
  padPress(e);
});

padEl.addEventListener('pointermove', (e) => {
  const p = padPtrs.get(e.pointerId);
  if (!p) return;
  const dx = e.clientX - p.x;
  const dy = e.clientY - p.y;
  const dist = Math.hypot(dx, dy);
  p.moved += dist;
  if (p.moved > TAP_MOVE) lastTapCheck = 0;   // too much travel -> never a tap
  p.x = e.clientX;
  p.y = e.clientY;

  if (padMulti) {
    // two-finger pinch: fingers apart -> zoom in, together -> zoom out
    if (padPtrs.size >= 2) {
      const pts = [...padPtrs.values()];
      const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      if (padPinch != null) {
        padPinchAccum += d - padPinch;
        while (padPinchAccum > PINCH_STEP) {
          padPinchAccum -= PINCH_STEP;
          send({ type: 'zoom', dir: 1 });
          zoomFlash(1);
        }
        while (padPinchAccum < -PINCH_STEP) {
          padPinchAccum += PINCH_STEP;
          send({ type: 'zoom', dir: -1 });
          zoomFlash(-1);
        }
      }
      padPinch = d;
    }
    return;   // no cursor drag in two-finger gesture
  }
  if (!padTouching || dx === 0 && dy === 0) return;

  const sens = parseInt($('sens').value, 10) / 10;
  const rect = padEl.getBoundingClientRect();
  const accel = 1 + ((TOUCH_ACCEL - 1) * Math.min(dist / rect.width * 8, 1));
  const scale = PAD_GAIN * sens * accel / rect.width;
  cursor.x += dx * scale;
  cursor.y += dy * scale;
  schedulePadFlush();
});

function padRelease(e) {
  const p = padPtrs.get(e.pointerId);
  padPtrs.delete(e.pointerId);
  const now = performance.now();

  if (padMulti) {
    // A two-finger TAP (both lifted, little travel, quick) = right-click.
    const others = [...padPtrs.values()];
    if (padPtrs.size === 0) {
      padMulti = false;
      padPinch = null;
      padPinchAccum = 0;
      padEl.classList.remove('pad-press');
      const wasTap =
        p && p.moved < TAP_MOVE && now - lastTapCheck < TAP_MS &&
        now - p.startT < TAP_MS &&
        others.every(o => o.moved < TAP_MOVE && now - o.startT < TAP_MS);
      if (wasTap) send({ type: 'click', button: 'right', clicks: 1 });
      lastTapCheck = null;
    }
    return;
  }

  // single-finger mode
  if (padPtrs.size === 0) {
    padEl.classList.remove('pad-press');
    if (padPending) flushPad();   // never drop the final cursor position
    let click = null;
    if (tapToClick && p && p.moved < TAP_MOVE && now - p.startT < TAP_MS) {
      const zone = padZone(e.clientX, e.clientY);
      // corner R zone always right-clicks; L zone always left-clicks;
      // the middle uses the selected tap action (Tap=Right toggle)
      let button = tapBtn;
      if (zone === 'right') button = 'right';
      else if (zone === 'left') button = 'left';
      click = { button, clicks: 1 };
    }
    padTouching = false;
    if (click) send({ type: 'click', button: click.button, clicks: click.clicks });
  }
}

padEl.addEventListener('pointerup', padRelease);
padEl.addEventListener('pointercancel', (e) => {
  padPtrs.delete(e.pointerId);
  if (padPtrs.size < 2) { padMulti = false; padPinch = null; padPinchAccum = 0; padTouching = padPtrs.size === 1; }
  if (padPtrs.size === 0) { padTouching = false; lastTapCheck = null; padEl.classList.remove('pad-press'); }
});

$('btn-tapclk').addEventListener('click', () => {
  // cycle: Off -> Left -> Right -> Off ...
  if (!tapToClick) { tapToClick = true; tapBtn = 'left'; }
  else if (tapBtn === 'left') { tapBtn = 'right'; }
  else { tapToClick = false; }
  syncTapBtn();
});
syncTapBtn();

function syncTapBtn() {
  const b = $('btn-tapclk');
  b.classList.toggle('on', tapToClick);
  b.textContent = !tapToClick ? 'Tap=Off' : (tapBtn === 'right' ? 'Tap=Right' : 'Tap=Left');
}

/* Mouse buttons */
let wheelMode = false;
$('btn-left').addEventListener('click', () => send({ type: 'click', button: 'left', clicks: 1 }));
$('btn-right').addEventListener('click', () => send({ type: 'click', button: 'right', clicks: 1 }));
$('btn-double').addEventListener('click', () => send({ type: 'click', button: 'left', clicks: 2 }));

$('btn-recenter').addEventListener('click', recenter);

$('btn-invert-x').addEventListener('click', () => {
  invertX = !invertX;
  $('btn-invert-x').classList.toggle('on', invertX);
});
$('btn-invert-y').addEventListener('click', () => {
  invertY = !invertY;
  $('btn-invert-y').classList.toggle('on', invertY);
});

$('btn-wheel').addEventListener('click', () => {
  wheelMode = !wheelMode;
  $('btn-wheel').classList.toggle('on', wheelMode);
  $('btn-wheel').textContent = wheelMode ? 'Tilt to scroll' : '🖱️ Scroll';
});

/* Scroll arrows (right side of the trackpad): hold to keep scrolling */
function bindScrollArrow(id, dir) {
  const el = $(id);
  let rep = null;
  const step = () => {
    // one wheel notch per slider point (slider is 1–20)
    const s = Math.max(1, Math.round(scrollSpeed()));
    send({ type: 'scroll', dy: dir * s });
  };
  const holdMs = () => Math.max(30, Math.min(350, Math.round(300 / scrollSpeed())));
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    step();
    rep = setInterval(step, holdMs());
    try { el.setPointerCapture(e.pointerId); } catch (err) { /* gone */ }
  });
  ['pointerup', 'pointercancel'].forEach((ev) =>
    el.addEventListener(ev, () => { clearInterval(rep); rep = null; })
  );
}
bindScrollArrow('pad-scroll-up', -1);
bindScrollArrow('pad-scroll-down', 1);

$('sens').addEventListener('input', () => {
  $('sens-val').textContent = $('sens').value;
});

$('scrollsens').addEventListener('input', () => {
  $('scroll-val').textContent = $('scrollsens').value;
});

/* =====================================================================
   KEYBOARD — GBoard typing + extended keys
   ===================================================================== */
const gbInput = $('gb-input');
let lastGbValue = '';
let gbClearing = false;

// Text stays visible while you type (autocorrect + GBoard's own ⌫ all work).
// It only clears when the field loses focus (you switch away / GBoard closes)
// or when you press Enter.
function gbDiff(prev, cur) {
  let p = 0;
  while (p < prev.length && p < cur.length && prev[p] === cur[p]) p++;
  let s = 0;
  while (s < prev.length - p && s < cur.length - p &&
         prev[prev.length - 1 - s] === cur[cur.length - 1 - s]) s++;
  return { erased: prev.length - p - s, inserted: cur.slice(p, cur.length - s) };
}

function clearGbInput() {
  if (gbInput.value === '' && lastGbValue === '') return;
  gbClearing = true;          // the reset below fires an input event; swallow it
  gbInput.value = '';
  gbClearing = false;
  lastGbValue = '';
}

gbInput.addEventListener('input', () => {
  if (gbClearing) { lastGbValue = ''; return; }
  const { erased, inserted } = gbDiff(lastGbValue, gbInput.value);
  lastGbValue = gbInput.value;
  if (erased) {
    for (let i = 0; i < erased; i++) send({ type: 'key', key: 'backspace' });
  }
  if (inserted) send({ type: 'text', text: inserted });
});

// Switching away (another element, another tab, GBoard closing) clears the box.
gbInput.addEventListener('blur', clearGbInput);

gbInput.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Enter') {
    e.preventDefault();
    send({ type: 'key', key: 'enter' });
    clearGbInput();
  }
});

$('gb-enter').addEventListener('click', () => {
  send({ type: 'key', key: 'enter' });
  clearGbInput();
});
$('gb-backspace').addEventListener('click', () => {
  gbInput.value = gbInput.value.slice(0, -1);
  lastGbValue = gbInput.value;
  send({ type: 'key', key: 'backspace' });
});
$('gb-tab').addEventListener('click', () => send({ type: 'key', key: 'tab' }));

/* Extended keys toggle */
$('ext-toggle').addEventListener('click', () => {
  const ext = $('ext-keys');
  const show = ext.classList.toggle('hidden');
  $('ext-toggle').classList.toggle('on', !show);
});

/* Extended keys */
document.querySelectorAll('.ek').forEach((btn) => {
  const keyTap = () => {
    btn.classList.add('pressed');
    setTimeout(() => btn.classList.remove('pressed'), 120);
    if (btn.dataset.key) {
      send({ type: 'key', key: btn.dataset.key });
    } else if (btn.dataset.hotkey) {
      send({ type: 'hotkey', keys: JSON.parse(btn.dataset.hotkey) });
    }
  };
  btn.addEventListener('touchstart', (e) => { e.preventDefault(); keyTap(); }, { passive: false });
  btn.addEventListener('click', keyTap);
});

/* Custom combo: type "win+v" / "ctrl+shift+esc" and hit Send */
const COMBO_ALIASES = {
  win: 'win', windows: 'win', cmd: 'win',
  ctrl: 'ctrl', control: 'ctrl',
  alt: 'alt', option: 'alt',
  shift: 'shift',
  esc: 'esc', escape: 'esc',
  enter: 'enter', return: 'enter',
  tab: 'tab', space: 'space', spc: 'space',
  del: 'delete', backspace: 'backspace', bksp: 'backspace',
  prtsc: 'printscreen', printscreen: 'printscreen', prtscr: 'printscreen',
  home: 'home', end: 'end', insert: 'insert', ins: 'insert',
  pageup: 'pageup', pgup: 'pageup', pagedown: 'pagedown', pgdn: 'pagedown',
  up: 'up', down: 'down', left: 'left', right: 'right',
  capslock: 'capslock', numlock: 'numlock', scrolllock: 'scrolllock',
  pause: 'pause', break: 'pause'
};
for (let i = 1; i <= 12; i++) COMBO_ALIASES['f' + i] = 'f' + i;

function parseCombo(str) {
  return str.split('+')
    .map((s) => {
      const k = s.trim().toLowerCase();
      if (COMBO_ALIASES[k]) return COMBO_ALIASES[k];
      if (/^[a-z0-9]$/.test(k)) return k;   // single letters/digits pass through
      return null;
    })
    .filter(Boolean);
}

function sendCombo() {
  const keys = parseCombo($('combo-input').value);
  if (!keys.length) return;
  send({ type: 'hotkey', keys });
  const btn = $('combo-send');
  btn.classList.add('pressed');
  setTimeout(() => btn.classList.remove('pressed'), 120);
}
$('combo-send').addEventListener('click', sendCombo);
$('combo-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendCombo(); });

/* ---- Start ----
   If the laptop QR was scanned, the URL carries ?code=NNNN — auto-fill it
   and pair automatically as soon as the socket opens. */
window.addEventListener('load', () => {
  const params = new URLSearchParams(location.search);
  const code = (params.get('code') || '').trim();
  if (code.length >= 4) {
    $('pair-input').value = code;
    pendingCode = code;
    setStatus('Connecting…');
  } else if (localStorage.getItem('pr_code')) {
    $('pair-input').value = localStorage.getItem('pr_code');
  }
  connect();
});
