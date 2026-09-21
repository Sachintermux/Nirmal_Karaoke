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
    this.hasConfirmedLive = false;
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
      if (data) {
        const parsed = JSON.parse(data);
        if (parsed.youtube || parsed.youtube_rtmps) return parsed;
      }
    } catch (_) {}
    return { youtube: '2k5t-7stf-gt2v-cbm1-22b6', youtube_rtmps: '2k5t-7stf-gt2v-cbm1-22b6', twitch: '', facebook: '', custom_url: '', custom_key: '' };
  }

  saveKey(platform, key, customUrl = '') {
    if (!this.savedKeys) this.savedKeys = {};
    if (platform === 'custom') {
      this.savedKeys.custom_url = customUrl;
      this.savedKeys.custom_key = key;
    } else {
      this.savedKeys[platform] = key;
      if (platform === 'youtube_rtmps') this.savedKeys.youtube = key;
      if (platform === 'youtube') this.savedKeys.youtube_rtmps = key;
    }
    try { localStorage.setItem(STORAGE_KEY_STREAM_KEYS, JSON.stringify(this.savedKeys)); } catch (_) {}
  }

  getCloudRelayUrl() {
    const isLocalhost = typeof location !== 'undefined' && (location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.hostname === '::1');
    const saved = localStorage.getItem(STORAGE_KEY_RELAY_URL);
    if (saved && saved.trim()) {
      const val = saved.trim();
      if (isLocalhost || (!val.includes('localhost') && !val.includes('127.0.0.1'))) {
        return val;
      }
    }
    if (typeof window !== 'undefined' && window.NIRMAL_STREAM_RELAY_URL && window.NIRMAL_STREAM_RELAY_URL.trim()) {
      const val = window.NIRMAL_STREAM_RELAY_URL.trim();
      if (isLocalhost || (!val.includes('localhost') && !val.includes('127.0.0.1'))) {
        return val;
      }
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
    this.btnTestStreamKey  = document.getElementById('btnTestStreamKey');
    this.testStreamResult  = document.getElementById('testStreamResult');
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

    // Real-Time Preview & Layout Engine
    this.previewCanvas        = document.getElementById('broadcastScenePreview');
    this.previewLayoutBadge   = document.getElementById('previewActiveLayoutBadge');
    this.selectTheme          = document.getElementById('selectStreamTheme');
    this.selectQuality        = document.getElementById('selectStreamQuality');
    this.layoutPillsContainer = document.getElementById('broadcastLayoutPills');

    this.selectedQuality = localStorage.getItem('nirmal_stream_quality') || '540p';

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
    this.btnTestStreamKey?.addEventListener('click', () => this.testStreamKey());

    if (this.inputCloudRelay) {
      this.inputCloudRelay.value = this.getCloudRelayUrl();
      this.inputCloudRelay.addEventListener('change', () => {
        this.saveCloudRelayUrl(this.inputCloudRelay.value);
      });
      this.inputCloudRelay.addEventListener('input', () => {
        this.saveCloudRelayUrl(this.inputCloudRelay.value);
      });
    }

    // Bind Stage Theme Dropdown
    if (this.selectTheme) {
      this.selectTheme.value = this.compositor.theme;
      this.selectTheme.addEventListener('change', () => {
        this.compositor.setTheme(this.selectTheme.value);
      });
    }

    // Bind Stream Quality Dropdown
    if (this.selectQuality) {
      this.selectQuality.value = this.selectedQuality;
      this.selectQuality.addEventListener('change', () => {
        this.selectedQuality = this.selectQuality.value;
        try { localStorage.setItem('nirmal_stream_quality', this.selectedQuality); } catch (_) {}
      });
    }

    // Bind Layout Preset Switcher Buttons
    if (this.layoutPillsContainer) {
      const pills = this.layoutPillsContainer.querySelectorAll('button[data-layout]');
      const updatePillsUi = (activeLayout) => {
        pills.forEach(btn => {
          const isMatch = btn.getAttribute('data-layout') === activeLayout;
          if (isMatch) {
            btn.style.background = 'rgba(0,229,255,0.15)';
            btn.style.border = '1px solid #00e5ff';
            btn.style.color = '#00e5ff';
          } else {
            btn.style.background = 'transparent';
            btn.style.border = '1px solid var(--border)';
            btn.style.color = 'var(--text-dim)';
          }
        });
        if (this.previewLayoutBadge) {
          const labels = {
            spotlight: '🎤 Spotlight Layout',
            karaoke: '🎼 Karaoke Stage',
            duet: '👥 Side-by-Side Duet',
            visualizer: '📊 Full Visualizer'
          };
          this.previewLayoutBadge.textContent = labels[activeLayout] || activeLayout;
        }
      };
      this._updatePillsUi = updatePillsUi;
      pills.forEach(btn => {
        btn.addEventListener('click', () => {
          const layoutName = btn.getAttribute('data-layout');
          this.compositor.setLayout(layoutName);
          updatePillsUi(layoutName);
        });
      });
      updatePillsUi(this.compositor.layout);
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

  async testStreamKey() {
    const key = this.inputStreamKey?.value.trim() || '';
    const platform = this.platformSelect?.value || 'youtube_rtmps';
    const customUrl = this.inputCustomUrl?.value.trim() || '';
    const resultBox = this.testStreamResult || document.getElementById('testStreamResult');
    const btn = this.btnTestStreamKey || document.getElementById('btnTestStreamKey');

    if (!key) {
      if (resultBox) {
        resultBox.style.display = 'block';
        resultBox.style.background = 'rgba(255, 77, 77, 0.15)';
        resultBox.style.color = '#ff6b6b';
        resultBox.style.border = '1px solid rgba(255, 77, 77, 0.3)';
        resultBox.textContent = '⚠️ Please enter your stream key first.';
      }
      return;
    }

    if (btn) { btn.disabled = true; btn.textContent = 'Testing…'; }
    if (resultBox) {
      resultBox.style.display = 'block';
      resultBox.style.background = 'rgba(0, 229, 255, 0.1)';
      resultBox.style.color = '#00e5ff';
      resultBox.style.border = '1px solid rgba(0, 229, 255, 0.25)';
      resultBox.textContent = '⏳ Testing live connection to YouTube ingestion server…';
    }

    try {
      const isLocalhost = location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.hostname === '::1';
      const targetHost = isLocalhost ? (location.port && location.port !== '3000' ? `${location.hostname}:3000` : location.host) : this.getCloudRelayUrl().replace(/^https?:\/\//i, '').replace(/^wss?:\/\//i, '').replace(/\/$/, '');
      const httpProto = isLocalhost && location.protocol !== 'https:' ? 'http:' : 'https:';
      const params = new URLSearchParams({ key, platform, ...(customUrl ? { customUrl } : {}) });
      const resp = await fetch(`${httpProto}//${targetHost}/api/stream/test-ffmpeg?${params}`, { cache: 'no-store' });
      const data = await resp.json();

      if (btn) { btn.disabled = false; btn.textContent = '🧪 Test Connection'; }

      if (data.ok) {
        if (resultBox) {
          resultBox.style.background = 'rgba(0, 255, 136, 0.15)';
          resultBox.style.color = '#00ff88';
          resultBox.style.border = '1px solid rgba(0, 255, 136, 0.3)';
          resultBox.innerHTML = '✅ <b>Connected Successfully!</b> YouTube accepted this stream key and is ready for live broadcast.';
        }
      } else {
        const resultItem = data.results?.[0];
        const errDetail = resultItem?.error || resultItem?.logTail?.slice(-3).join(' ') || data.error || 'Connection rejected by destination.';
        if (resultBox) {
          resultBox.style.background = 'rgba(255, 77, 77, 0.15)';
          resultBox.style.color = '#ff6b6b';
          resultBox.style.border = '1px solid rgba(255, 77, 77, 0.3)';
          resultBox.innerHTML = `❌ <b>Connection failed:</b> ${errDetail}<br><span style="font-size:0.75rem; color:#ffd166; margin-top:6px; display:block;">💡 <b>YouTube Studio Tip:</b> Ensure your YouTube Live Studio page is open. If you previously clicked "End Stream", that stream key is closed—click <b>Reset</b> next to the Stream Key in YouTube Studio to generate a fresh one.</span>`;
        }
      }
    } catch (netErr) {
      if (btn) { btn.disabled = false; btn.textContent = '🧪 Test Connection'; }
      if (resultBox) {
        resultBox.style.background = 'rgba(255, 77, 77, 0.15)';
        resultBox.style.color = '#ff6b6b';
        resultBox.style.border = '1px solid rgba(255, 77, 77, 0.3)';
        resultBox.textContent = `❌ Network error: ${netErr.message}`;
      }
    }
  }

  openModal() {
    if (this.modal) this.modal.style.display = 'flex';
    this.onPlatformChanged();
    if (this.inputCloudRelay) this.inputCloudRelay.value = this.getCloudRelayUrl();
    if (this.chkVisualizer) this.chkVisualizer.checked = this.compositor.layers.visualizer;
    if (this.chkLyrics) this.chkLyrics.checked = this.compositor.layers.lyrics;
    if (this.chkHostCam) this.chkHostCam.checked = this.compositor.layers.hostCamera;
    if (this.chkGuestCam) this.chkGuestCam.checked = this.compositor.layers.guestCamera;
    if (this.selectTheme) this.selectTheme.value = this.compositor.theme;
    if (this._updatePillsUi) this._updatePillsUi(this.compositor.layout);
    if (this.selectQuality) this.selectQuality.value = this.selectedQuality;

    // Attach live stage preview monitor
    if (this.previewCanvas) {
      this.compositor.attachPreview(this.previewCanvas);
    }

    this.clearError();
  }

  closeModal() {
    if (this.modal) this.modal.style.display = 'none';
    this.compositor.detachPreview();
    if (!this.isStreaming) {
      this.compositor.stop();
    }
  }

  onPlatformChanged() {
    const plat = this.platformSelect?.value || 'youtube_rtmps';
    if (this.customUrlWrap) this.customUrlWrap.style.display = plat === 'custom' ? 'block' : 'none';
    if (plat === 'custom') {
      if (this.inputCustomUrl)  this.inputCustomUrl.value  = this.savedKeys.custom_url || '';
      if (this.inputStreamKey)  this.inputStreamKey.value  = this.savedKeys.custom_key || '';
    } else {
      const key = this.savedKeys[plat] || (plat.startsWith('youtube') ? (this.savedKeys.youtube_rtmps || this.savedKeys.youtube) : '');
      if (this.inputStreamKey)  this.inputStreamKey.value  = key || '';
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
    this.hasConfirmedLive = false;
    this._rtmpTransportConnected = false;

    const platform   = this.platformSelect?.value || 'youtube_rtmps';
    const streamKey  = this.inputStreamKey?.value.trim() || '';
    const customUrl  = this.inputCustomUrl?.value.trim() || '';

    console.info(`[MultiStream STEP 1/8] Starting broadcast setup for platform: ${platform}`);

    if (!streamKey) { this.showError('Please enter your stream key to go live.'); return; }
    if (streamKey.startsWith('http://') || streamKey.startsWith('https://')) {
      this.showError('⚠️ You entered a webpage link (https://...). Please copy the secret "Stream key" from the Stream Settings section in YouTube Studio (looks like xxxx-xxxx-xxxx-xxxx-xxxx).');
      return;
    }
    if (streamKey === 'rtmp://a.rtmp.youtube.com/live2' || streamKey === 'rtmps://a.rtmps.youtube.com/live2' || streamKey.endsWith('/live2') || streamKey.endsWith('/live2/')) {
      this.showError('⚠️ You entered the Stream URL instead of the Stream Key. Please copy the secret "Stream key" from the Stream Settings box on YouTube Studio.');
      return;
    }
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
        if (!ae.isGraphComplete || !ae.isGraphComplete()) {
          await ae.boot();
        }
        if (ae.ctx && ae.ctx.state === 'suspended') {
          await ae.ctx.resume();
        }
      } catch (aeErr) {
        console.warn('[MultiStream] AudioEngine boot notice:', aeErr);
      }
    }
    console.info('[MultiStream STEP 2/8] Audio Engine & AudioContext verified and ready.');

    // 2. Ensure LiveKit Room is created & Program Audio Published
    let roomName = this.liveHost?.roomId;
    if (!roomName || this.liveHost?.room?.state !== 'connected') {
      try {
        this.setStatus('Connecting Stage…');
        roomName = await this.liveHost.createRoom(true);
        await new Promise(r => setTimeout(r, 1000));
        await this.liveHost.ensureProgramAudioPublished?.();
      } catch (err) {
        console.error('[MultiStream ERROR at STEP 3] Could not start live stage:', err);
        this.showError('Could not start live stage: ' + (err.message || err));
        this.resetStartButton();
        return;
      }
    } else {
      try { await this.liveHost.ensureProgramAudioPublished?.(); } catch (_) {}
    }
    console.info(`[MultiStream STEP 3/8] Live Stage room verified: ${roomName}`);

    // 3. Extract dedicated mixed stereo audio stream from AudioEngine
    let broadcastAudioStream = null;
    if (ae?.createBroadcastDestination) {
      broadcastAudioStream = ae.createBroadcastDestination();
    }
    if (!broadcastAudioStream) {
      broadcastAudioStream = ae?.engine?.dest?.stream
                          || this.liveHost?.impl?.audioEngine?.engine?.dest?.stream
                          || this.liveHost?.audioEngine?.engine?.dest?.stream;
    }

    let audioTrack = broadcastAudioStream?.getAudioTracks?.()[0] || null;

    if (!audioTrack || audioTrack.readyState !== 'live') {
      if (ae?.createBroadcastDestination) {
        broadcastAudioStream = ae.createBroadcastDestination();
        audioTrack = broadcastAudioStream?.getAudioTracks?.()[0] || null;
      }
    }

    if (audioTrack) {
      audioTrack.enabled = true;
      try { audioTrack.contentHint = 'music'; } catch (_) {}
    }

    // Robust Fallback: Synthesize an audio destination if needed
    if (!audioTrack || audioTrack.readyState !== 'live') {
      try {
        const audioCtx = ae?.ctx || (window.AudioContext ? new (window.AudioContext || window.webkitAudioContext)() : null);
        if (audioCtx) {
          if (audioCtx.state === 'suspended') {
            audioCtx.resume().catch(() => {});
          }
          const destNode = audioCtx.createMediaStreamDestination();
          const osc = audioCtx.createOscillator();
          const gain = audioCtx.createGain();
          osc.frequency.value = 440;
          gain.gain.value = 0.00001;
          osc.connect(gain);
          gain.connect(destNode);
          osc.start();
          audioTrack = destNode.stream.getAudioTracks()[0];
          audioTrack.enabled = true;
        }
      } catch (synthErr) {
        console.warn('[MultiStream] Audio synthesis fallback notice:', synthErr);
      }
    }

    if (!audioTrack) {
      console.error('[MultiStream ERROR at STEP 4] Audio system not ready.');
      this.showError('Audio system not ready. Please tap "Go Live" or select a song, then try starting the stream again.');
      this.resetStartButton();
      return;
    }

    const programLevel = ae?.getProgramLevel ? ae.getProgramLevel() : 0;
    console.info(`[MultiStream STEP 4/8] Dedicated broadcast audio track ready: level=${programLevel.toFixed(4)}, state=${audioTrack.readyState}`);

    // 4. Generate Unified Broadcast Stream (Canvas Video + Mixed Audio)
    const broadcastStream = this.compositor.getMediaStream(audioTrack);
    console.info('[MultiStream STEP 4.1/8] Unified broadcast stream initialized:', {
      videoTracks: broadcastStream.getVideoTracks().map(t => `${t.kind}:${t.readyState}:enabled=${t.enabled}`),
      audioTracks: broadcastStream.getAudioTracks().map(t => `${t.kind}:${t.readyState}:enabled=${t.enabled}`)
    });

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

    console.info(`[MultiStream STEP 5/8] Connecting to Streaming Relay server at: ${targetHost}`);

    // Cloud servers (e.g. Render free tier) may be sleeping and need ~25-45s to wake up
    if (!isLocal) {
      this.setStatus('Waking up cloud server…');
      try {
        const controller = new AbortController();
        const hTimer = setTimeout(() => controller.abort(), 12000);
        console.info(`[MultiStream STEP 5.1/8] Pinging relay health at ${httpProto}//${targetHost}/api/health...`);
        await fetch(`${httpProto}//${targetHost}/api/health`, {
          cache: 'no-store',
          signal: controller.signal
        });
        clearTimeout(hTimer);
        console.info(`[MultiStream STEP 5.2/8] Cloud server health ping OK.`);
      } catch (netErr) {
        console.info(`[MultiStream STEP 5.2/8] Pre-flight notice for ${targetHost} (${netErr.message}) — proceeding with WebSocket.`);
      }
    }

    return new Promise((resolve, reject) => {
      let resolved = false;
      const sid = 'ms_' + Math.random().toString(36).slice(2, 9);
      const params = new URLSearchParams({
        platform,
        key: streamKey,
        roomName,
        sessionId: sid,
        quality: this.selectedQuality || '540p',
        ...(customUrl ? { customUrl } : {})
      });
      const wsUrl = `${proto}://${targetHost}/api/stream/ws?${params}`;

      this.sessionId = sid;
      this._pendingChunks = [];
      this.streamMethod = 'websocket';

      console.info(`[MultiStream STEP 5.3/8] Opening WebSocket connection: ${wsUrl.replace(streamKey, '***')}`);
      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      this._ws = ws;

      const CONNECT_TIMEOUT = isLocal ? 15000 : 45000;
      let connectTimer = setTimeout(() => {
        if (!resolved) {
          try { ws.close(); } catch (_) {}
          this.compositor.stop();
          console.error(`[MultiStream ERROR at STEP 5] Connection timed out (${targetHost})`);
          reject(new Error(`Connection to streaming server timed out (${targetHost}). If using Render free tier, the server may be waking up—please try starting again in a moment.`));
        }
      }, CONNECT_TIMEOUT);

      ws.onopen = () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(connectTimer);
        console.info('[MultiStream STEP 6/8] WebSocket connected to relay! Initializing unified MediaRecorder...');
        try {
          this._stopMediaRecorder();
          this._pendingChunks = [];
          this._startMediaRecorder(stream, ws);
          resolve();
        } catch (recErr) {
          console.error('[MultiStream ERROR at STEP 6] MediaRecorder start error:', recErr);
          this.compositor.stop();
          try { ws.close(); } catch (_) {}
          reject(new Error('Broadcast recording error: ' + (recErr.message || recErr)));
        }
      };

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'ready') {
            console.info('[MultiStream STEP 6.5/8] Relay server confirmed ready. Awaiting media chunks.');
          } else if (msg.type === 'started') {
            console.info('[MultiStream STEP 7.2/8] Relay server received media chunk and launched FFmpeg.');
          } else if (msg.type === 'rtmp-connected') {
            this._rtmpTransportConnected = true;
            console.info('[MultiStream STEP 7.5/8] 🟡 Relay FFmpeg connected to RTMP destination! Handshake complete.');
            if (this.streamStatusBadge && !this.hasConfirmedLive) {
              this.streamStatusBadge.className = 'status-badge-connecting';
              this.streamStatusBadge.innerHTML = '<span class="badge-dot" style="background:#ffd166;"></span> CONNECTED (Publishing to YouTube…)';
            }
          } else if (msg.type === 'live' || msg.type === 'streaming') {
            this.hasConfirmedLive = true;
            console.info('[MultiStream STEP 8/8] 🔴 CONFIRMED LIVE ON YOUTUBE! Streaming frames.', msg.stats);
            if (this.streamStatusBadge) {
              const platLabel = (this.activePlatform || 'YOUTUBE').toUpperCase().replace('_RTMPS', '').replace('_RTMP_STANDARD', '');
              const rate = msg.stats?.bitrate ? ` (${msg.stats.bitrate})` : '';
              this.streamStatusBadge.className = 'status-badge-live';
              this.streamStatusBadge.innerHTML = `<span class="badge-dot"></span> LIVE ON ${platLabel}${rate} (10s Buffer Active)`;
            }
            this.updateStateUI();
          } else if (msg.type === 'error') {
            this.hasConfirmedLive = false;
            console.error(`[MultiStream ERROR from Relay]: ${msg.message}`);
            let friendlyMsg = 'Stream error: ' + msg.message;
            if (/I\/O error|End of file|Broken pipe|refused|failed to connect|cannot open connection|error in the pull function|inactive stream key/i.test(msg.message)) {
              friendlyMsg = '⚠️ YouTube connection failed: ' + msg.message + '\n\n💡 Fixes in YouTube Studio:\n1. Make sure your live stream in YouTube Studio (studio.youtube.com) is in "Ready" or "Stream" mode.\n2. If you previously started or stopped a stream, YouTube marks that broadcast as finished. Click "Reset" next to your stream key in Stream Settings, copy the new key, and paste it here.\n3. Make sure you select "YouTube Live (RTMPS Secure)" which uses port 443.';
            }
            this.showError(friendlyMsg);
            this.stopBroadcast();
            this.openModal();
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
          console.error(`[MultiStream ERROR at STEP 5] WebSocket connection error to ${targetHost}`);
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
      'video/webm;codecs=vp9,opus',
      'video/webm',
      'video/mp4;codecs=avc1,mp4a'
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

    this._stopMediaRecorder();
    this._pendingChunks = [];

    const BUFFER_TARGET_CHUNKS = 10; // 10 seconds delay buffer to prevent YouTube buffering
    let isBufferingInitial = true;
    const chunkQueue = [];
    let isProcessingQueue = false;
    let chunkCount = 0;

    const flushQueue = async () => {
      if (isProcessingQueue) return;
      if (isBufferingInitial) return; // Wait until 10-second pre-roll buffer is gathered
      isProcessingQueue = true;
      while (chunkQueue.length > 0 && ws.readyState === WebSocket.OPEN) {
        const item = chunkQueue.shift();
        try {
          chunkCount++;
          if (chunkCount === 1) {
            console.info(`[MultiStream STEP 7/8] Chunk #1 transmitted to relay via WebSocket (${item.size || item.byteLength || 'binary'} bytes, 10s pre-roll buffer releasing). Awaiting FFmpeg initialization.`);
          } else if (chunkCount % 10 === 0) {
            console.info(`[MultiStream UPLOAD] Transmitted ${chunkCount} media chunks to relay (10s continuous buffer active).`);
          }
          if (item instanceof Blob) {
            const buf = await item.arrayBuffer();
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(buf);
            }
          } else if (ws.readyState === WebSocket.OPEN) {
            ws.send(item);
          }
        } catch (err) {
          console.warn('[MultiStream] Chunk transmit warning:', err);
        }
      }
      isProcessingQueue = false;
    };

    recorder.ondataavailable = (ev) => {
      if (!ev.data || ev.data.size === 0) return;
      chunkQueue.push(ev.data);

      if (isBufferingInitial) {
        const currentSeconds = chunkQueue.length;
        console.info(`[MultiStream STEP 7.0/8] Buffering 10s smooth playback delay: ${currentSeconds}/${BUFFER_TARGET_CHUNKS}s...`);
        if (this.streamStatusBadge && !this.hasConfirmedLive) {
          this.streamStatusBadge.className = 'status-badge-connecting';
          this.streamStatusBadge.innerHTML = `<span class="badge-dot" style="background:#ffd166;"></span> BUFFERING (${currentSeconds}/${BUFFER_TARGET_CHUNKS}s DELAY)`;
        }
        if (this.btnStartStream && !this.hasConfirmedLive) {
          this.btnStartStream.textContent = `Buffering (${currentSeconds}/${BUFFER_TARGET_CHUNKS}s)…`;
        }

        if (currentSeconds >= BUFFER_TARGET_CHUNKS) {
          isBufferingInitial = false;
          console.info(`[MultiStream STEP 7.1/8] 10-second smooth buffer primed! Releasing pre-buffered media pipeline to cloud relay.`);
          if (this.streamStatusBadge && !this.hasConfirmedLive) {
            this.streamStatusBadge.innerHTML = '<span class="badge-dot" style="background:#ffd166;"></span> CONNECTING TO YOUTUBE…';
          }
          flushQueue();
        }
      } else {
        flushQueue();
      }
    };

    recorder.onerror = (e) => {
      console.error('[MultiStream ERROR at MediaRecorder]:', e);
      this.showError('Video/Audio capture error: ' + (e?.error?.message || 'MediaRecorder failed'));
    };

    recorder.onstop = () => {
      console.info('[MultiStream] MediaRecorder stopped');
    };

    // 1000ms timeslice ensures clean 1-second keyframe clusters without sub-second cluster fragmentation
    recorder.start(1000);
    this._recorder = recorder;
    console.info(`[MultiStream STEP 6.1/8] MediaRecorder active (1000ms clusters @ 128k AAC / 2.5M video, mimeType: ${recorder.mimeType || 'default'})`);
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
      const platLabel = (this.activePlatform || 'external platform').toUpperCase().replace('_RTMPS', '').replace('_RTMP_STANDARD', '');
      if (this.streamStatusBadge) {
        if (this.hasConfirmedLive) {
          this.streamStatusBadge.className = 'status-badge-live';
          this.streamStatusBadge.innerHTML = `<span class="badge-dot"></span> LIVE ON ${platLabel}`;
        } else if (this._rtmpTransportConnected) {
          this.streamStatusBadge.className = 'status-badge-connecting';
          this.streamStatusBadge.innerHTML = `<span class="badge-dot" style="background:#ffd166;"></span> CONNECTED (Publishing to ${platLabel}…)`;
        } else {
          this.streamStatusBadge.className = 'status-badge-connecting';
          this.streamStatusBadge.innerHTML = `🟡 CONNECTING TO ${platLabel}…`;
        }
      }
      if (this.btnStartStream)   this.btnStartStream.style.display  = 'none';
      if (this.btnStopStream)    this.btnStopStream.style.display   = 'inline-flex';
      if (this.platformSelect)   this.platformSelect.disabled       = true;
      if (this.inputStreamKey)   this.inputStreamKey.disabled       = true;
      if (this.inputCustomUrl)   this.inputCustomUrl.disabled       = true;
      if (this.topbarBadge) {
        this.topbarBadge.style.display = 'inline-flex';
        if (this.hasConfirmedLive) {
          this.topbarBadge.style.background = '#22c55e';
          this.topbarBadge.textContent   = `🔴 LIVE ON ${platLabel}`;
        } else if (this._rtmpTransportConnected) {
          this.topbarBadge.style.background = '#f59e0b';
          this.topbarBadge.textContent   = `🟡 Publishing to ${platLabel}…`;
        } else {
          this.topbarBadge.style.background = '#f59e0b';
          this.topbarBadge.textContent   = `🟡 Connecting ${platLabel}…`;
        }
        this.topbarBadge.onclick = () => this.openModal();
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
