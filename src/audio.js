/**
 * audio.js — Web Audio synthesis for the two instruments.
 *
 * Trombone: a pair of detuned sawtooths through a pitch-tracking lowpass
 * (brass-ish), gated by the player "blowing" (mouth open). Pitch comes from
 * the slide position and glides continuously, like a real slide.
 *
 * Accordion: a bank of detuned "reeds" (sub, two musette reeds, an octave up)
 * through a fixed lowpass. Volume is driven by bellows *speed* — squeeze or
 * stretch your hands and you hear it, hold still and it goes quiet, exactly
 * like pumping a real bellows.
 */

const TROMBONE_BASE_FREQ = 116.5409; // Bb2 — first slide position
const TROMBONE_SEMI_RANGE = 6;       // 7 slide positions = 6 semitones down to Eb2

// C-major pentatonic from C3 to C5 — quantized accordion range
const ACCORDION_SCALE = (() => {
  const semis = [0, 2, 4, 7, 9]; // C D E G A
  const notes = [];
  for (let oct = 0; oct <= 2; oct++) {
    for (const s of semis) {
      const midi = 48 + oct * 12 + s; // 48 = C3
      if (midi <= 72) notes.push(440 * 2 ** ((midi - 69) / 12));
    }
  }
  return notes;
})();

const semitonesToFreq = (base, semis) => base * 2 ** (-semis / 12);

/** One shared second of white noise, sliced at random offsets per burst. */
function makeNoiseBuffer(ctx) {
  const len = Math.floor(ctx.sampleRate);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.trombone = null;
    this.accordion = null;
    this.muted = false;
  }

  /** Must be called from a user gesture (click/keydown) so playback is allowed. */
  ensure() {
    if (this.ctx) {
      if (this.ctx.state === "suspended") this.ctx.resume();
      return;
    }
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.ctx = ctx;

    const master = ctx.createGain();
    master.gain.value = 0.85;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -14;
    limiter.knee.value = 12;
    limiter.ratio.value = 8;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.18;
    master.connect(limiter).connect(ctx.destination);
    this.master = master;

    this.trombone = new TromboneVoice(ctx, master);
    this.accordion = new AccordionVoice(ctx, master);
    this.maraca = new MaracaVoice(ctx, master);
    this.drums = new DrumKitVoice(ctx, master);
    this.harp = new HarpVoice(ctx, master);
    this.bass = new BassVoice(ctx, master);
  }

  setMuted(muted) {
    this.muted = muted;
    if (this.ctx) {
      this.master.gain.setTargetAtTime(muted ? 0 : 0.85, this.ctx.currentTime, 0.03);
    }
  }

  /** Slide position 0..1 -> frequency, with continuous glide built in. */
  static tromboneFreq(slide01) {
    return semitonesToFreq(TROMBONE_BASE_FREQ, slide01 * TROMBONE_SEMI_RANGE);
  }

  /** Hand spread 0..1 -> index into the pentatonic scale. */
  static accordionFreq(spread01) {
    const i = Math.min(
      ACCORDION_SCALE.length - 1,
      Math.max(0, Math.round(spread01 * (ACCORDION_SCALE.length - 1)))
    );
    return ACCORDION_SCALE[i];
  }

  /** Harp string index -> frequency: C-major pentatonic, C4 up two octaves. */
  static harpFreq(index) {
    const semis = [0, 2, 4, 7, 9];
    const octave = Math.floor(index / 5);
    const midi = 60 + octave * 12 + semis[index % 5]; // 60 = C4
    return 440 * 2 ** ((midi - 69) / 12);
  }

  /** Bass fret index -> frequency: C-major pentatonic, C2 up to C3. */
  static bassFreq(index) {
    const semis = [0, 2, 4, 7, 9, 12];
    const midi = 36 + semis[Math.min(semis.length - 1, Math.max(0, index))]; // 36 = C2
    return 440 * 2 ** ((midi - 69) / 12);
  }
}

class TromboneVoice {
  constructor(ctx, dest) {
    this.ctx = ctx;

    const out = ctx.createGain();
    out.gain.value = 0; // silent until blowing

    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = 1.1;

    const oscGain = ctx.createGain();
    oscGain.gain.value = 0.5;

    // Two slightly detuned saws + gentle vibrato give the buzz some life
    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    osc1.type = osc2.type = "sawtooth";
    osc1.frequency.value = osc2.frequency.value = TROMBONE_BASE_FREQ;
    osc2.detune.value = 7;

    const lfo = ctx.createOscillator();
    lfo.frequency.value = 5.3;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 2.6; // cents
    lfo.connect(lfoDepth);
    lfoDepth.connect(osc1.detune);
    lfoDepth.connect(osc2.detune);

    osc1.connect(oscGain);
    osc2.connect(oscGain);
    oscGain.connect(filter).connect(out).connect(dest);

    osc1.start();
    osc2.start();
    lfo.start();

    this.osc1 = osc1;
    this.osc2 = osc2;
    this.filter = filter;
    this.out = out;
    this.blowing = false;
    this.freq = TROMBONE_BASE_FREQ;
  }

  /** Called every frame with the current intent; envelopes are smoothed in audio time. */
  update({ active, freq, level = 1 }) {
    const t = this.ctx.currentTime;
    if (!active) {
      this.blowing = false;
      if (!this._gated) {
        this._gated = true;
        this.out.gain.setTargetAtTime(0, t, 0.07); // breath release
      }
      return;
    }
    this._gated = false;
    this.blowing = true;
    this.freq = freq;
    if (Math.abs(freq - (this._lastFreq ?? -1)) > 0.1) {
      this._lastFreq = freq;
      this.osc1.frequency.setTargetAtTime(freq, t, 0.03);
      this.osc2.frequency.setTargetAtTime(freq, t, 0.03);
      // Brighten as pitch rises; keeps the tone consistent across the slide
      this.filter.frequency.setTargetAtTime(Math.min(5200, freq * 4.5 + 250), t, 0.04);
    }
    const target = 0.9 * level;
    if (Math.abs(target - (this._lastGain ?? -1)) > 0.005) {
      this._lastGain = target;
      this.out.gain.setTargetAtTime(target, t, 0.035); // quick-ish attack, no click
    }
  }

  silence() {
    this.out.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
    this.blowing = false;
  }
}

class AccordionVoice {
  constructor(ctx, dest) {
    this.ctx = ctx;

    const out = ctx.createGain();
    out.gain.value = 0; // silent until the bellows move

    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 2400;
    filter.Q.value = 0.6;

    // Reed bank: 16' sub, two musette reeds ±8 cents, 4' octave — classic sound
    const reeds = [
      { ratio: 0.5, detune: 0, gain: 0.32 },
      { ratio: 1.0, detune: -8, gain: 0.42 },
      { ratio: 1.0, detune: 8, gain: 0.36 },
      { ratio: 2.0, detune: 3, gain: 0.13 },
    ];
    this.oscs = reeds.map((r) => {
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = 220 * r.ratio;
      osc.detune.value = r.detune;
      const g = ctx.createGain();
      g.gain.value = r.gain;
      osc.connect(g).connect(filter);
      osc.start();
      return { osc, ratio: r.ratio };
    });

    filter.connect(out).connect(dest);
    this.out = out;
  }

  update({ active, freq, volume }) {
    const t = this.ctx.currentTime;
    if (!active) {
      if (!this._gated) {
        this._gated = true;
        this.out.gain.setTargetAtTime(0, t, 0.25); // bellows settling
      }
      return;
    }
    this._gated = false;
    if (Math.abs(freq - (this._lastFreq ?? -1)) > 0.1) {
      this._lastFreq = freq;
      for (const { osc, ratio } of this.oscs) {
        osc.frequency.setTargetAtTime(freq * ratio, t, 0.045); // audible reed glide
      }
    }
    if (Math.abs(volume - (this._lastVol ?? -1)) > 0.005) {
      this._lastVol = volume;
      this.out.gain.setTargetAtTime(0.85 * volume, t, volume > 0.02 ? 0.06 : 0.22);
    }
  }

  silence() {
    this.out.gain.setTargetAtTime(0, this.ctx.currentTime, 0.1);
  }
}

/**
 * Maracas are event-driven: each detected shake reversal fires hit(vol),
 * a short noise burst through a high bandpass — the beads hitting the
 * gourd. Harder shakes schedule a couple of extra micro-bursts, which
 * reads as a denser rattle.
 */
class MaracaVoice {
  constructor(ctx, dest) {
    this.ctx = ctx;
    this.bus = ctx.createGain();
    this.bus.gain.value = 0.9;
    this.bus.connect(dest);
    this.hitCount = 0; // observability for tests/debug

    // one shared second of white noise, sliced at random offsets per burst
    this.noise = makeNoiseBuffer(ctx);
  }

  hit(vol) {
    const t = this.ctx.currentTime;
    const bursts = vol > 0.6 ? 3 : vol > 0.25 ? 2 : 1;
    for (let i = 0; i < bursts; i++) {
      const start = t + i * 0.012;
      const amp = vol * (1 - i * 0.25);

      const src = this.ctx.createBufferSource();
      src.buffer = this.noise;
      src.playbackRate.value = 0.9 + Math.random() * 0.3;

      // sizzle band 4–6kHz + a touch of gourd warmth at ~1.6kHz
      const bp = this.ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 4200 + Math.random() * 1800;
      bp.Q.value = 1.4;
      const warm = this.ctx.createBiquadFilter();
      warm.type = "bandpass";
      warm.frequency.value = 1500 + Math.random() * 300;
      warm.Q.value = 2.5;
      const warmGain = this.ctx.createGain();
      warmGain.gain.value = 0.35;

      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0, start);
      g.gain.linearRampToValueAtTime(amp, start + 0.004);
      g.gain.exponentialRampToValueAtTime(0.001, start + 0.09 + 0.05 * vol);

      src.connect(bp).connect(g);
      src.connect(warm).connect(warmGain).connect(g);
      g.connect(this.bus);
      src.start(start, Math.random() * 0.8);
      src.stop(start + 0.25);
    }
    this.hitCount++;
  }

  /** One-shots decay on their own; nothing to silence. */
  silence() {}
}

/**
 * Drum kit: velocity one-shots. kick = sine drop + click, snare = noise
 * + tonal crack, hat = short high sizzle, toms = pitched sine drops.
 */
class DrumKitVoice {
  constructor(ctx, dest) {
    this.ctx = ctx;
    this.dest = dest;
    this.noise = makeNoiseBuffer(ctx);
    this.hitCount = 0;
    this.byType = { kick: 0, hat: 0, snare: 0, tom: 0, floor: 0 };
  }

  hit(type, vol = 1) {
    const t = this.ctx.currentTime;
    this.hitCount++;
    this.byType[type] = (this.byType[type] ?? 0) + 1;
    if (type === "kick") this.kick(t, vol);
    else if (type === "snare") this.snare(t, vol);
    else if (type === "hat") this.hat(t, vol);
    else this.tom(t, vol, type === "floor" ? 0.65 : 1);
  }

  kick(t, vol) {
    const osc = this.ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(155, t);
    osc.frequency.exponentialRampToValueAtTime(44, t + 0.11);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(1.25 * vol, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
    osc.connect(g).connect(this.dest);
    osc.start(t);
    osc.stop(t + 0.25);
    this.burst({ t, vol: vol * 0.35, decay: 0.02, filter: "lowpass", freq: 3200, Q: 0.7 }); // beater click
  }

  snare(t, vol) {
    this.burst({ t, vol: vol * 0.9, decay: 0.16, filter: "bandpass", freq: 2100, Q: 0.8 });
    this.burst({ t, vol: vol * 0.5, decay: 0.08, filter: "highpass", freq: 5200, Q: 0.7 });
    const osc = this.ctx.createOscillator(); // tonal crack under the noise
    osc.type = "triangle";
    osc.frequency.setValueAtTime(196, t);
    osc.frequency.exponentialRampToValueAtTime(148, t + 0.08);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.5 * vol, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.11);
    osc.connect(g).connect(this.dest);
    osc.start(t);
    osc.stop(t + 0.13);
  }

  hat(t, vol) {
    this.burst({ t, vol: vol * 0.65, decay: 0.045, filter: "highpass", freq: 7800, Q: 0.9 });
  }

  tom(t, vol, pitch = 1) {
    const osc = this.ctx.createOscillator();
    osc.type = "sine";
    const base = 210 * pitch;
    osc.frequency.setValueAtTime(base, t);
    osc.frequency.exponentialRampToValueAtTime(base * 0.5, t + 0.18);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.95 * vol, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
    osc.connect(g).connect(this.dest);
    osc.start(t);
    osc.stop(t + 0.3);
    this.burst({ t, vol: vol * 0.18, decay: 0.02, filter: "bandpass", freq: base * 4, Q: 1 }); // stick
  }

  burst({ t, vol, decay, filter, freq, Q }) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const f = this.ctx.createBiquadFilter();
    f.type = filter;
    f.frequency.value = freq;
    f.Q.value = Q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.001, t + decay);
    src.connect(f).connect(g).connect(this.dest);
    src.start(t, Math.random() * 0.8);
    src.stop(t + decay + 0.05);
  }

  silence() {}
}

/**
 * Harp: real Karplus-Strong plucked strings, rendered offline into cached
 * buffers (one per pitch) and played back as one-shots.
 */
class HarpVoice {
  constructor(ctx, dest) {
    this.ctx = ctx;
    this.dest = dest;
    this.cache = new Map(); // freq -> AudioBuffer
    this.pluckCount = 0;
  }

  ksBuffer(freq) {
    let buf = this.cache.get(freq);
    if (buf) return buf;
    const sr = this.ctx.sampleRate;
    const N = Math.max(2, Math.round(sr / freq)); // delay line = one period
    buf = this.ctx.createBuffer(1, Math.floor(sr * 2.2), sr);
    const out = buf.getChannelData(0);
    const line = new Float32Array(N);
    for (let i = 0; i < N; i++) line[i] = Math.random() * 2 - 1;
    // slight damping tweak so bass notes don't ring forever
    const decay = freq < 330 ? 0.9955 : 0.9965;
    let j = 0;
    for (let i = 0; i < out.length; i++) {
      const cur = line[j];
      out[i] = cur;
      line[j] = (cur + line[(j + 1) % N]) * 0.5 * decay;
      j = (j + 1) % N;
    }
    this.cache.set(freq, buf);
    return buf;
  }

  pluck(freq, vol = 1) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.ksBuffer(freq);
    src.playbackRate.value = 0.995 + Math.random() * 0.01; // natural variance
    const g = this.ctx.createGain();
    g.gain.value = 0.85 * vol;
    src.connect(g).connect(this.dest);
    src.start();
    this.pluckCount++;
  }

  silence() {}
}

/**
 * Bass: Karplus-Strong like the harp but pitched down (C2–C3), with an
 * octave-up KS blended in at low level so small speakers still show the
 * fundamental's neighbors.
 */
class BassVoice {
  constructor(ctx, dest) {
    this.ctx = ctx;
    this.dest = dest;
    this.cache = new Map(); // freq -> AudioBuffer
    this.pluckCount = 0;
  }

  ksBuffer(freq) {
    let buf = this.cache.get(freq);
    if (buf) return buf;
    const sr = this.ctx.sampleRate;
    buf = this.ctx.createBuffer(1, Math.floor(sr * 2.8), sr);
    const out = buf.getChannelData(0);
    // two interleaved delay-line plucks: fundamental + quiet octave up
    const gen = (f, decay) => {
      const N = Math.max(2, Math.round(sr / f));
      const line = new Float32Array(N);
      for (let i = 0; i < N; i++) line[i] = Math.random() * 2 - 1;
      let j = 0;
      return () => {
        const cur = line[j];
        line[j] = (cur + line[(j + 1) % N]) * 0.5 * decay;
        j = (j + 1) % N;
        return cur;
      };
    };
    const fundamental = gen(freq, 0.997);   // long sustain, it's a bass
    const octaveUp = gen(freq * 2, 0.996);
    for (let i = 0; i < out.length; i++) out[i] = fundamental() + 0.3 * octaveUp();
    this.cache.set(freq, buf);
    return buf;
  }

  pluck(freq, vol = 1) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.ksBuffer(freq);
    src.playbackRate.value = 0.995 + Math.random() * 0.01;
    const g = this.ctx.createGain();
    g.gain.value = 0.95 * vol;
    src.connect(g).connect(this.dest);
    src.start();
    this.pluckCount++;
  }

  silence() {}
}
