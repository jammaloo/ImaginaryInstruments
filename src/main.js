/**
 * main.js — app state, input mapping, and the animation loop.
 *
 * Pipeline per frame:
 *   Tracker (camera) or virtual mouse rig  ->  smoothed points in canvas px
 *   -> instrument mapping (slide / bellows)  ->  audio voices
 *   -> canvas overlay drawing
 *
 * Mapping summary:
 *   Trombone: anchored to mouth + one hand. Mouth↔hand distance (in "eye
 *   widths") is the slide position; open mouth = blow. Prefer the hand on the
 *   right side of the screen; any single hand works.
 *   Accordion: between both hands. Hand separation sets the pitch; the SPEED
 *   of separation change drives volume, so sound only flows while you pump.
 */

import { AudioEngine } from "./audio.js";
import { Tracker } from "./tracking.js";
import { drawTrombone, drawAccordion, drawHandSkeleton } from "./draw.js";

/* ---------------- tuning ---------------- */
const TROMBONE_EXTENT = { min: 1.0, max: 4.2 };  // mouth↔hand distance in eye-widths -> slide 0..1
const ACCORDION_SPREAD = { min: 2.2, max: 7.5 }; // hand separation in eye-widths -> scale index
const BELLOWS_SPEED = 5.0;                       // eye-widths/sec that maps to full volume
const BLOW_ON = 0.16, BLOW_OFF = 0.09;           // jawOpen hysteresis
const MOUSE_MOUTH = { x: 0.5, y: 0.28 };
const MOUSE_EYE_DIST = 0.075;                    // virtual eye width (fraction of canvas width)

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const lerp = (a, b, t) => a + (b - a) * t;

class Smooth {
  constructor(k = 0.35) { this.k = k; this.v = null; }
  /** Smooths scalars and {x,y}-style point objects alike. */
  set(t) {
    if (t === null || t === undefined) { this.v = null; return null; }
    if (this.v === null) { this.v = t; return this.v; }
    if (typeof t === "object") {
      const out = {};
      for (const key of new Set([...Object.keys(this.v), ...Object.keys(t)])) {
        out[key] = lerp(Number(this.v[key]) || 0, Number(t[key]) || 0, this.k);
      }
      this.v = out;
    } else {
      this.v = lerp(this.v, t, this.k);
    }
    return this.v;
  }
  reset() { this.v = null; }
}

/* ---------------- elements ---------------- */
const $ = (id) => document.getElementById(id);
const video = $("video");
const canvas = $("overlay");
const ctx = canvas.getContext("2d");
const stage = $("stage");
const startPanel = $("startPanel");
const statusEl = $("status");
const hintEl = $("hint");
const fpsEl = $("fps");

/* ---------------- state ---------------- */
const app = {
  mode: "idle", // idle | camera | mouse
  instrument: "trombone",
  running: false,
  loopStarted: false,
  cpuFallback: false,
  rebuilding: false,
  debug: false,
  blowing: false,          // trombone gate (mouth open / mouse held)
  slide01: 0,
  spread01: 0,
  spreadRaw: 0,
  volume: 0,
  freq: 0,
  faceSeen: false,
  handCount: 0,
  fps: 0,
};

const engine = new AudioEngine();
const tracker = new Tracker();

const pointer = { x: 0.5, y: 0.5, down: false, space: false };
let lastFrame = performance.now();
let lastBellowsT = performance.now();
let lastFrameState = null;

// smoothers (reset when the tracked part disappears)
const sm = {
  mouth: new Smooth(0.4),
  eye: new Smooth(0.2),
  open: new Smooth(0.5),
  palmA: new Smooth(0.4), // trombone hand
  palmL: new Smooth(0.4), // accordion left
  palmR: new Smooth(0.4),
  slide: new Smooth(0.3),
  spread: new Smooth(0.4),
  volume: new Smooth(0.5),
};

/* ---------------- debug hooks (also handy for automated testing) ---------------- */
window.__II_DEBUG = {
  app,
  engine,
  errors: [],
  /** Manually run one frame with the mouse rig — used by automated tests
   *  when rAF is suspended (background webviews). */
  tick: (now) => {
    lastFrameState = readMouseFrame();
    frame(now);
  },
};
window.addEventListener("error", (e) => window.__II_DEBUG.errors.push(String(e.message)));

/* ---------------- canvas sizing ---------------- */
function fitCanvas() {
  let w, h;
  if (app.mode === "camera" && video.videoWidth) {
    // match the video's aspect ratio; extra resolution just sharpens the overlay
    const factor = Math.min(window.devicePixelRatio || 1, 2, 2600 / video.videoWidth);
    w = video.videoWidth * factor;
    h = video.videoHeight * factor;
  } else {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = stage.clientWidth * dpr;
    h = stage.clientHeight * dpr;
  }
  canvas.width = Math.round(w);
  canvas.height = Math.round(h);
}
window.addEventListener("resize", fitCanvas);

/* ---------------- camera / tracking ---------------- */
async function startCamera() {
  ensureAudio();
  hidePanel();
  app.mode = "camera";
  app.running = true;
  fitCanvas();

  try {
    setStatus("Loading tracking models…", "busy");
    await tracker.init((msg) => setStatus(msg + "…", "busy"));

    setStatus("Requesting camera…", "busy");
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    video.srcObject = stream;
    await video.play().catch(() => {});
    video.classList.add("active");
    tracker.attach(video);
    setStatus("Searching for you…", "warn");
    startLoop(); // <- without this the camera feed never gets analyzed
  } catch (err) {
    console.warn(err);
    const denied = err?.name === "NotAllowedError" || err?.name === "NotFoundError";
    setStatus(denied ? "Camera unavailable" : "Startup failed", "warn");
    showHint(denied
      ? "Camera unavailable — switching to <em>mouse mode</em>. Reload to try again."
      : `Startup failed: ${escapeHtml(err?.message ?? err)} — switching to mouse mode.`);
    setTimeout(() => startMouseMode(), 1600);
  }
}

/** Kick off the render loop exactly once, from whichever mode starts first. */
function startLoop() {
  if (app.loopStarted) return;
  app.loopStarted = true;
  requestAnimationFrame(loop);
}

function startMouseMode() {
  ensureAudio();
  hidePanel();
  app.mode = "mouse";
  app.running = true;
  video.classList.remove("active");
  fitCanvas();
  setStatus("Mouse mode", "ok");
  startLoop();
}

function hidePanel() {
  startPanel.classList.add("hidden");
  $("topbar").classList.remove("hidden");
  hintEl.classList.remove("hidden");
  fpsEl.classList.remove("hidden");
}

function ensureAudio() {
  engine.ensure();
}

/* ---------------- input ---------------- */
function setInstrument(name) {
  if (app.instrument === name) return;
  app.instrument = name;
  for (const btn of document.querySelectorAll(".switch-btn")) {
    btn.classList.toggle("active", btn.dataset.instrument === name);
  }
  engine.trombone?.silence();
  engine.accordion?.silence();
  sm.slide.reset();
  sm.spread.reset();
  sm.volume.reset();
  app.spreadRaw = 0;
}

$("startBtn").addEventListener("click", startCamera);
$("mouseBtn").addEventListener("click", startMouseMode);
$("muteBtn").addEventListener("click", () => {
  engine.setMuted(!engine.muted);
  $("muteBtn").textContent = engine.muted ? "🔇" : "🔊";
});
for (const btn of document.querySelectorAll(".switch-btn, .card")) {
  btn.addEventListener("click", () => setInstrument(btn.dataset.instrument));
}

stage.addEventListener("pointermove", (e) => {
  const r = stage.getBoundingClientRect();
  pointer.x = clamp01((e.clientX - r.left) / r.width);
  pointer.y = clamp01((e.clientY - r.top) / r.height);
});
stage.addEventListener("pointerdown", (e) => {
  if (app.mode === "idle") return;
  ensureAudio();
  pointer.down = true;
  const r = stage.getBoundingClientRect();
  pointer.x = clamp01((e.clientX - r.left) / r.width);
  pointer.y = clamp01((e.clientY - r.top) / r.height);
});
window.addEventListener("pointerup", () => (pointer.down = false));

window.addEventListener("keydown", (e) => {
  if (e.repeat) return;
  if (e.key === "1") setInstrument("trombone");
  else if (e.key === "2") setInstrument("accordion");
  else if (e.key.toLowerCase() === "d") app.debug = !app.debug;
  else if (e.key.toLowerCase() === "m" && app.mode !== "mouse") startMouseMode();
  else if (e.code === "Space" && app.mode === "mouse") {
    e.preventDefault();
    ensureAudio();
    pointer.space = true;
  }
});
window.addEventListener("keyup", (e) => {
  if (e.code === "Space") pointer.space = false;
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    engine.trombone?.silence();
    engine.accordion?.silence();
  }
});

/* ---------------- model preload ---------------- */

// Start pulling the ~15 MB of tracking models the moment the page opens, so
// the camera starts almost instantly when the user clicks. startCamera()
// awaits this same promise (init() is idempotent).
tracker.init((msg) => {
  const el = document.getElementById("modelStatus");
  if (!el) return;
  el.textContent = msg === "Ready"
    ? "Models ready — the camera will start instantly ✓"
    : `${msg} Feel free to keep reading, we'll be ready`;
}).catch(() => {
  const el = document.getElementById("modelStatus");
  if (el) el.textContent = "Couldn't preload models — they'll load when you press start";
});

/* ---------------- per-frame tracking ---------------- */

/** Convert normalized video coords to mirrored canvas px. */
const toPx = (p) => ({ x: (1 - p.x) * canvas.width, y: p.y * canvas.height });

function readCameraFrame(now) {
  const res = tracker.detect(now);
  if (!res) return null;

  const face = res.face;
  let mouth = null, eyePx = null, openness = 0;
  if (face) {
    mouth = sm.mouth.set(toPx(face.mouth));
    eyePx = sm.eye.set(face.eyeDist * canvas.width);
    openness = sm.open.set(face.openness) ?? 0;
  } else {
    sm.mouth.reset(); sm.eye.reset(); sm.open.reset();
  }

  const handsPx = res.hands.map((h) => ({ palm: toPx(h.palm), points: h.points }));
  app.faceSeen = !!face;
  app.handCount = handsPx.length;
  return { face: face ? { mouth, eyePx, openness } : null, hands: handsPx };
}

function readMouseFrame() {
  const mouth = { x: MOUSE_MOUTH.x * canvas.width, y: MOUSE_MOUTH.y * canvas.height };
  const eyePx = MOUSE_EYE_DIST * canvas.width;
  const right = { x: pointer.x * canvas.width, y: pointer.y * canvas.height };
  const left = { x: (1 - pointer.x) * canvas.width, y: pointer.y * canvas.height };
  app.faceSeen = true;
  app.handCount = app.instrument === "accordion" ? 2 : 1;
  return {
    face: { mouth, eyePx, openness: pointer.down || pointer.space ? 1 : 0 },
    hands: [{ palm: right }, { palm: left }],
  };
}

/* ---------------- instruments ---------------- */

function updateTrombone(frame) {
  const { face, hands } = frame;
  if (!face) {
    sm.palmA.reset();
    app.blowing = false;
    engine.trombone?.update({ active: false });
    return { visible: false };
  }

  // Prefer the hand on the right of the screen; a lone hand works too.
  let hand = null;
  if (hands.length) {
    hand = hands.reduce((a, b) => (a.palm.x > b.palm.x ? a : b));
  }
  const palm = hand ? sm.palmA.set(hand.palm) : (sm.palmA.reset(), null);

  // slide position from mouth↔hand distance measured in eye-widths
  let slide = app.slide01;
  if (palm && face.eyePx) {
    const ext = dist(palm, face.mouth) / face.eyePx;
    slide = sm.slide.set(clamp01((ext - TROMBONE_EXTENT.min) / (TROMBONE_EXTENT.max - TROMBONE_EXTENT.min)));
  } else {
    sm.slide.reset();
  }

  // mouth-open gate with hysteresis (louder when wider)
  const open = face.openness;
  if (open > BLOW_ON) app.blowing = true;
  else if (open < BLOW_OFF) app.blowing = false;

  const freq = AudioEngine.tromboneFreq(slide);
  app.slide01 = slide;
  app.freq = freq;
  const level = Math.max(0.35, clamp01((open - 0.05) / 0.4));
  const live = app.instrument === "trombone" && !!palm && app.blowing;
  engine.trombone?.update({ active: live, freq, level });

  return { visible: !!palm, mouth: face.mouth, palm, slide, blowing: live, eyePx: face.eyePx };
}

function updateAccordion(frame, now) {
  const { face, hands } = frame;

  // accordion works without a face: fall back to a default eye-width scale
  const eyePx = face?.eyePx || canvas.width * 0.075;

  let left = null, right = null;
  if (hands.length >= 2) {
    const sorted = [...hands].sort((a, b) => a.palm.x - b.palm.x);
    left = sm.palmL.set(sorted[0].palm);
    right = sm.palmR.set(sorted[1].palm);
  } else {
    sm.palmL.reset(); sm.palmR.reset();
  }

  if (!left || !right) {
    sm.spread.reset(); sm.volume.reset(); app.volume = 0; app.spreadRaw = 0;
    engine.accordion?.update({ active: false });
    return { visible: false };
  }

  const raw = dist(left, right) / eyePx;
  const spread01 = sm.spread.set(clamp01((raw - ACCORDION_SPREAD.min) / (ACCORDION_SPREAD.max - ACCORDION_SPREAD.min)));

  // bellows: volume follows how *fast* the separation changes
  const dt = Math.max((now - lastBellowsT) / 1000, 1 / 120);
  const speed = Math.abs(raw - (app.spreadRaw || raw)) / dt; // eye-widths per second
  lastBellowsT = now;
  app.spreadRaw = raw;

  const target = speed < 0.4 ? 0 : clamp01(speed / BELLOWS_SPEED) ** 0.7;
  app.volume = sm.volume.set(target) ?? 0;

  const freq = AudioEngine.accordionFreq(spread01);
  if (app.instrument === "accordion") {
    app.spread01 = spread01;
    app.freq = freq;
  }
  engine.accordion?.update({ active: app.instrument === "accordion", freq, volume: app.volume });

  return { visible: true, left, right, spread01, volume: app.volume };
}

/* ---------------- render ---------------- */

function render(frame, tromboneState, accordionState, now) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const t = now / 1000;

  // vignette in mouse mode so the stage doesn't look dead without a camera
  if (app.mode === "mouse") {
    const g = ctx.createRadialGradient(
      canvas.width / 2, canvas.height / 2, canvas.height * 0.15,
      canvas.width / 2, canvas.height / 2, canvas.height * 0.85
    );
    g.addColorStop(0, "rgba(30,38,66,0.35)");
    g.addColorStop(1, "rgba(5,8,15,0.7)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  const eyePx = tromboneState.eyePx || canvas.width * 0.075;
  const scale = eyePx * 2.3;

  if (app.instrument === "trombone" && tromboneState.visible) {
    drawTrombone(ctx, {
      mouth: tromboneState.mouth,
      hand: tromboneState.palm,
      blowing: tromboneState.blowing,
      scale,
      time: t,
    });
  }
  if (app.instrument === "accordion" && accordionState.visible) {
    drawAccordion(ctx, {
      left: accordionState.left,
      right: accordionState.right,
      volume: accordionState.volume,
      scale,
      time: t,
    });
  }

  if (app.debug) {
    if (app.mode === "camera") {
      for (const h of frame.hands) drawHandSkeleton(ctx, h.points, canvas.width, canvas.height);
      if (frame.face) {
        ctx.fillStyle = "#86efac";
        ctx.beginPath();
        ctx.arc(frame.face.mouth.x, frame.face.mouth.y, 8, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.font = `${Math.max(13, canvas.width * 0.014)}px ui-monospace, monospace`;
    const lines = [
      `mode=${app.mode} fps=${app.fps.toFixed(0)} hands=${app.handCount} face=${app.faceSeen}`,
      `slide=${app.slide01.toFixed(2)} spread=${app.spread01.toFixed(2)} raw=${(app.spreadRaw || 0).toFixed(2)}`,
      `open=${(frame.face?.openness ?? 0).toFixed(2)} blowing=${app.blowing} vol=${app.volume.toFixed(2)} freq=${app.freq.toFixed(1)}Hz`,
    ];
    lines.forEach((l, i) => ctx.fillText(l, 14, canvas.height * 0.06 + i * canvas.width * 0.018));
  }
}

/* ---------------- status & hints ---------------- */

function setStatus(text, cls = "") {
  statusEl.textContent = text;
  statusEl.className = `pill ${cls}`;
}

function showHint(html) {
  hintEl.innerHTML = html;
  hintEl.classList.remove("hidden");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function updateStatusAndHints(tromboneState, accordionState) {
  if (app.mode === "mouse") {
    setStatus("Mouse mode", "ok");
    showHint(app.instrument === "trombone"
      ? "Move the pointer to work the slide — <em>hold click or Space to blow</em>"
      : "Move the pointer: distance from center is the bellows — <em>pump it to play</em>");
    return;
  }

  if (!tracker.faceLandmarker) { setStatus("Loading models…", "busy"); return; }

  if (app.instrument === "trombone") {
    if (!app.faceSeen) {
      setStatus("Searching for you…", "warn");
      showHint(tracker.detectCount > 90
        ? "Still no face — try more <em>light</em>, or face the camera directly"
        : "Show your face — the trombone hangs off your <em>mouth</em>");
    } else if (!tromboneState.visible) {
      setStatus("Tracking · need a hand", "warn");
      showHint("Reach out <em>one hand</em> to grab the trombone slide");
    } else if (!app.blowing) {
      setStatus("Tracking ✓", "ok");
      showHint("Open your <em>mouth</em> to blow — pull your hand to slide 🎺");
    } else {
      setStatus("Playing 🎺", "ok");
      showHint("Pull the slide out for <em>lower</em> notes, in for higher");
    }
  } else {
    if (app.handCount < 2) {
      setStatus("Tracking · need both hands", "warn");
      showHint("Show <em>both hands</em> — one on each end of the accordion");
    } else if (app.volume < 0.08) {
      setStatus("Tracking ✓", "ok");
      showHint("Pump your hands <em>together and apart</em> to squeeze the bellows");
    } else {
      setStatus("Playing 🪗", "ok");
      showHint("Wider apart = <em>higher</em> notes — keep pumping to keep singing");
    }
  }
}

/* ---------------- main loop ---------------- */

/** One frame of work, independent of how it's scheduled. */
function frame(now) {
  const dt = now - lastFrame;
  lastFrame = now;
  app.fps = app.fps ? lerp(app.fps, 1000 / Math.max(dt, 1), 0.08) : 60;
  fpsEl.textContent = `${app.fps.toFixed(0)} fps`;

  if (app.mode === "camera" && (video.videoWidth !== canvas.width || video.videoHeight !== canvas.height)) {
    fitCanvas();
  }

  const tromboneState = updateTrombone(lastFrameState);
  const accordionState = updateAccordion(lastFrameState, now);
  render(lastFrameState, tromboneState, accordionState, now);

  if (now - (frame._lastUI ?? 0) > 300) { // don't thrash the DOM every frame
    frame._lastUI = now;
    updateStatusAndHints(tromboneState, accordionState);
  }
}

function loop(now) {
  if (!app.running) return;
  requestAnimationFrame(loop);

  const frameData = app.mode === "camera" ? readCameraFrame(now) : readMouseFrame();
  if (!frameData) return;
  lastFrameState = frameData;
  frame(now);

  // Watchdog: WebKit sometimes accepts the GPU delegate but then returns no
  // detections at all. If we've processed plenty of frames and never seen a
  // face (or errors keep piling up), rebuild the landmarkers on CPU once.
  if (app.mode === "camera" && !app.cpuFallback && !app.rebuilding) {
    const stalled =
      (tracker.detectCount > 45 && tracker.framesWithFace === 0) ||
      tracker.errorCount > 8;
    if (stalled) {
      app.rebuilding = true;
      setStatus("GPU tracking stalled — switching to CPU…", "busy");
      tracker.rebuildOnCpu((msg) => setStatus(msg + "…", "busy"))
        .then(() => { app.cpuFallback = true; })
        .catch((e) => {
          console.warn(e);
          setStatus("Tracking unavailable", "warn");
          showHint("Tracking failed to start — try <em>mouse mode</em> (press M).");
        })
        .finally(() => { app.rebuilding = false; });
    }
  }
}
