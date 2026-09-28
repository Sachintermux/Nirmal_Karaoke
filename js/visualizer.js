export class VisualizerRenderer {
  constructor(audioEngine) {
    this.audioEngine = audioEngine;
    this.visDataArray = null;
    this.fallbackPeaks = new Float32Array(512);
    this._lastDrawTs = 0;
    this._cachedGrad = null;
    this._lastH = 0;
    this._silentFrames = 0;
    this._isMobile = typeof window !== 'undefined' && (
      window.innerWidth <= 850 ||
      /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
    );
  }

  init() {
    const cvs = document.getElementById('visualizer');
    // Cap DPR on mobile to 1.5 to eliminate heavy GPU fill bottlenecks
    const dpr = Math.min(window.devicePixelRatio || 1, this._isMobile ? 1.5 : 2);
    const hudAccel = document.getElementById('hudAccel');
    if (hudAccel) {
      hudAccel.textContent = "HW ACCEL: ON";
      hudAccel.style.color = "var(--accent-green)";
    }

    const resize = () => {
      if (cvs && cvs.parentElement) {
        const targetW = Math.round(cvs.parentElement.clientWidth * dpr);
        const targetH = Math.round(cvs.parentElement.clientHeight * dpr);
        if (cvs.width !== targetW || cvs.height !== targetH) {
          cvs.width = targetW;
          cvs.height = targetH;
          this._cachedGrad = null;
          this._lastH = targetH;
        }
      }
    };
    window.addEventListener('resize', resize, { passive: true });
    window.addEventListener('orientationchange', () => setTimeout(resize, 200), { passive: true });
    resize();

    this.drawLoop(performance.now());
  }

  drawLoop(now = performance.now()) {
    requestAnimationFrame((ts) => this.drawLoop(ts));

    // Do not consume GPU when page/tab is hidden
    if (typeof document !== 'undefined' && document.hidden) return;

    // Frame rate throttle: 30 FPS on mobile, 45 FPS on desktop
    const targetInterval = this._isMobile ? 33 : 22;
    if (now - this._lastDrawTs < targetInterval) return;
    this._lastDrawTs = now;

    const engine = this.audioEngine?.engine;
    if (!engine?.analyser) return;

    if (!this.visDataArray || this.visDataArray.length !== engine.analyser.frequencyBinCount) {
      this.visDataArray = new Uint8Array(engine.analyser.frequencyBinCount);
    }
    engine.analyser.getByteFrequencyData(this.visDataArray);

    const cvs = document.getElementById('visualizer');
    if (!cvs) return;
    const ctx2d = cvs.getContext('2d', { alpha: true });
    const w = cvs.width, h = cvs.height;
    if (!w || !h) return;

    // Quick energy check
    let hasEnergy = false;
    for (let k = 0; k < Math.min(this.visDataArray.length, 32); k++) {
      if (this.visDataArray[k] > 2) {
        hasEnergy = true;
        break;
      }
    }

    if (!hasEnergy) {
      this._silentFrames++;
      // After fading to zero, render flat baseline and idle
      if (this._silentFrames > 25) {
        ctx2d.clearRect(0, 0, w, h);
        const baseLine = h * 0.85;
        ctx2d.strokeStyle = 'rgba(0, 229, 255, 0.08)';
        ctx2d.lineWidth = 1;
        ctx2d.beginPath();
        ctx2d.moveTo(0, baseLine);
        ctx2d.lineTo(w, baseLine);
        ctx2d.stroke();
        return;
      }
    } else {
      this._silentFrames = 0;
    }

    ctx2d.clearRect(0, 0, w, h);
    const baseLine = h * 0.85;
    ctx2d.strokeStyle = 'rgba(0, 229, 255, 0.12)';
    ctx2d.lineWidth = 1;
    ctx2d.beginPath();
    ctx2d.moveTo(0, baseLine);
    ctx2d.lineTo(w, baseLine);
    ctx2d.stroke();

    const numBars = this._isMobile ? 32 : 48;
    const step = Math.floor(this.visDataArray.length / (numBars * 1.8));
    const barSpacing = w / numBars;
    const barWidth = barSpacing * 0.65;

    // Cache gradient object across frames
    if (!this._cachedGrad || this._lastH !== h) {
      this._lastH = h;
      this._cachedGrad = ctx2d.createLinearGradient(0, h * 0.1, 0, baseLine);
      this._cachedGrad.addColorStop(0, '#00e5ff');
      this._cachedGrad.addColorStop(0.5, '#a855f7');
      this._cachedGrad.addColorStop(1, '#ff007f');
    }
    ctx2d.fillStyle = this._cachedGrad;

    for (let i = 0; i < numBars; i++) {
      const percent = (this.visDataArray[i * step] || 0) / 255;
      const barHeight = Math.pow(percent, 1.4) * (h * 0.75);
      if (barHeight > this.fallbackPeaks[i]) this.fallbackPeaks[i] = barHeight;
      else this.fallbackPeaks[i] = Math.max(0, this.fallbackPeaks[i] - (this._isMobile ? 3.5 : 2.5));

      const finalH = Math.max(barHeight, this.fallbackPeaks[i]);
      if (finalH < 1) continue;

      const barX = i * barSpacing + (barSpacing - barWidth) / 2;
      const barY = baseLine - finalH;
      if (typeof ctx2d.roundRect === 'function') {
        ctx2d.beginPath();
        ctx2d.roundRect(barX, barY, barWidth, finalH, [3, 3, 0, 0]);
        ctx2d.fill();
      } else {
        ctx2d.fillRect(barX, barY, barWidth, finalH);
      }
    }
  }
}