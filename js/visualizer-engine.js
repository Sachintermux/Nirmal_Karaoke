/**
 * Gen-Z Aesthetic Audio Visualizer Engine
 * High-performance, neon cyberpunk equalizer with floating peak caps,
 * spring/gravity physics, bass-reactive aura, and glassy stage reflection.
 *
 * Runs 100% agnostic of environment (Main Thread or OffscreenCanvas Web Worker).
 */

export class GenZVisualizerEngine {
  constructor(ctx, options = {}) {
    this.ctx = ctx;
    this.width = options.width || 300;
    this.height = options.height || 150;
    this.dpr = options.dpr || 1;
    this.isMobile = !!options.isMobile;

    this.numBars = this.isMobile ? 32 : 48;
    this.bars = new Float32Array(this.numBars);
    this.peaks = new Float32Array(this.numBars);
    this.peakHold = new Int16Array(this.numBars);
    this.peakSpeed = new Float32Array(this.numBars);

    this.smoothedBass = 0;
    this.silentFrames = 0;
    this.cachedGrad = null;
    this.cachedReflGrad = null;
    this.cachedH = 0;
    this.lastTime = 0;
    this.timeSec = 0;

    this._freqData = null;
    this.hasActiveSignal = false;
  }

  resize(width, height, dpr = this.dpr) {
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    this.cachedGrad = null;
    this.cachedReflGrad = null;
    this.cachedH = height;
  }

  setMobile(isMobile) {
    if (this.isMobile !== isMobile) {
      this.isMobile = isMobile;
      const newNum = isMobile ? 32 : 48;
      if (this.numBars !== newNum) {
        this.numBars = newNum;
        this.bars = new Float32Array(this.numBars);
        this.peaks = new Float32Array(this.numBars);
        this.peakHold = new Int16Array(this.numBars);
        this.peakSpeed = new Float32Array(this.numBars);
      }
    }
  }

  updateAudio(freqData) {
    this._freqData = freqData;
    if (!freqData || !freqData.length) {
      this.hasActiveSignal = false;
      return;
    }

    let signalCount = 0;
    const testLen = Math.min(32, freqData.length);
    for (let k = 0; k < testLen; k++) {
      if (freqData[k] > 2) signalCount++;
    }
    this.hasActiveSignal = signalCount > 1;
  }

  _drawCapsule(ctx, x, y, w, h, radius) {
    if (h <= 0 || w <= 0) return;
    const r = Math.min(radius, w / 2, h / 2);
    if (typeof ctx.roundRect === 'function') {
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, [r, r, 2, 2]);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, 2);
      ctx.arcTo(x, y + h, x, y, 2);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
      ctx.fill();
    }
  }

  _drawPeakPill(ctx, x, y, w, h, radius) {
    if (w <= 0 || h <= 0) return;
    const r = Math.min(radius, w / 2, h / 2);
    if (typeof ctx.roundRect === 'function') {
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, r);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.arc(x + w / 2, y + h / 2, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  render(now = performance.now()) {
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    if (!ctx || !w || !h) return;

    const dt = this.lastTime ? Math.min(0.1, (now - this.lastTime) / 1000) : 0.016;
    this.lastTime = now;
    this.timeSec += dt;

    const baseLine = Math.round(h * 0.82);
    const maxBarH = Math.round(h * 0.70);
    const numBars = this.numBars;
    const freq = this._freqData;

    // Check active audio signal
    if (!this.hasActiveSignal) {
      this.silentFrames++;
    } else {
      this.silentFrames = 0;
    }

    // Sub-bass kick detector (0 - 80Hz)
    let currentBass = 0;
    if (this.hasActiveSignal && freq && freq.length) {
      const bassBins = Math.min(6, freq.length);
      for (let b = 0; b < bassBins; b++) currentBass += freq[b] || 0;
      currentBass /= (bassBins * 255);
    }
    this.smoothedBass += (currentBass - this.smoothedBass) * (this.isMobile ? 0.35 : 0.25);

    // If long silence (> 25 frames), draw minimal cyber ambient wave and exit
    if (this.silentFrames > 25) {
      ctx.clearRect(0, 0, w, h);

      // Cyber glowing baseline with breathing wave
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(0, 240, 255, 0.16)';
      ctx.lineWidth = 1.5;
      ctx.moveTo(0, baseLine);
      const stepX = Math.max(8, Math.round(w / 40));
      for (let x = 0; x <= w; x += stepX) {
        const wave = Math.sin((x / w) * Math.PI * 4 + this.timeSec * 1.8) * 1.8;
        ctx.lineTo(x, baseLine + wave);
      }
      ctx.stroke();

      // Cyber tick dots
      ctx.fillStyle = 'rgba(0, 240, 255, 0.35)';
      const dots = [0.2, 0.5, 0.8];
      for (const d of dots) {
        ctx.beginPath();
        ctx.arc(w * d, baseLine, 2, 0, Math.PI * 2);
        ctx.fill();
      }

      // Decay any residual bars
      for (let i = 0; i < numBars; i++) {
        this.bars[i] = 0;
        this.peaks[i] = 0;
      }
      return;
    }

    ctx.clearRect(0, 0, w, h);

    // 1. Dynamic Sub-Bass Radial Aura (reactive glow when kicks land)
    if (this.smoothedBass > 0.18) {
      const auraIntensity = Math.min(0.24, (this.smoothedBass - 0.15) * 0.4);
      const auraRadius = Math.round(w * (0.22 + this.smoothedBass * 0.16));
      const auraGrad = ctx.createRadialGradient(w / 2, baseLine - 10, 0, w / 2, baseLine - 10, auraRadius);
      auraGrad.addColorStop(0, `rgba(0, 240, 255, ${auraIntensity.toFixed(3)})`);
      auraGrad.addColorStop(0.45, `rgba(255, 0, 127, ${(auraIntensity * 0.6).toFixed(3)})`);
      auraGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = auraGrad;
      ctx.beginPath();
      ctx.arc(w / 2, baseLine - 10, auraRadius, 0, Math.PI * 2);
      ctx.fill();
    }

    // 2. Cyber Horizon Baseline
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(0, 240, 255, 0.22)';
    ctx.lineWidth = 1.5;
    ctx.moveTo(0, baseLine);
    ctx.lineTo(w, baseLine);
    ctx.stroke();

    // 3. Compute Bar & Peak Physics
    const barSpacing = w / numBars;
    const barWidth = Math.max(3, barSpacing * 0.68);
    const startX = (w - (numBars * barSpacing)) / 2;
    const capRadius = Math.max(2, Math.min(barWidth / 2, 4));

    const binCount = freq ? freq.length : 0;
    const attackRate = this.isMobile ? 0.75 : 0.65;
    const decayRate = this.isMobile ? 0.22 : 0.17;
    const gravity = this.isMobile ? 0.38 : 0.28;

    for (let i = 0; i < numBars; i++) {
      let targetNorm = 0;
      if (this.hasActiveSignal && binCount > 0) {
        // Non-linear musical frequency bin curve (concentrates in vocal / melody zone)
        const normIdx = i / (numBars - 1);
        const bin = Math.floor(Math.pow(normIdx, 1.42) * (binCount * 0.72));
        const safeBin = Math.max(0, Math.min(binCount - 1, bin));
        targetNorm = (freq[safeBin] || 0) / 255;
      }

      // Smooth attack & spring decay
      if (targetNorm > this.bars[i]) {
        this.bars[i] += (targetNorm - this.bars[i]) * attackRate;
      } else {
        this.bars[i] -= (this.bars[i] - targetNorm) * decayRate;
      }

      const barHeight = Math.max(0, Math.pow(this.bars[i], 1.35) * maxBarH);

      // Floating Neon Peak Cap Physics
      if (barHeight >= this.peaks[i]) {
        this.peaks[i] = barHeight;
        this.peakHold[i] = this.isMobile ? 4 : 7; // frames held in mid-air
        this.peakSpeed[i] = 0;
      } else if (this.peakHold[i] > 0) {
        this.peakHold[i]--;
      } else {
        this.peakSpeed[i] += gravity;
        this.peaks[i] = Math.max(0, this.peaks[i] - this.peakSpeed[i]);
      }
    }

    // 4. Cache & Prepare Gen-Z Vibrant Neon Gradient
    if (!this.cachedGrad || this.cachedH !== h) {
      this.cachedH = h;
      this.cachedGrad = ctx.createLinearGradient(0, baseLine - maxBarH, 0, baseLine);
      this.cachedGrad.addColorStop(0, '#00f0ff');     // Electric Neon Cyan
      this.cachedGrad.addColorStop(0.32, '#a855f7');  // Cyber Violet
      this.cachedGrad.addColorStop(0.72, '#ff007f');  // Cyberpunk Magenta
      this.cachedGrad.addColorStop(1, '#ff3366');     // Neon Coral

      this.cachedReflGrad = ctx.createLinearGradient(0, baseLine, 0, baseLine + Math.round(maxBarH * 0.35));
      this.cachedReflGrad.addColorStop(0, 'rgba(255, 0, 127, 0.22)');
      this.cachedReflGrad.addColorStop(0.5, 'rgba(168, 85, 247, 0.10)');
      this.cachedReflGrad.addColorStop(1, 'rgba(0, 240, 255, 0.0)');
    }

    // 5. Draw Mirrored Glassy Stage Reflection
    ctx.fillStyle = this.cachedReflGrad;
    for (let i = 0; i < numBars; i++) {
      const bH = this.bars[i] * maxBarH;
      if (bH < 3) continue;
      const x = Math.round(startX + (i * barSpacing) + (barSpacing - barWidth) / 2);
      const reflH = Math.min(Math.round(bH * 0.32), Math.round(maxBarH * 0.3));
      this._drawCapsule(ctx, x, baseLine + 1, barWidth, reflH, capRadius);
    }

    // 6. Draw Main Gen-Z Equalizer Capsule Bars
    ctx.fillStyle = this.cachedGrad;
    for (let i = 0; i < numBars; i++) {
      const bH = Math.max(0, Math.pow(this.bars[i], 1.35) * maxBarH);
      if (bH < 1.5) continue;
      const x = Math.round(startX + (i * barSpacing) + (barSpacing - barWidth) / 2);
      const y = Math.round(baseLine - bH);
      this._drawCapsule(ctx, x, y, barWidth, bH, capRadius);
    }

    // 7. Draw Floating Neon Peak Caps (hanging glowing dots)
    ctx.fillStyle = '#00ffff';
    const peakDotH = Math.max(2.5, Math.min(barWidth * 0.42, 4));
    for (let i = 0; i < numBars; i++) {
      const pH = this.peaks[i];
      if (pH < 4) continue;
      const x = Math.round(startX + (i * barSpacing) + (barSpacing - barWidth) / 2);
      const y = Math.round(baseLine - pH - peakDotH - 2);
      this._drawPeakPill(ctx, x, y, barWidth, peakDotH, capRadius);
    }
  }
}
