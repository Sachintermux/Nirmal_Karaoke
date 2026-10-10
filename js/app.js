import { AudioEngine } from './audio-engine.js?v=31';
import { LyricsManager } from './lyrics.js?v=31';
import { MusicSearchManager } from './music-search.js?v=33';
import { VisualizerRenderer } from './visualizer.js?v=31';
import { playSFX } from './sfx.js?v=31';
import { LiveStreamHost } from './live-stream.js?v=31';
import { AUTOTUNE_PRESETS, SCALE_MAP, NOTE_NAMES } from './config.js?v=31';
import { PresenceManager } from './presence-manager.js?v=31';
import { MultiStreamManager } from './multistream.js?v=31';
import { ArtistToolsManager } from './artist-tools.js?v=31';
import { acquireWakeLock, releaseWakeLock } from './wake-lock.js?v=31';
import { startBackgroundAudioKeepAlive, stopBackgroundAudioKeepAlive, updateMediaSession } from './media-session.js?v=31';
import { CallOutputManager } from './call-output.js?v=1';
import { ensureSingerName } from './name-prompt.js?v=1';
import { SoundboardManager } from './soundboard.js?v=1';
import { StatsManager } from './stats.js?v=1';

const audioEngine = new AudioEngine();
if (typeof window !== 'undefined') window.audioEngine = audioEngine;
const lyricsManager = new LyricsManager();
const searchManager = new MusicSearchManager(audioEngine, lyricsManager);
if (typeof window !== 'undefined') window.searchManager = searchManager;
const visualizer = new VisualizerRenderer(audioEngine);
if (typeof window !== 'undefined') window.visualizer = visualizer;
const liveHost = new LiveStreamHost(audioEngine);
const presence = new PresenceManager();
if (typeof window !== 'undefined') window.presence = presence;
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
  const isPlayerPlaying = filePlayerGlobal && !filePlayerGlobal.paused && !filePlayerGlobal.ended;
  if (shouldKeepAlive()) {
    acquireWakeLock().catch(() => {});
    // When filePlayer is actively playing music, the browser and OS already maintain an active audio session.
    // Concurrently playing an 8kHz silent audio element causes hardware mixer contention and audible audio cuts/pops on mobile.
    if (isPlayerPlaying) {
      stopBackgroundAudioKeepAlive();
    } else {
      startBackgroundAudioKeepAlive();
    }
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
filePlayerGlobal?.addEventListener('play', async () => {
  if (audioEngine) {
    if (!audioEngine.isGraphComplete()) {
      await audioEngine.boot().catch(() => {});
    } else if (audioEngine.ctx && audioEngine.ctx.state === 'suspended') {
      await audioEngine.ctx.resume().catch(() => {});
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
  try {
    const currentVal = speakerSelect.value;
    const devices = await navigator.mediaDevices.enumerateDevices();
    speakerSelect.innerHTML = '<option value="">Default Audio Interface / Bluetooth</option>';
    devices.filter((d) => d.kind === 'audiooutput').forEach((device, i) => {
      const opt = document.createElement('option');
      opt.value = device.deviceId;
      opt.textContent = device.label || `Output Channel ${i + 1}`;
      if (device.deviceId && device.deviceId === currentVal) opt.selected = true;
      speakerSelect.appendChild(opt);
    });
  } catch (err) {
    console.warn('[Nirmal] scanHardware notice:', err);
  }
}

if (typeof navigator !== 'undefined' && navigator.mediaDevices) {
  navigator.mediaDevices.addEventListener('devicechange', () => {
    console.info('[Nirmal] Audio device change detected, refreshing hardware channels...');
    scanHardware();
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
        <div style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:54%;">
          <strong>${g.name}</strong><br>${micStatus} &nbsp; ${camStatus}
        </div>
        <div style="display:flex;gap:4px;align-items:center;">
          ${g.hasMic ? `<button class="btn-listen-guest" data-id="${g.id}" style="background:var(--accent-blue); color:#fff; border:none; border-radius:3px; padding:3px 7px; font-size:0.65rem; cursor:pointer;">Listen</button>` : ''}
          ${g.hasMic ? `<button class="btn-mute-guest" data-id="${g.id}" style="background:var(--accent-red); color:#fff; border:none; border-radius:3px; padding:3px 8px; font-size:0.65rem; cursor:pointer;">Mute Mic</button>` : ''}
          ${!g.hasMic ? `<button class="btn-invite-guest-stage" data-id="${g.id}" style="background:linear-gradient(135deg,#27a9ff,#2f7cf6); color:#fff; border:none; border-radius:4px; padding:3px 8px; font-size:0.65rem; font-weight:700; cursor:pointer;" title="Invite this listener to sing onstage">🎤 Invite Duet</button>` : ''}
        </div>
      `;

      // Invite connected listener onstage to duet
      const btnInviteDuet = row.querySelector('.btn-invite-guest-stage');
      if (btnInviteDuet) {
        btnInviteDuet.addEventListener('click', async () => {
          btnInviteDuet.disabled = true;
          btnInviteDuet.textContent = 'Inviting…';
          try {
            await liveHost.inviteAudienceToDuet(g.id, g.name);
            btnInviteDuet.textContent = '✓ Invited!';
            btnInviteDuet.style.background = 'var(--accent-green)';
            btnInviteDuet.style.color = '#000';
            setTimeout(() => {
              if (btnInviteDuet.isConnected) {
                btnInviteDuet.disabled = false;
                btnInviteDuet.textContent = '🎤 Invite Duet';
                btnInviteDuet.style.background = 'linear-gradient(135deg,#27a9ff,#2f7cf6)';
                btnInviteDuet.style.color = '#fff';
              }
            }, 6000);
          } catch (err) {
            alert('Failed to send invite: ' + (err.message || err));
            btnInviteDuet.disabled = false;
            btnInviteDuet.textContent = '🎤 Invite Duet';
          }
        });
      }

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
        <div style="background:rgba(47,124,246,0.15); border:1px solid var(--accent-purple); padding:4px 6px; border-radius:4px; margin-bottom:2px;">
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
            title: t.title || t.name || t.song || 'Requested Song',
            artist: t.artist || t.primaryArtists || t.primary_artists || 'Requested Artist',
            album: t.album || '',
            image: t.image || '',
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

  function handleDuetRequest({ identity, name }) {
    console.info(`[Nirmal] Duet request from ${name} (${identity})`);
    let container = document.getElementById('duetRequestContainer');
    if (!container) {
      container = document.createElement('div');
      container.id = 'duetRequestContainer';
      container.style.cssText = 'position:fixed;top:20px;right:20px;z-index:99999;display:flex;flex-direction:column;gap:10px;max-width:360px;width:calc(100% - 40px);pointer-events:none;';
      document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.style.cssText = 'background:linear-gradient(135deg, #181f2b, #0d1118);border:2px solid var(--accent-pink, #27a9ff);border-radius:12px;padding:14px 16px;box-shadow:0 0 25px rgba(39,169,255,0.4);color:#fff;font-size:0.85rem;pointer-events:auto;';
    toast.innerHTML = `
      <div style="font-weight:800;font-size:0.95rem;color:var(--accent-pink, #27a9ff);margin-bottom:6px;display:flex;align-items:center;gap:6px;">
        <span>🎤</span> Duet Mic Request
      </div>
      <div style="margin-bottom:12px;line-height:1.4;">
        <strong>${escapeHtml(name)}</strong> requested to join the stage for a Duet!
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button class="btn-decline-duet" style="background:rgba(255,255,255,0.1);color:#aaa;border:1px solid rgba(255,255,255,0.2);padding:6px 12px;border-radius:6px;font-size:0.8rem;cursor:pointer;font-weight:700;">Decline</button>
        <button class="btn-accept-duet" style="background:var(--accent-green, #00ff88);color:#000;border:none;padding:6px 14px;border-radius:6px;font-size:0.8rem;cursor:pointer;font-weight:800;">Accept & Bring Onstage</button>
      </div>
    `;
    container.appendChild(toast);

    toast.querySelector('.btn-accept-duet').onclick = async () => {
      try {
        await liveHost.approveDuetRequest(identity);
        toast.innerHTML = `<div style="color:var(--accent-green);font-weight:800;">✓ Approved! ${escapeHtml(name)} is joining the stage.</div>`;
        setTimeout(() => toast.remove(), 2500);
      } catch (err) {
        alert('Could not approve duet request: ' + (err.message || err));
        toast.remove();
      }
    };

    toast.querySelector('.btn-decline-duet').onclick = async () => {
      try {
        await liveHost.rejectDuetRequest(identity);
        toast.remove();
      } catch (err) {
        console.warn('[Host] rejectDuetRequest warning:', err);
        toast.remove();
      }
    };

    setTimeout(() => { if (toast.isConnected) toast.remove(); }, 45000);
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
    (reason) => resetLiveBroadcastUI(reason),
    handleDuetRequest
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
      try {
        await liveHost.endRoom();
      } catch (err) {
        console.warn('[Host] liveHost.endRoom warning before restart:', err);
      }
    }
    if (liveStarting) return;
    liveStarting = true;
    btnOpen.disabled = true;
    // Ask for the singer name once (saved on this device, reused next time).
    await ensureSingerName(presence);
    const status = document.getElementById('liveTransportStatus');

    // Open modal immediately to show connection status
    if (modal) modal.style.display = 'flex';
    if (status) status.textContent = 'Connecting to LiveKit SFU…';
    const shareInput = document.getElementById('shareLinkInput');
    if (shareInput) shareInput.value = 'Connecting to broadcast server…';
    if (qrContainer) {
      qrContainer.innerHTML = '<div style="color:var(--text-dim); font-size:0.8rem; text-align:center; padding:30px 10px;">Connecting to LiveKit…</div>';
    }

    try {
      const audioBoot = audioEngine.boot().catch((e) => {
        console.warn('[Nirmal] early audio boot deferred:', e);
        return false;
      });

      const roomId = await liveHost.createRoom(allowDuetToggle?.checked ?? true);
      presence.updateLiveStatus({ role: 'host', roomId, roomName: `${presence.user.name}'s Stage`, isLive: true });
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
      if (status) {
        status.innerHTML = `<span style="color:var(--accent-red, #ff3366); font-weight:700;">⚠️ Live setup failed:</span> <span style="color:var(--text, #fff); font-size:0.75rem;">${errMsg}</span>`;
      }
      if (shareInput) shareInput.value = `⚠️ Error: ${errMsg}`;
      if (qrContainer) {
        qrContainer.innerHTML = `<div style="color:var(--accent-orange, #ff9900); font-size:0.75rem; text-align:center; padding:16px 8px; line-height:1.4;">
          <strong>Live Broadcast Offline</strong><br><br>
          <span style="font-size:0.7rem; color:var(--text-dim);">${errMsg.includes('not configured') ? 'Set LIVEKIT_URL, LIVEKIT_API_KEY & LIVEKIT_API_SECRET in your .env file to enable live audience broadcast.' : errMsg}</span>
        </div>`;
      }
      console.error('[Nirmal] Go Live failed:', e);
      alert(`Go Live Notice:\n\n${errMsg}\n\nNote: All local karaoke studio features (mic, auto-tune, voice effects, stage master tools, recording, and YouTube streaming) are still fully active!`);
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

  // LiveKit Cloud Credentials Configuration (In-App fallback for Netlify)
  const inputLkUrl = document.getElementById('inputLiveKitUrl');
  const inputLkKey = document.getElementById('inputLiveKitApiKey');
  const inputLkSecret = document.getElementById('inputLiveKitApiSecret');
  const btnSaveLk = document.getElementById('btnSaveLiveKitConfig');
  const lblLkStatus = document.getElementById('lblLiveKitConfigStatus');

  try {
    const savedLk = JSON.parse(localStorage.getItem('nirmal_livekit_config') || '{}');
    if (inputLkUrl && savedLk.url) inputLkUrl.value = savedLk.url;
    if (inputLkKey && savedLk.apiKey) inputLkKey.value = savedLk.apiKey;
    if (inputLkSecret && savedLk.apiSecret) inputLkSecret.value = savedLk.apiSecret;
  } catch (_) {}

  btnSaveLk?.addEventListener('click', () => {
    const url = inputLkUrl?.value.trim() || '';
    const apiKey = inputLkKey?.value.trim() || '';
    const apiSecret = inputLkSecret?.value.trim() || '';
    localStorage.setItem('nirmal_livekit_config', JSON.stringify({ url, apiKey, apiSecret }));
    if (lblLkStatus) {
      lblLkStatus.style.display = 'inline';
      lblLkStatus.textContent = 'Saved!';
      setTimeout(() => { lblLkStatus.style.display = 'none'; }, 2500);
    }
  });

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

  // Interactive avatar picker grid popover
  let avatarPickerPopover = null;
  const avatarList = ['🎤', '🎧', '🎸', '🎹', '⚡', '👑', '🔥', '🌟', '🎶', '💎', '🚀', '🐱'];
  desktopMyAvatar?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (avatarPickerPopover) {
      avatarPickerPopover.remove();
      avatarPickerPopover = null;
      return;
    }
    avatarPickerPopover = document.createElement('div');
    avatarPickerPopover.style.cssText = 'position:absolute; top:45px; left:0; z-index:300; background:#19202b; border:1px solid rgba(79,195,255,0.4); border-radius:12px; padding:8px; display:grid; grid-template-columns:repeat(4, 1fr); gap:6px; box-shadow:0 8px 30px rgba(0,0,0,0.8);';
    avatarList.forEach((av) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = av;
      btn.style.cssText = 'background:rgba(255,255,255,0.06); border:1px solid var(--border); border-radius:8px; font-size:1.3rem; padding:6px; cursor:pointer; transition:all 0.15s;';
      if (av === presence.user.avatar) {
        btn.style.borderColor = '#4fc3ff';
        btn.style.background = 'rgba(79,195,255,0.2)';
      }
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        presence.updateProfile(presence.user.name, av);
        updateDesktopMyProfileUI();
        avatarPickerPopover?.remove();
        avatarPickerPopover = null;
      });
      avatarPickerPopover.appendChild(btn);
    });
    if (desktopMyAvatar.parentElement) {
      desktopMyAvatar.parentElement.style.position = 'relative';
      desktopMyAvatar.parentElement.appendChild(avatarPickerPopover);
    }
    const closeOnOutside = (ev) => {
      if (avatarPickerPopover && !avatarPickerPopover.contains(ev.target)) {
        avatarPickerPopover.remove();
        avatarPickerPopover = null;
        document.removeEventListener('click', closeOnOutside);
      }
    };
    setTimeout(() => document.addEventListener('click', closeOnOutside), 50);
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
      if (String(u.id).startsWith('host_')) return false; // legacy phantom "Live Host" entries
      if (presence.currentRoomId && u.roomId === presence.currentRoomId) return false;
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
              await ensureSingerName(presence);
              const rId = await liveHost.createRoom(true);
              await liveHost.ensureProgramAudioPublished?.().catch(() => {});
              presence.updateLiveStatus({ role: 'host', roomId: rId, roomName: `${presence.user.name}'s Stage`, isLive: true });
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
        await ensureSingerName(presence);
        const rId = await liveHost.createRoom(true);
        await liveHost.ensureProgramAudioPublished?.().catch(() => {});
        presence.updateLiveStatus({ role: 'host', roomId: rId, roomName: `${presence.user.name}'s Stage`, isLive: true });
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

    // When navigating to or back to stage, ensure visualizer re-measures and renders smoothly
    if (screenId === 'stage') {
      try {
        visualizer?.refresh?.();
        requestAnimationFrame(() => {
          visualizer?.refresh?.();
        });
      } catch (_) {}
    }
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
    if (audioEngine.updateMonitorRouting) {
      audioEngine.updateMonitorRouting();
    } else {
      const val = e.target.checked ? 1.0 : 0.0;
      if (audioEngine.engine.micMonitorGain && audioEngine.ctx) {
        audioEngine.engine.micMonitorGain.gain.setTargetAtTime(val, audioEngine.ctx.currentTime, 0.02);
      }
      if (audioEngine.engine.monitorGain && audioEngine.ctx) {
        audioEngine.engine.monitorGain.gain.setTargetAtTime(val, audioEngine.ctx.currentTime, 0.02);
      }
    }
  });

  // ─── Live Stage Performance 8-Pad Soundboard ─────────────────────────────
  // Soundboard (built-ins + uploads + hotkeys) is rendered and handled by js/soundboard.js

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
  let lastVuPct = -1;
  let lastPeakText = '';
  let lastPeakTextTs = 0;
  let lastClipState = false;

  artistTools.onPeakUpdate = ({ peak, peakDb, isClipping }) => {
    if (vuBar) {
      const pct = Math.min(100, Math.max(0, ((peakDb + 60) / 60) * 100));
      const roundedPct = Math.round(pct);
      if (roundedPct !== lastVuPct) {
        lastVuPct = roundedPct;
        // transform is compositor-only; animating width forced layout on every update
        vuBar.style.transform = `scaleX(${roundedPct / 100})`;
      }
    }
    if (lblPeak) {
      const peakText = `${peakDb.toFixed(1)} dB`;
      const nowTs = performance.now();
      if (peakText !== lastPeakText && (nowTs - lastPeakTextTs > 120 || isClipping !== lastClipState)) {
        lastPeakTextTs = nowTs;
        lastPeakText = peakText;
        lblPeak.textContent = peakText;
        lblPeak.style.color = isClipping ? '#ef4444' : (peakDb > -6 ? '#eab308' : '#4fc3ff');
      }
    }
    if (lblClip && isClipping !== lastClipState) {
      lastClipState = isClipping;
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
    // Routing decides what is audible locally: with Mic monitor (headphones) ON the backing track is heard through
    // the program mix, so its separate monitor path must stay at 0 (otherwise it plays twice).
    audioEngine.updateMonitorRouting?.();
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
    if (audioEngine.setMasterVolume) {
      audioEngine.setMasterVolume(v);
    } else if (audioEngine.engine.masterGain && audioEngine.ctx) {
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
          lastSungNote = null;
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
      if (!ctx2d || !canvas || atGraphWrapper?.classList.contains('is-hidden') || canvas.offsetParent === null) return;

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
      ctx2d.strokeStyle = '#52c4ff';
      ctx2d.lineWidth = 2.5;
      ctx2d.shadowColor = '#52c4ff';
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
    let lastSungNote = null;
    let pianoKeyEls = null;
    audioEngine.onAutoTuneTelemetry((data) => {
      const isEnabled = atToggle?.checked;

      pitchHistory.push({
        voiced: data.voiced,
        cents: data.cents || 0,
        rawFreq: data.detectedFreq || 0,
        targetFreq: data.targetFreq || 0,
        ratio: data.ratio || 1.0
      });
      if (pitchHistory.length > MAX_HISTORY) pitchHistory.shift();

      renderPitchGraph();

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
          atTargetReadout.textContent = data.targetFreq ? `${data.targetFreq.toFixed(1)}Hz (${sign}${data.cents}¢)` : '--';
        }

        if (atStatusBadge) {
          atStatusBadge.className = 'at-status-badge';
          if (!isEnabled) {
            atStatusBadge.textContent = 'TRACKING';
          } else if (Math.abs(data.cents) <= 3) {
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

        // Active sung piano key indicator (only touch the DOM when the note changes)
        if (atPianoStrip && lastSungNote !== data.noteIndex) {
          lastSungNote = data.noteIndex;
          if (!pianoKeyEls) pianoKeyEls = Array.from(atPianoStrip.querySelectorAll('.piano-key'));
          for (let i = 0; i < pianoKeyEls.length; i++) {
            const k = pianoKeyEls[i];
            k.classList.toggle('current-sung', parseInt(k.getAttribute('data-note'), 10) === data.noteIndex);
          }
        }
      } else {
        // Natural ease back to center when unvoiced
        if (atPitchNeedle) atPitchNeedle.style.left = '50%';
        if (atInputReadout) atInputReadout.textContent = '--';
        if (atTargetReadout) atTargetReadout.textContent = '--';
        if (atStatusBadge) {
          atStatusBadge.className = 'at-status-badge';
          atStatusBadge.textContent = isEnabled ? 'LOCKING' : 'READY';
        }
        if (atPianoStrip && lastSungNote !== null) {
          lastSungNote = null;
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
      } catch (err) {
        console.warn('[AutoTune] Failed to parse user presets from localStorage:', err);
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
    audioEngine.updateMediaFxRouting(e.target.checked);
  });

  document.getElementById('fxRouteMic')?.addEventListener('change', async (e) => {
    await audioEngine.boot();
    audioEngine.updateMicFxRouting(e.target.checked);
  });

  document.getElementById('vocalRemoverToggle')?.addEventListener('change', async (e) => {
    await audioEngine.boot();
    audioEngine.updateVocalRemover(e.target.checked);
  });

  document.getElementById('guideDuckingToggle')?.addEventListener('change', async (e) => {
    await audioEngine.boot();
    if (audioEngine.engine?.guideVocalGain && !e.target.checked && audioEngine.ctx) {
      const slider = document.getElementById('sliderGuideVol');
      const val = parseFloat(slider?.value || 0);
      audioEngine.engine.guideVocalGain.gain.setTargetAtTime(val, audioEngine.ctx.currentTime, 0.02);
    }
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
    searchManager.renderTrending();
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
    // Pre-fill with the current song if the box is empty (e.g. nothing was auto-searched yet)
    const lrcInput = document.getElementById('lrcSearchInput');
    const npTitle = document.getElementById('nowPlayingTitle')?.textContent?.trim();
    const npArtist = document.getElementById('nowPlayingArtist')?.textContent?.trim();
    if (lrcInput && !lrcInput.value.trim() && npTitle && npTitle !== 'Choose a song to begin') {
      lyricsManager.prefillSearchQuery(lyricsManager.sanitizeSongTitle(npTitle), lyricsManager.sanitizeSongTitle(npArtist || ''));
    }
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
      console.warn('[LRC] Auto lyrics fetch failed:', e);
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
      audioEngine._applyMicConditioning?.(); // apply the chosen noise-suppression level to the new mic track
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
        const recStream = audioEngine.getRecordingStream ? audioEngine.getRecordingStream() : audioEngine.engine.dest.stream;
        audioEngine.recorder = new MediaRecorder(recStream);
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

// Sends the studio mix to a virtual audio cable so call apps can use it as a microphone.
function setupCallOutput() {
  const select = document.getElementById('callOutputSelect');
  const btnStart = document.getElementById('btnCallOutputStart');
  const btnStop = document.getElementById('btnCallOutputStop');
  const btnDetect = document.getElementById('btnCallOutputDetect');
  const slider = document.getElementById('sliderCallVol');
  const lblVol = document.getElementById('lblCallVol');
  const badge = document.getElementById('callOutputStatus');
  const msg = document.getElementById('callOutputMsg');
  if (!select || !btnStart) return;

  const callOutput = new CallOutputManager(audioEngine);
  if (typeof window !== 'undefined') window.callOutput = callOutput;

  const say = (text, isError = false) => {
    if (!msg) return;
    msg.style.display = text ? 'block' : 'none';
    msg.textContent = text || '';
    msg.style.color = isError ? 'var(--accent-red, #ef4444)' : '';
  };

  callOutput.onStateChange = (state) => {
    const live = state === 'live';
    if (badge) {
      badge.textContent = live ? 'LIVE' : 'OFF';
      badge.classList.toggle('is-live', live);
    }
    btnStart.style.display = live ? 'none' : '';
    if (btnStop) btnStop.style.display = live ? '' : 'none';
    select.disabled = false;
  };

  const populate = async () => {
    try {
      const devices = await callOutput.listOutputDevices();
      const keep = select.value || CallOutputManager.getSavedDevice();
      select.innerHTML = '';
      if (!devices.length) {
        select.innerHTML = '<option value="">No devices found - press Detect</option>';
        return;
      }
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = 'Choose the virtual cable...';
      select.appendChild(placeholder);
      devices.forEach((d) => {
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.textContent = d.isVirtual ? `${d.label}  (virtual cable)` : d.label;
        select.appendChild(opt);
      });
      const saved = devices.find((d) => d.deviceId === keep);
      const cable = devices.find((d) => d.isVirtual && /cable input|blackhole/i.test(d.label)) || devices.find((d) => d.isVirtual);
      select.value = (saved || cable)?.deviceId || '';
      if (!devices.some((d) => d.hasLabel)) say('Press "Detect devices" and allow the microphone once so the browser shows device names.');
      else if (!devices.some((d) => d.isVirtual)) say('No virtual cable found. Install VB-Cable (Windows) or BlackHole (Mac), then press Detect devices.');
      else say('');
    } catch (err) {
      console.warn('[CallOutput] device scan failed:', err);
    }
  };

  btnDetect?.addEventListener('click', async () => {
    try { await callOutput.requestLabels(); } catch (_) { say('Microphone permission is needed once to show device names.', true); }
    await populate();
  });

  btnStart.addEventListener('click', async () => {
    say('');
    try {
      await callOutput.start(select.value, { monitorDeviceId: document.getElementById('speakerSelect')?.value || '' });
      say('Sending to the call. In your call app choose the cable OUTPUT (e.g. "CABLE Output") as the microphone.');
    } catch (err) {
      callOutput.stop();
      say(err?.message || 'Could not start the call output.', true);
    }
  });

  btnStop?.addEventListener('click', () => { callOutput.stop(); say(''); });

  slider?.addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    if (lblVol) lblVol.textContent = `${Math.round(v * 100)}%`;
    callOutput.setVolume(v);
  });

  select.addEventListener('change', async () => {
    if (!callOutput.active) return;
    try {
      await callOutput.changeDevice(select.value, { monitorDeviceId: document.getElementById('speakerSelect')?.value || '' });
    } catch (err) {
      callOutput.stop();
      say(err?.message || 'Could not switch the call output device.', true);
    }
  });

  navigator.mediaDevices?.addEventListener('devicechange', populate);
  if (!CallOutputManager.isSupported()) {
    btnStart.disabled = true;
    say('This browser cannot pick an output device. Use Chrome or Edge on desktop.', true);
  }
  populate();
}

// Custom voice builder: sliders -> AudioEngine.applyCustomVoice.
function setupCustomVoice() {
  const box = document.getElementById('customVoiceBox');
  if (!box) return null;
  const KEY = 'nirmal_custom_voice';
  const $ = (id) => document.getElementById(id);
  const sl = { pitch: $('cvPitch'), tone: $('cvTone'), grit: $('cvGrit'), bright: $('cvBright'), echo: $('cvEcho') };
  const tile = box.querySelector('.preset-btn[data-preset="custom"]');

  const values = () => ({
    semitones: parseFloat(sl.pitch.value), tone: parseFloat(sl.tone.value), grit: parseFloat(sl.grit.value),
    highCut: parseFloat(sl.bright.value), echo: parseFloat(sl.echo.value)
  });
  const labels = () => {
    const v = values();
    $('valCvPitch').textContent = `${v.semitones > 0 ? '+' : ''}${v.semitones} st`;
    $('valCvTone').textContent = `${v.tone > 0 ? '+' : ''}${v.tone} dB`;
    $('valCvGrit').textContent = `${Math.round(v.grit)}%`;
    $('valCvBright').textContent = `${(v.highCut / 1000).toFixed(v.highCut % 1000 ? 1 : 0)} kHz`;
    $('valCvEcho').textContent = `${Math.round(v.echo)}%`;
  };
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(values())); } catch (_) {} };

  const onChange = async (e) => {
    labels();
    save();
    if (window.__nirmalResetting) return; // Reset all restores the sliders without (re)activating the custom voice
    const isCustom = audioEngine.currentPreset === 'custom';
    // A person moving a slider switches to the custom voice; programmatic resets (Reset all) do not.
    if (!isCustom && !(e && e.isTrusted)) return;
    try { await audioEngine.boot(); } catch (_) {}
    audioEngine.applyCustomVoice(values());
    document.querySelectorAll('.preset-btn').forEach((b) => b.classList.toggle('active', b === tile));
  };
  Object.values(sl).forEach((el) => el.addEventListener('input', onChange));
  // The generic preset-button handler applies the stored custom preset; rebuild it from the sliders first.
  tile?.addEventListener('click', async () => {
    try { await audioEngine.boot(); } catch (_) {}
    audioEngine.applyCustomVoice(values());
  });
  labels();

  // Restore the last custom voice after the Reset-all snapshot (see initApp)
  return () => {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (_) {}
    if (!saved) return;
    const map = { pitch: saved.semitones, tone: saved.tone, grit: saved.grit, bright: saved.highCut, echo: saved.echo };
    for (const [k, v] of Object.entries(map)) if (Number.isFinite(v)) sl[k].value = String(v);
    labels();
  };
}

// Mic boost, noise suppression strength and live level meters (Mixer tab).
function setupMicTools() {
  const card = document.getElementById('micToolsCard');
  const slider = document.getElementById('sliderMicBoost');
  const seg = document.getElementById('nsSeg');
  if (!card || !slider || !seg) return;

  const KEY = 'nirmal_mic_tools';
  const lblBoost = document.getElementById('valMicBoost');
  const lblNs = document.getElementById('valNs');
  const help = document.getElementById('nsHelp');
  const NS_NAMES = ['Off', 'Low', 'Medium', 'High'];
  const NS_HELP = [
    'No processing: your raw microphone.',
    'Browser noise suppression plus a gentle rumble filter (60 Hz). Best for quiet rooms.',
    'Adds a noise gate that closes between words and a stronger rumble filter. Good for fans and keyboards.',
    'Strongest: tighter gate and a higher rumble cut. Use if your room is noisy; very quiet singing may be cut.'
  ];
  // Gate thresholds (dB) forced by Medium / High
  const NS_GATE_DB = { 2: -52, 3: -42 };

  const gateToggle = document.getElementById('gateToggle');
  const gateSlider = document.getElementById('sliderGate');
  let savedGate = null; // the user's own gate settings, restored when leaving Medium/High

  const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true }));

  const applyGateForLevel = (level) => {
    if (!gateToggle || !gateSlider) return;
    if (level >= 2) {
      if (!savedGate) savedGate = { on: gateToggle.checked, value: gateSlider.value };
      gateToggle.checked = true;
      gateSlider.value = String(NS_GATE_DB[level]);
      fire(gateSlider, 'input');
      fire(gateToggle, 'change');
    } else if (savedGate) {
      gateToggle.checked = savedGate.on;
      gateSlider.value = savedGate.value;
      fire(gateSlider, 'input');
      fire(gateToggle, 'change');
      savedGate = null;
    }
  };

  const setLevel = (level, { persist = true } = {}) => {
    level = Math.max(0, Math.min(3, level));
    seg.querySelectorAll('button').forEach((b) => b.classList.toggle('active', Number(b.dataset.ns) === level));
    if (lblNs) lblNs.textContent = NS_NAMES[level];
    if (help) help.textContent = NS_HELP[level];
    applyGateForLevel(level);
    audioEngine.setNoiseSuppression(level);
    if (persist) save();
  };

  const setBoost = (db, { persist = true } = {}) => {
    db = Math.max(0, Math.min(24, db));
    slider.value = String(db);
    if (lblBoost) lblBoost.textContent = `+${db} dB`;
    audioEngine.setMicBoostDb(db);
    if (persist) save();
  };

  const save = () => {
    try { localStorage.setItem(KEY, JSON.stringify({ boost: Number(slider.value), ns: audioEngine._nsLevel ?? 1 })); } catch (_) {}
  };

  // Defaults first (no boost, Low suppression): this is the "start-up state" that Reset all snapshots.
  setBoost(0, { persist: false });
  setLevel(1, { persist: false });

  // Last used settings are restored afterwards (see initApp) so they never become the Reset baseline.
  const restore = () => {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (_) {}
    if (Number.isFinite(saved.boost) && saved.boost !== 0) setBoost(saved.boost, { persist: false });
    if (Number.isFinite(saved.ns) && saved.ns !== 1) setLevel(saved.ns, { persist: false });
  };

  slider.addEventListener('input', (e) => setBoost(parseInt(e.target.value, 10) || 0));
  seg.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-ns]');
    if (btn) setLevel(Number(btn.dataset.ns));
  });

  // ── level meters ──────────────────────────────────────────────────────────────────────────────
  const meterIn = document.getElementById('meterIn');
  const meterOut = document.getElementById('meterOut');
  const dbIn = document.getElementById('dbIn');
  const dbOut = document.getElementById('dbOut');
  const bufIn = new Float32Array(256);
  const bufOut = new Float32Array(512);
  let visible = false;
  try {
    new IntersectionObserver((entries) => { for (const en of entries) visible = en.isIntersecting; }).observe(card);
  } catch (_) { visible = true; }

  const level = (an, buf) => {
    an.getFloatTimeDomainData(buf);
    let peak = 0;
    for (let i = 0; i < buf.length; i++) { const a = Math.abs(buf[i]); if (a > peak) peak = a; }
    return 20 * Math.log10(Math.max(peak, 1e-5));
  };
  const toFill = (db) => Math.max(0, Math.min(1, (db + 60) / 60));
  let shownIn = 0;
  let shownOut = 0;
  let lastDraw = 0;
  let lastText = 0;

  const loop = (ts) => {
    requestAnimationFrame(loop);
    if (!visible || document.hidden || ts - lastDraw < 40) return; // ~25 fps, only while the card is on screen
    lastDraw = ts;
    const e = audioEngine.engine;
    let inDb = -60;
    let outDb = -60;
    try {
      if (e?.micAnalyser && audioEngine.activeMicStream?.active) inDb = level(e.micAnalyser, bufIn);
      if (e?.analyser) outDb = level(e.analyser, bufOut);
    } catch (_) {}
    // fast attack, slow release
    shownIn = Math.max(toFill(inDb), shownIn * 0.86);
    shownOut = Math.max(toFill(outDb), shownOut * 0.86);
    if (meterIn) meterIn.style.clipPath = `inset(0 ${(100 - shownIn * 100).toFixed(1)}% 0 0)`;
    if (meterOut) meterOut.style.clipPath = `inset(0 ${(100 - shownOut * 100).toFixed(1)}% 0 0)`;
    if (ts - lastText > 250) {
      lastText = ts;
      if (dbIn) dbIn.textContent = inDb <= -59 ? '-∞ dB' : `${inDb.toFixed(0)} dB`;
      if (dbOut) dbOut.textContent = outDb <= -59 ? '-∞ dB' : `${outDb.toFixed(0)} dB`;
    }
  };
  requestAnimationFrame(loop);

  window.setNoiseLevel = (l) => setLevel(l);
  return restore;
}

// "Reset all": puts every sound / effect / Auto-Tune control back to its start-up state.
// Mic, music playback and the live stream keep running; only settings are reset.
function setupResetAllSettings() {
  const SCOPE = ['#mixer', '#proVocalRack', '#karaokeToolsCard', '#trackToolsCard', '#studioFxCard',
    '#effects', '#artistSuiteCard', '#recording', '#lyrics', '#soundboardCard', '#micToolsCard'];
  // Hardware choices, not settings: keep the user's selected devices.
  const KEEP = new Set(['speakerSelect', 'callOutputSelect']);
  // Their change handlers overwrite other sliders, so restore the value without firing them.
  const SILENT = new Set(['atPresetSelect', 'proVocalPreset']);

  const controls = [...new Set(SCOPE.flatMap((sel) =>
    [...document.querySelectorAll(`${sel} input[type=range], ${sel} input[type=checkbox], ${sel} input[type=radio], ${sel} select`)]))]
    .filter((el) => el.id && !KEEP.has(el.id));

  // Snapshot taken at start-up (end of initApp) = the "normal" state.
  const snapshot = new Map(controls.map((el) => [el, { value: el.value, checked: el.checked }]));
  const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true }));

  const resetAll = async () => {
    if (!window.confirm('Reset all sound, voice-effect and Auto-Tune settings to their start-up defaults? Your mic, music and live stream keep running.')) return;

    try { await audioEngine.boot(); } catch (_) {}
    window.__nirmalResetting = true;

    // 1. Restore dropdowns whose handlers would otherwise rewrite other controls.
    for (const el of controls) if (SILENT.has(el.id)) el.value = snapshot.get(el).value;

    // 2. Voice effect back to Bypass, track key and lyric sync back to zero.
    document.querySelector('.preset-btn[data-preset="normal"]')?.click();
    window.setNoiseLevel?.(1); // noise suppression back to its default (Low); also restores the user's gate settings
    document.getElementById('btnKeyReset')?.click();
    document.getElementById('btnSyncReset')?.click();

    // 3. Every other control: restore the start-up value and fire its normal event so the
    //    audio engine and the labels update exactly as if the user had set it by hand.
    for (const el of controls) {
      if (SILENT.has(el.id)) continue;
      const s = snapshot.get(el);
      if (el.type === 'radio') {
        el.checked = s.checked;
        if (s.checked) fire(el, 'change'); // only the default option; firing the others would select them
      } else if (el.type === 'checkbox') {
        el.checked = s.checked;
        fire(el, 'change');
      } else {
        el.value = s.value;
        fire(el, el.type === 'range' ? 'input' : 'change');
        if (el.type === 'range') fire(el, 'change');
      }
    }

    // 4. Push the final state to the engine in one go (handlers above ran in DOM order).
    try { audioEngine.updateAutoTuneSettings?.(); } catch (_) {}
    try { audioEngine.updateProVocalSettings?.(); } catch (_) {}
    try { audioEngine.updateMonitorRouting?.(); } catch (_) {}
    try { audioEngine.applyPreset?.('normal'); } catch (_) {}

    // The voice-effect click above is async; make sure Bypass is the final word and the tile highlight matches.
    document.querySelectorAll('.preset-btn').forEach((b) => b.classList.toggle('active', b.dataset.preset === 'normal'));
    setTimeout(() => { window.__nirmalResetting = false; }, 600);

    document.querySelectorAll('[data-reset-all]').forEach((btn) => {
      const original = btn.dataset.label || (btn.dataset.label = btn.textContent);
      btn.textContent = '✔ Reset done';
      setTimeout(() => { btn.textContent = original; }, 1600);
    });
  };

  document.querySelectorAll('[data-reset-all]').forEach((btn) => btn.addEventListener('click', resetAll));
  if (typeof window !== 'undefined') window.resetAllSettings = resetAll;
}

function initApp() {
  visualizer.init();
  scanHardware();
  setupEventListeners();
  setupLiveShareUI();
  setupCallOutput();
  const restoreMicTools = setupMicTools();
  const restoreCustomVoice = setupCustomVoice();
  const soundboard = new SoundboardManager(audioEngine);
  if (typeof window !== 'undefined') window.soundboard = soundboard;
  soundboard.init().catch((err) => console.warn('[Soundboard] init failed:', err));
  const stats = new StatsManager({ audioEngine, presence, filePlayer: document.getElementById('filePlayer') });
  if (typeof window !== 'undefined') window.stats = stats;
  stats.start();
  setupResetAllSettings();
  restoreMicTools?.(); // after the Reset-all snapshot
  restoreCustomVoice?.();
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}

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

// ─── Developer Diagnostics HUD Controller ────────────────────────────────────
let diagnosticsTimer = null;

async function refreshDiagnosticsHUD() {
  const modal = document.getElementById('diagnosticsModal');
  if (!modal || modal.style.display === 'none') {
    if (diagnosticsTimer) {
      clearInterval(diagnosticsTimer);
      diagnosticsTimer = null;
    }
    return;
  }

  // 1. AudioEngine stats
  const audioStats = audioEngine?.getAudioDiagnostics ? audioEngine.getAudioDiagnostics() : {};
  const setEl = (id, text, color = null) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text ?? '--';
    if (color) el.style.color = color;
  };

  setEl('diagCtxState', audioStats.contextState || 'uninitialized', audioStats.contextState === 'running' ? 'var(--accent-green)' : 'var(--accent-orange)');
  setEl('diagSampleRate', audioStats.sampleRate ? `${audioStats.sampleRate} Hz` : 'N/A');
  setEl('diagBaseLatency', audioStats.baseLatencyMs !== 'N/A' ? `${audioStats.baseLatencyMs} ms` : 'N/A');
  setEl('diagOutputLatency', audioStats.outputLatencyMs !== 'N/A' ? `${audioStats.outputLatencyMs} ms` : 'N/A');
  setEl('diagChannels', audioStats.maxChannels ? `${audioStats.maxChannels} ch (Stereo Discrete)` : '2 ch');
  setEl('diagProgramLevel', audioStats.programOutput ? `${(audioStats.programOutput.levelRms * 100).toFixed(1)}%` : '0%');
  setEl('diagWorklets', audioStats.workletsLoaded ? 'Active (Ultra-low latency)' : 'Fallback GainNodes', audioStats.workletsLoaded ? 'var(--accent-green)' : 'var(--accent-orange)');
  setEl('diagMonitorMode', audioStats.monitorVocalActive ? '🎧 Headphones (Full FX)' : '🔈 Speakers (Vocal Muted to Prevent Feedback)');

  // 2. Mic Hardware stats
  const mic = audioStats.mic || {};
  setEl('diagMicActive', mic.active ? `Active (${mic.label || 'Default'})` : 'Inactive', mic.active ? 'var(--accent-green)' : 'var(--text-dim)');
  setEl('diagMicRate', mic.sampleRate ? `${mic.sampleRate} Hz` : 'N/A');
  setEl('diagMicChannels', mic.channelCount ? `${mic.channelCount} ch (Upmixed to Stereo Center)` : '1 ch');
  setEl('diagMicEcho', mic.echoCancellation ? 'Enabled' : 'Disabled (Pristine Vocal Mode)');
  setEl('diagMicNoise', mic.noiseSuppression ? 'Enabled' : 'Disabled (Pristine Vocal Mode)');
  setEl('diagMicAgc', mic.autoGainControl ? 'Enabled' : 'Disabled (Hardware Dynamics Active)');

  // 3. LiveKit SFU stats
  const lk = liveHost?.getLiveKitDiagnostics ? await liveHost.getLiveKitDiagnostics() : {};
  setEl('diagLkState', lk.state || 'disconnected', lk.state === 'connected' ? 'var(--accent-green)' : 'var(--text-dim)');
  setEl('diagLkRoom', lk.roomId || 'Not active');
  setEl('diagLkAudience', lk.remoteParticipantCount !== undefined ? `${lk.remoteParticipantCount} participants` : '0');
  const pubAudio = lk.publishedTracks?.find(t => t.kind === 'audio');
  setEl('diagLkPubAudio', pubAudio ? `Published • SID: ${pubAudio.sid.slice(-6)} • 2ch forceStereo` : 'None published', pubAudio ? 'var(--accent-green)' : 'var(--text-dim)');
  setEl('diagLkDuets', `${lk.activeGuestAudioCount || 0} active duet streams`);
  setEl('diagLkDuetMonitor', lk.duetMonitorEnabled ? 'ON (Audible to Host)' : 'OFF (Muted)');

  // 4. Recording & Broadcaster stats
  const rec = audioStats.recording || {};
  setEl('diagRecState', rec.active ? 'RECORDING ACTIVE' : 'Idle', rec.active ? 'var(--accent-pink)' : 'var(--text-dim)');
  setEl('diagRecStream', rec.recDestLive ? '2ch MediaStreamDestination Ready (Master + Duets)' : 'Standby');
}

function openDiagnosticsHUD() {
  const modal = document.getElementById('diagnosticsModal');
  if (!modal) return;
  modal.style.display = 'flex';
  refreshDiagnosticsHUD();
  if (!diagnosticsTimer) {
    diagnosticsTimer = setInterval(refreshDiagnosticsHUD, 800);
  }
}

function closeDiagnosticsHUD() {
  const modal = document.getElementById('diagnosticsModal');
  if (modal) modal.style.display = 'none';
  if (diagnosticsTimer) {
    clearInterval(diagnosticsTimer);
    diagnosticsTimer = null;
  }
}

document.getElementById('btnOpenDiagnostics')?.addEventListener('click', openDiagnosticsHUD);
document.getElementById('btnCloseDiagnostics')?.addEventListener('click', closeDiagnosticsHUD);

window.addEventListener('keydown', (e) => {
  if (e.key === 'D' && e.shiftKey && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    const modal = document.getElementById('diagnosticsModal');
    if (modal && modal.style.display === 'flex') {
      closeDiagnosticsHUD();
    } else {
      openDiagnosticsHUD();
    }
  }
});