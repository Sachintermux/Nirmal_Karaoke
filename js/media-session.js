/**
 * MediaSession & Silent Audio Background Keep-Alive Engine
 * Keeps mobile browsers (iOS Safari & Android Chrome) active in the background
 * by maintaining an OS-recognized audio session and lock-screen controls.
 */

// Minimal 1-second 8kHz silent WAV file encoded as base64
const SILENT_WAV_BASE64 = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
let silentAudioEl = null;

// The silent <audio> trick only matters on phones/tablets, where the OS suspends a
// backgrounded tab unless an audio session is playing. On desktop the live mic,
// WebRTC and the 48 kHz WebAudio output already exempt the tab from throttling, and
// this extra 8 kHz output stream next to the audio engine causes mixer contention that
// shows up as lag when singing with the mic alone (nothing else playing).
const IS_MOBILE_DEVICE = typeof navigator !== 'undefined' &&
  /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

export function startBackgroundAudioKeepAlive() {
  if (typeof document === 'undefined' || !IS_MOBILE_DEVICE) return;
  try {
    if (!silentAudioEl) {
      silentAudioEl = document.createElement('audio');
      silentAudioEl.id = 'nirmal_bg_audio_keepalive';
      silentAudioEl.src = SILENT_WAV_BASE64;
      silentAudioEl.loop = true;
      silentAudioEl.setAttribute('playsinline', '');
      silentAudioEl.setAttribute('webkit-playsinline', '');
      silentAudioEl.style.display = 'none';
      silentAudioEl.volume = 0.01;
      document.body.appendChild(silentAudioEl);
    }
    const p = silentAudioEl.play();
    if (p && typeof p.catch === 'function') {
      p.catch(() => {});
    }
    console.info('[MediaSession] Background audio keep-alive activated.');
  } catch (err) {
    console.warn('[MediaSession] Audio keep-alive notice:', err?.message || err);
  }
}

export function stopBackgroundAudioKeepAlive() {
  if (silentAudioEl) {
    try {
      silentAudioEl.pause();
      silentAudioEl.removeAttribute('src');
      if (silentAudioEl.parentElement) silentAudioEl.parentElement.removeChild(silentAudioEl);
    } catch (_) {}
    silentAudioEl = null;
    console.info('[MediaSession] Background audio keep-alive stopped.');
  }
}

export function updateMediaSession({ title, artist, album, onPlay, onPause } = {}) {
  if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: title || 'Nirmal Live Stage',
        artist: artist || 'Live Karaoke Studio',
        album: album || 'Nirmal Karaoke Live',
        artwork: [
          { src: './icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: './icon-512.png', sizes: '512x512', type: 'image/png' }
        ]
      });
      if (typeof onPlay === 'function') {
        navigator.mediaSession.setActionHandler('play', onPlay);
      }
      if (typeof onPause === 'function') {
        navigator.mediaSession.setActionHandler('pause', onPause);
      }
    } catch (_) {}
  }
}
