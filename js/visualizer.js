import { GenZVisualizerEngine } from './visualizer-engine.js';

export class VisualizerRenderer {
  constructor(audioEngine) {
    this.audioEngine = audioEngine;
    this.visDataArray = null;
    this.worker = null;
    this.useWorker = false;
    this.fallbackEngine = null;
    this._rafId = null;
    this._lastSendTs = 0;
    this._offscreenTransferred = false;
    this._isMobile = typeof window !== 'undefined' && (
      window.innerWidth <= 850 ||
      /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
    );
  }

  init() {
    const cvs = document.getElementById('visualizer');
    if (!cvs) return;

    // Cap DPR on mobile to 1.5 to eliminate memory and fill rate overhead
    const dpr = Math.min(window.devicePixelRatio || 1, this._isMobile ? 1.5 : 2);
    const hudAccel = document.getElementById('hudAccel');

    const parent = cvs.parentElement || cvs;
    const targetW = Math.max(10, Math.round(parent.clientWidth * dpr));
    const targetH = Math.max(10, Math.round(parent.clientHeight * dpr));

    // Determine if OffscreenCanvas and Web Workers are supported
    const canUseWorker = typeof cvs.transferControlToOffscreen === 'function' &&
                         typeof Worker !== 'undefined' &&
                         !this._offscreenTransferred;

    if (canUseWorker) {
      try {
        const offscreen = cvs.transferControlToOffscreen();
        this._offscreenTransferred = true;

        this.worker = new Worker(new URL('./visualizer-worker.js', import.meta.url), { type: 'module' });

        this.worker.postMessage({
          type: 'init',
          canvas: offscreen,
          width: targetW,
          height: targetH,
          dpr: dpr,
          isMobile: this._isMobile
        }, [offscreen]);

        this.useWorker = true;
        if (hudAccel) {
          hudAccel.textContent = "⚡ BG ACCEL: ON";
          hudAccel.style.color = "var(--accent-cyan, #00f0ff)";
        }
      } catch (err) {
        console.warn('[Visualizer] Worker acceleration init failed, using fallback engine:', err);
        this.useWorker = false;
      }
    }

    if (!this.useWorker) {
      cvs.width = targetW;
      cvs.height = targetH;
      const ctx2d = cvs.getContext('2d', { alpha: true });
      this.fallbackEngine = new GenZVisualizerEngine(ctx2d, {
        width: targetW,
        height: targetH,
        dpr: dpr,
        isMobile: this._isMobile
      });
      if (hudAccel) {
        hudAccel.textContent = "HW ACCEL: ON";
        hudAccel.style.color = "var(--accent-green, #00ff88)";
      }
    }

    const resize = () => {
      if (!cvs || !cvs.parentElement) return;
      const curDpr = Math.min(window.devicePixelRatio || 1, this._isMobile ? 1.5 : 2);
      const newW = Math.max(10, Math.round(cvs.parentElement.clientWidth * curDpr));
      const newH = Math.max(10, Math.round(cvs.parentElement.clientHeight * curDpr));

      if (this.useWorker && this.worker) {
        this.worker.postMessage({ type: 'resize', width: newW, height: newH, dpr: curDpr });
      } else if (this.fallbackEngine) {
        cvs.width = newW;
        cvs.height = newH;
        this.fallbackEngine.resize(newW, newH, curDpr);
      }
    };

    window.addEventListener('resize', resize, { passive: true });
    window.addEventListener('orientationchange', () => setTimeout(resize, 200), { passive: true });

    document.addEventListener('visibilitychange', () => {
      const hidden = document.hidden;
      if (this.useWorker && this.worker) {
        this.worker.postMessage({ type: 'visibility', hidden });
      }
    });

    this.startPump();
  }

  startPump() {
    const pumpLoop = (ts) => {
      this._rafId = requestAnimationFrame(pumpLoop);

      // Do not consume CPU cycles when page/tab is completely hidden
      if (typeof document !== 'undefined' && document.hidden) return;

      // Frame throttle for audio analysis data:
      // 30 FPS on mobile (33ms interval)
      // 50 FPS on desktop (20ms interval)
      const targetInterval = this._isMobile ? 33 : 20;
      if (ts - this._lastSendTs < targetInterval) return;
      this._lastSendTs = ts;

      const engine = this.audioEngine?.engine;
      if (!engine?.analyser) return;

      if (!this.visDataArray || this.visDataArray.length !== engine.analyser.frequencyBinCount) {
        this.visDataArray = new Uint8Array(engine.analyser.frequencyBinCount);
      }
      engine.analyser.getByteFrequencyData(this.visDataArray);

      if (this.useWorker && this.worker) {
        // Send audio frequency array to background worker (takes < 0.02ms on main thread!)
        this.worker.postMessage({ type: 'audio', data: this.visDataArray });
      } else if (this.fallbackEngine) {
        this.fallbackEngine.updateAudio(this.visDataArray);
        this.fallbackEngine.render(ts);
      }
    };

    this._rafId = requestAnimationFrame(pumpLoop);
  }

  drawLoop(now = performance.now()) {
    // Kept for backward compatibility if invoked directly
    if (this.fallbackEngine) {
      this.fallbackEngine.render(now);
    }
  }

  destroy() {
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }
}