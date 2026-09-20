export const dspWorkletCode = `
class PolyphonicPitchShifter extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'pitch', defaultValue: 1.0, minValue: 0.5, maxValue: 2.0 }];
  }
  constructor() {
    super();
    this.bufferSize = 8192;
    this.bufL = new Float32Array(this.bufferSize);
    this.bufR = new Float32Array(this.bufferSize);
    this.writePos = 0;
    this.grainSize = 2048;
    this.halfGrain = this.grainSize / 2;
    this.phase0 = 0;
    this.phase1 = this.halfGrain;
    this.currentPitch = 1.0;

    // Pre-calculate Hann window table for smooth equal-power crossfading
    this.windowTable = new Float32Array(this.grainSize);
    for (let i = 0; i < this.grainSize; i++) {
      this.windowTable[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (this.grainSize - 1)));
    }
  }

  readSample(buffer, offset) {
    const cap = this.bufferSize;
    let readIndex = this.writePos - offset;
    while (readIndex < 0) readIndex += cap;
    readIndex %= cap;

    const i0 = Math.floor(readIndex);
    const i1 = (i0 + 1) % cap;
    const frac = readIndex - i0;

    return buffer[i0] * (1 - frac) + buffer[i1] * frac;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input.length || !output || !output.length) return true;

    const inL = input[0];
    const inR = input.length > 1 ? input[1] : inL;
    const outL = output[0];
    const outR = output.length > 1 ? output[1] : null;

    const targetPitch = parameters.pitch[parameters.pitch.length - 1];

    // Bypass check: pristine passthrough when unmodified
    if (Math.abs(targetPitch - 1.0) < 0.005 && Math.abs(this.currentPitch - 1.0) < 0.005) {
      outL.set(inL);
      if (outR) outR.set(inR);
      return true;
    }

    const grain = this.grainSize;
    const half = this.halfGrain;
    const smoothing = 0.002;

    for (let i = 0; i < inL.length; i++) {
      this.currentPitch += (targetPitch - this.currentPitch) * smoothing;
      const rateDiff = 1.0 - this.currentPitch;

      this.bufL[this.writePos] = inL[i];
      this.bufR[this.writePos] = inR[i];

      this.phase0 += rateDiff;
      this.phase1 += rateDiff;

      while (this.phase0 >= grain) this.phase0 -= grain;
      while (this.phase0 < 0) this.phase0 += grain;

      while (this.phase1 >= grain) this.phase1 -= grain;
      while (this.phase1 < 0) this.phase1 += grain;

      const w0 = this.windowTable[Math.floor(this.phase0)];
      const w1 = this.windowTable[Math.floor(this.phase1)];

      const s0L = this.readSample(this.bufL, this.phase0 + 256);
      const s1L = this.readSample(this.bufL, this.phase1 + 256);

      outL[i] = (s0L * w0) + (s1L * w1);

      if (outR) {
        const s0R = this.readSample(this.bufR, this.phase0 + 256);
        const s1R = this.readSample(this.bufR, this.phase1 + 256);
        outR[i] = (s0R * w0) + (s1R * w1);
      }

      this.writePos = (this.writePos + 1) % this.bufferSize;
    }

    return true;
  }
}
registerProcessor('polyphonic-shifter', PolyphonicPitchShifter);

class AutoTuneProXProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'speed', defaultValue: 20, minValue: 0, maxValue: 400 },
      { name: 'flex', defaultValue: 0, minValue: 0, maxValue: 100 },
      { name: 'humanize', defaultValue: 0, minValue: 0, maxValue: 100 },
      { name: 'mix', defaultValue: 1.0, minValue: 0, maxValue: 1.0 }
    ];
  }

  constructor() {
    super();
    this.bufferSize = 8192;
    this.analysisSize = 2048;
    this.windowLen = 1024;
    this.inBuffer = new Float32Array(this.analysisSize);
    this.inBufIdx = 0;
    this.hopCounter = 0;
    this.hopSize = 256;

    // Pitch Shifting Delay Line (Stereo capability)
    this.delayBufL = new Float32Array(this.bufferSize);
    this.delayBufR = new Float32Array(this.bufferSize);
    this.writePos = 0;
    this.windowSize = 512;
    this.halfWindow = 256;
    this.phase0 = 0;
    this.phase1 = 256;

    // Pre-calculate Hann window table
    this.hann = new Float32Array(this.windowSize);
    for (let i = 0; i < this.windowSize; i++) {
      this.hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (this.windowSize - 1)));
    }

    // Auto-Tune Pro X Parameters
    this.scale = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]; // Chromatic default
    this.root = 0; // C
    this.noteStates = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]; // 1: Active, 0: Remove, 2: Bypass
    this.inputType = 'altoTenor';
    this.tracking = 0.85;
    this.mode = 'modern'; // 'modern' | 'classic'
    this.detune = 0; // cents from A440 (-100 to +100)
    this.transpose = 0; // -24 to +24 semitones
    this.formant = true;
    this.throat = 1.0; // 0.80 to 1.40
    this.mix = 1.0;
    this.enabled = true;

    // Vibrato
    this.vibrato = false;
    this.vibShape = 'sine'; // sine, triangle, square, saw, random
    this.vibDepth = 0; // 0 to 100 cents
    this.vibRate = 5.5; // 0.1 to 10 Hz
    this.vibDelay = 0; // ms
    this.vibVariation = 0; // 0 to 100 %
    this.vibPhase = 0;
    this.lastLfoVal = 0;
    this.holdFrames = 0;

    // State Tracking
    this.detectedFreq = 0;
    this.targetFreq = 0;
    this.targetRatio = 1.0;
    this.smoothedRatio = 1.0;
    this.currentCents = 0;
    this.currentNoteIndex = 0;
    this.isVoiced = false;
    this.lastStablePitch = 220;
    this.driftPhase = 0;
    this.lastNoteMidi = -1;
    this.fadeFactor = 0.0;

    // Formant filter state (Biquad)
    this.fX1_L = 0; this.fX2_L = 0; this.fY1_L = 0; this.fY2_L = 0;
    this.fX1_R = 0; this.fX2_R = 0; this.fY1_R = 0; this.fY2_R = 0;
    this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0;

    // Telemetry throttle counter
    this.telemetrySamples = 0;

    this.noteNames = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

    this.port.onmessage = (e) => {
      const data = e.data;
      if (!data) return;
      if (data.scale !== undefined) this.scale = data.scale;
      if (data.root !== undefined) this.root = data.root;
      if (data.noteStates !== undefined) this.noteStates = data.noteStates;
      if (data.inputType !== undefined) this.inputType = data.inputType;
      if (data.tracking !== undefined) this.tracking = Math.max(0.1, Math.min(1.0, data.tracking));
      if (data.mode !== undefined) this.mode = data.mode;
      if (data.detune !== undefined) this.detune = data.detune;
      if (data.transpose !== undefined) this.transpose = data.transpose;
      if (data.formant !== undefined) this.formant = !!data.formant;
      if (data.throat !== undefined) this.throat = Math.max(0.75, Math.min(1.5, data.throat));
      if (data.mix !== undefined) this.mix = Math.max(0, Math.min(1, data.mix));
      if (data.enabled !== undefined) this.enabled = !!data.enabled;
      if (data.vibrato !== undefined) this.vibrato = !!data.vibrato;
      if (data.vibShape !== undefined) this.vibShape = data.vibShape;
      if (data.vibDepth !== undefined) this.vibDepth = data.vibDepth;
      if (data.vibRate !== undefined) this.vibRate = data.vibRate;
      if (data.vibDelay !== undefined) this.vibDelay = data.vibDelay;
      if (data.vibVariation !== undefined) this.vibVariation = data.vibVariation;
    };
  }

  // Get frequency search bounds based on Pro X input vocal range
  getPitchBounds() {
    const sr = sampleRate || 48000;
    switch (this.inputType) {
      case 'soprano':
        return { minLag: Math.floor(sr / 1150), maxLag: Math.ceil(sr / 200) };
      case 'lowMale':
        return { minLag: Math.floor(sr / 400), maxLag: Math.ceil(sr / 65) };
      case 'instrument':
        return { minLag: Math.floor(sr / 1400), maxLag: Math.ceil(sr / 50) };
      case 'bassInst':
        return { minLag: Math.floor(sr / 350), maxLag: Math.ceil(sr / 30) };
      case 'altoTenor':
      default:
        return { minLag: Math.floor(sr / 750), maxLag: Math.ceil(sr / 125) };
    }
  }

  // McLeod / Normalized Square Difference Function (NSDF) pitch estimation
  detectPitch(buf, writeIdx) {
    const sr = sampleRate || 48000;
    const len = this.analysisSize;
    const W = this.windowLen;
    const { minLag, maxLag } = this.getPitchBounds();

    // Check RMS energy
    let sumSquares = 0;
    for (let i = 0; i < W; i++) {
      const idx = (writeIdx - 1 - i + len) % len;
      const s = buf[idx];
      sumSquares += s * s;
    }
    const rms = Math.sqrt(sumSquares / W);
    if (rms < 0.005) {
      return { freq: 0, voiced: false, confidence: 0 };
    }

    let maxNsdf = -1;
    let bestLag = 0;
    let prevVal = 0;
    let prevDiff = 0;
    let inPositiveRegion = false;

    for (let tau = minLag; tau <= maxLag; tau++) {
      let r = 0;
      let m = 0;
      for (let i = 0; i < W; i += 2) {
        const i0 = (writeIdx - 1 - i + len) % len;
        const iTau = (writeIdx - 1 - (i + tau) + len) % len;
        const s0 = buf[i0];
        const sT = buf[iTau];
        r += s0 * sT;
        m += s0 * s0 + sT * sT;
      }
      const nsdf = m > 1e-6 ? (2 * r) / m : 0;

      if (nsdf > 0 && !inPositiveRegion) {
        inPositiveRegion = true;
      } else if (nsdf < 0 && inPositiveRegion) {
        inPositiveRegion = false;
      }

      // Find peak in positive region
      if (inPositiveRegion) {
        const diff = nsdf - prevVal;
        if (prevDiff > 0 && diff <= 0) {
          // Peak detected at tau - 1
          const peakLag = tau - 1;
          const peakVal = prevVal;
          if (peakVal > maxNsdf) {
            maxNsdf = peakVal;
            bestLag = peakLag;
            if (peakVal >= 0.85) break; // Strong fundamental found
          }
        }
        prevDiff = diff;
      }
      prevVal = nsdf;
    }

    const voicingThreshold = 0.42 * this.tracking;
    if (bestLag < minLag || maxNsdf < voicingThreshold) {
      return { freq: 0, voiced: false, confidence: maxNsdf };
    }

    // Parabolic interpolation around peak
    let r0 = 0, r1 = 0, r2 = 0;
    let m0 = 0, m1 = 0, m2 = 0;
    for (let i = 0; i < W; i += 2) {
      const i0 = (writeIdx - 1 - i + len) % len;
      const s0 = buf[i0];
      const sT0 = buf[(writeIdx - 1 - (i + bestLag - 1) + len) % len];
      const sT1 = buf[(writeIdx - 1 - (i + bestLag) + len) % len];
      const sT2 = buf[(writeIdx - 1 - (i + bestLag + 1) + len) % len];
      r0 += s0 * sT0; m0 += s0 * s0 + sT0 * sT0;
      r1 += s0 * sT1; m1 += s0 * s0 + sT1 * sT1;
      r2 += s0 * sT2; m2 += s0 * s0 + sT2 * sT2;
    }
    const val0 = m0 > 1e-6 ? (2 * r0) / m0 : 0;
    const val1 = m1 > 1e-6 ? (2 * r1) / m1 : 0;
    const val2 = m2 > 1e-6 ? (2 * r2) / m2 : 0;

    let delta = 0;
    const denom = val0 - 2 * val1 + val2;
    if (Math.abs(denom) > 1e-6) {
      delta = (val0 - val2) / (2 * denom);
      if (Math.abs(delta) > 1) delta = 0;
    }

    const fineLag = bestLag + delta;
    let freq = sr / fineLag;

    // Reject octave jitter if previous stable pitch is reliable
    if (this.lastStablePitch > 50 && freq > 0) {
      const ratio = freq / this.lastStablePitch;
      if (Math.abs(ratio - 2.0) < 0.08 || Math.abs(ratio - 0.5) < 0.08) {
        // Octave jump check: keep continuity
        if (maxNsdf < 0.75) {
          freq = this.lastStablePitch;
        }
      }
    }
    this.lastStablePitch = freq;

    return { freq, voiced: true, confidence: maxNsdf };
  }

  // Antares Pro X Pitch Quantization Engine
  quantizePitch(f0, flexTune, humanize) {
    if (f0 < 30 || f0 > 2400) {
      return { targetF: f0, cents: 0, noteIdx: 0, oct: 4, bypassed: false };
    }

    // Reference A4 frequency with Detune
    const refA4 = 440 * Math.pow(2, (this.detune || 0) / 1200);

    // Fractional semitone MIDI number
    const midi = 69 + 12 * Math.log2(f0 / refA4) + (this.transpose || 0);
    const roundMidi = Math.round(midi);
    const oct = Math.floor(roundMidi / 12) - 1;
    const pc = ((roundMidi % 12) + 12) % 12;

    // Check Note State Map
    // 0: Exclude/Remove, 1: Active/Snap, 2: Bypass
    const keyState = this.noteStates ? this.noteStates[pc] : 1;

    // If note is explicitly bypassed in Pro X keyboard strip:
    if (keyState === 2) {
      return { targetF: f0, cents: 0, noteIdx: pc, oct, bypassed: true };
    }

    // If key is active, target is closest semitone
    let targetMidi = roundMidi;
    let chosenPc = pc;

    if (keyState === 0) {
      // Find nearest active note in scale
      let bestDist = 999;
      let bestMidi = roundMidi;
      for (let offset = -11; offset <= 11; offset++) {
        const candidateMidi = roundMidi + offset;
        const candPc = ((candidateMidi % 12) + 12) % 12;
        if (this.noteStates && this.noteStates[candPc] === 1) {
          const dist = Math.abs(midi - candidateMidi);
          if (dist < bestDist) {
            bestDist = dist;
            bestMidi = candidateMidi;
            chosenPc = candPc;
          }
        }
      }
      targetMidi = bestMidi;
    }

    // Exact frequency of target note
    const nominalTargetF = refA4 * Math.pow(2, (targetMidi - 69) / 12);
    const centsDiff = 1200 * Math.log2(f0 / nominalTargetF);

    let effectiveTargetF = nominalTargetF;

    // Pro X Flex-Tune: preserves natural vocal scoops and bends
    if (flexTune > 0) {
      const absCents = Math.min(50, Math.abs(centsDiff));
      const pullStrength = Math.max(0, 1.0 - (flexTune / 100) * Math.pow(absCents / 50, 1.25));
      effectiveTargetF = f0 * Math.pow(2, (-centsDiff * pullStrength) / 1200);
    }

    // Pro X Humanize: organic micro-drift on sustained notes
    if (humanize > 0 && this.holdFrames > 12) {
      this.driftPhase += 0.04;
      const drift = Math.sin(this.driftPhase) * 0.003 * (humanize / 100);
      effectiveTargetF *= (1.0 + drift);
    }

    // Pro X Vibrato Engine
    if (this.vibrato && this.vibDepth > 0) {
      const sr = sampleRate || 48000;
      const delayFrames = (this.vibDelay / 1000) * (sr / this.hopSize);
      if (this.holdFrames >= delayFrames) {
        // Calculate LFO
        this.vibPhase += (this.vibRate * this.hopSize) / sr;
        if (this.vibPhase >= 1.0) {
          this.vibPhase -= 1.0;
          this.lastLfoVal = (Math.random() * 2 - 1);
        }

        let lfo = 0;
        switch (this.vibShape) {
          case 'triangle':
            lfo = 2 * Math.abs(2 * (this.vibPhase - Math.floor(this.vibPhase + 0.5))) - 1;
            break;
          case 'square':
            lfo = this.vibPhase < 0.5 ? 1 : -1;
            break;
          case 'saw':
            lfo = 2 * (this.vibPhase - Math.floor(this.vibPhase)) - 1;
            break;
          case 'random':
            lfo = this.lastLfoVal;
            break;
          case 'sine':
          default:
            lfo = Math.sin(2 * Math.PI * this.vibPhase);
            break;
        }

        const vibCents = this.vibDepth * lfo;
        effectiveTargetF *= Math.pow(2, vibCents / 1200);
      }
    }

    return {
      targetF: effectiveTargetF,
      cents: Math.round(centsDiff),
      noteIdx: chosenPc,
      oct,
      bypassed: false
    };
  }

  // Update Biquad Formant compensation filter coefficients
  updateFormantFilter(pitchRatio) {
    if (!this.formant && Math.abs(this.throat - 1.0) < 0.02) {
      this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0;
      return;
    }

    const sr = sampleRate || 48000;
    // Shift formant opposite to pitch ratio to preserve throat size,
    // and scale by 1 / throat to simulate physical vocal tract length!
    const throatMod = 1.0 / Math.max(0.75, Math.min(1.4, this.throat));
    const ratioMod = this.formant ? Math.pow(pitchRatio, -0.75) : 1.0;
    const centerFreq = Math.max(250, Math.min(6500, 1800 * throatMod * ratioMod));

    // Peaking EQ filter
    const Q = 1.4;
    const gainDb = (this.throat - 1.0) * 8.0;
    const A = Math.pow(10, gainDb / 40);
    const w0 = 2 * Math.PI * centerFreq / sr;
    const alpha = Math.sin(w0) / (2 * Q);
    const cosw0 = Math.cos(w0);

    const a0 = 1 + alpha / A;
    this.b0 = (1 + alpha * A) / a0;
    this.b1 = (-2 * cosw0) / a0;
    this.b2 = (1 - alpha * A) / a0;
    this.a1 = (-2 * cosw0) / a0;
    this.a2 = (1 - alpha / A) / a0;
  }

  // Read tap with cubic Hermite interpolation for pristine pitch shifting
  readTapHermite(buf, dist) {
    const cap = this.bufferSize;
    const safeDist = Number.isFinite(dist) ? Math.max(0, dist) : 0;
    const i1 = Math.floor(safeDist);
    const frac = safeDist - i1;

    const idx0 = (this.writePos - i1 + 1 + cap) % cap;
    const idx1 = (this.writePos - i1 + cap) % cap;
    const idx2 = (this.writePos - i1 - 1 + cap) % cap;
    const idx3 = (this.writePos - i1 - 2 + cap) % cap;

    const y0 = buf[idx0], y1 = buf[idx1], y2 = buf[idx2], y3 = buf[idx3];
    const c0 = y1;
    const c1 = 0.5 * (y2 - y0);
    const c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
    const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);

    return ((c3 * frac + c2) * frac + c1) * frac + c0;
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input.length || !output || !output.length) return true;

    const inL = input[0];
    const inR = input.length > 1 ? input[1] : inL;
    const outL = output[0];
    const outR = output.length > 1 ? output[1] : null;

    if (!this.enabled) {
      outL.set(inL);
      if (outR) outR.set(inR);
      return true;
    }

    const speedParam = (params.speed && Number.isFinite(params.speed[0])) ? params.speed[0] : 20;
    const flexParam = (params.flex && Number.isFinite(params.flex[0])) ? params.flex[0] : 0;
    const humanizeParam = (params.humanize && Number.isFinite(params.humanize[0])) ? params.humanize[0] : 0;
    const mixParam = (params.mix && Number.isFinite(params.mix[0])) ? params.mix[0] : this.mix;

    const sr = sampleRate || 48000;
    const grain = this.windowSize;

    // Slew rate coefficient based on Retune Speed (ms)
    let retuneAlpha = 1.0;
    if (this.mode === 'classic') {
      retuneAlpha = speedParam <= 4 ? 1.0 : (1.0 - Math.exp(-1.0 / (sr * (speedParam * 0.00075))));
    } else {
      retuneAlpha = speedParam <= 1 ? 1.0 : (1.0 - Math.exp(-1.0 / (sr * (speedParam * 0.001 + 0.0001))));
    }

    for (let i = 0; i < inL.length; i++) {
      const sL = inL[i];
      const sR = inR[i];

      // Buffer for pitch analysis
      this.inBuffer[this.inBufIdx] = sL;
      this.inBufIdx = (this.inBufIdx + 1) % this.analysisSize;

      this.hopCounter++;
      if (this.hopCounter >= this.hopSize) {
        this.hopCounter = 0;
        const analysis = this.detectPitch(this.inBuffer, this.inBufIdx);

        if (analysis.voiced && analysis.freq > 0) {
          this.isVoiced = true;
          this.detectedFreq = analysis.freq;
          const quant = this.quantizePitch(analysis.freq, flexParam, humanizeParam);
          this.targetFreq = quant.targetF;
          this.currentCents = quant.cents;
          this.currentNoteIndex = quant.noteIdx;

          if (this.lastNoteMidi === quant.noteIdx) {
            this.holdFrames++;
          } else {
            this.holdFrames = 0;
            this.lastNoteMidi = quant.noteIdx;
          }

          if (quant.bypassed) {
            this.targetRatio = 1.0;
          } else {
            const rawRatio = this.targetFreq / this.detectedFreq;
            this.targetRatio = Math.max(0.5, Math.min(2.0, rawRatio));
          }
        } else {
          this.isVoiced = false;
          this.targetRatio = 1.0;
          this.holdFrames = 0;
        }

        this.updateFormantFilter(this.smoothedRatio);
      }

      // Smooth pitch ratio towards target
      if (this.mode === 'classic' && speedParam <= 4) {
        this.smoothedRatio = this.targetRatio;
      } else {
        this.smoothedRatio += (this.targetRatio - this.smoothedRatio) * retuneAlpha;
      }

      // Check if pitch shift is needed (in-tune or unvoiced bypasses delay line)
      const needShift = this.isVoiced && Math.abs(this.smoothedRatio - 1.0) >= 0.003;
      const targetFade = needShift ? 1.0 : 0.0;
      this.fadeFactor += (targetFade - this.fadeFactor) * 0.05;

      let wetSampleL = sL;
      let wetSampleR = sR;

      if (this.fadeFactor > 0.001) {
        const shift = 1.0 - this.smoothedRatio;

        // Write into pitch delay buffer
        this.delayBufL[this.writePos] = sL;
        this.delayBufR[this.writePos] = sR;

        // Dual windowed phase pointer
        this.phase0 += shift;
        this.phase1 += shift;

        while (this.phase0 >= grain) this.phase0 -= grain;
        while (this.phase0 < 0) this.phase0 += grain;
        while (this.phase1 >= grain) this.phase1 -= grain;
        while (this.phase1 < 0) this.phase1 += grain;

        const w0 = this.hann[Math.floor(this.phase0)];
        const w1 = this.hann[Math.floor(this.phase1)];

        const s0L = this.readTapHermite(this.delayBufL, this.phase0);
        const s1L = this.readTapHermite(this.delayBufL, this.phase1);
        let shiftedL = (s0L * w0) + (s1L * w1);

        let shiftedR = shiftedL;
        if (outR) {
          const s0R = this.readTapHermite(this.delayBufR, this.phase0);
          const s1R = this.readTapHermite(this.delayBufR, this.phase1);
          shiftedR = (s0R * w0) + (s1R * w1);
        }

        // Apply Formant & Throat filter on the shifted signal
        if (this.formant || Math.abs(this.throat - 1.0) >= 0.02) {
          const yL = this.b0 * shiftedL + this.b1 * this.fX1_L + this.b2 * this.fX2_L - this.a1 * this.fY1_L - this.a2 * this.fY2_L;
          this.fX2_L = this.fX1_L; this.fX1_L = shiftedL; this.fY2_L = this.fY1_L; this.fY1_L = yL;
          shiftedL = Number.isFinite(yL) ? yL : shiftedL;

          if (outR) {
            const yR = this.b0 * shiftedR + this.b1 * this.fX1_R + this.b2 * this.fX2_R - this.a1 * this.fY1_R - this.a2 * this.fY2_R;
            this.fX2_R = this.fX1_R; this.fX1_R = shiftedR; this.fY2_R = this.fY1_R; this.fY1_R = yR;
            shiftedR = Number.isFinite(yR) ? yR : shiftedR;
          }
        }

        // Crossfade pristine direct input with tuned pitch
        wetSampleL = (sL * (1.0 - this.fadeFactor)) + (shiftedL * this.fadeFactor);
        wetSampleR = (sR * (1.0 - this.fadeFactor)) + (shiftedR * this.fadeFactor);
      } else {
        // Keep delay buffer populated and reset phase heads
        this.delayBufL[this.writePos] = sL;
        this.delayBufR[this.writePos] = sR;
        this.phase0 = 0;
        this.phase1 = grain / 2;
      }

      // Mix: at 1.0 output tuned signal directly without dry leakage
      if (mixParam >= 0.999) {
        outL[i] = wetSampleL;
        if (outR) outR[i] = wetSampleR;
      } else {
        const dryGain = Math.cos(mixParam * 0.5 * Math.PI);
        const wetGain = Math.sin(mixParam * 0.5 * Math.PI);
        outL[i] = (sL * dryGain) + (wetSampleL * wetGain);
        if (outR) outR[i] = (sR * dryGain) + (wetSampleR * wetGain);
      }

      this.writePos = (this.writePos + 1) % this.bufferSize;

      // Telemetry dispatch throttled (~35 Hz)
      this.telemetrySamples++;
      if (this.telemetrySamples >= 1370) {
        this.telemetrySamples = 0;
        this.port.postMessage({
          detectedFreq: this.isVoiced ? Math.round(this.detectedFreq * 10) / 10 : 0,
          targetFreq: this.isVoiced ? Math.round(this.targetFreq * 10) / 10 : 0,
          correctedFreq: this.isVoiced ? Math.round(this.detectedFreq * this.smoothedRatio * 10) / 10 : 0,
          cents: this.isVoiced ? this.currentCents : 0,
          noteIndex: this.currentNoteIndex,
          noteName: this.noteNames[this.currentNoteIndex],
          octave: Math.floor((69 + 12 * Math.log2(Math.max(1, this.detectedFreq) / 440)) / 12) - 1,
          voiced: this.isVoiced,
          inTune: this.isVoiced && Math.abs(this.currentCents) < 5,
          ratio: this.smoothedRatio
        });
      }
    }

    return true;
  }
}
registerProcessor('auto-tune', AutoTuneProXProcessor);
`;