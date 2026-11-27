/* =============================================================================
   Krell Patch Machine II — generative alien pulse synthesizer (Web Audio, no deps)

   SIGNAL PATH
   Per voice (×4, round-robin; 1 voice = classic mono + glide):
     sine A ┐
     tri  B ├─ mix (Σ weights = 1) ─ VCA(env) ─┐
     sub    ┘                                   ├─ low-pass (env/LFO/chaos → detune) ─ reso comp ─┐
     noise ─ noise env ─┬─ breath send ─────────┘                                                ├─ voice level ─ panner ─┐
                        └─ band-pass ─ band level (Q-compensated) ──────────────────────────────┘                        │
   Global:                                                                                                                │
     voice bus ─┬─ dry (1-x) ───────────────────────────┐                                                                 │
                └─ drive → shaper[sat|fold|rect] → wet ─┴─ DC block ─┬─ delay dry ─────────────────────────┐              │
                                                                     ├─ ping-pong delay (LP+HP+tanh in loop) ┼─ sum ─ master ─ limiter ─ ceiling clipper ─ out
                                                                     └─ space send ─ duck ─ pre-delay ─ convolver (crossfaded) ┘

   GAIN STAGING
   - Every shaper has an explicit input domain, so nothing is hard-clamped at ±1 inside the graph.
   - Warp drive is applied only to the wet branch (dry stays at unity).
   - Resonance and band-noise Q are level-compensated.
   - Delay feedback passes through LP/HP and a tanh limiter, so it can never run away.
   - Output: brick-wall-ish limiter, then a soft-knee safety clipper with an absolute ceiling of −0.2 dBFS.
   ============================================================================= */

(() => {
  'use strict';

  // ===========================================================================
  // Constants
  // ===========================================================================
  const MAX_VOICES = 4;
  const VOICE_LEVEL = 0.5;      // per-voice peak budget (scaled by 1/√voices)
  const WARP_RANGE = 16;        // warp shaper input domain ±16 (max drive)
  const WARP_OUT = 0.42;        // shaper output (±1) scaled to bus level
  const FB_RANGE = 4;           // delay feedback saturator domain ±4
  const SPACE_LEVEL = 0.85;     // reverb return trim
  const CEIL_RANGE = 4;         // safety clipper input domain ±4 (≈ +12 dBFS)
  const CEIL_KNEE = 0.8;        // fully linear below this
  const CEILING = 0.977;        // absolute output ceiling ≈ −0.2 dBFS
  const BUTTERWORTH = -3.0103;  // biquad Q (dB) for a flat 2nd-order response

  const LS_USER = 'krell2.userPresets';
  const LS_SESSION = 'krell2.session';

  // ===========================================================================
  // Helpers
  // ===========================================================================
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  const midiToHz = m => 440 * Math.pow(2, (m - 69) / 12);
  const dbToGain = db => Math.pow(10, db / 20);
  const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

  function noteName(m) {
    const r = Math.round(m);
    const name = NOTE_NAMES[((r % 12) + 12) % 12] + (Math.floor(r / 12) - 1);
    const cents = Math.round((m - r) * 100);
    return cents ? `${name}${cents > 0 ? '+' : ''}${cents}¢` : name;
  }

  function parseNote(s) {
    const m = /^([a-g])(#|♯|b|♭)?(-?\d)$/i.exec(s.trim());
    if (!m) return null;
    const pc = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[m[1].toLowerCase()];
    const acc = m[2] ? (/[#♯]/.test(m[2]) ? 1 : -1) : 0;
    return (parseInt(m[3], 10) + 1) * 12 + pc + acc;
  }

  // Deterministic, re-seedable RNG (mulberry32)
  function rng(seed) {
    let t = seed >>> 0;
    return () => {
      t += 0x6D2B79F5;
      let r = Math.imul(t ^ (t >>> 15), 1 | t);
      r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }
  function newSeed() {
    try { return crypto.getRandomValues(new Uint32Array(1))[0]; }
    catch (_) { return (Math.random() * 0xFFFFFFFF) >>> 0; }
  }
  const seedHex = s => (s >>> 0).toString(16).toUpperCase().padStart(8, '0');

  // ===========================================================================
  // Scales (degrees in semitones; floats allowed → microtonal)
  // ===========================================================================
  const OVERTONE = [8, 9, 10, 11, 12, 13, 14, 15].map(n => 12 * Math.log2(n / 8));
  const SCALES = {
    pent_minor: { label: 'Pentatonic minor', deg: [0, 3, 5, 7, 10] },
    pent_major: { label: 'Pentatonic major', deg: [0, 2, 4, 7, 9] },
    aeolian: { label: 'Aeolian', deg: [0, 2, 3, 5, 7, 8, 10] },
    dorian: { label: 'Dorian', deg: [0, 2, 3, 5, 7, 9, 10] },
    phrygian: { label: 'Phrygian', deg: [0, 1, 3, 5, 7, 8, 10] },
    lydian: { label: 'Lydian', deg: [0, 2, 4, 6, 7, 9, 11] },
    mixolydian: { label: 'Mixolydian', deg: [0, 2, 4, 5, 7, 9, 10] },
    harm_minor: { label: 'Harmonic minor', deg: [0, 2, 3, 5, 7, 8, 11] },
    hirajoshi: { label: 'Hirajōshi', deg: [0, 2, 3, 7, 8] },
    insen: { label: 'In Sen', deg: [0, 1, 5, 7, 10] },
    octatonic: { label: 'Octatonic', deg: [0, 2, 3, 5, 6, 8, 9, 11] },
    whole: { label: 'Whole tone', deg: [0, 2, 4, 6, 8, 10] },
    overtone: { label: 'Overtone (just)', deg: OVERTONE },
    chromatic: { label: 'Chromatic', deg: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
  };

  function quantize(midi, root, scaleKey) {
    const deg = (SCALES[scaleKey] || SCALES.pent_minor).deg;
    const rel = midi - root;
    const oct = Math.floor(rel / 12);
    const within = rel - oct * 12;
    let best = deg[0], bd = Infinity;
    for (const d of deg) {
      const dist = Math.abs(within - d);
      if (dist < bd) { bd = dist; best = d; }
    }
    if (Math.abs(within - (deg[0] + 12)) < bd) best = deg[0] + 12; // wrap to next octave root
    return root + oct * 12 + best;
  }

  // ===========================================================================
  // Shaper curves
  // ===========================================================================
  function makeCurve(n, range, fn) {
    const c = new Float32Array(n);
    for (let i = 0; i < n; i++) c[i] = fn(((i / (n - 1)) * 2 - 1) * range);
    return c;
  }
  function ceilingFn(x) {
    const a = Math.abs(x);
    if (a <= CEIL_KNEE) return x;
    const w = CEILING - CEIL_KNEE;
    return Math.sign(x) * (CEIL_KNEE + w * Math.tanh((a - CEIL_KNEE) / w));
  }
  const WARP_MODES = [
    { id: 'saturate', label: 'Saturate', fn: x => Math.tanh(x) },
    { id: 'fold', label: 'Fold', fn: x => Math.sin(x) },
    { id: 'rectify', label: 'Rectify', fn: x => (x >= 0 ? Math.tanh(x) : -0.3 * Math.tanh(x)) },
  ];

  // Stereo, decorrelated, brightness-decaying noise impulse (−60 dB at `size`)
  function makeImpulse(ac, size, bright) {
    const sr = ac.sampleRate;
    const len = Math.max(256, Math.floor(sr * (size + 0.12)));
    const buf = ac.createBuffer(2, len, sr);
    const r = rng(0xC0FFEE);
    const fcStart = 1800 + 14000 * bright;
    const fcEnd = 220 + 3200 * bright;
    const decay = 6.9078 / size;
    const fadeOut = Math.floor(sr * 0.06);
    let energy = 0;
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let lp1 = 0, lp2 = 0, a = 0;
      for (let i = 0; i < len; i++) {
        if ((i & 63) === 0) {
          const x = Math.min(1, i / (sr * size));
          a = 1 - Math.exp((-2 * Math.PI * fcStart * Math.pow(fcEnd / fcStart, x)) / sr);
        }
        lp1 += a * (r() * 2 - 1 - lp1);
        lp2 += a * (lp1 - lp2);
        const t = i / sr;
        let env = Math.exp(-decay * t) * Math.min(1, t / 0.004);
        if (i > len - fadeOut) env *= (len - i) / fadeOut;
        const s = lp2 * env;
        d[i] = s;
        energy += s * s;
      }
    }
    const scale = Math.sqrt(1 / (energy / 2 || 1)); // Σh² = 1 per channel → unity power gain
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] *= scale;
    }
    return buf;
  }

  // ===========================================================================
  // Parameter schema
  // ===========================================================================
  const FMT = {
    hz: v => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 1 : 2)} kHz` : `${v >= 100 ? v.toFixed(0) : v.toFixed(v >= 10 ? 1 : 2)} Hz`),
    ms: v => (v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${v.toFixed(0)} ms`),
    s: v => (v < 1 ? `${(v * 1000).toFixed(0)} ms` : `${v.toFixed(2)} s`),
    pct: v => `${Math.round(v * 100)}%`,
    cents: v => `${Math.round(v)}¢`,
    db: v => (v <= -47.9 ? '−∞ dB' : `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`),
    note: v => noteName(v),
    steps: v => `${v} steps`,
    voices: v => (v === 1 ? 'Mono' : `${v} voices`),
    x: v => v.toFixed(v < 10 ? 1 : 0),
  };

  const NOTE_OPTIONS = NOTE_NAMES.map((n, i) => ({ v: i, label: n }));
  const SCALE_OPTIONS = Object.entries(SCALES).map(([k, s]) => ({ v: k, label: s.label }));
  const LFO_OPTIONS = [
    { v: 'sine', label: 'Sine' }, { v: 'triangle', label: 'Tri' },
    { v: 'square', label: 'Sqr' }, { v: 'sawtooth', label: 'Saw' },
  ];
  const WARP_OPTIONS = WARP_MODES.map(m => ({ v: m.id, label: m.label }));

  const MODULES = [
    { id: 'pulse', title: 'Pulse', tag: 'sequencer', hue: 166 },
    { id: 'pitch', title: 'Pitch', tag: 'quantizer', hue: 188 },
    { id: 'env', title: 'Envelope', tag: 'attack · hold · release', hue: 140 },
    { id: 'osc', title: 'Oscillators', tag: 'sine ⇄ triangle', hue: 212 },
    { id: 'filter', title: 'Filter', tag: 'low-pass', hue: 262 },
    { id: 'noise', title: 'Noise', tag: 'breath · band', hue: 318 },
    { id: 'warp', title: 'Warp', tag: 'shaper', hue: 18 },
    { id: 'lfo', title: 'LFO', tag: 'vibrato', hue: 288 },
    { id: 'chaos', title: 'Chaos', tag: 'random drift', hue: 342 },
    { id: 'delay', title: 'Delay', tag: 'ping-pong', hue: 198 },
    { id: 'space', title: 'Space', tag: 'convolution', hue: 234 },
  ];

  // `apply` names the engine area that a parameter drives. Params without `apply`
  // are read by the sequencer at the moment each pulse is scheduled.
  // `rnd` is the normalized range used by Random/Mutate (omit = never randomized).
  const PARAMS = [
    // Pulse
    { id: 'eventHz', mod: 'pulse', label: 'Rate', min: 0.05, max: 8, def: 0.6, curve: 'log', fmt: 'hz', rnd: [0.25, 0.75] },
    { id: 'density', mod: 'pulse', label: 'Density', min: 0, max: 1, def: 1, fmt: 'pct', rnd: [0.55, 1] },
    { id: 'randomness', mod: 'pulse', label: 'Random', min: 0, max: 1, def: 0.6, fmt: 'pct', rnd: [0, 1] },
    { id: 'memory', mod: 'pulse', label: 'Memory', min: 0, max: 1, def: 0, fmt: 'pct', rnd: [0, 1] },
    { id: 'loopLen', mod: 'pulse', label: 'Loop', min: 2, max: 16, def: 8, int: true, fmt: 'steps', rnd: [0, 1] },
    { id: 'voices', mod: 'pulse', label: 'Voices', min: 1, max: MAX_VOICES, def: 1, int: true, fmt: 'voices', apply: 'voices', rnd: [0, 1] },
    // Pitch
    { id: 'pitchMin', mod: 'pitch', label: 'Low', min: 24, max: 96, def: 45, int: true, fmt: 'note', rnd: [0.2, 0.5] },
    { id: 'pitchMax', mod: 'pitch', label: 'High', min: 24, max: 108, def: 65, int: true, fmt: 'note', rnd: [0.35, 0.75] },
    { id: 'glideMs', mod: 'pitch', label: 'Glide', min: 0, max: 3000, def: 250, curve: 'pow', k: 3, fmt: 'ms', rnd: [0, 0.75] },
    { id: 'root', mod: 'pitch', label: 'Root', type: 'choice', options: NOTE_OPTIONS, def: 0, rnd: true },
    { id: 'scale', mod: 'pitch', label: 'Scale', type: 'choice', options: SCALE_OPTIONS, def: 'pent_minor', rnd: true },
    // Envelope
    { id: 'attackMs', mod: 'env', label: 'Attack', min: 1, max: 5000, def: 400, curve: 'pow', k: 3, fmt: 'ms', rnd: [0, 0.7] },
    { id: 'pulseWidth', mod: 'env', label: 'Hold', min: 10, max: 6000, def: 600, curve: 'pow', k: 3, fmt: 'ms', rnd: [0.1, 0.75] },
    { id: 'releaseMs', mod: 'env', label: 'Release', min: 20, max: 10000, def: 1600, curve: 'pow', k: 3, fmt: 'ms', rnd: [0.25, 0.85] },
    { id: 'droneFloor', mod: 'env', label: 'Drone', min: 0, max: 0.5, def: 0, fmt: 'pct', rnd: [0, 0.3] },
    // Oscillators
    { id: 'blend', mod: 'osc', label: 'Blend', min: 0, max: 1, def: 0.4, fmt: 'pct', apply: 'osc', rnd: [0, 1] },
    { id: 'detune', mod: 'osc', label: 'Detune', min: 0, max: 50, def: 0, curve: 'pow', k: 2, fmt: 'cents', apply: 'osc', rnd: [0, 0.8] },
    { id: 'subLevel', mod: 'osc', label: 'Sub', min: 0, max: 1, def: 0, fmt: 'pct', apply: 'osc', rnd: [0, 0.7] },
    // Filter
    { id: 'cutoffHz', mod: 'filter', label: 'Cutoff', min: 40, max: 16000, def: 1200, curve: 'log', fmt: 'hz', apply: 'filter', rnd: [0.35, 0.85] },
    { id: 'filterQ', mod: 'filter', label: 'Reso', min: 0, max: 24, def: 0.3, fmt: 'db', apply: 'filter', rnd: [0, 0.6] },
    { id: 'envToFilter', mod: 'filter', label: 'Env Amt', min: 0, max: 1, def: 0.5, fmt: 'pct', rnd: [0, 1] },
    { id: 'keyTrack', mod: 'filter', label: 'Key Trk', min: 0, max: 1, def: 0, fmt: 'pct', apply: 'filter', rnd: [0, 1] },
    // Noise
    { id: 'noiseMix', mod: 'noise', label: 'Breath', min: 0, max: 1, def: 0.08, curve: 'pow', k: 2, fmt: 'pct', apply: 'noise', rnd: [0, 0.6] },
    { id: 'noiseBandMix', mod: 'noise', label: 'Band', min: 0, max: 1, def: 0.25, fmt: 'pct', apply: 'noise', rnd: [0, 0.7] },
    { id: 'noiseBandHz', mod: 'noise', label: 'Band Hz', min: 100, max: 10000, def: 1800, curve: 'log', fmt: 'hz', apply: 'noise', rnd: [0.2, 0.9] },
    { id: 'noiseBandQ', mod: 'noise', label: 'Band Q', min: 0.3, max: 30, def: 3, curve: 'log', fmt: 'x', apply: 'noise', rnd: [0.2, 0.9] },
    // Warp
    { id: 'alienWarp', mod: 'warp', label: 'Amount', min: 0, max: 1, def: 0.1, fmt: 'pct', apply: 'warp', rnd: [0, 0.6] },
    { id: 'warpMode', mod: 'warp', label: 'Mode', type: 'choice', options: WARP_OPTIONS, def: 'saturate', apply: 'warp', rnd: true },
    // LFO
    { id: 'lfoRate', mod: 'lfo', label: 'Rate', min: 0.01, max: 20, def: 0.35, curve: 'log', fmt: 'hz', apply: 'lfo', rnd: [0.1, 0.85] },
    { id: 'lfoDepth', mod: 'lfo', label: 'Pitch', min: 0, max: 1200, def: 80, curve: 'pow', k: 2, fmt: 'cents', apply: 'lfo', rnd: [0, 0.45] },
    { id: 'lfoFilter', mod: 'lfo', label: 'Filter', min: 0, max: 2400, def: 0, curve: 'pow', k: 2, fmt: 'cents', apply: 'lfo', rnd: [0, 0.5] },
    { id: 'lfoShape', mod: 'lfo', label: 'Shape', type: 'choice', options: LFO_OPTIONS, def: 'sine', apply: 'lfo', rnd: true },
    // Chaos
    { id: 'chaosRate', mod: 'chaos', label: 'Rate', min: 0.05, max: 8, def: 0.25, curve: 'log', fmt: 'hz', rnd: [0.1, 0.7] },
    { id: 'chaosDepth', mod: 'chaos', label: 'Tempo', min: 0, max: 1, def: 0.5, fmt: 'pct', rnd: [0, 0.8] },
    { id: 'chaosFilter', mod: 'chaos', label: 'Filter', min: 0, max: 1, def: 0, fmt: 'pct', apply: 'chaos', rnd: [0, 0.6] },
    // Delay
    { id: 'delayTime', mod: 'delay', label: 'Time', min: 0.01, max: 1.5, def: 0.35, curve: 'pow', k: 2, fmt: 's', apply: 'delay', rnd: [0.2, 0.9] },
    { id: 'delayFb', mod: 'delay', label: 'Feedback', min: 0, max: 0.95, def: 0.35, fmt: 'pct', apply: 'delay', rnd: [0, 0.75] },
    { id: 'delayMix', mod: 'delay', label: 'Mix', min: 0, max: 1, def: 0.3, fmt: 'pct', apply: 'delayMix', rnd: [0, 0.5] },
    { id: 'delayTone', mod: 'delay', label: 'Tone', min: 400, max: 12000, def: 6000, curve: 'log', fmt: 'hz', apply: 'delay', rnd: [0.3, 0.9] },
    { id: 'delayWidth', mod: 'delay', label: 'Width', min: 0, max: 1, def: 0.5, fmt: 'pct', apply: 'delay', rnd: [0, 1] },
    // Space
    { id: 'spaceMix', mod: 'space', label: 'Mix', min: 0, max: 1, def: 0.25, fmt: 'pct', apply: 'space', rnd: [0.1, 0.7] },
    { id: 'spaceSize', mod: 'space', label: 'Size', min: 0.5, max: 10, def: 2.5, curve: 'log', fmt: 's', apply: 'spaceIR', rnd: [0.2, 0.9] },
    { id: 'spaceBright', mod: 'space', label: 'Bright', min: 0, max: 1, def: 0.5, fmt: 'pct', apply: 'spaceIR', rnd: [0.1, 0.9] },
    { id: 'duckDepth', mod: 'space', label: 'Duck', min: 0, max: 1, def: 0.65, fmt: 'pct', rnd: [0, 1] },
    { id: 'panSpread', mod: 'space', label: 'Spread', min: 0, max: 1, def: 0.35, fmt: 'pct', rnd: [0.1, 1] },
    // Master
    { id: 'masterDb', mod: 'master', label: 'Volume', min: -48, max: 12, def: 0, fmt: 'db', apply: 'master' },
  ];
  const PMAP = Object.fromEntries(PARAMS.map(p => [p.id, p]));
  const DEFAULTS = Object.fromEntries(PARAMS.map(p => [p.id, p.def]));

  function toNorm(p, v) {
    const r = p.max - p.min;
    if (p.curve === 'log') return Math.log(v / p.min) / Math.log(p.max / p.min);
    if (p.curve === 'pow') return Math.pow(clamp((v - p.min) / r, 0, 1), 1 / p.k);
    return (v - p.min) / r;
  }
  function fromNorm(p, n) {
    n = clamp(n, 0, 1);
    let v;
    if (p.curve === 'log') v = p.min * Math.pow(p.max / p.min, n);
    else if (p.curve === 'pow') v = p.min + (p.max - p.min) * Math.pow(n, p.k);
    else v = p.min + (p.max - p.min) * n;
    return p.int ? Math.round(v) : v;
  }
  function normalizeValue(p, v) {
    if (p.type === 'choice') {
      const hit = p.options.find(o => String(o.v) === String(v));
      return hit ? hit.v : p.def;
    }
    v = Number(v);
    if (!Number.isFinite(v)) return p.def;
    v = clamp(v, p.min, p.max);
    return p.int ? Math.round(v) : v;
  }
  const fmtParam = (p, v) => (p.type === 'choice' ? (p.options.find(o => o.v === v) || {}).label : FMT[p.fmt](v));
  const keyTracked = (cut, kt, midi) => clamp(cut * Math.pow(2, (kt * (midi - 60)) / 12), 20, 20000);

  // ===========================================================================
  // Factory presets (missing params fall back to defaults)
  // ===========================================================================
  const FACTORY = [
    { name: 'Krell Classic', cat: 'Classic', desc: 'The original patch — slow pentatonic throbs.', params: {} },
    {
      name: 'Forbidden Planet', cat: 'Classic', desc: 'Wide vibrato, long glides, overtone tuning.',
      params: {
        eventHz: 0.32, randomness: 0.5, glideMs: 900, pitchMin: 50, pitchMax: 74, scale: 'overtone',
        attackMs: 300, pulseWidth: 900, releaseMs: 3000, blend: 0.15, detune: 6,
        lfoRate: 6.2, lfoDepth: 45, cutoffHz: 2400, filterQ: 6, envToFilter: 0.35,
        noiseMix: 0.03, noiseBandMix: 0.12, noiseBandHz: 3200, noiseBandQ: 8, alienWarp: 0.18,
        delayTime: 0.42, delayFb: 0.45, delayMix: 0.32, delayTone: 3800, delayWidth: 0.8,
        spaceMix: 0.45, spaceSize: 6, spaceBright: 0.45, chaosDepth: 0.35,
      },
    },
    {
      name: 'Altair IV Nightfall', cat: 'Drones & Pads', desc: 'Three-voice drone cloud with drifting filter.',
      params: {
        voices: 3, eventHz: 0.18, density: 0.9, randomness: 0.4, glideMs: 1200, pitchMin: 38, pitchMax: 62,
        scale: 'pent_major', root: 2, attackMs: 2600, pulseWidth: 2400, releaseMs: 7000, droneFloor: 0.12,
        blend: 0.55, detune: 9, subLevel: 0.35, cutoffHz: 650, filterQ: 3, envToFilter: 0.4, keyTrack: 0.4,
        noiseMix: 0.12, noiseBandMix: 0.2, noiseBandHz: 900, noiseBandQ: 4, alienWarp: 0.05,
        lfoRate: 0.12, lfoDepth: 25, lfoFilter: 300, chaosRate: 0.08, chaosDepth: 0.3, chaosFilter: 0.35,
        delayTime: 0.62, delayFb: 0.5, delayMix: 0.25, delayTone: 2500, delayWidth: 1,
        spaceMix: 0.6, spaceSize: 9, spaceBright: 0.3, duckDepth: 0.3, panSpread: 0.7, masterDb: 1.5,
      },
    },
    {
      name: 'Id Monster', cat: 'Textures & FX', desc: 'Low, folded and resonant. Something is out there.',
      params: {
        eventHz: 0.45, randomness: 0.7, pitchMin: 28, pitchMax: 46, scale: 'phrygian', root: 4, glideMs: 600,
        attackMs: 120, pulseWidth: 900, releaseMs: 2200, blend: 0.8, detune: 18, subLevel: 0.7,
        cutoffHz: 380, filterQ: 16, envToFilter: 0.85, keyTrack: 0.2,
        noiseMix: 0.25, noiseBandMix: 0.15, noiseBandHz: 400, noiseBandQ: 6, alienWarp: 0.55, warpMode: 'fold',
        lfoRate: 3.5, lfoDepth: 30, lfoFilter: 600, lfoShape: 'triangle', chaosRate: 0.6, chaosDepth: 0.6, chaosFilter: 0.3,
        delayTime: 0.28, delayFb: 0.4, delayMix: 0.22, delayTone: 1800, delayWidth: 0.6,
        spaceMix: 0.35, spaceSize: 4.5, spaceBright: 0.25, duckDepth: 0.7, panSpread: 0.3, masterDb: 2,
      },
    },
    {
      name: 'Krell Machinery', cat: 'Sequences & Machines', desc: 'Locked whole-tone loop, ticking and metallic.',
      params: {
        voices: 2, eventHz: 3.6, density: 0.82, randomness: 0.35, memory: 0.9, loopLen: 6,
        pitchMin: 52, pitchMax: 79, scale: 'whole', glideMs: 15, attackMs: 4, pulseWidth: 50, releaseMs: 260,
        blend: 0.7, detune: 4, cutoffHz: 1500, filterQ: 10, envToFilter: 0.75, keyTrack: 0.5,
        noiseMix: 0.05, noiseBandMix: 0.5, noiseBandHz: 4200, noiseBandQ: 14, alienWarp: 0.32,
        lfoRate: 7.5, lfoDepth: 20, lfoShape: 'square', chaosRate: 0.5, chaosDepth: 0.15,
        delayTime: 0.21, delayFb: 0.6, delayMix: 0.35, delayTone: 5000, delayWidth: 1,
        spaceMix: 0.22, spaceSize: 2.2, spaceBright: 0.6, duckDepth: 0.8, panSpread: 0.55, masterDb: 9,
      },
    },
    {
      name: 'Ion Storm', cat: 'Textures & FX', desc: 'Maximum chaos: rectified sparks and noise squalls.',
      params: {
        voices: 3, eventHz: 1.6, density: 0.7, randomness: 1, pitchMin: 40, pitchMax: 90, scale: 'chromatic',
        glideMs: 80, attackMs: 30, pulseWidth: 180, releaseMs: 900, blend: 0.5, detune: 25,
        cutoffHz: 2200, filterQ: 8, envToFilter: 0.6, noiseMix: 0.45, noiseBandMix: 0.7, noiseBandHz: 2600, noiseBandQ: 12,
        alienWarp: 0.4, warpMode: 'rectify', lfoRate: 11, lfoDepth: 300, lfoShape: 'sawtooth', lfoFilter: 900,
        chaosRate: 2.5, chaosDepth: 1, chaosFilter: 0.8,
        delayTime: 0.13, delayFb: 0.55, delayMix: 0.3, delayTone: 7000, delayWidth: 1,
        spaceMix: 0.4, spaceSize: 3.5, spaceBright: 0.7, duckDepth: 0.5, panSpread: 0.9, masterDb: 8,
      },
    },
    {
      name: 'Glass Rain', cat: 'Textures & FX', desc: 'High overtone droplets in a bright hall.',
      params: {
        voices: 4, eventHz: 2.4, density: 0.55, randomness: 0.55, pitchMin: 72, pitchMax: 96, scale: 'overtone', root: 7,
        glideMs: 0, attackMs: 2, pulseWidth: 25, releaseMs: 1400, blend: 0.85, detune: 3,
        cutoffHz: 7000, filterQ: 2, envToFilter: 0.3, keyTrack: 0.6, noiseMix: 0, noiseBandMix: 0.06,
        noiseBandHz: 7000, noiseBandQ: 20, alienWarp: 0, lfoRate: 0.2, lfoDepth: 8, chaosRate: 0.3, chaosDepth: 0.4,
        delayTime: 0.33, delayFb: 0.58, delayMix: 0.38, delayTone: 8000, delayWidth: 1,
        spaceMix: 0.55, spaceSize: 7, spaceBright: 0.8, duckDepth: 0.4, panSpread: 0.85, masterDb: 8,
      },
    },
    {
      name: 'Pulsar Beacon', cat: 'Sequences & Machines', desc: 'A four-step octatonic signal, repeating forever.',
      params: {
        eventHz: 1.25, randomness: 0.2, memory: 1, loopLen: 4, pitchMin: 45, pitchMax: 69, scale: 'octatonic',
        glideMs: 120, attackMs: 8, pulseWidth: 140, releaseMs: 600, blend: 0.3, detune: 12, subLevel: 0.5,
        cutoffHz: 900, filterQ: 12, envToFilter: 0.9, keyTrack: 0.3, noiseMix: 0.02, noiseBandMix: 0.1,
        noiseBandHz: 1200, noiseBandQ: 10, alienWarp: 0.22, lfoRate: 0.5, lfoDepth: 10, chaosDepth: 0,
        delayTime: 0.4, delayFb: 0.5, delayMix: 0.3, delayTone: 3000, delayWidth: 0.9,
        spaceMix: 0.3, spaceSize: 3, spaceBright: 0.45, duckDepth: 0.75, panSpread: 0.25, masterDb: 10,
      },
    },
    {
      name: 'Deep Space Choir', cat: 'Drones & Pads', desc: 'Slow, wide, four-voice dorian pads.',
      params: {
        voices: 4, eventHz: 0.28, density: 0.95, randomness: 0.45, pitchMin: 48, pitchMax: 72, scale: 'dorian', root: 9,
        glideMs: 700, attackMs: 1800, pulseWidth: 2200, releaseMs: 5500, droneFloor: 0.05,
        blend: 0.65, detune: 22, subLevel: 0.15, cutoffHz: 1600, filterQ: 1.5, envToFilter: 0.25, keyTrack: 0.5,
        noiseMix: 0.06, noiseBandMix: 0.3, noiseBandHz: 1400, noiseBandQ: 5, alienWarp: 0.06,
        lfoRate: 0.22, lfoDepth: 18, lfoFilter: 250, chaosRate: 0.12, chaosDepth: 0.25, chaosFilter: 0.2,
        delayTime: 0.55, delayFb: 0.42, delayMix: 0.22, delayTone: 3000, delayWidth: 1,
        spaceMix: 0.7, spaceSize: 10, spaceBright: 0.5, duckDepth: 0.2, panSpread: 0.8, masterDb: 1,
      },
    },
    {
      name: 'Ancient Signal', cat: 'Classic', desc: 'A half-remembered Hirajōshi transmission.',
      params: {
        eventHz: 0.9, density: 0.75, randomness: 0.3, memory: 0.7, loopLen: 5, pitchMin: 57, pitchMax: 81,
        scale: 'hirajoshi', root: 5, glideMs: 400, attackMs: 60, pulseWidth: 300, releaseMs: 1800, blend: 0.1,
        cutoffHz: 3000, filterQ: 4, envToFilter: 0.2, noiseMix: 0.15, noiseBandMix: 0.45, noiseBandHz: 2200, noiseBandQ: 18,
        alienWarp: 0.12, lfoRate: 4.8, lfoDepth: 35, lfoShape: 'triangle', chaosRate: 0.2, chaosDepth: 0.3,
        delayTime: 0.75, delayFb: 0.55, delayMix: 0.4, delayTone: 2200, delayWidth: 0.7,
        spaceMix: 0.4, spaceSize: 5, spaceBright: 0.35, duckDepth: 0.6, panSpread: 0.4, masterDb: -2,
      },
    },
    {
      name: 'Monolith Drone', cat: 'Drones & Pads', desc: 'Sub-heavy, near-static. Turn it up.',
      params: {
        voices: 2, eventHz: 0.1, randomness: 0.25, pitchMin: 31, pitchMax: 43, glideMs: 2500,
        attackMs: 4000, pulseWidth: 5000, releaseMs: 9000, droneFloor: 0.3, blend: 0.45, detune: 7, subLevel: 0.6,
        cutoffHz: 420, filterQ: 9, envToFilter: 0.3, noiseMix: 0.18, noiseBandMix: 0.3, noiseBandHz: 650, noiseBandQ: 2.5,
        alienWarp: 0.25, lfoRate: 0.07, lfoDepth: 12, lfoFilter: 700, chaosRate: 0.05, chaosDepth: 0.2, chaosFilter: 0.5,
        delayTime: 1.1, delayFb: 0.35, delayMix: 0.15, delayTone: 1500, delayWidth: 1,
        spaceMix: 0.5, spaceSize: 8, spaceBright: 0.2, duckDepth: 0.1, panSpread: 0.5, masterDb: 3,
      },
    },
    // ---- Classic
    {
      name: 'Theremin Ghost', cat: 'Classic', desc: 'One long, wavering voice sliding between notes.',
      params: {
        eventHz: 0.45, randomness: 0.35, pitchMin: 60, pitchMax: 84, scale: 'chromatic', glideMs: 1400,
        attackMs: 600, pulseWidth: 1500, releaseMs: 2500, blend: 0, cutoffHz: 5000, filterQ: 0, envToFilter: 0.1,
        noiseMix: 0, noiseBandMix: 0.04, alienWarp: 0.04, lfoRate: 5.8, lfoDepth: 40, chaosDepth: 0.2,
        delayTime: 0.38, delayFb: 0.3, delayMix: 0.2, delayTone: 4000, delayWidth: 0.7,
        spaceMix: 0.45, spaceSize: 4, spaceBright: 0.5, duckDepth: 0.4, panSpread: 0.2, masterDb: -4.5,
      },
    },
    // ---- Drones & Pads
    {
      name: 'Tidal Lock', cat: 'Drones & Pads', desc: 'Four lydian voices that barely move. Very slow.',
      params: {
        voices: 4, eventHz: 0.07, density: 1, randomness: 0.3, pitchMin: 36, pitchMax: 60, scale: 'lydian', root: 5,
        glideMs: 2000, attackMs: 5000, pulseWidth: 6000, releaseMs: 10000, droneFloor: 0.25,
        blend: 0.3, detune: 30, subLevel: 0.2, cutoffHz: 900, filterQ: 2, envToFilter: 0.2, keyTrack: 0.3,
        noiseMix: 0.05, noiseBandMix: 0.1, noiseBandHz: 1100, noiseBandQ: 3, alienWarp: 0.04,
        lfoRate: 0.05, lfoDepth: 10, lfoFilter: 900, chaosRate: 0.06, chaosDepth: 0.2, chaosFilter: 0.4,
        delayTime: 1.3, delayFb: 0.3, delayMix: 0.12, delayTone: 2200, delayWidth: 1,
        spaceMix: 0.65, spaceSize: 10, spaceBright: 0.4, duckDepth: 0.05, panSpread: 0.9, masterDb: 2.5,
      },
    },
    {
      name: 'Cathedral of Glass', cat: 'Drones & Pads', desc: 'Bright mixolydian swells in an enormous room.',
      params: {
        voices: 4, eventHz: 0.4, density: 0.9, randomness: 0.4, pitchMin: 55, pitchMax: 79, scale: 'mixolydian', root: 7,
        glideMs: 300, attackMs: 900, pulseWidth: 1500, releaseMs: 6000, blend: 0.9, detune: 14,
        cutoffHz: 3500, filterQ: 4, envToFilter: 0.2, keyTrack: 0.6, noiseMix: 0.02, noiseBandMix: 0.12,
        noiseBandHz: 5000, noiseBandQ: 9, alienWarp: 0.03, lfoRate: 0.3, lfoDepth: 9, chaosDepth: 0.2,
        delayTime: 0.5, delayFb: 0.45, delayMix: 0.25, delayTone: 6000, delayWidth: 1,
        spaceMix: 0.75, spaceSize: 10, spaceBright: 0.75, duckDepth: 0.15, panSpread: 0.85, masterDb: 3,
      },
    },
    {
      name: 'Dead Star', cat: 'Drones & Pads', desc: 'Folded sub-bass groaning under a closed filter.',
      params: {
        voices: 2, eventHz: 0.12, randomness: 0.3, pitchMin: 24, pitchMax: 36, scale: 'octatonic', glideMs: 1800,
        attackMs: 3000, pulseWidth: 4000, releaseMs: 8000, droneFloor: 0.35, blend: 0.2, detune: 5, subLevel: 0.9,
        cutoffHz: 160, filterQ: 18, envToFilter: 0.5, noiseMix: 0.1, noiseBandMix: 0.15, noiseBandHz: 300, noiseBandQ: 3,
        alienWarp: 0.45, warpMode: 'fold', lfoRate: 0.03, lfoDepth: 6, lfoFilter: 1500, chaosRate: 0.05, chaosDepth: 0.15,
        chaosFilter: 0.3, delayTime: 1.4, delayFb: 0.25, delayMix: 0.1, delayTone: 1200, delayWidth: 1,
        spaceMix: 0.45, spaceSize: 7, spaceBright: 0.1, duckDepth: 0.1, panSpread: 0.4, masterDb: 2,
      },
    },
    {
      name: 'Ion Engine Idle', cat: 'Drones & Pads', desc: 'A humming engine with a fluttering filter.',
      params: {
        voices: 2, eventHz: 0.5, randomness: 0.2, pitchMin: 33, pitchMax: 40, scale: 'pent_minor', glideMs: 500,
        attackMs: 1500, pulseWidth: 3000, releaseMs: 3000, droneFloor: 0.4, blend: 0.8, detune: 3, subLevel: 0.4,
        cutoffHz: 500, filterQ: 12, envToFilter: 0.2, noiseMix: 0.08, noiseBandMix: 0.4, noiseBandHz: 280, noiseBandQ: 4,
        alienWarp: 0.4, lfoRate: 9, lfoDepth: 6, lfoFilter: 400, lfoShape: 'square', chaosRate: 0.2, chaosDepth: 0.1,
        delayTime: 0.3, delayFb: 0.2, delayMix: 0.08, delayTone: 2000, delayWidth: 0.5,
        spaceMix: 0.3, spaceSize: 2.5, spaceBright: 0.3, duckDepth: 0.3, panSpread: 0.3, masterDb: 4,
      },
    },
    {
      name: 'Solar Wind', cat: 'Drones & Pads', desc: 'Mostly noise: gusts of filtered breath over low tones.',
      params: {
        voices: 3, eventHz: 0.2, density: 0.9, randomness: 0.6, pitchMin: 30, pitchMax: 42, scale: 'aeolian', glideMs: 1500,
        attackMs: 2500, pulseWidth: 1500, releaseMs: 5000, droneFloor: 0.1, blend: 0.5, detune: 12,
        cutoffHz: 600, filterQ: 6, envToFilter: 0.6, noiseMix: 0.7, noiseBandMix: 0.9, noiseBandHz: 1200, noiseBandQ: 2,
        alienWarp: 0.08, lfoRate: 0.1, lfoDepth: 15, lfoFilter: 1200, chaosRate: 0.15, chaosDepth: 0.4, chaosFilter: 0.9,
        delayTime: 0.7, delayFb: 0.3, delayMix: 0.1, delayTone: 2500, delayWidth: 1,
        spaceMix: 0.6, spaceSize: 8, spaceBright: 0.45, duckDepth: 0.2, panSpread: 1, masterDb: 2.5,
      },
    },
    // ---- Sequences & Machines
    {
      name: 'Subterranean Pulse', cat: 'Sequences & Machines', desc: 'A locked eight-step bassline, resonant and driven.',
      params: {
        eventHz: 2, density: 0.9, randomness: 0.2, memory: 1, loopLen: 8, pitchMin: 28, pitchMax: 40,
        scale: 'pent_minor', root: 9, glideMs: 30, attackMs: 3, pulseWidth: 90, releaseMs: 350,
        blend: 0.6, subLevel: 0.8, cutoffHz: 220, filterQ: 14, envToFilter: 0.95, keyTrack: 0.2,
        noiseMix: 0.04, noiseBandMix: 0.05, alienWarp: 0.35, lfoDepth: 4, chaosDepth: 0,
        delayTime: 0.25, delayFb: 0.3, delayMix: 0.15, delayTone: 2000, delayWidth: 0.8,
        spaceMix: 0.2, spaceSize: 1.8, spaceBright: 0.4, duckDepth: 0.8, panSpread: 0.15, masterDb: 9,
      },
    },
    {
      name: 'Morse From Orbit', cat: 'Sequences & Machines', desc: 'Pure sine beeps in a long repeating message.',
      params: {
        eventHz: 6, density: 0.6, randomness: 0.1, memory: 0.95, loopLen: 12, pitchMin: 76, pitchMax: 88,
        scale: 'pent_major', glideMs: 0, attackMs: 1, pulseWidth: 40, releaseMs: 80, blend: 0,
        cutoffHz: 9000, filterQ: 0, envToFilter: 0, noiseMix: 0, noiseBandMix: 0.05, noiseBandHz: 6000, noiseBandQ: 8,
        alienWarp: 0, lfoDepth: 0, chaosDepth: 0,
        delayTime: 0.09, delayFb: 0.4, delayMix: 0.25, delayTone: 7000, delayWidth: 1,
        spaceMix: 0.3, spaceSize: 2.5, spaceBright: 0.7, duckDepth: 0.8, panSpread: 0.3, masterDb: 2.5,
      },
    },
    {
      name: 'Telemetry', cat: 'Sequences & Machines', desc: 'A sixteen-step dorian readout with echoes.',
      params: {
        eventHz: 2.8, density: 0.85, randomness: 0.25, memory: 1, loopLen: 16, pitchMin: 57, pitchMax: 76,
        scale: 'dorian', root: 2, glideMs: 40, attackMs: 5, pulseWidth: 120, releaseMs: 500, blend: 0.5, detune: 8,
        cutoffHz: 1800, filterQ: 9, envToFilter: 0.7, keyTrack: 0.5, noiseMix: 0.03, noiseBandMix: 0.1,
        noiseBandHz: 2500, noiseBandQ: 8, alienWarp: 0.12, lfoRate: 0.4, lfoDepth: 6, chaosDepth: 0.05,
        delayTime: 0.27, delayFb: 0.5, delayMix: 0.3, delayTone: 4500, delayWidth: 1,
        spaceMix: 0.3, spaceSize: 3, spaceBright: 0.5, duckDepth: 0.7, panSpread: 0.45, masterDb: 7.5,
      },
    },
    {
      name: 'Lullaby Protocol', cat: 'Sequences & Machines', desc: 'A gentle, half-repeating major-pentatonic tune.',
      params: {
        eventHz: 0.8, density: 0.9, randomness: 0.3, memory: 0.6, loopLen: 6, pitchMin: 60, pitchMax: 79,
        scale: 'pent_major', glideMs: 200, attackMs: 120, pulseWidth: 250, releaseMs: 1600, blend: 0.7,
        cutoffHz: 2600, filterQ: 1, envToFilter: 0.2, noiseMix: 0.02, noiseBandMix: 0.06, alienWarp: 0.02,
        lfoRate: 4.5, lfoDepth: 12, chaosDepth: 0.15,
        delayTime: 0.5, delayFb: 0.45, delayMix: 0.3, delayTone: 3500, delayWidth: 0.9,
        spaceMix: 0.5, spaceSize: 5, spaceBright: 0.55, duckDepth: 0.5, panSpread: 0.35, masterDb: -2,
      },
    },
    // ---- Textures & FX
    {
      name: 'Crystal Lattice', cat: 'Textures & FX', desc: 'Folded triangle chimes with long ping-pong echoes.',
      params: {
        voices: 4, eventHz: 3.2, density: 0.65, randomness: 0.5, pitchMin: 66, pitchMax: 90, scale: 'lydian', root: 2,
        glideMs: 0, attackMs: 1, pulseWidth: 15, releaseMs: 2200, blend: 1, detune: 7,
        cutoffHz: 9000, filterQ: 1, envToFilter: 0.2, keyTrack: 0.4, noiseMix: 0, noiseBandMix: 0.04,
        alienWarp: 0.3, warpMode: 'fold', lfoRate: 0.2, lfoDepth: 5, chaosRate: 0.3, chaosDepth: 0.3,
        delayTime: 0.375, delayFb: 0.62, delayMix: 0.35, delayTone: 7000, delayWidth: 1,
        spaceMix: 0.5, spaceSize: 6, spaceBright: 0.9, duckDepth: 0.4, panSpread: 0.9, masterDb: 3.5,
      },
    },
    {
      name: 'Mechanical Insects', cat: 'Textures & FX', desc: 'Tiny high clicks and chirps everywhere.',
      params: {
        voices: 4, eventHz: 7, density: 0.5, randomness: 0.9, pitchMin: 80, pitchMax: 104, scale: 'chromatic',
        glideMs: 10, attackMs: 1, pulseWidth: 10, releaseMs: 60, blend: 0.5, detune: 20,
        cutoffHz: 6000, filterQ: 6, envToFilter: 0.5, noiseMix: 0.1, noiseBandMix: 0.8, noiseBandHz: 6000, noiseBandQ: 25,
        alienWarp: 0.5, warpMode: 'rectify', lfoRate: 18, lfoDepth: 600, lfoShape: 'sawtooth', chaosRate: 1.5, chaosDepth: 0.6,
        delayTime: 0.06, delayFb: 0.5, delayMix: 0.3, delayTone: 9000, delayWidth: 1,
        spaceMix: 0.25, spaceSize: 1.5, spaceBright: 0.7, duckDepth: 0.3, panSpread: 1, masterDb: 9.5,
      },
    },
    {
      name: 'Event Horizon', cat: 'Textures & FX', desc: 'Enormous glides falling in and out of range.',
      params: {
        voices: 2, eventHz: 0.25, randomness: 0.8, pitchMin: 30, pitchMax: 90, scale: 'chromatic', glideMs: 3000,
        attackMs: 1500, pulseWidth: 2000, releaseMs: 4000, blend: 0.4, detune: 10, subLevel: 0.3,
        cutoffHz: 1400, filterQ: 6, envToFilter: 0.4, noiseMix: 0.06, noiseBandMix: 0.2, noiseBandHz: 900, noiseBandQ: 5,
        alienWarp: 0.3, lfoRate: 0.08, lfoDepth: 400, lfoShape: 'triangle', chaosRate: 0.2, chaosDepth: 0.8, chaosFilter: 0.6,
        delayTime: 0.8, delayFb: 0.7, delayMix: 0.3, delayTone: 2000, delayWidth: 1,
        spaceMix: 0.6, spaceSize: 9, spaceBright: 0.4, duckDepth: 0.3, panSpread: 0.7, masterDb: -1,
      },
    },
    {
      name: 'Rain on Hull', cat: 'Textures & FX', desc: 'Scattered metallic drops with a hiss of breath.',
      params: {
        voices: 4, eventHz: 5.5, density: 0.45, randomness: 1, pitchMin: 60, pitchMax: 96, scale: 'whole',
        glideMs: 0, attackMs: 1, pulseWidth: 5, releaseMs: 150, blend: 0.3, detune: 6,
        cutoffHz: 4000, filterQ: 3, envToFilter: 0.4, noiseMix: 0.3, noiseBandMix: 0.5, noiseBandHz: 3500, noiseBandQ: 6,
        alienWarp: 0.1, lfoDepth: 0, chaosRate: 0.5, chaosDepth: 0.5,
        delayTime: 0.15, delayFb: 0.3, delayMix: 0.2, delayTone: 6000, delayWidth: 1,
        spaceMix: 0.5, spaceSize: 3, spaceBright: 0.6, duckDepth: 0.2, panSpread: 1, masterDb: 9,
      },
    },
  ];
  const PRESET_CATS = ['Classic', 'Drones & Pads', 'Sequences & Machines', 'Textures & FX'];
  FACTORY.sort((a, b) => PRESET_CATS.indexOf(a.cat) - PRESET_CATS.indexOf(b.cat)); // stable: keeps order within a category

  // ===========================================================================
  // Audio engine
  // ===========================================================================
  function createEngine(ac, P, opts = {}) {
    const E = { ac, voices: [], init: true };
    const now = () => ac.currentTime;
    const gain = (v = 1) => { const g = ac.createGain(); g.gain.value = v; return g; };
    const filt = (type, f, q) => { const b = ac.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; };
    const shaper = (curve, oversample) => { const s = ac.createWaveShaper(); s.curve = curve; s.oversample = oversample; return s; };
    const chain = (...n) => { for (let i = 0; i < n.length - 1; i++) n[i].connect(n[i + 1]); return n[n.length - 1]; };
    // All live changes are smoothed (no zipper noise); at build time values are set directly.
    const set = (param, v, tc = 0.03) => { if (E.init) param.value = v; else param.setTargetAtTime(v, now(), tc); };

    // ---- Output stage: sum → master → limiter → safety ceiling → out
    const sum = gain();
    const master = gain(0);
    const limiter = ac.createDynamicsCompressor();
    limiter.threshold.value = -4;
    limiter.knee.value = 2;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.18;
    const ceilIn = gain(1 / CEIL_RANGE);
    const ceil = shaper(makeCurve(16385, CEIL_RANGE, ceilingFn), 'none');
    const out = gain();
    chain(sum, master, limiter, ceilIn, ceil, out);
    if (opts.connectOutput !== false) out.connect(ac.destination);
    E.output = out;
    E.preLimiter = master;
    E.limiter = limiter;

    // ---- Warp: dry at unity, drive only on the wet branch
    const bus = gain();
    const warpDry = gain(1), warpDrive = gain(1 / WARP_RANGE), warpWet = gain(0);
    bus.connect(warpDry);
    bus.connect(warpDrive);
    const warpSlots = WARP_MODES.map(m => {
      const s = shaper(makeCurve(8193, WARP_RANGE, m.fn), '4x');
      const g = gain(0);
      chain(warpDrive, s, g, warpWet);
      return g;
    });
    const dcBlock = filt('highpass', 15, BUTTERWORTH);
    warpDry.connect(dcBlock);
    warpWet.connect(dcBlock);

    // ---- Ping-pong delay with filtered, saturated feedback
    const delayDry = gain(1), delayWet = gain(0);
    chain(dcBlock, delayDry, sum);
    const dIn = gain(1);
    dIn.channelCount = 1; dIn.channelCountMode = 'explicit'; dIn.channelInterpretation = 'speakers';
    const dL = ac.createDelay(2), dR = ac.createDelay(2);
    const fbLP = filt('lowpass', 6000, BUTTERWORTH), fbHP = filt('highpass', 70, BUTTERWORTH);
    const fbGain = gain(0), fbSatIn = gain(1 / FB_RANGE);
    const fbSat = shaper(makeCurve(4097, FB_RANGE, Math.tanh), 'none');
    dcBlock.connect(dIn);
    chain(dIn, dL, dR, fbLP, fbHP, fbGain, fbSatIn, fbSat, dL);
    const merger = ac.createChannelMerger(2);
    const wLL = gain(), wRL = gain(), wRR = gain(), wLR = gain();
    dL.connect(wLL); wLL.connect(merger, 0, 0);
    dR.connect(wRL); wRL.connect(merger, 0, 0);
    dR.connect(wRR); wRR.connect(merger, 0, 1);
    dL.connect(wLR); wLR.connect(merger, 0, 1);
    chain(merger, delayWet, sum);

    // ---- Space: send → duck → pre-delay → two crossfaded convolvers
    const spaceSend = gain(0), spaceDuck = gain(1);
    const preDelay = ac.createDelay(0.2);
    preDelay.delayTime.value = 0.018;
    chain(dcBlock, spaceSend, spaceDuck, preDelay);
    const convs = [0, 1].map(() => {
      const c = ac.createConvolver();
      c.normalize = false;
      const g = gain(0);
      chain(preDelay, c, g, sum);
      return { c, g };
    });
    let activeConv = -1, irTimer = null;
    function loadIR() {
      const buf = makeImpulse(ac, P.spaceSize, P.spaceBright);
      if (activeConv < 0) { convs[0].c.buffer = buf; convs[0].g.gain.value = 1; activeConv = 0; return; }
      const next = 1 - activeConv, prev = activeConv, t = now();
      convs[next].c.buffer = buf;
      convs[next].g.gain.cancelScheduledValues(t);
      convs[next].g.gain.setTargetAtTime(1, t, 0.12);
      convs[prev].g.gain.cancelScheduledValues(t);
      convs[prev].g.gain.setTargetAtTime(0, t, 0.12);
      activeConv = next;
      clearTimeout(irTimer);
      irTimer = setTimeout(() => { try { convs[prev].c.buffer = null; } catch (_) { /* keep */ } }, 1500);
    }

    // ---- Modulation sources
    const lfo = ac.createOscillator();
    const lfoPitch = gain(0), lfoFilt = gain(0);
    lfo.connect(lfoPitch);
    lfo.connect(lfoFilt);
    const chaosCV = ac.createConstantSource();
    chaosCV.offset.value = 0;
    const chaosFilt = gain(0);
    chaosCV.connect(chaosFilt);

    const nBuf = ac.createBuffer(1, ac.sampleRate * 4, ac.sampleRate);
    const nd = nBuf.getChannelData(0);
    const nr = rng(0x5EED);
    for (let i = 0; i < nd.length; i++) nd[i] = nr() * 2 - 1;
    const noise = ac.createBufferSource();
    noise.buffer = nBuf;
    noise.loop = true;

    // ---- Voices
    const sources = [lfo, chaosCV, noise];
    for (let i = 0; i < MAX_VOICES; i++) {
      const v = { busyUntil: 0, startedAt: -1, lastMidi: 55 };
      const f0 = midiToHz(55);
      v.oscA = ac.createOscillator(); v.oscA.type = 'sine'; v.oscA.frequency.value = f0;
      v.oscB = ac.createOscillator(); v.oscB.type = 'triangle'; v.oscB.frequency.value = f0;
      v.sub = ac.createOscillator(); v.sub.type = 'sine'; v.sub.frequency.value = f0 / 2;
      v.gA = gain(0); v.gB = gain(0); v.gS = gain(0);
      v.vca = gain(0);
      chain(v.oscA, v.gA, v.vca);
      chain(v.oscB, v.gB, v.vca);
      chain(v.sub, v.gS, v.vca);
      lfoPitch.connect(v.oscA.detune);
      lfoPitch.connect(v.oscB.detune);
      lfoPitch.connect(v.sub.detune);

      v.nEnv = gain(0);
      v.nLP = gain(0);
      chain(noise, v.nEnv, v.nLP);

      v.vcf = filt('lowpass', 1200, 0);
      v.vca.connect(v.vcf);
      v.nLP.connect(v.vcf);
      lfoFilt.connect(v.vcf.detune);
      chaosFilt.connect(v.vcf.detune);
      v.reso = gain(1);
      v.vcf.connect(v.reso);

      v.bp = filt('bandpass', 1800, 3);
      v.bpG = gain(0);
      chain(v.nEnv, v.bp, v.bpG);

      v.out = gain(0);
      v.reso.connect(v.out);
      v.bpG.connect(v.out);
      v.pan = ac.createStereoPanner();
      chain(v.out, v.pan, bus);

      sources.push(v.oscA, v.oscB, v.sub);
      E.voices.push(v);
    }

    // ---- Parameter application (one function per area)
    E.apply = {
      master() {
        set(master.gain, P.masterDb <= -47.9 ? 0 : dbToGain(P.masterDb), 0.05);
      },
      voices() {
        const g = VOICE_LEVEL / Math.sqrt(clamp(P.voices, 1, MAX_VOICES));
        for (const v of E.voices) set(v.out.gain, g, 0.08);
      },
      osc() {
        const b = P.blend, s = P.subLevel, k = 1 / (1 + s), d = P.detune / 2;
        for (const v of E.voices) {
          set(v.gA.gain, (1 - b) * k);
          set(v.gB.gain, b * k);
          set(v.gS.gain, s * k);
          set(v.oscA.detune, d, 0.05);
          set(v.oscB.detune, -d, 0.05);
        }
      },
      filter() {
        const q = P.filterQ, comp = dbToGain(-0.5 * q); // give back half the resonant peak
        for (const v of E.voices) {
          set(v.vcf.frequency, keyTracked(P.cutoffHz, P.keyTrack, v.lastMidi));
          set(v.vcf.Q, q);
          set(v.reso.gain, comp);
        }
      },
      noise() {
        const q = P.noiseBandQ, comp = clamp(Math.sqrt(q / 3), 0.35, 3.2); // constant-loudness band noise
        for (const v of E.voices) {
          set(v.nLP.gain, P.noiseMix, 0.05);
          set(v.bp.frequency, P.noiseBandHz);
          set(v.bp.Q, q);
          set(v.bpG.gain, P.noiseBandMix * comp, 0.05);
        }
      },
      warp() {
        const x = P.alienWarp, drive = 1 + x * (WARP_RANGE - 1);
        set(warpDrive.gain, drive / WARP_RANGE, 0.05);
        set(warpDry.gain, 1 - x, 0.05);
        set(warpWet.gain, x * WARP_OUT, 0.05);
        WARP_MODES.forEach((m, i) => set(warpSlots[i].gain, m.id === P.warpMode ? 1 : 0, 0.04));
      },
      lfo() {
        if (lfo.type !== P.lfoShape) lfo.type = P.lfoShape;
        set(lfo.frequency, P.lfoRate, 0.05);
        set(lfoPitch.gain, P.lfoDepth, 0.05);
        set(lfoFilt.gain, P.lfoFilter, 0.05);
      },
      chaos() {
        set(chaosFilt.gain, P.chaosFilter * 1800, 0.05);
      },
      delay() {
        set(dL.delayTime, P.delayTime, 0.12);
        set(dR.delayTime, P.delayTime, 0.12);
        set(fbGain.gain, P.delayFb * P.delayFb, 0.05); // one round trip = two echoes
        set(fbLP.frequency, P.delayTone, 0.05);
        const th = ((1 - P.delayWidth) * Math.PI) / 4, a = Math.cos(th), b = Math.sin(th);
        set(wLL.gain, a); set(wRR.gain, a); set(wRL.gain, b); set(wLR.gain, b);
      },
      delayMix() {
        set(delayDry.gain, 1 - P.delayMix, 0.05);
        set(delayWet.gain, P.delayMix, 0.05);
      },
      space() {
        set(spaceSend.gain, P.spaceMix * SPACE_LEVEL, 0.05);
      },
      spaceIR() {
        loadIR();
      },
    };

    // ---- Pulse trigger (sample-accurate, scheduled ahead of time)
    // Envelopes are built only from setTargetAtTime segments, so a retrigger always
    // continues from the current level — no clicks, no stale `.value` reads.
    E.trigger = (t, ev) => {
      const v = E.voices[ev.voice];
      v.busyUntil = t + ev.atk + ev.hold + ev.rel;
      v.startedAt = t;
      v.lastMidi = ev.midi;

      const pitch = (osc, f) => {
        const fp = osc.frequency;
        fp.cancelScheduledValues(t);
        if (ev.glide > 0.003) fp.setTargetAtTime(f, t, ev.glide / 3);
        else fp.setValueAtTime(f, t);
      };
      pitch(v.oscA, ev.freq);
      pitch(v.oscB, ev.freq);
      pitch(v.sub, ev.freq * 0.5);

      const env = (param, peak, atk, hold, rel, floor) => {
        param.cancelScheduledValues(t);
        param.setTargetAtTime(peak, t, Math.max(0.0007, atk / 3));
        param.setTargetAtTime(floor, t + atk + hold, Math.max(0.004, rel / 4));
      };
      const floor = P.droneFloor;
      env(v.vca.gain, ev.peak, ev.atk, ev.hold, ev.rel, floor);
      env(v.nEnv.gain, ev.peak, ev.atk * 0.9, ev.hold * 0.85, ev.rel * 0.85, floor);

      // Base cutoff on .frequency (key-tracked); envelope in cents on .detune so the
      // cutoff knob and the envelope never fight each other.
      const fc = v.vcf.frequency;
      fc.cancelScheduledValues(t);
      fc.setTargetAtTime(keyTracked(P.cutoffHz, P.keyTrack, ev.midi), t, 0.012);
      const det = v.vcf.detune;
      det.cancelScheduledValues(t);
      det.setTargetAtTime(P.envToFilter * 2400 * ev.peak, t, Math.max(0.001, ev.atk / 3));
      det.setTargetAtTime(0, t + ev.atk, Math.max(0.01, (ev.hold + ev.rel) / 4));

      const pp = v.pan.pan;
      pp.cancelScheduledValues(t);
      pp.setTargetAtTime(ev.pan, t, 0.12);

      // Duck the reverb send on each attack so it blooms behind the dry pulse
      const dk = spaceDuck.gain;
      dk.cancelScheduledValues(t);
      if (P.duckDepth > 0.001) {
        dk.setTargetAtTime(1 - P.duckDepth, t, 0.012);
        dk.setTargetAtTime(1, t + 0.03, 0.07);
      } else {
        dk.setTargetAtTime(1, t, 0.02);
      }
    };

    E.chaosTo = (value, t, tc) => chaosCV.offset.setTargetAtTime(value, t, Math.max(0.005, tc));

    E.releaseAll = t => {
      for (const v of E.voices) {
        for (const p of [v.vca.gain, v.nEnv.gain]) {
          p.cancelScheduledValues(t);
          p.setTargetAtTime(0, t, 0.06);
        }
        v.vcf.detune.cancelScheduledValues(t);
        v.vcf.detune.setTargetAtTime(0, t, 0.1);
        v.busyUntil = 0;
      }
      spaceDuck.gain.cancelScheduledValues(t);
      spaceDuck.gain.setTargetAtTime(1, t, 0.05);
    };

    E.applyAll = () => { for (const k of Object.keys(E.apply)) E.apply[k](); };

    E.dispose = () => {
      for (const s of sources) { try { s.stop(); } catch (_) { /* already stopped */ } }
      try { out.disconnect(); } catch (_) { /* ignore */ }
    };

    const t0 = now();
    for (const s of sources) s.start(t0);
    E.applyAll();
    E.init = false;
    return E;
  }

  // ===========================================================================
  // Sequencer: decides when pulses happen and what they are (seeded, look-ahead)
  // ===========================================================================
  function createSequencer(E, P) {
    const S = { seed: 1, rand: Math.random, nextEvent: 0, nextChaos: 0, tempoScale: 1, history: [], onEvent: null };

    S.reset = (t, seed) => {
      S.seed = seed >>> 0;
      S.rand = rng(S.seed);
      S.nextEvent = t;
      S.nextChaos = t;
      S.tempoScale = 1;
      S.history.length = 0;
    };
    S.reseed = seed => {
      S.seed = seed >>> 0;
      S.rand = rng(S.seed);
      S.history.length = 0;
    };

    function chaosStep(t) {
      const r = S.rand() * 2 - 1;
      S.tempoScale = 1 + r * 0.8 * P.chaosDepth;
      const period = 1 / Math.max(0.01, P.chaosRate);
      E.chaosTo(r, t, period * 0.35);
      S.nextChaos = t + period;
    }

    function allocate(t) {
      const n = clamp(P.voices, 1, MAX_VOICES);
      let best = -1, bestT = Infinity;
      for (let i = 0; i < n; i++) {
        const b = E.voices[i].busyUntil;
        if (b <= t && b < bestT) { best = i; bestT = b; }
      }
      if (best >= 0) return best;
      let oldest = Infinity;
      for (let i = 0; i < n; i++) {
        if (E.voices[i].startedAt < oldest) { oldest = E.voices[i].startedAt; best = i; }
      }
      return best;
    }

    function eventStep(t) {
      const rnd = P.randomness;
      const H = S.history;
      // Memory: replay the step from `loopLen` steps ago (Turing-machine style loop lock)
      let step;
      if (H.length >= P.loopLen && S.rand() < P.memory) step = H[H.length - P.loopLen];
      else step = { u: S.rand(), gate: S.rand(), acc: S.rand(), pan: S.rand(), jit: S.rand(), env: S.rand() };
      H.push(step);
      if (H.length > 64) H.splice(0, H.length - 64);

      const base = 1 / Math.max(0.01, P.eventHz);
      const jitter = (step.jit - 0.5) * rnd * 0.35;
      S.nextEvent = t + Math.max(0.02, (base * (1 + jitter)) / clamp(S.tempoScale, 0.4, 2));
      const drift = (S.rand() - 0.5) * 2 * rnd * 8; // ± cents of analog drift
      if (step.gate >= P.density) return; // rest

      let lo = P.pitchMin, hi = P.pitchMax;
      if (hi < lo) [lo, hi] = [hi, lo];
      const midi = quantize(lo + step.u * (hi - lo), P.root, P.scale);

      const e1 = step.env, e2 = (step.env * 7.31) % 1, e3 = (step.env * 13.7) % 1;
      const atk = Math.max(0.002, (P.attackMs / 1000) * (1 + (e1 - 0.5) * 0.6 * rnd));
      const hold = Math.max(0.01, (P.pulseWidth / 1000) * (1 + (e2 - 0.5) * 0.4 * rnd));
      const rel = Math.max(0.02, (P.releaseMs / 1000) * (1 + (e3 - 0.5) * 0.6 * rnd));
      const ev = {
        voice: allocate(t),
        midi,
        freq: midiToHz(midi) * Math.pow(2, drift / 1200),
        atk, hold, rel,
        peak: 1 - rnd * 0.4 * step.acc,
        pan: (step.pan * 2 - 1) * P.panSpread,
        glide: P.glideMs / 1000,
      };
      E.trigger(t, ev);
      if (S.onEvent) S.onEvent(t, ev);
    }

    // Schedule everything up to `until`, interleaving chaos steps and pulses in time order
    S.advance = until => {
      for (;;) {
        const t = Math.min(S.nextEvent, S.nextChaos);
        if (t >= until) break;
        if (S.nextChaos <= S.nextEvent) chaosStep(S.nextChaos);
        else eventStep(S.nextEvent);
      }
    };
    return S;
  }

  // ===========================================================================
  // Offline verification hook (used to check gain staging across presets)
  // ===========================================================================
  async function renderOffline(params, seconds = 20, seedValue = 12345, sr = 48000) {
    const P = Object.assign({}, DEFAULTS, params);
    const oac = new OfflineAudioContext(4, Math.ceil(sr * seconds), sr);
    const eng = createEngine(oac, P, { connectOutput: false });
    const merger = oac.createChannelMerger(4);
    const sOut = oac.createChannelSplitter(2), sPre = oac.createChannelSplitter(2);
    eng.output.connect(sOut);
    eng.preLimiter.connect(sPre);
    sOut.connect(merger, 0, 0); sOut.connect(merger, 1, 1);
    sPre.connect(merger, 0, 2); sPre.connect(merger, 1, 3);
    merger.connect(oac.destination);
    const sq = createSequencer(eng, P);
    sq.reset(0.05, seedValue);
    sq.advance(seconds - 0.25);
    const buf = await oac.startRendering();
    const stat = ch => {
      const d = buf.getChannelData(ch);
      let pk = 0, ss = 0, over = 0;
      for (let i = 0; i < d.length; i++) {
        const a = Math.abs(d[i]);
        if (a > pk) pk = a;
        if (a >= 1) over++;
        ss += d[i] * d[i];
      }
      return { peak: pk, rms: Math.sqrt(ss / d.length), over };
    };
    const L = stat(0), R = stat(1), pL = stat(2), pR = stat(3);
    const db = x => (x > 0 ? 20 * Math.log10(x) : -Infinity);
    return {
      outPeakDb: db(Math.max(L.peak, R.peak)),
      outRmsDb: db(Math.max(L.rms, R.rms)),
      prePeakDb: db(Math.max(pL.peak, pR.peak)),
      overs: L.over + R.over,
    };
  }
  window.KrellLab = { renderOffline, FACTORY, DEFAULTS, PARAMS };

  // ===========================================================================
  // App state
  // ===========================================================================
  const state = { ...DEFAULTS };
  const CTRL = {};
  let current = { kind: 'f', name: FACTORY[0].name };
  let dirty = false;
  let seed = newSeed();

  let ac = null, engine = null, seq = null;
  let running = false, schedTimer = null, suspendTimer = null;
  let analyser = null, anL = null, anR = null, timeBuf = null, freqBuf = null, mBufL = null, mBufR = null;
  let recDest = null, recorder = null, recChunks = [], recStartedAt = 0;
  const eventQueue = [];
  let lastEv = [];

  function lsGet(k, fallback) {
    try { const s = localStorage.getItem(k); return s ? JSON.parse(s) : fallback; } catch (_) { return fallback; }
  }
  function lsSet(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* storage unavailable */ }
  }

  let toastTimer = null;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
  }

  // ===========================================================================
  // Parameter changes
  // ===========================================================================
  let irDebounce = null;
  function applyArea(key) {
    if (!engine || !key) return;
    if (key === 'spaceIR') {
      clearTimeout(irDebounce);
      irDebounce = setTimeout(() => engine && engine.apply.spaceIR(), 140);
    } else {
      engine.apply[key]();
    }
  }

  function setParam(id, value, opt = {}) {
    const p = PMAP[id];
    const v = normalizeValue(p, value);
    if (state[id] === v) return;
    state[id] = v;
    if (CTRL[id]) CTRL[id].update();
    applyArea(p.apply);
    if (id === 'voices') updateLedAvailability();
    if (!opt.silent) { markDirty(); saveSessionSoon(); }
  }

  function loadValues(values) {
    for (const p of PARAMS) {
      state[p.id] = normalizeValue(p, values && values[p.id] !== undefined ? values[p.id] : p.def);
      if (CTRL[p.id]) CTRL[p.id].update();
    }
    if (engine) {
      for (const key of new Set(PARAMS.map(p => p.apply).filter(Boolean))) applyArea(key);
    }
    updateLedAvailability();
  }

  function loadPatch(values, meta, patchSeed) {
    loadValues(values);
    if (Number.isFinite(patchSeed)) setSeed(patchSeed);
    current = meta;
    dirty = false;
    refreshPresetUI();
    saveSessionSoon();
  }

  function markDirty() {
    if (dirty) return;
    dirty = true;
    refreshDirty();
  }

  let saveTimer = null;
  function saveSessionSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => lsSet(LS_SESSION, { params: state, preset: current, dirty, seed }), 400);
  }

  function setSeed(s) {
    seed = s >>> 0;
    $('#seedOut').textContent = seedHex(seed);
    if (seq) seq.reseed(seed);
  }

  // ===========================================================================
  // Presets
  // ===========================================================================
  const userPresets = () => lsGet(LS_USER, []).filter(p => p && typeof p.name === 'string' && p.params);
  const keyOf = c => `${c.kind}:${c.name}`;

  function refreshPresetUI() {
    const sel = $('#presetSel');
    sel.innerHTML = '';
    const users = userPresets();
    const known = (current.kind === 'f' && FACTORY.some(f => f.name === current.name))
      || (current.kind === 'u' && users.some(u => u.name === current.name));
    if (!known) {
      const o = new Option(current.name || 'Untitled', keyOf({ kind: 'c', name: current.name }));
      sel.add(o);
      current = { kind: 'c', name: current.name || 'Untitled' };
    }
    for (const cat of PRESET_CATS) {
      const g = document.createElement('optgroup');
      g.label = cat;
      FACTORY.filter(f => f.cat === cat).forEach(f => g.appendChild(new Option(f.name, `f:${f.name}`)));
      sel.add(g);
    }
    if (users.length) {
      const gU = document.createElement('optgroup');
      gU.label = 'User';
      users.forEach(u => gU.appendChild(new Option(u.name, `u:${u.name}`)));
      sel.add(gU);
    }
    sel.value = keyOf(current);
    const f = current.kind === 'f' ? FACTORY.find(x => x.name === current.name) : null;
    sel.title = f ? f.desc : current.name;
    $('#deleteBtn').disabled = current.kind !== 'u';
    refreshDirty();
  }

  function refreshDirty() {
    $('#dirtyTag').hidden = !dirty;
  }

  function loadPresetKey(key) {
    const kind = key[0], name = key.slice(2);
    if (kind === 'f') {
      const f = FACTORY.find(x => x.name === name);
      if (f) { loadPatch(f.params, { kind: 'f', name }); toast(`${f.name} — ${f.desc}`); }
    } else if (kind === 'u') {
      const u = userPresets().find(x => x.name === name);
      if (u) { loadPatch(u.params, { kind: 'u', name }, u.seed); toast(`Loaded ${name}`); }
    }
  }

  function stepPreset(dir) {
    const keys = [...FACTORY.map(f => `f:${f.name}`), ...userPresets().map(u => `u:${u.name}`)];
    let i = keys.indexOf(keyOf(current));
    i = i < 0 ? 0 : (i + dir + keys.length) % keys.length;
    loadPresetKey(keys[i]);
  }

  function savePreset(name) {
    name = name.trim().slice(0, 40);
    if (!name) return;
    const list = userPresets().filter(u => u.name !== name);
    list.push({ name, params: { ...state }, seed });
    list.sort((a, b) => a.name.localeCompare(b.name));
    lsSet(LS_USER, list);
    current = { kind: 'u', name };
    dirty = false;
    refreshPresetUI();
    saveSessionSoon();
    toast(`Saved “${name}”`);
  }

  function deletePreset() {
    if (current.kind !== 'u') return;
    if (!confirm(`Delete preset “${current.name}”?`)) return;
    lsSet(LS_USER, userPresets().filter(u => u.name !== current.name));
    toast(`Deleted “${current.name}”`);
    current = { kind: 'c', name: `${current.name} (unsaved)` };
    refreshPresetUI();
    saveSessionSoon();
  }

  function gauss() {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  function fixPitchRange(vals) {
    if (vals.pitchMax < vals.pitchMin + 7) vals.pitchMax = Math.min(108, vals.pitchMin + 7 + Math.round(Math.random() * 20));
  }

  function mutate() {
    const vals = { ...state };
    for (const p of PARAMS) {
      if (!p.rnd || p.type === 'choice') continue;
      vals[p.id] = fromNorm(p, toNorm(p, state[p.id]) + gauss() * 0.06);
    }
    fixPitchRange(vals);
    loadValues(vals);
    markDirty();
    saveSessionSoon();
    toast('Mutated');
  }

  function randomize() {
    const vals = { ...state };
    for (const p of PARAMS) {
      if (!p.rnd) continue;
      if (p.type === 'choice') vals[p.id] = p.options[Math.floor(Math.random() * p.options.length)].v;
      else vals[p.id] = fromNorm(p, p.rnd[0] + Math.random() * (p.rnd[1] - p.rnd[0]));
    }
    fixPitchRange(vals);
    loadPatch(vals, { kind: 'c', name: 'Random patch' });
    toast('New random patch');
  }

  const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'patch';

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function exportPatch() {
    const data = { format: 'krell-patch', version: 2, name: current.name, seed, params: { ...state } };
    download(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), `${slug(current.name)}.krell.json`);
  }

  async function importFile(file) {
    try {
      const data = JSON.parse(await file.text());
      const items = Array.isArray(data) ? data : Array.isArray(data.presets) ? data.presets : [data];
      const valid = items.filter(x => x && typeof x.params === 'object');
      if (!valid.length) throw new Error('no patches');
      const list = userPresets();
      for (const it of valid) {
        const name = String(it.name || file.name.replace(/\.(krell\.)?json$/i, '') || 'Imported').slice(0, 40);
        const clean = {};
        for (const p of PARAMS) if (it.params[p.id] !== undefined) clean[p.id] = normalizeValue(p, it.params[p.id]);
        const idx = list.findIndex(u => u.name === name);
        const entry = { name, params: clean, seed: Number.isFinite(it.seed) ? it.seed : undefined };
        if (idx >= 0) list[idx] = entry; else list.push(entry);
      }
      list.sort((a, b) => a.name.localeCompare(b.name));
      lsSet(LS_USER, list);
      const first = valid[0];
      const name = String(first.name || file.name.replace(/\.(krell\.)?json$/i, '') || 'Imported').slice(0, 40);
      loadPatch(first.params, { kind: 'u', name }, first.seed);
      toast(valid.length > 1 ? `Imported ${valid.length} presets` : `Imported “${name}”`);
    } catch (_) {
      toast('That file is not a Krell patch');
    }
  }

  const b64e = s => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const b64d = s => decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/'))));

  async function sharePatch() {
    const diff = {};
    for (const p of PARAMS) {
      const v = state[p.id];
      if (v !== p.def) diff[p.id] = typeof v === 'number' && !p.int ? +v.toPrecision(5) : v;
    }
    const url = `${location.origin}${location.pathname}${location.search}#patch=${b64e(JSON.stringify({ n: current.name, s: seed, p: diff }))}`;
    try {
      await navigator.clipboard.writeText(url);
      toast('Patch link copied');
    } catch (_) {
      prompt('Copy this patch link:', url);
    }
  }

  function readHashPatch() {
    const m = /#patch=([\w-]+)/.exec(location.hash);
    if (!m) return null;
    try {
      const d = JSON.parse(b64d(m[1]));
      return { name: d.n, seed: d.s, params: d.p || {} };
    } catch (_) {
      return null;
    }
  }

  // ===========================================================================
  // Audio lifecycle / transport
  // ===========================================================================
  function ensureAudio() {
    if (ac) return true;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { toast('Web Audio is not supported in this browser'); return false; }
    try {
      ac = new AC({ latencyHint: 'balanced' });
      engine = createEngine(ac, state);
    } catch (err) {
      console.error(err);
      toast('Could not start the audio engine');
      ac = null; engine = null;
      return false;
    }
    seq = createSequencer(engine, state);
    seq.onEvent = (t, ev) => eventQueue.push({ t, ev });

    analyser = ac.createAnalyser();
    analyser.fftSize = 4096;
    analyser.smoothingTimeConstant = 0.8;
    timeBuf = new Float32Array(analyser.fftSize);
    freqBuf = new Float32Array(analyser.frequencyBinCount);
    engine.output.connect(analyser);

    const split = ac.createChannelSplitter(2);
    anL = ac.createAnalyser(); anR = ac.createAnalyser();
    anL.fftSize = anR.fftSize = 1024;
    mBufL = new Float32Array(1024); mBufR = new Float32Array(1024);
    engine.output.connect(split);
    split.connect(anL, 0);
    split.connect(anR, 1);
    return true;
  }

  function schedTick() {
    if (!running || !ac) return;
    // Hidden tabs throttle timers to ~1 Hz, so look further ahead there.
    seq.advance(ac.currentTime + (document.hidden ? 1.6 : 0.12));
  }

  async function start() {
    if (!ensureAudio()) return;
    clearTimeout(suspendTimer);
    if (ac.state !== 'running') {
      try { await ac.resume(); } catch (_) { /* ignore */ }
    }
    engine.apply.master();
    seq.reset(ac.currentTime + 0.06, seed);
    running = true;
    clearInterval(schedTimer);
    schedTimer = setInterval(schedTick, 25);
    schedTick();
    updateTransport();
  }

  function stop() {
    if (!running) return;
    running = false;
    clearInterval(schedTimer);
    schedTimer = null;
    if (engine) engine.releaseAll(ac.currentTime);
    eventQueue.length = 0;
    lastEv = [];
    updateTransport();
    // Let delay/reverb tails ring out, then suspend to save CPU.
    clearTimeout(suspendTimer);
    suspendTimer = setTimeout(() => {
      if (!running && !recorder && ac) ac.suspend().catch(() => {});
    }, 8000 + state.spaceSize * 1000);
  }

  function toggle() { if (running) stop(); else start(); }

  function updateTransport() {
    const b = $('#playBtn');
    b.classList.toggle('on', running);
    b.setAttribute('aria-pressed', String(running));
    $('.play-txt', b).textContent = running ? 'Stop' : 'Start';
    if (!running) {
      $('#hudNote').textContent = '—';
      $('#hudSub').textContent = 'Press Start or hit Space';
    }
  }

  // ---- Recording
  function pickMime() {
    if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
    return ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'].find(t => MediaRecorder.isTypeSupported(t)) || '';
  }

  async function startRec() {
    if (!ensureAudio()) return;
    if (!recDest) {
      recDest = ac.createMediaStreamDestination();
      engine.output.connect(recDest);
    }
    const mimeType = pickMime();
    try {
      recorder = new MediaRecorder(recDest.stream, mimeType ? { mimeType, audioBitsPerSecond: 256000 } : undefined);
    } catch (_) {
      recorder = null;
      toast('Recording is not supported here');
      return;
    }
    recChunks = [];
    recorder.ondataavailable = e => { if (e.data && e.data.size) recChunks.push(e.data); };
    recorder.onstop = () => {
      const type = recorder.mimeType || mimeType || 'audio/webm';
      const ext = /ogg/.test(type) ? 'ogg' : /mp4/.test(type) ? 'm4a' : 'webm';
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      download(new Blob(recChunks, { type }), `krell-${slug(current.name)}-${stamp}.${ext}`);
      recorder = null;
      updateRec();
      toast('Recording saved');
    };
    recorder.start(1000);
    recStartedAt = performance.now();
    if (!running) await start();
    updateRec();
  }

  function stopRec() {
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  }

  function updateRec() {
    const b = $('#recBtn');
    const on = !!recorder;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
    if (!on) $('.rec-txt', b).textContent = 'Rec';
  }

  // ===========================================================================
  // UI: controls
  // ===========================================================================
  const el = (tag, cls, html) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  };

  function polar(cx, cy, r, deg) {
    const a = (deg * Math.PI) / 180;
    return [cx + r * Math.sin(a), cy - r * Math.cos(a)];
  }
  function arcPath(cx, cy, r, a0, a1) {
    const [x0, y0] = polar(cx, cy, r, a0), [x1, y1] = polar(cx, cy, r, a1);
    return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
  }

  function parseValue(p, raw) {
    const s = raw.trim().toLowerCase().replace(',', '.');
    if (p.fmt === 'note') { const m = parseNote(s); if (m !== null) return m; }
    let x = parseFloat(s.replace(/[^\d.+-]/g, ''));
    if (!Number.isFinite(x)) return null;
    if (p.fmt === 'hz' && /k/.test(s)) x *= 1000;
    if (p.fmt === 'ms' && /(^|[^m])s\s*$/.test(s)) x *= 1000;
    if (p.fmt === 's' && /ms\s*$/.test(s)) x /= 1000;
    if (p.fmt === 'pct') x /= 100;
    return x;
  }

  function buildKnob(p) {
    const wrap = el('div', 'ctl');
    const K = 30, R = 24;
    wrap.innerHTML = `
      <div class="knob" role="slider" tabindex="0" aria-label="${p.label}"
           aria-valuemin="${p.min}" aria-valuemax="${p.max}">
        <svg viewBox="0 0 60 60" aria-hidden="true">
          <path class="k-track" d="${arcPath(K, K, R, -135, 135)}"/>
          <path class="k-val" d=""/>
          <circle class="k-cap" cx="${K}" cy="${K}" r="17"/>
          <g class="k-ptr-g"><line class="k-ptr" x1="${K}" y1="${K - 7}" x2="${K}" y2="${K - 14}"/></g>
        </svg>
      </div>
      <div class="ctl-label">${p.label}</div>
      <button class="ctl-val" type="button" title="Click to type a value"></button>`;
    const knob = $('.knob', wrap), valPath = $('.k-val', wrap), ptr = $('.k-ptr-g', wrap), valBtn = $('.ctl-val', wrap);

    const update = () => {
      const v = state[p.id], n = clamp(toNorm(p, v), 0, 1), ang = -135 + 270 * n;
      valPath.setAttribute('d', n > 0.004 ? arcPath(K, K, R, -135, ang) : '');
      ptr.setAttribute('transform', `rotate(${ang.toFixed(2)} ${K} ${K})`);
      const txt = fmtParam(p, v);
      valBtn.textContent = txt;
      knob.setAttribute('aria-valuenow', String(+(+v).toFixed(4)));
      knob.setAttribute('aria-valuetext', txt);
    };

    const nudge = dn => {
      if (p.int) setParam(p.id, state[p.id] + Math.sign(dn) * Math.max(1, Math.round(Math.abs(dn) * (p.max - p.min))));
      else setParam(p.id, fromNorm(p, toNorm(p, state[p.id]) + dn));
    };

    let drag = null;
    knob.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault();
      knob.focus({ preventScroll: true });
      knob.setPointerCapture(e.pointerId);
      drag = { x: e.clientX, y: e.clientY, n: toNorm(p, state[p.id]) };
      knob.classList.add('active');
    });
    knob.addEventListener('pointermove', e => {
      if (!drag) return;
      const dy = drag.y - e.clientY, dx = e.clientX - drag.x;
      drag.x = e.clientX; drag.y = e.clientY;
      drag.n = clamp(drag.n + (dy + dx * 0.5) * (e.shiftKey ? 1 / 1400 : 1 / 220), 0, 1);
      setParam(p.id, fromNorm(p, drag.n));
    });
    const end = () => { drag = null; knob.classList.remove('active'); };
    knob.addEventListener('pointerup', end);
    knob.addEventListener('pointercancel', end);
    knob.addEventListener('lostpointercapture', end);
    knob.addEventListener('dblclick', () => setParam(p.id, p.def));
    knob.addEventListener('wheel', e => {
      if (document.activeElement !== knob) return; // don't hijack page scrolling
      e.preventDefault();
      nudge((e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? 0.004 : 0.02));
    }, { passive: false });
    knob.addEventListener('keydown', e => {
      const fine = e.shiftKey ? 0.002 : 0.01;
      const map = { ArrowUp: fine, ArrowRight: fine, ArrowDown: -fine, ArrowLeft: -fine, PageUp: 0.1, PageDown: -0.1 };
      if (e.key in map) { e.preventDefault(); nudge(map[e.key]); }
      else if (e.key === 'Home') { e.preventDefault(); setParam(p.id, p.min); }
      else if (e.key === 'End') { e.preventDefault(); setParam(p.id, p.max); }
      else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); setParam(p.id, p.def); }
    });

    valBtn.addEventListener('click', () => {
      const input = el('input', 'ctl-edit');
      input.value = fmtParam(p, state[p.id]).replace(/[−∞]/g, '');
      input.setAttribute('aria-label', `${p.label} value`);
      valBtn.replaceWith(input);
      input.focus();
      input.select();
      let done = false;
      const finish = commit => {
        if (done) return;
        done = true;
        if (commit) {
          const v = parseValue(p, input.value);
          if (v !== null) setParam(p.id, v);
        }
        input.replaceWith(valBtn);
        update();
      };
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); finish(true); knob.focus(); }
        else if (e.key === 'Escape') { e.preventDefault(); finish(false); knob.focus(); }
      });
      input.addEventListener('blur', () => finish(true));
    });

    CTRL[p.id] = { update };
    update();
    return wrap;
  }

  function buildChoice(p) {
    const wrap = el('div', 'choice');
    const id = `ch-${p.id}`;
    wrap.appendChild(el('label', 'choice-label', p.label)).setAttribute(p.options.length > 4 ? 'for' : 'id', id);
    let update;
    if (p.options.length <= 4) {
      const seg = el('div', 'seg');
      seg.setAttribute('role', 'group');
      seg.setAttribute('aria-labelledby', id);
      const btns = p.options.map(o => {
        const b = el('button', '', o.label);
        b.type = 'button';
        b.addEventListener('click', () => setParam(p.id, o.v));
        seg.appendChild(b);
        return b;
      });
      update = () => p.options.forEach((o, i) => btns[i].setAttribute('aria-pressed', String(o.v === state[p.id])));
      wrap.appendChild(seg);
    } else {
      const sel = el('select', 'select');
      sel.id = id;
      p.options.forEach(o => sel.add(new Option(o.label, String(o.v))));
      sel.addEventListener('change', () => setParam(p.id, sel.value));
      update = () => { sel.value = String(state[p.id]); };
      wrap.appendChild(sel);
    }
    CTRL[p.id] = { update };
    update();
    return wrap;
  }

  const buildControl = p => (p.type === 'choice' ? buildChoice(p) : buildKnob(p));

  function buildModules() {
    const host = $('#modules');
    for (const m of MODULES) {
      const sec = el('section', 'module');
      sec.style.setProperty('--h', m.hue);
      sec.setAttribute('aria-label', m.title);
      sec.appendChild(el('header', 'mod-head', `<h2>${m.title}</h2><span>${m.tag}</span>`));
      const knobs = el('div', 'mod-knobs'), choices = el('div', 'mod-choices');
      for (const p of PARAMS.filter(x => x.mod === m.id)) (p.type === 'choice' ? choices : knobs).appendChild(buildControl(p));
      sec.appendChild(knobs);
      if (choices.children.length) sec.appendChild(choices);
      host.appendChild(sec);
    }
    $('#masterSlot').appendChild(buildControl(PMAP.masterDb));
  }

  // ===========================================================================
  // UI: display (scope / spectrum / meters / HUD)
  // ===========================================================================
  const canvas = $('#scope');
  const c2d = canvas.getContext('2d');
  let view = 'scope', dpr = 1, idleDrawn = false;
  const leds = () => $$('#voiceLeds i');

  function resizeCanvas() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    const r = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(r.width * dpr));
    canvas.height = Math.max(1, Math.round(r.height * dpr));
    idleDrawn = false;
  }

  const css = getComputedStyle(document.documentElement);
  const COL = {
    accent: css.getPropertyValue('--accent').trim() || '#46eec4',
    accent2: css.getPropertyValue('--accent-2').trim() || '#8f7bff',
    grid: 'rgba(148,178,222,0.075)',
    ceil: 'rgba(255,79,109,0.28)',
  };

  function drawGrid(W, H) {
    c2d.clearRect(0, 0, W, H);
    c2d.strokeStyle = COL.grid;
    c2d.lineWidth = 1;
    c2d.beginPath();
    for (let i = 1; i < 10; i++) { const x = Math.round((W * i) / 10) + 0.5; c2d.moveTo(x, 0); c2d.lineTo(x, H); }
    for (let i = 1; i < 4; i++) { const y = Math.round((H * i) / 4) + 0.5; c2d.moveTo(0, y); c2d.lineTo(W, y); }
    c2d.stroke();
  }

  function strokeGlow(width) {
    const g = c2d.createLinearGradient(0, 0, c2d.canvas.width, 0);
    g.addColorStop(0, COL.accent);
    g.addColorStop(1, COL.accent2);
    c2d.strokeStyle = g;
    c2d.globalAlpha = 0.18;
    c2d.lineWidth = width * 4;
    c2d.stroke();
    c2d.globalAlpha = 1;
    c2d.lineWidth = width;
    c2d.stroke();
  }

  function drawIdle() {
    const W = canvas.width, H = canvas.height;
    drawGrid(W, H);
    c2d.beginPath();
    c2d.moveTo(0, H / 2);
    c2d.lineTo(W, H / 2);
    strokeGlow(1.5 * dpr);
  }

  function drawScope() {
    const W = canvas.width, H = canvas.height;
    analyser.getFloatTimeDomainData(timeBuf);
    const N = timeBuf.length, span = N >> 1;
    let s0 = 0;
    for (let i = 1; i < N - span; i++) { if (timeBuf[i - 1] <= 0 && timeBuf[i] > 0) { s0 = i; break; } }
    drawGrid(W, H);
    const amp = H * 0.46;
    c2d.setLineDash([4 * dpr, 6 * dpr]);
    c2d.strokeStyle = COL.ceil;
    c2d.lineWidth = 1;
    c2d.beginPath();
    c2d.moveTo(0, H / 2 - CEILING * amp); c2d.lineTo(W, H / 2 - CEILING * amp);
    c2d.moveTo(0, H / 2 + CEILING * amp); c2d.lineTo(W, H / 2 + CEILING * amp);
    c2d.stroke();
    c2d.setLineDash([]);
    c2d.beginPath();
    const step = W / (span - 1);
    for (let i = 0; i < span; i++) {
      const y = H / 2 - timeBuf[s0 + i] * amp;
      if (i === 0) c2d.moveTo(0, y); else c2d.lineTo(i * step, y);
    }
    strokeGlow(1.6 * dpr);
  }

  function drawSpectrum() {
    const W = canvas.width, H = canvas.height;
    analyser.getFloatFrequencyData(freqBuf);
    drawGrid(W, H);
    const bins = freqBuf.length, nyq = ac.sampleRate / 2, fMin = 25, fMax = Math.min(20000, nyq);
    const lr = Math.log(fMax / fMin), dbMin = -110, dbMax = -15;
    c2d.beginPath();
    c2d.moveTo(0, H);
    const cols = Math.max(64, Math.floor(W / (2 * dpr)));
    for (let x = 0; x <= cols; x++) {
      const f = fMin * Math.exp((x / cols) * lr);
      const db = freqBuf[clamp(Math.round((f / nyq) * bins), 0, bins - 1)];
      const y = H - clamp((db - dbMin) / (dbMax - dbMin), 0, 1) * H * 0.92;
      c2d.lineTo((x / cols) * W, y);
    }
    c2d.lineTo(W, H);
    c2d.closePath();
    const g = c2d.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, 'rgba(70,238,196,0.35)');
    g.addColorStop(1, 'rgba(143,123,255,0.02)');
    c2d.fillStyle = g;
    c2d.fill();
    strokeGlow(1.4 * dpr);
  }

  function envAt(e, t) {
    const dt = t - e.t;
    if (dt < 0) return 0;
    const a = Math.max(0.0007, e.atk / 3);
    if (dt < e.atk + e.hold) return e.peak * (1 - Math.exp(-dt / a));
    const top = e.peak * (1 - Math.exp(-(e.atk + e.hold) / a));
    const fl = state.droneFloor;
    return fl + (top - fl) * Math.exp(-(dt - e.atk - e.hold) / Math.max(0.004, e.rel / 4));
  }

  function updateLedAvailability() {
    leds().forEach((l, i) => l.classList.toggle('off', i >= state.voices));
  }

  // meters
  const M = {
    L: { lvl: -120, hold: -120, ht: 0 }, R: { lvl: -120, hold: -120, ht: 0 },
    gr: 0, clipUntil: 0, limitUntil: 0, last: performance.now(),
  };
  const meterPos = db => clamp((db + 48) / 48, 0, 1);
  function peakOf(buf) {
    let m = 0;
    for (let i = 0; i < buf.length; i++) { const a = buf[i] < 0 ? -buf[i] : buf[i]; if (a > m) m = a; }
    return m;
  }
  function setMeter(id, m) {
    const node = document.getElementById(id);
    $('.m-fill', node).style.transform = `scaleY(${meterPos(m.lvl).toFixed(3)})`;
    $('.m-peak', node).style.bottom = `${(meterPos(m.hold) * 100).toFixed(1)}%`;
    $('.m-peak', node).style.opacity = m.hold > -47 ? 1 : 0;
  }
  function updateMeters(nowMs) {
    const dt = Math.min(0.1, (nowMs - M.last) / 1000);
    M.last = nowMs;
    let maxPk = 0;
    for (const [key, an, buf] of [['L', anL, mBufL], ['R', anR, mBufR]]) {
      let pk = 0;
      if (an) { an.getFloatTimeDomainData(buf); pk = peakOf(buf); }
      maxPk = Math.max(maxPk, pk);
      const m = M[key], db = pk > 1e-6 ? 20 * Math.log10(pk) : -120;
      m.lvl = Math.max(db, m.lvl - dt * 26);
      if (db >= m.hold) { m.hold = db; m.ht = nowMs; } else if (nowMs - m.ht > 1200) m.hold -= dt * 14;
      setMeter(`meter${key}`, m);
    }
    const red = engine ? engine.limiter.reduction : 0;
    const gr = typeof red === 'number' ? red : (red && red.value) || 0;
    M.gr = Math.min(gr, M.gr + dt * 30);
    $('#meterGR .m-fill').style.transform = `scaleY(${clamp(-M.gr / 12, 0, 1).toFixed(3)})`;
    if (gr < -0.5) M.limitUntil = nowMs + 250;
    if (maxPk >= 0.999) M.clipUntil = nowMs + 2000;
    $('#limitLed').classList.toggle('lit', nowMs < M.limitUntil);
    $('#clipLed').classList.toggle('lit', nowMs < M.clipUntil);
  }
  function resetMeters() {
    M.L.lvl = M.L.hold = M.R.lvl = M.R.hold = -120;
    M.gr = 0;
    setMeter('meterL', M.L);
    setMeter('meterR', M.R);
    $('#meterGR .m-fill').style.transform = 'scaleY(0)';
    $('#limitLed').classList.remove('lit');
    $('#clipLed').classList.remove('lit');
    leds().forEach(l => l.style.setProperty('--v', 0));
    $('#screenGlow').style.opacity = 0;
  }

  function frame(ts) {
    requestAnimationFrame(frame);
    const live = ac && ac.state === 'running';
    if (recorder) {
      const s = Math.floor((performance.now() - recStartedAt) / 1000);
      $('#recBtn .rec-txt').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    }
    if (!live) {
      if (!idleDrawn) { drawIdle(); resetMeters(); idleDrawn = true; }
      return;
    }
    idleDrawn = false;
    const t = ac.currentTime;
    let shown = null;
    while (eventQueue.length && eventQueue[0].t <= t) {
      const q = eventQueue.shift();
      lastEv[q.ev.voice] = { t: q.t, ...q.ev };
      shown = q.ev;
    }
    if (shown) {
      $('#hudNote').textContent = noteName(shown.midi);
      $('#hudSub').textContent = `${FMT.hz(shown.freq)} · ${state.voices > 1 ? `voice ${shown.voice + 1}` : 'mono'}`;
    }
    let pulse = 0;
    leds().forEach((l, i) => {
      const v = lastEv[i] ? envAt(lastEv[i], t) : 0;
      l.style.setProperty('--v', v.toFixed(3));
      pulse = Math.max(pulse, v);
    });
    $('#screenGlow').style.opacity = (pulse * 0.85).toFixed(3);
    if (view === 'scope') drawScope(); else drawSpectrum();
    updateMeters(ts || performance.now());
  }

  // ===========================================================================
  // Wiring
  // ===========================================================================
  function wire() {
    $('#playBtn').addEventListener('click', toggle);
    $('#recBtn').addEventListener('click', () => (recorder ? stopRec() : startRec()));
    if (!window.MediaRecorder) $('#recBtn').hidden = true;
    $('#reseedBtn').addEventListener('click', () => { setSeed(newSeed()); saveSessionSoon(); toast(`Seed ${seedHex(seed)}`); });

    $('#presetSel').addEventListener('change', e => loadPresetKey(e.target.value));
    $('#prevPreset').addEventListener('click', () => stepPreset(-1));
    $('#nextPreset').addEventListener('click', () => stepPreset(1));
    $('#mutateBtn').addEventListener('click', mutate);
    $('#randomBtn').addEventListener('click', randomize);
    $('#exportBtn').addEventListener('click', exportPatch);
    $('#shareBtn').addEventListener('click', sharePatch);
    $('#deleteBtn').addEventListener('click', deletePreset);
    $('#importBtn').addEventListener('click', () => $('#importFile').click());
    $('#importFile').addEventListener('change', e => {
      const f = e.target.files && e.target.files[0];
      if (f) importFile(f);
      e.target.value = '';
    });

    const dlg = $('#saveDlg');
    $('#saveBtn').addEventListener('click', () => {
      const input = $('#saveName');
      input.value = current.kind === 'u' ? current.name : current.kind === 'f' ? `${current.name} variation` : '';
      if (typeof dlg.showModal === 'function') { dlg.showModal(); input.select(); }
      else { const n = prompt('Preset name', input.value); if (n) savePreset(n); }
    });
    dlg.addEventListener('close', () => { if (dlg.returnValue === 'save') savePreset($('#saveName').value); });

    $$('.view-toggle button').forEach(b => b.addEventListener('click', () => {
      view = b.dataset.view;
      $$('.view-toggle button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
      idleDrawn = false;
    }));

    document.addEventListener('keydown', e => {
      if (e.code !== 'Space' || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.target.closest('input, select, textarea, button, dialog, [contenteditable]')) return;
      e.preventDefault();
      toggle();
    });

    if ('ResizeObserver' in window) new ResizeObserver(resizeCanvas).observe(canvas);
    else window.addEventListener('resize', resizeCanvas);
    resizeCanvas();
  }

  function init() {
    buildModules();
    wire();
    const shared = readHashPatch();
    const session = lsGet(LS_SESSION, null);
    if (shared) {
      loadPatch(shared.params, { kind: 'c', name: shared.name || 'Shared patch' }, shared.seed);
      history.replaceState(null, '', location.pathname + location.search);
      toast('Loaded shared patch');
    } else if (session && session.params) {
      loadPatch(session.params, session.preset || { kind: 'c', name: 'Last session' }, session.seed);
      if (session.dirty) markDirty();
    } else {
      loadPatch(FACTORY[0].params, { kind: 'f', name: FACTORY[0].name });
    }
    $('#seedOut').textContent = seedHex(seed);
    updateTransport();
    updateRec();
    requestAnimationFrame(frame);
  }

  init();
})();
