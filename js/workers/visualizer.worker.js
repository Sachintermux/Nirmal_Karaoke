/**
 * Visualizer render worker (OffscreenCanvas).
 *
 * Owns all bar physics and 2D drawing for both the admin stage visualizer and
 * the audience visualizer so none of it runs on the page's main thread. The
 * main thread only forwards frequency data:
 *   admin    -> { type: 'FRAME', data: Uint8Array }   (analyser bins)
 *   audience -> { type: 'BARS',  bars: Uint8Array|null } (host-sent bars)
 *
 * Math is a straight port of js/visualizer.js (admin) and the audience
 * renderer in audience.html so the look is unchanged.
 */

let cvs = null;
let ctx = null;
let mode = 'admin';
let isMobile = false;
let numBars = 48;
let w = 0;
let h = 0;

let bars, peaks, peakHold, peakSpeed;
let cachedGrad = null;
let cachedReflGrad = null;
let cachedH = 0;
let silentFrames = 0;
let smoothedBass = 0;
let timeSec = 0;
let lastTime = 0;

// admin: latest analyser frame awaiting a draw (coalesces bursts)
let pendingFrame = null;
let drawScheduled = false;

// audience: latest host bars + own 30 fps loop
let latestBars = null;
let hasSignal = false;
let audienceTimer = null;

function allocBars(n) {
  numBars = n;
  bars = new Float32Array(n);
  peaks = new Float32Array(n);
  peakHold = new Int16Array(n);
  peakSpeed = new Float32Array(n);
}
allocBars(numBars);

function applySize(width, height) {
  if (!cvs || width <= 0 || height <= 0) return;
  if (cvs.width !== width || cvs.height !== height) {
    cvs.width = width;
    cvs.height = height;
    cachedGrad = null;
    cachedReflGrad = null;
    cachedH = height;
  }
  w = width;
  h = height;
}

self.onmessage = (e) => {
  const m = e.data;
  if (!m) return;
  switch (m.type) {
    case 'INIT':
      cvs = m.canvas;
      ctx = cvs.getContext('2d', { alpha: true });
      mode = m.mode || 'admin';
      isMobile = !!m.isMobile;
      if (m.numBars && m.numBars !== numBars) allocBars(m.numBars);
      applySize(m.width, m.height);
      break;
    case 'RESIZE':
      isMobile = !!m.isMobile;
      if (m.numBars && m.numBars !== numBars) allocBars(m.numBars);
      applySize(m.width, m.height);
      break;
    case 'FRAME':
      pendingFrame = m.data || null;
      scheduleDraw();
      break;
    case 'BARS':
      latestBars = m.bars || null;
      hasSignal = !!latestBars;
      if (hasSignal) {
        silentFrames = 0;
        startAudienceLoop();
      }
      break;
    case 'CLEAR':
      stopAudienceLoop();
      latestBars = null;
      hasSignal = false;
      silentFrames = 0;
      for (let i = 0; i < numBars; i++) { bars[i] = 0; peaks[i] = 0; }
      if (ctx && w && h) ctx.clearRect(0, 0, w, h);
      break;
  }
};

function scheduleDraw() {
  if (drawScheduled) return;
  drawScheduled = true;
  const run = () => {
    drawScheduled = false;
    const data = pendingFrame;
    pendingFrame = null;
    drawAdmin(data);
  };
  if (typeof self.requestAnimationFrame === 'function') self.requestAnimationFrame(run);
  else setTimeout(run, 0);
}

function startAudienceLoop() {
  if (audienceTimer) return;
  audienceTimer = setInterval(drawAudience, 33); // 30 fps, matches host send rate
}

function stopAudienceLoop() {
  if (audienceTimer) {
    clearInterval(audienceTimer);
    audienceTimer = null;
  }
}

// ─── Admin (port of VisualizerRenderer.renderFrame) ──────────────────────────
function capsule(x, y, bw, bh, radius) {
  if (bh <= 0 || bw <= 0) return;
  const r = Math.min(radius, bw / 2, bh / 2);
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, bw, bh, [r, r, 2, 2]);
  } else {
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + bw, y, x + bw, y + bh, r);
    ctx.arcTo(x + bw, y + bh, x, y + bh, 2);
    ctx.arcTo(x, y + bh, x, y, 2);
    ctx.arcTo(x, y, x + bw, y, r);
    ctx.closePath();
  }
  ctx.fill();
}

function peakPill(x, y, bw, bh, radius) {
  if (bw <= 0 || bh <= 0) return;
  const r = Math.min(radius, bw / 2, bh / 2);
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, bw, bh, r);
  else ctx.arc(x + bw / 2, y + bh / 2, r, 0, Math.PI * 2);
  ctx.fill();
}

function drawAdmin(freq) {
  if (!ctx || !w || !h) return;
  const now = performance.now();
  const dt = lastTime ? Math.min(0.1, (now - lastTime) / 1000) : 0.016;
  lastTime = now;
  timeSec += dt;

  const baseLine = Math.round(h * 0.82);
  const maxBarH = Math.round(h * 0.70);

  let sig = false;
  if (freq) {
    let maxEnergy = 0;
    for (let k = 0; k < freq.length; k += 3) {
      if (freq[k] > maxEnergy) {
        maxEnergy = freq[k];
        if (maxEnergy > 2) { sig = true; break; }
      }
    }
  }
  if (!sig) silentFrames++; else silentFrames = 0;

  let currentBass = 0;
  if (sig && freq) {
    const bassBins = Math.min(6, freq.length);
    for (let b = 0; b < bassBins; b++) currentBass += freq[b] || 0;
    currentBass /= (bassBins * 255);
  }
  smoothedBass += (currentBass - smoothedBass) * (isMobile ? 0.35 : 0.25);

  if (silentFrames > 20) {
    ctx.clearRect(0, 0, w, h);
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(82, 196, 255, 0.16)';
    ctx.lineWidth = 1.5;
    ctx.moveTo(0, baseLine);
    const stepX = Math.max(8, Math.round(w / 40));
    for (let x = 0; x <= w; x += stepX) {
      const wave = Math.sin((x / w) * Math.PI * 4 + timeSec * 1.8) * 2.0;
      ctx.lineTo(x, baseLine + wave);
    }
    ctx.stroke();
    ctx.fillStyle = 'rgba(82, 196, 255, 0.35)';
    for (const d of [0.2, 0.5, 0.8]) {
      ctx.beginPath();
      ctx.arc(w * d, baseLine, 2, 0, Math.PI * 2);
      ctx.fill();
    }
    for (let i = 0; i < numBars; i++) { bars[i] = 0; peaks[i] = 0; }
    return;
  }

  ctx.clearRect(0, 0, w, h);

  if (smoothedBass > 0.15) {
    const auraIntensity = Math.min(0.24, (smoothedBass - 0.12) * 0.45);
    const auraRadius = Math.round(w * (0.22 + smoothedBass * 0.16));
    const g = ctx.createRadialGradient(w / 2, baseLine - 10, 0, w / 2, baseLine - 10, auraRadius);
    g.addColorStop(0, `rgba(82, 196, 255, ${auraIntensity.toFixed(3)})`);
    g.addColorStop(0.45, `rgba(39, 169, 255, ${(auraIntensity * 0.6).toFixed(3)})`);
    g.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(w / 2, baseLine - 10, auraRadius, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.beginPath();
  ctx.strokeStyle = 'rgba(82, 196, 255, 0.22)';
  ctx.lineWidth = 1.5;
  ctx.moveTo(0, baseLine);
  ctx.lineTo(w, baseLine);
  ctx.stroke();

  const barSpacing = w / numBars;
  const barWidth = Math.max(3, barSpacing * 0.68);
  const startX = (w - (numBars * barSpacing)) / 2;
  const capRadius = Math.max(2, Math.min(barWidth / 2, 4));
  const binCount = freq ? freq.length : 0;
  const attackRate = isMobile ? 0.75 : 0.65;
  const decayRate = isMobile ? 0.22 : 0.17;
  const gravity = isMobile ? 0.38 : 0.28;

  for (let i = 0; i < numBars; i++) {
    let targetNorm = 0;
    if (sig && binCount > 0) {
      const normIdx = i / (numBars - 1);
      const bin = Math.floor(Math.pow(normIdx, 1.35) * (binCount * 0.72));
      targetNorm = (freq[Math.max(0, Math.min(binCount - 1, bin))] || 0) / 255;
    }
    if (targetNorm > bars[i]) bars[i] += (targetNorm - bars[i]) * attackRate;
    else bars[i] -= (bars[i] - targetNorm) * decayRate;

    const barHeight = Math.max(0, Math.pow(bars[i], 1.35) * maxBarH);
    if (barHeight >= peaks[i]) {
      peaks[i] = barHeight;
      peakHold[i] = isMobile ? 4 : 7;
      peakSpeed[i] = 0;
    } else if (peakHold[i] > 0) {
      peakHold[i]--;
    } else {
      peakSpeed[i] += gravity;
      peaks[i] = Math.max(0, peaks[i] - peakSpeed[i]);
    }
  }

  if (!cachedGrad || cachedH !== h) {
    cachedH = h;
    cachedGrad = ctx.createLinearGradient(0, baseLine - maxBarH, 0, baseLine);
    cachedGrad.addColorStop(0, '#7fdcff');
    cachedGrad.addColorStop(0.32, '#27a9ff');
    cachedGrad.addColorStop(0.72, '#2f7cf6');
    cachedGrad.addColorStop(1, '#5b5cf0');
    cachedReflGrad = ctx.createLinearGradient(0, baseLine, 0, baseLine + Math.round(maxBarH * 0.35));
    cachedReflGrad.addColorStop(0, 'rgba(39, 169, 255, 0.22)');
    cachedReflGrad.addColorStop(0.5, 'rgba(47, 124, 246, 0.10)');
    cachedReflGrad.addColorStop(1, 'rgba(82, 196, 255, 0.0)');
  }

  ctx.fillStyle = cachedReflGrad;
  for (let i = 0; i < numBars; i++) {
    const bH = bars[i] * maxBarH;
    if (bH < 3) continue;
    const x = Math.round(startX + (i * barSpacing) + (barSpacing - barWidth) / 2);
    const reflH = Math.min(Math.round(bH * 0.32), Math.round(maxBarH * 0.3));
    capsule(x, baseLine + 1, barWidth, reflH, capRadius);
  }

  ctx.fillStyle = cachedGrad;
  for (let i = 0; i < numBars; i++) {
    const bH = Math.max(0, Math.pow(bars[i], 1.35) * maxBarH);
    if (bH < 1.5) continue;
    const x = Math.round(startX + (i * barSpacing) + (barSpacing - barWidth) / 2);
    capsule(x, Math.round(baseLine - bH), barWidth, bH, capRadius);
  }

  ctx.fillStyle = '#7fdcff';
  const peakDotH = Math.max(2.5, Math.min(barWidth * 0.42, 4));
  for (let i = 0; i < numBars; i++) {
    const pH = peaks[i];
    if (pH < 4) continue;
    const x = Math.round(startX + (i * barSpacing) + (barSpacing - barWidth) / 2);
    peakPill(x, Math.round(baseLine - pH - peakDotH - 2), barWidth, peakDotH, capRadius);
  }
}

// ─── Audience (port of AudienceVisualizerRenderer.renderFrame) ───────────────
function drawAudience() {
  if (!ctx || !w || !h) return;

  if (!hasSignal) silentFrames++; else silentFrames = 0;
  if (silentFrames > 20) {
    stopAudienceLoop();
    for (let i = 0; i < numBars; i++) { bars[i] = 0; peaks[i] = 0; }
    ctx.clearRect(0, 0, w, h);
    self.postMessage({ type: 'IDLE' });
    return;
  }

  ctx.clearRect(0, 0, w, h);

  const baseLine = Math.round(h * 0.82);
  const maxBarH = Math.round(h * 0.70);

  ctx.beginPath();
  ctx.strokeStyle = 'rgba(82, 196, 255, 0.22)';
  ctx.lineWidth = 1.5;
  ctx.moveTo(0, baseLine);
  ctx.lineTo(w, baseLine);
  ctx.stroke();

  const barSpacing = w / numBars;
  const barWidth = Math.max(2.5, barSpacing * 0.68);
  const startX = (w - (numBars * barSpacing)) / 2;
  const capRadius = Math.max(1.5, Math.min(barWidth / 2, 3));
  const attackRate = isMobile ? 0.75 : 0.65;
  const decayRate = isMobile ? 0.22 : 0.17;
  const gravity = isMobile ? 0.38 : 0.28;
  const inBars = latestBars;
  const inLen = inBars ? inBars.length : 0;

  for (let i = 0; i < numBars; i++) {
    let targetNorm = 0;
    if (hasSignal && inLen > 0) {
      const normIdx = i / (numBars - 1);
      const bin = Math.floor(Math.pow(normIdx, 1.35) * (inLen * 0.85));
      targetNorm = (inBars[Math.max(0, Math.min(inLen - 1, bin))] || 0) / 255;
    }
    if (targetNorm > bars[i]) bars[i] += (targetNorm - bars[i]) * attackRate;
    else bars[i] -= (bars[i] - targetNorm) * decayRate;

    const barHeight = Math.max(0, Math.pow(bars[i], 1.35) * maxBarH);
    if (barHeight >= peaks[i]) {
      peaks[i] = barHeight;
      peakHold[i] = isMobile ? 4 : 7;
      peakSpeed[i] = 0;
    } else if (peakHold[i] > 0) {
      peakHold[i]--;
    } else {
      peakSpeed[i] += gravity;
      peaks[i] = Math.max(0, peaks[i] - peakSpeed[i]);
    }
  }

  if (!cachedGrad || cachedH !== h) {
    cachedH = h;
    cachedGrad = ctx.createLinearGradient(0, baseLine - maxBarH, 0, baseLine);
    cachedGrad.addColorStop(0, '#7fdcff');
    cachedGrad.addColorStop(0.32, '#27a9ff');
    cachedGrad.addColorStop(0.72, '#2f7cf6');
    cachedGrad.addColorStop(1, '#5b5cf0');
    cachedReflGrad = ctx.createLinearGradient(0, baseLine, 0, baseLine + Math.round(maxBarH * 0.35));
    cachedReflGrad.addColorStop(0, 'rgba(39, 169, 255, 0.22)');
    cachedReflGrad.addColorStop(0.5, 'rgba(47, 124, 246, 0.10)');
    cachedReflGrad.addColorStop(1, 'rgba(82, 196, 255, 0.0)');
  }

  const hasRoundRect = typeof ctx.roundRect === 'function';

  ctx.fillStyle = cachedReflGrad;
  ctx.beginPath();
  let any = false;
  for (let i = 0; i < numBars; i++) {
    const bH = bars[i] * maxBarH;
    if (bH < 3) continue;
    const x = Math.round(startX + (i * barSpacing) + (barSpacing - barWidth) / 2);
    const reflH = Math.min(Math.round(bH * 0.32), Math.round(maxBarH * 0.3));
    const r = Math.min(capRadius, barWidth / 2, reflH / 2);
    if (hasRoundRect) ctx.roundRect(x, baseLine + 1, barWidth, reflH, [r, r, 1, 1]);
    else ctx.rect(x, baseLine + 1, barWidth, reflH);
    any = true;
  }
  if (any) ctx.fill();

  ctx.fillStyle = cachedGrad;
  ctx.beginPath();
  any = false;
  for (let i = 0; i < numBars; i++) {
    const bH = Math.max(0, Math.pow(bars[i], 1.35) * maxBarH);
    if (bH < 1.5) continue;
    const x = Math.round(startX + (i * barSpacing) + (barSpacing - barWidth) / 2);
    const r = Math.min(capRadius, barWidth / 2, bH / 2);
    if (hasRoundRect) ctx.roundRect(x, Math.round(baseLine - bH), barWidth, bH, [r, r, 1, 1]);
    else ctx.rect(x, Math.round(baseLine - bH), barWidth, bH);
    any = true;
  }
  if (any) ctx.fill();

  ctx.fillStyle = '#7fdcff';
  const peakDotH = Math.max(2, Math.min(barWidth * 0.42, 3));
  ctx.beginPath();
  any = false;
  for (let i = 0; i < numBars; i++) {
    const pH = peaks[i];
    if (pH < 4) continue;
    const x = Math.round(startX + (i * barSpacing) + (barSpacing - barWidth) / 2);
    const r = Math.min(capRadius, barWidth / 2, peakDotH / 2);
    if (hasRoundRect) ctx.roundRect(x, Math.round(baseLine - pH - peakDotH - 2), barWidth, peakDotH, r);
    else ctx.rect(x, Math.round(baseLine - pH - peakDotH - 2), barWidth, peakDotH);
    any = true;
  }
  if (any) ctx.fill();
}
