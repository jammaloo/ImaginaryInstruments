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
