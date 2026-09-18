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
import { drawTrombone, drawAccordion, drawMaraca, drawDrums, drawHarp, drawBass, drawHandSkeleton } from "./draw.js";

/* ---------------- tuning ---------------- */
const TROMBONE_EXTENT = { min: 1.0, max: 4.2 };  // mouth↔hand distance in eye-widths -> slide 0..1
const ACCORDION_SPREAD = { min: 2.2, max: 7.5 }; // hand separation in eye-widths -> scale index
const BELLOWS_SPEED = 5.0;                       // eye-widths/sec that maps to full volume
const BLOW_ON = 0.16, BLOW_OFF = 0.09;           // jawOpen hysteresis
const MARACA_SWING_SPEED = 4.5;                  // eye-widths/sec to enter a swing
const MARACA_FIRE_SPEED = 1.5;                   // swing ends when speed drops below this
const MARACA_FULL_SPEED = 18;                    // swing peak for full-volume rattle
const MARACA_COOLDOWN_MS = 60;                   // min gap between hits, per hand
const DRUM_ZONE_Y = 0.58;                        // pads live in the bottom fraction of the frame
const DRUM_HIT_SPEED = 3.5;                      // downward eye-widths/sec to strike
const DRUM_FULL_SPEED = 16;
const DRUM_REARM_SPEED = 1.2;                    // must slow below this before the next strike
const NOD_SPEED = 1.7;                           // face downward speed (eye-widths/s) = kick
const NOD_COOLDOWN_MS = 240;
const HARP_STRINGS = 10;
const HARP_WIDTH_EYE = 4.8;                      // harp span in eye-widths
const HARP_HEIGHT_EYE = 5.4;                     // string length in eye-widths
const PLUCK_SPEED = 1.5;                         // fingertip speed (eye-widths/s) to pluck
const PLUCK_FULL_SPEED = 9;
const TIP_IDS = [4, 8, 12, 16, 20];              // MediaPipe fingertip landmarks
const BASS_SLOTS = 6;                            // frets: C2 D2 E2 G2 A2 C3
const BASS_LEN_EYE = 5.2;                        // neck length in eye-widths
const BASS_NECK_Y_EYE = 1.5;                     // neck sits this far below the mouth
const BASS_PLUCK_SPEED = 3.2;                    // downward flick (eye-widths/s) to pluck
const BASS_FULL_SPEED = 14;
const BASS_REARM_SPEED = 1.2;
const BASS_COOLDOWN_MS = 90;
const MOUSE_MOUTH = { x: 0.5, y: 0.28 };
const MOUSE_EYE_DIST = 0.075;                    // virtual eye width (fraction of canvas width)

/* Quality tiers — the governor steps between them based on measured fps.
 * The expensive bits are canvas shadow/glow rasterization (slow in WebKit)
 * and per-frame inference, so tiers trade those off. */
const QUALITY_TIERS = {
  high: { fx: true, canvasMaxWidth: 1920, faceStride: 2 },
  med: { fx: true, canvasMaxWidth: 1600, faceStride: 2 },
  low: { fx: false, canvasMaxWidth: 1280, faceStride: 3 },
};
const TIERS = ["low", "med", "high"];

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
  quality: "med",           // low | med | high — see QUALITY_TIERS
  debug: false,
  blowing: false,          // trombone gate (mouth open / mouse held)
  slide01: 0,
  spread01: 0,
  spreadRaw: 0,
  volume: 0,
  maracaVolume: 0,
  lastDrumHit: -1e9,
  lastBassPluck: -1e9,
  freq: 0,
  faceSeen: false,
  handCount: 0,
  fps: 0,
};

function applyQuality(tier) {
  app.quality = tier;
  const q = QUALITY_TIERS[tier];
  tracker.faceStride = q.faceStride;
  video.classList.toggle("fx", q.fx);
  if (app.mode !== "idle") fitCanvas();
  return tier;
}

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
  palmL: new Smooth(0.4), // accordion/maraca left
  palmR: new Smooth(0.4), // accordion/maraca right
  slide: new Smooth(0.3),
  spread: new Smooth(0.4),
  volume: new Smooth(0.5),
};

// maraca shake trackers, one per hand slot (sorted left/right)
const maracaSlots = [0, 1].map(() => ({
  pos: null, vx: 0, vy: 0, lastT: null, lastHit: -1e9,
  intensity: 0, angle: 0,
  swinging: false, peak: 0,
}));

// drum strike trackers: one per hand (down-punch arming) + face (nod)
const DRUM_TYPES = ["kick", "hat", "snare", "tom", "floor"];
const DRUM_COLORS = ["#e05d5d", "#e0b95d", "#5dc0e0", "#8d5de0", "#5de08d"];
const DRUM_LABELS = ["kick", "hi-hat", "snare", "tom", "floor"];
const drumSlots = [0, 1].map(() => ({ pos: null, lastT: null, armed: true }));
const drumFace = { y: null, lastT: null };
const drumFlashes = { lanes: DRUM_TYPES.map(() => -1e9), kick: -1e9, kickByHand: -1e9 };

// harp: fingertip pluck trackers + string ripple state
const harpTips = new Map(); // "hand:tip" -> { x, y }
const harpStrings = Array.from({ length: HARP_STRINGS }, () => ({
  amp: 0, phase: 0, pluckT: -1e9,
}));
let harpLastT = null;

// bass: pluck-hand arming (index = sorted hand slot) + string ripple
const bassSlots = [0, 1].map(() => ({ pos: null, lastT: null, armed: true }));
const bassString = { amp: 0, phase: 0, pluckT: -1e9, pluckX: 0 };
let appBassDecayT = null;

/* ---------------- debug hooks (also handy for automated testing) ---------------- */
window.__II_DEBUG = {
  app,
  engine,
  tracker,
  errors: [],
  applyQuality,
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
    // match the video's aspect ratio; cap the total so fill/stroke raster
    // work stays cheap on weak GPUs (shadows are the expensive part)
    const maxWidth = QUALITY_TIERS[app.quality].canvasMaxWidth;
    const factor = Math.min(window.devicePixelRatio || 1, 2, maxWidth / video.videoWidth);
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
    // 640×480 is plenty for tracking at webcam distances and keeps both the
    // camera pipeline and inference feed cheap
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
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
  for (const slot of maracaSlots) {
    slot.pos = null;
    slot.lastT = null;
    slot.intensity = 0;
  }
  app.maracaVolume = 0;
  for (const slot of drumSlots) { slot.pos = null; slot.lastT = null; slot.armed = true; }
  drumFace.y = null; drumFace.lastT = null;
  harpTips.clear();
  for (const s of harpStrings) { s.amp = 0; s.pluckT = -1e9; }
  for (const slot of bassSlots) { slot.pos = null; slot.lastT = null; slot.armed = true; }
  bassString.amp = 0; bassString.pluckT = -1e9;
}

$("startBtn").addEventListener("click", startCamera);
$("mouseBtn").addEventListener("click", startMouseMode);
$("muteBtn").addEventListener("click", () => {
  engine.setMuted(!engine.muted);
  $("muteBtn").textContent = engine.muted ? "Muted" : "Mute";
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
  else if (e.key === "3") setInstrument("maracas");
  else if (e.key === "4") setInstrument("drums");
  else if (e.key === "5") setInstrument("harp");
  else if (e.key === "6") setInstrument("bass");
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
applyQuality("med"); // also sets tracker stride + video filter class up front
tracker.init((msg) => {
  const el = document.getElementById("modelStatus");
  if (!el) return;
  el.textContent = msg === "Ready"
    ? "Models ready — the camera will start instantly"
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
  // the accordion needs two mirrored hands; the others play the pointer alone
  const twoHands = app.instrument === "accordion";
  app.handCount = twoHands ? 2 : 1;
  return {
    face: { mouth, eyePx, openness: pointer.down || pointer.space ? 1 : 0 },
    hands: twoHands ? [{ palm: right }, { palm: left }] : [{ palm: right }],
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

/**
 * Maracas: one per hand. Like the real thing, the beads fly during the fast
 * part of a swing and clack when the hand turns around — so a hit fires when
 * a fast swing settles (speed rises over the swing threshold, then drops to
 * near rest). Volume comes from the swing's peak speed. Velocity is measured
 * on raw positions with light smoothing to reject landmark jitter.
 */
function updateMaracas(frame, now) {
  const eyePx = frame.face?.eyePx || canvas.width * 0.075;
  const active = app.instrument === "maracas";
  const sorted = frame.hands.length >= 2
    ? [...frame.hands].sort((a, b) => a.palm.x - b.palm.x)
    : frame.hands;

  const out = [];
  let maxI = 0;
  for (let i = 0; i < 2; i++) {
    const slot = maracaSlots[i];
    const hand = sorted[i];
    if (!hand) {
      slot.pos = null;
      slot.lastT = null;
      slot.intensity = 0;
      slot.swinging = false;
      slot.peak = 0;
      continue;
    }
    const palmSmoothed = (i === 0 ? sm.palmL : sm.palmR).set(hand.palm);

    if (slot.pos === null || slot.lastT === null) {
      slot.pos = { x: hand.palm.x, y: hand.palm.y };
      slot.lastT = now;
      slot.vx = slot.vy = 0;
    } else {
      const dt = Math.min(Math.max((now - slot.lastT) / 1000, 1 / 240), 0.1);
      slot.lastT = now;
      const rawVx = (hand.palm.x - slot.pos.x) / dt / eyePx; // eye-widths/sec
      const rawVy = (hand.palm.y - slot.pos.y) / dt / eyePx;
      slot.vx = lerp(slot.vx, rawVx, 0.5); // light smoothing vs landmark jitter
      slot.vy = lerp(slot.vy, rawVy, 0.5);
      const speed = Math.hypot(slot.vx, slot.vy);

      // swing state machine: fast -> (peak captured) -> settles = clack
      if (!slot.swinging) {
        if (speed > MARACA_SWING_SPEED) {
          slot.swinging = true;
          slot.peak = speed;
        }
      } else {
        slot.peak = Math.max(slot.peak, speed);
        if (speed < MARACA_FIRE_SPEED) {
          slot.swinging = false;
          if (active && now - slot.lastHit > MARACA_COOLDOWN_MS) {
            slot.lastHit = now;
            const vol = Math.max(0.35, clamp01(slot.peak / MARACA_FULL_SPEED) ** 0.8);
            slot.intensity = Math.max(slot.intensity, vol);
            engine.maraca?.hit(vol);
          }
        }
      }

      slot.intensity *= Math.exp(-dt * 7); // rattle settles
      // lean into horizontal motion; hold still -> upright
      slot.angle = Math.max(-0.55, Math.min(0.55, slot.vx * 0.035)) *
        Math.min(1, speed / MARACA_SWING_SPEED);
      slot.pos = { x: hand.palm.x, y: hand.palm.y };
      maxI = Math.max(maxI, slot.intensity);
    }
    out.push({ palm: palmSmoothed, intensity: slot.intensity, angle: slot.angle, lastHit: slot.lastHit });
  }

  app.maracaVolume = active ? maxI : 0;
  return { visible: out.length > 0, hands: out };
}

/**
 * Drums: five pads across the bottom. A strike is a fast DOWNWARD punch
 * while the palm is inside a pad's lane (per-hand re-arm so one punch is
 * one hit); a quick downward nod of the face also plays the kick.
 */
function updateDrums(frame, now) {
  const active = app.instrument === "drums";
  const eyePx = frame.face?.eyePx || canvas.width * 0.075;
  const zoneY = canvas.height * DRUM_ZONE_Y;
  const sorted = frame.hands.length >= 2
    ? [...frame.hands].sort((a, b) => a.palm.x - b.palm.x)
    : frame.hands;

  for (let i = 0; i < 2; i++) {
    const slot = drumSlots[i];
    const hand = sorted[i];
    if (!hand) { slot.pos = null; slot.lastT = null; slot.armed = true; continue; }

    if (!slot.pos || !slot.lastT) {
      slot.pos = { x: hand.palm.x, y: hand.palm.y };
      slot.lastT = now;
      continue;
    }
    const dt = Math.min(Math.max((now - slot.lastT) / 1000, 1 / 240), 0.1);
    const vy = (hand.palm.y - slot.pos.y) / dt / eyePx; // + = moving down
    slot.pos = { x: hand.palm.x, y: hand.palm.y };
    slot.lastT = now;

    if (slot.armed && vy > DRUM_HIT_SPEED && hand.palm.y > zoneY) {
      slot.armed = false;
      const lane = Math.min(DRUM_TYPES.length - 1, Math.max(0,
        Math.floor((hand.palm.x / canvas.width) * DRUM_TYPES.length)));
      const vol = Math.max(0.3, clamp01(vy / DRUM_FULL_SPEED) ** 0.85);
      if (active) {
        drumFlashes.lanes[lane] = now;
        if (lane === 0) drumFlashes.kick = now;
        app.lastDrumHit = now;
        engine.drums?.hit(DRUM_TYPES[lane], vol);
      }
    } else if (vy < DRUM_REARM_SPEED) {
      slot.armed = true; // pulled back up / settled — ready for the next hit
    }
  }

  // head nod -> kick (downward face motion spike, normalized by eye width)
  if (frame.face) {
    if (drumFace.y !== null && drumFace.lastT !== null) {
      const dt = Math.min(Math.max((now - drumFace.lastT) / 1000, 1 / 240), 0.1);
      const vy = (frame.face.mouth.y - drumFace.y) / dt / eyePx;
      if (active && vy > NOD_SPEED && now - drumFlashes.kick > NOD_COOLDOWN_MS) {
        drumFlashes.kick = now;
        drumFlashes.lanes[0] = now;
        app.lastDrumHit = now;
        engine.drums?.hit("kick", Math.min(1, vy / (NOD_SPEED * 3)));
      }
    }
    drumFace.y = frame.face.mouth.y;
    drumFace.lastT = now;
  } else {
    drumFace.y = null;
    drumFace.lastT = null;
  }

  // mouse mode: hold click / Space for the kick
  if (active && app.mode === "mouse" && (pointer.down || pointer.space) &&
      now - drumFlashes.kick > 220) {
    drumFlashes.kick = now;
    drumFlashes.lanes[0] = now;
    app.lastDrumHit = now;
    engine.drums?.hit("kick", 0.9);
  }

  return { visible: true };
}

/**
 * Harp: hangs below the face (hands stay free). Every fingertip is a
 * plectrum — a fingertip crossing a string's x with enough horizontal
 * speed plucks it. Velocity uses raw landmark positions.
 */
function updateHarp(frame, now) {
  const eyePx = frame.face?.eyePx || canvas.width * 0.075;
  const mouth = frame.face?.mouth || { x: canvas.width / 2, y: canvas.height * 0.3 };
  const dt = harpLastT === null ? 1 / 60 : Math.min(Math.max((now - harpLastT) / 1000, 1 / 240), 0.1);
  harpLastT = now;

  const cx = mouth.x;
  const topY = mouth.y + eyePx * 0.45; // right at the chin
  const width = eyePx * HARP_WIDTH_EYE;
  const height = eyePx * HARP_HEIGHT_EYE;
  const xs = Array.from({ length: HARP_STRINGS }, (_, i) =>
    cx - width / 2 + ((i + 0.5) / HARP_STRINGS) * width);

  // decay existing ripples
  for (const s of harpStrings) s.amp *= Math.exp(-dt * 2.2);

  // collect plectra: fingertips from camera hands, the palm in mouse mode
  const tips = [];
  for (let i = 0; i < frame.hands.length && i < 2; i++) {
    const h = frame.hands[i];
    if (h.points) {
      for (let j = 0; j < TIP_IDS.length; j++) {
        const p = h.points[TIP_IDS[j]];
        tips.push({ key: `${i}:${j}`, x: (1 - p.x) * canvas.width, y: p.y * canvas.height });
      }
    } else {
      tips.push({ key: `${i}:palm`, x: h.palm.x, y: h.palm.y });
    }
  }

  if (app.instrument === "harp") {
    const bottomY = topY + height;
    for (const tip of tips) {
      const prev = harpTips.get(tip.key);
      harpTips.set(tip.key, { x: tip.x, y: tip.y });
      if (!prev) continue;
      const speed = Math.abs(tip.x - prev.x) / dt / eyePx;
      if (speed < PLUCK_SPEED) continue;
      for (let s = 0; s < HARP_STRINGS; s++) {
        // crossed the string between frames?
        if ((prev.x - xs[s]) * (tip.x - xs[s]) < 0 && now - harpStrings[s].pluckT > 70) {
          // ...and was the fingertip actually ON the string at that moment?
          const frac = (xs[s] - prev.x) / (tip.x - prev.x || 1);
          const yAtCross = prev.y + (tip.y - prev.y) * frac;
          if (yAtCross < topY || yAtCross > bottomY) continue;
          const vol = clamp01(speed / PLUCK_FULL_SPEED) ** 0.8;
          harpStrings[s].amp = Math.max(harpStrings[s].amp, vol);
          harpStrings[s].phase = Math.random() * Math.PI * 2;
          harpStrings[s].pluckT = now;
          engine.harp?.pluck(AudioEngine.harpFreq(s), vol);
        }
      }
    }
  } else {
    // keep tips fresh so re-entering the instrument doesn't ghost-cross
    for (const tip of tips) harpTips.set(tip.key, { x: tip.x, y: tip.y });
  }

  return { visible: true, cx, topY, width, height, xs };
}

/**
 * Bass: the neck hangs across the chest. The leftmost hand frets (its x
 * picks the slot; toward the bridge = higher note, like a real string),
 * the rightmost hand plucks with a quick downward flick over the neck.
 * One hand does both.
 */
function updateBass(frame, now) {
  const active = app.instrument === "bass";
  const eyePx = frame.face?.eyePx || canvas.width * 0.075;
  const mouth = frame.face?.mouth || { x: canvas.width / 2, y: canvas.height * 0.3 };
  const L = eyePx * BASS_LEN_EYE;
  const y = mouth.y + eyePx * BASS_NECK_Y_EYE;
  const x0 = mouth.x - L * 0.62;
  const x1 = x0 + L;
  const slotW = L / BASS_SLOTS;

  // string ripple decay
  if (appBassDecayT !== null) bassString.amp *= Math.exp(-((now - appBassDecayT) / 1000) * 3);
  appBassDecayT = now;

  const sorted = frame.hands.length >= 2
    ? [...frame.hands].sort((a, b) => a.palm.x - b.palm.x)
    : frame.hands;
  const fretter = sorted[0];
  const plucker = sorted[sorted.length - 1];

  let fretSlot = 0;
  if (fretter) {
    fretSlot = Math.min(BASS_SLOTS - 1, Math.max(0, Math.floor((fretter.palm.x - x0) / slotW)));
  }

  if (plucker) {
    const slot = plucker === fretter ? bassSlots[0] : bassSlots[1];
    if (!slot.pos || !slot.lastT) {
      slot.pos = { x: plucker.palm.x, y: plucker.palm.y };
      slot.lastT = now;
    } else {
      const dt = Math.min(Math.max((now - slot.lastT) / 1000, 1 / 240), 0.1);
      const vy = (plucker.palm.y - slot.pos.y) / dt / eyePx;
      slot.pos = { x: plucker.palm.x, y: plucker.palm.y };
      slot.lastT = now;

      const overNeck = plucker.palm.x > x0 - slotW * 0.2 && plucker.palm.x < x1 + slotW * 0.5;
      if (slot.armed && active && vy > BASS_PLUCK_SPEED && overNeck &&
          now - bassString.pluckT > BASS_COOLDOWN_MS) {
        slot.armed = false;
        const vol = Math.max(0.35, clamp01(vy / BASS_FULL_SPEED) ** 0.85);
        const freq = AudioEngine.bassFreq(fretSlot);
        bassString.amp = Math.max(bassString.amp, vol);
        bassString.phase = Math.random() * Math.PI * 2;
        bassString.pluckT = now;
        bassString.pluckX = Math.min(plucker.palm.x, bridgeX());
        app.lastBassPluck = now;
        app.freq = freq;
        engine.bass?.pluck(freq, vol);
      } else if (vy < BASS_REARM_SPEED) {
        slot.armed = true;
      }
    }
  }

  function bridgeX() { return x1 + eyePx * 2.3 * 0.42; }
  return { visible: true, x0, x1, y, fretSlot, slots: BASS_SLOTS };
}

/* ---------------- render ---------------- */

function render(frame, tromboneState, accordionState, maracaState, drumState, harpState, bassState, now) {
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
  const fx = QUALITY_TIERS[app.quality].fx;

  if (app.instrument === "trombone" && tromboneState.visible) {
    drawTrombone(ctx, {
      mouth: tromboneState.mouth,
      hand: tromboneState.palm,
      blowing: tromboneState.blowing,
      scale,
      time: t,
      fx,
    });
  }
  if (app.instrument === "accordion" && accordionState.visible) {
    drawAccordion(ctx, {
      left: accordionState.left,
      right: accordionState.right,
      volume: accordionState.volume,
      scale,
      time: t,
      fx,
    });
  }
  if (app.instrument === "maracas" && maracaState.visible) {
    for (const m of maracaState.hands) {
      drawMaraca(ctx, {
        palm: m.palm,
        angle: m.angle,
        intensity: m.intensity,
        hitAge: (now - m.lastHit) / 1000,
        scale,
        fx,
      });
    }
  }
  if (app.instrument === "drums") {
    drawDrums(ctx, {
      lanes: DRUM_TYPES.map((type, i) => ({
        type,
        label: DRUM_LABELS[i],
        color: DRUM_COLORS[i],
        lastHit: drumFlashes.lanes[i],
      })),
      now,
      fx,
    });
  }
  if (app.instrument === "harp") {
    drawHarp(ctx, {
      cx: harpState.cx,
      topY: harpState.topY,
      width: harpState.width,
      height: harpState.height,
      strings: harpStrings,
      now,
      fx,
    });
  }
  if (app.instrument === "bass") {
    drawBass(ctx, {
      x0: bassState.x0,
      x1: bassState.x1,
      y: bassState.y,
      fretSlot: bassState.fretSlot,
      slots: bassState.slots,
      string: bassString,
      now,
      fx,
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
      `mode=${app.mode} fps=${app.fps.toFixed(0)} quality=${app.quality}${app.cpuFallback ? " (cpu)" : ""} hands=${app.handCount} face=${app.faceSeen}`,
      `slide=${app.slide01.toFixed(2)} spread=${app.spread01.toFixed(2)} shake=${app.maracaVolume.toFixed(2)} drums=${engine.drums?.hitCount ?? 0} plucks=${engine.harp?.pluckCount ?? 0} bass=${engine.bass?.pluckCount ?? 0}`,
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
  const cpu = app.cpuFallback ? " · CPU" : "";
  if (app.mode === "mouse") {
    setStatus("Mouse mode", "ok");
    showHint({
      trombone: "Move the pointer to work the slide — <em>hold click or Space to blow</em>",
      accordion: "Move the pointer: distance from center is the bellows — <em>pump it to play</em>",
      maracas: "<em>Shake</em> the pointer back and forth to rattle the maraca",
      drums: "Sweep the pointer <em>down</em> into a pad to hit it — <em>hold click for the kick</em>",
      harp: "Sweep the pointer <em>across</em> the strings to pluck them",
      bass: "Slide to choose the note — flick the pointer <em>down</em> to pluck",
    }[app.instrument]);
    return;
  }

  if (!tracker.faceLandmarker) { setStatus("Loading models…", "busy"); return; }

  if (app.instrument === "trombone") {
    if (!app.faceSeen) {
      setStatus(`Searching for you…${cpu}`, "warn");
      showHint(tracker.detectCount > 90
        ? "Still no face — try more <em>light</em>, or face the camera directly"
        : "Show your face — the trombone hangs off your <em>mouth</em>");
    } else if (!tromboneState.visible) {
      setStatus(`Tracking · need a hand${cpu}`, "warn");
      showHint("Reach out <em>one hand</em> to grab the trombone slide");
    } else if (!app.blowing) {
      setStatus(`Tracking${cpu}`, "ok");
      showHint("Open your <em>mouth</em> to blow — pull your hand to slide");
    } else {
      setStatus(`Playing${cpu}`, "ok");
      showHint("Pull the slide out for <em>lower</em> notes, in for higher");
    }
  } else if (app.instrument === "accordion") {
    if (app.handCount < 2) {
      setStatus(`Tracking · need both hands${cpu}`, "warn");
      showHint("Show <em>both hands</em> — one on each end of the accordion");
    } else if (app.volume < 0.08) {
      setStatus(`Tracking${cpu}`, "ok");
      showHint("Pump your hands <em>together and apart</em> to squeeze the bellows");
    } else {
      setStatus(`Playing${cpu}`, "ok");
      showHint("Wider apart = <em>higher</em> notes — keep pumping to keep singing");
    }
  } else if (app.instrument === "maracas") {
    if (app.handCount < 1) {
      setStatus(`Searching for you…${cpu}`, "warn");
      showHint("Hold up a <em>hand</em> — or two, one maraca each");
    } else if (app.maracaVolume < 0.12) {
      setStatus(`Tracking${cpu}`, "ok");
      showHint("<em>Shake</em> it! Quick back-and-forth shakes rattle the beads");
    } else {
      setStatus(`Shaking${cpu}`, "ok");
      showHint("Shake <em>harder</em> for louder — both hands for double maracas");
    }
  } else if (app.instrument === "drums") {
    if (app.handCount < 1) {
      setStatus(`Searching for you…${cpu}`, "warn");
      showHint("Put your <em>hands</em> in frame — the pads are at the bottom");
    } else if (now() - app.lastDrumHit > 1500) {
      setStatus(`Tracking${cpu}`, "ok");
      showHint("<em>Punch down</em> into a pad to hit it — <em>nod your head</em> for the kick");
    } else {
      setStatus(`Drumming${cpu}`, "ok");
      showHint("Faster punches hit <em>harder</em> — nod again for more kick");
    }
  } else if (app.instrument === "harp") {
    if (app.handCount < 1) {
      setStatus(`Searching for you…${cpu}`, "warn");
      showHint("Raise a <em>hand</em> — the harp hangs below your face");
    } else if (engine.harp && now() - lastHarpPluckT() > 1500) {
      setStatus(`Tracking${cpu}`, "ok");
      showHint("Sweep your <em>fingertips across</em> the strings to pluck them");
    } else {
      setStatus(`Plucking${cpu}`, "ok");
      showHint("Sweep <em>faster</em> for louder plucks — both hands, all ten fingers");
    }
  } else if (app.instrument === "bass") {
    if (app.handCount < 1) {
      setStatus(`Searching for you…${cpu}`, "warn");
      showHint("Show your <em>face</em> — the bass hangs across your chest");
    } else if (now() - app.lastBassPluck > 1500) {
      setStatus(`Tracking${cpu}`, "ok");
      showHint(app.handCount < 2
        ? "Slide along the <em>neck</em> to choose a note — flick <em>down</em> to pluck"
        : "Left hand works the <em>frets</em> — flick your right hand <em>down</em> over the strings");
    } else {
      setStatus(`Plucking${cpu}`, "ok");
      showHint("Slide <em>right</em> for higher notes — flick harder for more punch");
    }
  }
}

function now() { return performance.now(); }
function lastHarpPluckT() {
  return harpStrings.reduce((m, s) => Math.max(m, s.pluckT), -1e9);
}

/* ---------------- main loop ---------------- */

/** One frame of work, independent of how it's scheduled. */
function frame(now) {
  const dt = now - lastFrame;
  lastFrame = now;
  app.fps = app.fps ? lerp(app.fps, 1000 / Math.max(dt, 1), 0.08) : 60;

  if (app.mode === "camera" && (video.videoWidth !== canvas.width || video.videoHeight !== canvas.height)) {
    fitCanvas();
  }

  const tromboneState = updateTrombone(lastFrameState);
  const accordionState = updateAccordion(lastFrameState, now);
  const maracaState = updateMaracas(lastFrameState, now);
  const drumState = updateDrums(lastFrameState, now);
  const harpState = updateHarp(lastFrameState, now);
  const bassState = updateBass(lastFrameState, now);
  render(lastFrameState, tromboneState, accordionState, maracaState, drumState, harpState, bassState, now);

  if (now - (frame._lastUI ?? 0) > 300) { // don't thrash the DOM every frame
    frame._lastUI = now;
    fpsEl.textContent = `${app.fps.toFixed(0)} fps`;
    updateStatusAndHints(tromboneState, accordionState);
  }
}

/**
 * Adaptive quality: if the render loop can't hold ~34fps we step down a tier
 * (smaller canvas, no glow raster, sparser face inference); if it comfortably
 * exceeds ~52fps for a while we step back up. Hysteresis keeps it stable.
 */
function qualityGovernor(now) {
  if (app.mode !== "camera" || app.rebuilding) return;
  governor._lastCheck ??= now;
  governor._goodSince ??= now;
  if (now - governor._lastCheck < 1500) return;
  governor._lastCheck = now;

  const fps = app.fps;
  if (fps > 5 && fps < 34) {
    governor._goodSince = now;
    const idx = TIERS.indexOf(app.quality);
    if (idx > 0) applyQuality(TIERS[idx - 1]);
  } else if (fps > 52) {
    const idx = TIERS.indexOf(app.quality);
    if (idx < TIERS.length - 1 && now - governor._goodSince > 8000) {
      governor._goodSince = now;
      applyQuality(TIERS[idx + 1]);
    }
  } else {
    governor._goodSince = now;
  }
}
const governor = {};

function loop(now) {
  if (!app.running) return;
  requestAnimationFrame(loop);

  const frameData = app.mode === "camera" ? readCameraFrame(now) : readMouseFrame();
  if (!frameData) return;
  lastFrameState = frameData;
  frame(now);
  qualityGovernor(now);

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
      applyQuality("low"); // CPU inference is the heavy path; shed visuals too
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
