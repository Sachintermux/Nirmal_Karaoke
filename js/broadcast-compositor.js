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
    this.layout = 'spotlight'; // 'spotlight' | 'karaoke' | 'duet' | 'visualizer' | 'custom'
    this.theme = 'cyberpunk';   // 'cyberpunk' | 'sunset' | 'midnight' | 'emerald'

    // Configurable OBS Studio Canvas Scene Elements (Normalized 0.0 - 1.0)
    this.obsSources = this.loadSavedObsSources();

    // Live Modal Preview Monitor
    this._previewCanvas = null;
    this._previewCtx = null;

    this.loadSavedLayers();
  }

  getDefaultObsSources() {
    return {
      hostCamera: { id: 'hostCamera', name: '🎤 Host Camera', x: 0.04, y: 0.12, w: 0.44, h: 0.46, visible: true, zIndex: 2 },
      guestCamera: { id: 'guestCamera', name: '👥 Guest Stage', x: 0.52, y: 0.12, w: 0.44, h: 0.46, visible: true, zIndex: 2 },
      lyrics: { id: 'lyrics', name: '📜 Karaoke Lyrics', x: 0.08, y: 0.62, w: 0.84, h: 0.18, visible: true, zIndex: 3 },
      visualizer: { id: 'visualizer', name: '📊 Audio Spectrum', x: 0.04, y: 0.82, w: 0.92, h: 0.11, visible: true, zIndex: 1 },
      songBanner: { id: 'songBanner', name: '🏷️ Song Banner', x: 0.0, y: 0.0, w: 1.0, h: 0.09, visible: true, zIndex: 4 },
      socialTicker: { id: 'socialTicker', name: '📣 Artist Ticker', x: 0.0, y: 0.94, w: 1.0, h: 0.06, visible: true, zIndex: 5, text: '🎤 Nirmal Karaoke Live Studio • Request songs in live chat! • Enjoy the music' }
    };
  }

  loadSavedObsSources() {
    const defaults = this.getDefaultObsSources();
    try {
      const raw = localStorage.getItem('nirmal_broadcast_obs_sources');
      if (raw) {
        const parsed = JSON.parse(raw);
        return Object.assign(defaults, parsed);
      }
    } catch (_) {}
    return defaults;
  }

  saveObsSources() {
    try {
      localStorage.setItem('nirmal_broadcast_obs_sources', JSON.stringify(this.obsSources));
    } catch (_) {}
  }

  updateObsSource(id, coords) {
    if (this.obsSources && this.obsSources[id]) {
      Object.assign(this.obsSources[id], coords);
      this.saveObsSources();
    }
  }

  resetObsSources() {
    this.obsSources = this.getDefaultObsSources();
    this.saveObsSources();
  }

  setTickerText(text) {
    if (this.obsSources && this.obsSources.socialTicker) {
      this.obsSources.socialTicker.text = String(text || '').trim() || '🎤 Live Performance • Nirmal Karaoke Studio';
      this.saveObsSources();
    }
  }

  setLayout(layoutName) {
    const valid = ['spotlight', 'karaoke', 'duet', 'visualizer', 'custom'];
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
    if (this._canvasStream) {
      try {
        this._canvasStream.getTracks().forEach(t => {
          try { t.stop(); } catch (_) {}
        });
      } catch (_) {}
      this._canvasStream = null;
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
    this._canvasStream = canvasStream;
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

      // Scan Host Card
      const hostCard = document.querySelector('#liveStageVideoGrid [data-is-admin="1"], .stage-video-grid [data-is-admin="1"]');
      const hostVideo = hostCard?.querySelector('video') || null;
      const hostLabel = hostCard?.querySelector('.video-badge')?.textContent?.replace(/🎤/g, '')?.trim() || 'HOST (YOU)';
      this._cachedHost = hostVideo ? { video: hostVideo, label: `🎤 ${hostLabel}`, isAdmin: true } : null;

      // Scan up to 3 Guest Cards
      const allGuestCards = Array.from(document.querySelectorAll('#liveStageVideoGrid [data-is-admin="0"], .stage-video-grid [data-is-admin="0"], #liveStageVideoGrid .stage-video-card:not([data-is-admin="1"]), .stage-video-grid .stage-video-card:not([data-is-admin="1"])'));
      const uniqueGuestCards = allGuestCards.filter(c => c !== hostCard && c.querySelector('video'));
      this._cachedGuests = uniqueGuestCards.slice(0, 3).map((card, idx) => {
        const video = card.querySelector('video');
        const badgeText = card.querySelector('.video-badge')?.textContent?.replace(/🎤/g, '')?.trim();
        return {
          video,
          label: badgeText ? `🎤 ${badgeText}` : `👥 GUEST ${idx + 1}`,
          isAdmin: false
        };
      });

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

    const activeBoxes = [];
    if (this.layers.hostCamera && this._cachedHost?.video) {
      const v = this._cachedHost.video;
      if (v.videoWidth > 0 && !v.paused) {
        activeBoxes.push(this._cachedHost);
      }
    }
    if (this.layers.guestCamera && this._cachedGuests?.length) {
      for (const g of this._cachedGuests) {
        if (activeBoxes.length >= 4) break;
        if (g.video && g.video.videoWidth > 0 && !g.video.paused) {
          activeBoxes.push(g);
        }
      }
    }
    const numCams = activeBoxes.length;

    const mode = this.layout || 'spotlight';

    if (mode === 'custom') {
      // ─── OBS Studio Modular Custom Scene Layout ─────────────────────────────
      this.drawObsCustomScene(ctx, w, h, colors, activeBoxes);
    } else {
      // ─── Standard Presets (Spotlight, Karaoke, Duet, Visualizer) ────────────
      if (mode !== 'visualizer' && numCams > 0) {
        const topY = Math.round(h * 0.12);

        if (mode === 'karaoke') {
          // Karaoke Focus Layout: Big central lyrics, camera(s) in top-right Picture-in-Picture
          if (numCams === 1) {
            const pipW = Math.round(w * 0.25);
            const pipH = Math.round(pipW * 0.58);
            const pipX = w - pipW - Math.round(w * 0.03);
            this.drawVideoBox(ctx, activeBoxes[0].video, pipX, topY, pipW, pipH, activeBoxes[0].label, colors);
          } else {
            const pipGap = Math.round(w * 0.01);
            const pipW = Math.round(Math.min(w * 0.20, (w * 0.55 - (numCams * pipGap)) / numCams));
            const pipH = Math.round(pipW * 0.58);
            const totalPipW = numCams * pipW + (numCams - 1) * pipGap;
            const startPipX = w - totalPipW - Math.round(w * 0.03);
            activeBoxes.forEach((box, i) => {
              const bx = startPipX + i * (pipW + pipGap);
              this.drawVideoBox(ctx, box.video, bx, topY, pipW, pipH, box.label, colors);
            });
          }
        } else if (numCams === 1) {
          // 1 Camera: Spotlight Layout
          const boxW = Math.round(w * 0.48);
          const boxH = Math.round(boxW * 0.6);
          const boxX = Math.round((w - boxW) / 2);
          this.drawVideoBox(ctx, activeBoxes[0].video, boxX, topY, boxW, boxH, activeBoxes[0].label, colors);
        } else if (numCams === 2) {
          // 2 Cameras: 2-Box Split Side-by-Side (Host on left, Guest on right)
          const boxMargin = Math.round(w * 0.03);
          const gap = Math.round(w * 0.02);
          const boxW = Math.round((w - (boxMargin * 2) - gap) / 2);
          const boxH = Math.round(Math.min(boxW * 0.6, h * 0.48));
          this.drawVideoBox(ctx, activeBoxes[0].video, boxMargin, topY, boxW, boxH, activeBoxes[0].label, colors);
          this.drawVideoBox(ctx, activeBoxes[1].video, boxMargin + boxW + gap, topY, boxW, boxH, activeBoxes[1].label, colors);
        } else if (numCams === 3) {
          // 3 Cameras: 3-Box Panel Side-by-Side (1 Host + 2 Guests)
          const boxMargin = Math.round(w * 0.025);
          const gap = Math.round(w * 0.015);
          const boxW = Math.round((w - (boxMargin * 2) - (gap * 2)) / 3);
          const boxH = Math.round(Math.min(boxW * 0.65, h * 0.46));
          activeBoxes.forEach((box, i) => {
            const bx = boxMargin + i * (boxW + gap);
            this.drawVideoBox(ctx, box.video, bx, topY, boxW, boxH, box.label, colors);
          });
        } else if (numCams >= 4) {
          // 4 Cameras: 4-Box 2x2 Quad Grid (1 Host + 3 Guests)
          const boxMargin = Math.round(w * 0.03);
          const gapX = Math.round(w * 0.02);
          const gapY = Math.round(h * 0.015);
          const boxW = Math.round((w - (boxMargin * 2) - gapX) / 2);
          const boxH = Math.round(Math.min(boxW * 0.52, (h * 0.50 - gapY) / 2));
          activeBoxes.slice(0, 4).forEach((box, i) => {
            const row = Math.floor(i / 2);
            const col = i % 2;
            const bx = boxMargin + col * (boxW + gapX);
            const by = topY + row * (boxH + gapY);
            this.drawVideoBox(ctx, box.video, bx, by, boxW, boxH, box.label, colors);
          });
        }
      }

      // ─── 3. Audio Visualizer Layer ────────────────────────────────────────────
      if (this.layers.visualizer) {
        this.drawVisualizer(ctx, w, h, numCams > 0 && mode !== 'visualizer', colors, mode, numCams);
      }

      // ─── 4. Karaoke Lyrics Layer ──────────────────────────────────────────────
      if (this.layers.lyrics) {
        this.drawLyrics(ctx, w, h, numCams > 0 && mode !== 'visualizer', colors, mode, numCams);
      }

      // ─── 5. Stage Header & Song Banner ────────────────────────────────────────
      if (this.layers.songBanner) {
        this.drawHeader(ctx, w, h, colors);
      }
    }

    // ─── 6. Live Modal Preview Monitor Mirroring (Only when modal visible) ────
    if (this._previewCtx && this._previewCanvas && this._previewCanvas.offsetParent !== null) {
      try {
        this._previewCtx.drawImage(this.canvas, 0, 0, this._previewCanvas.width, this._previewCanvas.height);
      } catch (_) {}
    }

    // Guarantee unthrottled frame emission for captureStream even when tab is in background
    if (this._canvasStream && typeof this._canvasStream.requestFrame === 'function') {
      try { this._canvasStream.requestFrame(); } catch (_) {}
    }
    if (this._videoTrack && typeof this._videoTrack.requestFrame === 'function') {
      try { this._videoTrack.requestFrame(); } catch (_) {}
    }
  }

  drawObsCustomScene(ctx, w, h, colors, activeBoxes) {
    if (!this.obsSources) return;

    // Sort enabled sources by zIndex
    const sources = Object.values(this.obsSources)
      .filter(s => s && s.visible !== false)
      .sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0));

    for (const s of sources) {
      const sx = Math.round(s.x * w);
      const sy = Math.round(s.y * h);
      const sw = Math.round(s.w * w);
      const sh = Math.round(s.h * h);

      if (sw <= 10 || sh <= 10) continue;

      switch (s.id) {
        case 'hostCamera':
          if (this.layers.hostCamera !== false) {
            if (activeBoxes.length > 0 && activeBoxes[0].video) {
              this.drawVideoBox(ctx, activeBoxes[0].video, sx, sy, sw, sh, activeBoxes[0].label, colors);
            } else {
              this.drawPlaceholderBox(ctx, sx, sy, sw, sh, '🎤 Host Camera (Standby)', colors);
            }
          }
          break;

        case 'guestCamera':
          if (this.layers.guestCamera !== false) {
            const guestBox = activeBoxes.find(b => !b.isAdmin) || (activeBoxes.length > 1 ? activeBoxes[1] : null);
            if (guestBox && guestBox.video) {
              this.drawVideoBox(ctx, guestBox.video, sx, sy, sw, sh, guestBox.label, colors);
            } else {
              this.drawPlaceholderBox(ctx, sx, sy, sw, sh, '👥 Guest Stage (Ready for Duet)', colors);
            }
          }
          break;

        case 'lyrics':
          if (this.layers.lyrics !== false) {
            this.drawCustomLyrics(ctx, sx, sy, sw, sh, colors);
          }
          break;

        case 'visualizer':
          if (this.layers.visualizer !== false) {
            this.drawCustomVisualizer(ctx, sx, sy, sw, sh, colors);
          }
          break;

        case 'songBanner':
          if (this.layers.songBanner !== false) {
            this.drawCustomSongBanner(ctx, sx, sy, sw, sh, colors);
          }
          break;

        case 'socialTicker':
          this.drawSocialTicker(ctx, sx, sy, sw, sh, colors, s.text);
          break;
      }
    }
  }

  drawPlaceholderBox(ctx, x, y, width, height, label, colors) {
    const radius = Math.min(12, Math.max(6, Math.round(height * 0.05)));
    ctx.save();
    ctx.fillStyle = 'rgba(10, 14, 26, 0.75)';
    ctx.strokeStyle = colors?.border || 'rgba(0, 229, 255, 0.45)';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, radius);
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);

    const fontSize = Math.max(10, Math.round(Math.min(height * 0.15, width * 0.07)));
    ctx.font = `bold ${fontSize}px sans-serif`;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.65)';
    ctx.textAlign = 'center';
    ctx.fillText(label, x + width / 2, y + height / 2 + fontSize * 0.35);
    ctx.restore();
  }

  drawCustomVisualizer(ctx, x, y, width, height, colors) {
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

    const numBars = Math.min(48, Math.max(16, Math.floor(width / 10)));
    const step = this._visDataArray ? Math.max(1, Math.floor(this._visDataArray.length / (numBars * 2))) : 1;
    const barSpacing = width / (numBars + 2);
    const barWidth = Math.max(2, barSpacing * 0.72);
    const startX = x + (width - (numBars * barSpacing)) / 2;
    const baseY = y + height;
    const maxBarHeight = height * 0.95;
    const time = performance.now() * 0.001;

    ctx.save();
    const grad = ctx.createLinearGradient(0, y, 0, baseY);
    grad.addColorStop(0, colors?.accent1 || '#00e5ff');
    grad.addColorStop(0.5, '#a855f7');
    grad.addColorStop(1, colors?.accent2 || '#ff007f');
    ctx.fillStyle = grad;

    ctx.beginPath();
    for (let i = 0; i < numBars; i++) {
      let val = (this._visDataArray && hasSignal) ? (this._visDataArray[i * step] || 0) : 0;
      if (!hasSignal) {
        val = Math.floor((Math.sin(i * 0.22 + time * 2.8) * 0.5 + 0.5) * 55 + 12);
      }
      const barHeight = Math.max(2, (val / 255) * maxBarHeight);
      const bx = startX + (i * barSpacing);
      const by = baseY - barHeight;
      ctx.roundRect(bx, by, barWidth, barHeight, 2);
    }
    ctx.fill();
    ctx.restore();
  }

  drawCustomLyrics(ctx, x, y, width, height, colors) {
    const currentLine = this._cachedCurrentLine || '♪ ♫ ♪ Nirmal Karaoke Live ♪ ♫ ♪';
    const nextLine = this._cachedNextLine || 'Sing along with your favorite tracks';

    const mainFontSize = Math.max(13, Math.round(Math.min(height * 0.35, width * 0.05)));
    const nextFontSize = Math.max(10, Math.round(mainFontSize * 0.68));
    const radius = Math.min(12, Math.max(6, Math.round(height * 0.1)));

    ctx.save();
    // Background pill container
    ctx.fillStyle = 'rgba(8, 12, 24, 0.88)';
    ctx.strokeStyle = colors?.border || 'rgba(0, 229, 255, 0.5)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, radius);
    ctx.fill();
    ctx.stroke();

    ctx.textAlign = 'center';

    // Current Line
    ctx.font = `bold ${mainFontSize}px sans-serif`;
    ctx.fillStyle = '#ffffff';
    ctx.fillText(currentLine, x + width / 2, y + height * 0.46);

    // Next Line
    if (nextLine && height > 35) {
      ctx.font = `600 ${nextFontSize}px sans-serif`;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.65)';
      ctx.fillText(nextLine, x + width / 2, y + height * 0.82);
    }
    ctx.restore();
  }

  drawCustomSongBanner(ctx, x, y, width, height, colors) {
    const time = performance.now() * 0.001;
    ctx.save();

    ctx.fillStyle = 'rgba(5, 5, 15, 0.88)';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, Math.min(8, height * 0.1));
    ctx.fill();
    ctx.stroke();

    const titleSize = Math.max(11, Math.round(Math.min(height * 0.4, width * 0.035)));
    const tagSize = Math.max(9, Math.round(titleSize * 0.72));

    // Brand Logo & Live indicator
    ctx.textAlign = 'left';
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${titleSize}px sans-serif`;
    ctx.fillText('🎤 NIRMAL KARAOKE', x + 12, y + height * 0.62);

    const brandMetrics = ctx.measureText('🎤 NIRMAL KARAOKE');
    const badgeX = x + 12 + brandMetrics.width + 12;

    const dotAlpha = 0.65 + 0.35 * Math.sin(time * 5);
    ctx.fillStyle = `rgba(255, 0, 85, ${dotAlpha})`;
    ctx.beginPath();
    ctx.arc(badgeX, y + height * 0.52, Math.max(3, height * 0.09), 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#ff0055';
    ctx.font = `bold ${tagSize}px sans-serif`;
    ctx.fillText('LIVE', badgeX + 8, y + height * 0.62);

    // Song Title
    const songName = this._cachedSongName || 'Live Karaoke Session';
    ctx.textAlign = 'right';
    ctx.fillStyle = colors?.accent1 || '#00e5ff';
    ctx.font = `bold ${tagSize}px sans-serif`;
    ctx.fillText('♫ ' + songName.slice(0, 32), x + width - 12, y + height * 0.62);

    ctx.restore();
  }

  drawSocialTicker(ctx, x, y, width, height, colors, customText) {
    const text = customText || '🎤 Nirmal Karaoke Live Studio • Request songs in live chat! • Enjoy the music';
    const fontSize = Math.max(10, Math.round(height * 0.58));
    const time = performance.now() * 0.001;

    ctx.save();
    // Ticker Background
    ctx.fillStyle = 'rgba(10, 8, 20, 0.94)';
    ctx.strokeStyle = colors?.accent2 || '#ff007f';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, Math.min(6, height * 0.1));
    ctx.fill();
    ctx.stroke();

    // Clipping bounds for marquee text
    ctx.beginPath();
    ctx.roundRect(x + 4, y, width - 8, height, 0);
    ctx.clip();

    ctx.font = `bold ${fontSize}px sans-serif`;
    const metrics = ctx.measureText(text);
    const textWidth = metrics.width;

    ctx.fillStyle = '#ffffff';
    if (textWidth <= width - 20) {
      // Centered if it fits
      ctx.textAlign = 'center';
      ctx.fillText(text, x + width / 2, y + height * 0.70);
    } else {
      // Smooth continuous marquee scroll
      const totalDist = textWidth + width;
      const speed = 40; // px/sec
      const offset = (time * speed) % totalDist;
      const tx = (x + width) - offset;
      ctx.textAlign = 'left';
      ctx.fillText(text, tx, y + height * 0.70);
    }
    ctx.restore();
  }

  drawVideoBox(ctx, videoEl, x, y, width, height, label, colors) {
    const radius = Math.min(16, Math.max(8, Math.round(height * 0.05)));
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, radius);
    ctx.clip();

    try {
      const vw = videoEl.videoWidth || width;
      const vh = videoEl.videoHeight || height;
      const videoAspect = vw / vh;
      const boxAspect = width / height;
      let sx = 0, sy = 0, sw = vw, sh = vh;
      if (videoAspect > boxAspect) {
        sw = Math.round(vh * boxAspect);
        sx = Math.round((vw - sw) / 2);
      } else {
        sh = Math.round(vw / boxAspect);
        sy = Math.round((vh - sh) / 2);
      }
      ctx.drawImage(videoEl, sx, sy, sw, sh, x, y, width, height);
    } catch (_) {
      try { ctx.drawImage(videoEl, x, y, width, height); } catch (_) {}
    }

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

  drawVisualizer(ctx, w, h, hasCameras, colors, mode, numCams = 0) {
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

    if (hasCameras && numCams >= 4) {
      baseY = Math.round(h * 0.72);
      maxBarHeight = Math.round(h * 0.11);
    } else if (isVisMode) {
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

  drawLyrics(ctx, w, h, hasCameras, colors, mode, numCams = 0) {
    const currentLine = this._cachedCurrentLine || '♪ ♫ ♪ Nirmal Karaoke Live ♪ ♫ ♪';
    const nextLine = this._cachedNextLine || 'Sing along with your favorite tracks';

    const isKaraokeMode = mode === 'karaoke';
    const isVisMode = mode === 'visualizer';
    let y = hasCameras ? Math.round(h * 0.76) : Math.round(h * 0.72);
    let mainFontSize = Math.round(Math.max(16, h * 0.048));
    let nextFontSize = Math.round(Math.max(12, h * 0.030));

    if (hasCameras && numCams >= 4) {
      y = Math.round(h * 0.81);
      mainFontSize = Math.round(Math.max(14, h * 0.040));
      nextFontSize = Math.round(Math.max(11, h * 0.026));
    } else if (isKaraokeMode) {
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
