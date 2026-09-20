/**
 * Broadcast Scene Compositor for Nirmal Karaoke
 * Renders an HD 1280x720 @ 30 FPS stage canvas in real-time.
 * Composites:
 *   1. Stage Gradient / Theme Background
 *   2. Host Camera (with Face Filters if active)
 *   3. Remote Guest Duet Camera (if duetting)
 *   4. Dynamic Audio Visualizer (Spectrum Equalizer Bars)
 *   5. Synchronized Karaoke Highlighted Lyrics (Current & Next Line)
 *   6. Now Playing Song Banner & Live Status Header
 */

export class BroadcastCompositor {
  constructor(audioEngine, liveHost, lyricsManager) {
    this.audioEngine = audioEngine;
    this.liveHost = liveHost;
    this.lyricsManager = lyricsManager;

    // Output Canvas (1280x720 16:9 HD standard)
    this.width = 1280;
    this.height = 720;
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    this.ctx = this.canvas.getContext('2d', { alpha: false });

    this._rafId = null;
    this._isRunning = false;
    this._visDataArray = null;

    // Configurable Scene Layers
    this.layers = {
      visualizer: true,
      lyrics: true,
      hostCamera: true,
      guestCamera: true,
      songBanner: true
    };

    this.loadSavedLayers();
  }

  loadSavedLayers() {
    try {
      const saved = localStorage.getItem('nirmal_broadcast_layers');
      if (saved) {
        this.layers = Object.assign(this.layers, JSON.parse(saved));
      }
    } catch (_) {}
  }

  saveLayers() {
    try {
      localStorage.setItem('nirmal_broadcast_layers', JSON.stringify(this.layers));
    } catch (_) {}
  }

  setLayer(layerName, enabled) {
    if (this.layers.hasOwnProperty(layerName)) {
      this.layers[layerName] = !!enabled;
      this.saveLayers();
    }
  }

  /**
   * Start rendering the 30 FPS broadcast stage loop
   * Uses an unthrottled Web Worker clock ticker so background tabs never drop below 30 FPS.
   */
  start() {
    if (this._isRunning) return;
    this._isRunning = true;

    // Attach canvas to DOM in hidden offscreen position for hardware acceleration
    if (!this.canvas.parentElement && typeof document !== 'undefined' && document.body) {
      this.canvas.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:320px;height:180px;pointer-events:none;opacity:0.01;z-index:-999;';
      document.body.appendChild(this.canvas);
    }

    // Draw initial frame immediately
    this.drawScene();

    // Create an unthrottled Web Worker 33.3ms (30 FPS) clock ticker
    try {
      const workerBlob = new Blob([
        `let intervalId = null;
         self.onmessage = function(e) {
           if (e.data === 'start') {
             if (!intervalId) {
               intervalId = setInterval(function() { self.postMessage('tick'); }, 33);
             }
           } else if (e.data === 'stop') {
             if (intervalId) { clearInterval(intervalId); intervalId = null; }
           }
         };`
      ], { type: 'application/javascript' });
      this._workerUrl = URL.createObjectURL(workerBlob);
      this._worker = new Worker(this._workerUrl);
      this._worker.onmessage = () => {
        if (this._isRunning) {
          this.drawScene();
        }
      };
      this._worker.postMessage('start');
    } catch (workerErr) {
      console.warn('[BroadcastCompositor] Web Worker clock fallback to setInterval:', workerErr);
      this._timer = setInterval(() => {
        if (this._isRunning) {
          this.drawScene();
        }
      }, 33);
    }
  }

  stop() {
    this._isRunning = false;
    this._videoTrack = null;
    if (this._worker) {
      try {
        this._worker.postMessage('stop');
        this._worker.terminate();
      } catch (_) {}
      this._worker = null;
    }
    if (this._workerUrl) {
      try { URL.revokeObjectURL(this._workerUrl); } catch (_) {}
      this._workerUrl = null;
    }
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    if (this.canvas.parentElement) {
      try { this.canvas.parentElement.removeChild(this.canvas); } catch (_) {}
    }
  }

  /**
   * Generates a combined MediaStream (Canvas Video + Mixed Stereo Audio)
   */
  getMediaStream(audioTrack) {
    this.start();
    this.drawScene();
    const stream = this.canvas.captureStream(30);
    this._videoTrack = stream.getVideoTracks()[0] || null;
    if (audioTrack) {
      stream.addTrack(audioTrack);
    }
    return stream;
  }

  drawScene() {
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    const time = performance.now() * 0.001;

    // ─── 1. Background Stage ──────────────────────────────────────────────────
    const grad = ctx.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, '#0a0a14');
    grad.addColorStop(0.5, '#120c1f');
    grad.addColorStop(1, '#05070e');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    // Subtle dynamic ambient glow circles (animated coordinates keep canvas dirty & video clock running)
    const pulse1 = Math.sin(time * 1.5) * 25;
    const pulse2 = Math.cos(time * 1.2) * 25;
    const glow1 = ctx.createRadialGradient(w * 0.2 + pulse1, h * 0.3 + pulse2, 20, w * 0.2 + pulse1, h * 0.3 + pulse2, 420);
    glow1.addColorStop(0, 'rgba(0, 229, 255, 0.12)');
    glow1.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = glow1;
    ctx.fillRect(0, 0, w, h);

    const glow2 = ctx.createRadialGradient(w * 0.8 - pulse2, h * 0.4 + pulse1, 20, w * 0.8 - pulse2, h * 0.4 + pulse1, 460);
    glow2.addColorStop(0, 'rgba(255, 0, 128, 0.10)');
    glow2.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = glow2;
    ctx.fillRect(0, 0, w, h);

    // ─── 2. Camera Feeds (Host & Guest) ───────────────────────────────────────
    let hasHostCam = false;
    let hasGuestCam = false;

    // Find host video element in DOM
    const hostVideoCard = document.querySelector('#liveStageVideoGrid [data-is-admin="1"] video');
    const guestVideoCards = Array.from(document.querySelectorAll('#liveStageVideoGrid [data-is-admin="0"] video'));

    if (this.layers.hostCamera && hostVideoCard && hostVideoCard.videoWidth > 0 && !hostVideoCard.paused) {
      hasHostCam = true;
    }
    if (this.layers.guestCamera && guestVideoCards.length > 0 && guestVideoCards[0].videoWidth > 0 && !guestVideoCards[0].paused) {
      hasGuestCam = true;
    }

    if (hasHostCam && hasGuestCam) {
      // Split Screen: Host on left, Guest on right
      this.drawVideoBox(ctx, hostVideoCard, 40, 100, 580, 360, '🎤 HOST SINGER');
      this.drawVideoBox(ctx, guestVideoCards[0], 660, 100, 580, 360, '👥 GUEST DUET');
    } else if (hasHostCam) {
      // Single Host Camera (Center Top)
      this.drawVideoBox(ctx, hostVideoCard, 340, 100, 600, 360, '🎤 HOST SINGER');
    } else if (hasGuestCam) {
      // Single Guest Camera
      this.drawVideoBox(ctx, guestVideoCards[0], 340, 100, 600, 360, '👥 GUEST DUET');
    }

    // ─── 3. Audio Visualizer Layer ────────────────────────────────────────────
    if (this.layers.visualizer) {
      this.drawVisualizer(ctx, w, h, hasHostCam || hasGuestCam);
    }

    // ─── 4. Karaoke Lyrics Layer ──────────────────────────────────────────────
    if (this.layers.lyrics) {
      this.drawLyrics(ctx, w, h, hasHostCam || hasGuestCam);
    }

    // ─── 5. Stage Header & Song Banner ────────────────────────────────────────
    if (this.layers.songBanner) {
      this.drawHeader(ctx, w, h);
    }
  }

  drawVideoBox(ctx, videoEl, x, y, width, height, label) {
    ctx.save();
    // Rounded Card Background & Border
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, 16);
    ctx.clip();

    try {
      ctx.drawImage(videoEl, x, y, width, height);
    } catch (_) {}

    // Subtle dark gradient vignette at bottom of video
    const vig = ctx.createLinearGradient(x, y + height - 60, x, y + height);
    vig.addColorStop(0, 'rgba(0, 0, 0, 0)');
    vig.addColorStop(1, 'rgba(0, 0, 0, 0.85)');
    ctx.fillStyle = vig;
    ctx.fillRect(x, y + height - 60, width, 60);

    ctx.restore();

    // Border Glow
    ctx.save();
    ctx.strokeStyle = 'rgba(0, 229, 255, 0.4)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, 16);
    ctx.stroke();

    // Label Badge
    ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
    ctx.beginPath();
    ctx.roundRect(x + 14, y + height - 38, 140, 26, 6);
    ctx.fill();
    ctx.fillStyle = '#00e5ff';
    ctx.font = 'bold 12px sans-serif';
    ctx.fillText(label, x + 24, y + height - 21);
    ctx.restore();
  }

  drawVisualizer(ctx, w, h, hasCameras) {
    const engine = this.audioEngine?.engine;
    let hasSignal = false;

    if (engine?.analyser) {
      if (!this._visDataArray) {
        this._visDataArray = new Uint8Array(engine.analyser.frequencyBinCount);
      }
      engine.analyser.getByteFrequencyData(this._visDataArray);
      for (let i = 0; i < Math.min(32, this._visDataArray.length); i++) {
        if (this._visDataArray[i] > 2) { hasSignal = true; break; }
      }
    }

    const numBars = 64;
    const step = this._visDataArray ? Math.max(1, Math.floor(this._visDataArray.length / (numBars * 2))) : 1;
    const baseY = hasCameras ? 490 : 420;
    const barSpacing = w / (numBars + 8);
    const barWidth = Math.max(4, barSpacing * 0.7);
    const startX = (w - (numBars * barSpacing)) / 2;
    const time = performance.now() * 0.001;

    ctx.save();
    const grad = ctx.createLinearGradient(0, baseY - 120, 0, baseY);
    grad.addColorStop(0, '#00e5ff');
    grad.addColorStop(0.5, '#a855f7');
    grad.addColorStop(1, '#ff007f');
    ctx.fillStyle = grad;

    for (let i = 0; i < numBars; i++) {
      let val = (this._visDataArray && hasSignal) ? (this._visDataArray[i * step] || 0) : 0;
      if (!hasSignal) {
        // Idle ambient equalizer wave: continuously animates dirty rect & keeps video encoder warm
        val = Math.floor((Math.sin(i * 0.22 + time * 2.8) * 0.5 + 0.5) * 55 + 12);
      }
      const barHeight = Math.max(4, (val / 255) * 110);
      const x = startX + (i * barSpacing);
      const y = baseY - barHeight;

      ctx.beginPath();
      ctx.roundRect(x, y, barWidth, barHeight, 3);
      ctx.fill();
    }
    ctx.restore();
  }

  drawLyrics(ctx, w, h, hasCameras) {
    let currentLine = '';
    let nextLine = '';

    // Extract active lyric text from DOM or LyricsManager
    const activeEl = document.querySelector('.lyric-line.active');
    if (activeEl) {
      currentLine = activeEl.textContent?.trim() || '';
      const nextEl = activeEl.nextElementSibling;
      if (nextEl && nextEl.classList.contains('lyric-line')) {
        nextLine = nextEl.textContent?.trim() || '';
      }
    } else {
      currentLine = '♪ ♫ ♪ Nirmal Karaoke Stage ♪ ♫ ♪';
      nextLine = 'Sing along with your favorite tracks';
    }

    const y = hasCameras ? 560 : 540;

    ctx.save();
    ctx.textAlign = 'center';

    // Current Line Background Pill
    if (currentLine) {
      ctx.font = 'bold 32px sans-serif';
      const textWidth = ctx.measureText(currentLine).width;
      const pillW = Math.min(w - 80, textWidth + 60);
      const pillH = 58;

      ctx.fillStyle = 'rgba(10, 15, 30, 0.85)';
      ctx.strokeStyle = 'rgba(0, 229, 255, 0.5)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect((w - pillW) / 2, y, pillW, pillH, 14);
      ctx.fill();
      ctx.stroke();

      // Current Line Text Glow & Typography
      ctx.shadowColor = '#00e5ff';
      ctx.shadowBlur = 12;
      ctx.fillStyle = '#ffffff';
      ctx.fillText(currentLine, w / 2, y + 40);
    }

    // Next Line (Preview below)
    if (nextLine) {
      ctx.shadowBlur = 0;
      ctx.font = '600 20px sans-serif';
      ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
      ctx.fillText(nextLine, w / 2, y + 90);
    }

    ctx.restore();
  }

  drawHeader(ctx, w, h) {
    const time = performance.now() * 0.001;
    ctx.save();

    // Top Header Bar
    ctx.fillStyle = 'rgba(5, 5, 15, 0.75)';
    ctx.fillRect(0, 0, w, 68);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, 68);
    ctx.lineTo(w, 68);
    ctx.stroke();

    // Brand Logo & Live Badge
    ctx.textAlign = 'left';
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 22px sans-serif';
    ctx.fillText('🎤 NIRMAL KARAOKE', 30, 42);

    // Live Dot & Tag with pulsating brightness
    const dotAlpha = 0.65 + 0.35 * Math.sin(time * 5);
    ctx.fillStyle = `rgba(255, 0, 85, ${dotAlpha})`;
    ctx.beginPath();
    ctx.arc(280, 36, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ff0055';
    ctx.font = 'bold 13px sans-serif';
    ctx.fillText('LIVE BROADCAST', 294, 41);

    // Song Title / Track Info on Right
    const titleEl = document.getElementById('hudNote') || document.querySelector('.now-playing .title');
    const songName = titleEl?.textContent?.trim() || 'Live Singing Session';

    ctx.textAlign = 'right';
    ctx.fillStyle = '#00e5ff';
    ctx.font = 'bold 16px sans-serif';
    ctx.fillText('♫ ' + songName.slice(0, 45), w - 30, 42);

    ctx.restore();

    // Trigger explicit frame capture on canvas video track if supported
    if (this._videoTrack && typeof this._videoTrack.requestFrame === 'function') {
      try { this._videoTrack.requestFrame(); } catch (_) {}
    }
  }
}
