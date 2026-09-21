/**
 * BGMI / Free Fire Style Duet & Audience Invitation Dialog
 * Plays a game-style audio chime, shows an animated countdown popup, and triggers callback.
 */

let activeOverlay = null;
let activeCountdownTimer = null;
let chimeAudioCtx = null;

function getChimeAudioContext() {
  try {
    if (window.audioEngine?.ctx && window.audioEngine.ctx.state !== 'closed') {
      return window.audioEngine.ctx;
    }
    if (chimeAudioCtx && chimeAudioCtx.state !== 'closed') {
      return chimeAudioCtx;
    }
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;
    chimeAudioCtx = new AudioCtx();
    return chimeAudioCtx;
  } catch (_) {
    return null;
  }
}

// Synthesize a gaming notification chime using Web Audio API
function playGamingInviteChime() {
  try {
    const ctx = getChimeAudioContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
    const t = ctx.currentTime;

    const playTone = (freq, start, duration, gainVal = 0.2) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, start);
      
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(gainVal, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(start);
      osc.stop(start + duration);
    };

    // Battle royale lobby dual-tone notification chord
    playTone(523.25, t, 0.22, 0.25);        // C5
    playTone(659.25, t + 0.08, 0.25, 0.28); // E5
    playTone(783.99, t + 0.16, 0.28, 0.32); // G5
    playTone(1046.50, t + 0.24, 0.45, 0.35);// C6 triumph finish
  } catch (err) {
    console.warn('[GameInvite] audio chime skipped:', err);
  }
}

/**
 * Display a BGMI / Free Fire style invite popup
 * @param {Object} invite - { id, fromUser: { id, name, avatar, roomId, roomName }, expiresAt }
 * @param {Function} onAccept - callback when accepted
 * @param {Function} onDecline - callback when declined
 */
export function showGameInviteDialog(invite, onAccept, onDecline) {
  // If an invite is already showing, remove it first
  dismissGameInviteDialog(false);

  playGamingInviteChime();

  const totalSeconds = Math.max(5, Math.min(20, Math.round((invite.expiresAt - Date.now()) / 1000))) || 15;
  let remainingSeconds = totalSeconds;

  const overlay = document.createElement('div');
  overlay.className = 'game-invite-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');

  const inviterName = invite.fromUser?.name || 'Singer';
  const inviterAvatar = invite.fromUser?.avatar || '🎤';
  const roomName = invite.fromUser?.roomName || invite.roomName || 'Live Karaoke Stage';
  const inviteType = invite.fromUser?.type === 'duet' ? '⚔️ DUET SQUAD INVITE' : '📡 AUDIENCE INVITE';

  overlay.innerHTML = `
    <div class="game-invite-card">
      <div class="game-invite-header">
        <span class="game-invite-badge">${inviteType}</span>
        <span class="game-invite-timer-text" id="gameInviteTimer">${remainingSeconds}s</span>
      </div>
      <div class="game-invite-body">
        <div class="game-invite-avatar-wrap">
          <div class="game-invite-avatar-ring"></div>
          <div class="game-invite-avatar">${inviterAvatar}</div>
        </div>
        <div class="game-invite-info">
          <div class="game-invite-inviter">
            <span>${escapeHtml(inviterName)}</span>
          </div>
          <div class="game-invite-status">wants to sing & talk a duet with you!</div>
          <div class="game-invite-room-tag">Room: ${escapeHtml(roomName)}</div>
        </div>
      </div>
      <div class="game-invite-progress-track">
        <div class="game-invite-progress-bar" id="gameInviteProgressBar" style="width: 100%;"></div>
      </div>
      <div class="game-invite-actions">
        <button class="btn-game-decline" id="btnGameDecline">✕ Decline</button>
        <button class="btn-game-accept" id="btnGameAccept">✓ Accept & Sing</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  activeOverlay = overlay;

  const progressBar = overlay.querySelector('#gameInviteProgressBar');
  const timerText = overlay.querySelector('#gameInviteTimer');
  const btnAccept = overlay.querySelector('#btnGameAccept');
  const btnDecline = overlay.querySelector('#btnGameDecline');

  const handleDecline = () => {
    dismissGameInviteDialog(true);
    if (typeof onDecline === 'function') onDecline(invite);
  };

  const handleAccept = () => {
    dismissGameInviteDialog(true);
    if (typeof onAccept === 'function') onAccept(invite);
  };

  btnDecline.addEventListener('click', handleDecline);
  btnAccept.addEventListener('click', handleAccept);

  // Countdown timer
  activeCountdownTimer = setInterval(() => {
    remainingSeconds--;
    if (timerText) timerText.textContent = `${remainingSeconds}s`;
    if (progressBar) {
      const pct = Math.max(0, (remainingSeconds / totalSeconds) * 100);
      progressBar.style.width = `${pct}%`;
    }

    if (remainingSeconds <= 0) {
      clearInterval(activeCountdownTimer);
      activeCountdownTimer = null;
      handleDecline();
    }
  }, 1000);
}

export function dismissGameInviteDialog(animate = true) {
  if (activeCountdownTimer) {
    clearInterval(activeCountdownTimer);
    activeCountdownTimer = null;
  }
  if (!activeOverlay) return;

  const el = activeOverlay;
  activeOverlay = null;

  if (animate) {
    el.classList.add('slide-out');
    setTimeout(() => {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 350);
  } else {
    if (el.parentNode) el.parentNode.removeChild(el);
  }
}

function escapeHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
