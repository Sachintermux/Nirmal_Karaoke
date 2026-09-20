/**
 * Multistream / External RTMP Livestreaming Manager
 * Streams live karaoke audio + Broadcast Scene Video (Visualizer, Lyrics, Cameras)
 * to YouTube Live, Twitch, Facebook Live & Custom RTMP servers.
 *
 * Architecture:
 *   BroadcastCompositor (1280x720 Canvas @ 30 FPS)
 *   + Mixed Audio Track (128 Kbps Stereo AAC / Opus)
 *     → MediaRecorder (video/webm;codecs=vp8,opus)
 *       → WebSocket (/api/stream/ws on Render cloud relay or localhost)
 *         → Node.js server (server.js)
 *           → FFmpeg (FLV with H.264 video + 128kbps AAC audio)
 *             → RTMP → YouTube Live
 */

import { BroadcastCompositor } from './broadcast-compositor.js';

const STORAGE_KEY_STREAM_KEYS = 'nirmal_karaoke_stream_keys';
const STORAGE_KEY_RELAY_URL   = 'nirmal_stream_relay_url';
const DEFAULT_CLOUD_RELAY_URL = 'https://nirmal-karaoke.onrender.com';

export class MultiStreamManager {
  constructor(liveHost, audioEngine = null, lyricsManager = null) {
    this.liveHost = liveHost;
    this.audioEngine = audioEngine || liveHost?.audioEngine || liveHost?.impl?.audioEngine;
    this.lyricsManager = lyricsManager;

    this.isStreaming = false;
    this.sessionId = null;
    this.activePlatform = null;
    this.startTime = null;
    this.timerInterval = null;
    this.streamMethod = 'websocket';

    /** @type {BroadcastCompositor} */
    this.compositor = new BroadcastCompositor(this.audioEngine, this.liveHost, this.lyricsManager);

    /** @type {MediaRecorder|null} */
    this._recorder = null;
    /** @type {WebSocket|null} */
    this._ws = null;
    /** Pending chunks buffer */
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

  getCloudRelayUrl() {
    const saved = localStorage.getItem(STORAGE_KEY_RELAY_URL);
    if (saved && saved.trim()) return saved.trim();
    if (typeof window !== 'undefined' && window.NIRMAL_STREAM_RELAY_URL && window.NIRMAL_STREAM_RELAY_URL.trim()) {
      return window.NIRMAL_STREAM_RELAY_URL.trim();
    }
    return DEFAULT_CLOUD_RELAY_URL;
  }

  saveCloudRelayUrl(url) {
    try {
      localStorage.setItem(STORAGE_KEY_RELAY_URL, String(url || '').trim());
    } catch (_) {}
  }

  // ─── UI Init ──────────────────────────────────────────────────────────────

  initUI() {
    this.modal             = document.getElementById('modalExternalStream');
    this.btnOpen           = document.getElementById('btnOpenMultistream');
    this.btnClose          = document.getElementById('btnCloseMultistream');
    this.platformSelect    = document.getElementById('selectStreamPlatform');
    this.customUrlWrap     = document.getElementById('wrapCustomRtmpUrl');
    this.inputCustomUrl    = document.getElementById('inputCustomRtmpUrl');
    this.inputStreamKey    = document.getElementById('inputStreamKey');
    this.inputCloudRelay   = document.getElementById('inputCloudRelayUrl');
    this.btnToggleKey      = document.getElementById('btnToggleStreamKey');
    this.btnStartStream    = document.getElementById('btnStartExternalStream');
    this.btnStopStream     = document.getElementById('btnStopExternalStream');
    this.streamStatusBadge = document.getElementById('streamStatusBadge');
    this.streamTimer       = document.getElementById('streamTimer');
    this.streamErrorNotice = document.getElementById('streamErrorNotice');
    this.topbarBadge       = document.getElementById('badgeExternalStreamLive');

    // Scene Layer Checkboxes
    this.chkVisualizer     = document.getElementById('chkStreamVisualizer');
    this.chkLyrics         = document.getElementById('chkStreamLyrics');
    this.chkHostCam        = document.getElementById('chkStreamHostCam');
    this.chkGuestCam       = document.getElementById('chkStreamGuestCam');

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

    if (this.inputCloudRelay) {
      this.inputCloudRelay.value = this.getCloudRelayUrl();
      this.inputCloudRelay.addEventListener('change', () => {
        this.saveCloudRelayUrl(this.inputCloudRelay.value);
      });
      this.inputCloudRelay.addEventListener('input', () => {
        this.saveCloudRelayUrl(this.inputCloudRelay.value);
      });
    }

    // Bind Scene Layer Checkboxes
    if (this.chkVisualizer) {
      this.chkVisualizer.checked = this.compositor.layers.visualizer;
      this.chkVisualizer.addEventListener('change', () => this.compositor.setLayer('visualizer', this.chkVisualizer.checked));
    }
    if (this.chkLyrics) {
      this.chkLyrics.checked = this.compositor.layers.lyrics;
      this.chkLyrics.addEventListener('change', () => this.compositor.setLayer('lyrics', this.chkLyrics.checked));
    }
    if (this.chkHostCam) {
      this.chkHostCam.checked = this.compositor.layers.hostCamera;
      this.chkHostCam.addEventListener('change', () => this.compositor.setLayer('hostCamera', this.chkHostCam.checked));
    }
    if (this.chkGuestCam) {
      this.chkGuestCam.checked = this.compositor.layers.guestCamera;
      this.chkGuestCam.addEventListener('change', () => this.compositor.setLayer('guestCamera', this.chkGuestCam.checked));
    }

    this.btnStartStream?.addEventListener('click', () => this.startBroadcast());
    this.btnStopStream?.addEventListener('click',  () => this.stopBroadcast());

    this.onPlatformChanged();
  }

  openModal() {
    if (this.modal) this.modal.style.display = 'flex';
    this.onPlatformChanged();
    if (this.inputCloudRelay) this.inputCloudRelay.value = this.getCloudRelayUrl();
    if (this.chkVisualizer) this.chkVisualizer.checked = this.compositor.layers.visualizer;
    if (this.chkLyrics) this.chkLyrics.checked = this.compositor.layers.lyrics;
    if (this.chkHostCam) this.chkHostCam.checked = this.compositor.layers.hostCamera;
    if (this.chkGuestCam) this.chkGuestCam.checked = this.compositor.layers.guestCamera;
    this.clearError();
  }

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
    const platform   = this.platformSelect?.value || 'youtube';
    const streamKey  = this.inputStreamKey?.value.trim() || '';
    const customUrl  = this.inputCustomUrl?.value.trim() || '';

    if (!streamKey) { this.showError('Please enter your stream key to go live.'); return; }
    if (platform === 'custom' && !customUrl) {
      this.showError('Please enter your custom RTMP server URL (e.g. rtmp://my-server/live).');
      return;
    }

    this.saveKey(platform, streamKey, customUrl);
    if (this.inputCloudRelay?.value) {
      this.saveCloudRelayUrl(this.inputCloudRelay.value);
    }

    if (this.btnStartStream) {
      this.btnStartStream.disabled = true;
      this.btnStartStream.textContent = 'Connecting Stage…';
    }

    // 1. Ensure Audio Engine is booted & AudioContext is active
    const ae = this.audioEngine || this.liveHost?.impl?.audioEngine || this.liveHost?.audioEngine;
    if (ae) {
      try {
        if (!ae.ctx) await ae.boot();
        if (ae.ctx && ae.ctx.state === 'suspended') {
          await ae.ctx.resume();
        }
      } catch (aeErr) {
        console.warn('[MultiStream] AudioEngine boot notice:', aeErr);
      }
    }

    // 2. Ensure LiveKit Room is created & Program Audio Published
    let roomName = this.liveHost?.roomId;
    if (!roomName || this.liveHost?.room?.state !== 'connected') {
      try {
        this.setStatus('Connecting Stage…');
        roomName = await this.liveHost.createRoom(true);
        await new Promise(r => setTimeout(r, 1000));
        await this.liveHost.ensureProgramAudioPublished?.();
      } catch (err) {
        this.showError('Could not start live stage: ' + (err.message || err));
        this.resetStartButton();
        return;
      }
    } else {
      try { await this.liveHost.ensureProgramAudioPublished?.(); } catch (_) {}
    }

    // 3. Extract mixed stereo audio track from AudioEngine
    const mixedStream = ae?.engine?.dest?.stream
                     || this.liveHost?.impl?.audioEngine?.engine?.dest?.stream
                     || this.liveHost?.audioEngine?.engine?.dest?.stream;

    let audioTrack = mixedStream?.getAudioTracks?.()[0] || null;

    // Fallback: If no active audio track, create a continuous silent stereo track
    // so YouTube never rejects the live stream due to missing audio.
    if (!audioTrack && ae?.ctx) {
      try {
        const destNode = ae.ctx.createMediaStreamDestination();
        const osc = ae.ctx.createConstantSource ? ae.ctx.createConstantSource() : ae.ctx.createOscillator();
        const gain = ae.ctx.createGain();
        gain.gain.value = 0.0001;
        osc.connect(gain);
        gain.connect(destNode);
        osc.start();
        audioTrack = destNode.stream.getAudioTracks()[0];
      } catch (synthErr) {
        console.warn('[MultiStream] Audio synthesis fallback notice:', synthErr);
      }
    }

    if (!audioTrack) {
      this.showError('Audio system not ready. Please tap "Go Live" or select a song, then try starting the stream again.');
      this.resetStartButton();
      return;
    }

    // 4. Generate Unified Broadcast Stream (Canvas Video + Mixed Audio)
    const broadcastStream = this.compositor.getMediaStream(audioTrack);

    this.setStatus('Connecting Server…');

    const isLocalhost = location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.hostname === '::1';

    let started = false;
    let lastError = null;

    if (isLocalhost) {
      // Local development: route to local Node server on current port / 3000
      try {
        const localTarget = (location.port && location.port !== '3000') ? `${location.hostname}:3000` : location.host;
        await this._startWebSocketStream(roomName, platform, streamKey, customUrl, broadcastStream, localTarget);
        started = true;
      } catch (wsErr) {
        lastError = wsErr;
      }
    } else {
      // Remote / Netlify / Vercel deployment:
      // Option A: Use configured Cloud Streaming Relay (Render / Railway / VPS)
      const cloudRelay = this.getCloudRelayUrl();
      if (cloudRelay) {
        try {
          const cleanHost = cloudRelay.replace(/^https?:\/\//i, '').replace(/^wss?:\/\//i, '').replace(/\/$/, '');
          console.info(`[MultiStream] Connecting to Cloud Streaming Relay: ${cleanHost}`);
          await this._startWebSocketStream(roomName, platform, streamKey, customUrl, broadcastStream, cleanHost);
          started = true;
        } catch (cloudRelayErr) {
          console.warn('[MultiStream] Cloud relay connection failed:', cloudRelayErr?.message);
          lastError = cloudRelayErr;
        }
      }

      // Option B: Try local relay (if host is running 'node server.js' on localhost:3000)
      if (!started) {
        try {
          console.info('[MultiStream] Attempting local relay on 127.0.0.1:3000...');
          await this._startWebSocketStream(roomName, platform, streamKey, customUrl, broadcastStream, '127.0.0.1:3000');
          started = true;
        } catch (localRelayErr) {
          console.info('[MultiStream] Local relay not available, trying Cloud LiveKit Egress fallback...');
          // Option C: Cloud LiveKit Egress fallback
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
      this.compositor.stop();
      this.showError(lastError?.message || 'Could not connect to streaming server. Check your Cloud Server URL in settings.');
      this.resetStartButton();
      return;
    }

    this.isStreaming    = true;
    this.activePlatform = platform;
    this.startTime      = Date.now();
    this.updateStateUI();
    this.startTimer();
    this.resetStartButton();
  }

  // ─── WebSocket + MediaRecorder pipeline ───────────────────────────────────

  async _startWebSocketStream(roomName, platform, streamKey, customUrl, stream, targetHost) {
    const isLocal = targetHost.includes('localhost') || targetHost.includes('127.0.0.1');
    const proto = isLocal && location.protocol !== 'https:' ? 'ws' : 'wss';
    const httpProto = isLocal && location.protocol !== 'https:' ? 'http:' : 'https:';

    // Fast non-blocking pre-flight health check (4s timeout)
    try {
      const controller = new AbortController();
      const hTimer = setTimeout(() => controller.abort(), 4000);
      const healthCheck = await fetch(`${httpProto}//${targetHost}/api/health`, {
        cache: 'no-store',
        signal: controller.signal
      });
      clearTimeout(hTimer);
      if (!healthCheck.ok) throw new Error(`Server returned ${healthCheck.status}`);
    } catch (netErr) {
      console.info(`[MultiStream] Pre-flight notice for ${targetHost} (${netErr.message}) — proceeding with WebSocket.`);
    }

    return new Promise((resolve, reject) => {
      let resolved = false;
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
      this._pendingChunks = [];
      this.streamMethod = 'websocket';

      console.info('[MultiStream] Connecting WebSocket to:', wsUrl.replace(streamKey, '***'));
      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      this._ws = ws;

      const CONNECT_TIMEOUT = 12000;
      let connectTimer = setTimeout(() => {
        if (!resolved) {
          try { ws.close(); } catch (_) {}
          this.compositor.stop();
          reject(new Error(`Connection to streaming server timed out (${targetHost}). Make sure Render service is awake.`));
        }
      }, CONNECT_TIMEOUT);

      ws.onopen = () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(connectTimer);
        console.info('[MultiStream] WebSocket connected to backend. Starting unified MediaRecorder.');
        try {
          this._startMediaRecorder(stream, ws);
          resolve();
        } catch (recErr) {
          console.error('[MultiStream] MediaRecorder start error:', recErr);
          this.compositor.stop();
          try { ws.close(); } catch (_) {}
          reject(new Error('Broadcast recording error: ' + (recErr.message || recErr)));
        }
      };

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'error') {
            console.error('[MultiStream] Server streaming error:', msg.message);
            this.showError('Stream error: ' + msg.message);
            this.stopBroadcast();
          } else if (msg.type === 'stopped') {
            console.info('[MultiStream] Server signaled stream stopped');
            if (this.isStreaming) this.stopBroadcast();
          }
        } catch (_) {}
      };

      ws.onerror = () => {
        if (!resolved) {
          clearTimeout(connectTimer);
          this.compositor.stop();
          reject(new Error(`WebSocket connection error to ${targetHost}. Verify server is awake and accessible.`));
        }
      };

      ws.onclose = (ev) => {
        clearTimeout(connectTimer);
        if (this.isStreaming && this.streamMethod === 'websocket') {
          console.warn('[MultiStream] WebSocket closed:', ev.code, ev.reason);
          this.stopBroadcast();
          this.showError('Stream disconnected. Please try starting again.');
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

  _startMediaRecorder(stream, ws) {
    let mimeType = '';
    const candidates = [
      'video/webm;codecs=vp8,opus',
      'video/webm;codecs=h264,opus',
      'video/webm',
      'video/mp4;codecs=avc1,mp4a',
      'video/mp4'
    ];
    for (const c of candidates) {
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(c)) {
        mimeType = c;
        break;
      }
    }

    let recorder = null;
    const options = {
      videoBitsPerSecond: 2500000,
      audioBitsPerSecond: 128000
    };
    if (mimeType) options.mimeType = mimeType;

    try {
      recorder = new MediaRecorder(stream, options);
    } catch (_) {
      recorder = new MediaRecorder(stream);
    }

    recorder.ondataavailable = async (ev) => {
      if (!ev.data || ev.data.size === 0) return;
      if (ws.readyState === WebSocket.OPEN) {
        try {
          const buf = await ev.data.arrayBuffer();
          ws.send(buf);
        } catch (_) {
          ws.send(ev.data);
        }
      } else {
        this._pendingChunks.push(ev.data);
        if (this._pendingChunks.length > 20) this._pendingChunks.shift();
      }
    };

    recorder.onerror = (e) => {
      console.error('[MultiStream] MediaRecorder error:', e);
      this.showError('Video/Audio capture error: ' + (e?.error?.message || 'MediaRecorder failed'));
    };

    recorder.onstop = () => {
      console.info('[MultiStream] MediaRecorder stopped');
    };

    // 1000ms timeslice ensures clean 1-second keyframe clusters without sub-second cluster fragmentation
    recorder.start(1000);
    this._recorder = recorder;
    console.info('[MultiStream] MediaRecorder active (1000ms clusters @ 128k AAC / 2.5M video)', { mimeType: recorder.mimeType || 'default' });
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
    this.compositor.stop();

    const roomName  = this.liveHost?.roomId;
    const sessionId = this.sessionId;
    const targetHost = this.getCloudRelayUrl().replace(/^https?:\/\//i, '').replace(/^wss?:\/\//i, '').replace(/\/$/, '');
    const httpProto = location.protocol === 'https:' ? 'https:' : 'http:';

    if (this.streamMethod === 'egress') {
      try {
        await fetch('/api/stream/stop-egress', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ roomName, egressId: sessionId, action: 'stop-egress' })
        });
      } catch (_) {}
    } else {
      const targets = ['/api/stream/stop-ffmpeg', `${httpProto}//${targetHost}/api/stream/stop-ffmpeg`];
      for (const t of targets) {
        try {
          await fetch(t, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ roomName, sessionId })
          });
        } catch (_) {}
      }
    }

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
