/**
 * Voice modulator stage: the character effects that pitch-shift + EQ alone cannot make
 * (ring modulation, vibrato/chorus, tremolo, bit-crush, echo).
 *
 * Shared by the studio (audio-engine.js) and the audience guest mic (audience.html).
 * Presets opt in with these optional fields (all default to 0 = off):
 *   ringHz, ringMix            ring modulator frequency (Hz) and wet amount 0..1   (robotic / Dalek)
 *   vibHz, vibDepth, vibMix    vibrato LFO rate (Hz), depth (seconds, ~0.001-0.006), wet 0..1 (underwater / ghost)
 *   tremHz, tremDepth          tremolo rate (Hz) and depth 0..1                    (nervous / trembling)
 *   crushSteps, crushMix       quantiser levels (e.g. 32 = ~5 bit) and wet 0..1     (retro / telephone)
 *   echoMs, echoFb, echoMix    echo time (ms), feedback 0..0.7, wet 0..1            (cave / demon / ghost)
 *
 * With every effect off the stage is bypassed with plain connects (no node in the signal path),
 * so ordinary presets pay no CPU for it.
 */

export const MOD_FIELDS = ['ringHz', 'ringMix', 'vibHz', 'vibDepth', 'vibMix', 'tremHz', 'tremDepth',
  'crushSteps', 'crushMix', 'echoMs', 'echoFb', 'echoMix'];

export function hasModEffects(p) {
  return !!(p && ((p.ringMix || 0) > 0 || (p.vibMix || 0) > 0 || (p.tremDepth || 0) > 0 ||
    (p.crushMix || 0) > 0 || (p.echoMix || 0) > 0));
}

function makeCrushCurve(steps) {
  const n = 2048;
  const curve = new Float32Array(n);
  const s = Math.max(2, Math.round(steps));
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / (n - 1) - 1;
    curve[i] = Math.round(x * (s / 2)) / (s / 2);
  }
  return curve;
}

/** dry/wet crossfade helper: returns {input, output, dry, wet} where `wetPath` is wired by the caller. */
function makeMixStage(ctx) {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  dry.gain.value = 1;
  wet.gain.value = 0;
  input.connect(dry);
  dry.connect(output);
  wet.connect(output);
  return { input, output, dry, wet };
}

export function createVoiceModStage(ctx) {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const chainIn = ctx.createGain();
  const chainOut = ctx.createGain();

  // 1. Ring modulator: carrier gain whose gain AudioParam is driven by an oscillator (base 0 => true ring mod)
  const ring = makeMixStage(ctx);
  const ringCarrier = ctx.createGain();
  ringCarrier.gain.value = 0;
  const ringOsc = ctx.createOscillator();
  ringOsc.type = 'sine';
  ringOsc.frequency.value = 30;
  ringOsc.connect(ringCarrier.gain);
  ring.input.connect(ringCarrier);
  ringCarrier.connect(ring.wet);

  // 2. Vibrato / chorus: short delay modulated by an LFO
  const vib = makeMixStage(ctx);
  const vibDelay = ctx.createDelay(0.1);
  vibDelay.delayTime.value = 0.012;
  const vibLfo = ctx.createOscillator();
  vibLfo.type = 'sine';
  vibLfo.frequency.value = 5;
  const vibDepthGain = ctx.createGain();
  vibDepthGain.gain.value = 0;
  vibLfo.connect(vibDepthGain);
  vibDepthGain.connect(vibDelay.delayTime);
  vib.input.connect(vibDelay);
  vibDelay.connect(vib.wet);

  // 3. Tremolo: amplitude LFO
  const trem = ctx.createGain();
  trem.gain.value = 1;
  const tremLfo = ctx.createOscillator();
  tremLfo.type = 'sine';
  tremLfo.frequency.value = 6;
  const tremDepthGain = ctx.createGain();
  tremDepthGain.gain.value = 0;
  tremLfo.connect(tremDepthGain);
  tremDepthGain.connect(trem.gain);

  // 4. Bit-crush: quantising waveshaper
  const crush = makeMixStage(ctx);
  const crusher = ctx.createWaveShaper();
  crusher.curve = makeCrushCurve(32);
  crush.input.connect(crusher);
  crusher.connect(crush.wet);

  // 5. Echo with feedback
  const echo = makeMixStage(ctx);
  const echoDelay = ctx.createDelay(1.0);
  echoDelay.delayTime.value = 0.2;
  const echoFeedback = ctx.createGain();
  echoFeedback.gain.value = 0;
  const echoTone = ctx.createBiquadFilter();
  echoTone.type = 'lowpass';
  echoTone.frequency.value = 4500;
  echo.input.connect(echoDelay);
  echoDelay.connect(echoTone);
  echoTone.connect(echoFeedback);
  echoFeedback.connect(echoDelay);
  echoTone.connect(echo.wet);

  // serial chain: ring -> vibrato -> tremolo -> crush -> echo
  chainIn.connect(ring.input);
  ring.output.connect(vib.input);
  vib.output.connect(trem);
  trem.connect(crush.input);
  crush.output.connect(echo.input);
  echo.output.connect(chainOut);

  ringOsc.start();
  vibLfo.start();
  tremLfo.start();

  let engaged = false;
  const bypass = () => {
    if (engaged) {
      try { input.disconnect(chainIn); } catch (_) {}
      try { chainOut.disconnect(output); } catch (_) {}
      engaged = false;
    }
    try { input.disconnect(output); } catch (_) {}
    input.connect(output);
  };
  const engage = () => {
    if (!engaged) {
      try { input.disconnect(output); } catch (_) {}
      input.connect(chainIn);
      chainOut.connect(output);
      engaged = true;
    }
  };
  bypass();

  const smooth = (param, value, tc = 0.02) => {
    try { param.setTargetAtTime(value, ctx.currentTime, tc); } catch (_) { param.value = value; }
  };

  function apply(p = {}) {
    const ringMix = Math.max(0, Math.min(1, p.ringMix || 0));
    const vibMix = Math.max(0, Math.min(1, p.vibMix || 0));
    const tremDepth = Math.max(0, Math.min(1, p.tremDepth || 0));
    const crushMix = Math.max(0, Math.min(1, p.crushMix || 0));
    const echoMix = Math.max(0, Math.min(1, p.echoMix || 0));

    if (!hasModEffects(p)) {
      bypass();
      return false;
    }

    smooth(ringOsc.frequency, Math.max(1, p.ringHz || 30));
    smooth(ring.wet.gain, ringMix);
    smooth(ring.dry.gain, 1 - ringMix * 0.9);

    smooth(vibLfo.frequency, Math.max(0.1, p.vibHz || 5));
    smooth(vibDepthGain.gain, Math.max(0, p.vibDepth || 0));
    smooth(vib.wet.gain, vibMix);
    smooth(vib.dry.gain, 1 - vibMix);

    smooth(tremLfo.frequency, Math.max(0.1, p.tremHz || 6));
    smooth(trem.gain, 1 - tremDepth / 2);
    smooth(tremDepthGain.gain, tremDepth / 2);

    if (p.crushSteps) crusher.curve = makeCrushCurve(p.crushSteps);
    smooth(crush.wet.gain, crushMix);
    smooth(crush.dry.gain, 1 - crushMix);

    smooth(echoDelay.delayTime, Math.max(0.01, Math.min(0.9, (p.echoMs || 200) / 1000)));
    smooth(echoFeedback.gain, Math.max(0, Math.min(0.7, p.echoFb || 0)));
    smooth(echo.wet.gain, echoMix);
    smooth(echo.dry.gain, 1);

    engage();
    return true;
  }

  function destroy() {
    try { ringOsc.stop(); vibLfo.stop(); tremLfo.stop(); } catch (_) {}
    try { input.disconnect(); output.disconnect(); } catch (_) {}
  }

  // `disconnect` lets generic cleanup loops (which call node.disconnect()) tear the stage down too.
  return { input, output, apply, destroy, disconnect: destroy, get engaged() { return engaged; } };
}
