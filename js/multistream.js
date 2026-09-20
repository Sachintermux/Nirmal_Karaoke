/**
 * Multistream / External RTMP Livestreaming Manager
 * Streams live karaoke audio to YouTube Live, Twitch, Facebook Live & Custom RTMP.
 *
 * Architecture (no LiveKit Egress needed — works on FREE LiveKit plan):
 *   Browser AudioContext mix
 *     → MediaRecorder (WebM/Opus, 250ms chunks)
 *       → WebSocket (/api/stream/ws)
 *         → Node.js server
 *           → ffmpeg (AAC + black video frame)
 *             → RTMP → YouTube / Twitch / Facebook
 */

const STORAGE_KEY_STREAM_KEYS = 'nirmal_karaoke_stream_keys';

export class MultiStreamManager {
  constructor(liveHost) {
    this.liveHost = liveHost;
    this.isStreaming = false;
    this.sessionId = null;
    this.activePlatform = null;
    this.startTime = null;
    this.timerInterval = null;

    /** @type {MediaRecorder|null} */
    this._recorder = null;
    /** @type {WebSocket|null} */
    this._ws = null;
    /** WebSocket reconnect attempts */
    this._wsRetries = 0;
    /** Pending audio chunks queued while WebSocket reconnects */
    this._pendingChunks = [];

    this.savedKeys = this.loadSavedKeys();
    this.initUI();
  }

  // ─── Persistence ──────────────────────────────────────────────────────────

  loadSavedKeys() {
    try {
      const data = localStorage.getItem(STORAGE_KEY_STREAM_KEYS);
      if (data) return JSON.parse(data);
    } catch (_) {}
    return { youtube: '', twitch: '', facebook: '', custom_url: '', custom_key: '' };
  }

  saveKey(platform, key, customUrl = '') {
    if (!this.savedKeys) this.savedKeys = {};
    if (platform === 'custom') {
      this.savedKeys.custom_url = customUrl;
      this.savedKeys.custom_key = key;
    } else {
      this.savedKeys[platform] = key;
    }
    try { localStorage.setItem(STORAGE_KEY_STREAM_KEYS, JSON.stringify(this.savedKeys)); } catch (_) {}
  }

  // ─── UI Init ──────────────────────────────────────────────────────────────

  initUI() {
    this.modal            = document.getElementById('modalExternalStream');
    this.btnOpen          = document.getElementById('btnOpenMultistream');
    this.btnClose         = document.getElementById('btnCloseMultistream');
    this.platformSelect   = document.getElementById('selectStreamPlatform');
    this.customUrlWrap    = document.getElementById('wrapCustomRtmpUrl');
    this.inputCustomUrl   = document.getElementById('inputCustomRtmpUrl');
    this.inputStreamKey   = document.getElementById('inputStreamKey');
    this.btnToggleKey     = document.getElementById('btnToggleStreamKey');
    this.btnStartStream   = document.getElementById('btnStartExternalStream');
    this.btnStopStream    = document.getElementById('btnStopExternalStream');
    this.streamStatusBadge = document.getElementById('streamStatusBadge');
    this.streamTimer      = document.getElementById('streamTimer');
    this.streamErrorNotice = document.getElementById('streamErrorNotice');
    this.topbarBadge      = document.getElementById('badgeExternalStreamLive');

    if (!this.modal) return;

    this.btnOpen?.addEventListener('click',  () => this.openModal());
    this.btnClose?.addEventListener('click', () => this.closeModal());
    this.modal?.addEventListener('click', (e) => { if (e.target === this.modal) this.closeModal(); });
    this.platformSelect?.addEventListener('change', () => this.onPlatformChanged());
    this.btnToggleKey?.addEventListener('click', () => {
      if (this.inputStreamKey) {
        this.inputStreamKey.type = this.inputStreamKey.type === 'password' ? 'text' : 'password';
        this.btnToggleKey.textContent = this.inputStreamKey.type === 'password' ? '👁️' : '🔒';
      }
    });
    this.btnStartStream?.addEventListener('click', () => this.startBroadcast());
    this.btnStopStream?.addEventListener('click',  () => this.stopBroadcast());

    this.onPlatformChanged();
  }

  openModal()  { if (this.modal) this.modal.style.display = 'flex'; this.onPlatformChanged(); this.clearError(); }
  closeModal() { if (this.modal) this.modal.style.display = 'none'; }

  onPlatformChanged() {
    const plat = this.platformSelect?.value || 'youtube';
    if (this.customUrlWrap) this.customUrlWrap.style.display = plat === 'custom' ? 'block' : 'none';
    if (plat === 'custom') {
      if (this.inputCustomUrl)  this.inputCustomUrl.value  = this.savedKeys.custom_url || '';
      if (this.inputStreamKey)  this.inputStreamKey.value  = this.savedKeys.custom_key || '';
    } else {
      if (this.inputStreamKey)  this.inputStreamKey.value  = this.savedKeys[plat] || '';
    }
  }

  showError(msg) {
    if (this.streamErrorNotice) {
      this.streamErrorNotice.textContent = msg;
      this.streamErrorNotice.style.display = 'block';
    }
  }
  clearError() {
    if (this.streamErrorNotice) {
      this.streamErrorNotice.textContent = '';
      this.streamErrorNotice.style.display = 'none';
    }
  }

  // ─── Start Broadcast ──────────────────────────────────────────────────────

  async startBroadcast() {
    this.clearError();
    const platform  = this.platformSelect?.value || 'youtube';
    const streamKey = this.inputStreamKey?.value.trim() || '';
    const customUrl = this.inputCustomUrl?.value.trim() || '';

    if (!streamKey) { this.showError('Please enter your stream key to go live.'); return; }
    if (platform === 'custom' && !customUrl) {
      this.showError('Please enter your custom RTMP server URL (e.g. rtmp://my-server/live).');
      return;
    }

    this.saveKey(platform, streamKey, customUrl);

    // Ensure the LiveKit room is live (so audio is being mixed)
    if (this.btnStartStream) { this.btnStartStream.disabled = true; this.btnStartStream.textContent = 'Connecting…'; }

    let roomName = this.liveHost?.roomId;
    if (!roomName || this.liveHost?.room?.state !== 'connected') {
      try {
        this.setStatus('Connecting Stage…');
        roomName = await this.liveHost.createRoom(true);
        await new Promise(r => setTimeout(r, 1200));
        await this.liveHost.ensureProgramAudioPublished?.();
      } catch (err) {
        this.showError('Could not start live stage: ' + (err.message || err));
        this.resetStartButton();
        return;
      }
    } else {
      try { await this.liveHost.ensureProgramAudioPublished?.(); } catch (_) {}
    }

    // Get the mixed audio stream from the AudioContext
    const mixedStream = this.liveHost?.impl?.audioEngine?.engine?.dest?.stream
                     || this.liveHost?.audioEngine?.engine?.dest?.stream;

    if (!mixedStream || mixedStream.getAudioTracks().length === 0) {
      this.showError('No audio mix available. Start playing a song or speak into the mic first, then try again.');
      this.resetStartButton();
      return;
    }

    this.setStatus('Starting stream…');

    const isLocalhost = location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.hostname === '::1';

    let started = false;
    let lastError = null;

    if (isLocalhost) {
      // Local development: use browser MediaRecorder -> local WebSocket -> ffmpeg
      try {
        await this._startWebSocketStream(roomName, platform, streamKey, customUrl, mixedStream, location.host);
        started = true;
      } catch (wsErr) {
        lastError = wsErr;
      }
    } else {
      // Remote (Netlify / Vercel) deployment:
      // 1. Check for configured Cloud Backend Relay URL (Render, Railway, VPS, etc.)
      const cloudRelay = window.NIRMAL_STREAM_RELAY_URL 
                      || localStorage.getItem('nirmal_stream_relay_url') 
                      || '';

      if (cloudRelay) {
        try {
          const cleanHost = cloudRelay.replace(/^https?:\/\//i, '').replace(/^wss?:\/\//i, '').replace(/\/$/, '');
          console.info(`[MultiStream] Connecting to configured Cloud Streaming Relay: ${cleanHost}`);
          await this._startWebSocketStream(roomName, platform, streamKey, customUrl, mixedStream, cleanHost);
          started = true;
        } catch (cloudRelayErr) {
          console.warn('[MultiStream] Configured cloud relay failed:', cloudRelayErr?.message);
          lastError = cloudRelayErr;
        }
      }

      // 2. Try local relay (if host is running 'node server.js' on localhost:3000)
      if (!started) {
        try {
          console.info('[MultiStream] Attempting local relay on 127.0.0.1:3000...');
          await this._startWebSocketStream(roomName, platform, streamKey, customUrl, mixedStream, '127.0.0.1:3000');
          started = true;
        } catch (localRelayErr) {
          console.info('[MultiStream] Local relay not active, attempting Cloud LiveKit Egress fallback...');
          // 3. Cloud LiveKit Egress fallback
          try {
            await this._startCloudEgressStream(roomName, platform, streamKey, customUrl);
            started = true;
          } catch (cloudErr) {
            lastError = cloudErr;
          }
        }
      }
    }

    if (!started) {
      console.error('[MultiStream] start failed:', lastError);
      if (!isLocalhost) {
        this.showError(
          'Streaming requires a live Node+FFmpeg backend (or LiveKit Egress).\n\n' +
          '💡 Options to stream:\n' +
          '1. Deploy your backend to Render / Railway using the provided Dockerfile.\n' +
          '2. Open the app locally at http://localhost:3000 (with "node server.js").\n' +
          '3. Or use OBS Studio to stream this window directly to YouTube.'
        );
      } else {
        this.showError(lastError?.message || 'Stream connection failed. Make sure "node server.js" is running in terminal.');
      }
      this.resetStartButton();
      return;
    }

    this.isStreaming   = true;
    this.activePlatform = platform;
    this.startTime     = Date.now();
    this.updateStateUI();
    this.startTimer();
    this.resetStartButton();
  }

  // ─── WebSocket + MediaRecorder pipeline (Local) ───────────────────────────

  async _startWebSocketStream(roomName, platform, streamKey, customUrl, mixedStream, targetHost = 'localhost:3000') {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const httpProto = location.protocol === 'https:' ? 'https:' : 'http:';

    // Pre-flight health check to verify backend server is reachable
    try {
      const healthCheck = await fetch(`${httpProto}//${targetHost}/api/health`, { cache: 'no-store' });
      if (!healthCheck.ok) throw new Error(`Server returned ${healthCheck.status}`);
    } catch (netErr) {
      throw new Error(`Cannot reach local server on ${httpProto}//${targetHost}. Ensure 'node server.js' is running.`);
    }

    return new Promise((resolve, reject) => {
      const sid = 'ms_' + Math.random().toString(36).slice(2, 9);
      const params = new URLSearchParams({
        platform,
        key: streamKey,
        roomName,
        sessionId: sid,
        ...(customUrl ? { customUrl } : {})
      });
      const wsUrl = `${proto}://${targetHost}/api/stream/ws?${params}`;

      this.sessionId = sid;
      this._wsRetries = 0;
      this._pendingChunks = [];
      this.streamMethod = 'websocket';

      console.info('[MultiStream] Connecting WebSocket to:', wsUrl.replace(streamKey, '***'));
      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      this._ws = ws;

      const CONNECT_TIMEOUT = 10000;
      let connectTimer = setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN) {
          ws.close();
          reject(new Error(`WebSocket connection timed out on ${wsUrl}.`));
        }
      }, CONNECT_TIMEOUT);

      ws.onopen = () => {
        clearTimeout(connectTimer);
        console.info('[MultiStream] WebSocket connected. Starting MediaRecorder.');
        this._startMediaRecorder(mixedStream, ws);
        resolve();
      };

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'error') {
            console.error('[MultiStream] server error:', msg.message);
            this.showError('Stream error: ' + msg.message);
            this.stopBroadcast();
          } else if (msg.type === 'stopped') {
            console.info('[MultiStream] server stopped stream');
            if (this.isStreaming) this.stopBroadcast();
          }
        } catch (_) {}
      };

      ws.onerror = (e) => {
        clearTimeout(connectTimer);
        console.error('[MultiStream] WebSocket error', e);
        reject(new Error('WebSocket connection error.'));
      };

      ws.onclose = (ev) => {
        clearTimeout(connectTimer);
        if (this.isStreaming && this.streamMethod === 'websocket') {
          console.warn('[MultiStream] WebSocket closed:', ev.code, ev.reason);
          this._stopMediaRecorder();
          this.isStreaming = false;
          this.stopTimer();
          this.updateStateUI();
          this.showError('Stream disconnected. Check terminal logs.');
        }
      };
    });
  }

  // ─── Cloud LiveKit Egress pipeline (Fallback) ─────────────────────────────

  async _startCloudEgressStream(roomName, platform, streamKey, customUrl) {
    const body = { action: 'start-egress', roomName, platform, streamKey, rtmpUrl: customUrl };
    const endpoints = ['/api/stream/start-egress', '/.netlify/functions/livekit-token'];
    let lastErr = null;

    for (const ep of endpoints) {
      try {
        const r = await fetch(ep, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        const data = await r.json().catch(() => ({}));
        if (r.ok && data.ok) {
          this.sessionId = data.egressId;
          this.streamMethod = 'egress';
          console.info('[MultiStream] Cloud LiveKit Egress started:', data.egressId);
          return data;
        }
        lastErr = new Error(data.error || `LiveKit Egress failed (${r.status})`);
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('Could not initiate cloud livestream.');
  }

  _startMediaRecorder(mixedStream, ws) {
    // Pick the best supported MIME type
    const mimeTypes = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/ogg'
    ];
    const mimeType = mimeTypes.find(m => MediaRecorder.isTypeSupported(m)) || '';

    let recorder;
    try {
      recorder = new MediaRecorder(mixedStream, {
        mimeType,
        audioBitsPerSecond: 128000
      });
    } catch (e) {
      // Fallback: no options
      recorder = new MediaRecorder(mixedStream);
    }

    recorder.ondataavailable = (ev) => {
      if (!ev.data || ev.data.size === 0) return;
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(ev.data);
      } else {
        // Buffer briefly in case WS is mid-reconnect
        this._pendingChunks.push(ev.data);
        if (this._pendingChunks.length > 20) this._pendingChunks.shift(); // cap buffer
      }
    };

    recorder.onerror = (e) => {
      console.error('[MultiStream] MediaRecorder error:', e);
      this.showError('Audio capture error: ' + (e?.error?.message || 'MediaRecorder failed'));
    };

    recorder.onstop = () => {
      console.info('[MultiStream] MediaRecorder stopped');
    };

    // 250ms chunks = low latency with manageable overhead
    recorder.start(250);
    this._recorder = recorder;
    console.info('[MultiStream] MediaRecorder started', { mimeType: recorder.mimeType });
  }

  _stopMediaRecorder() {
    if (this._recorder && this._recorder.state !== 'inactive') {
      try { this._recorder.stop(); } catch (_) {}
    }
    this._recorder = null;
    this._pendingChunks = [];
  }

  // ─── Stop Broadcast ───────────────────────────────────────────────────────

  async stopBroadcast() {
    if (this.btnStopStream) { this.btnStopStream.disabled = true; this.btnStopStream.textContent = 'Stopping…'; }

    this._stopMediaRecorder();

    // Tell server to stop stream
    const roomName  = this.liveHost?.roomId;
    const sessionId = this.sessionId;
    if (this.streamMethod === 'egress') {
      try {
        await fetch('/api/stream/stop-egress', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ roomName, egressId: sessionId, action: 'stop-egress' })
        });
      } catch (_) {}
    } else {
      try {
        await fetch('/api/stream/stop-ffmpeg', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ roomName, sessionId })
        });
      } catch (_) {}
    }

    // Close WebSocket
    if (this._ws) {
      try { this._ws.close(); } catch (_) {}
      this._ws = null;
    }

    this.isStreaming    = false;
    this.sessionId      = null;
    this.activePlatform = null;
    this.stopTimer();
    this.updateStateUI();

    if (this.btnStopStream) {
      this.btnStopStream.disabled = false;
      this.btnStopStream.textContent = '⏹️ Stop Live Stream';
    }
  }

  // ─── Timer & UI ───────────────────────────────────────────────────────────

  setStatus(msg) {
    if (this.btnStartStream) this.btnStartStream.textContent = msg;
  }

  resetStartButton() {
    if (this.btnStartStream) {
      this.btnStartStream.disabled = false;
      this.btnStartStream.textContent = '🚀 Start Live Stream';
    }
  }

  startTimer() {
    this.stopTimer();
    const update = () => {
      if (!this.startTime || !this.streamTimer) return;
      const s = Math.floor((Date.now() - this.startTime) / 1000);
      this.streamTimer.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    };
    update();
    this.timerInterval = setInterval(update, 1000);
  }

  stopTimer() {
    if (this.timerInterval) { clearInterval(this.timerInterval); this.timerInterval = null; }
    if (this.streamTimer) this.streamTimer.textContent = '00:00';
  }

  updateStateUI() {
    if (this.isStreaming) {
      const platLabel = (this.activePlatform || 'external platform').toUpperCase();
      if (this.streamStatusBadge) {
        this.streamStatusBadge.className = 'status-badge-live';
        this.streamStatusBadge.innerHTML = `<span class="badge-dot"></span> LIVE ON ${platLabel}`;
      }
      if (this.btnStartStream)   this.btnStartStream.style.display  = 'none';
      if (this.btnStopStream)    this.btnStopStream.style.display   = 'inline-flex';
      if (this.platformSelect)   this.platformSelect.disabled       = true;
      if (this.inputStreamKey)   this.inputStreamKey.disabled       = true;
      if (this.inputCustomUrl)   this.inputCustomUrl.disabled       = true;
      if (this.topbarBadge) {
        this.topbarBadge.style.display = 'inline-flex';
        this.topbarBadge.textContent   = `🔴 Streaming ${platLabel}`;
      }
    } else {
      if (this.streamStatusBadge) {
        this.streamStatusBadge.className   = 'status-badge-offline';
        this.streamStatusBadge.textContent = '⚪ OFFLINE';
      }
      if (this.btnStartStream)  this.btnStartStream.style.display  = 'inline-flex';
      if (this.btnStopStream)   this.btnStopStream.style.display   = 'none';
      if (this.platformSelect)  this.platformSelect.disabled       = false;
      if (this.inputStreamKey)  this.inputStreamKey.disabled       = false;
      if (this.inputCustomUrl)  this.inputCustomUrl.disabled       = false;
      if (this.topbarBadge)     this.topbarBadge.style.display     = 'none';
    }
  }
}
