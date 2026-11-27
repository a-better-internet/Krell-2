# Krell Patch Machine II

A generative "alien pulse" synthesizer that runs in the browser with Web Audio. It has no dependencies and no build step: open `index.html`, or serve the folder (`python3 -m http.server`).

## Signal path

```
per voice (×4):  sine + triangle + sub ─ VCA ─┐
                 noise ─ env ─ breath ────────┴─ low-pass ─ reso comp ─┐
                             └─ band-pass (Q-compensated) ─────────────┴─ pan ─┐
global:  voice bus ─ warp (dry | drive → shaper → wet) ─ DC block ─┬─ dry ───────────────┐
                                                                   ├─ ping-pong delay ───┼─ master ─ limiter ─ soft ceiling (−0.2 dBFS)
                                                                   └─ duck ─ convolver ──┘
```

- Warp drive only goes to the wet branch. Every waveshaper has a defined input range, so nothing is hard-clipped inside the graph.
- The filter envelope modulates `detune` (in cents), so moving the cutoff knob never cancels the envelope.
- The delay feedback loop is low-passed, high-passed and soft-saturated, so it can't run away.
- The output goes through a limiter, then a soft-knee clipper with an absolute ceiling of −0.2 dBFS.
- Pulses are scheduled ahead of time on the audio clock, so timing is sample-accurate. Envelopes are built from `setTargetAtTime` steps, so retriggers never click.

## Features

- 25 factory presets in four categories. User presets are saved in the browser. Patches can be imported/exported as JSON, and **Share** copies a link that recreates the current patch.
- **Mutate** nudges every parameter a little; **Random** rolls a new patch.
- 1–4 voices. Memory and Loop lock the random sequence into a repeating pattern. Density adds rests. Root key and 14 scales, including microtonal just-intonation overtone tuning.
- Drone floor, sub oscillator, detune, filter key tracking, LFO shapes and LFO→filter, chaos→filter, three warp modes, delay tone and stereo width, reverb size and brightness, duck depth, pan spread.
- A seeded RNG: the same seed and patch always give the same sequence.
- Scope and spectrum views, peak meters, limiter gain-reduction meter, and Limit/Clip indicators.
- Record the output to a lossless 24-bit stereo WAV file (up to 30 minutes).

## Controls

`Space` starts and stops. Drag a knob to change it (`Shift` for fine control). Double-click a knob to reset it. Click a value to type one in, e.g. `2.5k` or `A3`. Focus a knob, then scroll or use the arrow keys.

## Verifying gain staging

`window.KrellLab.renderOffline(params, seconds, seed)` renders the engine offline. It returns the output peak, the pre-limiter peak, RMS, and a count of samples at or above full scale.
