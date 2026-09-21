export class VisualizerRenderer {
  constructor(audioEngine) {
    this.audioEngine = audioEngine;
    this.visDataArray = null;
    this.fallbackPeaks = new Float32Array(512);
  }

  init() {
    const cvs = document.getElementById('visualizer');
    const dpr = window.devicePixelRatio || 1;
    const hudAccel = document.getElementById('hudAccel');
    if (hudAccel) {
      hudAccel.textContent = "HW ACCEL: ON";
      hudAccel.style.color = "var(--accent-green)";
    }

    const resize = () => {
      if (cvs && cvs.parentElement) {
        cvs.width = cvs.parentElement.clientWidth * dpr;
        cvs.height = cvs.parentElement.clientHeight * dpr;
      }
    };
    window.addEventListener('resize', resize);
    window.addEventListener('orientationchange', () => setTimeout(resize, 200));
    resize();

    this.drawLoop();
  }

  drawLoop() {
    requestAnimationFrame(() => this.drawLoop());
    const engine = this.audioEngine.engine;
    if (!engine.analyser) return;

    if (!this.visDataArray) this.visDataArray = new Uint8Array(engine.analyser.frequencyBinCount);
    engine.analyser.getByteFrequencyData(this.visDataArray);

    const cvs = document.getElementById('visualizer');
    if (!cvs) return;
    const ctx2d = cvs.getContext('2d');
    const w = cvs.width, h = cvs.height;
    if (!w || !h) return;

    ctx2d.clearRect(0, 0, w, h);
    const baseLine = h * 0.85;
    ctx2d.strokeStyle = 'rgba(0, 229, 255, 0.1)';
    ctx2d.lineWidth = 1;
    ctx2d.beginPath();
    ctx2d.moveTo(0, baseLine);
    ctx2d.lineTo(w, baseLine);
    ctx2d.stroke();

    const numBars = 48;
    const step = Math.floor(this.visDataArray.length / (numBars * 1.8));
    const barSpacing = w / numBars;
    const barWidth = barSpacing * 0.65;
    const grad = ctx2d.createLinearGradient(0, h * 0.1, 0, baseLine);
    grad.addColorStop(0, '#00e5ff');
    grad.addColorStop(0.5, '#a855f7');
    grad.addColorStop(1, '#ff007f');
    ctx2d.fillStyle = grad;

    for (let i = 0; i < numBars; i++) {
      const percent = (this.visDataArray[i * step] || 0) / 255;
      const barHeight = Math.pow(percent, 1.4) * (h * 0.75);
      if (barHeight > this.fallbackPeaks[i]) this.fallbackPeaks[i] = barHeight;
      else this.fallbackPeaks[i] = Math.max(0, this.fallbackPeaks[i] - 2.5);
      ctx2d.beginPath();
      const barX = i * barSpacing + (barSpacing - barWidth) / 2;
      const barY = baseLine - barHeight;
      if (typeof ctx2d.roundRect === 'function') {
        ctx2d.roundRect(barX, barY, barWidth, barHeight, [4, 4, 0, 0]);
      } else {
        ctx2d.rect(barX, barY, barWidth, barHeight);
      }
      ctx2d.fill();
    }
  }
}