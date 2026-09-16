/**
 * tracking.js — camera + MediaPipe Tasks Vision wrapper.
 *
 * Runs FaceLandmarker (1 face, blendshapes for jaw-open) and HandLandmarker
 * (2 hands) on every video frame, and distills the raw landmarks down to the
 * handful of points the instruments actually need:
 *
 *   face : mouth position, mouth openness 0..1, eye distance (scale reference)
 *   hands: palm centroid for each detected hand
 *
 * All coordinates are normalized 0..1 in *video* space (not yet mirrored for
 * display — main.js does that when converting to canvas pixels).
 */

import {
  FilesetResolver,
  FaceLandmarker,
  HandLandmarker,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";

const WASM_BASE =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const FACE_MODEL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const HAND_MODEL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

// Key face landmark indices (FaceMesh topology)
const LM_UPPER_LIP = 13;
const LM_LOWER_LIP = 14;
const LM_EYE_OUTER_L = 33;
const LM_EYE_OUTER_R = 263;
const PALM_IDS = [0, 5, 9, 13, 17]; // wrist + finger bases -> steady palm centroid

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export class Tracker {
  constructor() {
    this.faceLandmarker = null;
    this.handLandmarker = null;
    this.video = null;
    this.lastVideoTime = -1;
    // health stats, used by main.js to detect a stalled GPU pipeline
    this.detectCount = 0;
    this.framesWithFace = 0;
    this.errorCount = 0;
  }

  /** Load WASM + both models. ~15 MB total, cached by the browser afterwards. */
  async init(onProgress = () => {}) {
    onProgress("Loading tracking engine…");
    const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
    await this.createLandmarkers(fileset, "GPU", onProgress);
  }

  /**
   * Some browsers (notably WebKit) accept the GPU delegate but then silently
   * return no detections. Rebuilding on CPU is the reliable recovery.
   */
  async rebuildOnCpu(onProgress = () => {}) {
    this.close();
    onProgress("Reloading tracking on CPU");
    const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
    await this.createLandmarkers(fileset, "CPU", onProgress);
  }

  async createLandmarkers(fileset, delegate, onProgress) {
    // Some machines have no usable WebGL — fall back to the CPU delegate.
    const create = async (Cls, label, opts, wanted) => {
      try {
        return await Cls.createFromOptions(fileset, {
          ...opts,
          baseOptions: { ...opts.baseOptions, delegate: wanted },
        });
      } catch {
        if (wanted === delegate) throw new Error(`${label} failed to load`);
        onProgress(`${label}: using CPU…`);
        return await Cls.createFromOptions(fileset, {
          ...opts,
          baseOptions: { ...opts.baseOptions, delegate: "CPU" },
        });
      }
    };

    onProgress("Loading face model…");
    this.faceLandmarker = await create(FaceLandmarker, "Face model", {
      baseOptions: { modelAssetPath: FACE_MODEL },
      runningMode: "VIDEO",
      numFaces: 1,
      outputFaceBlendshapes: true, // for the calibrated jawOpen score
    }, delegate);

    onProgress("Loading hand model…");
    this.handLandmarker = await create(HandLandmarker, "Hand model", {
      baseOptions: { modelAssetPath: HAND_MODEL },
      runningMode: "VIDEO",
      numHands: 2,
      minHandDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5,
    }, delegate);
    onProgress("Ready");
  }

  close() {
    try { this.faceLandmarker?.close(); } catch { /* already gone */ }
    try { this.handLandmarker?.close(); } catch { /* already gone */ }
    this.faceLandmarker = null;
    this.handLandmarker = null;
    this.lastVideoTime = -1;
  }

  attach(video) {
    this.video = video;
    this.lastVideoTime = -1;
  }

  /**
   * Run detection for the current video frame.
   * Returns null when the video hasn't advanced (call again next rAF) or the
   * models are being rebuilt.
   */
  detect(nowMs) {
    if (!this.faceLandmarker || !this.handLandmarker) return null;
    const video = this.video;
    if (!video || video.readyState < 2 || video.videoWidth === 0) return null;
    if (video.currentTime === this.lastVideoTime) return this._lastResult ?? null;
    this.lastVideoTime = video.currentTime;

    let face = null;
    let hands = [];

    try {
      const faceRes = this.faceLandmarker.detectForVideo(video, nowMs);
      const lm = faceRes?.faceLandmarks?.[0];
      if (lm) {
        this.framesWithFace++;
        const upper = lm[LM_UPPER_LIP];
        const lower = lm[LM_LOWER_LIP];
        const eyeL = lm[LM_EYE_OUTER_L];
        const eyeR = lm[LM_EYE_OUTER_R];
        const eyeDist = dist(eyeL, eyeR) || 1e-4;

        // Prefer the calibrated blendshape score; fall back to lip geometry
        const cats = faceRes.faceBlendshapes?.[0]?.categories ?? [];
        const jaw = cats.find((c) => c.categoryName === "jawOpen");
        const geometric = Math.min(1, dist(upper, lower) / (eyeDist * 0.55));
        const openness = jaw ? jaw.score : geometric;

        face = {
          mouth: {
            x: (upper.x + lower.x) / 2,
            y: (upper.y + lower.y) / 2,
          },
          openness,
          eyeDist,
        };
      }

      const handRes = this.handLandmarker.detectForVideo(video, nowMs);
      const handLms = handRes?.landmarks ?? [];
      for (const pts of handLms) {
        let cx = 0, cy = 0;
        for (const i of PALM_IDS) { cx += pts[i].x; cy += pts[i].y; }
        hands.push({
          palm: { x: cx / PALM_IDS.length, y: cy / PALM_IDS.length },
          points: pts,
        });
      }
    } catch (err) {
      this.errorCount++;
      // detectForVideo throws on monotonically-violating timestamps after
      // tab throttling; dropping one frame is fine.
      if (this.errorCount % 10 === 1) console.warn(err);
    }

    this.detectCount++;
    this._lastResult = { face, hands };
    return this._lastResult;
  }
}
