import { AudioEngine } from './audio-engine.js?v=29';
import { LyricsManager } from './lyrics.js?v=29';
import { MusicSearchManager } from './music-search.js?v=29';
import { VisualizerRenderer } from './visualizer.js?v=29';
import { playSFX } from './sfx.js?v=29';
import { LiveStreamHost } from './live-stream.js?v=29';
import { AUTOTUNE_PRESETS, SCALE_MAP, NOTE_NAMES } from './config.js?v=29';
import { PresenceManager } from './presence-manager.js?v=29';
import { MultiStreamManager } from './multistream.js?v=29';
import { ArtistToolsManager } from './artist-tools.js?v=29';
import { acquireWakeLock, releaseWakeLock } from './wake-lock.js?v=29';
import { startBackgroundAudioKeepAlive, stopBackgroundAudioKeepAlive, updateMediaSession } from './media-session.js?v=29';

const audioEngine = new AudioEngine();
if (typeof window !== 'undefined') window.audioEngine = audioEngine;
const lyricsManager = new LyricsManager();
const searchManager = new MusicSearchManager(audioEngine, lyricsManager);
const visualizer = new VisualizerRenderer(audioEngine);
const liveHost = new LiveStreamHost(audioEngine);
const presence = new PresenceManager();
const multistream = new MultiStreamManager(liveHost, audioEngine, lyricsManager);
const artistTools = new ArtistToolsManager(audioEngine);

multistream.onStreamingStateChange = (isStreaming) => {
  if (isStreaming) {
    presence.updateLiveStatus({
      role: 'host',
      roomId: liveHost?.roomId || 'stage-broadcast',
      roomName: 'YouTube Live Stream',
      isLive: true
    });
  } else if (!liveHost?.isConnected?.()) {
    presence.updateLiveStatus({
      role: 'idle',
      roomId: null,
      roomName: null,
      isLive: false
    });
  }
  syncBackgroundKeepAlive();
};

export function shouldKeepAlive() {
  const isPlayerPlaying = filePlayerGlobal && !filePlayerGlobal.paused && !filePlayerGlobal.ended;
  const isMicActive = Boolean(audioEngine?.activeMicStream || audioEngine?.activeTabStream);
  const isLiveActive = liveHost?.room?.state === 'connected';
  const isMultiStreaming = Boolean(multistream?.isStreaming);
  return Boolean(isPlayerPlaying || isMicActive || isLiveActive || isMultiStreaming);
}

export function syncBackgroundKeepAlive() {
  if (shouldKeepAlive()) {
    acquireWakeLock().catch(() => {});
    startBackgroundAudioKeepAlive();
  } else {
    releaseWakeLock().catch(() => {});
    stopBackgroundAudioKeepAlive();
  }
}

let stopClockSync = () => {};
let pushPlaybackClock = () => {};

// Wire lyrics auto-sync with live WebRTC audience broadcast
lyricsManager.onLyricsUpdated = (parsed) => {
  liveHost.broadcastFullLyrics(parsed);
  pushPlaybackClock();
};

const filePlayerGlobal = document.getElementById('filePlayer');
filePlayerGlobal?.addEventListener('play', () => {
  if (audioEngine) {
    if (audioEngine.ctx && audioEngine.ctx.state === 'suspended') {
      audioEngine.ctx.resume().catch(() => {});
    }
    audioEngine.connectMediaElement(filePlayerGlobal);
  }
  if (liveHost?.room?.state === 'connected') {
    liveHost.ensureProgramAudioPublished?.().catch(() => {});
  }
  syncBackgroundKeepAlive();
  const title = document.getElementById('nowPlayingTitle')?.textContent || 'Karaoke Track';
  const artist = document.getElementById('nowPlayingArtist')?.textContent || 'Nirmal Karaoke';
  updateMediaSession({
    title,
    artist,
    album: 'Nirmal Karaoke Live Studio',
    onPlay: () => filePlayerGlobal?.play?.().catch(() => {}),
    onPause: () => filePlayerGlobal?.pause?.()
  });
});

filePlayerGlobal?.addEventListener('pause', () => {
  syncBackgroundKeepAlive();
});

filePlayerGlobal?.addEventListener('ended', () => {
  syncBackgroundKeepAlive();
});

async function scanHardware() {
  const speakerSelect = document.getElementById('speakerSelect');
  if (!navigator.mediaDevices?.enumerateDevices || !speakerSelect) return;
  const devices = await navigator.mediaDevices.enumerateDevices();
  speakerSelect.innerHTML = '<option value="">Default Audio Interface / Bluetooth</option>';
  devices.filter((d) => d.kind === 'audiooutput').forEach((device, i) => {
    const opt = document.createElement('option');
    opt.value = device.deviceId;
    opt.textContent = device.label || `Output Channel ${i + 1}`;
    speakerSelect.appendChild(opt);
  });
}

function killMedia() {
  stopClockSync();
  if (audioEngine.activeTabNode) {
    try { audioEngine.activeTabNode.disconnect(); } catch (e) {}
    audioEngine.activeTabNode = null;
  }
  if (audioEngine.activeTabStream) {
    audioEngine.activeTabStream.getTracks().forEach((t) => t.stop());
    audioEngine.activeTabStream = null;
  }
  const filePlayer = document.getElementById('filePlayer');
  if (filePlayer) {
    filePlayer.pause();
    filePlayer.removeAttribute('src');
    const playerWrapper = document.getElementById('playerWrapper');
    if (playerWrapper) playerWrapper.style.display = 'none';
  }

  if (searchManager) {
    searchManager.currentTrackIndex = -1;
    searchManager.renderPlaylist();
  }
  const npTitle = document.getElementById('nowPlayingTitle');
  const npArtist = document.getElementById('nowPlayingArtist');
  if (npTitle) npTitle.textContent = 'Choose a song to begin';
  if (npArtist) npArtist.textContent = 'Your personal karaoke studio';

  lyricsManager.reset();
  const musicSearchBox = document.getElementById('musicSearchBox');
  if (musicSearchBox) musicSearchBox.style.display = 'none';
  const mediaInput = document.getElementById('mediaInput');
  if (mediaInput) mediaInput.value = '';
  const lrcInput = document.getElementById('lrcInput');
  if (lrcInput) lrcInput.value = '';
  const btnStopMedia = document.getElementById('btnStopMedia');
  if (btnStopMedia) btnStopMedia.style.display = 'none';

  document.getElementById('btnTab')?.classList.remove('active-tab');
  document.getElementById('btnFile')?.classList.remove('active-file');
  document.getElementById('btnOpenMusicSearch')?.classList.remove('active-file');
  document.getElementById('led-in')?.classList.remove('active-blue');
  syncBackgroundKeepAlive();
}

function killMic() {
  if (audioEngine.activeMicNode) {
    try { audioEngine.activeMicNode.disconnect(); } catch (e) {}
    audioEngine.activeMicNode = null;
  }
  if (audioEngine.activeMicStream) {
    audioEngine.activeMicStream.getTracks().forEach((t) => t.stop());
    audioEngine.activeMicStream = null;
  }
  const btnStopMic = document.getElementById('btnStopMic');
  if (btnStopMic) btnStopMic.style.display = 'none';
  const btnMic = document.getElementById('btnMic');
  if (btnMic) {
    btnMic.classList.remove('active-mic');
    btnMic.innerHTML = '🎙 Start singing';
  }
  document.getElementById('led-mic')?.classList.remove('active-green');
  const hudNote = document.getElementById('hudNote');
  if (hudNote) hudNote.textContent = '🎤 PITCH: --';
  syncBackgroundKeepAlive();
}

function setupLiveShareUI() {
  const modal = document.getElementById('shareModal');
  const btnOpen = document.getElementById('btnOpenShareModal');
  const btnClose = document.getElementById('btnCloseShareModal');
  const qrContainer = document.getElementById('shareQrWrapper');
  const allowDuetToggle = document.getElementById('allowDuetToggle');
  const adminChatLog = document.getElementById('adminChatLog');
  const adminReplyInput = document.getElementById('adminReplyInput');
  const btnSendAdminReply = document.getElementById('btnSendAdminReply');
  const lblLiveCount = document.getElementById('lblLiveAudienceCount');
  const adminAudienceList = document.getElementById('adminAudienceList');
  // Handle active connected audience member UI list
  function handleAudienceListUpdate(guests) {
    if (!adminAudienceList) return;
    if (guests.length === 0) {
      adminAudienceList.innerHTML = '<div style="color:var(--text-dim); text-align:center; padding:6px 0;">No singers connected yet.</div>';
      return;
    }

    adminAudienceList.innerHTML = '';
    guests.forEach(g => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; justify-content:space-between; align-items:center; background:rgba(0,0,0,0.3); padding:4px 8px; border-radius:4px; margin-bottom:4px;';

      const micStatus = g.hasMic
        ? '<span style="color:var(--accent-green); font-size:0.65rem; font-weight:bold;">● MIC ON</span>'
        : '<span style="color:var(--text-dim); font-size:0.65rem;">MIC OFF</span>';
      const camStatus = g.hasCamera
        ? '<span style="color:var(--accent-blue); font-size:0.65rem; font-weight:bold;">● CAM ON</span>'
        : '<span style="color:var(--text-dim); font-size:0.65rem;">CAM OFF</span>';

      row.innerHTML = `
        <div style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:58%;">
          <strong>${g.name}</strong><br>${micStatus} &nbsp; ${camStatus}
        </div>
        <div style="display:flex;gap:4px;align-items:center;">
          ${g.hasMic ? `<button class="btn-listen-guest" data-id="${g.id}" style="background:var(--accent-blue); color:#fff; border:none; border-radius:3px; padding:3px 7px; font-size:0.65rem; cursor:pointer;">Listen</button>` : ''}
          ${g.hasMic ? `<button class="btn-mute-guest" data-id="${g.id}" style="background:var(--accent-red); color:#fff; border:none; border-radius:3px; padding:3px 8px; font-size:0.65rem; cursor:pointer;">Mute Mic</button>` : ''}
        </div>
      `;

      // Per-singer listen is a direct user gesture. It is useful on mobile/
      // browsers that require an explicit interaction even after global unlock.
      const btnListen = row.querySelector('.btn-listen-guest');
      if (btnListen) {
        btnListen.addEventListener('click', async () => {
          btnListen.disabled = true;
          try {
            const ok = await liveHost.playAudienceGuest?.(g.id);
            btnListen.textContent = ok ? 'Listening' : 'Retry';
          } catch (e) {
            btnListen.textContent = 'Retry';
            console.warn('[Nirmal] per-guest listen failed:', e);
          } finally {
            btnListen.disabled = false;
          }
        });
      }

      // Wire individual remote mute controls
      const btnMute = row.querySelector('.btn-mute-guest');
      if (btnMute) {
        let muted = !!g.isMuted;
        btnMute.textContent = muted ? 'Unmute' : 'Mute Mic';
        btnMute.style.background = muted ? 'var(--accent-green)' : 'var(--accent-red)';
        btnMute.addEventListener('click', (e) => {
          muted = !muted;
          liveHost.setGuestMute(g.id, muted);
          e.target.textContent = muted ? 'Unmute' : 'Mute Mic';
          e.target.style.background = muted ? 'var(--accent-green)' : 'var(--accent-red)';
        });
      }

      adminAudienceList.appendChild(row);
    });
  }

  const btnHearAudienceAudio = document.getElementById('btnHearAudienceAudio');
  const audienceMonitorState = document.getElementById('audienceMonitorState');

  let audienceMonitorEnabled = false;

  const updateAudienceMonitorButton = (enabled) => {
    audienceMonitorEnabled = !!enabled;
    if (btnHearAudienceAudio) {
      btnHearAudienceAudio.setAttribute('aria-pressed', audienceMonitorEnabled ? 'true' : 'false');
      btnHearAudienceAudio.classList.toggle('active-file', audienceMonitorEnabled);
      const label = btnHearAudienceAudio.querySelector('.monitor-label') || btnHearAudienceAudio.querySelector('span:first-child');
      if (label) label.textContent = audienceMonitorEnabled ? '🔊 Hearing audience audio on admin' : '🔇 Hear audience audio on admin';
    }
    if (audienceMonitorState) audienceMonitorState.textContent = audienceMonitorEnabled ? 'ON' : 'OFF';
  };

  updateAudienceMonitorButton(false);

  // LiveKit/browser audio playback must be unlocked by a trusted user gesture.
  // The click handler deliberately calls and awaits LiveKit startAudio() before
  // any subscription reconciliation, so the browser's transient user activation
  // is used at the correct point.
  btnHearAudienceAudio?.addEventListener('click', async (e) => {
    e.preventDefault();
    if (!liveHost.room?.localParticipant && !liveHost.impl?.room?.localParticipant) {
      const status = document.getElementById('liveTransportStatus');
      if (status) status.textContent = 'Start the live room first, then connect an audience microphone.';
      return;
    }

    const next = !audienceMonitorEnabled;
    btnHearAudienceAudio.disabled = true;
    try {
      // Call the dedicated gesture entry point immediately. It starts room audio
      // and already-attached audience playback before any subscription await.
      const monitorPromise = liveHost.setAudienceMonitorEnabledFromGesture?.(next);
      if (!monitorPromise) throw new Error('Audience monitor is unavailable in this build.');
      updateAudienceMonitorButton(next);
      const status = document.getElementById('liveTransportStatus');
      if (status) status.textContent = next
        ? 'LiveKit SFU • audience monitor ON • waiting for microphone audio…'
        : 'LiveKit SFU • audience monitor OFF';
      const ok = await monitorPromise;
      if (!ok) throw new Error('LiveKit room is not connected.');
      if (next) {
        if (status) status.textContent = 'LiveKit SFU • audience monitor ON • admin speakers only';
      }
    } catch (err) {
      updateAudienceMonitorButton(false);
      const status = document.getElementById('liveTransportStatus');
      if (status) status.textContent = `Audience monitor failed: ${err.message || err}`;
      console.error('[Nirmal] audience monitor toggle failed:', err);
    } finally {
      btnHearAudienceAudio.disabled = false;
    }
  });

  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // Handle incoming audience chat & song request
  function handleAudienceChatMessage(sender, text, isSpecial) {
    if (!adminChatLog) return;
    const safeSender = escapeHtml(sender);
    const safeText = escapeHtml(text);
    const msg = document.createElement('div');
    if (isSpecial) {
      msg.innerHTML = `
        <div style="background:rgba(168,85,247,0.15); border:1px solid var(--accent-purple); padding:4px 6px; border-radius:4px; margin-bottom:2px;">
          🎵 <strong>${safeSender}</strong> requested: <em>${safeText}</em>
          <button class="btn-accept-req" style="background:var(--accent-purple); color:#fff; border:none; border-radius:3px; padding:2px 6px; font-size:0.65rem; margin-left:6px; cursor:pointer;">Accept & Queue</button>
        </div>
      `;
      // When host accepts request, search and append it directly to the playlist
      msg.querySelector('.btn-accept-req')?.addEventListener('click', async (e) => {
        e.target.textContent = 'Queuing...';
        const data = await searchManager.fetchTracksFromQuery(text);
        const tracks = searchManager.extractTracks(data);
        if (tracks.length > 0) {
          const t = tracks[0];
          searchManager.addToUpcomingQueue({
            title: t.name || t.song || t.title,
            artist: t.primaryArtists || t.primary_artists || t.artist || 'Requested Artist',
            url: searchManager.cleanAudioUrl(t),
            duration: t.duration || 0
          });
          e.target.textContent = '✔️ In Queue';
        } else {
          e.target.textContent = 'Not Found';
        }
      });
    } else {
      msg.innerHTML = `<strong>${safeSender}</strong>: ${safeText}`;
    }
    adminChatLog.appendChild(msg);
    adminChatLog.scrollTop = adminChatLog.scrollHeight;
  }

  function resetLiveBroadcastUI(reason = '') {
    presence.updateLiveStatus({ role: 'idle', roomId: null, roomName: null, isLive: false });
    liveHost.roomId = null;
    liveHost.room = null;
    if (btnOpen) {
      btnOpen.textContent = '● Go live';
      btnOpen.style.borderColor = '';
      btnOpen.style.color = '';
      btnOpen.disabled = false;
    }
    if (lblLiveCount) lblLiveCount.textContent = '0 online';
    const btnStopLive = document.getElementById('btnStopLive');
    if (btnStopLive) btnStopLive.style.display = 'none';
    const hostCamBtn = document.getElementById('btnHostCamera');
    if (hostCamBtn) {
      hostCamBtn.textContent = '📹 Share admin camera';
      hostCamBtn.classList.remove('active-file');
    }
    const btnStageHostCam = document.getElementById('btnStageHostCamera');
    if (btnStageHostCam) {
      btnStageHostCam.textContent = '📹 Share camera';
      btnStageHostCam.classList.remove('active-file');
    }
    const btnAdminSwitchCam = document.getElementById('btnAdminSwitchCamera');
    if (btnAdminSwitchCam) btnAdminSwitchCam.style.display = 'none';
    const btnModalSwitchCam = document.getElementById('btnModalSwitchCamera');
    if (btnModalSwitchCam) btnModalSwitchCam.style.display = 'none';
    updateAudienceMonitorButton(false);
    const transport = document.getElementById('liveTransportStatus');
    if (transport) transport.textContent = reason || 'Broadcast ended. Ready to go live.';
    syncBackgroundKeepAlive();
  }

  liveHost.init(
    (roomId) => renderShareLinks(roomId),
    (count) => {
      if (lblLiveCount) lblLiveCount.textContent = `${count} Online`;
      if (btnOpen) {
        btnOpen.textContent = count > 0 ? `📡 Live (${count} online)` : `📡 Go Live & Share`;
        btnOpen.style.borderColor = count > 0 ? 'var(--accent-green)' : 'var(--accent-red)';
        btnOpen.style.color = count > 0 ? 'var(--accent-green)' : 'var(--accent-red)';
      }
    },
    handleAudienceChatMessage,
    handleAudienceListUpdate, // <-- Ensures Audience panel draws properly
    (reason) => resetLiveBroadcastUI(reason)
  );

  // Host sends chat reply back to audience
  function sendAdminReply() {
    const text = adminReplyInput.value.trim();
    if (!text) return;
    liveHost.broadcastChatMessage('Host (Admin)', text, false, true);
    const msg = document.createElement('div');
    msg.style.color = 'var(--accent-blue)';
    msg.innerHTML = `⭐ <strong>You</strong>: ${escapeHtml(text)}`;
    adminChatLog.appendChild(msg);
    adminChatLog.scrollTop = adminChatLog.scrollHeight;
    adminReplyInput.value = '';
  }

  btnSendAdminReply?.addEventListener('click', sendAdminReply);
  adminReplyInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendAdminReply(); });

  let liveStarting = false;
  btnOpen?.addEventListener('click', async () => {
    const isLive = liveHost.isConnected?.() || (liveHost.roomId && (liveHost.room || liveHost.impl?.room)?.state === 'connected');
    if (isLive) {
      if (modal) modal.style.display = 'flex';
      return;
    }
    if (liveHost.roomId && !isLive) {
      try { await liveHost.endRoom(); } catch (_) {}
    }
    if (liveStarting) return;
    liveStarting = true;
    btnOpen.disabled = true;
    const status = document.getElementById('liveTransportStatus');

    // Open modal immediately to show connection status
    if (modal) modal.style.display = 'flex';
    if (status) status.textContent = 'Connecting to LiveKit SFU…';
    renderShareLinks('connecting...');

    try {
      const audioBoot = audioEngine.boot().catch((e) => {
        console.warn('[Nirmal] early audio boot deferred:', e);
        return false;
      });

      const roomId = await liveHost.createRoom(allowDuetToggle?.checked ?? true);
      presence.updateLiveStatus({ role: 'host', roomId, roomName: 'My Live Stage', isLive: true });
      syncBackgroundKeepAlive();
      renderShareLinks(roomId);
      const btnStopLive = document.getElementById('btnStopLive');
      if (btnStopLive) btnStopLive.style.display = 'block';
      if (btnOpen) {
        btnOpen.textContent = '📡 LIVE (Manage)';
        btnOpen.style.borderColor = 'var(--accent-red)';
        btnOpen.style.color = 'var(--accent-red)';
      }

      try {
        if (status) status.textContent = 'LiveKit connected • preparing program audio…';
        await audioBoot;
        if (audioEngine.ctx?.state === 'suspended') await audioEngine.ctx.resume();
        await liveHost.ensureProgramAudioPublished?.();
        if (status) status.textContent = 'LIVE • program audio published • audience can connect now';

        // Immediately broadcast any already-loaded lyrics and playback clock to the live audience
        if (lyricsManager?.parsedLyrics && lyricsManager.parsedLyrics.length > 0) {
          liveHost.broadcastFullLyrics(lyricsManager.parsedLyrics);
        }
        pushPlaybackClock();
      } catch (audioError) {
        console.warn('[Nirmal] program audio setup deferred:', audioError);
        if (status) status.textContent = `LIVE • room active • program audio pending: ${audioError.message || audioError}`;
      }
    } catch (e) {
      const errMsg = e?.message || e || 'Could not connect to LiveKit SFU.';
      if (status) status.textContent = `Live setup failed: ${errMsg}`;
      console.error('[Nirmal] Go Live failed:', e);
    } finally {
      liveStarting = false;
      btnOpen.disabled = false;
    }
  });

  btnClose?.addEventListener('click', () => {
    if (modal) modal.style.display = 'none';
  });

  const btnHostCamera = document.getElementById('btnHostCamera');
  const btnStageHostCamera = document.getElementById('btnStageHostCamera');
  const btnAdminSwitchCamera = document.getElementById('btnAdminSwitchCamera');
  const btnModalSwitchCamera = document.getElementById('btnModalSwitchCamera');

  async function handleHostCameraToggle() {
    const room = liveHost.room || liveHost.impl?.room;
    if (!room?.localParticipant || room.state !== 'connected') {
      if (modal) modal.style.display = 'flex';
      alert('Please click "Go live" to start the broadcast first, then share camera.');
      return;
    }
    try {
      const active = await liveHost.toggleHostCamera();
      const label = active ? '⏹ Stop camera' : '📹 Share camera';
      const modalLabel = active ? '⏹ Stop admin camera' : '📹 Share admin camera';
      if (btnHostCamera) {
        btnHostCamera.textContent = modalLabel;
        btnHostCamera.classList.toggle('active-file', active);
      }
      if (btnStageHostCamera) {
        btnStageHostCamera.textContent = label;
        btnStageHostCamera.classList.toggle('active-file', active);
      }
      if (btnAdminSwitchCamera) {
        btnAdminSwitchCamera.style.display = active ? 'inline-block' : 'none';
      }
      if (btnModalSwitchCamera) {
        btnModalSwitchCamera.style.display = active ? 'inline-block' : 'none';
      }
    } catch (e) {
      alert(e.message || 'Camera permission was not granted.');
    }
  }

  async function handleHostSwitchCamera() {
    try {
      await liveHost.switchHostCamera();
    } catch (e) {
      alert('Could not switch camera: ' + (e.message || e));
    }
  }

  btnHostCamera?.addEventListener('click', handleHostCameraToggle);
  btnStageHostCamera?.addEventListener('click', handleHostCameraToggle);
  btnAdminSwitchCamera?.addEventListener('click', handleHostSwitchCamera);
  btnModalSwitchCamera?.addEventListener('click', handleHostSwitchCamera);

  const btnStopLive = document.getElementById('btnStopLive');
  btnStopLive?.addEventListener('click', async () => {
    btnStopLive.disabled = true;
    try {
      await liveHost.endRoom();
      presence.updateLiveStatus({ role: 'idle', roomId: null, roomName: null, isLive: false });
      if (btnOpen) {
        btnOpen.textContent = '📡 Go live';
        btnOpen.style.borderColor = '';
        btnOpen.style.color = '';
      }
      if (lblLiveCount) lblLiveCount.textContent = '0 online';
      if (btnStopLive) btnStopLive.style.display = 'none';
      const hostCamBtn = document.getElementById('btnHostCamera');
      if (hostCamBtn) {
        hostCamBtn.textContent = '📹 Share admin camera';
        hostCamBtn.classList.remove('active-file');
      }
      if (btnStageHostCamera) {
        btnStageHostCamera.textContent = '📹 Share camera';
        btnStageHostCamera.classList.remove('active-file');
      }
      if (btnAdminSwitchCamera) btnAdminSwitchCamera.style.display = 'none';
      if (btnModalSwitchCamera) btnModalSwitchCamera.style.display = 'none';
      updateAudienceMonitorButton(false);
      if (modal) modal.style.display = 'none';
      syncBackgroundKeepAlive();
    } catch (err) {
      console.warn('[Nirmal] end broadcast error:', err);
    } finally {
      btnStopLive.disabled = false;
    }
  });

  allowDuetToggle?.addEventListener('change', () => {
    if (liveHost.isConnected?.()) renderShareLinks(liveHost.roomId);
  });

  function renderShareLinks(roomId) {
    const origin = `${location.protocol}//${location.host}`;
    const listenUrl = `${origin}/audience.html?room=${roomId}&role=listen`;
    const duetUrl = `${origin}/audience.html?room=${roomId}&role=participate`;

    if (qrContainer && window.QRCode) {
      qrContainer.innerHTML = '';
      new QRCode(qrContainer, {
        text: allowDuetToggle?.checked ? duetUrl : listenUrl,
        width: 156,
        height: 156
      });
    }

    const shareInput = document.getElementById('shareLinkInput');
    const currentActiveUrl = allowDuetToggle?.checked ? duetUrl : listenUrl;
    if (shareInput) {
      shareInput.value = currentActiveUrl;
      shareInput.onclick = () => shareInput.select();
    }

    function copyShareUrl(text, successMessage) {
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text)
          .then(() => alert(successMessage))
          .catch(() => fallbackCopy(text, successMessage));
      } else {
        fallbackCopy(text, successMessage);
      }
    }

    function fallbackCopy(text, successMessage) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        alert(successMessage);
      } catch (err) {
        prompt('Copy this link:', text);
      } finally {
        document.body.removeChild(ta);
      }
    }

    const btnListen = document.getElementById('btnCopyListenLink');
    if (btnListen) {
      btnListen.onclick = () => copyShareUrl(listenUrl, 'Listener link copied!');
    }

    const btnDuet = document.getElementById('btnCopyDuetLink');
    if (btnDuet) {
      btnDuet.onclick = () => copyShareUrl(duetUrl, 'Duet participation link copied!');
    }
  }

  // ==========================================================================
  // REAL-TIME ACTIVE SINGERS & DUET LOBBY (DESKTOP & MODAL INTEGRATION)
  // ==========================================================================
  const usersModal = document.getElementById('usersModal');
  const btnOpenUsersLobby = document.getElementById('btnOpenUsersLobby');
  const btnCloseUsersModal = document.getElementById('btnCloseUsersModal');
  const topbarUsersBadge = document.getElementById('topbarUsersBadge');
  const lblModalOnlineCount = document.getElementById('lblModalOnlineCount');
  const desktopMyAvatar = document.getElementById('desktopMyAvatar');
  const desktopMyName = document.getElementById('desktopMyName');
  const btnDesktopEditName = document.getElementById('btnDesktopEditName');
  const desktopSearchUsersInput = document.getElementById('desktopSearchUsersInput');
  const desktopSingersList = document.getElementById('desktopSingersList');
  const btnQuickGoLiveFromLobby = document.getElementById('btnQuickGoLiveFromLobby');
  const navLinkUsers = document.getElementById('navLinkUsers');

  let desktopSearchQuery = '';
  const pendingInvitesSet = new Set();

  function updateDesktopMyProfileUI() {
    if (desktopMyAvatar) desktopMyAvatar.textContent = presence.user.avatar || '🎤';
    if (desktopMyName) desktopMyName.textContent = presence.user.name || 'Singer';
  }
  updateDesktopMyProfileUI();

  // Cycle avatar on click
  const avatarList = ['🎤', '🎧', '🎸', '🎹', '⚡', '👑', '🔥', '🌟', '🎶', '💎'];
  desktopMyAvatar?.addEventListener('click', () => {
    const curIdx = avatarList.indexOf(presence.user.avatar);
    const nextAvatar = avatarList[(curIdx + 1) % avatarList.length];
    presence.updateProfile(presence.user.name, nextAvatar);
    updateDesktopMyProfileUI();
  });

  btnDesktopEditName?.addEventListener('click', () => {
    const newName = prompt('Enter your singer name / nickname:', presence.user.name);
    if (newName && newName.trim()) {
      presence.updateProfile(newName.trim(), presence.user.avatar);
      updateDesktopMyProfileUI();
    }
  });

  function safeEscape(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function renderDesktopSingersList(users) {
    if (topbarUsersBadge) topbarUsersBadge.textContent = users.length;
    if (lblModalOnlineCount) lblModalOnlineCount.textContent = `${users.length} online`;
    if (!desktopSingersList) return;

    let list = users.filter(u => {
      if (u.id === presence.user.id) return false;
      if (presence.currentRoomId && (u.roomId === presence.currentRoomId || u.id === `host_${presence.currentRoomId}`)) return false;
      return true;
    });
    if (desktopSearchQuery) {
      const q = desktopSearchQuery.toLowerCase();
      list = list.filter(u => u.name.toLowerCase().includes(q));
    }

    if (list.length === 0) {
      desktopSingersList.innerHTML = `
        <div style="text-align:center; padding:24px 10px; color:var(--text-dim); font-size:0.8rem;">
          ${desktopSearchQuery ? 'No singers match your search.' : 'No other singers online right now.<br><span style="font-size:0.72rem; color:var(--accent-blue);">Tip: Open Nirmal in another window/tab to test live duet invitations!</span>'}
        </div>
      `;
      return;
    }

    desktopSingersList.innerHTML = '';
    list.forEach(u => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; justify-content:space-between; align-items:center; background:rgba(0,0,0,0.3); border:1px solid var(--border); padding:8px 12px; border-radius:8px;';

      const isLive = !!u.isLive || u.role === 'host';
      const inDuet = u.role === 'duet';
      const statusColor = isLive ? 'var(--accent-pink)' : (inDuet ? 'var(--accent-orange)' : 'var(--accent-green)');
      let statusText = '🟢 Available to Duet';
      if (isLive) statusText = `🔴 LIVE • ${u.roomName || 'Karaoke Stage'}`;
      else if (inDuet) statusText = `🎶 In Duet • ${u.roomName || 'Duet Stage'}`;

      const isInvited = pendingInvitesSet.has(u.id);

      row.innerHTML = `
        <div style="display:flex; align-items:center; gap:10px; min-width:0; flex:1;">
          <div style="font-size:1.5rem; flex-shrink:0;">${u.avatar || '🎤'}</div>
          <div style="min-width:0; flex:1;">
            <strong style="font-size:0.85rem; color:#fff; display:block; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
              ${safeEscape(u.name)} <span style="font-size:0.65rem; color:var(--text-dim);">${u.device === 'mobile' ? '📱' : '💻'}</span>
            </strong>
            <span style="font-size:0.7rem; color:${statusColor}; font-weight:600;">${statusText}</span>
          </div>
        </div>
        <div style="flex-shrink:0;">
          ${(() => {
            const isHostBroadcasting = (typeof liveHost !== 'undefined' && liveHost?.isConnected?.())
                                    || (typeof multistream !== 'undefined' && multistream?.isStreaming)
                                    || (typeof presence !== 'undefined' && presence?.isLive && presence?.currentRole === 'host');

            if (isLive && u.roomId) {
              if (isHostBroadcasting && u.roomId !== liveHost?.roomId) {
                return `
                  <div style="display:flex; align-items:center; gap:4px;">
                    <a href="./audience.html?room=${encodeURIComponent(u.roomId)}&role=audience" target="_blank" class="button button-quiet" style="padding:5px 8px; font-size:0.72rem; text-decoration:none;" title="Watch in new tab without disrupting broadcast">👁️ Watch</a>
                    <button class="button button-quiet" disabled style="padding:5px 8px; font-size:0.72rem; opacity:0.5; cursor:not-allowed;" title="You are live as Host! End broadcast before joining another stage.">🔒 Live Host</button>
                  </div>
                `;
              }
              return `
                <div style="display:flex; align-items:center; gap:4px;">
                  <a href="./audience.html?room=${encodeURIComponent(u.roomId)}&role=audience" target="_blank" class="button button-quiet" style="padding:5px 8px; font-size:0.72rem; text-decoration:none;">👁️ Watch</a>
                  <a href="./audience.html?room=${encodeURIComponent(u.roomId)}&role=duet&autoJoin=1" class="button button-primary" style="padding:5px 8px; font-size:0.72rem; text-decoration:none;">🎤 Duet</a>
                </div>
              `;
            }
            if (isInvited) {
              return `<span style="color:var(--accent-orange); font-size:0.72rem; font-weight:700;">⏳ Invited...</span>`;
            }
            return `<button class="button button-quiet btn-invite-singer" data-user-id="${u.id}" style="padding:5px 10px; font-size:0.72rem; border-color:var(--accent-green); color:var(--accent-green);">📩 Invite Duet</button>`;
          })()}
        </div>
      `;

      const btnInv = row.querySelector('.btn-invite-singer');
      if (btnInv) {
        btnInv.addEventListener('click', async () => {
          btnInv.disabled = true;
          btnInv.textContent = 'Inviting...';

          try {
            // If host has not started a room yet, automatically create one so we can invite them directly to it!
            if (!liveHost.isConnected?.()) {
              const rId = await liveHost.createRoom(true);
              await liveHost.ensureProgramAudioPublished?.().catch(() => {});
              presence.updateLiveStatus({ role: 'host', roomId: rId, roomName: 'My Live Stage', isLive: true });
              renderShareLinks(rId);
            }

            await presence.sendInvite(u.id, 'duet');
            pendingInvitesSet.add(u.id);
            renderDesktopSingersList(presence.onlineUsers);
          } catch (err) {
            alert('Failed to send invite: ' + (err.message || err));
            btnInv.disabled = false;
            btnInv.textContent = '📩 Invite Duet';
          }
        });
      }

      desktopSingersList.appendChild(row);
    });
  }

  // Multi-Audience Batch Invitations: Invite all online singers simultaneously
  const btnInviteAllSingers = document.getElementById('btnInviteAllSingers');
  const lblLobbyBatchStatus = document.getElementById('lblLobbyBatchStatus');

  btnInviteAllSingers?.addEventListener('click', async () => {
    const list = presence.onlineUsers || [];
    const available = list.filter(u => u.id !== presence.user.id && !pendingInvitesSet.has(u.id));
    if (!available.length) {
      if (lblLobbyBatchStatus) lblLobbyBatchStatus.textContent = 'No new online singers to invite.';
      setTimeout(() => { if (lblLobbyBatchStatus) lblLobbyBatchStatus.textContent = ''; }, 3000);
      return;
    }

    btnInviteAllSingers.disabled = true;
    btnInviteAllSingers.textContent = `⏳ Inviting (${available.length})...`;
    if (lblLobbyBatchStatus) lblLobbyBatchStatus.textContent = `Inviting ${available.length} singers to your stage...`;

    try {
      if (!liveHost.isConnected?.()) {
        const rId = await liveHost.createRoom(true);
        await liveHost.ensureProgramAudioPublished?.().catch(() => {});
        presence.updateLiveStatus({ role: 'host', roomId: rId, roomName: 'My Live Stage', isLive: true });
        renderShareLinks(rId);
      }

      const promises = available.map(u => {
        pendingInvitesSet.add(u.id);
        return presence.sendInvite(u.id, 'duet').catch(err => {
          console.warn(`[Presence] batch invite error for ${u.id}:`, err);
        });
      });

      await Promise.allSettled(promises);
      renderDesktopSingersList(presence.onlineUsers);
      btnInviteAllSingers.textContent = '✅ Invited All!';
      if (lblLobbyBatchStatus) lblLobbyBatchStatus.textContent = `⚡ Sent ${available.length} invitations!`;
      setTimeout(() => {
        btnInviteAllSingers.disabled = false;
        btnInviteAllSingers.textContent = '⚡ Invite All Online';
      }, 4000);
    } catch (err) {
      alert('Batch invite error: ' + (err.message || err));
      btnInviteAllSingers.disabled = false;
      btnInviteAllSingers.textContent = '⚡ Invite All Online';
    }
  });

  // Update presence list on SSE event
  presence.onUserListUpdated = (users) => {
    renderDesktopSingersList(users);
  };

  // When an invited singer accepts:
  presence.onInviteResponse = (res) => {
    if (res.accepted) {
      alert(`🎉 ${res.responder?.name || 'Singer'} accepted your Duet invitation! They are joining your LiveKit stage now.`);
      // Auto-enable audience monitor so host and guest can immediately hear each other
      if (!audienceMonitorEnabled) {
        updateAudienceMonitorButton(true);
        liveHost.setAudienceMonitorEnabledFromGesture?.(true).catch(() => {});
      }
    } else {
      pendingInvitesSet.delete(res.responder?.id);
      renderDesktopSingersList(presence.onlineUsers);
    }
  };

  desktopSearchUsersInput?.addEventListener('input', (e) => {
    desktopSearchQuery = e.target.value.trim();
    renderDesktopSingersList(presence.onlineUsers);
  });

  // In-page Lobby Modal for both Desktop and Mobile (Never navigates away)
  const openLobbyModal = (e) => {
    if (e) e.preventDefault();
    if (usersModal) usersModal.style.display = 'flex';
    renderDesktopSingersList(presence.onlineUsers);
  };

  btnOpenUsersLobby?.addEventListener('click', openLobbyModal);
  navLinkUsers?.addEventListener('click', openLobbyModal);
  const mobileNavLobbyBtn = document.getElementById('mobileNavLobbyBtn');
  mobileNavLobbyBtn?.addEventListener('click', openLobbyModal);

  const btnRefreshLobbySingers = document.getElementById('btnRefreshLobbySingers');
  btnRefreshLobbySingers?.addEventListener('click', () => {
    presence.pushHeartbeat?.().catch(() => {});
    renderDesktopSingersList(presence.onlineUsers);
  });

  btnCloseUsersModal?.addEventListener('click', () => {
    if (usersModal) usersModal.style.display = 'none';
  });

  btnQuickGoLiveFromLobby?.addEventListener('click', () => {
    if (usersModal) usersModal.style.display = 'none';
    btnOpen?.click();
  });

  // Admin Broadcast Lock: Prevent accidental browser navigation or tab closure while broadcasting
  window.addEventListener('beforeunload', (e) => {
    const isHostBroadcasting = (typeof liveHost !== 'undefined' && liveHost?.isConnected?.())
                            || (typeof multistream !== 'undefined' && multistream?.isStreaming)
                            || (typeof presence !== 'undefined' && presence?.isLive && presence?.currentRole === 'host');
    if (isHostBroadcasting) {
      e.preventDefault();
      e.returnValue = 'Live broadcast in progress! Leaving will disconnect all audience members and stop the live stream.';
      return e.returnValue;
    }
  });

  // High-rate playback clock sync. Lyrics use interpolation on the audience
  // side, so we only need small, regular clock corrections rather than trying
  // to seek the remote audio. This is deliberately independent of audio RTP.
  const filePlayer = document.getElementById('filePlayer');
  let syncTimer = null;

  pushPlaybackClock = () => {
    if (!filePlayer || !liveHost.isConnected?.()) return;
    const currentOffset = lyricsManager ? (lyricsManager.lyricSyncOffset || 0) : 0;
    const syncedTime = Math.max(0, Number(filePlayer.currentTime || 0) - currentOffset);
    liveHost.broadcastTime({
      currentTime: syncedTime,
      playing: !filePlayer.paused && !filePlayer.ended,
      syncOffset: currentOffset,
      sentAtMs: Date.now()
    });
  };

  const startClockSync = () => {
    pushPlaybackClock();
    if (!syncTimer) {
      syncTimer = setInterval(pushPlaybackClock, 250);
    }
  };

  stopClockSync = () => {
    if (syncTimer) {
      clearInterval(syncTimer);
      syncTimer = null;
    }
    pushPlaybackClock();
  };

  filePlayer?.addEventListener('play', startClockSync);
  filePlayer?.addEventListener('pause', stopClockSync);
  filePlayer?.addEventListener('ended', stopClockSync);
  filePlayer?.addEventListener('seeked', pushPlaybackClock);
  filePlayer?.addEventListener('loadedmetadata', pushPlaybackClock);
}

function setupEventListeners() {
  // Mobile Screen / Tab navigation
  function setActiveMobileScreen(screenId) {
    if (!screenId) screenId = 'stage';
    screenId = screenId.replace(/^#/, '');
    if (screenId === 'lyrics') screenId = 'stage';
    if (screenId === 'recording') screenId = 'audience';

    document.body.dataset.mobileScreen = screenId;

    // Update active state on mobile nav
    document.querySelectorAll('.mobile-nav a').forEach((link) => {
      const target = link.dataset.screen || link.getAttribute('href')?.replace(/^#/, '');
      link.classList.toggle('active', target === screenId);
    });

    // Update active state on desktop sidebar
    document.querySelectorAll('.sidebar .nav-link').forEach((link) => {
      const target = link.dataset.screen || link.getAttribute('href')?.replace(/^#/, '');
      link.classList.toggle('active', target === screenId || (screenId === 'stage' && target === 'lyrics') || (screenId === 'audience' && target === 'recording'));
    });
  }
  window.setActiveMobileScreen = setActiveMobileScreen;

  // Handle mobile nav clicks
  document.querySelectorAll('.mobile-nav a').forEach((link) => {
    link.addEventListener('click', () => {
      const screenId = link.dataset.screen || link.getAttribute('href')?.replace(/^#/, '');
      setActiveMobileScreen(screenId);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });

  // Handle desktop sidebar clicks
  document.querySelectorAll('.sidebar .nav-link').forEach((link) => {
    link.addEventListener('click', () => {
      const screenId = link.dataset.screen || link.getAttribute('href')?.replace(/^#/, '');
      setActiveMobileScreen(screenId);
    });
  });

  window.addEventListener('hashchange', () => {
    const hash = window.location.hash?.replace(/^#/, '');
    if (hash) setActiveMobileScreen(hash);
  });

  const initialHash = window.location.hash?.replace(/^#/, '');
  setActiveMobileScreen(initialHash || 'stage');

  // Mobile Web Audio unlock for iOS Safari and mobile simulators.
  // Standard click events often fail to unlock AudioContext on iOS without touchstart/touchend.
  const mobileUnlockEvents = ['touchstart', 'touchend', 'click', 'pointerdown'];
  let audioHardwareUnlocked = false;

  const performAudioUnlock = async () => {
    try {
      await audioEngine.boot();
      const ctx = audioEngine.ctx;
      if (ctx) {
        if (ctx.state === 'suspended') {
          await ctx.resume();
        }
        // Forcefully wake up iOS WebKit audio hardware with a 1-sample silent buffer
        if (!audioHardwareUnlocked) {
          try {
            const silentBuf = ctx.createBuffer(1, 1, 22050);
            const src = ctx.createBufferSource();
            src.buffer = silentBuf;
            src.connect(ctx.destination);
            src.start(0);
            audioHardwareUnlocked = true;
          } catch (_) {}
        }
      }
    } catch (err) {
      console.warn('[Nirmal] early AudioContext unlock deferred:', err);
    }
  };

  mobileUnlockEvents.forEach(ev => {
    window.addEventListener(ev, performAudioUnlock, { passive: true });
    document.addEventListener(ev, performAudioUnlock, { passive: true });
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && audioEngine.ctx && audioEngine.ctx.state === 'suspended') {
      audioEngine.ctx.resume().catch(() => {});
    }
  });

  // Mobile network drop listener: Forcefully resets UI state so user is never stuck in broken "Live" state
  window.addEventListener('offline', () => {
    console.warn('[Nirmal] Device network disconnected (offline)');
    if (liveHost.isConnected?.() || liveHost.roomId) {
      liveHost.teardownRoomOnDisconnect?.('Network connection dropped (offline). Tap "Go live" to restart.');
    }
  });

  window.addEventListener('online', () => {
    console.info('[Nirmal] Device back online');
    const transport = document.getElementById('liveTransportStatus');
    if (transport && (!liveHost.isConnected || !liveHost.isConnected())) {
      transport.textContent = 'Network connection restored. Ready to go live.';
    }
  });

  document.getElementById('speakerSelect')?.addEventListener('change', () => {
    audioEngine.applyOutputRouting();
    liveHost.refreshAudienceMonitorOutputDevice?.();
  });

  // System-wide audio sharing. The browser's native display picker controls which output/source is shared.
  document.getElementById('btnSystemAudio')?.addEventListener('click', async () => {
    const btn = document.getElementById('btnSystemAudio');
    const stop = document.getElementById('btnStopSystemAudio');
    const status = document.getElementById('systemAudioStatus');
    try {
      if (btn) btn.disabled = true;
      await audioEngine.startSystemAudioShare();
      // A full-monitor system-audio capture contains the computer's final
      // speaker mix. Never monitor remote audience microphones through the
      // speakers while that capture is active, otherwise guest audio can be
      // picked up again and leak into the host program.
      if (audioEngine.systemAudioCapturesSpeakerMix && liveHost?.isAudienceMonitorEnabled?.()) {
        liveHost.setAudienceMonitorEnabled(false);
        audienceMonitorEnabled = false;
        updateAudienceMonitorButton(false);
      }
      if (btn) { btn.disabled = false; btn.classList.add('active-file'); btn.textContent = '🔊 System sound shared'; }
      if (stop) stop.style.display = 'flex';
      if (status) { status.textContent = 'STEREO • 2CH'; status.classList.add('is-live'); }
      const transport = document.getElementById('liveTransportStatus');
      if (transport) transport.textContent = `Web-only capture active • ${audioEngine.ctx?.sampleRate || 48000} Hz • Stereo 2ch • audio is mixed before WebRTC`;
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = '🔊 Share system sound'; }
      alert(e.message || 'Could not share system audio. In Chrome/Edge, choose a screen/window and enable Share audio.');
    }
  });

  document.getElementById('btnStopSystemAudio')?.addEventListener('click', () => {
    audioEngine.stopSystemAudioShare();
    const btn = document.getElementById('btnSystemAudio');
    const stop = document.getElementById('btnStopSystemAudio');
    const status = document.getElementById('systemAudioStatus');
    if (btn) { btn.disabled = false; btn.classList.remove('active-file'); btn.textContent = '🔊 Share system sound'; }
    if (stop) stop.style.display = 'none';
    if (status) { status.textContent = 'OFF'; status.classList.remove('is-live'); }
  });

  // Pro vocal rack controls.
  const proInputs = ['sliderVocalComp', 'sliderDeEsser', 'sliderVocalSat', 'sliderVocalPresence'];
  proInputs.forEach((id) => {
    document.getElementById(id)?.addEventListener('input', async (e) => {
      const map = { sliderVocalComp: ['valVocalComp', v => `${Math.round(v * 100)}%`], sliderDeEsser: [null, v => `${Math.round(v * 100)}%`], sliderVocalSat: ['valVocalSat', v => `${Math.round(v * 100)}%`], sliderVocalPresence: ['valVocalPresence', v => `${v > 0 ? '+' : ''}${v} dB`] };
      const [labelId, formatter] = map[id] || [];
      const lbl = labelId ? document.getElementById(labelId) : null;
      if (lbl && formatter) lbl.textContent = formatter(parseFloat(e.target.value) || 0);
      await audioEngine.boot();
      audioEngine.updateProVocalSettings();
    });
  });
  document.getElementById('proChainToggle')?.addEventListener('change', async () => { await audioEngine.boot(); audioEngine.updateProVocalSettings(); });
  document.getElementById('proVocalPreset')?.addEventListener('change', async (e) => {
    await audioEngine.boot();
    const presets = {
      clean: [-0.18, 0.25, 0.04, 2], warm: [-0.35, 0.4, 0.08, 1], bright: [-0.25, 0.55, 0.06, 4], radio: [-0.5, 0.7, 0.12, 3], live: [-0.4, 0.5, 0.05, 2.5]
    };
    const values = presets[e.target?.value] || presets.clean;
    const comp = document.getElementById('sliderVocalComp');
    const de = document.getElementById('sliderDeEsser');
    const sat = document.getElementById('sliderVocalSat');
    const pres = document.getElementById('sliderVocalPresence');
    if (comp) comp.value = Math.min(1, Math.max(0, Math.abs(values[0] ?? 0.18)));
    if (de) de.value = values[1] ?? 0.25;
    if (sat) sat.value = values[2] ?? 0.04;
    if (pres) pres.value = values[3] ?? 2;

    const lblComp = document.getElementById('valVocalComp');
    const lblSat = document.getElementById('valVocalSat');
    const lblPres = document.getElementById('valVocalPresence');
    if (lblComp && comp) lblComp.textContent = `${Math.round((parseFloat(comp.value) || 0) * 100)}%`;
    if (lblSat && sat) lblSat.textContent = `${Math.round((parseFloat(sat.value) || 0) * 100)}%`;
    if (lblPres && pres) {
      const pVal = parseFloat(pres.value) || 0;
      lblPres.textContent = `${pVal > 0 ? '+' : ''}${pVal} dB`;
    }

    audioEngine.updateProVocalSettings();
  });

  document.getElementById('monitorToggle')?.addEventListener('change', (e) => {
    if (audioEngine.engine.monitorGain && audioEngine.ctx) {
      audioEngine.engine.monitorGain.gain.setTargetAtTime(e.target.checked ? 1.0 : 0.0, audioEngine.ctx.currentTime, 0.02);
    }
  });

  // ─── Live Stage Performance 8-Pad Soundboard ─────────────────────────────
  document.getElementById('sfxCheer')?.addEventListener('click', () => playSFX('cheer', audioEngine));
  document.getElementById('sfxAirhorn')?.addEventListener('click', () => playSFX('airhorn', audioEngine));
  document.getElementById('sfxDrumroll')?.addEventListener('click', () => playSFX('drumroll', audioEngine));
  document.getElementById('sfxBeatdrop')?.addEventListener('click', () => playSFX('beatdrop', audioEngine));
  document.getElementById('sfxGuitar')?.addEventListener('click', () => playSFX('guitar', audioEngine));
  document.getElementById('sfxSparkle')?.addEventListener('click', () => playSFX('sparkle', audioEngine));
  document.getElementById('sfxScratch')?.addEventListener('click', () => playSFX('scratch', audioEngine));
  document.getElementById('sfxBleep')?.addEventListener('click', () => playSFX('bleep', audioEngine));

  // ─── Pro Artist Live Suite: Metronome ────────────────────────────────────
  const sliderMetro = document.getElementById('sliderMetronomeBpm');
  const lblMetroBpm = document.getElementById('lblMetronomeBpm');
  const btnToggleMetro = document.getElementById('btnToggleMetronome');
  const chkMetroBrd = document.getElementById('chkMetroBroadcast');
  const lblMetroRoute = document.getElementById('lblMetroRouteDesc');
  const metroDots = document.querySelectorAll('#metronomeBeatBar .beat-dot');

  const updateMetroBpmUi = (bpm) => {
    if (lblMetroBpm) lblMetroBpm.textContent = `${bpm} BPM`;
    if (sliderMetro) sliderMetro.value = bpm;
  };

  sliderMetro?.addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    artistTools.setBpm(val);
    updateMetroBpmUi(val);
  });

  document.getElementById('btnMetroMinus')?.addEventListener('click', () => {
    const nextBpm = Math.max(40, artistTools.bpm - 1);
    artistTools.setBpm(nextBpm);
    updateMetroBpmUi(nextBpm);
  });

  document.getElementById('btnMetroPlus')?.addEventListener('click', () => {
    const nextBpm = Math.min(240, artistTools.bpm + 1);
    artistTools.setBpm(nextBpm);
    updateMetroBpmUi(nextBpm);
  });

  document.getElementById('btnMetroTap')?.addEventListener('click', () => {
    const tappedBpm = artistTools.tapTempo();
    updateMetroBpmUi(tappedBpm);
  });

  chkMetroBrd?.addEventListener('change', (e) => {
    artistTools.setMetronomeBroadcast(e.target.checked);
    if (lblMetroRoute) {
      lblMetroRoute.textContent = e.target.checked ? '(On = Live on Stream)' : '(Off = In-Ear Only)';
    }
  });

  btnToggleMetro?.addEventListener('click', () => {
    if (artistTools.isMetronomeRunning) {
      artistTools.stopMetronome();
      btnToggleMetro.textContent = '▶ Start Metronome';
      btnToggleMetro.style.background = '';
    } else {
      artistTools.startMetronome();
      btnToggleMetro.textContent = '⏹ Stop Metronome';
      btnToggleMetro.style.background = 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)';
    }
  });

  // Visual beat LED flasher
  artistTools.onMetronomeTick = (beatNumber, isAccent) => {
    metroDots.forEach((dot, idx) => {
      if (idx === beatNumber) {
        dot.classList.add('flash');
        setTimeout(() => dot.classList.remove('flash'), 110);
      } else {
        dot.classList.remove('flash');
      }
    });
  };

  // ─── Pro Artist Live Suite: Chromatic Vocal Pitch Pipe ────────────────────
  const btnRef440 = document.getElementById('btnRef440');
  const btnRef432 = document.getElementById('btnRef432');
  btnRef440?.addEventListener('click', () => {
    artistTools.setConcertReference(440);
    btnRef440.classList.add('active');
    btnRef432?.classList.remove('active');
  });
  btnRef432?.addEventListener('click', () => {
    artistTools.setConcertReference(432);
    btnRef432.classList.add('active');
    btnRef440?.classList.remove('active');
  });

  const pitchButtons = document.querySelectorAll('.pitch-key-btn[data-note]');
  pitchButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const note = btn.getAttribute('data-note');
      pitchButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      artistTools.playPitchTone(note);
    });
  });

  document.getElementById('btnStopPitchPipe')?.addEventListener('click', () => {
    artistTools.stopPitchTone();
    pitchButtons.forEach(b => b.classList.remove('active'));
  });

  // ─── Pro Artist Live Suite: 1-Tap Quick Transpose Key Bar ────────────────
  const transposePills = document.querySelectorAll('.transpose-pill');
  transposePills.forEach(pill => {
    pill.addEventListener('click', () => {
      const st = parseInt(pill.getAttribute('data-semitone'), 10);
      transposePills.forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      audioEngine.updateKey(st);
      artistTools.setQuickKeyShift(st);
      const lbl = document.getElementById('lblQuickKeyShift');
      if (lbl) {
        lbl.textContent = st === 0 ? 'Original (0)' : (st > 0 ? `+${st} Semitones` : `${st} Semitones`);
      }
      const keyLbl = document.getElementById('lblKey');
      if (keyLbl) keyLbl.textContent = st > 0 ? `+${st}` : `${st}`;
    });
  });

  // ─── Pro Artist Live Suite: Auto-Ducking / DJ Talkover ────────────────────
  document.getElementById('chkAutoDucking')?.addEventListener('change', (e) => {
    artistTools.enableAutoDucking(e.target.checked);
    const statusEl = document.getElementById('lblDuckingStatus');
    if (statusEl) statusEl.style.display = e.target.checked ? 'block' : 'none';
  });

  // ─── Pro Artist Live Suite: Broadcast Safety Peak VU Meter ────────────────
  const vuBar = document.getElementById('vuMeterBar');
  const lblPeak = document.getElementById('lblVuPeakDb');
  const lblClip = document.getElementById('lblVuClipWarning');

  artistTools.onPeakUpdate = ({ peak, peakDb, isClipping }) => {
    if (vuBar) {
      const pct = Math.min(100, Math.max(0, ((peakDb + 60) / 60) * 100));
      vuBar.style.width = `${pct.toFixed(1)}%`;
    }
    if (lblPeak) {
      lblPeak.textContent = `${peakDb.toFixed(1)} dB`;
      lblPeak.style.color = isClipping ? '#ef4444' : (peakDb > -6 ? '#eab308' : '#00e5ff');
    }
    if (lblClip) {
      lblClip.style.opacity = isClipping ? '1' : '0';
    }
  };

  // Audio Sliders
  // Backing track slider
  document.getElementById('sliderMediaVol')?.addEventListener('input', async (e) => {
    const v = parseFloat(e.target.value);
    const lbl = document.getElementById('lblMediaVol');
    if (lbl) lbl.textContent = `${Math.round(v * 100)}%`;
    await audioEngine.boot();
    if (audioEngine.engine.mediaGain && audioEngine.ctx) {
      audioEngine.engine.mediaGain.gain.setTargetAtTime(v, audioEngine.ctx.currentTime, 0.02);
    }
  });

  // Guide vocal slider
  document.getElementById('sliderGuideVol')?.addEventListener('input', async (e) => {
    const v = parseFloat(e.target.value);
    const lbl = document.getElementById('valGuideVol');
    if (lbl) lbl.textContent = `${Math.round(v * 100)}%`;
    await audioEngine.boot();
    if (audioEngine.engine.guideVocalGain && audioEngine.ctx) {
      audioEngine.engine.guideVocalGain.gain.setTargetAtTime(v, audioEngine.ctx.currentTime, 0.02);
    }
  });

  // Microphone slider
  document.getElementById('sliderMicVol')?.addEventListener('input', async (e) => {
    const v = parseFloat(e.target.value);
    const lbl = document.getElementById('lblMicVol');
    if (lbl) lbl.textContent = `${Math.round(v * 100)}%`;
    await audioEngine.boot();
    if (audioEngine.engine.micGain && audioEngine.ctx) {
      audioEngine.engine.micGain.gain.setTargetAtTime(v, audioEngine.ctx.currentTime, 0.02);
    }
  });

  // Master volume slider
  document.getElementById('sliderVol')?.addEventListener('input', async (e) => {
    const v = parseFloat(e.target.value);
    const lbl = document.getElementById('valVol');
    if (lbl) lbl.textContent = `${Math.round(v * 100)}%`;
    await audioEngine.boot();
    if (audioEngine.engine.masterGain && audioEngine.ctx) {
      audioEngine.engine.masterGain.gain.setTargetAtTime(v, audioEngine.ctx.currentTime, 0.02);
    }
  });

  // Vocal air EQ slider
  document.getElementById('sliderAir')?.addEventListener('input', async (e) => {
    const v = parseFloat(e.target.value);
    const lbl = document.getElementById('valAir');
    if (lbl) lbl.textContent = `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`;
    await audioEngine.boot();
    if (audioEngine.engine.airEq && audioEngine.ctx) {
      audioEngine.engine.airEq.gain.setTargetAtTime(v, audioEngine.ctx.currentTime, 0.02);
    }
  });

  document.getElementById('gateToggle')?.addEventListener('change', () => {
    const isChecked = document.getElementById('gateToggle').checked;
    if (!isChecked && audioEngine.engine.gateGain && audioEngine.ctx) {
      audioEngine.engine.gateGain.gain.setTargetAtTime(1.0, audioEngine.ctx.currentTime, 0.02);
    }
  });

  document.getElementById('sliderGate')?.addEventListener('input', (e) => {
    const lbl = document.getElementById('valGate');
    if (lbl) lbl.textContent = `${e.target.value} dB`;
  });

  document.getElementById('echoToggle')?.addEventListener('change', async (e) => {
    await audioEngine.boot();
    if (audioEngine.engine.echoTap && audioEngine.ctx) {
      audioEngine.engine.echoTap.gain.setTargetAtTime(e.target.checked ? 1.0 : 0.0, audioEngine.ctx.currentTime, 0.02);
    }
  });

  document.getElementById('sliderEcho')?.addEventListener('input', async (e) => {
    const v = parseFloat(e.target.value);
    const lbl = document.getElementById('valEcho');
    if (lbl) lbl.textContent = `${Math.round(v * 1000)} ms`;
    await audioEngine.boot();
    if (audioEngine.engine.echoDelay && audioEngine.ctx) {
      audioEngine.engine.echoDelay.delayTime.setTargetAtTime(v, audioEngine.ctx.currentTime, 0.02);
    }
  });

  document.getElementById('reverbToggle')?.addEventListener('change', async (e) => {
    await audioEngine.boot();
    if (audioEngine.engine.reverbGain && audioEngine.ctx) {
      const revVal = parseFloat(document.getElementById('sliderReverb')?.value || 0.35);
      audioEngine.engine.reverbGain.gain.setTargetAtTime(e.target.checked ? revVal : 0.0, audioEngine.ctx.currentTime, 0.02);
    }
  });

  document.getElementById('sliderReverb')?.addEventListener('input', async (e) => {
    const v = parseFloat(e.target.value);
    const lbl = document.getElementById('valReverb');
    if (lbl) lbl.textContent = `${Math.round(v * 100)}%`;
    await audioEngine.boot();
    const isChecked = document.getElementById('reverbToggle')?.checked;
    if (audioEngine.engine.reverbGain && isChecked && audioEngine.ctx) {
      audioEngine.engine.reverbGain.gain.setTargetAtTime(v, audioEngine.ctx.currentTime, 0.02);
    }
  });

  document.querySelectorAll('.preset-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.preset-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      await audioEngine.boot();
      audioEngine.applyPreset(btn.getAttribute('data-preset'));
    });
  });

  // ==========================================================================
  // ANTARES AUTO-TUNE PRO X WORKSTATION CONTROLLER
  // ==========================================================================
  function setupAutoTuneProX() {
    const atToggle = document.getElementById('autoTuneToggle');
    const atStatusDot = document.getElementById('atStatusDot');
    const atPresetSelect = document.getElementById('atPresetSelect');
    const btnSavePreset = document.getElementById('btnSavePreset');
    const btnToggleGraph = document.getElementById('btnToggleGraph');
    const atGraphWrapper = document.getElementById('atGraphWrapper');
    const canvas = document.getElementById('atPitchGraphCanvas');
    const ctx2d = canvas?.getContext('2d');

    const atPitchNeedle = document.getElementById('atPitchNeedle');
    const atInputReadout = document.getElementById('atInputReadout');
    const atTargetReadout = document.getElementById('atTargetReadout');
    const atStatusBadge = document.getElementById('atStatusBadge');

    const atSpeed = document.getElementById('atSpeed');
    const valAtSpeed = document.getElementById('valAtSpeed');
    const atFlex = document.getElementById('atFlex');
    const valAtFlex = document.getElementById('valAtFlex');
    const atHumanize = document.getElementById('atHumanize');
    const valAtHumanize = document.getElementById('valAtHumanize');
    const atMix = document.getElementById('atMix');
    const valAtMix = document.getElementById('valAtMix');

    const atKey = document.getElementById('atKey');
    const atScale = document.getElementById('atScale');
    const atPianoStrip = document.getElementById('atPianoStrip');

    const atModeModern = document.getElementById('atModeModern');
    const atModeClassic = document.getElementById('atModeClassic');
    const lblModeModern = document.getElementById('lblModeModern');
    const lblModeClassic = document.getElementById('lblModeClassic');

    const atInputType = document.getElementById('atInputType');
    const atTracking = document.getElementById('atTracking');
    const valAtTracking = document.getElementById('valAtTracking');
    const atDetune = document.getElementById('atDetune');
    const valAtDetune = document.getElementById('valAtDetune');
    const atTranspose = document.getElementById('atTranspose');
    const valAtTranspose = document.getElementById('valAtTranspose');

    const atFormantToggle = document.getElementById('atFormantToggle');
    const atThroat = document.getElementById('atThroat');
    const valAtThroat = document.getElementById('valAtThroat');

    const atVibratoToggle = document.getElementById('atVibratoToggle');
    const atVibShape = document.getElementById('atVibShape');
    const atVibDepth = document.getElementById('atVibDepth');
    const valAtVibDepth = document.getElementById('valAtVibDepth');
    const atVibRate = document.getElementById('atVibRate');
    const valAtVibRate = document.getElementById('valAtVibRate');
    const atVibDelay = document.getElementById('atVibDelay');
    const valAtVibDelay = document.getElementById('valAtVibDelay');
    const atVibVariation = document.getElementById('atVibVariation');
    const valAtVibVariation = document.getElementById('valAtVibVariation');

    const btnAllActive = document.getElementById('btnAllActive');
    const btnBypassAll = document.getElementById('btnBypassAll');
    const btnResetScale = document.getElementById('btnResetScale');
    const atUserPresetsGroup = document.getElementById('atUserPresetsGroup');

    // 12 Semitones: 1: Active, 2: Bypass, 0: Removed
    let noteStates = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];

    const pushEngineUpdate = () => {
      audioEngine._atNoteStates = noteStates;
      audioEngine.updateAutoTuneSettings();
    };

    // Update piano keys UI classes from noteStates
    const renderPianoKeys = () => {
      if (!atPianoStrip) return;
      const keys = atPianoStrip.querySelectorAll('.piano-key');
      keys.forEach((k) => {
        const note = parseInt(k.getAttribute('data-note'), 10);
        const state = noteStates[note];
        k.classList.toggle('active', state === 1);
        k.classList.toggle('bypass', state === 2);
        k.classList.toggle('removed', state === 0);
      });
    };

    // Apply scale mapping to keyboard based on selected root key & scale
    const applyScaleToKeyboard = () => {
      const scaleName = atScale?.value || 'chromatic';
      const root = parseInt(atKey?.value || '0', 10);
      const scaleIntervals = SCALE_MAP[scaleName] || SCALE_MAP.chromatic;

      for (let note = 0; note < 12; note++) {
        const relPc = (note - root + 12) % 12;
        noteStates[note] = scaleIntervals.includes(relPc) ? 1 : 0;
      }
      renderPianoKeys();
      pushEngineUpdate();
    };

    // Piano key clicks: cycle Active (1) -> Bypass (2) -> Removed (0) -> Active (1)
    if (atPianoStrip) {
      atPianoStrip.addEventListener('click', (e) => {
        const btn = e.target.closest('.piano-key');
        if (!btn) return;
        const note = parseInt(btn.getAttribute('data-note'), 10);
        if (Number.isNaN(note)) return;

        if (noteStates[note] === 1) noteStates[note] = 2;
        else if (noteStates[note] === 2) noteStates[note] = 0;
        else noteStates[note] = 1;

        renderPianoKeys();
        pushEngineUpdate();
      });
    }

    btnAllActive?.addEventListener('click', () => {
      noteStates = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
      renderPianoKeys();
      pushEngineUpdate();
    });

    btnBypassAll?.addEventListener('click', () => {
      noteStates = [2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2];
      renderPianoKeys();
      pushEngineUpdate();
    });

    btnResetScale?.addEventListener('click', () => {
      applyScaleToKeyboard();
    });

    atKey?.addEventListener('change', () => {
      applyScaleToKeyboard();
    });

    atScale?.addEventListener('change', () => {
      applyScaleToKeyboard();
    });

    // Mode Toggle (Modern vs Classic)
    const setCorrectionMode = (mode) => {
      if (mode === 'classic') {
        if (atModeClassic) atModeClassic.checked = true;
        lblModeClassic?.classList.add('active');
        lblModeModern?.classList.remove('active');
      } else {
        if (atModeModern) atModeModern.checked = true;
        lblModeModern?.classList.add('active');
        lblModeClassic?.classList.remove('active');
      }
      pushEngineUpdate();
    };

    atModeModern?.addEventListener('change', () => setCorrectionMode('modern'));
    atModeClassic?.addEventListener('change', () => setCorrectionMode('classic'));
    lblModeModern?.addEventListener('click', () => setCorrectionMode('modern'));
    lblModeClassic?.addEventListener('click', () => setCorrectionMode('classic'));

    // Master Power Toggle
    atToggle?.addEventListener('change', async (e) => {
      await audioEngine.boot();
      const isChecked = e.target.checked;
      const t = audioEngine.ctx.currentTime;
      audioEngine.engine.autoTuneDry.gain.setTargetAtTime(isChecked ? 0.0 : 1.0, t, 0.02);
      audioEngine.engine.autoTuneWet.gain.setTargetAtTime(isChecked ? 1.0 : 0.0, t, 0.02);
      atStatusDot?.classList.toggle('active', isChecked);

      if (!isChecked) {
        if (atPitchNeedle) atPitchNeedle.style.left = '50%';
        if (atInputReadout) atInputReadout.textContent = '--';
        if (atTargetReadout) atTargetReadout.textContent = '--';
        if (atStatusBadge) {
          atStatusBadge.className = 'at-status-badge';
          atStatusBadge.textContent = 'BYPASS';
        }
        const hudNote = document.getElementById('hudNote');
        if (hudNote) hudNote.textContent = '🎤 PITCH: --';
        const hudCoach = document.getElementById('hudCoach');
        if (hudCoach) hudCoach.textContent = '🎯 COACH: READY';
        if (atPianoStrip) {
          atPianoStrip.querySelectorAll('.current-sung').forEach((k) => k.classList.remove('current-sung'));
        }
      }
      pushEngineUpdate();
    });

    // Sliders & Readout listeners
    atSpeed?.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      if (valAtSpeed) valAtSpeed.textContent = v === 0 ? '0 ms (Hard Robo)' : `${v} ms`;
      pushEngineUpdate();
    });

    atFlex?.addEventListener('input', (e) => {
      if (valAtFlex) valAtFlex.textContent = `${e.target.value}%`;
      pushEngineUpdate();
    });

    atHumanize?.addEventListener('input', (e) => {
      if (valAtHumanize) valAtHumanize.textContent = `${e.target.value}%`;
      pushEngineUpdate();
    });

    atMix?.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      if (valAtMix) valAtMix.textContent = `${Math.round(v * 100)}%`;
      pushEngineUpdate();
    });

    atInputType?.addEventListener('change', pushEngineUpdate);

    atTracking?.addEventListener('input', (e) => {
      if (valAtTracking) valAtTracking.textContent = `${Math.round(parseFloat(e.target.value) * 100)}%`;
      pushEngineUpdate();
    });

    atDetune?.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      const freq = (440 * Math.pow(2, v / 1200)).toFixed(1);
      if (valAtDetune) valAtDetune.textContent = `${freq}`;
      pushEngineUpdate();
    });

    atTranspose?.addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      if (valAtTranspose) valAtTranspose.textContent = `${v > 0 ? '+' : ''}${v} st`;
      pushEngineUpdate();
    });

    atFormantToggle?.addEventListener('change', pushEngineUpdate);

    atThroat?.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      if (valAtThroat) valAtThroat.textContent = `${v.toFixed(2)}x`;
      pushEngineUpdate();
    });

    atVibratoToggle?.addEventListener('change', pushEngineUpdate);
    atVibShape?.addEventListener('change', pushEngineUpdate);

    atVibDepth?.addEventListener('input', (e) => {
      if (valAtVibDepth) valAtVibDepth.textContent = `${e.target.value}¢`;
      pushEngineUpdate();
    });

    atVibRate?.addEventListener('input', (e) => {
      if (valAtVibRate) valAtVibRate.textContent = `${parseFloat(e.target.value).toFixed(1)} Hz`;
      pushEngineUpdate();
    });

    atVibDelay?.addEventListener('input', (e) => {
      if (valAtVibDelay) valAtVibDelay.textContent = `${e.target.value} ms`;
      pushEngineUpdate();
    });

    atVibVariation?.addEventListener('input', (e) => {
      if (valAtVibVariation) valAtVibVariation.textContent = `${e.target.value}%`;
      pushEngineUpdate();
    });

    // Pitch Graph Toggle
    btnToggleGraph?.addEventListener('click', () => {
      const isHidden = atGraphWrapper?.classList.toggle('is-hidden');
      btnToggleGraph?.classList.toggle('active', !isHidden);
    });

    // Graph Visualizer Rendering State
    const pitchHistory = [];
    const MAX_HISTORY = 90;

    const renderPitchGraph = () => {
      if (!ctx2d || !canvas || atGraphWrapper?.classList.contains('is-hidden')) return;

      const w = canvas.width;
      const h = canvas.height;
      ctx2d.clearRect(0, 0, w, h);

      // Background grid: draw subtle horizontal pitch reference lines
      ctx2d.strokeStyle = 'rgba(255, 255, 255, 0.07)';
      ctx2d.lineWidth = 1;
      const gridLines = 5;
      for (let i = 1; i < gridLines; i++) {
        const y = (h / gridLines) * i;
        ctx2d.beginPath();
        ctx2d.moveTo(0, y);
        ctx2d.lineTo(w, y);
        ctx2d.stroke();
      }

      // Center pitch guide line
      ctx2d.strokeStyle = 'rgba(103, 248, 170, 0.25)';
      ctx2d.setLineDash([4, 4]);
      ctx2d.beginPath();
      ctx2d.moveTo(0, h / 2);
      ctx2d.lineTo(w, h / 2);
      ctx2d.stroke();
      ctx2d.setLineDash([]);

      if (pitchHistory.length < 2) return;

      // Draw Raw Sung Pitch curve (Neon Orange)
      ctx2d.beginPath();
      ctx2d.strokeStyle = '#ffb15c';
      ctx2d.lineWidth = 2;
      let isFirst = true;
      for (let i = 0; i < pitchHistory.length; i++) {
        const item = pitchHistory[i];
        const x = (i / (MAX_HISTORY - 1)) * w;
        if (!item.voiced) {
          isFirst = true;
          continue;
        }
        // Map cents diff (-50 to +50) to canvas height
        const y = h / 2 - (item.cents / 50) * (h * 0.42);
        if (isFirst) {
          ctx2d.moveTo(x, y);
          isFirst = false;
        } else {
          ctx2d.lineTo(x, y);
        }
      }
      ctx2d.stroke();

      // Draw Auto-Tuned Output Pitch curve (Neon Cyan)
      ctx2d.beginPath();
      ctx2d.strokeStyle = '#45e6ff';
      ctx2d.lineWidth = 2.5;
      ctx2d.shadowColor = '#45e6ff';
      ctx2d.shadowBlur = 6;
      isFirst = true;
      for (let i = 0; i < pitchHistory.length; i++) {
        const item = pitchHistory[i];
        const x = (i / (MAX_HISTORY - 1)) * w;
        if (!item.voiced) {
          isFirst = true;
          continue;
        }
        // Corrected pitch pulled towards center line (0 cents)
        const correctedCents = item.cents * (1 - (item.ratio ? Math.abs(1 - item.ratio) * 0.8 : 0.8));
        const y = h / 2 - (correctedCents / 50) * (h * 0.42);
        if (isFirst) {
          ctx2d.moveTo(x, y);
          isFirst = false;
        } else {
          ctx2d.lineTo(x, y);
        }
      }
      ctx2d.stroke();
      ctx2d.shadowBlur = 0;
    };

    // Telemetry updates from Worklet DSP
    audioEngine.onAutoTuneTelemetry((data) => {
      const isEnabled = atToggle?.checked;

      pitchHistory.push({
        voiced: isEnabled && data.voiced,
        cents: data.cents || 0,
        rawFreq: data.detectedFreq || 0,
        targetFreq: data.targetFreq || 0,
        ratio: data.ratio || 1.0
      });
      if (pitchHistory.length > MAX_HISTORY) pitchHistory.shift();

      renderPitchGraph();

      if (!isEnabled) return;

      if (data.voiced && data.detectedFreq > 0) {
        // Update needle position: cents (-50 to +50) mapped to 2% - 98%
        const pct = Math.max(2, Math.min(98, 50 + (data.cents / 50) * 50));
        if (atPitchNeedle) {
          atPitchNeedle.style.left = `${pct}%`;
          atPitchNeedle.classList.toggle('in-tune', Math.abs(data.cents) <= 4);
        }

        if (atInputReadout) {
          atInputReadout.textContent = `${data.noteName}${data.octave} (${data.detectedFreq.toFixed(1)}Hz)`;
        }
        if (atTargetReadout) {
          const sign = data.cents > 0 ? '+' : '';
          atTargetReadout.textContent = `${data.targetFreq.toFixed(1)}Hz (${sign}${data.cents}¢)`;
        }

        if (atStatusBadge) {
          atStatusBadge.className = 'at-status-badge';
          if (Math.abs(data.cents) <= 3) {
            atStatusBadge.classList.add('status-perfect');
            atStatusBadge.textContent = 'PERFECT';
          } else if (data.cents < 0) {
            atStatusBadge.classList.add('status-flat');
            atStatusBadge.textContent = `FLAT (${data.cents}¢)`;
          } else {
            atStatusBadge.classList.add('status-sharp');
            atStatusBadge.textContent = `SHARP (+${data.cents}¢)`;
          }
        }

        // Active sung piano key indicator
        if (atPianoStrip) {
          atPianoStrip.querySelectorAll('.piano-key').forEach((k) => {
            const note = parseInt(k.getAttribute('data-note'), 10);
            k.classList.toggle('current-sung', note === data.noteIndex);
          });
        }
      } else {
        // Natural ease back to center when unvoiced
        if (atPitchNeedle) atPitchNeedle.style.left = '50%';
        if (atInputReadout) atInputReadout.textContent = '--';
        if (atTargetReadout) atTargetReadout.textContent = '--';
        if (atStatusBadge) {
          atStatusBadge.className = 'at-status-badge';
          atStatusBadge.textContent = 'TRACKING';
        }
        if (atPianoStrip) {
          atPianoStrip.querySelectorAll('.current-sung').forEach((k) => k.classList.remove('current-sung'));
        }
      }
    });

    // Preset Loader
    const applyPresetObject = (p) => {
      if (!p) return;
      if (p.speed !== undefined && atSpeed) {
        atSpeed.value = p.speed;
        if (valAtSpeed) valAtSpeed.textContent = p.speed === 0 ? '0 ms (Hard Robo)' : `${p.speed} ms`;
      }
      if (p.flexTune !== undefined && atFlex) {
        atFlex.value = p.flexTune;
        if (valAtFlex) valAtFlex.textContent = `${p.flexTune}%`;
      }
      if (p.humanize !== undefined && atHumanize) {
        atHumanize.value = p.humanize;
        if (valAtHumanize) valAtHumanize.textContent = `${p.humanize}%`;
      }
      if (p.mix !== undefined && atMix) {
        atMix.value = p.mix;
        if (valAtMix) valAtMix.textContent = `${Math.round(p.mix * 100)}%`;
      }
      if (p.mode) setCorrectionMode(p.mode);
      if (p.inputType && atInputType) atInputType.value = p.inputType;
      if (p.tracking !== undefined && atTracking) {
        atTracking.value = p.tracking;
        if (valAtTracking) valAtTracking.textContent = `${Math.round(p.tracking * 100)}%`;
      }
      if (p.detune !== undefined && atDetune) {
        atDetune.value = p.detune;
        if (valAtDetune) valAtDetune.textContent = `${(440 * Math.pow(2, p.detune / 1200)).toFixed(1)}`;
      }
      if (p.transpose !== undefined && atTranspose) {
        atTranspose.value = p.transpose;
        if (valAtTranspose) valAtTranspose.textContent = `${p.transpose > 0 ? '+' : ''}${p.transpose} st`;
      }
      if (p.formant !== undefined && atFormantToggle) atFormantToggle.checked = p.formant;
      if (p.throat !== undefined && atThroat) {
        atThroat.value = p.throat;
        if (valAtThroat) valAtThroat.textContent = `${p.throat.toFixed(2)}x`;
      }
      if (p.vibrato !== undefined && atVibratoToggle) atVibratoToggle.checked = p.vibrato;
      if (p.vibShape && atVibShape) atVibShape.value = p.vibShape;
      if (p.vibDepth !== undefined && atVibDepth) {
        atVibDepth.value = p.vibDepth;
        if (valAtVibDepth) valAtVibDepth.textContent = `${p.vibDepth}¢`;
      }
      if (p.vibRate !== undefined && atVibRate) {
        atVibRate.value = p.vibRate;
        if (valAtVibRate) valAtVibRate.textContent = `${p.vibRate.toFixed(1)} Hz`;
      }
      if (p.vibDelay !== undefined && atVibDelay) {
        atVibDelay.value = p.vibDelay;
        if (valAtVibDelay) valAtVibDelay.textContent = `${p.vibDelay} ms`;
      }
      if (p.vibVariation !== undefined && atVibVariation) {
        atVibVariation.value = p.vibVariation;
        if (valAtVibVariation) valAtVibVariation.textContent = `${p.vibVariation}%`;
      }
      pushEngineUpdate();
    };

    // User Presets Storage
    const STORAGE_KEY = 'nirmal_autotune_user_presets';
    const getUserPresets = () => {
      try {
        return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      } catch (_) {
        return {};
      }
    };

    const refreshUserPresetDropdown = () => {
      if (!atUserPresetsGroup) return;
      atUserPresetsGroup.innerHTML = '';
      const userPresets = getUserPresets();
      const keys = Object.keys(userPresets);
      keys.forEach((key) => {
        const opt = document.createElement('option');
        opt.value = `user_${key}`;
        opt.textContent = `⭐ ${userPresets[key].name || key}`;
        atUserPresetsGroup.appendChild(opt);
      });
    };

    atPresetSelect?.addEventListener('change', (e) => {
      const val = e.target.value;
      if (val.startsWith('user_')) {
        const key = val.replace('user_', '');
        const userPresets = getUserPresets();
        if (userPresets[key]) applyPresetObject(userPresets[key]);
      } else if (AUTOTUNE_PRESETS[val]) {
        applyPresetObject(AUTOTUNE_PRESETS[val]);
      }
    });

    btnSavePreset?.addEventListener('click', () => {
      const name = prompt('Enter a name for your custom Auto-Tune Pro X preset:');
      if (!name || !name.trim()) return;

      const userPresets = getUserPresets();
      const presetId = `preset_${Date.now()}`;
      userPresets[presetId] = {
        name: name.trim(),
        speed: parseFloat(atSpeed?.value || '20'),
        flexTune: parseFloat(atFlex?.value || '0'),
        humanize: parseFloat(atHumanize?.value || '0'),
        mix: parseFloat(atMix?.value || '1.0'),
        mode: atModeClassic?.checked ? 'classic' : 'modern',
        inputType: atInputType?.value || 'altoTenor',
        tracking: parseFloat(atTracking?.value || '0.85'),
        detune: parseFloat(atDetune?.value || '0'),
        transpose: parseInt(atTranspose?.value || '0', 10),
        formant: atFormantToggle?.checked ?? true,
        throat: parseFloat(atThroat?.value || '1.0'),
        vibrato: atVibratoToggle?.checked ?? false,
        vibShape: atVibShape?.value || 'sine',
        vibDepth: parseFloat(atVibDepth?.value || '0'),
        vibRate: parseFloat(atVibRate?.value || '5.5'),
        vibDelay: parseFloat(atVibDelay?.value || '0'),
        vibVariation: parseFloat(atVibVariation?.value || '0')
      };

      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(userPresets));
        refreshUserPresetDropdown();
        if (atPresetSelect) atPresetSelect.value = `user_${presetId}`;
        alert(`Preset "${name.trim()}" saved successfully!`);
      } catch (err) {
        alert('Could not save preset to localStorage.');
      }
    });

    // Initialize Keyboard & Presets
    applyScaleToKeyboard();
    refreshUserPresetDropdown();

    // Default preset
    if (AUTOTUNE_PRESETS.modernPop) {
      applyPresetObject(AUTOTUNE_PRESETS.modernPop);
    }
  }

  setupAutoTuneProX();

  document.getElementById('fxRouteMedia')?.addEventListener('change', async (e) => {
    await audioEngine.boot();
    audioEngine.engine.mediaToFx.gain.setTargetAtTime(e.target.checked ? 1.0 : 0.0, audioEngine.ctx.currentTime, 0.02);
    audioEngine.engine.mediaToDry.gain.setTargetAtTime(e.target.checked ? 0.0 : 1.0, audioEngine.ctx.currentTime, 0.02);
  });

  document.getElementById('fxRouteMic')?.addEventListener('change', async (e) => {
    await audioEngine.boot();
    audioEngine.engine.micToFx.gain.setTargetAtTime(e.target.checked ? 1.0 : 0.0, audioEngine.ctx.currentTime, 0.02);
    audioEngine.engine.micToDry.gain.setTargetAtTime(e.target.checked ? 0.0 : 1.0, audioEngine.ctx.currentTime, 0.02);
  });

  document.getElementById('vocalRemoverToggle')?.addEventListener('change', async (e) => {
    await audioEngine.boot();
    audioEngine.engine.mediaVrDry.gain.setTargetAtTime(e.target.checked ? 0.0 : 1.0, audioEngine.ctx.currentTime, 0.02);
    audioEngine.engine.mediaVrWet.gain.setTargetAtTime(e.target.checked ? 1.0 : 0.0, audioEngine.ctx.currentTime, 0.02);
  });

  document.getElementById('btnKeyFlat')?.addEventListener('click', () => {
    if (audioEngine.currentKey > -12) audioEngine.updateKey(audioEngine.currentKey - 1);
  });
  document.getElementById('btnKeySharp')?.addEventListener('click', () => {
    if (audioEngine.currentKey < 12) audioEngine.updateKey(audioEngine.currentKey + 1);
  });
  document.getElementById('btnKeyReset')?.addEventListener('click', () => audioEngine.updateKey(0));

  // Search Open/Close - handles desktop stage action and mobile music tab buttons
  const handleOpenMusicSearch = (forceOpen) => {
    if (window.innerWidth <= 850 && typeof window.setActiveMobileScreen === 'function') {
      window.setActiveMobileScreen('music');
    }
    searchManager.toggleSearchBox(forceOpen);
  };
  document.getElementById('btnOpenMusicSearch')?.addEventListener('click', () => handleOpenMusicSearch(true));
  document.getElementById('btnFindMusicInTab')?.addEventListener('click', () => searchManager.toggleSearchBox());
  document.getElementById('btnFindMusicInTabBottom')?.addEventListener('click', () => searchManager.toggleSearchBox());
  document.getElementById('btnDoMusicSearch')?.addEventListener('click', () => searchManager.searchMusic());
  document.getElementById('musicSearchInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') searchManager.searchMusic();
  });
  document.getElementById('btnRefreshTrending')?.addEventListener('click', () => {
    const input = document.getElementById('musicSearchInput');
    if (input) input.value = '';
    searchManager.searchMusic();
  });

  // Direct Audio Player events for LRC Auto-scrolling
  const filePlayer = document.getElementById('filePlayer');
  filePlayer?.addEventListener('timeupdate', () => lyricsManager.updateLyricScrollPosition());

  document.getElementById('lyricsWindowToggle')?.addEventListener('change', (e) => {
    const container = document.getElementById('lyricsDisplayContainer');
    if (container) container.style.display = e.target.checked ? 'block' : 'none';
    if (e.target.checked && lyricsManager.parsedLyrics.length > 0) lyricsManager.updateLyricScrollPosition();
  });

  document.getElementById('btnLoadLrc')?.addEventListener('click', () => document.getElementById('lrcInput')?.click());
  document.getElementById('lrcInput')?.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      lyricsManager.parseLRC(ev.target.result);
      const dlBtn = document.getElementById('btnDownloadAutoLrc');
      if (dlBtn) dlBtn.style.display = 'block';
    };
    reader.readAsText(file);
  });

  document.getElementById('btnDownloadAutoLrc')?.addEventListener('click', () => {
    lyricsManager.downloadLrc('Nirmal_Lyrics_Synced.lrc');
  });

  document.getElementById('btnSyncMinus')?.addEventListener('click', () => {
    lyricsManager.lyricSyncOffset -= 0.5;
    lyricsManager.updateSyncUI();
    pushPlaybackClock();
  });
  document.getElementById('btnSyncPlus')?.addEventListener('click', () => {
    lyricsManager.lyricSyncOffset += 0.5;
    lyricsManager.updateSyncUI();
    pushPlaybackClock();
  });
  document.getElementById('btnSyncReset')?.addEventListener('click', () => {
    lyricsManager.lyricSyncOffset = 0.0;
    lyricsManager.updateSyncUI();
    pushPlaybackClock();
  });

  document.getElementById('btnSearchLrc')?.addEventListener('click', () => {
    const box = document.getElementById('lrcSearchBox');
    if (box) box.style.display = box.style.display === 'none' ? 'block' : 'none';
    const createBox = document.getElementById('lrcCreateBox');
    if (createBox) createBox.style.display = 'none';
  });

  document.getElementById('btnDoSearch')?.addEventListener('click', async () => {
    const q = document.getElementById('lrcSearchInput')?.value.trim();
    if (!q) return;
    const resBox = document.getElementById('lrcSearchResults');
    if (resBox) resBox.innerHTML = '<span style="color:var(--text-dim); font-size: 0.8rem;">Searching LRCLIB...</span>';
    try {
      const response = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(q)}`);
      const data = await response.json();
      if (resBox) resBox.innerHTML = '';
      if (!Array.isArray(data) || data.length === 0) {
        if (resBox) resBox.innerHTML = '<span style="color:var(--text-dim); font-size: 0.8rem;">No results found.</span>';
        return;
      }
      let found = false;
      data.forEach((track) => {
        if (!track.syncedLyrics) return;
        found = true;
        const div = document.createElement('div');
        div.className = 'search-result-item';
        const durStr = lyricsManager.formatDuration(track.duration);
        div.innerHTML = `<strong>${track.trackName} <span style="color:var(--text-dim)">${durStr}</span></strong> - ${track.artistName} <span style="color:var(--accent-green)">[Synced]</span>`;
        div.addEventListener('click', () => {
          lyricsManager.parseLRC(track.syncedLyrics);
          const dlBtn = document.getElementById('btnDownloadAutoLrc');
          if (dlBtn) dlBtn.style.display = 'block';
          const searchBox = document.getElementById('lrcSearchBox');
          if (searchBox) searchBox.style.display = 'none';
        });
        if (resBox) resBox.appendChild(div);
      });
      if (!found && resBox) resBox.innerHTML = '<span style="color:var(--text-dim); font-size: 0.8rem;">No synced lyrics found.</span>';
    } catch (e) {
      if (resBox) resBox.innerHTML = '<span style="color:var(--accent-red); font-size: 0.8rem;">Connection error.</span>';
    }
  });

  document.getElementById('btnCreateLrc')?.addEventListener('click', () => {
    const createBox = document.getElementById('lrcCreateBox');
    if (createBox) createBox.style.display = createBox.style.display === 'none' ? 'block' : 'none';
    const searchBox = document.getElementById('lrcSearchBox');
    if (searchBox) searchBox.style.display = 'none';
  });

  document.getElementById('btnApplyCustomLrc')?.addEventListener('click', () => {
    const editor = document.getElementById('lrcEditor');
    if (editor) lyricsManager.parseLRC(editor.value);
    const dlBtn = document.getElementById('btnDownloadAutoLrc');
    if (dlBtn) dlBtn.style.display = 'block';
    const createBox = document.getElementById('lrcCreateBox');
    if (createBox) createBox.style.display = 'none';
  });

  document.getElementById('btnDownloadCustomLrc')?.addEventListener('click', () => {
    const editor = document.getElementById('lrcEditor');
    if (editor) lyricsManager.parseLRC(editor.value);
    lyricsManager.downloadLrc(`Nirmal_Lyrics_${Date.now()}.lrc`);
  });

  // PC Tab Capture
  document.getElementById('btnTab')?.addEventListener('click', async () => {
    try {
      killMedia();
      await audioEngine.boot();
      if (!navigator.mediaDevices.getDisplayMedia) throw new Error('Tab capture is strictly for PC.');
      const stream = await navigator.mediaDevices.getDisplayMedia({
        // Let Chrome offer tab/window/entire-screen choices. Do not force a
        // browser tab because users may intentionally share the whole screen.
        video: true,
        audio: {
          channelCount: { ideal: 2 },
          sampleRate: { ideal: 48000 },
          suppressLocalAudioPlayback: true,
          echoCancellation: 'remote-only',
          noiseSuppression: false,
          autoGainControl: false,
          restrictOwnAudio: true
        },
        systemAudio: 'include',
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'include',
        windowAudio: 'window',
        monitorTypeSurfaces: 'include'
      });
      if (stream.getAudioTracks().length === 0) {
        stream.getTracks().forEach((t) => t.stop());
        throw new Error("No audio found. Check 'Share tab audio' in popup.");
      }
      audioEngine.activeTabStream = stream;
      audioEngine.activeTabNode = audioEngine.ctx.createMediaStreamSource(stream);
      audioEngine.activeTabNode.connect(audioEngine.engine.mediaGain);
      document.getElementById('btnTab')?.classList.add('active-tab');
      const btnStopMedia = document.getElementById('btnStopMedia');
      if (btnStopMedia) btnStopMedia.style.display = 'flex';
      document.getElementById('led-in')?.classList.add('active-blue');
      syncBackgroundKeepAlive();
      stream.getVideoTracks()[0].onended = killMedia;
    } catch (e) {
      alert(e.message);
    }
  });

  // Local File Upload
  document.getElementById('btnFile')?.addEventListener('click', async () => {
    await audioEngine.boot();
    document.getElementById('mediaInput')?.click();
  });

  document.getElementById('mediaInput')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    killMedia();
    filePlayer.removeAttribute('crossorigin');
    const objectUrl = URL.createObjectURL(file);
    filePlayer.src = objectUrl;
    const playerWrapper = document.getElementById('playerWrapper');
    if (playerWrapper) playerWrapper.style.display = 'block';
    filePlayer.load();

    const getAudioDuration = new Promise((resolve) => {
      if (!isNaN(filePlayer.duration) && filePlayer.duration > 0) resolve(filePlayer.duration);
      else {
        filePlayer.onloadedmetadata = () => resolve(filePlayer.duration);
        setTimeout(() => resolve(filePlayer.duration || 0), 1500);
      }
    });

    audioEngine.connectMediaElement(filePlayer);
    filePlayer.play().catch(() => console.log('Browser requires manual play click.'));
    document.getElementById('btnFile')?.classList.add('active-file');
    const btnStopMedia = document.getElementById('btnStopMedia');
    if (btnStopMedia) btnStopMedia.style.display = 'flex';
    document.getElementById('led-in')?.classList.add('active-blue');

    const npTitle = document.getElementById('nowPlayingTitle');
    const npArtist = document.getElementById('nowPlayingArtist');
    if (npTitle) npTitle.textContent = file.name.replace(/\.[^/.]+$/, '');
    if (npArtist) npArtist.textContent = 'Uploaded Local Audio';

    const detectedDuration = await getAudioDuration;
    lyricsManager.autoFetchLyricsWithLengthMatch(file, detectedDuration);
  });

  document.getElementById('btnStopMedia')?.addEventListener('click', killMedia);

  // Microphone Hook
  document.getElementById('btnMic')?.addEventListener('click', async () => {
    try {
      killMic();
      await audioEngine.boot();
      if (audioEngine.ctx && audioEngine.ctx.state === 'suspended') {
        await audioEngine.ctx.resume();
      }

      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: { ideal: 1 },
            echoCancellation: { ideal: true },
            noiseSuppression: { ideal: true },
            autoGainControl: false,
            latency: { ideal: 0.005 }
          }
        });
      } catch (err) {
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: true
            }
          });
        } catch (err2) {
          stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        }
      }

      audioEngine.activeMicStream = stream;
      audioEngine.activeMicNode = audioEngine.ctx.createMediaStreamSource(stream);
      // Fix C: pin the mic source node to 1-ch explicit so no browser
      // channel-count negotiation creates phantom stereo issues in the
      // downstream DSP graph. Vocal input is intentionally mono.
      try { audioEngine.activeMicNode.channelCount = 1; } catch (_) {}
      try { audioEngine.activeMicNode.channelCountMode = 'explicit'; } catch (_) {}
      try { audioEngine.activeMicNode.channelInterpretation = 'discrete'; } catch (_) {}
      audioEngine.activeMicNode.connect(audioEngine.engine.micGain);
      stream.getAudioTracks()[0]?.addEventListener('ended', killMic, { once: true });

      const btnMic = document.getElementById('btnMic');
      if (btnMic) {
        btnMic.classList.add('active-mic');
        btnMic.innerHTML = '🎙 Mic live (Singing)';
      }
      const stopBtn = document.getElementById('btnStopMic');
      if (stopBtn) stopBtn.style.display = 'flex';
      document.getElementById('led-mic')?.classList.add('active-green');
      syncBackgroundKeepAlive();
    } catch (e) {
      alert('Microphone Error: ' + (e.message || 'Permission denied or mic unavailable.'));
    }
  });

  document.getElementById('btnStopMic')?.addEventListener('click', killMic);

  // Recorder Hook
  document.getElementById('btnRecord')?.addEventListener('click', async () => {
    await audioEngine.boot();
    const btnRecord = document.getElementById('btnRecord');
    const ledRec = document.getElementById('led-rec');

    if (audioEngine.recorder && audioEngine.recorder.state === 'recording') {
      audioEngine.recorder.stop();
      if (btnRecord) {
        btnRecord.innerHTML = '⏺ Start Recording';
        btnRecord.classList.remove('active-rec');
      }
      if (ledRec) ledRec.classList.remove('active-rec');
    } else {
      audioEngine.recChunks = [];
      try {
        audioEngine.recorder = new MediaRecorder(audioEngine.engine.dest.stream);
      } catch (e) {
        alert('Recording is not supported in this browser.');
        return;
      }

      audioEngine.recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioEngine.recChunks.push(e.data);
      };

      audioEngine.recorder.onstop = () => {
        const totalSize = audioEngine.recChunks.reduce((acc, c) => acc + c.size, 0);
        if (totalSize === 0) {
          console.warn('[Nirmal] recording aborted: 0 bytes recorded.');
          alert('Recording was too short or contained no audio.');
          return;
        }
        const ext = (audioEngine.recChunks[0]?.type || 'audio/webm').includes('mp4') ? 'mp4' : 'webm';
        const url = URL.createObjectURL(new Blob(audioEngine.recChunks, { type: audioEngine.recChunks[0]?.type || 'audio/webm' }));
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = `Nirmal_Mix_${Date.now()}.${ext}`;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          document.body.removeChild(a);
          window.URL.revokeObjectURL(url);
        }, 100);
      };

      audioEngine.recorder.start(100);
      if (btnRecord) {
        btnRecord.innerHTML = '⏹ Stop & Save Recording';
        btnRecord.classList.add('active-rec');
      }
      if (ledRec) ledRec.classList.add('active-rec');
    }
  });

  navigator.mediaDevices?.addEventListener('devicechange', scanHardware);
}

window.addEventListener('DOMContentLoaded', () => {
  visualizer.init();
  scanHardware();
  setupEventListeners();
  setupLiveShareUI();
});

// Accidental reload & navigation protection
function shouldWarnOnReload() {
  if (window.__bypassUnloadWarning) return false;

  // 1. Live stream broadcast active or LiveKit room connected or multistream active
  if (liveHost?.isLive || liveHost?.room?.state === 'connected' || liveHost?.impl?.room?.state === 'connected' || multistream?.isStreaming) {
    return true;
  }
  // 2. Microphone or camera is active
  if (audioEngine?.activeMicNode || liveHost?.hostMicTrack || liveHost?.isCameraActive || liveHost?.hostCameraTrack) {
    return true;
  }
  // 3. Audio / karaoke backing track currently playing
  const filePlayer = document.getElementById('filePlayer');
  if (filePlayer && !filePlayer.paused && filePlayer.currentTime > 0 && !filePlayer.ended) {
    return true;
  }
  // 4. Tab or System audio sharing active
  if (audioEngine?.activeTabStream || audioEngine?.activeTabNode) {
    return true;
  }
  // 5. Audio recording in progress
  if (audioEngine?.recorder && audioEngine.recorder.state === 'recording') {
    return true;
  }
  // 6. Songs in the queue or synced lyrics loaded
  if ((searchManager?.playlist && searchManager.playlist.length > 0) || (lyricsManager?.parsedLyrics && lyricsManager.parsedLyrics.length > 0)) {
    return true;
  }
  return false;
}

window.addEventListener('beforeunload', (e) => {
  if (shouldWarnOnReload()) {
    e.preventDefault();
    e.returnValue = 'A live karaoke session is currently active. Reloading will disconnect your broadcast and audio.';
    return e.returnValue;
  }
});