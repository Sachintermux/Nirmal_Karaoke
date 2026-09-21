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

    // Real-Time Layout & Theme
    this.layout = 'spotlight'; // 'spotlight' | 'karaoke' | 'duet' | 'visualizer'
    this.theme = 'cyberpunk';   // 'cyberpunk' | 'sunset' | 'midnight' | 'emerald'

    // Live Modal Preview Monitor
    this._previewCanvas = null;
    this._previewCtx = null;

    this.loadSavedLayers();
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
   * Constructs a new MediaStream so MediaRecorder reliably recognizes both tracks in Chromium.
   */
  getMediaStream(audioTrack) {
    this.start();
    this.drawScene();
    const canvasStream = this.canvas.captureStream(30);
    this._videoTrack = canvasStream.getVideoTracks()[0] || null;

    const tracks = [];
    if (this._videoTrack) tracks.push(this._videoTrack);
    if (audioTrack) tracks.push(audioTrack);

    console.info(`[BroadcastCompositor] Combined stream created with ${tracks.length} tracks:`,
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

    // Dynamic ambient glow lights
    const pulse1 = Math.sin(time * 1.5) * 25;
    const pulse2 = Math.cos(time * 1.2) * 25;
    const glow1 = ctx.createRadialGradient(w * 0.2 + pulse1, h * 0.3 + pulse2, 20, w * 0.2 + pulse1, h * 0.3 + pulse2, 420);
    glow1.addColorStop(0, colors.glow1);
    glow1.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = glow1;
    ctx.fillRect(0, 0, w, h);

    const glow2 = ctx.createRadialGradient(w * 0.8 - pulse2, h * 0.4 + pulse1, 20, w * 0.8 - pulse2, h * 0.4 + pulse1, 460);
    glow2.addColorStop(0, colors.glow2);
    glow2.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = glow2;
    ctx.fillRect(0, 0, w, h);

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
      if (mode === 'karaoke') {
        // Karaoke Focus Layout: Big central lyrics, camera in top-right Picture-in-Picture
        if (hasHostCam) {
          this.drawVideoBox(ctx, hostVideoCard, w - 340, 90, 310, 185, '🎤 SINGER PIP', colors);
        } else if (hasGuestCam) {
          this.drawVideoBox(ctx, guestVideoCard, w - 340, 90, 310, 185, '👥 GUEST PIP', colors);
        }
      } else if (mode === 'duet' || (hasHostCam && hasGuestCam)) {
        // Duet Split Screen: Host on left, Guest on right
        if (hasHostCam) {
          this.drawVideoBox(ctx, hostVideoCard, 40, 95, 580, 360, '🎤 HOST SINGER', colors);
        }
        if (hasGuestCam) {
          this.drawVideoBox(ctx, guestVideoCard, 660, 95, 580, 360, '👥 GUEST DUET', colors);
        }
      } else if (hasHostCam) {
        // Spotlight Layout: Center camera
        this.drawVideoBox(ctx, hostVideoCard, 340, 95, 600, 360, '🎤 HOST SINGER', colors);
      } else if (hasGuestCam) {
        this.drawVideoBox(ctx, guestVideoCard, 340, 95, 600, 360, '👥 GUEST DUET', colors);
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
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, 16);
    ctx.clip();

    try {
      ctx.drawImage(videoEl, x, y, width, height);
    } catch (_) {}

    // Dark gradient vignette at bottom of video
    const vig = ctx.createLinearGradient(x, y + height - 60, x, y + height);
    vig.addColorStop(0, 'rgba(0, 0, 0, 0)');
    vig.addColorStop(1, 'rgba(0, 0, 0, 0.85)');
    ctx.fillStyle = vig;
    ctx.fillRect(x, y + height - 60, width, 60);

    ctx.restore();

    // Border Glow
    ctx.save();
    ctx.strokeStyle = colors?.border || 'rgba(0, 229, 255, 0.45)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, 16);
    ctx.stroke();

    // Label Badge
    ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
    ctx.beginPath();
    ctx.roundRect(x + 14, y + height - 38, 140, 26, 6);
    ctx.fill();
    ctx.fillStyle = colors?.accent1 || '#00e5ff';
    ctx.font = 'bold 12px sans-serif';
    ctx.fillText(label, x + 24, y + height - 21);
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
    const numBars = isVisMode ? 96 : 64;
    const step = this._visDataArray ? Math.max(1, Math.floor(this._visDataArray.length / (numBars * 2))) : 1;
    
    let baseY = hasCameras ? 490 : 430;
    let maxBarHeight = 110;

    if (isVisMode) {
      baseY = 460;
      maxBarHeight = 220;
    } else if (isKaraokeMode) {
      baseY = 520;
      maxBarHeight = 90;
    }

    const barSpacing = w / (numBars + 8);
    const barWidth = Math.max(4, barSpacing * 0.72);
    const startX = (w - (numBars * barSpacing)) / 2;
    const time = performance.now() * 0.001;

    ctx.save();
    const grad = ctx.createLinearGradient(0, baseY - maxBarHeight, 0, baseY);
    grad.addColorStop(0, colors?.accent1 || '#00e5ff');
    grad.addColorStop(0.5, '#a855f7');
    grad.addColorStop(1, colors?.accent2 || '#ff007f');
    ctx.fillStyle = grad;

    for (let i = 0; i < numBars; i++) {
      let val = (this._visDataArray && hasSignal) ? (this._visDataArray[i * step] || 0) : 0;
      if (!hasSignal) {
        val = Math.floor((Math.sin(i * 0.22 + time * 2.8) * 0.5 + 0.5) * 55 + 12);
      }
      const barHeight = Math.max(4, (val / 255) * maxBarHeight);
      const x = startX + (i * barSpacing);
      const y = baseY - barHeight;

      ctx.beginPath();
      ctx.roundRect(x, y, barWidth, barHeight, 3);
      ctx.fill();
    }
    ctx.restore();
  }

  drawLyrics(ctx, w, h, hasCameras, colors, mode) {
    const currentLine = this._cachedCurrentLine || '♪ ♫ ♪ Nirmal Karaoke Live ♪ ♫ ♪';
    const nextLine = this._cachedNextLine || 'Sing along with your favorite tracks';

    const isKaraokeMode = mode === 'karaoke';
    const isVisMode = mode === 'visualizer';
    let y = hasCameras ? 560 : 540;
    let mainFontSize = 32;
    let nextFontSize = 20;

    if (isKaraokeMode) {
      y = 310;
      mainFontSize = 42;
      nextFontSize = 24;
    } else if (isVisMode) {
      y = 530;
      mainFontSize = 36;
      nextFontSize = 22;
    }

    ctx.save();
    ctx.textAlign = 'center';

    // Highlight Pill Box for Active Lyric
    if (currentLine) {
      ctx.font = `bold ${mainFontSize}px sans-serif`;
      const textMetrics = ctx.measureText(currentLine);
      const pillW = Math.min(w - 60, Math.max(340, textMetrics.width + 48));
      const pillH = mainFontSize + 32;

      ctx.fillStyle = 'rgba(8, 12, 24, 0.88)';
      ctx.strokeStyle = colors?.border || 'rgba(0, 229, 255, 0.5)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect((w - pillW) / 2, y, pillW, pillH, 14);
      ctx.fill();
      ctx.stroke();

      // Current Line Typography (Clean high-contrast render without expensive Gaussian shadow blur)
      ctx.fillStyle = '#ffffff';
      ctx.fillText(currentLine, w / 2, y + mainFontSize + 8);
    }

    // Next Line Preview
    if (nextLine) {
      ctx.font = `600 ${nextFontSize}px sans-serif`;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.65)';
      ctx.fillText(nextLine, w / 2, y + mainFontSize + 45);
    }

    ctx.restore();
  }

  drawHeader(ctx, w, h, colors) {
    const time = performance.now() * 0.001;
    ctx.save();

    // Top Header Bar
    ctx.fillStyle = 'rgba(5, 5, 15, 0.82)';
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

    // Song Title / Track Info on Right (Cached)
    const songName = this._cachedSongName || 'Live Karaoke Session';

    ctx.textAlign = 'right';
    ctx.fillStyle = colors?.accent1 || '#00e5ff';
    ctx.font = 'bold 16px sans-serif';
    ctx.fillText('♫ ' + songName.slice(0, 45), w - 30, 42);

    ctx.restore();

    // Explicit frame capture on canvas video track if supported
    if (this._videoTrack && typeof this._videoTrack.requestFrame === 'function') {
      try { this._videoTrack.requestFrame(); } catch (_) {}
    }
  }
}
