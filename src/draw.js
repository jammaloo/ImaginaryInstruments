/**
 * draw.js — canvas rendering for the instruments.
 *
 * Everything is drawn in canvas pixel space with the selfie-mirror already
 * applied by the caller (main.js), so "right on screen" == "your right hand".
 *
 * Both instruments scale with `scale` (≈ face width in pixels), so they keep a
 * sensible size as you lean toward or away from the camera.
 */

const BRASS_LIGHT = "#ffe9b0";
const BRASS_MID = "#e3b04b";
const BRASS_DARK = "#8a5a1d";

/** Shadow state is sticky on the context, so set it explicitly both ways. */
function setShadow(ctx, fx, color, blur, offsetY = 0) {
  if (fx) {
    ctx.shadowColor = color;
    ctx.shadowBlur = blur;
    ctx.shadowOffsetY = offsetY;
  } else {
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
  }
}

function brassGradient(ctx, x0, y0, x1, y1) {
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  g.addColorStop(0, BRASS_DARK);
  g.addColorStop(0.35, BRASS_MID);
  g.addColorStop(0.55, BRASS_LIGHT);
  g.addColorStop(0.8, BRASS_MID);
  g.addColorStop(1, BRASS_DARK);
  return g;
}

function brassStroke(ctx, s, widthUnits) {
  ctx.strokeStyle = brassGradient(ctx, 0, -s, 0, s); // perpendicular sheen
  ctx.lineWidth = s * widthUnits;
  ctx.lineCap = "round";
}

/* ------------------------------------------------------------------ */
/* Trombone — mouthpiece at the mouth, slide reaching out to the hand  */
/* ------------------------------------------------------------------ */

export function drawTrombone(ctx, { mouth, hand, blowing, scale, time, fx = true }) {
  const dx = hand.x - mouth.x;
  const dy = hand.y - mouth.y;
  const len = Math.hypot(dx, dy);
  if (len < 10) return;
  const angle = Math.atan2(dy, dx);
  const s = scale;

  ctx.save();
  ctx.translate(mouth.x, mouth.y);
  ctx.rotate(angle);

  // Soft drop shadow so the instrument feels stuck onto the video
  setShadow(ctx, fx, "rgba(0,0,0,0.55)", s * 0.5, s * 0.16);

  const bellY = -s * 0.36;      // bell tube rides above the slide
  const slideGapY = s * 0.34;   // distance between the two slide tubes

  // --- bell section: fixed start, rim always beyond the slide end ---
  const bellX0 = s * 0.45;
  const bellX1 = len * 1.14 + s * 0.3;
  brassStroke(ctx, s, 0.13);
  // gooseneck: connects the mouthpiece up to the bell tube, like the real thing
  ctx.beginPath();
  ctx.moveTo(s * 0.1, 0);
  ctx.quadraticCurveTo(bellX0 * 0.7, bellY * 0.35, bellX0, bellY);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(bellX0, bellY);
  ctx.lineTo(bellX1 - s * 0.34, bellY);
  ctx.stroke();

  // --- slide tubes: stretch from mouth to hand (this IS the slide) ---
  brassStroke(ctx, s, 0.115);
  ctx.beginPath();
  ctx.moveTo(s * 0.06, 0);              // leadpipe straight out of the mouthpiece
  ctx.lineTo(len * 0.97, 0);
  ctx.moveTo(s * 0.22, slideGapY);      // outer slide tube, ends at the hand
  ctx.lineTo(len, slideGapY);
  ctx.stroke();

  // --- braces joining the slide tubes ---
  brassStroke(ctx, s, 0.085);
  ctx.beginPath();
  ctx.moveTo(s * 0.3, 0);
  ctx.lineTo(s * 0.3, slideGapY);
  ctx.moveTo(len * 0.88, 0);           // the slide grip the hand holds
  ctx.lineTo(len * 0.88, slideGapY);
  ctx.stroke();

  // --- bell flare ---
  if (blowing && fx) {
    ctx.shadowColor = "rgba(255, 200, 90, 0.9)";
    ctx.shadowBlur = s * 1.1;
  }
  const flareLen = s * 0.36;
  const rimR = s * 0.52;
  const coneX = bellX1 - flareLen;
  ctx.fillStyle = brassGradient(ctx, 0, bellY - rimR, 0, bellY + rimR);
  ctx.beginPath();
  ctx.moveTo(coneX - s * 0.2, bellY - s * 0.085);
  ctx.lineTo(bellX1, bellY - rimR);
  ctx.lineTo(bellX1, bellY + rimR);
  ctx.lineTo(coneX - s * 0.2, bellY + s * 0.085);
  ctx.closePath();
  ctx.fill();
  // rim opening
  ctx.beginPath();
  ctx.ellipse(bellX1 + s * 0.05, bellY, s * 0.09, rimR * 0.96, 0, 0, Math.PI * 2);
  ctx.fillStyle = blowing ? "rgba(255, 240, 200, 0.95)" : "rgba(60, 38, 10, 0.9)";
  ctx.fill();

  // --- mouthpiece ---
  ctx.beginPath();
  ctx.arc(0, 0, s * 0.11, 0, Math.PI * 2);
  ctx.fillStyle = brassGradient(ctx, 0, -s * 0.12, 0, s * 0.12);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(0, 0, s * 0.05, 0, Math.PI * 2);
  ctx.fillStyle = blowing ? "rgba(255,255,255,0.85)" : "#3a2408";
  ctx.fill();

  ctx.restore();

  // --- animated sound waves pumping out of the bell while blowing ---
  if (blowing) {
    const rim = {
      x: mouth.x + Math.cos(angle) * bellX1 - Math.sin(angle) * bellY,
      y: mouth.y + Math.sin(angle) * bellX1 + Math.cos(angle) * bellY,
    };
    ctx.save();
    ctx.translate(rim.x, rim.y);
    ctx.rotate(angle);
    ctx.strokeStyle = "rgba(255, 228, 158, 0.95)";
    ctx.lineCap = "round";
    if (fx) {
      ctx.shadowColor = "rgba(255, 210, 120, 0.9)";
      ctx.shadowBlur = s * 0.25;
    }
    for (let i = 0; i < 3; i++) {
      const phase = (time * 1.6 + i / 3) % 1;             // 0..1, repeating
      const r = s * (0.5 + phase * 1.2);
      ctx.globalAlpha = 0.9 * Math.sin(phase * Math.PI);  // fade in and out
      ctx.lineWidth = s * 0.085 * (1 - phase * 0.4);
      ctx.beginPath();
      ctx.arc(0, 0, r, -0.55, 0.55);
      ctx.stroke();
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }
}

/* ------------------------------------------------------------------ */
/* Accordion — stretches between both hands, bellows in the middle     */
/* ------------------------------------------------------------------ */

export function drawAccordion(ctx, { left, right, volume, scale, time, fx = true }) {
  const mx = (left.x + right.x) / 2;
  const my = (left.y + right.y) / 2;
  const rawLen = Math.hypot(right.x - left.x, right.y - left.y);
  const angle = Math.atan2(right.y - left.y, right.x - left.x);
  const s = scale;
  const len = Math.max(rawLen, s * 1.7); // keep the case plates from overlapping

  ctx.save();
  ctx.translate(mx, my);
  ctx.rotate(angle);

  setShadow(ctx, fx, "rgba(0,0,0,0.5)", s * 0.45, s * 0.14);

  const half = len / 2;
  const plateW = s * 0.62;
  const plateH = s * 1.85;
  const bellH = s * 1.3;
  const innerL = -half + plateW / 2;
  const innerR = half - plateW / 2;

  // --- bellows: a single zigzag fold chain between the two plates ---
  const bellowsLen = Math.max(innerR - innerL, s * 0.2);
  const folds = Math.max(8, Math.min(26, Math.round(bellowsLen / (s * 0.3))));
  const w = bellowsLen / folds;
  const glow = Math.min(1, volume * 1.6);

  ctx.save();
  // dark fold body — ends tuck slightly under the plates so it looks hinged
  const zigzag = (pad) => {
    ctx.beginPath();
    for (let i = 0; i <= folds; i++) {
      const x = innerL - pad + (i / folds) * (bellowsLen + pad * 2);
      const y = i % 2 === 0 ? -bellH / 2 : bellH / 2;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
  };
  ctx.strokeStyle = "#2a1219";
  ctx.lineWidth = s * 0.11;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  zigzag(s * 0.12);
  ctx.stroke();
  // warm highlight along the fold edges (the "cloth" catching light)
  ctx.strokeStyle = "rgba(122, 62, 80, 0.9)";
  ctx.lineWidth = s * 0.035;
  ctx.stroke();
  // leather edge strips
  ctx.strokeStyle = "#3d1b26";
  ctx.lineWidth = s * 0.14;
  ctx.lineCap = "butt";
  ctx.beginPath();
  ctx.moveTo(innerL, -bellH / 2);
  ctx.lineTo(innerR, -bellH / 2);
  ctx.moveTo(innerL, bellH / 2);
  ctx.lineTo(innerR, bellH / 2);
  ctx.stroke();
  // bellows "breathing" glow while singing
  if (glow > 0.03) {
    ctx.strokeStyle = `rgba(255, 170, 215, ${0.35 * glow})`;
    ctx.lineWidth = s * 0.16;
    zigzag(0);
    ctx.stroke();
  }
  ctx.restore();

  // --- case plates ---
  const drawPlate = (cx, isTreble, innerSign) => {
    // innerSign: which side of the plate faces the bellows (-1 = left edge, +1 = right)
    const g = ctx.createLinearGradient(cx, -plateH / 2, cx, plateH / 2);
    g.addColorStop(0, "#a3123c");
    g.addColorStop(0.5, "#7c0d2e");
    g.addColorStop(1, "#56081f");
    ctx.fillStyle = g;
    roundRectPath(ctx, cx - plateW / 2, -plateH / 2, plateW, plateH, s * 0.12);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,205,120,0.55)";
    ctx.lineWidth = s * 0.045;
    ctx.stroke();

    // details live on the inner edge, facing the bellows
    const innerX = innerSign < 0 ? cx - plateW / 2 : cx + plateW / 2;
    const dir = -innerSign; // stripes run inward from the inner edge

    ctx.save();
    roundRectPath(ctx, cx - plateW / 2, -plateH / 2, plateW, plateH, s * 0.12);
    ctx.clip();

    if (isTreble) {
      const stripX = Math.min(innerX, innerX + dir * s * 0.26);
      ctx.fillStyle = "#f5f2ea";
      ctx.fillRect(stripX, -plateH / 2 + s * 0.06, s * 0.26, plateH - s * 0.12);
      // key dividers make the white strip read as separate keys
      ctx.fillStyle = "#c9c4b8";
      for (let i = 0; i < 8; i++) {
        ctx.fillRect(stripX + (i / 8) * s * 0.26, -plateH / 2 + s * 0.06, s * 0.012, plateH - s * 0.12);
      }
      ctx.fillStyle = "#17131c";
      for (let i = 0; i < 7; i++) {
        if (i === 2 || i === 6) continue; // like real missing black keys
        const y = -plateH / 2 + s * 0.16 + i * s * 0.22;
        ctx.fillRect(Math.min(innerX + dir * s * 0.05, innerX + dir * s * 0.18), y, s * 0.13, s * 0.13);
      }
    } else {
      // bass buttons: grid of dots
      ctx.fillStyle = "#d9c9a8";
      for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 2; c++) {
          ctx.beginPath();
          ctx.arc(
            innerX + dir * (s * 0.1 + c * s * 0.22),
            -plateH / 2 + s * 0.32 + r * s * 0.4,
            s * 0.07, 0, Math.PI * 2
          );
          ctx.fill();
        }
      }
    }
    ctx.restore();
  };
  drawPlate(-half, false, +1); // bass end: buttons face right (toward bellows)
  drawPlate(half, true, -1);   // treble end: keyboard faces left (toward bellows)

  ctx.restore();

  // pulsing ring around the whole instrument while the bellows sing
  if (glow > 0.05) {
    const pulse = 1 + 0.05 * Math.sin(time * 14) * glow;
    ctx.save();
    ctx.translate(mx, my);
    ctx.rotate(angle);
    ctx.strokeStyle = `rgba(255,170,215,${0.45 * glow})`;
    ctx.lineWidth = s * 0.06;
    roundRectPath(ctx, -half * pulse - s * 0.25, -(plateH / 2) * pulse - s * 0.1,
      len * pulse + s * 0.5, plateH * pulse + s * 0.2, s * 0.3);
    ctx.stroke();
    ctx.restore();
  }
}

/* ------------------------------------------------------------------ */

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Faint tracking dots (debug view, toggle with "D"). */
export function drawHandSkeleton(ctx, points, w, h, color = "rgba(125,211,252,0.8)") {
  const HAND_EDGES = [
    [0,1],[1,2],[2,3],[3,4],
    [0,5],[5,6],[6,7],[7,8],
    [5,9],[9,10],[10,11],[11,12],
    [9,13],[13,14],[14,15],[15,16],
    [13,17],[17,18],[18,19],[19,20],[0,17],
  ];
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1.5, w * 0.002);
  ctx.beginPath();
  for (const [a, b] of HAND_EDGES) {
    ctx.moveTo(points[a].x * w, points[a].y * h);
    ctx.lineTo(points[b].x * w, points[b].y * h);
  }
  ctx.stroke();
  ctx.fillStyle = color;
  for (const p of points) {
    ctx.beginPath();
    ctx.arc(p.x * w, p.y * h, Math.max(2, w * 0.0035), 0, Math.PI * 2);
    ctx.fill();
  }
}

/* ------------------------------------------------------------------ */
/* Maraca — one per hand, squashes and throws beads when shaken        */
/* ------------------------------------------------------------------ */

export function drawMaraca(ctx, { palm, angle, intensity, hitAge, scale, fx = true }) {
  const s = scale;
  const I = Math.min(1, intensity); // 0 calm .. 1 full-tilt shake
  const squashX = 1 + 0.16 * I;
  const squashY = 1 - 0.16 * I;

  ctx.save();
  ctx.translate(palm.x, palm.y);
  ctx.rotate(angle);

  setShadow(ctx, fx, "rgba(0,0,0,0.5)", s * 0.4, s * 0.14);

  // --- wooden handle (the hand grips here) ---
  const hg = ctx.createLinearGradient(-s * 0.09, 0, s * 0.09, 0);
  hg.addColorStop(0, "#8a5a2b");
  hg.addColorStop(0.5, "#d9a96b");
  hg.addColorStop(1, "#8a5a2b");
  ctx.fillStyle = hg;
  roundRectPath(ctx, -s * 0.085, -s * 0.18, s * 0.17, s * 0.95, s * 0.08);
  ctx.fill();
  // grip rings
  ctx.strokeStyle = "rgba(90,55,20,0.5)";
  ctx.lineWidth = s * 0.02;
  ctx.beginPath();
  for (let i = 0; i < 3; i++) {
    const y = s * (0.2 + i * 0.2);
    ctx.moveTo(-s * 0.085, y);
    ctx.lineTo(s * 0.085, y);
  }
  ctx.stroke();

  // --- gourd ---
  const gy = -s * 0.66;
  ctx.save();
  ctx.translate(0, gy);
  ctx.scale(squashX, squashY);
  const gg = ctx.createLinearGradient(0, -s * 0.5, 0, s * 0.5);
  gg.addColorStop(0, "#f7e3b8");
  gg.addColorStop(0.55, "#e8c281");
  gg.addColorStop(1, "#c98f4a");
  ctx.fillStyle = gg;
  ctx.beginPath();
  ctx.ellipse(0, 0, s * 0.44, s * 0.5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(120,80,30,0.45)";
  ctx.lineWidth = s * 0.025;
  ctx.stroke();

  // painted bands (matching the accordion's case red)
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(0, 0, s * 0.44, s * 0.5, 0, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = "#a3123c";
  ctx.fillRect(-s * 0.5, -s * 0.5, s * 1.0, s * 0.12);
  ctx.fillRect(-s * 0.5, s * 0.1, s * 1.0, s * 0.08);
  // gourd ridges
  ctx.strokeStyle = "rgba(160,110,50,0.5)";
  ctx.lineWidth = s * 0.02;
  ctx.beginPath();
  ctx.moveTo(-s * 0.22, -s * 0.46);
  ctx.quadraticCurveTo(-s * 0.3, 0, -s * 0.22, s * 0.46);
  ctx.moveTo(s * 0.22, -s * 0.46);
  ctx.quadraticCurveTo(s * 0.3, 0, s * 0.22, s * 0.46);
  ctx.stroke();
  ctx.restore();
  ctx.restore();

  // shake sheen while rattling
  if (I > 0.05 && fx) {
    ctx.shadowColor = "rgba(255, 226, 160, 0.9)";
    ctx.shadowBlur = s * I * 0.9;
    ctx.strokeStyle = `rgba(255,226,160,${0.4 * I})`;
    ctx.lineWidth = s * 0.04;
    ctx.beginPath();
    ctx.ellipse(0, gy, s * 0.46 * squashX, s * 0.52 * squashY, 0, 0, Math.PI * 2);
    ctx.stroke();
    setShadow(ctx, false);
  }

  // --- beads flying out of a fresh hit ---
  const phase = Math.min(1, hitAge / 0.35); // 0 just hit .. 1 settled
  if (phase < 1) {
    const fade = 1 - phase;
    ctx.fillStyle = `rgba(250, 230, 180, ${0.9 * fade})`;
    for (let i = 0; i < 6; i++) {
      const a = -Math.PI / 2 + (i - 2.5) * 0.5;
      const r = s * (0.45 + phase * 0.55);
      ctx.beginPath();
      ctx.arc(Math.cos(a) * r, gy + Math.sin(a) * r, s * 0.05 * fade + s * 0.015, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.restore();
}

/* ------------------------------------------------------------------ */
/* Drums — five pads along the bottom, flashing when struck            */
/* ------------------------------------------------------------------ */

export function drawDrums(ctx, { lanes, now, fx = true }) {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  const laneW = w / lanes.length;
  const padY = h - h * 0.17;

  for (let i = 0; i < lanes.length; i++) {
    const lane = lanes[i];
    const cx = (i + 0.5) * laneW;
    const age = (now - lane.lastHit) / 1000;
    const flash = age < 0.28 ? 1 - age / 0.28 : 0;
    const isKick = lane.type === "kick";
    const r = isKick ? h * 0.105 : h * (lane.type === "floor" ? 0.085 : 0.07);

    ctx.save();
    setShadow(ctx, fx, "rgba(0,0,0,0.5)", h * 0.02, h * 0.008);

    // shell
    const g = ctx.createLinearGradient(0, padY - r, 0, padY + r);
    g.addColorStop(0, lane.color);
    g.addColorStop(1, "rgba(10, 14, 24, 0.85)");
    ctx.fillStyle = g;
    ctx.globalAlpha = 0.88;
    ctx.beginPath();
    ctx.ellipse(cx, padY, r, r * (isKick ? 0.9 : 0.55), 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    // head
    ctx.fillStyle = flash > 0
      ? `rgba(255, 255, 240, ${0.35 + 0.65 * flash})`
      : "rgba(235, 230, 215, 0.85)";
    ctx.beginPath();
    ctx.ellipse(cx, padY - r * 0.08, r * 0.82, r * (isKick ? 0.6 : 0.38), 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(20, 24, 34, 0.8)";
    ctx.lineWidth = h * 0.004;
    ctx.stroke();

    // rim lugs
    ctx.strokeStyle = "rgba(255, 205, 120, 0.6)";
    ctx.lineWidth = h * 0.003;
    for (const k of [-0.6, 0, 0.6]) {
      const lx = cx + Math.cos(k) * r * 0.92;
      const ly = padY + Math.sin(k) * r * 0.5 - r * 0.08;
      ctx.beginPath();
      ctx.arc(lx, ly, h * 0.004, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (isKick) { // resonant port
      ctx.fillStyle = "rgba(15, 18, 28, 0.8)";
      ctx.beginPath();
      ctx.arc(cx, padY - r * 0.05, r * 0.2, 0, Math.PI * 2);
      ctx.fill();
    }

    // hit ring
    if (flash > 0) {
      ctx.strokeStyle = `rgba(255, 235, 180, ${0.8 * flash})`;
      ctx.lineWidth = h * 0.006 * flash + h * 0.002;
      ctx.beginPath();
      ctx.ellipse(cx, padY - r * 0.08, r * (0.9 + (1 - flash) * 0.5),
        r * (isKick ? 0.66 : 0.42) * (1 + (1 - flash) * 0.4), 0, 0, Math.PI * 2);
      ctx.stroke();
    }

    // label
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.font = `${Math.max(11, h * 0.022)}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText(lane.label.toUpperCase(), cx, padY + r + h * 0.022);
    ctx.restore();
  }
}

/* ------------------------------------------------------------------ */
/* Harp — strings hanging below the face, rippling when plucked        */
/* ------------------------------------------------------------------ */

export function drawHarp(ctx, { cx, topY, width, height, strings, now, fx = true }) {
  const w = ctx.canvas.width;
  const bottomY = topY + height;
  const x0 = cx - width / 2;
  const x1 = cx + width / 2;

  // frame: top bar + side posts (brass, matching the trombone)
  ctx.save();
  setShadow(ctx, fx, "rgba(0,0,0,0.5)", w * 0.008);
  ctx.strokeStyle = brassGradient(ctx, x0, topY, x0, topY + 10);
  ctx.lineWidth = Math.max(3, w * 0.006);
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(x0 - w * 0.004, topY);
  ctx.lineTo(x1 + w * 0.004, topY);
  ctx.moveTo(x0, topY);
  ctx.lineTo(x0, bottomY);
  ctx.moveTo(x1, topY);
  ctx.lineTo(x1, bottomY);
  ctx.stroke();

  // strings
  for (let i = 0; i < strings.length; i++) {
    const s = strings[i];
    const sx = x0 + ((i + 0.5) / strings.length) * width;
    const age = (now - s.pluckT) / 1000;
    const amp = s.amp * Math.exp(-Math.max(age, 0) * 3.2);

    const bright = Math.min(1, amp * 1.4);
    ctx.strokeStyle = `rgba(${190 + 60 * bright}, ${170 + 70 * bright}, 255, ${0.5 + 0.5 * bright})`;
    ctx.lineWidth = Math.max(1.2, w * 0.0016) * (1 + bright);
    if (bright > 0.05 && fx) {
      ctx.shadowColor = "rgba(200, 170, 255, 0.9)";
      ctx.shadowBlur = w * 0.006 * bright;
    }
    ctx.beginPath();
    const segs = 10;
    for (let k = 0; k <= segs; k++) {
      const y = topY + (k / segs) * height;
      const wob = amp * width * 0.02 * Math.sin((k / segs) * Math.PI) * Math.sin(age * 60 + s.phase);
      const x = sx + wob;
      if (k === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
  }
  ctx.restore();
}

/* ------------------------------------------------------------------ */
/* Bass — neck across the chest, frets under the left hand             */
/* ------------------------------------------------------------------ */

export function drawBass(ctx, { x0, x1, y, fretSlot, slots, string, now, fx = true }) {
  const s = Math.max(18, (x1 - x0) / 8);
  const neckH = s * 0.44;
  const age = (now - string.pluckT) / 1000;
  const amp = string.amp * Math.exp(-Math.max(age, 0) * 3);

  ctx.save();
  setShadow(ctx, fx, "rgba(0,0,0,0.5)", s * 0.35, s * 0.12);

  // --- body (right end): two offset lobes like a double-cutaway bass ---
  const bodyX = x1 + s * 0.55;
  const bg = ctx.createRadialGradient(bodyX, y - s * 0.2, s * 0.1, bodyX, y, s * 1.5);
  bg.addColorStop(0, "#e08030");
  bg.addColorStop(0.6, "#8a4218");
  bg.addColorStop(1, "#4a2008");
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.ellipse(bodyX, y + s * 0.35, s * 1.05, s * 1.15, 0, 0, Math.PI * 2);
  ctx.ellipse(bodyX - s * 0.25, y - s * 0.55, s * 0.7, s * 0.62, 0, 0, Math.PI * 2);
  ctx.fill();
  // pickguard (kept below the neck joint so it doesn't swallow the strings)
  ctx.fillStyle = "#1c1410";
  ctx.beginPath();
  ctx.ellipse(bodyX - s * 0.1, y + s * 0.35, s * 0.6, s * 0.62, 0.3, 0, Math.PI * 2);
  ctx.fill();
  // pickups
  ctx.fillStyle = "#0d0d10";
  for (const py of [y - s * 0.12, y + s * 0.22]) {
    roundRectPath(ctx, bodyX - s * 0.42, py, s * 0.62, s * 0.14, s * 0.05);
    ctx.fill();
  }

  // --- neck (left of the body) ---
  const ng = ctx.createLinearGradient(0, y - neckH / 2, 0, y + neckH / 2);
  ng.addColorStop(0, "#a06a35");
  ng.addColorStop(0.5, "#d9a96b");
  ng.addColorStop(1, "#8a5a2b");
  ctx.fillStyle = ng;
  roundRectPath(ctx, x0 - s * 0.3, y - neckH / 2, (x1 - x0) + s * 1.1, neckH, s * 0.06);
  ctx.fill();

  // headstock + tuning pegs
  ctx.fillStyle = "#4a2c12";
  roundRectPath(ctx, x0 - s * 0.62, y - neckH * 0.62, s * 0.36, neckH * 1.24, s * 0.05);
  ctx.fill();
  ctx.fillStyle = "#d8d8dc";
  for (const py of [-0.28, -0.1, 0.1, 0.28]) {
    ctx.beginPath();
    ctx.arc(x0 - s * 0.44, y + neckH * py, s * 0.045, 0, Math.PI * 2);
    ctx.fill();
  }

  // nut + frets
  ctx.fillStyle = "#efe8d8";
  ctx.fillRect(x0 - s * 0.02, y - neckH / 2, s * 0.045, neckH);
  ctx.strokeStyle = "rgba(210,210,215,0.75)";
  ctx.lineWidth = s * 0.022;
  const slotW = (x1 - x0) / slots;
  ctx.beginPath();
  for (let i = 1; i < slots; i++) {
    const fx2 = x0 + i * slotW;
    ctx.moveTo(fx2, y - neckH / 2);
    ctx.lineTo(fx2, y + neckH / 2);
  }
  ctx.stroke();
  // inlay dots
  ctx.fillStyle = "rgba(240,235,220,0.65)";
  for (let i = 1; i < slots; i += 2) {
    ctx.beginPath();
    ctx.arc(x0 + (i - 0.5) * slotW, y, s * 0.035, 0, Math.PI * 2);
    ctx.fill();
  }
  setShadow(ctx, false);

  // --- strings (over neck and body), wobbling after a pluck ---
  const bridgeX = x1 + s * 0.42;
  ctx.strokeStyle = "rgba(245, 242, 230, 0.95)";
  for (let si = -1; si <= 1; si++) {
    const oy = si * s * 0.055;
    ctx.lineWidth = si === 0 ? s * 0.02 : s * 0.014;
    ctx.beginPath();
    const segs = 14;
    for (let k = 0; k <= segs; k++) {
      const px = x0 + ((bridgeX - x0) * k) / segs;
      const env = Math.sin((k / segs) * Math.PI);
      const wob = amp * s * 0.12 * env * Math.sin(age * 55 + string.phase + si * 1.3);
      const py = y + oy + (si === 0 ? wob : 0);
      if (k === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }

  // --- fretting finger: glowing band on the fretted slot ---
  const fretX = x0 + (fretSlot + 0.5) * slotW;
  ctx.strokeStyle = "rgba(34, 211, 238, 0.95)";
  ctx.lineWidth = s * 0.05;
  if (fx) {
    ctx.shadowColor = "rgba(34, 211, 238, 0.9)";
    ctx.shadowBlur = s * 0.25;
  }
  roundRectPath(ctx, fretX - s * 0.09, y - neckH * 0.52, s * 0.18, neckH * 1.04, s * 0.06);
  ctx.stroke();
  ctx.shadowBlur = 0;

  // pluck spark: expanding ring where the string was snapped
  if (age >= 0 && age < 0.3 && string.pluckX !== undefined) {
    const f2 = 1 - age / 0.3;
    ctx.strokeStyle = `rgba(255, 235, 200, ${0.75 * f2})`;
    ctx.lineWidth = s * 0.04 * f2 + s * 0.008;
    ctx.beginPath();
    ctx.ellipse(string.pluckX, y, s * (0.2 + (1 - f2) * 0.55), s * (0.12 + (1 - f2) * 0.3), 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.restore();
}
