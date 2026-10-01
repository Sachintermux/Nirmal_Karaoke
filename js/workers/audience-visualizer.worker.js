/**
 * Nirmal Karaoke - Audience Background Visualizer Worker
 * Runs 100% off the main thread using OffscreenCanvas.
 * Handles FFT bar rendering, 64-band peak decay physics, neon gradients,
 * and reflections without causing UI jank or dropping video/audio frames.
 */

let canvas = null;
let ctx = null;
let width = 0;
let height = 0;
let dpr = 1;

let latestBars = null;
let isRunning = false;
let lastActiveTime = 0;
let isCanvasVisible = false;

// Physics buffers for 64-band frequency spectrum
const NUM_PEAKS = 64;
const peaks = new Float32Array(NUM_PEAKS);
const peakHold = new Int16Array(NUM_PEAKS);
const peakSpeed = new Float32Array(NUM_PEAKS);

let gradMain = null;
let gradRefl = null;

self.onmessage = function (e) {
  const msg = e.data;
  if (!msg) return;

  switch (msg.type) {
    case 'INIT':
      canvas = msg.canvas;
      dpr = msg.dpr || 1;
      width = msg.width || 320;
      height = msg.height || 48;
      if (canvas) {
        ctx = canvas.getContext('2d', { alpha: true, desynchronized: true });
        setupCanvasDimensions(width, height, dpr);
      }
      break;

    case 'RESIZE':
      dpr = msg.dpr || dpr;
      width = msg.width || width;
      height = msg.height || height;
      if (canvas && ctx) {
        setupCanvasDimensions(width, height, dpr);
      }
      break;

    case 'BARS':
      latestBars = msg.bars;
      lastActiveTime = performance.now();
      if (!isRunning) {
        isRunning = true;
        startRenderLoop();
      }
      break;

    case 'CLEAR':
      latestBars = null;
      clearCanvas();
      break;
  }
};

function setupCanvasDimensions(w, h, ratio) {
  const targetW = Math.round(w * ratio);
  const targetH = Math.round(h * ratio);
  canvas.width = targetW;
  canvas.height = targetH;
  gradMain = null;
  gradRefl = null;
}

function clearCanvas() {
  if (!ctx || !canvas) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (isCanvasVisible) {
    isCanvasVisible = false;
    self.postMessage({ type: 'VISIBILITY', visible: false });
  }
}

function startRenderLoop() {
  // Use requestAnimationFrame if supported in Worker, otherwise high-precision timer
  const requestFrame = typeof self.requestAnimationFrame === 'function'
    ? self.requestAnimationFrame.bind(self)
    : (cb) => setTimeout(() => cb(performance.now()), 16);

  function frame(now) {
    if (!isRunning) return;

    // Check for idle / silence timeout (> 1800ms with no new active bars)
    if (now - lastActiveTime > 1800) {
      clearCanvas();
      isRunning = false;
      return;
    }

    render();
    requestFrame(frame);
  }

  requestFrame(frame);
}

function render() {
  if (!ctx || !canvas) return;
  const cw = canvas.width;
  const ch = canvas.height;
  if (!cw || !ch) return;

  const bars = latestBars;
  if (!bars || !bars.length) {
    ctx.clearRect(0, 0, cw, ch);
    return;
  }

  if (!isCanvasVisible) {
    isCanvasVisible = true;
    self.postMessage({ type: 'VISIBILITY', visible: true });
  }

  ctx.clearRect(0, 0, cw, ch);

  const numBars = Math.min(bars.length, NUM_PEAKS);
  const barSpacing = cw / numBars;
  const barWidth = Math.max(2, barSpacing * 0.70);
  const baseLine = Math.round(ch * 0.82);
  const maxBarH = Math.round(ch * 0.72);
  const capRadius = Math.max(1.5, Math.min(barWidth / 2, 3));

  if (!gradMain) {
    gradMain = ctx.createLinearGradient(0, baseLine - maxBarH, 0, baseLine);
    gradMain.addColorStop(0, '#00f0ff');
    gradMain.addColorStop(0.35, '#a855f7');
    gradMain.addColorStop(0.75, '#ff007f');
    gradMain.addColorStop(1, '#ff3366');

    gradRefl = ctx.createLinearGradient(0, baseLine, 0, baseLine + Math.round(maxBarH * 0.25));
    gradRefl.addColorStop(0, 'rgba(255, 0, 127, 0.22)');
    gradRefl.addColorStop(1, 'rgba(0, 240, 255, 0.0)');
  }

  // 1. Draw baseline
  ctx.strokeStyle = 'rgba(0, 240, 255, 0.2)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, baseLine);
  ctx.lineTo(cw, baseLine);
  ctx.stroke();

  // 2. Draw reflected baseline bars
  ctx.fillStyle = gradRefl;
  const hasRoundRect = typeof ctx.roundRect === 'function';

  for (let i = 0; i < numBars; i++) {
    const pct = (bars[i] || 0) / 255;
    const bH = Math.pow(pct, 1.35) * maxBarH;
    if (bH < 2) continue;
    const x = Math.round(i * barSpacing + (barSpacing - barWidth) / 2);
    const reflH = Math.min(Math.round(bH * 0.26), Math.round(maxBarH * 0.22));

    if (hasRoundRect) {
      ctx.beginPath();
      ctx.roundRect(x, baseLine + 1, barWidth, reflH, [1, 1, capRadius, capRadius]);
      ctx.fill();
    } else {
      ctx.fillRect(x, baseLine + 1, barWidth, reflH);
    }
  }

  // 3. Draw Main Bars & Compute Peak Physics
  ctx.fillStyle = gradMain;
  for (let i = 0; i < numBars; i++) {
    const pct = (bars[i] || 0) / 255;
    const bH = Math.max(0, Math.pow(pct, 1.35) * maxBarH);

    // Peak physics decay
    if (bH >= peaks[i]) {
      peaks[i] = bH;
      peakHold[i] = 5;
      peakSpeed[i] = 0;
    } else if (peakHold[i] > 0) {
      peakHold[i]--;
    } else {
      peakSpeed[i] += 0.3;
      peaks[i] = Math.max(0, peaks[i] - peakSpeed[i]);
    }

    if (bH < 1.5) continue;
    const x = Math.round(i * barSpacing + (barSpacing - barWidth) / 2);
    const y = Math.round(baseLine - bH);

    if (hasRoundRect) {
      ctx.beginPath();
      ctx.roundRect(x, y, barWidth, bH, [capRadius, capRadius, 1, 1]);
      ctx.fill();
    } else {
      ctx.fillRect(x, y, barWidth, bH);
    }
  }

  // 4. Draw Floating Peak Dots
  ctx.fillStyle = '#00ffff';
  const peakDotH = Math.max(2, Math.min(barWidth * 0.4, 3));
  for (let i = 0; i < numBars; i++) {
    const pH = peaks[i];
    if (pH < 3) continue;
    const x = Math.round(i * barSpacing + (barSpacing - barWidth) / 2);
    const y = Math.round(baseLine - pH - peakDotH - 1.5);

    if (hasRoundRect) {
      ctx.beginPath();
      ctx.roundRect(x, y, barWidth, peakDotH, capRadius);
      ctx.fill();
    } else {
      ctx.fillRect(x, y, barWidth, peakDotH);
    }
  }
}
