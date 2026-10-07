/**
 * Presence & Invitation Manager for Nirmal Karaoke
 * Manages user profile, online user directory via SSE & REST polling fallback,
 * and BGMI/Free Fire-style game invitations.
 *
 * Where presence state lives
 * --------------------------
 * Netlify functions are stateless: every call can land on a different instance, so users and
 * invites kept in a function's memory randomly disappear. The always-on backend (Render,
 * server.js) holds presence in one process and pushes events over SSE, so that is used as the
 * primary API when the site is served from Netlify. The same-origin /api/presence function is
 * kept only as a fallback if the primary cannot be reached.
 */

import { showGameInviteDialog, dismissGameInviteDialog } from './game-invite.js?v=24';

const STORAGE_KEY = 'nirmal_singer_profile';
const SHARED_STATE_KEY = 'nirmal_presence_state';
const DEFAULT_PRESENCE_ORIGIN = 'https://nirmal-karaoke.onrender.com';
const SHARED_STATE_MAX_AGE_MS = 30000;
const DEFAULT_NAME_RE = /^Singer_\d+$/;

function isLocalHost(host) {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost') ||
    host.endsWith('.onrender.com') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

// Ordered list of API origins to try ('' = same origin).
function resolveApiOrigins() {
  const host = typeof location !== 'undefined' ? location.hostname : '';
  if (!host || isLocalHost(host)) return [''];
  let primary = DEFAULT_PRESENCE_ORIGIN;
  try {
    const saved = (localStorage.getItem('nirmal_stream_relay_url') || '').trim();
    if (/^https?:\/\//i.test(saved)) primary = saved.replace(/\/+$/, '');
  } catch (_) {}
  return [primary, ''];
}

export class PresenceManager {
  constructor() {
    this.user = this.loadOrCreateProfile();
    this.device = window.innerWidth <= 850 ? 'mobile' : 'desktop';
    this.isStudioAdmin = typeof window !== 'undefined' && (!window.location.pathname.includes('audience.html') && !window.location.pathname.includes('users.html'));
    this.currentRole = this.isStudioAdmin ? 'host' : 'idle'; // 'host' | 'audience' | 'duet' | 'idle'
    this.currentRoomId = null;
    this.currentRoomName = null;
    this.isLive = false;

    this.apiOrigins = resolveApiOrigins();
    this.originIdx = 0;
    this.originPinnedAt = 0;

    this.onlineUsers = [];
    this.handledInvites = new Set();
    this.handledResponses = new Set();
    this.sseSource = null;
    this.heartbeatTimer = null;
    this.pollingTimer = null;
    this.reconnectTimer = null;
    this.sseActive = false;

    this.onUserListUpdated = null;
    this.onInviteReceivedCustom = null;
    this.onInviteResponse = null;

    this.restoreSharedState();

    // 1. Initial immediate user list fetch
    this.fetchUsers().catch((err) => console.warn('[Presence] initial fetchUsers failed:', err));

    // 2. Initialize real-time signaling
    this.initSSE();
    this.startHeartbeat();
  }

  // ── API access with fallback ──────────────────────────────────────────────
  get apiOrigin() {
    return this.apiOrigins[this.originIdx] ?? '';
  }

  async api(path, init = {}) {
    // Retry the preferred origin every minute after having fallen back.
    if (this.originIdx > 0 && Date.now() - this.originPinnedAt > 60000) this.originIdx = 0;

    let lastErr = null;
    for (let i = 0; i < this.apiOrigins.length; i++) {
      const idx = (this.originIdx + i) % this.apiOrigins.length;
      const origin = this.apiOrigins[idx];
      try {
        const res = await fetch(`${origin}${path}`, { cache: 'no-store', ...init });
        // 5xx / gateway errors mean this backend is unhealthy; 4xx are real answers.
        if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
        if (idx !== this.originIdx) {
          this.originIdx = idx;
          this.originPinnedAt = Date.now();
          if (this.sseSource) this.initSSE();
        }
        return res;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error('Presence API unreachable');
  }

  // ── Profile ────────────────────────────────────────────────────────────────
  loadOrCreateProfile() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed?.id && parsed?.name) {
          // Profiles saved before the 'named' flag existed count as named if the name was customised.
          if (parsed.named === undefined) parsed.named = !DEFAULT_NAME_RE.test(parsed.name);
          return parsed;
        }
      }
    } catch (e) {
      console.warn('[Presence] Failed to parse profile from localStorage:', e);
    }

    const avatars = ['🎤', '🎧', '🎸', '🎹', '⚡', '👑', '🔥', '🌟', '🎶', '💎'];
    const randomAvatar = avatars[Math.floor(Math.random() * avatars.length)];
    const randomNum = Math.floor(100 + Math.random() * 900);
    const newProfile = {
      id: 'usr_' + Math.random().toString(36).slice(2, 9),
      name: `Singer_${randomNum}`,
      avatar: randomAvatar,
      named: false
    };

    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(newProfile)); } catch (e) {
      console.warn('[Presence] Failed to save new profile to localStorage:', e);
    }
    return newProfile;
  }

  getUser() {
    return this.user;
  }

  /** True once the person has chosen their own name (so we do not ask again). */
  hasChosenName() {
    return !!this.user.named && !!String(this.user.name || '').trim();
  }

  updateProfile(name, avatar) {
    if (name) {
      this.user.name = String(name).trim();
      this.user.named = true;
    }
    if (avatar) this.user.avatar = String(avatar).trim();
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.user)); } catch (e) {
      console.warn('[Presence] Failed to update profile in localStorage:', e);
    }
    this.pushHeartbeat();
  }

  // ── Live state shared between this person's tabs/pages ────────────────────
  // Every page (studio, users, audience) heartbeats the same user id. A page that does not know
  // the person is live (e.g. users.html opened in a second tab) would overwrite the live record
  // with "idle", which made the person's own stage show up as someone else to invite.
  restoreSharedState() {
    if (this.isStudioAdmin) {
      // A fresh studio page never inherits "live": its LiveKit room died with the old page.
      this.clearSharedState();
      return;
    }
    try {
      const s = JSON.parse(localStorage.getItem(SHARED_STATE_KEY) || 'null');
      if (s && s.userId === this.user.id && s.isLive && s.roomId && Date.now() - s.t < SHARED_STATE_MAX_AGE_MS) {
        this.currentRole = s.role || 'host';
        this.currentRoomId = s.roomId;
        this.currentRoomName = s.roomName || null;
        this.isLive = true;
      }
    } catch (_) {}
  }

  saveSharedState() {
    // Only the pages that own the live session publish it.
    if (!this.isStudioAdmin) return;
    try {
      if (this.isLive && this.currentRoomId) {
        localStorage.setItem(SHARED_STATE_KEY, JSON.stringify({
          userId: this.user.id, role: this.currentRole, roomId: this.currentRoomId,
          roomName: this.currentRoomName, isLive: true, t: Date.now()
        }));
      } else {
        localStorage.removeItem(SHARED_STATE_KEY);
      }
    } catch (_) {}
  }

  clearSharedState() {
    try { localStorage.removeItem(SHARED_STATE_KEY); } catch (_) {}
  }

  updateLiveStatus({ role, roomId, roomName, isLive }) {
    if (role !== undefined) this.currentRole = role;
    if (roomId !== undefined) this.currentRoomId = roomId;
    if (roomName !== undefined) this.currentRoomName = roomName;
    if (isLive !== undefined) this.isLive = !!isLive;
    this.saveSharedState();
    this.pushHeartbeat();
  }

  /** Alias used by audience.html. */
  updateStatus(patch = {}) {
    this.updateLiveStatus(patch);
  }

  /** True while this person is hosting a real, connected live stage. */
  isHostingLive() {
    return !!(this.isLive && this.currentRole === 'host' && this.currentRoomId);
  }

  // ── Directory ──────────────────────────────────────────────────────────────
  async fetchUsers() {
    try {
      const r = await this.api('/api/presence/users');
      const data = await r.json().catch(() => ({}));
      if (Array.isArray(data?.users)) {
        this.onlineUsers = data.users;
        if (typeof this.onUserListUpdated === 'function') {
          this.onUserListUpdated(this.onlineUsers);
        }
      }
      return this.onlineUsers;
    } catch (err) {
      console.warn('[Presence] fetchUsers failed:', err);
      return this.onlineUsers;
    }
  }

  initSSE() {
    if (this.sseSource) {
      try { this.sseSource.close(); } catch (_) {}
      this.sseSource = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const q = new URLSearchParams({
      userId: this.user.id,
      name: this.user.name,
      avatar: this.user.avatar,
      role: this.currentRole,
      roomId: this.currentRoomId || '',
      roomName: this.currentRoomName || '',
      isLive: this.isLive ? '1' : '0',
      device: this.device
    });

    try {
      const sse = new EventSource(`${this.apiOrigin}/api/presence/stream?${q.toString()}`);
      this.sseSource = sse;

      sse.onopen = () => {
        this.sseActive = true;
        this.stopPollingFallback();
      };

      sse.addEventListener('user_list', (e) => {
        try {
          const list = JSON.parse(e.data);
          if (Array.isArray(list)) {
            this.onlineUsers = list;
            if (typeof this.onUserListUpdated === 'function') {
              this.onUserListUpdated(this.onlineUsers);
            }
          }
        } catch (err) {
          console.warn('[Presence] user_list parse error:', err);
        }
      });

      sse.addEventListener('invite_received', (e) => {
        try {
          const invite = JSON.parse(e.data);
          if (!this.handledInvites.has(invite.id)) {
            this.handledInvites.add(invite.id);
            this.handleIncomingInvite(invite);
          }
        } catch (err) {
          console.warn('[Presence] invite_received parse error:', err);
        }
      });

      sse.addEventListener('invite_response', (e) => {
        try {
          this.deliverInviteResponse(JSON.parse(e.data));
        } catch (err) {
          console.warn('[Presence] invite_response parse error:', err);
        }
      });

      // The sender gave up or the invite timed out: close the popup so nobody accepts a dead invite.
      sse.addEventListener('invite_expired', () => {
        try { dismissGameInviteDialog(true); } catch (_) {}
      });

      sse.onerror = () => {
        this.sseActive = false;
        try { sse.close(); } catch (_) {}
        this.sseSource = null;
        // Keep invites flowing through polling, and try to bring the live stream back.
        this.startPollingFallback();
        if (!this.reconnectTimer) {
          this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (!this.sseActive) this.initSSE();
          }, 8000);
        }
      };
    } catch (e) {
      console.warn('[Presence] EventSource initialization failed, starting polling fallback:', e);
      this.startPollingFallback();
    }
  }

  startPollingFallback() {
    if (this.pollingTimer) return;
    // Fast sync loop while the live stream is down so invites still arrive within seconds.
    this.pollingTimer = setInterval(() => {
      this.pushHeartbeat();
    }, 3500);
    this.pushHeartbeat();
  }

  stopPollingFallback() {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }
  }

  // ── Invitations ────────────────────────────────────────────────────────────
  handleIncomingInvite(invite) {
    // Never show a person their own invitation.
    if (invite?.fromUser?.id && invite.fromUser.id === this.user.id) return;

    if (typeof this.onInviteReceivedCustom === 'function') {
      const handled = this.onInviteReceivedCustom(invite);
      if (handled) return;
    }

    const targetRoom = invite.roomId || invite.fromUser?.roomId;
    const amLiveHost = this.isHostingLive();

    // Someone who is actively broadcasting their own stage cannot leave it for another room.
    // (Merely having the studio page open does NOT count: an idle studio user can accept.)
    if (amLiveHost && targetRoom && targetRoom !== this.currentRoomId) {
      console.warn(`[Presence] Host is live in ${this.currentRoomId}; declining invitation to ${targetRoom}`);
      this.respondInvite(invite.id, false, 'Host is currently broadcasting live');
      return;
    }

    showGameInviteDialog(
      invite,
      // onAccept
      async (inv) => {
        await this.respondInvite(inv.id, true);
        const invTargetRoom = inv.roomId || inv.fromUser?.roomId;
        if (!invTargetRoom || amLiveHost) return; // live hosts stay on their own stage

        if (typeof window !== 'undefined') window.__bypassUnloadWarning = true;
        // Already on this room's audience page: promote in place without reloading.
        if (window.location.pathname.includes('audience.html') && this.currentRoomId === invTargetRoom) {
          if (typeof window.promoteToDuet === 'function') {
            window.promoteToDuet(true);
            return;
          }
        }
        // Everyone else (studio, users page, another audience room) joins the inviter's stage.
        window.location.href = `./audience.html?room=${encodeURIComponent(invTargetRoom)}&role=duet&autoJoin=1`;
      },
      // onDecline
      async (inv) => {
        await this.respondInvite(inv.id, false);
      }
    );
  }

  /**
   * Invite someone to THIS person's live stage. The caller must already be live: an invite to a
   * stage that does not exist would drop the guest into an empty room.
   */
  async sendInvite(targetUserId, type = 'duet') {
    if (targetUserId === this.user.id) throw new Error('You cannot invite yourself.');
    if (!this.isHostingLive()) {
      throw new Error('Go live first, then invite singers to your stage.');
    }

    const r = await this.api('/api/presence/invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fromUser: {
          id: this.user.id,
          name: this.user.name,
          avatar: this.user.avatar,
          roomId: this.currentRoomId,
          roomName: this.currentRoomName || 'My Live Stage',
          type
        },
        toUserId: targetUserId,
        roomId: this.currentRoomId,
        roomName: this.currentRoomName,
        type
      })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data?.ok === false) {
      throw new Error(data?.error || 'Could not send the invite.');
    }
    return data;
  }

  async respondInvite(inviteId, accepted, reason = '') {
    try {
      const r = await this.api('/api/presence/respond-invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inviteId,
          responderId: this.user.id,
          accepted: !!accepted,
          reason
        })
      });
      return await r.json();
    } catch (err) {
      console.error('[Presence] respondInvite error:', err);
      return { ok: false };
    }
  }

  // A response reaches us over SSE and again in the next poll reply; handle each only once.
  deliverInviteResponse(res) {
    if (!res) return;
    const key = `${res.inviteId || ''}:${res.status || (res.accepted ? 'accepted' : 'declined')}`;
    if (this.handledResponses.has(key)) return;
    this.handledResponses.add(key);
    if (typeof this.onInviteResponse === 'function') this.onInviteResponse(res);
  }

  startHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => this.pushHeartbeat(), 12000);
  }

  async pushHeartbeat() {
    this.saveSharedState(); // keeps the shared "I am live" record fresh for my other pages
    try {
      const res = await this.api('/api/presence/heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: this.user.id,
          name: this.user.name,
          avatar: this.user.avatar,
          role: this.currentRole,
          roomId: this.currentRoomId,
          roomName: this.currentRoomName,
          isLive: this.isLive,
          device: this.device
        })
      });

      const data = await res.json().catch(() => ({}));
      if (data?.ok) {
        // 1. Sync updated user list
        if (Array.isArray(data.users)) {
          this.onlineUsers = data.users;
          if (typeof this.onUserListUpdated === 'function') {
            this.onUserListUpdated(this.onlineUsers);
          }
        }

        // 2. Process incoming invites in polling mode
        if (Array.isArray(data.pendingInvites)) {
          for (const inv of data.pendingInvites) {
            if (!this.handledInvites.has(inv.id)) {
              this.handledInvites.add(inv.id);
              this.handleIncomingInvite(inv);
            }
          }
        }

        // 3. Process invite responses in polling mode
        if (Array.isArray(data.inviteResponses)) {
          for (const resp of data.inviteResponses) this.deliverInviteResponse(resp);
        }
      }
    } catch (err) {
      console.warn('[Presence] Polling cycle request failed:', err);
    }
  }
}
