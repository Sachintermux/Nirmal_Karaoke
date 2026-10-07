import { FaceFilterEngine, FACE_FILTERS } from './face-filters.js?v=29';

const LK = () => window.LivekitClient;

// High-fidelity music transport: stereo Opus with ultra-low latency and
// high RTP priority. We disable RED for instant real-time packet playout without queuing delay.
const KARAOKE_STEREO_AUDIO_PRESET = { maxBitrate: 128_000, priority: 'high' };
const NIRMAL_LOW_LATENCY_AUDIO = {
  // Ultra-low latency audio: start at 0ms and play packets immediately.
  initialMs: 0,
  healthyMs: 0,
  moderateMs: 15,
  badMs: 30,
  severeMs: 50,
  criticalMs: 80,
  lowerAfterHealthySamples: 3
};

// Token endpoints in order of preference; the always-on backend is the last resort so a cold or
// failing serverless function does not stop the host from going live.
function livekitTokenEndpoints() {
  const list = ['/api/livekit/token', '/.netlify/functions/livekit-token'];
  const add = (host, proto) => {
    const url = `${proto}//${host}/api/livekit/token`;
    if (!list.includes(url)) list.push(url);
  };
  const savedRelay = (localStorage.getItem('nirmal_stream_relay_url') || '').trim();
  if (savedRelay) {
    const cleanHost = savedRelay.replace(/^https?:\/\//i, '').replace(/^wss?:\/\//i, '').replace(/\/$/, '');
    add(cleanHost, savedRelay.startsWith('http://') ? 'http:' : 'https:');
  }
  const h = location.hostname;
  if (h !== 'localhost' && h !== '127.0.0.1' && !h.endsWith('.onrender.com')) add('nirmal-karaoke.onrender.com', 'https:');
  return list;
}

// One failed handshake should not leave the host stuck: retry with a short backoff.
async function connectRoomWithRetry(room, url, token, options = {}) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await room.connect(url, token, { autoSubscribe: true, maxRetries: 2, ...options });
      return;
    } catch (e) {
      lastErr = e;
      console.warn(`[Nirmal] LiveKit connect attempt ${attempt + 1} failed:`, e?.message || e);
      if (attempt < 2) await new Promise((res) => setTimeout(res, 900 * (attempt + 1)));
    }
  }
  throw lastErr;
}

async function fetchToken(room, identity, role) {
  let customLk = null;
  try {
    customLk = JSON.parse(localStorage.getItem('nirmal_livekit_config') || '{}');
  } catch (_) {}

  let singerName = '';
  try { singerName = JSON.parse(localStorage.getItem('nirmal_singer_profile') || '{}')?.name || ''; } catch (_) {}

  const payload = {
    roomName: room,
    identity,
    ...(singerName ? { name: singerName } : {}),
    role,
    ...(customLk?.url ? { livekitUrl: customLk.url } : {}),
    ...(customLk?.apiKey ? { apiKey: customLk.apiKey } : {}),
    ...(customLk?.apiSecret ? { apiSecret: customLk.apiSecret } : {})
  };

  const endpoints = livekitTokenEndpoints();

  let lastError = null;
  for (const endpoint of endpoints) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        signal: controller.signal,
        body: JSON.stringify(payload)
      });
      const data = await r.json().catch(() => ({}));
      if (r.ok && data.token && data.url) return data;
      lastError = new Error(data.error || `LiveKit token request failed (${r.status})`);
      if (r.status === 400 || r.status === 401) break;
    } catch (e) {
      lastError = e?.name === 'AbortError' ? new Error(`LiveKit token endpoint timed out: ${endpoint}`) : e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error('LiveKit token endpoint is unavailable.');
}

export class LiveKitLiveStreamHost {
  constructor(audioEngine) {
    this.audioEngine = audioEngine;
    this.roomId = null;
    this.room = null;
    this.connections = new Map();
    this.guestStreams = new Map();
    // Audience microphone tracks are keyed by participant + track SID so the
    // admin can monitor multiple independent mic publications safely.
    this.guestAudioElements = new Map();
    // Admin-only remote audience monitoring. Each LiveKit RemoteAudioTrack is
    // played through its own HTMLAudioElement/MediaStream path and is never
    // connected to the host program MediaStreamDestination.
    this.mutedGuests = new Set();
    this.allowDuet = true;
    this.latestLyrics = [];
    this.latestTimePayload = null;
    this.onRoomCreated = null;
    this.onAudienceCountUpdate = null;
    this.onChatMessage = null;
    this.onAudienceListUpdate = null;
    // Remote audience audio is received separately from the host program mix.
    // Keep local audience monitoring OFF by default so guest microphones cannot
    // be heard in the admin UI or accidentally re-enter a speaker/loopback capture.
    // A dedicated AudioContext consumes each LiveKit RemoteAudioTrack directly.
    // This avoids HTML-media autoplay state, hidden-element behaviour and LiveKit
    // startAudio/attach coupling on the admin side.
    this.duetMonitorEnabled = false;
    this.guestVideos = new Map();
    this.hostCamera = null;
    this.filterManager = new FaceFilterEngine({ width: 640, height: 360 });
    this.programPublication = null;
    this.programTrack = null;
    this.hostReconnectTimer = null;
    this.hostReconnectAttempts = 0;
    this.hostReconnectInFlight = false;
    this.lastLiveKitError = null;
    this.audienceMonitorUnlocked = false;
    this.audioWatchdogTimer = null;
    this.visualBroadcastRaf = null;
    this._lastVisualTs = 0;
    this._visDataArray = null;

    if (typeof window !== 'undefined') {
      window.addEventListener('offline', () => {
        if (this.roomId || this.room) {
          console.warn('[Nirmal] Host network dropped (offline). Forcefully resetting live state.');
          this.teardownRoomOnDisconnect('Internet connection dropped. Tap "Go live" to restart once reconnected.');
        }
      });
    }
  }

  isConnected() {
    return !!(this.room && this.room.state === 'connected' && this.roomId);
  }

  init(onRoomCreated, onAudienceCountUpdate, onChatMessage, onAudienceListUpdate, onRoomDisconnected, onDuetRequest) {
    this.onRoomCreated = onRoomCreated;
    this.onAudienceCountUpdate = onAudienceCountUpdate;
    this.onChatMessage = onChatMessage;
    this.onAudienceListUpdate = onAudienceListUpdate;
    this.onRoomDisconnected = onRoomDisconnected;
    this.onDuetRequest = onDuetRequest;
  }

  async createRoom(allowDuet = true) {
    if (this.audioEngine) {
      try { await this.audioEngine.boot(); } catch (err) {
        console.warn('[Nirmal] AudioEngine boot in createRoom:', err);
      }
    }

    if (this.isConnected()) {
      try { await this.ensureProgramAudioPublished(); } catch (e) { console.warn('[Nirmal] program audio retry:', e); }
      return this.roomId;
    }

    const L = LK();
    if (!L?.Room || !L?.Track?.Source || !L?.Track?.Kind || !L?.RoomEvent) {
      throw new Error('LiveKit client is not loaded. Refresh the page and try Go Live again.');
    }

    this.allowDuet = !!allowDuet;
    const roomId = 'sing-' + Math.random().toString(36).slice(2, 9);
    const identity = `host-${roomId}`;
    const cfg = await fetchToken(roomId, identity, 'host');
    if (!cfg?.url || !cfg?.token) throw new Error('LiveKit token response is incomplete. Check LIVEKIT_URL/API key configuration.');

    let room = null;
    try {
      room = new L.Room({
        adaptiveStream: true,
        dynacast: true,
        // Keep publisher/subscriber RTP on dedicated peer connections. This
        // prevents camera/program publishing contention from disturbing the
        // remote-audio receive path.
        singlePeerConnection: false,
        publishDefaults: {
          audioPreset: KARAOKE_STEREO_AUDIO_PRESET,
          dtx: false,
          red: true,
          simulcast: false,
          forceStereo: true,
          // Do not generate extra codec variants for the music track.
          backupCodec: false
        }
      });
      this.room = room;
      this.roomId = roomId;
      this.lastLiveKitError = null;
      this.bindRoomEvents();

      // prepareConnection is only a latency optimization; never allow it to
      // block the real connection.
      try { void room.prepareConnection?.(cfg.url, cfg.token); } catch (e) {
        console.info('[Nirmal] LiveKit prepareConnection skipped:', e?.message || e);
      }

      await connectRoomWithRetry(room, cfg.url, cfg.token);
      if (room.state !== 'connected') throw new Error(`LiveKit connected with unexpected state: ${room.state}`);

      // Subscribe to already-published remote media. TrackSubscribed is still the
      // authoritative event for tracks that become available after this loop.
      for (const participant of room.remoteParticipants.values()) {
        for (const publication of participant.trackPublications?.values?.() || []) {
          if (publication.kind === L.Track.Kind.Video || this.isAudienceAudioPublication(publication, participant)) {
            try { await publication.setSubscribed?.(true); } catch (e) {
              console.warn('[Nirmal] initial remote subscription retry:', e);
            }
          }
        }
      }

      console.info('[Nirmal] GO LIVE connected', { room: roomId, state: room.state });
      this.onRoomCreated?.(roomId);
      this.updateAudience();

      // Program audio is independent of transport. A browser AudioContext/media
      // problem must never tear down a healthy LiveKit room.
      try { await this.ensureProgramAudioPublished(); } catch (e) {
        console.warn('[Nirmal] room live; program audio pending:', e);
      }
      this.startAudioPublishWatchdog();
      this.startVisualBroadcast();

      // Immediately broadcast any preloaded lyrics to the newly connected room
      if (this.latestLyrics && this.latestLyrics.length > 0) {
        this.sendData({ type: 'INIT_LYRICS', payload: this.latestLyrics }, { reliable: true });
      }
      if (this.latestTimePayload) {
        this.sendData({ type: 'SYNC_TIME', payload: this.latestTimePayload }, { reliable: false });
      }

      return roomId;
    } catch (error) {
      this.lastLiveKitError = error;
      console.error('[Nirmal] LiveKit Go Live failure:', error);
      try { await room?.disconnect?.(); } catch (_) {}
      this.room = null;
      this.roomId = null;
      this.programPublication = null;
      this.programTrack = null;
      throw new Error(`Go Live failed: ${error?.message || error}`);
    }
  }

  async endRoom() {
    if (this.hostReconnectTimer) {
      clearTimeout(this.hostReconnectTimer);
      this.hostReconnectTimer = null;
    }
    this.hostReconnectInFlight = false;
    this.hostReconnectAttempts = 0;

    // 1. Broadcast ROOM_DISCONTINUED to all audience participants so they know immediately
    const currentRoomId = this.roomId;
    if (this.room?.localParticipant) {
      try {
        const payload = new TextEncoder().encode(JSON.stringify({
          type: 'ROOM_DISCONTINUED',
          roomName: currentRoomId,
          reason: 'Host has ended the live broadcast.'
        }));
        await this.room.localParticipant.publishData(payload, { reliable: true });
        console.info('[Nirmal] ROOM_DISCONTINUED broadcast sent to room');
      } catch (e) {
        console.warn('[Nirmal] broadcast ROOM_DISCONTINUED warning:', e);
      }
    }

    // 2. Notify backend server to mark room as ended and delete SFU room
    if (currentRoomId) {
      try {
        fetch('/api/livekit/end-room', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ roomName: currentRoomId })
        }).catch(err => console.warn('[Nirmal] /api/livekit/end-room fetch error:', err));
      } catch (_) {}
    }

    // 3. Clean up camera & face filter engine
    if (this.hostCamera) {
      try { await this.room?.localParticipant?.unpublishTrack(this.hostCamera); } catch (_) {}
      try { this.hostCamera.stop(); } catch (_) {}
      this.hostCamera = null;
    }
    if (this.filterManager) {
      this.filterManager.stopCamera();
    }
    const localId = this.room?.localParticipant?.identity;
    if (localId) this.removeVideoCard(localId);

    const toolbar = document.getElementById('adminCameraFilterToolbar');
    if (toolbar) toolbar.style.display = 'none';
    const switchBtn = document.getElementById('btnAdminSwitchCamera');
    if (switchBtn) switchBtn.style.display = 'none';

    if (this.programPublication?.track) {
      try { await this.room?.localParticipant?.unpublishTrack(this.programPublication.track, false); } catch (_) {}
    }
    this.programPublication = null;
    this.programTrack = null;

    this.destroyAudienceMonitor();
    this.stopAudioPublishWatchdog();
    this.stopVisualBroadcast();

    try {
      await this.room?.disconnect?.();
    } catch (_) {}

    this.room = null;
    this.roomId = null;
    this.connections.clear();
    this.guestVideos.clear();
    const grid = document.getElementById('liveStageVideoGrid');
    if (grid) grid.innerHTML = '';
    this.updateStageVideoArenaVisibility();
    this.updateAudience();

    const transport = document.getElementById('liveTransportStatus');
    if (transport) transport.textContent = 'Broadcast ended. Ready to go live.';
    try { this.onRoomDisconnected?.('Broadcast ended by host.'); } catch (_) {}
    return true;
  }

  startVisualBroadcast() {
    if (this._visualTimer) return;
    const isMobile = typeof window !== 'undefined' && (window.innerWidth <= 850 || /Android|iPhone|iPad/i.test(navigator.userAgent));
    const BARS = isMobile ? 32 : 40;
    const FRAME_MS = isMobile ? 100 : 80;
    let lastHadSignal = false;

    const tick = () => {
      if (!this.isConnected()) {
        this.stopVisualBroadcast();
        return;
      }
      if (typeof document !== 'undefined' && document.hidden) return;
      // Skip processing when no audience connections are present
      if (!this.connections || this.connections.size === 0) return;

      const analyser = this.audioEngine?.engine?.analyser;
      if (!analyser) return;

      if (!this._visDataArray || this._visDataArray.length !== analyser.frequencyBinCount) {
        this._visDataArray = new Uint8Array(analyser.frequencyBinCount);
      }
      analyser.getByteFrequencyData(this._visDataArray);

      // Downsample to BARS values
      const step = Math.floor(this._visDataArray.length / (BARS * 1.8));
      const bars = new Array(BARS);
      for (let i = 0; i < BARS; i++) {
        bars[i] = this._visDataArray[i * step] || 0;
      }

      // Only send if there's actual signal (or 1 transition frame to silence)
      const hasSignal = bars.some(v => v > 2);
      if (hasSignal || lastHadSignal) {
        lastHadSignal = hasSignal;
        this.sendData({ type: 'VISUAL_DATA', bars: hasSignal ? bars : null }, { reliable: false });
      }
    };

    this._visualTimer = setInterval(tick, FRAME_MS);
  }

  stopVisualBroadcast() {
    if (this._visualTimer) {
      clearInterval(this._visualTimer);
      this._visualTimer = null;
    }
    if (this.visualBroadcastRaf) {
      cancelAnimationFrame(this.visualBroadcastRaf);
      this.visualBroadcastRaf = null;
    }
    // Send one final silent frame so audience canvas fades out
    try { this.sendData({ type: 'VISUAL_DATA', bars: null }, { reliable: false }); } catch (_) {}
  }

  teardownRoomOnDisconnect(reason = 'Disconnected from LiveKit SFU') {
    if (this.hostReconnectTimer) {
      clearTimeout(this.hostReconnectTimer);
      this.hostReconnectTimer = null;
    }
    this.hostReconnectInFlight = false;
    this.hostReconnectAttempts = 0;

    if (this.hostCamera) {
      try { this.hostCamera.stop(); } catch (_) {}
      this.hostCamera = null;
    }
    if (this.filterManager) {
      this.filterManager.stopCamera();
    }
    const localId = this.room?.localParticipant?.identity;
    if (localId) this.removeVideoCard(localId);

    const toolbar = document.getElementById('adminCameraFilterToolbar');
    if (toolbar) toolbar.style.display = 'none';
    const switchBtn = document.getElementById('btnAdminSwitchCamera');
    if (switchBtn) switchBtn.style.display = 'none';

    this.programPublication = null;
    this.programTrack = null;
    this.destroyAudienceMonitor();
    this.stopAudioPublishWatchdog();
    this.stopVisualBroadcast();

    try { this.room?.disconnect?.(); } catch (_) {}
    this.room = null;
    this.roomId = null;
    this.connections.clear();
    this.guestVideos.clear();
    const grid = document.getElementById('liveStageVideoGrid');
    if (grid) grid.innerHTML = '';
    this.updateStageVideoArenaVisibility();
    this.updateAudience();

    const transport = document.getElementById('liveTransportStatus');
    if (transport) transport.textContent = reason;

    try { this.onRoomDisconnected?.(reason); } catch (_) {}
  }


  async ensureProgramAudioPublished() {
    const L = LK();
    if (!this.room?.localParticipant || this.room.state !== 'connected') return null;
    if (this.programPublication?.track && this.programPublication.track.readyState === 'live' && !this.programPublication.isMuted) {
      return this.programPublication;
    }

    if (this.audioEngine?.ctx?.state === 'suspended') {
      try {
        await this.audioEngine.ctx.resume();
      } catch (err) {
        console.warn('[LiveKitHost] AudioEngine context resume warning:', err);
      }
    }

    const mixedTrack = this.audioEngine?.engine?.dest?.stream?.getAudioTracks?.()[0];
    if (!mixedTrack || mixedTrack.readyState !== 'live') {
      console.warn('[Nirmal] Master audio not live yet. Watchdog will auto-publish when playback/mic starts.');
      return null;
    }
    mixedTrack.enabled = true;
    try { mixedTrack.contentHint = 'music'; } catch (_) {}
    try {
      await mixedTrack.applyConstraints({
        channelCount: 2,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        latency: 0.003
      });
    } catch (_) {}

    const publishOptions = {
      source: L.Track.Source.Microphone,
      audioPreset: KARAOKE_STEREO_AUDIO_PRESET,
      dtx: false,
      red: false,
      forceStereo: true,
      name: 'nirmal-program-audio',
      stream: 'nirmal-program'
    };

    if (this.programPublication?.track) {
      try { await this.room.localParticipant.unpublishTrack(this.programPublication.track, false); } catch (_) {}
      this.programPublication = null;
    }

    const publication = await this.room.localParticipant.publishTrack(mixedTrack, publishOptions);
    this.programPublication = publication;
    this.programTrack = publication?.track || null;
    try { await publication?.unmute?.(); } catch (_) {}

    let settings = {};
    try { settings = mixedTrack.getSettings?.() || {}; } catch (_) {}
    const channels = Number(settings.channelCount || this.audioEngine?.engine?.dest?.channelCount || 2);
    const sampleRate = Number(settings.sampleRate || this.audioEngine?.ctx?.sampleRate || 48000);
    const transport = document.getElementById('liveTransportStatus');
    if (transport) transport.textContent = `LiveKit program audio • ${sampleRate} Hz • ${channels >= 2 ? 'STEREO 2ch' : 'MONO SOURCE'} • forceStereo enabled`;
    console.info('[Nirmal] program audio published successfully', {
      sid: publication?.trackSid,
      source: publication?.source,
      kind: publication?.kind,
      muted: publication?.isMuted,
      stereoForced: true,
      channels,
      sampleRate,
      audioPreset: publishOptions.audioPreset?.maxBitrate || 'music-preset'
    });
    return publication;
  }

  startAudioPublishWatchdog() {
    if (this.audioWatchdogTimer) clearInterval(this.audioWatchdogTimer);
    this.audioWatchdogTimer = setInterval(async () => {
      if (this.room?.state === 'connected') {
        const trk = this.programPublication?.track;
        if (!trk || trk.readyState !== 'live' || this.programPublication?.isMuted) {
          try {
            await this.ensureProgramAudioPublished();
          } catch (err) {
            console.warn('[LiveKitHost] Watchdog ensureProgramAudioPublished warning:', err);
          }
        }
      }
    }, 8000);
  }

  stopAudioPublishWatchdog() {
    if (this.audioWatchdogTimer) {
      clearInterval(this.audioWatchdogTimer);
      this.audioWatchdogTimer = null;
    }
  }

  getVideoGrid() {
    let grid = document.getElementById('liveStageVideoGrid');
    if (!grid) {
      grid = document.createElement('div');
      grid.id = 'liveStageVideoGrid';
      grid.className = 'stage-video-grid';
      const arena = document.getElementById('adminStageVideoArena');
      if (arena) arena.appendChild(grid);
      else document.getElementById('stage')?.appendChild(grid);
    }
    return grid;
  }

  updateStageVideoArenaVisibility() {
    const arena = document.getElementById('adminStageVideoArena');
    const grid = document.getElementById('liveStageVideoGrid');
    if (!arena || !grid) return;
    const cards = grid.querySelectorAll('[data-video-identity]');
    const count = cards.length;
    arena.style.display = count > 0 ? 'block' : 'none';
    if (count === 1) {
      grid.style.gridTemplateColumns = '1fr';
    } else {
      grid.style.gridTemplateColumns = 'repeat(auto-fit, minmax(min(100%, 200px), 1fr))';
    }
  }

  removeVideoCard(identity) {
    const grid = document.getElementById('liveStageVideoGrid');
    const card = grid?.querySelector(`[data-video-identity="${CSS.escape(identity)}"]`);
    if (card) {
      const video = card.querySelector('video');
      try { video?.pause?.(); } catch (_) {}
      try { video?.remove?.(); } catch (_) {}
      card.remove();
    }
    const adminCard = grid?.querySelector('[data-is-admin="1"]');
    if (!adminCard) {
      const toolbar = document.getElementById('adminCameraFilterToolbar');
      if (toolbar) toolbar.style.display = 'none';
      const switchBtn = document.getElementById('btnAdminSwitchCamera');
      if (switchBtn) switchBtn.style.display = 'none';
    }
    this.updateStageVideoArenaVisibility();
  }

  renderVideoCard(track, identity, label, isAdmin = false) {
    if (!track) return;
    const grid = this.getVideoGrid();
    this.removeVideoCard(identity);
    const card = document.createElement('div');
    card.dataset.videoIdentity = identity;
    card.dataset.isAdmin = isAdmin ? '1' : '0';
    card.className = 'stage-video-card' + (isAdmin ? ' is-admin' : ' is-guest');
    const video = track.attach();
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true;
    if (isAdmin) {
      video.style.transform = 'none';
    }
    const badge = document.createElement('div');
    badge.className = 'video-badge';
    badge.innerHTML = `<span class="video-live-dot"></span><span>${isAdmin ? '🎤 HOST (YOU)' : `🎤 ${label || 'GUEST SINGER'}`}</span>`;
    card.append(video, badge);

    if (isAdmin) {
      const switchBtn = document.createElement('button');
      switchBtn.className = 'stage-layout-btn admin-card-switch-cam';
      switchBtn.type = 'button';
      switchBtn.title = 'Switch between Front and Rear camera';
      switchBtn.innerHTML = `🔄 Switch Cam (${this.filterManager?.isFrontCamera() ? 'Front' : 'Rear'})`;
      switchBtn.style.cssText = 'position:absolute;top:8px;right:8px;z-index:10;background:rgba(0,0,0,0.75);color:#fff;border:1px solid rgba(255,255,255,0.25);border-radius:8px;padding:4px 9px;font-size:11px;font-weight:700;cursor:pointer;backdrop-filter:blur(8px);';
      switchBtn.onclick = async (e) => {
        e.stopPropagation();
        await this.switchHostCamera();
      };
      card.appendChild(switchBtn);

      this.renderAdminFilterToolbar();
    }

    grid.appendChild(card);
    // Always keep the admin camera first (on the left), then guest cameras.
    const adminCard = grid.querySelector('[data-is-admin="1"]');
    if (adminCard) grid.prepend(adminCard);
    this.updateStageVideoArenaVisibility();
    return video;
  }

  renderAdminFilterToolbar() {
    let toolbar = document.getElementById('adminCameraFilterToolbar');
    if (!toolbar) {
      toolbar = document.createElement('div');
      toolbar.id = 'adminCameraFilterToolbar';
      toolbar.className = 'camera-filter-toolbar';
      const arena = document.getElementById('adminStageVideoArena');
      if (arena) arena.appendChild(toolbar);
      else document.getElementById('stage')?.appendChild(toolbar);
    }
    toolbar.style.display = 'flex';
    const currentFilter = this.getHostFilter();
    toolbar.innerHTML = `
      <div class="camera-filter-header">
        <span>🎭 Face Filters (Snapchat Style)</span>
        <button id="btnAdminToolbarSwitchCam" type="button" class="stage-layout-btn" style="cursor:pointer;font-size:10px;padding:3px 8px;border-radius:6px;">🔄 Switch Cam (${this.filterManager?.isFrontCamera() ? 'Front' : 'Rear'})</button>
      </div>
      <div class="filter-strip" id="adminFilterStrip">
        ${FACE_FILTERS.map(f => `
          <button type="button" class="filter-pill ${f.id === currentFilter ? 'active' : ''}" data-filter="${f.id}" title="${f.title}">
            <span class="filter-icon">${f.icon}</span>
            <span class="filter-name">${f.label}</span>
          </button>
        `).join('')}
      </div>
    `;

    const switchBtn = toolbar.querySelector('#btnAdminToolbarSwitchCam');
    if (switchBtn) {
      switchBtn.onclick = () => this.switchHostCamera();
    }

    toolbar.querySelectorAll('.filter-pill').forEach(pill => {
      pill.onclick = () => {
        const fid = pill.dataset.filter;
        this.setHostFilter(fid);
        toolbar.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
      };
    });
  }

  async switchHostCamera() {
    if (!this.filterManager?.active) return;
    try {
      const res = await this.filterManager.switchCamera();
      const grid = this.getVideoGrid();
      const adminVideo = grid?.querySelector('[data-is-admin="1"] video');
      if (adminVideo) {
        adminVideo.style.transform = 'none';
      }
      const label = `🔄 Switch Cam (${this.filterManager.isFrontCamera() ? 'Front' : 'Rear'})`;
      const cardBtn = grid?.querySelector('.admin-card-switch-cam');
      if (cardBtn) cardBtn.innerHTML = label;
      const toolbarBtn = document.getElementById('btnAdminToolbarSwitchCam');
      if (toolbarBtn) toolbarBtn.textContent = label;
      const quickBtn = document.getElementById('btnAdminSwitchCamera');
      if (quickBtn) quickBtn.textContent = `🔄 Cam (${this.filterManager.isFrontCamera() ? 'Front' : 'Rear'})`;
      return res;
    } catch (e) {
      console.warn('[Nirmal] switch camera error:', e);
      alert('Could not switch camera: ' + (e.message || e));
    }
  }

  setHostFilter(filterId) {
    if (this.filterManager) {
      this.filterManager.setFilter(filterId);
    }
  }

  getHostFilter() {
    return this.filterManager ? this.filterManager.getFilter() : 'none';
  }

  async toggleHostCamera() {
    const isLive = Boolean(this.room?.localParticipant && this.room.state === 'connected');
    const L = LK();
    if (this.hostCamera) {
      if (isLive) {
        try { await this.room.localParticipant.unpublishTrack(this.hostCamera); } catch (_) {}
      }
      this.removeVideoCard(isLive ? this.room.localParticipant.identity : 'local-host');
      if (this.filterManager) this.filterManager.stopCamera();
      try { this.hostCamera.stop(); } catch (_) {}
      this.hostCamera = null;
      const toolbar = document.getElementById('adminCameraFilterToolbar');
      if (toolbar) toolbar.style.display = 'none';
      const switchBtn = document.getElementById('btnAdminSwitchCamera');
      if (switchBtn) switchBtn.style.display = 'none';
      return false;
    }

    const camRes = await this.filterManager.startCamera({ facingMode: 'user' });
    const cameraTrack = camRes.track;
    if (isLive && L?.Track?.Source) {
      const publication = await this.room.localParticipant.publishTrack(cameraTrack, {
        source: L.Track.Source.Camera,
        simulcast: true,
        degradationPreference: 'maintain-framerate',
        videoEncoding: { maxBitrate: 160_000, maxFramerate: 15, priority: 'low' },
        name: 'nirmal-host-camera',
        stream: 'nirmal-host-camera'
      });
      this.hostCamera = publication?.track || this.room.localParticipant.getTrackPublication?.(L.Track.Source.Camera)?.track || cameraTrack;
    } else {
      this.hostCamera = cameraTrack;
    }
    if (!this.hostCamera) {
      try { cameraTrack.stop(); } catch (_) {}
      throw new Error('Camera device failed to start.');
    }
    const identity = isLive ? this.room.localParticipant.identity : 'local-host';
    this.renderVideoCard(this.hostCamera, identity, 'ADMIN', true);

    const switchBtn = document.getElementById('btnAdminSwitchCamera');
    if (switchBtn) switchBtn.style.display = 'inline-block';

    return true;
  }

  /**
   * Admin audience microphone monitor.
   *
   * Canonical LiveKit receive path:
   *   RemoteAudioTrack -> track.attach() -> HTMLAudioElement -> admin speakers
   *
   * There is intentionally no Web Audio connection and no connection to the
   * host program MediaStreamDestination. The audio element is attached as soon
   * as the remote microphone subscription is ready, muted while monitoring is
   * OFF, and played when monitoring is enabled. This matches LiveKit's own
   * browser playback model and avoids losing the real remote RTP track inside
   * a second custom receive graph.
   */
  ensureAudienceAudioElement(item) {
    if (!item?.track || !item.isMic) return null;
    if (item.audio && item.audio.isConnected) return item.audio;

    let audio = null;
    try {
      // LiveKit owns the remote MediaStreamTrack and its lifecycle.
      audio = item.track.attach();
    } catch (e) {
      console.error('[Nirmal] RemoteAudioTrack.attach failed for audience mic:', e);
      return null;
    }

    audio.autoplay = true;
    audio.playsInline = true;
    audio.controls = false;
    audio.preload = 'none';
    audio.dataset.livekitAudienceAudio = 'true';
    audio.dataset.participant = item.participant?.identity || '';
    audio.dataset.trackSid = item.publication?.trackSid || '';
    // Keep the media element rendered-but-invisible. Do not use display:none.
    audio.style.cssText = 'position:fixed;width:2px;height:2px;opacity:0.01;pointer-events:none;left:0;bottom:0;z-index:0;';
    audio.muted = true;
    audio.volume = 0;
    audio.addEventListener('error', () => {
      console.warn('[Nirmal] audience monitor audio element error:', audio.error);
    });
    this.setAudienceMonitorJitterTarget(item.track, NIRMAL_LOW_LATENCY_AUDIO.initialMs);
    audio.addEventListener('playing', () => this.updateAudienceMonitorStatus());
    audio.addEventListener('pause', () => this.updateAudienceMonitorStatus());
    document.body.appendChild(audio);

    // Actively start playback (even while muted) to ensure Chromium decodes WebRTC RTP frames into MediaStreamTrack
    try {
      const playPromise = audio.play();
      if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch(() => {});
      }
    } catch (_) {}

    item.audio = audio;
    this.guestAudioElements.set(item.key, item);
    this.applyAudienceAudioOutputDevice(item);
    return audio;
  }

  setAudienceMonitorJitterTarget(track, targetMs) {
    if (!track) return 0;
    const ms = Math.max(0, Math.min(NIRMAL_LOW_LATENCY_AUDIO.criticalMs, Math.round(targetMs / 5) * 5));
    try {
      const receiver = track.receiver;
      if (receiver && 'jitterBufferTarget' in receiver) {
        if (receiver.jitterBufferTarget !== ms) {
          receiver.jitterBufferTarget = ms;
        }
        track.__nirmalJitterTargetMs = ms;
        return ms;
      }
      if (receiver && 'playoutDelayHint' in receiver) {
        const sec = ms / 1000;
        if (receiver.playoutDelayHint !== sec) {
          receiver.playoutDelayHint = sec;
        }
        track.__nirmalJitterTargetMs = ms;
        return ms;
      }
    } catch (_) {}
    try {
      if (typeof track.setPlayoutDelay === 'function') {
        const sec = ms / 1000;
        if (track.getPlayoutDelay?.() !== sec) {
          track.setPlayoutDelay(sec);
        }
        track.__nirmalJitterTargetMs = ms;
        return ms;
      }
    } catch (_) {}
    return 0;
  }

  getAudienceMonitorJitterTarget(track) {
    try {
      const receiver = track?.receiver;
      if (receiver && 'jitterBufferTarget' in receiver && Number.isFinite(receiver.jitterBufferTarget)) {
        return Number(receiver.jitterBufferTarget);
      }
    } catch (_) {}
    if (Number.isFinite(track?.__nirmalJitterTargetMs)) return track.__nirmalJitterTargetMs;
    return NIRMAL_LOW_LATENCY_AUDIO.healthyMs;
  }

  handleAudienceAudioStall(item, reason = 'stall') {
    if (!item?.track) return;
    const state = item.continuity || (item.continuity = { healthy: 0, lastDelay: NIRMAL_LOW_LATENCY_AUDIO.initialMs / 1000, stalls: 0 });
    state.stalls = (state.stalls || 0) + 1;
    state.healthy = 0;
    const currentMs = this.getAudienceMonitorJitterTarget(item.track) || NIRMAL_LOW_LATENCY_AUDIO.initialMs;
    const step = state.stalls <= 2 ? 10 : 15;
    const maxTarget = state.stalls > 4 ? NIRMAL_LOW_LATENCY_AUDIO.criticalMs : NIRMAL_LOW_LATENCY_AUDIO.severeMs;
    const nextMs = Math.min(maxTarget, Math.max(currentMs + step, NIRMAL_LOW_LATENCY_AUDIO.moderateMs));
    state.lastDelay = nextMs / 1000;
    this.setAudienceMonitorJitterTarget(item.track, nextMs);
    if (this.duetMonitorEnabled) {
      try {
        const p = item.audio?.play?.();
        p?.catch?.(() => {});
      } catch (_) {}
    }
    console.warn('[Nirmal] audience audio stall detected; increasing continuity buffer', {
      participant: item.participant?.identity, reason, delayMs: Math.round(nextMs), stalls: state.stalls
    });
  }

  playAudienceItem(item) {
    if (!item?.isMic || !item.audio) return false;
    if (item.track?.isMuted || this.mutedGuests.has(item.participant?.identity)) return false;
    try {
      // A successfully unlocked LiveKit room permits later remote tracks to
      // autoplay. Keep autoplay true for singers who join after the button tap.
      item.audio.autoplay = true;
      item.audio.muted = false;
      item.audio.volume = 1;
      try { item.track?.start?.(); } catch (_) {}
      try { item.track?.setVolume?.(1); } catch (_) {}
      const promise = item.audio.play();
      if (promise?.catch) {
        promise.catch((e) => {
          console.warn('[Nirmal] audience monitor audio.play rejected:', e);
          const status = document.getElementById('liveTransportStatus');
          if (status && this.duetMonitorEnabled) {
            status.textContent = `Audience audio is ready but browser playback was blocked: ${e?.message || 'tap Hear audience audio again'}`;
          }
        });
      }
      return true;
    } catch (e) {
      console.warn('[Nirmal] audience monitor play failed:', e);
      return false;
    }
  }

  stopAudienceItem(item) {
    if (!item?.audio) return;
    item.audio.autoplay = false;
    try { item.audio.pause(); } catch (_) {}
    item.audio.muted = true;
    item.audio.volume = 0;
    try { item.track?.setVolume?.(0); } catch (_) {}
  }

  updateAudienceMonitorStatus() {
    const el = document.getElementById('audienceMonitorState');
    if (!el) return;
    if (!this.duetMonitorEnabled) { el.textContent = 'OFF'; return; }
    const items = [...this.guestAudioElements.values()].filter(i => i?.isMic);
    const playing = items.filter(i => i.audio && !i.audio.paused && !i.audio.muted && i.audio.volume > 0).length;
    el.textContent = items.length ? `ON • ${playing}/${items.length}` : 'ON • waiting';
  }

  applyAudienceAudioOutputDevice(item) {
    const audio = item?.audio;
    if (!audio || typeof audio.setSinkId !== 'function') return;
    const deviceId = document.getElementById('speakerSelect')?.value || '';
    if (!deviceId) return;
    audio.setSinkId(deviceId).catch((e) => {
      console.warn('[Nirmal] audience monitor speaker selection failed:', e);
    });
  }

  refreshAudienceMonitorOutputDevice() {
    for (const item of this.guestAudioElements.values()) this.applyAudienceAudioOutputDevice(item);
    return true;
  }

  /**
   * This is the trusted-gesture entry point used by the admin button.
   * Do not await remote subscription work before starting browser playback.
   */
  unlockAudienceAudioFromGesture() {
    if (!this.room?.localParticipant) throw new Error('Start the live room first.');
    this.audienceMonitorUnlocked = true;

    // IMPORTANT: invoke LiveKit's browser-audio unlock synchronously from the
    // actual admin click. Do not await it before subscription/playback setup.
    let startPromise = Promise.resolve();
    try {
      if (typeof this.room.startAudio === 'function') startPromise = this.room.startAudio();
    } catch (e) {
      console.warn('[Nirmal] room.startAudio invocation failed:', e);
    }

    // Existing attached remote mics are also played from the same user gesture.
    for (const item of this.guestAudioElements.values()) this.playAudienceItem(item);
    return startPromise;
  }

  primeAudienceMonitorFromGesture() {
    if (!this.room?.localParticipant || !this.duetMonitorEnabled) return false;
    for (const item of this.guestAudioElements.values()) this.playAudienceItem(item);
    this.updateAudienceMonitorStatus();
    return true;
  }

  async setAudienceMonitorEnabledFromGesture(enabled) {
    const L = LK();
    const next = !!enabled;
    if (!this.room?.localParticipant || !L?.Track?.Kind?.Audio) return false;

    if (!next) {
      this.duetMonitorEnabled = false;
      this.audienceMonitorUnlocked = false;
      for (const item of this.guestAudioElements.values()) this.stopAudienceItem(item);
      this.updateAudienceMonitorStatus();
      return true;
    }

    // Set state and trigger the browser-unlock call before awaiting anything.
    this.duetMonitorEnabled = true;
    const unlockPromise = this.unlockAudienceAudioFromGesture();

    // Request all known audience microphone subscriptions immediately as well.
    // autoSubscribe remains enabled, but explicit subscription closes publication
    // timing races without delaying the trusted browser gesture.
    const subscribePromises = [];
    for (const participant of this.room.remoteParticipants.values()) {
      for (const publication of participant.trackPublications?.values?.() || []) {
        if (publication.kind !== L.Track.Kind.Audio || !this.isAudienceAudioPublication(publication, participant)) continue;
        try {
          if (!publication.isSubscribed && publication.setSubscribed) {
            subscribePromises.push(Promise.resolve(publication.setSubscribed(true)));
          }
          const track = publication.audioTrack || publication.track;
          if (track?.kind === L.Track.Kind.Audio) {
            const item = this.upsertAudienceMicItem(track, publication, participant);
            this.ensureAudienceAudioElement(item);
            this.playAudienceItem(item);
          }
        } catch (e) {
          console.warn('[Nirmal] audience monitor subscription request failed:', participant.identity, e);
        }
      }
    }

    // Let the LiveKit audio unlock and subscription negotiations progress.
    await Promise.allSettled([unlockPromise, ...subscribePromises]);
    await this.reconcileAudienceMicPublications();
    this.primeAudienceMonitorFromGesture();
    this.updateAudienceMonitorStatus();
    console.info('[Nirmal] audience monitor ON', {
      tracks: this.guestAudioElements.size,
      canPlaybackAudio: this.room.canPlaybackAudio,
      audioElements: [...this.guestAudioElements.values()].map(i => ({
        participant: i.participant?.identity,
        sid: i.publication?.trackSid,
        paused: i.audio?.paused,
        muted: i.audio?.muted,
        volume: i.audio?.volume,
        readyState: i.audio?.readyState
      }))
    });
    return true;
  }

  async setAudienceMonitorEnabled(enabled) {
    return this.setAudienceMonitorEnabledFromGesture(enabled);
  }

  async resumeAudienceAudioPlayback() {
    if (!this.room?.localParticipant || !this.duetMonitorEnabled) return false;
    await this.unlockAudienceAudioFromGesture();
    let playing = 0;
    for (const item of this.guestAudioElements.values()) if (this.playAudienceItem(item)) playing += 1;
    this.updateAudienceMonitorStatus();
    return playing > 0;
  }

  async playAudienceGuest(guestId) {
    if (!this.room?.localParticipant) throw new Error('Start the live room first.');
    this.duetMonitorEnabled = true;
    await this.unlockAudienceAudioFromGesture();
    await this.reconcileAudienceMicPublications();
    let played = false;
    for (const item of this.guestAudioElements.values()) {
      if (item.participant?.identity !== guestId) continue;
      this.ensureAudienceAudioElement(item);
      if (this.playAudienceItem(item)) played = true;
    }
    this.updateAudienceMonitorStatus();
    return played;
  }

  isAudienceMonitorEnabled() {
    return this.duetMonitorEnabled;
  }

  isAudienceAudioPublication(publication, participant) {
    const L = LK();
    if (!publication || publication.kind !== L?.Track?.Kind?.Audio) return false;
    const identity = String(participant?.identity || '');
    // The host is this browser's local participant. Any remote host identity is
    // also excluded so an accidental second admin session cannot be treated as
    // an audience microphone.
    if (identity.startsWith('host-')) return false;
    const screenShareAudio = L?.Track?.Source?.ScreenShareAudio;
    const source = publication?.source;
    // Audience pages only publish microphone audio. Treat a remote audio
    // publication with an unknown/missing source as audience audio too; source
    // metadata should never be allowed to make a real microphone invisible.
    if (source === screenShareAudio || source === 'screen_share_audio') return false;
    return true;
  }

  isAudienceMicPublication(publication, track, participant) {
    return this.isAudienceAudioPublication(publication, participant);
  }

  upsertAudienceMicItem(track, publication, participant) {
    if (!track || !publication || !participant) return null;
    const key = `${participant.identity}:${publication.trackSid || track.sid || track.name || 'mic'}`;
    let item = this.guestAudioElements.get(key);
    if (!item) {
      item = { track, publication, participant, isMic: true, audio: null, key, continuity: { healthy: 0, lastDelay: 0.65, stalls: 0 } };
      this.guestAudioElements.set(key, item);
    } else {
      item.track = track;
      item.publication = publication;
      item.participant = participant;
    }
    this.ensureAudienceAudioElement(item);
    if (this.duetMonitorEnabled && !this.mutedGuests.has(participant.identity) && !track.isMuted && this.audienceMonitorUnlocked) {
      this.playAudienceItem(item);
    }
    // Always bridge guest microphone into AudioEngine broadcast destination (guestMixBus -> stereoMerge -> _broadcastDest)
    const rawTrack = track.mediaStreamTrack || track;
    if (rawTrack && this.audioEngine?.bridgeGuestAudioTrack) {
      this.audioEngine.bridgeGuestAudioTrack(rawTrack, participant.identity);
      if (this.mutedGuests.has(participant.identity) || track.isMuted) {
        this.audioEngine.setGuestAudioVolume?.(participant.identity, 0);
      }
    }
    this.updateAudienceMonitorStatus();
    return item;
  }

  async reconcileAudienceMicPublications() {
    if (!this.room?.remoteParticipants) return 0;
    const L = LK();
    let found = 0;
    for (const participant of this.room.remoteParticipants.values()) {
      if (!participant || participant.identity === this.room.localParticipant?.identity) continue;
      for (const publication of participant.trackPublications?.values?.() || []) {
        if (publication.kind !== L.Track.Kind.Audio || !this.isAudienceAudioPublication(publication, participant)) continue;
        found += 1;
        try {
          if (!publication.isSubscribed) await publication.setSubscribed?.(true);
          const track = publication.audioTrack || publication.track;
          if (!track || track.kind !== L.Track.Kind.Audio) continue;
          const item = this.upsertAudienceMicItem(track, publication, participant);
          this.ensureAudienceAudioElement(item);
          const msTrack = track.mediaStreamTrack || track;
          if (msTrack && this.audioEngine?.bridgeGuestAudioTrack) {
            this.audioEngine.bridgeGuestAudioTrack(msTrack, participant.identity);
            if (this.mutedGuests.has(participant.identity) || track.isMuted) {
              this.audioEngine.setGuestAudioVolume(participant.identity, 0);
            }
          }
        } catch (e) {
          console.warn('[Nirmal] reconcile audience microphone failed:', participant.identity, publication?.trackSid, e);
        }
      }
    }
    return found;
  }

  scheduleHostReconnect() {
    if (this.hostReconnectTimer || this.hostReconnectInFlight || !this.roomId) return;
    this.hostReconnectAttempts += 1;
    if (this.hostReconnectAttempts > 4) {
      console.warn('[Nirmal] host reconnect attempts exhausted; resetting room state');
      this.teardownRoomOnDisconnect('Live broadcast connection lost. Tap "Go live" to restart.');
      return;
    }
    const delay = Math.min(30000, 1000 * Math.pow(2, Math.max(0, this.hostReconnectAttempts - 1)));
    this.hostReconnectTimer = setTimeout(async () => {
      this.hostReconnectTimer = null;
      if (this.hostReconnectInFlight || !this.room || this.room.state === 'connected') return;
      this.hostReconnectInFlight = true;
      try {
        const identity = this.room.localParticipant?.identity || `host-${this.roomId}`;
        const cfg = await fetchToken(this.roomId, identity, 'host');
        await this.room.connect(cfg.url, cfg.token, { autoSubscribe: true, maxRetries: 5 });
        await this.reconcileAudienceMicPublications();
        try {
          await this.ensureProgramAudioPublished();
        } catch (err) {
          console.warn('[LiveKitHost] Reconnect ensureProgramAudioPublished warning:', err);
        }
        if (this.duetMonitorEnabled && this.audienceMonitorUnlocked) {
          for (const item of this.guestAudioElements.values()) {
            this.playAudienceItem(item);
          }
        }
        this.hostReconnectAttempts = 0;
        console.info('[Nirmal] host reconnect successful; guest monitor audio restored');
      } catch (e) {
        console.warn('[Nirmal] host reconnect attempt failed:', e);
        this.scheduleHostReconnect();
      } finally {
        this.hostReconnectInFlight = false;
        this.lastLiveKitError = null;
        this.audienceMonitorUnlocked = this.duetMonitorEnabled;
      }
    }, delay);
  }

  bindRoomEvents() {
    const L = LK();
    this.room.on(L.RoomEvent.ConnectionStateChanged, state => {
      console.info('[Nirmal] LiveKit connection state:', state);
      if (state === 'connected') { this.updateAudienceMonitorStatus(); this.reconcileAudienceMicPublications().catch(() => {}); }
    });
    this.room.on(L.RoomEvent.Reconnecting, () => {
      console.warn('[Nirmal] host LiveKit reconnecting');
    });
    this.room.on(L.RoomEvent.Reconnected, async () => {
      this.hostReconnectAttempts = 0;
      console.info('[Nirmal] host LiveKit reconnected');
      try {
        await this.reconcileAudienceMicPublications();
      } catch (err) {
        console.warn('[LiveKitHost] Reconnected reconcileAudienceMicPublications warning:', err);
      }
      if (this.duetMonitorEnabled) this.primeAudienceMonitorFromGesture();
      try {
        await this.ensureProgramAudioPublished();
      } catch (err) {
        console.warn('[LiveKitHost] Reconnected ensureProgramAudioPublished warning:', err);
      }
    });
    this.room.on(L.RoomEvent.Disconnected, reason => {
      console.warn('[Nirmal] host LiveKit disconnected:', reason);
      this.teardownRoomOnDisconnect(`Live connection disconnected (${reason || 'network dropped'}). Tap "Go live" to restart.`);
    });
    this.room.on(L.RoomEvent.LocalTrackPublished, publication => {
      console.info('[Nirmal] local track published:', {
        sid: publication?.trackSid,
        kind: publication?.kind,
        source: publication?.source,
        muted: publication?.isMuted,
        name: publication?.trackName
      });
    });
    this.room.on(L.RoomEvent.LocalTrackUnpublished, publication => {
      console.warn('[Nirmal] local track unpublished:', publication?.trackSid);
    });
    this.room.on(L.RoomEvent.ParticipantConnected, participant => {
      this.connections.set(participant.identity, {
        metadata: { name: participant.name || participant.identity, role: 'listen' }
      });
      // Explicitly subscribe to remote camera/mic publications.
      for (const publication of participant.trackPublications?.values?.() || []) {
        try {
          if (publication.kind === L.Track.Kind.Video || this.isAudienceAudioPublication(publication, participant)) {
            void Promise.resolve(publication.setSubscribed?.(true)).catch((e) => console.warn('[Nirmal] subscription failed:', e));
          }
        } catch (_) {}
      }
      this.updateAudience();

      // Immediately send current lyrics and playback clock to newly connected audience
      if (this.latestLyrics && this.latestLyrics.length > 0) {
        this.sendData({ type: 'INIT_LYRICS', payload: this.latestLyrics }, { reliable: true });
      }
      if (this.latestTimePayload) {
        this.sendData({ type: 'SYNC_TIME', payload: this.latestTimePayload }, { reliable: false });
      }
    });

    this.room.on(L.RoomEvent.TrackPublished, (publication, participant) => {
      if (!publication || !participant || participant.identity === this.room.localParticipant.identity) return;
      if (publication.kind === L.Track.Kind.Video || this.isAudienceAudioPublication(publication, participant)) {
        void Promise.resolve(publication.setSubscribed?.(true)).catch((e) => {
          console.warn('[Nirmal] remote publication subscription failed:', e);
        });
      }
      console.info('[Nirmal] remote publication discovered', {
        participant: participant.identity,
        kind: publication.kind,
        source: publication.source,
        name: publication.trackName,
        sid: publication.trackSid
      });
    });

    this.room.on(L.RoomEvent.ParticipantDisconnected, participant => {
      this.cleanupGuest(participant.identity);
      this.updateAudience();
      this.updateAudienceMonitorStatus();
    });

    this.room.on(L.RoomEvent.TrackSubscribed, (track, publication, participant) => {
      if (participant.identity === this.room.localParticipant.identity) return;
      if (track.kind === L.Track.Kind.Video) {
        const video = this.renderVideoCard(track, participant.identity, participant.name || 'AUDIENCE', false);
        this.guestVideos.set(participant.identity, video);
        return;
      }
      if (track.kind !== L.Track.Kind.Audio || !this.isAudienceAudioPublication(publication, participant)) return;
      const item = this.upsertAudienceMicItem(track, publication, participant);
      this.ensureAudienceAudioElement(item);
      if (this.duetMonitorEnabled && this.audienceMonitorUnlocked && !track.isMuted && !this.mutedGuests.has(participant.identity)) {
        this.playAudienceItem(item);
      }
      // Bridge guest microphone into AudioEngine broadcast destination (dest / stereoMerge / guestMixBus)
      const rawTrack = track.mediaStreamTrack || track;
      if (rawTrack && this.audioEngine?.bridgeGuestAudioTrack) {
        this.audioEngine.bridgeGuestAudioTrack(rawTrack, participant.identity);
        if (this.mutedGuests.has(participant.identity) || track.isMuted) {
          this.audioEngine.setGuestAudioVolume(participant.identity, 0);
        }
      }
      this.updateAudienceMonitorStatus();
      console.info('[Nirmal] audience MIC subscribed & mixed into broadcast', {
        participant: participant.identity,
        name: participant.name,
        sid: publication?.trackSid,
        source: publication?.source,
        monitorEnabled: this.duetMonitorEnabled,
        canPlaybackAudio: this.room.canPlaybackAudio,
        mediaTrackReadyState: track.mediaStreamTrack?.readyState
      });
    });

    this.room.on(L.RoomEvent.TrackMuted, (publication, participant) => {
      if (this.audioEngine?.setGuestAudioVolume && participant?.identity) {
        this.audioEngine.setGuestAudioVolume(participant.identity, 0);
      }
      for (const item of this.guestAudioElements.values()) {
        if (item.participant?.identity !== participant?.identity || item.publication !== publication) continue;
        this.stopAudienceItem(item);
      }
    });
    this.room.on(L.RoomEvent.TrackUnmuted, (publication, participant) => {
      const mutedByAdmin = this.mutedGuests.has(participant?.identity);
      if (this.audioEngine?.setGuestAudioVolume && participant?.identity) {
        this.audioEngine.setGuestAudioVolume(participant.identity, mutedByAdmin ? 0 : 1.0);
      }
      for (const item of this.guestAudioElements.values()) {
        if (item.participant?.identity !== participant?.identity || item.publication !== publication) continue;
        if (this.duetMonitorEnabled && !mutedByAdmin && this.audienceMonitorUnlocked) {
          this.ensureAudienceAudioElement(item);
          this.playAudienceItem(item);
        }
      }
    });
    this.room.on(L.RoomEvent.TrackSubscriptionFailed, (sid, participant) => {
      console.warn('[Nirmal] audience audio subscription failed:', sid, participant?.identity);
      this.lastLiveKitError = new Error(`Could not subscribe to audience audio from ${participant?.name || participant?.identity || 'guest'} (${sid})`);
      this.updateAudience();
    });
    this.room.on(L.RoomEvent.TrackUnpublished, (publication, participant) => {
      if (!participant || publication?.kind !== L.Track.Kind.Audio) return;
      if (this.audioEngine?.removeGuestAudioTrack && participant.identity) {
        this.audioEngine.removeGuestAudioTrack(participant.identity);
      }
      for (const [key, item] of this.guestAudioElements) {
        if (item.participant?.identity !== participant.identity || item.publication?.trackSid !== publication.trackSid) continue;
        try { item.track?.detach?.(item.audio); } catch (_) {}
        try { item.audio?.pause?.(); } catch (_) {}
        try { item.audio?.remove?.(); } catch (_) {}
        this.guestAudioElements.delete(key);
      }
      this.updateAudienceMonitorStatus();
      this.updateAudience();
    });

    this.room.on(L.RoomEvent.AudioPlaybackStatusChanged, () => {
      const canPlay = !!this.room?.canPlaybackAudio;
      console.info('[Nirmal] LiveKit audio playback status:', canPlay);
      if (canPlay && this.duetMonitorEnabled) this.primeAudienceMonitorFromGesture();
    });

    this.room.on(L.RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
      if (track.kind === L.Track.Kind.Audio) {
        if (this.audioEngine?.removeGuestAudioTrack && participant?.identity) {
          this.audioEngine.removeGuestAudioTrack(participant.identity);
        }
        for (const [key, item] of this.guestAudioElements) {
          if (item.track !== track) continue;
          try { item.track?.detach?.(item.audio); } catch (_) {}
          try { item.track?.setVolume?.(0); } catch (_) {}
          try { item.audio && (item.audio.srcObject = null); } catch (_) {}
          try { item.audio?.pause?.(); } catch (_) {}
          try { item.audio?.remove?.(); } catch (_) {}
          this.guestAudioElements.delete(key);
        }
        this.updateAudienceMonitorStatus();
        return;
      }
      if (track.kind === L.Track.Kind.Video) {
        this.removeVideoCard(participant.identity);
        this.guestVideos.delete(participant.identity);
      }
    });

    this.room.on(L.RoomEvent.DataReceived, (payload, participant) => {
      try {
        const data = JSON.parse(new TextDecoder().decode(payload));
        if (!participant) return;
        const id = participant.identity;
        if (data.type === 'GUEST_HELLO') {
          const c = this.connections.get(id) || { metadata: {} };
          c.metadata = {
            ...c.metadata,
            name: data.name || participant.name || 'Guest',
            role: data.role || 'listen',
            isDuetActive: !!data.isDuetActive,
            hasMic: !!data.hasMic,
            hasCamera: !!data.hasCamera
          };
          this.connections.set(id, c);
          this.updateAudience();
          // Late joiners must receive the current lyrics and playback clock
          if (this.latestLyrics && this.latestLyrics.length > 0) {
            this.sendData({ type: 'INIT_LYRICS', payload: this.latestLyrics }, { reliable: true });
          }
          if (this.latestTimePayload) {
            this.sendData({ type: 'SYNC_TIME', payload: this.latestTimePayload }, { reliable: false });
          }
        } else if (data.type === 'REQUEST_STAGE_STATE') {
          if (this.latestLyrics && this.latestLyrics.length > 0) {
            this.sendData({ type: 'INIT_LYRICS', payload: this.latestLyrics }, { reliable: true });
          }
          if (this.latestTimePayload) {
            this.sendData({ type: 'SYNC_TIME', payload: this.latestTimePayload }, { reliable: false });
          }
        } else if (data.type === 'REQUEST_MIC') {
          console.info('[Nirmal] Received duet REQUEST_MIC from', id, data.name);
          this.onDuetRequest?.({
            identity: id,
            name: data.name || participant.name || id
          });
        } else if (data.type === 'ACCEPT_DUET') {
          console.info('[Nirmal] Guest accepted duet invitation:', id, data.name);
          const c = this.connections.get(id) || { metadata: {} };
          c.metadata = {
            ...c.metadata,
            role: 'duet',
            isDuetActive: true
          };
          this.connections.set(id, c);
          this.updateAudience();
          this.onDuetAccepted?.({ identity: id, name: data.name || participant.name || id });
        } else if (data.type === 'AUDIENCE_CHAT') {
          this.onChatMessage?.(data.sender, data.text, data.isSpecial);
          this.broadcastChatMessage(data.sender, data.text, data.isSpecial, false, id);
        }
      } catch (err) {
        console.warn('[LiveKitHost] Failed to parse received data packet:', err);
      }
    });
  }

  async sendData(data, options = {}) {
    if (!this.room?.localParticipant) return;
    const bytes = new TextEncoder().encode(JSON.stringify(data));
    try {
      await this.room.localParticipant.publishData(bytes, options);
    } catch (err) {
      console.warn('[LiveKitHost] sendData publishData warning:', err);
    }
  }

  broadcastChatMessage(sender, text, isSpecial = false, isHost = true, excludeId = null) {
    const options = { reliable: true };
    if (excludeId) {
      const targets = [...this.connections.keys()].filter(id => id !== excludeId);
      if (targets.length > 0) {
        options.destinationIdentities = targets;
      }
    }
    this.sendData({ type: 'CHAT_BROADCAST', sender, text, isSpecial, isHost }, options);
  }

  broadcastFullLyrics(lyrics) {
    this.latestLyrics = Array.isArray(lyrics) ? lyrics : [];
    this.sendData({ type: 'INIT_LYRICS', payload: this.latestLyrics }, { reliable: true });
  }

  broadcastTime(payload) {
    const value = typeof payload === 'number' ? { currentTime: payload, playing: true } : (payload || {});
    this.latestTimePayload = {
      currentTime: Number(value.currentTime || 0),
      playing: value.playing !== false,
      sentAtMs: Number(value.sentAtMs || Date.now())
    };
    this.sendData({ type: 'SYNC_TIME', payload: this.latestTimePayload }, { reliable: false });
  }

  setGuestMute(guestId, muteState) {
    if (muteState) this.mutedGuests.add(guestId); else this.mutedGuests.delete(guestId);
    if (this.audioEngine?.setGuestAudioVolume) {
      this.audioEngine.setGuestAudioVolume(guestId, muteState ? 0 : 1.0);
    }
    for (const item of this.guestAudioElements.values()) {
      if (item.participant?.identity !== guestId) continue;
      if (muteState) this.stopAudienceItem(item);
      else if (this.duetMonitorEnabled && this.audienceMonitorUnlocked) this.playAudienceItem(item);
    }
    this.sendData({ type: 'FORCE_MUTE', state: !!muteState }, {
      reliable: true,
      destinationIdentities: [guestId]
    });
  }

  cleanupGuest(id) {
    if (this.audioEngine?.removeGuestAudioTrack) {
      this.audioEngine.removeGuestAudioTrack(id);
    }
    for (const [key, item] of this.guestAudioElements) {
      if (item.participant?.identity !== id) continue;
      this.stopAudienceItem(item);
      try { item.track?.detach?.(item.audio); } catch (_) {}
      try { item.audio?.pause?.(); } catch (_) {}
      try { item.audio?.remove?.(); } catch (_) {}
      this.guestAudioElements.delete(key);
    }
    this.connections.delete(id);
    this.removeVideoCard(id);
    this.guestVideos.delete(id);
  }

  destroyAudienceMonitor() {
    if (this.audioEngine?._guestAudioNodes) {
      for (const id of Array.from(this.audioEngine._guestAudioNodes.keys())) {
        this.audioEngine.removeGuestAudioTrack(id);
      }
    }
    for (const item of this.guestAudioElements.values()) {
      this.stopAudienceItem(item);
      try { item.track?.detach?.(item.audio); } catch (_) {}
      try { item.audio?.pause?.(); } catch (_) {}
      try { item.audio?.remove?.(); } catch (_) {}
      item.audio = null;
    }
    this.duetMonitorEnabled = false;
    this.audienceMonitorUnlocked = false;
  }

  updateAudience() {
    const list = [...this.connections.entries()].map(([peerId, c]) => ({
      id: peerId,
      name: c.metadata?.name || 'Guest',
      role: c.metadata?.role || 'listen',
      isDuetActive: !!c.metadata?.isDuetActive,
      hasMic: (() => {
        const rp = this.room?.remoteParticipants?.get(peerId);
        return !!(c.metadata?.hasMic || [...(rp?.trackPublications?.values?.() || [])].some(p => p.kind === LK().Track.Kind.Audio && this.isAudienceMicPublication(p, undefined, rp)));
      })(),
      hasCamera: !!c.metadata?.hasCamera,
      isMuted: this.mutedGuests.has(peerId)
    }));
    this.onAudienceListUpdate?.(list);
    this.onAudienceCountUpdate?.(list.length);
  }

  async approveDuetRequest(guestId) {
    if (!guestId || !this.room?.localParticipant) return;
    console.info(`[Nirmal] Approving duet mic request for ${guestId}`);
    await this.sendData({
      type: 'APPROVE_MIC',
      targetIdentity: guestId
    }, { reliable: true });

    const c = this.connections.get(guestId);
    if (c) {
      c.metadata = { ...c.metadata, role: 'duet', isDuetActive: true };
      this.updateAudience();
    }
  }

  async rejectDuetRequest(guestId) {
    if (!guestId || !this.room?.localParticipant) return;
    console.info(`[Nirmal] Rejecting duet mic request for ${guestId}`);
    await this.sendData({
      type: 'REJECT_MIC',
      targetIdentity: guestId
    }, { reliable: true });
  }

  async inviteAudienceToDuet(guestId, guestName) {
    if (!guestId || !this.room?.localParticipant) return false;
    console.info(`[Nirmal] Host sending stage duet invitation to ${guestId} (${guestName || 'Guest'})`);
    await this.sendData({
      type: 'INVITE_DUET',
      targetIdentity: guestId,
      hostName: this.room.localParticipant.name || 'Host',
      roomId: this.roomId
    }, { reliable: true });
    return true;
  }

  async getLiveKitDiagnostics() {
    if (!this.room) {
      return { state: 'disconnected', roomId: null, identity: null };
    }
    const local = this.room.localParticipant;
    const pubTracks = [];
    if (local) {
      for (const pub of local.trackPublications.values()) {
        pubTracks.push({
          sid: pub.trackSid,
          kind: pub.kind,
          source: pub.source,
          muted: pub.isMuted,
          settings: pub.track?.mediaStreamTrack?.getSettings?.() || {}
        });
      }
    }

    const subTracks = [];
    if (this.room.remoteParticipants) {
      for (const p of this.room.remoteParticipants.values()) {
        for (const pub of p.trackPublications.values()) {
          if (pub.isSubscribed) {
            subTracks.push({
              participant: p.identity,
              name: p.name || p.identity,
              kind: pub.kind,
              source: pub.source,
              muted: pub.isMuted,
              sid: pub.trackSid
            });
          }
        }
      }
    }

    return {
      state: this.room.state,
      roomId: this.roomId,
      identity: local?.identity || null,
      remoteParticipantCount: this.room.remoteParticipants ? this.room.remoteParticipants.size : 0,
      publishedTracks: pubTracks,
      subscribedTracks: subTracks,
      duetMonitorEnabled: this.duetMonitorEnabled,
      activeGuestAudioCount: this.guestAudioElements ? this.guestAudioElements.size : 0
    };
  }
}
