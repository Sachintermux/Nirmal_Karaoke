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

    // Output Quality & Canvas (Defaults to 480p 25fps for rock-solid performance on mobile & PC)
    this.quality = localStorage.getItem('nirmal_stream_quality') || '480p';
    this.width = 854;
    this.height = 480;
    this.targetFps = 25;

    this.canvas = document.createElement('canvas');
    this.setQuality(this.quality);
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

    // Real-Time Layout & Theme
    this.layout = 'spotlight'; // 'spotlight' | 'karaoke' | 'duet' | 'visualizer'
    this.theme = 'cyberpunk';   // 'cyberpunk' | 'sunset' | 'midnight' | 'emerald'

    // Live Modal Preview Monitor
    this._previewCanvas = null;
    this._previewCtx = null;

    this.loadSavedLayers();
  }

  setQuality(quality) {
    const configs = {
      '360p': { width: 640, height: 360, fps: 25 },
      '480p': { width: 854, height: 480, fps: 25 },
      '540p': { width: 960, height: 540, fps: 30 },
      '720p': { width: 1280, height: 720, fps: 30 }
    };
    const cfg = configs[quality] || configs['480p'];
    this.quality = quality;
    this.width = cfg.width;
    this.height = cfg.height;
    this.targetFps = cfg.fps;
    if (this.canvas) {
      this.canvas.width = this.width;
      this.canvas.height = this.height;
    }
    console.info(`[BroadcastCompositor] Resolution configured: ${this.width}x${this.height} @ ${this.targetFps}fps (${quality})`);
  }

  loadSavedLayers() {
    try {
      const savedLayers = localStorage.getItem('nirmal_broadcast_layers');
      if (savedLayers) this.layers = Object.assign(this.layers, JSON.parse(savedLayers));
      const savedLayout = localStorage.getItem('nirmal_broadcast_layout');
      if (savedLayout) this.layout = savedLayout;
      const savedTheme = localStorage.getItem('nirmal_broadcast_theme');
      if (savedTheme) this.theme = savedTheme;
    } catch (_) {}
  }

  saveLayers() {
    try {
      localStorage.setItem('nirmal_broadcast_layers', JSON.stringify(this.layers));
      localStorage.setItem('nirmal_broadcast_layout', this.layout);
      localStorage.setItem('nirmal_broadcast_theme', this.theme);
    } catch (_) {}
  }

  setLayer(layerName, enabled) {
    if (this.layers.hasOwnProperty(layerName)) {
      this.layers[layerName] = !!enabled;
      this.saveLayers();
    }
  }

  setLayout(layoutName) {
    const valid = ['spotlight', 'karaoke', 'duet', 'visualizer'];
    if (valid.includes(layoutName)) {
      this.layout = layoutName;
      this.saveLayers();
      console.info('[BroadcastCompositor] Layout switched to:', layoutName);
    }
  }

  setTheme(themeName) {
    const valid = ['cyberpunk', 'sunset', 'midnight', 'emerald'];
    if (valid.includes(themeName)) {
      this.theme = themeName;
      this.saveLayers();
      console.info('[BroadcastCompositor] Theme switched to:', themeName);
    }
  }

  attachPreview(canvasEl) {
    if (!canvasEl) return;
    this._previewCanvas = canvasEl;
    this._previewCtx = canvasEl.getContext('2d', { alpha: false });
    this.start();
  }

  detachPreview() {
    this._previewCanvas = null;
    this._previewCtx = null;
  }

  /**
   * Start rendering the broadcast stage loop
   * Uses an unthrottled Web Worker clock ticker so background tabs maintain consistent frame rate.
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

    const tickMs = Math.round(1000 / (this.targetFps || 25));

    // Create an unthrottled Web Worker clock ticker
    try {
      const workerBlob = new Blob([
        `let intervalId = null;
         self.onmessage = function(e) {
           const data = e.data;
           if (data && (data === 'start' || data.type === 'start')) {
             const ms = (data && data.ms) ? data.ms : 40;
             if (!intervalId) {
               intervalId = setInterval(function() { self.postMessage('tick'); }, ms);
             }
           } else if (data === 'stop' || (data && data.type === 'stop')) {
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
      this._worker.postMessage({ type: 'start', ms: tickMs });
    } catch (workerErr) {
      console.warn('[BroadcastCompositor] Web Worker clock fallback to setInterval:', workerErr);
      this._timer = setInterval(() => {
        if (this._isRunning) {
          this.drawScene();
        }
      }, tickMs);
    }
  }

  stop() {
    this._isRunning = false;
    if (this._videoTrack) {
      try { this._videoTrack.stop(); } catch (_) {}
      this._videoTrack = null;
    }
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
   * Constructs a new MediaStream so MediaRecorder reliably recognizes both tracks in Chromium.
   */
  getMediaStream(audioTrack) {
    this.start();
    this.drawScene();
    const fps = this.targetFps || 25;
    const canvasStream = this.canvas.captureStream(fps);
    this._videoTrack = canvasStream.getVideoTracks()[0] || null;

    const tracks = [];
    if (this._videoTrack) tracks.push(this._videoTrack);
    if (audioTrack) tracks.push(audioTrack);

    console.info(`[BroadcastCompositor] Combined stream created (${this.width}x${this.height} @ ${fps}fps) with ${tracks.length} tracks:`,
      tracks.map(t => `${t.kind}:${t.label || 'track'}`));

    return new MediaStream(tracks);
  }

  getThemeColors() {
    switch (this.theme) {
      case 'sunset':
        return {
          bg1: '#15081c', bg2: '#280c26', bg3: '#0f0516',
          accent1: '#ffaa00', accent2: '#ff3366',
          glow1: 'rgba(255, 170, 0, 0.12)', glow2: 'rgba(255, 51, 102, 0.10)',
          border: 'rgba(255, 170, 0, 0.45)', textGlow: '#ffaa00'
        };
      case 'midnight':
        return {
          bg1: '#030712', bg2: '#0b1329', bg3: '#020617',
          accent1: '#38bdf8', accent2: '#6366f1',
          glow1: 'rgba(56, 189, 248, 0.12)', glow2: 'rgba(99, 102, 241, 0.10)',
          border: 'rgba(56, 189, 248, 0.45)', textGlow: '#38bdf8'
        };
      case 'emerald':
        return {
          bg1: '#021a12', bg2: '#062e20', bg3: '#01120c',
          accent1: '#10b981', accent2: '#4ade80',
          glow1: 'rgba(16, 185, 129, 0.12)', glow2: 'rgba(74, 222, 128, 0.10)',
          border: 'rgba(16, 185, 129, 0.45)', textGlow: '#10b981'
        };
      case 'cyberpunk':
      default:
        return {
          bg1: '#0a0a14', bg2: '#120c1f', bg3: '#05070e',
          accent1: '#00e5ff', accent2: '#ff007f',
          glow1: 'rgba(0, 229, 255, 0.12)', glow2: 'rgba(255, 0, 128, 0.10)',
          border: 'rgba(0, 229, 255, 0.45)', textGlow: '#00e5ff'
        };
    }
  }

  drawScene() {
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    const time = performance.now() * 0.001;
    const colors = this.getThemeColors();

    // ─── 1. Background Stage Theme ───────────────────────────────────────────
    const grad = ctx.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, colors.bg1);
    grad.addColorStop(0.5, colors.bg2);
    grad.addColorStop(1, colors.bg3);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    // Dynamic ambient glow lights (Restricted to circle paths for massive CPU speedup on mobile)
    const pulse1 = Math.sin(time * 1.5) * (w * 0.02);
    const pulse2 = Math.cos(time * 1.2) * (h * 0.03);
    const r1 = Math.min(w, h) * 0.38;
    const cx1 = w * 0.2 + pulse1;
    const cy1 = h * 0.3 + pulse2;
    const glow1 = ctx.createRadialGradient(cx1, cy1, 10, cx1, cy1, r1);
    glow1.addColorStop(0, colors.glow1);
    glow1.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = glow1;
    ctx.beginPath();
    ctx.arc(cx1, cy1, r1, 0, Math.PI * 2);
    ctx.fill();

    const r2 = Math.min(w, h) * 0.42;
    const cx2 = w * 0.8 - pulse2;
    const cy2 = h * 0.4 + pulse1;
    const glow2 = ctx.createRadialGradient(cx2, cy2, 10, cx2, cy2, r2);
    glow2.addColorStop(0, colors.glow2);
    glow2.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = glow2;
    ctx.beginPath();
    ctx.arc(cx2, cy2, r2, 0, Math.PI * 2);
    ctx.fill();

    // ─── 2. Camera Feeds & DOM Metadata Cache (Refreshed every 350ms) ────────
    if (!this._lastDomScan || performance.now() - this._lastDomScan > 350) {
      this._lastDomScan = performance.now();
      this._cachedHostVideo = document.querySelector('#liveStageVideoGrid [data-is-admin="1"] video')
                           || document.querySelector('.stage-video-grid [data-is-admin="1"] video');
      this._cachedGuestVideo = document.querySelector('#liveStageVideoGrid [data-is-admin="0"] video')
                            || document.querySelector('.stage-video-grid [data-is-admin="0"] video');

      const activeEl = document.querySelector('.lyric-line.active');
      if (activeEl) {
        this._cachedCurrentLine = activeEl.textContent?.trim() || '';
        const nextEl = activeEl.nextElementSibling;
        this._cachedNextLine = (nextEl && nextEl.classList.contains('lyric-line')) ? (nextEl.textContent?.trim() || '') : '';
      } else {
        this._cachedCurrentLine = '♪ ♫ ♪ Nirmal Karaoke Live ♪ ♫ ♪';
        this._cachedNextLine = 'Sing along with your favorite tracks';
      }

      const titleEl = document.getElementById('nowPlayingTitle') || document.querySelector('.now-playing .title');
      this._cachedSongName = titleEl?.textContent?.trim() || 'Live Karaoke Session';
    }

    let hasHostCam = false;
    let hasGuestCam = false;

    const hostVideoCard = this._cachedHostVideo;
    const guestVideoCard = this._cachedGuestVideo;

    if (this.layers.hostCamera && hostVideoCard && hostVideoCard.videoWidth > 0 && !hostVideoCard.paused) {
      hasHostCam = true;
    }
    if (this.layers.guestCamera && guestVideoCard && guestVideoCard.videoWidth > 0 && !guestVideoCard.paused) {
      hasGuestCam = true;
    }

    const mode = this.layout || 'spotlight';

    if (mode !== 'visualizer') {
      const topY = Math.round(h * 0.13);
      if (mode === 'karaoke') {
        // Karaoke Focus Layout: Big central lyrics, camera in top-right Picture-in-Picture
        const pipW = Math.round(w * 0.25);
        const pipH = Math.round(pipW * 0.58);
        const pipX = w - pipW - Math.round(w * 0.03);
        if (hasHostCam) {
          this.drawVideoBox(ctx, hostVideoCard, pipX, topY, pipW, pipH, '🎤 SINGER PIP', colors);
        } else if (hasGuestCam) {
          this.drawVideoBox(ctx, guestVideoCard, pipX, topY, pipW, pipH, '👥 GUEST PIP', colors);
        }
      } else if (mode === 'duet' || (hasHostCam && hasGuestCam)) {
        // Duet Split Screen: Host on left, Guest on right
        const boxMargin = Math.round(w * 0.03);
        const gap = Math.round(w * 0.02);
        const boxW = Math.round((w - (boxMargin * 2) - gap) / 2);
        const boxH = Math.round(boxW * 0.6);
        if (hasHostCam) {
          this.drawVideoBox(ctx, hostVideoCard, boxMargin, topY, boxW, boxH, '🎤 HOST SINGER', colors);
        }
        if (hasGuestCam) {
          this.drawVideoBox(ctx, guestVideoCard, boxMargin + boxW + gap, topY, boxW, boxH, '👥 GUEST DUET', colors);
        }
      } else if (hasHostCam) {
        // Spotlight Layout: Center camera
        const boxW = Math.round(w * 0.48);
        const boxH = Math.round(boxW * 0.6);
        const boxX = Math.round((w - boxW) / 2);
        this.drawVideoBox(ctx, hostVideoCard, boxX, topY, boxW, boxH, '🎤 HOST SINGER', colors);
      } else if (hasGuestCam) {
        const boxW = Math.round(w * 0.48);
        const boxH = Math.round(boxW * 0.6);
        const boxX = Math.round((w - boxW) / 2);
        this.drawVideoBox(ctx, guestVideoCard, boxX, topY, boxW, boxH, '👥 GUEST DUET', colors);
      }
    }

    // ─── 3. Audio Visualizer Layer ────────────────────────────────────────────
    if (this.layers.visualizer) {
      this.drawVisualizer(ctx, w, h, (hasHostCam || hasGuestCam) && mode !== 'visualizer', colors, mode);
    }

    // ─── 4. Karaoke Lyrics Layer ──────────────────────────────────────────────
    if (this.layers.lyrics) {
      this.drawLyrics(ctx, w, h, (hasHostCam || hasGuestCam) && mode !== 'visualizer', colors, mode);
    }

    // ─── 5. Stage Header & Song Banner ────────────────────────────────────────
    if (this.layers.songBanner) {
      this.drawHeader(ctx, w, h, colors);
    }

    // ─── 6. Live Modal Preview Monitor Mirroring (Only when modal visible) ────
    if (this._previewCtx && this._previewCanvas && this._previewCanvas.offsetParent !== null) {
      try {
        this._previewCtx.drawImage(this.canvas, 0, 0, this._previewCanvas.width, this._previewCanvas.height);
      } catch (_) {}
    }
  }

  drawVideoBox(ctx, videoEl, x, y, width, height, label, colors) {
    const radius = Math.min(16, Math.max(8, Math.round(height * 0.05)));
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, radius);
    ctx.clip();

    try {
      ctx.drawImage(videoEl, x, y, width, height);
    } catch (_) {}

    // Dark gradient vignette at bottom of video
    const vigHeight = Math.round(height * 0.25);
    const vig = ctx.createLinearGradient(x, y + height - vigHeight, x, y + height);
    vig.addColorStop(0, 'rgba(0, 0, 0, 0)');
    vig.addColorStop(1, 'rgba(0, 0, 0, 0.85)');
    ctx.fillStyle = vig;
    ctx.fillRect(x, y + height - vigHeight, width, vigHeight);

    ctx.restore();

    // Border Glow
    ctx.save();
    ctx.strokeStyle = colors?.border || 'rgba(0, 229, 255, 0.45)';
    ctx.lineWidth = Math.max(2, Math.round(width * 0.005));
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, radius);
    ctx.stroke();

    // Label Badge
    const badgeW = Math.round(Math.min(140, width * 0.4));
    const badgeH = Math.round(Math.min(26, height * 0.12));
    const badgeX = x + Math.round(width * 0.03);
    const badgeY = y + height - badgeH - Math.round(height * 0.03);
    const badgeFont = Math.max(9, Math.round(badgeH * 0.46));

    ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
    ctx.beginPath();
    ctx.roundRect(badgeX, badgeY, badgeW, badgeH, 6);
    ctx.fill();
    ctx.fillStyle = colors?.accent1 || '#00e5ff';
    ctx.font = `bold ${badgeFont}px sans-serif`;
    ctx.fillText(label, badgeX + 8, badgeY + badgeH * 0.7);
    ctx.restore();
  }

  drawVisualizer(ctx, w, h, hasCameras, colors, mode) {
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

    const isVisMode = mode === 'visualizer';
    const isKaraokeMode = mode === 'karaoke';
    const numBars = isVisMode ? 64 : 48;
    const step = this._visDataArray ? Math.max(1, Math.floor(this._visDataArray.length / (numBars * 2))) : 1;
    
    let baseY = hasCameras ? Math.round(h * 0.68) : Math.round(h * 0.60);
    let maxBarHeight = Math.round(h * 0.17);

    if (isVisMode) {
      baseY = Math.round(h * 0.64);
      maxBarHeight = Math.round(h * 0.30);
    } else if (isKaraokeMode) {
      baseY = Math.round(h * 0.72);
      maxBarHeight = Math.round(h * 0.13);
    }

    const barSpacing = w / (numBars + 6);
    const barWidth = Math.max(3, barSpacing * 0.72);
    const startX = (w - (numBars * barSpacing)) / 2;
    const time = performance.now() * 0.001;

    ctx.save();
    const grad = ctx.createLinearGradient(0, baseY - maxBarHeight, 0, baseY);
    grad.addColorStop(0, colors?.accent1 || '#00e5ff');
    grad.addColorStop(0.5, '#a855f7');
    grad.addColorStop(1, colors?.accent2 || '#ff007f');
    ctx.fillStyle = grad;

    // Single-pass batched rectangle drawing (massively faster than 64 separate fills)
    ctx.beginPath();
    for (let i = 0; i < numBars; i++) {
      let val = (this._visDataArray && hasSignal) ? (this._visDataArray[i * step] || 0) : 0;
      if (!hasSignal) {
        val = Math.floor((Math.sin(i * 0.22 + time * 2.8) * 0.5 + 0.5) * 55 + 12);
      }
      const barHeight = Math.max(3, (val / 255) * maxBarHeight);
      const x = startX + (i * barSpacing);
      const y = baseY - barHeight;

      ctx.roundRect(x, y, barWidth, barHeight, 2);
    }
    ctx.fill();
    ctx.restore();
  }

  drawLyrics(ctx, w, h, hasCameras, colors, mode) {
    const currentLine = this._cachedCurrentLine || '♪ ♫ ♪ Nirmal Karaoke Live ♪ ♫ ♪';
    const nextLine = this._cachedNextLine || 'Sing along with your favorite tracks';

    const isKaraokeMode = mode === 'karaoke';
    const isVisMode = mode === 'visualizer';
    let y = hasCameras ? Math.round(h * 0.76) : Math.round(h * 0.72);
    let mainFontSize = Math.round(Math.max(16, h * 0.048));
    let nextFontSize = Math.round(Math.max(12, h * 0.030));

    if (isKaraokeMode) {
      y = Math.round(h * 0.44);
      mainFontSize = Math.round(Math.max(20, h * 0.065));
      nextFontSize = Math.round(Math.max(14, h * 0.038));
    } else if (isVisMode) {
      y = Math.round(h * 0.74);
      mainFontSize = Math.round(Math.max(18, h * 0.052));
      nextFontSize = Math.round(Math.max(13, h * 0.032));
    }

    ctx.save();
    ctx.textAlign = 'center';

    // Highlight Pill Box for Active Lyric
    if (currentLine) {
      ctx.font = `bold ${mainFontSize}px sans-serif`;
      const textMetrics = ctx.measureText(currentLine);
      const pillW = Math.min(w - 40, Math.max(Math.round(w * 0.4), textMetrics.width + Math.round(w * 0.05)));
      const pillH = mainFontSize + Math.round(h * 0.045);

      ctx.fillStyle = 'rgba(8, 12, 24, 0.88)';
      ctx.strokeStyle = colors?.border || 'rgba(0, 229, 255, 0.5)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect((w - pillW) / 2, y, pillW, pillH, 12);
      ctx.fill();
      ctx.stroke();

      // Current Line Typography
      ctx.fillStyle = '#ffffff';
      ctx.fillText(currentLine, w / 2, y + mainFontSize + Math.round(pillH * 0.12));
    }

    // Next Line Preview
    if (nextLine) {
      ctx.font = `600 ${nextFontSize}px sans-serif`;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.65)';
      ctx.fillText(nextLine, w / 2, y + mainFontSize + Math.round(h * 0.06));
    }

    ctx.restore();
  }

  drawHeader(ctx, w, h, colors) {
    const time = performance.now() * 0.001;
    const headerH = Math.round(Math.max(42, h * 0.095));
    ctx.save();

    // Top Header Bar
    ctx.fillStyle = 'rgba(5, 5, 15, 0.85)';
    ctx.fillRect(0, 0, w, headerH);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, headerH);
    ctx.lineTo(w, headerH);
    ctx.stroke();

    const titleSize = Math.round(Math.max(14, h * 0.032));
    const tagSize = Math.round(Math.max(10, h * 0.020));
    const songSize = Math.round(Math.max(11, h * 0.024));

    // Brand Logo & Live Badge
    ctx.textAlign = 'left';
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${titleSize}px sans-serif`;
    ctx.fillText('🎤 NIRMAL KARAOKE', 20, headerH * 0.62);

    const brandMetrics = ctx.measureText('🎤 NIRMAL KARAOKE');
    const badgeX = 20 + brandMetrics.width + 16;

    // Live Dot & Tag with pulsating brightness
    const dotAlpha = 0.65 + 0.35 * Math.sin(time * 5);
    ctx.fillStyle = `rgba(255, 0, 85, ${dotAlpha})`;
    ctx.beginPath();
    ctx.arc(badgeX, headerH * 0.54, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ff0055';
    ctx.font = `bold ${tagSize}px sans-serif`;
    ctx.fillText('LIVE BROADCAST', badgeX + 10, headerH * 0.62);

    // Song Title / Track Info on Right (Cached)
    const songName = this._cachedSongName || 'Live Karaoke Session';

    ctx.textAlign = 'right';
    ctx.fillStyle = colors?.accent1 || '#00e5ff';
    ctx.font = `bold ${songSize}px sans-serif`;
    ctx.fillText('♫ ' + songName.slice(0, 38), w - 20, headerH * 0.62);

    ctx.restore();

    // Explicit frame capture on canvas video track if supported
    if (this._videoTrack && typeof this._videoTrack.requestFrame === 'function') {
      try { this._videoTrack.requestFrame(); } catch (_) {}
    }
  }
}
