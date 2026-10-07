/**
 * Gen-Z Cyberpunk Audio Visualizer for Nirmal Karaoke Live Studio
 *
 * Direct, high-performance 2D Canvas rendering with:
 * - Electric Neon Gradient: Cyan (#00f0ff) -> Cyber Violet (#a855f7) -> Cyberpunk Magenta (#ff007f) -> Neon Coral (#ff3366)
 * - Capsule Equalizer Bars with smooth non-linear frequency mapping
 * - Floating Neon Peak Caps (#00ffff) with peak hold & gravity physics
 * - Dynamic Sub-Bass Radial Aura (reactive glow on kicks)
 * - Mirrored Glassy Stage Floor Reflection
 * - Ambient Cyber Breathing Wave when audio is silent
 * - Frame throttling (30 FPS on mobile, 60 FPS on desktop) & visibility pausing
 * - Capped DPR (1.5 on mobile, 2.0 on desktop) for 0ms lag
 * - Drawing + bar physics run in an OffscreenCanvas Web Worker (js/workers/visualizer.worker.js)
 *   so the main thread only reads the analyser. Falls back to direct main-thread 2D
 *   drawing when OffscreenCanvas/Worker is unavailable or the worker fails.
 */

export class VisualizerRenderer {
  constructor(audioEngine) {
    this.audioEngine = audioEngine;
    this.cvs = null;
    this.ctx = null;
    this.visDataArray = null;
    this._rafId = null;
    this._lastDrawTs = 0;
    this._silentFrames = 0;
    this._lastTime = 0;
    this._timeSec = 0;
    this._smoothedBass = 0;
    this._cachedGrad = null;
    this._cachedReflGrad = null;
    this._cachedH = 0;
    this._isMobile = typeof window !== 'undefined' && (
      window.innerWidth <= 850 ||
      /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
    );

    this.numBars = this._isMobile ? 32 : 48;
    this.bars = new Float32Array(this.numBars);
    this.peaks = new Float32Array(this.numBars);
    this.peakHold = new Int16Array(this.numBars);
    this.peakSpeed = new Float32Array(this.numBars);
    this._wasHidden = false;
    this._resizeObserver = null;
    this._resizeBound = null;
    this._worker = null;
    this._w = 0;
    this._h = 0;
  }

  _startWorker() {
    try {
      if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined' ||
          typeof this.cvs.transferControlToOffscreen !== 'function') return false;
      const parent = this.cvs.parentElement;
      const dpr = Math.min(window.devicePixelRatio || 1, this._isMobile ? 1.25 : 2);
      const width = Math.max(80, Math.round((parent?.clientWidth || this.cvs.width || 300) * dpr));
      const height = Math.max(40, Math.round((parent?.clientHeight || this.cvs.height || 150) * dpr));
      const worker = new Worker('./js/workers/visualizer.worker.js?v=1');
      const offscreen = this.cvs.transferControlToOffscreen();
      worker.onerror = (err) => {
        console.warn('[Visualizer] worker failed, using main-thread renderer:', err?.message || err);
        this._fallbackToMainThread();
      };
      worker.postMessage({
        type: 'INIT', canvas: offscreen, mode: 'admin',
        width, height, isMobile: this._isMobile, numBars: this.numBars
      }, [offscreen]);
      this._worker = worker;
      this._w = width;
      this._h = height;
      return true;
    } catch (err) {
      console.warn('[Visualizer] OffscreenCanvas unavailable:', err?.message || err);
      this._worker = null;
      return false;
    }
  }

  // A canvas whose control was transferred cannot be drawn on again, so swap in a
  // fresh element with the same id/class/style and render on the main thread.
  _fallbackToMainThread() {
    if (!this._worker) return;
    try { this._worker.terminate(); } catch (_) {}
    this._worker = null;
    const old = this.cvs;
    if (!old) return;
    const fresh = old.cloneNode(false);
    old.replaceWith(fresh);
    this.cvs = fresh;
    this.ctx = fresh.getContext('2d', { alpha: true });
    this._cachedGrad = null;
    this._cachedReflGrad = null;
    this._resizeObserver?.disconnect();
    if (this._resizeObserver && fresh.parentElement) {
      try { this._resizeObserver.observe(fresh.parentElement); } catch (_) {}
    }
    this.resize();
  }

  resize() {
    if (!this.cvs || !this.cvs.parentElement) return;
    const parent = this.cvs.parentElement;

    // Safety guard: If parent element is hidden (display: none) or has 0 dimensions,
    // NEVER overwrite canvas resolution to 10x10!
    if (parent.clientWidth <= 0 || parent.clientHeight <= 0) {
      return;
    }

    this._isMobile = typeof window !== 'undefined' && (
      window.innerWidth <= 850 ||
      /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
    );
    const targetBars = this._isMobile ? 32 : 48;
    if (this.numBars !== targetBars) {
      this.numBars = targetBars;
      this.bars = new Float32Array(this.numBars);
      this.peaks = new Float32Array(this.numBars);
      this.peakHold = new Int16Array(this.numBars);
      this.peakSpeed = new Float32Array(this.numBars);
    }

    const dpr = Math.min(window.devicePixelRatio || 1, this._isMobile ? 1.25 : 2);
    const targetW = Math.max(80, Math.round(parent.clientWidth * dpr));
    const targetH = Math.max(40, Math.round(parent.clientHeight * dpr));

    if (this._worker) {
      if (this._w !== targetW || this._h !== targetH || this._sentBars !== this.numBars) {
        this._w = targetW;
        this._h = targetH;
        this._sentBars = this.numBars;
        this._worker.postMessage({
          type: 'RESIZE', width: targetW, height: targetH,
          isMobile: this._isMobile, numBars: this.numBars
        });
      }
      return;
    }

    if (this.cvs.width !== targetW || this.cvs.height !== targetH) {
      this.cvs.width = targetW;
      this.cvs.height = targetH;
      this._cachedGrad = null;
      this._cachedReflGrad = null;
      this._cachedH = targetH;
    }
  }

  refresh() {
    this.resize();
    this._lastTime = performance.now();
    this._lastDrawTs = 0;
    if (!this._rafId) {
      this.startPump();
    }
  }

  init() {
    this.cvs = document.getElementById('visualizer');
    if (!this.cvs) return;

    // Prefer an OffscreenCanvas worker; otherwise draw directly on the main thread.
    if (!this._startWorker()) {
      this.ctx = this.cvs.getContext('2d', { alpha: true });
      if (!this.ctx) return;
    }

    const hudAccel = document.getElementById('hudAccel');
    if (hudAccel) {
      hudAccel.textContent = "⚡ ACCEL: ON";
      hudAccel.style.color = "var(--accent-green, #00ff88)";
    }

    this._resizeBound = () => this.resize();
    window.addEventListener('resize', this._resizeBound, { passive: true });
    window.addEventListener('orientationchange', () => setTimeout(() => this.resize(), 150), { passive: true });

    // Use ResizeObserver for instant reflow detection on tab switching or DOM display changes
    if (typeof ResizeObserver !== 'undefined' && this.cvs.parentElement) {
      try {
        this._resizeObserver = new ResizeObserver((entries) => {
          for (const entry of entries) {
            if (entry.contentRect && entry.contentRect.width > 0 && entry.contentRect.height > 0) {
              this.resize();
            }
          }
        });
        this._resizeObserver.observe(this.cvs.parentElement);
      } catch (_) {}
    }

    this.resize();
    this.startPump();
  }

  startPump() {
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }

    let fpsFrames = 0;
    let fpsLastSec = performance.now();
    const hudFps = document.getElementById('hudFps');

    const pumpLoop = (ts) => {
      this._rafId = requestAnimationFrame(pumpLoop);

      // Do not consume GPU / CPU cycles when tab is hidden
      if (typeof document !== 'undefined' && document.hidden) return;

      // offsetParent/clientWidth force a synchronous layout, so sample them at
      // ~4 Hz instead of every frame; ResizeObserver covers real size changes.
      if (!this._layoutCheckTs || ts - this._layoutCheckTs > 250) {
        this._layoutCheckTs = ts;
        this._layoutHidden = !this.cvs || this.cvs.offsetParent === null || (this.cvs.parentElement && this.cvs.parentElement.clientWidth <= 0);
        if (!this._layoutHidden && this.cvs.parentElement) {
          const dpr = Math.min(window.devicePixelRatio || 1, this._isMobile ? 1.25 : 2);
          const expectedW = Math.round(this.cvs.parentElement.clientWidth * dpr);
          if (expectedW > 50 && Math.abs((this._worker ? this._w : this.cvs.width) - expectedW) > 6) {
            this.resize();
          }
        }
      }
      const isHidden = this._layoutHidden;
      if (isHidden) {
        this._wasHidden = true;
        return;
      }

      // If returning from another screen (e.g. effects or mixer tab):
      if (this._wasHidden) {
        this._wasHidden = false;
        this.resize();
        this._lastTime = ts;
        this._lastDrawTs = ts;
      }

      // Frame throttle:
      // Mobile: ~30 FPS (interval ~33ms) for optimal battery and thermals
      // Desktop: ~60 FPS (interval ~16ms) for ultra-fluid rendering
      const targetInterval = this._isMobile ? 33 : 16;
      if (ts - this._lastDrawTs < targetInterval) return;
      this._lastDrawTs = ts;

      this.renderFrame(ts);

      // Live FPS Telemetry on stage HUD
      fpsFrames++;
      if (ts - fpsLastSec >= 1000) {
        const curFps = Math.round((fpsFrames * 1000) / (ts - fpsLastSec));
        if (hudFps) {
          hudFps.textContent = `FPS: ${curFps}`;
        }
        fpsFrames = 0;
        fpsLastSec = ts;
      }
    };

    this._rafId = requestAnimationFrame(pumpLoop);
  }

  renderFrame(now = performance.now()) {
    // Worker mode: the main thread only samples the analyser and forwards the
    // bins; all physics and drawing happen off-thread.
    if (this._worker) {
      const analyser = this.audioEngine?.engine?.analyser;
      let data = null;
      if (analyser) {
        data = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(data);
      }
      try {
        this._worker.postMessage({ type: 'FRAME', data }, data ? [data.buffer] : []);
      } catch (_) {}
      return;
    }

    const cvs = this.cvs;
    const ctx = this.ctx;
    if (!cvs || !ctx) return;
    const w = cvs.width;
    const h = cvs.height;
    if (!w || !h) return;

    const dt = this._lastTime ? Math.min(0.1, (now - this._lastTime) / 1000) : 0.016;
    this._lastTime = now;
    this._timeSec += dt;

    const baseLine = Math.round(h * 0.82);
    const maxBarH = Math.round(h * 0.70);
    const numBars = this.numBars;

    // Fetch live frequency data from the audio engine
    const engine = this.audioEngine?.engine;
    let hasSignal = false;
    let maxEnergy = 0;

    if (engine?.analyser) {
      const binCount = engine.analyser.frequencyBinCount;
      if (!this.visDataArray || this.visDataArray.length !== binCount) {
        this.visDataArray = new Uint8Array(binCount);
      }
      engine.analyser.getByteFrequencyData(this.visDataArray);

      // Detect signal across the spectrum (sample every 3 bins)
      const data = this.visDataArray;
      const len = data.length;
      for (let k = 0; k < len; k += 3) {
        if (data[k] > maxEnergy) {
          maxEnergy = data[k];
          if (maxEnergy > 2) {
            hasSignal = true;
            break;
          }
        }
      }
    }

    if (!hasSignal) {
      this._silentFrames++;
    } else {
      this._silentFrames = 0;
    }

    // Sub-bass kick detector (bins 0-6)
    let currentBass = 0;
    if (hasSignal && this.visDataArray) {
      const bassBins = Math.min(6, this.visDataArray.length);
      for (let b = 0; b < bassBins; b++) currentBass += this.visDataArray[b] || 0;
      currentBass /= (bassBins * 255);
    }
    this._smoothedBass += (currentBass - this._smoothedBass) * (this._isMobile ? 0.35 : 0.25);

    // If silent for > 20 frames, render ambient breathing cyber horizon and exit early
    if (this._silentFrames > 20) {
      ctx.clearRect(0, 0, w, h);

      // Ambient breathing Cyber Horizon Wave
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(0, 240, 255, 0.16)';
      ctx.lineWidth = 1.5;
      ctx.moveTo(0, baseLine);
      const stepX = Math.max(8, Math.round(w / 40));
      for (let x = 0; x <= w; x += stepX) {
        const wave = Math.sin((x / w) * Math.PI * 4 + this._timeSec * 1.8) * 2.0;
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

      // Smoothly zero out bars and peaks
      for (let i = 0; i < numBars; i++) {
        this.bars[i] = 0;
        this.peaks[i] = 0;
      }
      return;
    }

    ctx.clearRect(0, 0, w, h);

    // 1. Dynamic Sub-Bass Radial Aura (reactive neon glow on kicks)
    if (this._smoothedBass > 0.15) {
      const auraIntensity = Math.min(0.24, (this._smoothedBass - 0.12) * 0.45);
      const auraRadius = Math.round(w * (0.22 + this._smoothedBass * 0.16));
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

    const freq = this.visDataArray;
    const binCount = freq ? freq.length : 0;
    const attackRate = this._isMobile ? 0.75 : 0.65;
    const decayRate = this._isMobile ? 0.22 : 0.17;
    const gravity = this._isMobile ? 0.38 : 0.28;

    for (let i = 0; i < numBars; i++) {
      let targetNorm = 0;
      if (hasSignal && binCount > 0) {
        // Non-linear musical frequency bin curve (concentrates in vocal / melody zone)
        const normIdx = i / (numBars - 1);
        const bin = Math.floor(Math.pow(normIdx, 1.35) * (binCount * 0.72));
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
        this.peakHold[i] = this._isMobile ? 4 : 7; // frames held in mid-air
        this.peakSpeed[i] = 0;
      } else if (this.peakHold[i] > 0) {
        this.peakHold[i]--;
      } else {
        this.peakSpeed[i] += gravity;
        this.peaks[i] = Math.max(0, this.peaks[i] - this.peakSpeed[i]);
      }
    }

    // 4. Cache & Prepare Gen-Z Vibrant Neon Gradient
    if (!this._cachedGrad || this._cachedH !== h) {
      this._cachedH = h;
      this._cachedGrad = ctx.createLinearGradient(0, baseLine - maxBarH, 0, baseLine);
      this._cachedGrad.addColorStop(0, '#00f0ff');     // Electric Neon Cyan
      this._cachedGrad.addColorStop(0.32, '#a855f7');  // Cyber Violet
      this._cachedGrad.addColorStop(0.72, '#ff007f');  // Cyberpunk Magenta
      this._cachedGrad.addColorStop(1, '#ff3366');     // Neon Coral

      this._cachedReflGrad = ctx.createLinearGradient(0, baseLine, 0, baseLine + Math.round(maxBarH * 0.35));
      this._cachedReflGrad.addColorStop(0, 'rgba(255, 0, 127, 0.22)');
      this._cachedReflGrad.addColorStop(0.5, 'rgba(168, 85, 247, 0.10)');
      this._cachedReflGrad.addColorStop(1, 'rgba(0, 240, 255, 0.0)');
    }

    // 5. Draw Mirrored Glassy Stage Reflection
    ctx.fillStyle = this._cachedReflGrad;
    for (let i = 0; i < numBars; i++) {
      const bH = this.bars[i] * maxBarH;
      if (bH < 3) continue;
      const x = Math.round(startX + (i * barSpacing) + (barSpacing - barWidth) / 2);
      const reflH = Math.min(Math.round(bH * 0.32), Math.round(maxBarH * 0.3));
      this._drawCapsule(ctx, x, baseLine + 1, barWidth, reflH, capRadius);
    }

    // 6. Draw Main Gen-Z Equalizer Capsule Bars
    ctx.fillStyle = this._cachedGrad;
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

  drawLoop(now = performance.now()) {
    this.renderFrame(now);
  }

  destroy() {
    if (this._worker) {
      try { this._worker.terminate(); } catch (_) {}
      this._worker = null;
    }
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }
    if (this._resizeBound) {
      window.removeEventListener('resize', this._resizeBound);
      this._resizeBound = null;
    }
  }
}

// Backwards-compatibility alias
export const GenZVisualizerEngine = VisualizerRenderer;