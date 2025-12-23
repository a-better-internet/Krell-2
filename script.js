// Krell Patch Machine — Pulsing Alien (Gentle Stereo + Ducking)
// Verbose long-form JS: each control explicitly wired, no condensed apply loops.
// Features:
// - Attack/Hold/Release pulse envelope (Pulse Width)
// - Chaos modulates event tempo ("breathing" feel)
// - Noise breath (LP) + bandpass noise branch (BP)
// - Waveshaper warp (drive + wet/dry)
// - Delay, simple stereo space reverb, oscilloscope
// - POLISH: gentle random panning per pulse (StereoPannerNode)
// - POLISH: reverb ducking after each pulse attack (reverb blooms behind the dry pulse)
// Safe gain staging; CodePen-friendly (no external libs/assets)

(() => {
  'use strict';

  // ---------- DOM ----------
  const $ = s => document.querySelector(s);

  // Transport
  const startBtn = $('#startBtn');
  const stopBtn = $('#stopBtn');
  const reseedBtn = $('#reseedBtn');
  const statusDot = $('#statusDot');

  // Controls (explicit handles)
  const ctl_masterGain = $('#masterGain');
  const ctl_eventHz = $('#eventHz');
  const ctl_randomness = $('#randomness');
  const ctl_glideMs = $('#glideMs');
  const ctl_attackMs = $('#attackMs');
  const ctl_pulseWidth = $('#pulseWidth');
  const ctl_releaseMs = $('#releaseMs');
  const ctl_pitchMin = $('#pitchMin');
  const ctl_pitchMax = $('#pitchMax');
  const ctl_lfoRate = $('#lfoRate');
  const ctl_lfoDepth = $('#lfoDepth');
  const ctl_cutoffHz = $('#cutoffHz');
  const ctl_filterQ = $('#filterQ');
  const ctl_envToFilter = $('#envToFilter');
  const ctl_delayTime = $('#delayTime');
  const ctl_delayFb = $('#delayFb');
  const ctl_delayMix = $('#delayMix');
  const ctl_blend = $('#blend');
  const ctl_scaleSel = $('#scaleSel');
  const ctl_noiseMix = $('#noiseMix');
  const ctl_noiseBandMix = $('#noiseBandMix');
  const ctl_noiseBandHz = $('#noiseBandHz');
  const ctl_noiseBandQ = $('#noiseBandQ');
  const ctl_alienWarp = $('#alienWarp');
  const ctl_chaosRate = $('#chaosRate');
  const ctl_chaosDepth = $('#chaosDepth');
  const ctl_spaceMix = $('#spaceMix');

  // Mirror outputs (explicit)
  function bindOutput(input) {
    if (!input) return;
    const out = input.parentElement.querySelector('output');
    if (!out) return;
    const update = () => { out.value = input.value; };
    input.addEventListener('input', update);
    update();
  }
  [
    ctl_masterGain, ctl_eventHz, ctl_randomness, ctl_glideMs,
    ctl_attackMs, ctl_pulseWidth, ctl_releaseMs,
    ctl_pitchMin, ctl_pitchMax, ctl_lfoRate, ctl_lfoDepth,
    ctl_cutoffHz, ctl_filterQ, ctl_envToFilter,
    ctl_delayTime, ctl_delayFb, ctl_delayMix, ctl_blend,
    ctl_noiseMix, ctl_noiseBandMix, ctl_noiseBandHz, ctl_noiseBandQ,
    ctl_alienWarp, ctl_chaosRate, ctl_chaosDepth, ctl_spaceMix
  ].forEach(bindOutput);

  // ---------- Audio Graph ----------
  let ctx = null, master = null, analyser = null, scopeData = null, scopeRAF = null;

  // Voice/FX nodes
  let envGain = null;
  let oscA = null, oscB = null, blendA = null, blendB = null;
  let lfo = null, lfoGain = null;

  let vcf = null;

  let noiseSrc = null, noiseEnv = null, noiseLowSend = null;
  let noiseBP = null, noiseBandSend = null;

  let preDrive = null, shaper = null, warpWet = null, warpDry = null;

  let delay = null, delayFb = null, dry = null, wet = null;

  let spaceSend = null, spaceDuck = null, spaceIn = null, spaceL = null, spaceR = null;

  // Stereo panner for gentle random panning per event
  let panner = null;

  // Engine state
  let engineOn = false, engineTimer = null;
  let chaosTimer = null, chaosTempoScale = 1.0;

  // RNG (deterministic re-seedable)
  let rngSeed = Math.floor(Math.random() * 2**31);
  function rng(seed){let t=seed>>>0;return()=>{t+=0x6D2B79F5;let r=Math.imul(t^(t>>>15),1|t);r^=r+Math.imul(r^(r>>>7),61|r);return((r^(r>>>14))>>>0)/4294967296};}
  let rand = rng(rngSeed);

  // Utils
  const now = () => ctx ? ctx.currentTime : 0;
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  const midiToHz = m => 440 * Math.pow(2, (m - 69) / 12);

  const SCALES = {
    pent_minor:[0,3,5,7,10], pent_major:[0,2,4,7,9],
    aeolian:[0,2,3,5,7,8,10], dorian:[0,2,3,5,7,9,10],
    chromatic:[0,1,2,3,4,5,6,7,8,9,10,11], whole:[0,2,4,6,8,10]
  };
  function quantizeMidi(midi, scaleName){
    const base = Math.floor(midi/12)*12;
    const degs = SCALES[scaleName] || SCALES.pent_minor;
    const within = midi - base;
    let best = degs[0], bd = 1e9;
    for (const d of degs){ const dist = Math.abs(within - d); if (dist < bd){ best=d; bd=dist; } }
    return base + best;
  }

  function makeTanhCurve(n){
    const c = new Float32Array(n), k = 2.5;
    for (let i=0;i<n;i++){ const x = (i/(n-1))*2 - 1; c[i] = Math.tanh(k*x); }
    return c;
  }

  function makeAllpass(ctx, delayTime, gain){
    const input = ctx.createGain(), output = ctx.createGain();
    const d = ctx.createDelay(1.0), g = ctx.createGain();
    d.delayTime.value = delayTime; g.gain.value = gain;
    input.connect(d); input.connect(g);
    d.connect(output); d.connect(g);
    g.connect(output);
    return { input, output };
  }

  function rampParam(param, value, timeSec){
    if (!ctx) return;
    const t = now();
    try{
      param.cancelScheduledValues(t);
      param.setValueAtTime(param.value, t);
      param.linearRampToValueAtTime(value, t + Math.max(0, timeSec));
    }catch(e){
      try{ param.value = value; }catch(_){}
    }
  }

  function buildGraph(){
    ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint:'interactive' });

    // Master & analyser
    master = ctx.createGain();
    master.gain.value = parseFloat(ctl_masterGain.value);
    master.connect(ctx.destination);

    analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    scopeData = new Uint8Array(analyser.fftSize);
    master.connect(analyser);

    // ----- Voice
    envGain = ctx.createGain();
    envGain.gain.value = 0;

    oscA = ctx.createOscillator(); oscA.type = 'sine';
    oscB = ctx.createOscillator(); oscB.type = 'triangle';

    blendA = ctx.createGain(); blendB = ctx.createGain();
    blendA.gain.value = 1 - parseFloat(ctl_blend.value);
    blendB.gain.value = parseFloat(ctl_blend.value);

    oscA.connect(blendA); oscB.connect(blendB);
    blendA.connect(envGain); blendB.connect(envGain);

    // LFO vibrato
    lfo = ctx.createOscillator(); lfo.type = 'sine';
    lfo.frequency.value = parseFloat(ctl_lfoRate.value);
    lfoGain = ctx.createGain();
    lfoGain.gain.value = parseFloat(ctl_lfoDepth.value);
    lfo.connect(lfoGain);
    lfoGain.connect(oscA.detune);
    lfoGain.connect(oscB.detune);

    // Filter (lowpass)
    vcf = ctx.createBiquadFilter();
    vcf.type = 'lowpass';
    vcf.frequency.value = parseFloat(ctl_cutoffHz.value);
    vcf.Q.value = parseFloat(ctl_filterQ.value);

    // Noise
    noiseEnv = ctx.createGain(); noiseEnv.gain.value = 0;

    noiseSrc = ctx.createBufferSource();
    const nbuf = ctx.createBuffer(1, ctx.sampleRate*2, ctx.sampleRate);
    const ndata = nbuf.getChannelData(0);
    for (let i=0;i<ndata.length;i++) ndata[i] = Math.random()*2-1;
    noiseSrc.buffer = nbuf; noiseSrc.loop = true;

    noiseLowSend = ctx.createGain(); noiseLowSend.gain.value = parseFloat(ctl_noiseMix.value);

    noiseBP = ctx.createBiquadFilter(); noiseBP.type='bandpass';
    noiseBP.frequency.value = parseFloat(ctl_noiseBandHz.value);
    noiseBP.Q.value = parseFloat(ctl_noiseBandQ.value);
    noiseBandSend = ctx.createGain(); noiseBandSend.gain.value = parseFloat(ctl_noiseBandMix.value);

    noiseSrc.connect(noiseEnv);
    noiseEnv.connect(noiseLowSend); noiseLowSend.connect(vcf);
    noiseEnv.connect(noiseBP); noiseBP.connect(noiseBandSend);

    // Warp (drive + shaper) with wet/dry
    preDrive = ctx.createGain(); preDrive.gain.value = 1 + parseFloat(ctl_alienWarp.value)*11;
    shaper = ctx.createWaveShaper(); shaper.curve = makeTanhCurve(2048); shaper.oversample='2x';
    warpWet = ctx.createGain(); warpDry = ctx.createGain();
    warpWet.gain.value = parseFloat(ctl_alienWarp.value);
    warpDry.gain.value = 1 - parseFloat(ctl_alienWarp.value);

    // Sum before warp: main LP and bandpass branch
    const preSum = ctx.createGain();
    envGain.connect(vcf);
    vcf.connect(preSum);
    noiseBandSend.connect(preSum);

    preSum.connect(preDrive);
    preDrive.connect(warpDry);
    preDrive.connect(shaper);
    shaper.connect(warpWet);

    // Stereo panner (gentle random per-event)
    panner = ctx.createStereoPanner();
    // Default pan center
    panner.pan.value = 0;

    // Post-warp to panner
    const postWarp = ctx.createGain();
    warpDry.connect(postWarp);
    warpWet.connect(postWarp);
    postWarp.connect(panner);

    // Delay
    delay = ctx.createDelay(1.5);
    delay.delayTime.value = parseFloat(ctl_delayTime.value);
    delayFb = ctx.createGain();
    delayFb.gain.value = parseFloat(ctl_delayFb.value);

    dry = ctx.createGain(); wet = ctx.createGain();
    const mix = parseFloat(ctl_delayMix.value);
    dry.gain.value = 1 - mix; wet.gain.value = mix;

    // Reverb (simple FDN-ish) + ducking
    spaceSend = ctx.createGain(); spaceSend.gain.value = parseFloat(ctl_spaceMix.value);
    spaceDuck = ctx.createGain(); spaceDuck.gain.value = 1.0; // we’ll dip this per event
    spaceIn = ctx.createGain();
    spaceL = ctx.createGain(); spaceR = ctx.createGain();

    const ap1 = makeAllpass(ctx, 0.013, 0.7);
    const ap2 = makeAllpass(ctx, 0.017, 0.7);
    const d1 = ctx.createDelay(2.0), d2 = ctx.createDelay(2.0);
    d1.delayTime.value = 0.111; d2.delayTime.value = 0.149;
    const f1 = ctx.createGain(), f2 = ctx.createGain();
    f1.gain.value = 0.72; f2.gain.value = 0.70;
    const x1 = ctx.createGain(), x2 = ctx.createGain();
    x1.gain.value = 0.15; x2.gain.value = 0.15;

    // Wire reverb network
    spaceIn.connect(ap1.input);
    ap1.output.connect(ap2.input);
    ap2.output.connect(d1);
    ap2.output.connect(d2);
    d1.connect(f1); f1.connect(d1);
    d2.connect(f2); f2.connect(d2);
    d1.connect(x1); x1.connect(d2);
    d2.connect(x2); x2.connect(d1);
    d1.connect(spaceL); d2.connect(spaceR);

    // Post-warp splits
    panner.connect(dry);
    panner.connect(delay);
    delay.connect(delayFb);
    delayFb.connect(delay);
    delay.connect(wet);

    // Reverb send with ducking
    panner.connect(spaceSend);
    spaceSend.connect(spaceDuck);
    spaceDuck.connect(spaceIn);

    // Master outs
    dry.connect(master);
    wet.connect(master);
    spaceL.connect(master);
    spaceR.connect(master);

    // Start oscillators & noise
    oscA.start(); oscB.start(); lfo.start(); noiseSrc.start();

    // Scope
    startScope();

    // Initial explicit param application
    applyMasterGain();
    applyLFO();
    applyFilter();
    applyNoiseParams();
    applyWarp();
    applyDelayParams();
    applyDelayMix();
    applySpaceMix();
    applyBlend();
  }

  function teardownGraph(){
    stopScope();
    stopChaos();
    engineOff();
    if (!ctx) return;
    try{ lfo.stop(); }catch(_){}
    try{ oscA.stop(); }catch(_){}
    try{ oscB.stop(); }catch(_){}
    try{ noiseSrc.stop(); }catch(_){}
    const c = ctx; ctx = null;
    c.close();
  }

  // ---------- Explicit Param Application (one function per control area) ----------
  function applyMasterGain(){
    if (!master || !ctx) return;
    const t = now();
    const val = parseFloat(ctl_masterGain.value);
    master.gain.cancelScheduledValues(t);
    master.gain.setTargetAtTime(val, t, 0.03);
  }

  function applyLFO(){
    if (!ctx) return;
    const t = now();
    if (lfo){
      const rate = parseFloat(ctl_lfoRate.value);
      lfo.frequency.cancelScheduledValues(t);
      lfo.frequency.setTargetAtTime(rate, t, 0.05);
    }
    if (lfoGain){
      const depth = parseFloat(ctl_lfoDepth.value);
      lfoGain.gain.cancelScheduledValues(t);
      lfoGain.gain.setTargetAtTime(depth, t, 0.05);
    }
  }

  function applyFilter(){
    if (!vcf || !ctx) return;
    const t = now();
    const cutoff = parseFloat(ctl_cutoffHz.value);
    const q = parseFloat(ctl_filterQ.value);
    vcf.frequency.cancelScheduledValues(t);
    vcf.frequency.setTargetAtTime(cutoff, t, 0.03);
    vcf.Q.cancelScheduledValues(t);
    vcf.Q.setTargetAtTime(q, t, 0.03);
  }

  function applyNoiseParams(){
    if (!ctx) return;
    const t = now();
    if (noiseLowSend){
      const nmix = parseFloat(ctl_noiseMix.value);
      noiseLowSend.gain.cancelScheduledValues(t);
      noiseLowSend.gain.setTargetAtTime(nmix, t, 0.05);
    }
    if (noiseBP){
      const nHz = parseFloat(ctl_noiseBandHz.value);
      const nQ = parseFloat(ctl_noiseBandQ.value);
      noiseBP.frequency.cancelScheduledValues(t);
      noiseBP.frequency.setTargetAtTime(nHz, t, 0.03);
      noiseBP.Q.cancelScheduledValues(t);
      noiseBP.Q.setTargetAtTime(nQ, t, 0.03);
    }
    if (noiseBandSend){
      const nbmix = parseFloat(ctl_noiseBandMix.value);
      noiseBandSend.gain.cancelScheduledValues(t);
      noiseBandSend.gain.setTargetAtTime(nbmix, t, 0.05);
    }
  }

  function applyWarp(){
    if (!preDrive || !warpWet || !warpDry || !ctx) return;
    const t = now();
    const x = parseFloat(ctl_alienWarp.value); // 0..1
    const drive = 1 + x * 11;
    const wet = x;
    preDrive.gain.cancelScheduledValues(t);
    preDrive.gain.setTargetAtTime(drive, t, 0.05);
    warpWet.gain.cancelScheduledValues(t);
    warpWet.gain.setTargetAtTime(wet, t, 0.05);
    warpDry.gain.cancelScheduledValues(t);
    warpDry.gain.setTargetAtTime(1 - wet, t, 0.05);
  }

  function applyDelayParams(){
    if (!delay || !delayFb || !ctx) return;
    const t = now();
    const dT = parseFloat(ctl_delayTime.value);
    const fb = parseFloat(ctl_delayFb.value);
    try{
      delay.delayTime.cancelScheduledValues(t);
      delay.delayTime.setTargetAtTime(dT, t, 0.05);
    }catch(_){ delay.delayTime.value = dT; }
    delayFb.gain.cancelScheduledValues(t);
    delayFb.gain.setTargetAtTime(fb, t, 0.05);
  }

  function applyDelayMix(){
    if (!dry || !wet || !ctx) return;
    const t = now();
    const mix = parseFloat(ctl_delayMix.value);
    dry.gain.cancelScheduledValues(t);
    wet.gain.cancelScheduledValues(t);
    dry.gain.setTargetAtTime(1 - mix, t, 0.05);
    wet.gain.setTargetAtTime(mix, t, 0.05);
  }

  function applySpaceMix(){
    if (!spaceSend || !ctx) return;
    const t = now();
    const m = parseFloat(ctl_spaceMix.value);
    spaceSend.gain.cancelScheduledValues(t);
    spaceSend.gain.setTargetAtTime(m, t, 0.05);
  }

  function applyBlend(){
    if (!blendA || !blendB) return;
    const v = parseFloat(ctl_blend.value);
    blendA.gain.value = 1 - v;
    blendB.gain.value = v;
  }

  // ---------- Scope ----------
  function startScope(){
    const canvas = $('#scope');
    const c = canvas.getContext('2d');

    function draw(){
      if (!analyser) return;
      analyser.getByteTimeDomainData(scopeData);
      const W = canvas.width, H = canvas.height;
      c.clearRect(0,0,W,H);
      c.globalAlpha = 0.65;
      c.fillStyle = '#0b1220';
      c.fillRect(0,0,W,H);
      c.globalAlpha = 1;
      c.strokeStyle = '#5fd2ff';
      c.lineWidth = 2;
      c.beginPath();
      const slice = W / scopeData.length;
      for (let i=0;i<scopeData.length;i++){
        const v = scopeData[i]/128 - 1;
        const y = H * (0.5 - v * 0.45);
        const x = i * slice;
        if (i===0) c.moveTo(x,y); else c.lineTo(x,y);
      }
      c.stroke();
      scopeRAF = requestAnimationFrame(draw);
    }
    cancelAnimationFrame(scopeRAF);
    scopeRAF = requestAnimationFrame(draw);
  }
  function stopScope(){ if (scopeRAF) cancelAnimationFrame(scopeRAF); scopeRAF = null; }

  // ---------- Engine: Pulsing Events ----------
  function engineTick(){
    if (!engineOn || !ctx) return;

    const randAmt = parseFloat(ctl_randomness.value);
    const aMs = parseFloat(ctl_attackMs.value) * (0.7 + 0.6 * Math.random());
    const holdMs = parseFloat(ctl_pulseWidth.value) * (0.8 + 0.4 * Math.random());
    const rMs = parseFloat(ctl_releaseMs.value) * (0.7 + 0.6 * Math.random());
    const glide = parseFloat(ctl_glideMs.value) / 1000;

    // Pitch selection & quantize
    let lo = parseInt(ctl_pitchMin.value, 10);
    let hi = parseInt(ctl_pitchMax.value, 10);
    if (hi < lo) [lo,hi] = [hi,lo];
    let midi = lo + Math.floor(Math.random() * Math.max(1,(hi-lo+1)));
    midi = quantizeMidi(midi, ctl_scaleSel.value);
    const drift = Math.floor((Math.random()-0.5) * 2 * randAmt); // softer than earlier
    midi = clamp(midi + drift, 12, 108);
    const freq = midiToHz(midi);

    // Glide frequency on both oscillators
    if (oscA) rampParam(oscA.frequency, freq, glide);
    if (oscB) rampParam(oscB.frequency, freq, glide);

    const t0 = now();
    const atk = Math.max(0.001, aMs/1000);
    const hold = Math.max(0.01, holdMs/1000);
    const rel = Math.max(0.02, rMs/1000);

    // Main envelope (A→Hold→R) — tone
    if (envGain){
      const g = envGain.gain;
      try{
        g.cancelScheduledValues(t0);
        g.setValueAtTime(g.value, t0);
        g.linearRampToValueAtTime(1.0, t0 + atk);
        g.setValueAtTime(1.0, t0 + atk + hold);
        g.exponentialRampToValueAtTime(0.001, t0 + atk + hold + rel);
      }catch(_){
        g.linearRampToValueAtTime(1.0, t0 + atk);
        g.linearRampToValueAtTime(1.0, t0 + atk + hold);
        g.linearRampToValueAtTime(0.0, t0 + atk + hold + rel);
      }
    }

    // Noise envelope (shorter)
    if (noiseEnv){
      const g = noiseEnv.gain;
      try{
        g.cancelScheduledValues(t0);
        g.setValueAtTime(g.value, t0);
        g.linearRampToValueAtTime(1.0, t0 + atk*0.9);
        g.setValueAtTime(1.0, t0 + atk*0.9 + hold*0.85);
        g.exponentialRampToValueAtTime(0.001, t0 + atk*0.9 + hold*0.85 + rel*0.85);
      }catch(_){
        g.linearRampToValueAtTime(1.0, t0 + atk*0.9);
        g.linearRampToValueAtTime(1.0, t0 + atk*0.9 + hold*0.85);
        g.linearRampToValueAtTime(0.0, t0 + atk*0.9 + hold*0.85 + rel*0.85);
      }
    }

    // Env→Filter sweep (kept)
    if (vcf){
      const envAmt = parseFloat(ctl_envToFilter.value);
      const base = parseFloat(ctl_cutoffHz.value);
      const peak = clamp(base * (1 + envAmt * 3.0), 50, 14000);
      try{
        vcf.frequency.cancelScheduledValues(t0);
        vcf.frequency.setValueAtTime(base, t0);
        vcf.frequency.linearRampToValueAtTime(peak, t0 + atk);
        vcf.frequency.exponentialRampToValueAtTime(Math.max(50, base), t0 + atk + hold + rel);
      }catch(_){
        vcf.frequency.value = base;
      }
    }

    // Gentle random panning per event
    if (panner){
      // pan in [-0.35, 0.35] scaled by randomness so it breathes with chaos level
      const panAmt = 0.35 * (0.4 + 0.6 * Math.random());
      const sign = Math.random() < 0.5 ? -1 : 1;
      const targetPan = sign * panAmt;
      try{
        panner.pan.cancelScheduledValues(t0);
        panner.pan.setTargetAtTime(targetPan, t0, 0.15); // ease into position
      }catch(_){
        panner.pan.value = targetPan;
      }
    }

    // Reverb ducking: dip reverb send briefly on attack, then release
    if (spaceDuck){
      try{
        spaceDuck.gain.cancelScheduledValues(t0);
        spaceDuck.gain.setValueAtTime(0.35, t0);               // duck to ~-9 dB
        spaceDuck.gain.linearRampToValueAtTime(1.0, t0 + 0.22); // bloom back over ~220ms
      }catch(_){
        spaceDuck.gain.value = 0.35;
        setTimeout(()=>{ if (spaceDuck) spaceDuck.gain.value = 1.0; }, 220);
      }
    }

    // Next event interval (tempo breathing with chaos)
    const hz = Math.max(0.01, parseFloat(ctl_eventHz.value));
    const baseInterval = 1 / hz;
    const jitter = (Math.random() - 0.5) * parseFloat(ctl_randomness.value) * baseInterval * 0.35;
    const scaled = (baseInterval + jitter) / clamp(chaosTempoScale, 0.4, 2.0);
    const nextMs = Math.max(20, scaled * 1000);
    engineTimer = setTimeout(engineTick, nextMs);
  }

  // ---------- Chaos: tempo breathing ----------
  function startChaos(){
    stopChaos();
    const update = () => {
      const depth = parseFloat(ctl_chaosDepth.value);
      const r = Math.random()*2 - 1; // [-1,1]
      const maxSpan = 0.8;           // ±80% scaling range at depth=1
      chaosTempoScale = 1 + r * maxSpan * depth;
    };
    update();
    const rateHz = Math.max(0.01, parseFloat(ctl_chaosRate.value));
    const periodMs = Math.max(30, 1000 / rateHz);
    chaosTimer = setInterval(update, periodMs);
  }
  function stopChaos(){ if (chaosTimer) clearInterval(chaosTimer); chaosTimer = null; }

  // ---------- Transport ----------
  function engineOnFn(){ if (engineOn) return; engineOn = true; statusDot.classList.add('on'); engineTick(); }
  function engineOff(){
    engineOn = false; statusDot.classList.remove('on');
    if (engineTimer){ clearTimeout(engineTimer); engineTimer = null; }
    const t = now();
    if (envGain){ try{ envGain.gain.cancelScheduledValues(t); envGain.gain.setTargetAtTime(0.0001, t, 0.05); }catch(_){}} 
    if (noiseEnv){ try{ noiseEnv.gain.cancelScheduledValues(t); noiseEnv.gain.setTargetAtTime(0.0001, t, 0.05); }catch(_){}} 
  }

  // ---------- UI Wiring (explicit) ----------
  // Each control updates its exact target(s). No shared "apply all" loop.

  ctl_masterGain.addEventListener('input', applyMasterGain);

  ctl_lfoRate.addEventListener('input', applyLFO);
  ctl_lfoDepth.addEventListener('input', applyLFO);

  ctl_cutoffHz.addEventListener('input', applyFilter);
  ctl_filterQ.addEventListener('input', applyFilter);

  ctl_noiseMix.addEventListener('input', applyNoiseParams);
  ctl_noiseBandHz.addEventListener('input', applyNoiseParams);
  ctl_noiseBandQ.addEventListener('input', applyNoiseParams);
  ctl_noiseBandMix.addEventListener('input', applyNoiseParams);

  ctl_alienWarp.addEventListener('input', applyWarp);

  ctl_delayTime.addEventListener('input', applyDelayParams);
  ctl_delayFb.addEventListener('input', applyDelayParams);

  ctl_delayMix.addEventListener('input', applyDelayMix);

  ctl_spaceMix.addEventListener('input', applySpaceMix);

  ctl_blend.addEventListener('input', applyBlend);

  // Chaos
  ctl_chaosRate.addEventListener('input', () => { if (chaosTimer) startChaos(); });
  ctl_chaosDepth.addEventListener('input', () => { /* depth read at tick; nothing to set immediately */ });

  // Transport buttons
  startBtn.addEventListener('click', async () => {
    if (ctx && ctx.state === 'suspended'){ await ctx.resume(); engineOnFn(); startChaos(); return; }
    teardownGraph();
    buildGraph();
    engineOnFn();
    startChaos();
  });

  stopBtn.addEventListener('click', async () => {
    engineOff();
    stopChaos();
    if (ctx){
      const t = now();
      try{
        master.gain.cancelScheduledValues(t);
        master.gain.setTargetAtTime(0.0001, t, 0.05);
      }catch(_){}
      setTimeout(async ()=>{ if (ctx) await ctx.suspend(); }, 120);
    }
  });

  reseedBtn.addEventListener('click', () => {
    rngSeed = Math.floor(Math.random() * 2**31);
    rand = rng(rngSeed);
  });

  // Pause when hidden
  document.addEventListener('visibilitychange', () => {
    if (document.hidden){ engineOff(); stopChaos(); }
  });

  // ---------- Start scope later to avoid first-frame glitches ----------
  function startScope(){
    const canvas = $('#scope');
    const c = canvas.getContext('2d');
    function draw(){
      if (!analyser) return;
      analyser.getByteTimeDomainData(scopeData);
      const W = canvas.width, H = canvas.height;
      c.clearRect(0,0,W,H);
      c.globalAlpha = 0.65; c.fillStyle = '#0b1220'; c.fillRect(0,0,W,H); c.globalAlpha = 1;
      c.strokeStyle = '#5fd2ff'; c.lineWidth = 2; c.beginPath();
      const slice = W / scopeData.length;
      for (let i=0;i<scopeData.length;i++){
        const v = scopeData[i]/128 - 1;
        const y = H * (0.5 - v * 0.45);
        const x = i * slice;
        if (i===0) c.moveTo(x,y); else c.lineTo(x,y);
      }
      c.stroke();
      scopeRAF = requestAnimationFrame(draw);
    }
    cancelAnimationFrame(scopeRAF);
    scopeRAF = requestAnimationFrame(draw);
  }
})();