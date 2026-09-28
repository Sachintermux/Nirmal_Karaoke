/**
 * Presence & Invitation Manager for Nirmal Karaoke
 * Manages user profile, online user directory via SSE & serverless REST polling fallback,
 * and BGMI/Free Fire-style game invitations.
 */

import { showGameInviteDialog } from './game-invite.js?v=24';

const STORAGE_KEY = 'nirmal_singer_profile';

export class PresenceManager {
  constructor() {
    this.user = this.loadOrCreateProfile();
    this.device = window.innerWidth <= 850 ? 'mobile' : 'desktop';
    this.isStudioAdmin = typeof window !== 'undefined' && (!window.location.pathname.includes('audience.html') && !window.location.pathname.includes('users.html'));
    this.currentRole = this.isStudioAdmin ? 'host' : 'idle'; // 'host' | 'audience' | 'idle'
    this.currentRoomId = null;
    this.currentRoomName = null;
    this.isLive = false;

    this.onlineUsers = [];
    this.handledInvites = new Set();
    this.sseSource = null;
    this.heartbeatTimer = null;
    this.pollingTimer = null;
    this.reconnectTimer = null;
    this.sseActive = false;

    this.onUserListUpdated = null;
    this.onInviteReceivedCustom = null;
    this.onInviteResponse = null;

    // 1. Initial immediate user list fetch
    this.fetchUsers().catch(() => {});

    // 2. Initialize real-time signaling
    this.initSSE();
    this.startHeartbeat();
  }

  loadOrCreateProfile() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed?.id && parsed?.name) return parsed;
      }
    } catch (_) {}

    const avatars = ['🎤', '🎧', '🎸', '🎹', '⚡', '👑', '🔥', '🌟', '🎶', '💎'];
    const randomAvatar = avatars[Math.floor(Math.random() * avatars.length)];
    const randomNum = Math.floor(100 + Math.random() * 900);
    const newProfile = {
      id: 'usr_' + Math.random().toString(36).slice(2, 9),
      name: `Singer_${randomNum}`,
      avatar: randomAvatar
    };

    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(newProfile)); } catch (_) {}
    return newProfile;
  }

  updateProfile(name, avatar) {
    if (name) this.user.name = String(name).trim();
    if (avatar) this.user.avatar = String(avatar).trim();
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.user)); } catch (_) {}
    this.pushHeartbeat();
  }

  updateLiveStatus({ role, roomId, roomName, isLive }) {
    if (role !== undefined) this.currentRole = role;
    if (roomId !== undefined) this.currentRoomId = roomId;
    if (roomName !== undefined) this.currentRoomName = roomName;
    if (isLive !== undefined) this.isLive = !!isLive;
    this.pushHeartbeat();
  }

  async fetchUsers() {
    try {
      const r = await fetch('/api/presence/users');
      const data = await r.json().catch(() => ({}));
      if (Array.isArray(data?.users)) {
        this.onlineUsers = data.users;
        if (typeof this.onUserListUpdated === 'function') {
          this.onUserListUpdated(this.onlineUsers);
        }
      }
      return this.onlineUsers;
    } catch (_) {
      return this.onlineUsers;
    }
  }

  initSSE() {
    if (this.sseSource) {
      try { this.sseSource.close(); } catch (_) {}
      this.sseSource = null;
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
      const sse = new EventSource(`/api/presence/stream?${q.toString()}`);
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
          const res = JSON.parse(e.data);
          if (typeof this.onInviteResponse === 'function') {
            this.onInviteResponse(res);
          }
        } catch (err) {
          console.warn('[Presence] invite_response parse error:', err);
        }
      });

      sse.onerror = () => {
        this.sseActive = false;
        try { sse.close(); } catch (_) {}
        this.sseSource = null;
        // On serverless environments (Netlify), activate high-frequency polling fallback
        this.startPollingFallback();
      };
    } catch (_) {
      this.startPollingFallback();
    }
  }

  startPollingFallback() {
    if (this.pollingTimer) return;
    // Fast 3.5s sync loop when SSE is not supported in serverless Netlify
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

  handleIncomingInvite(invite) {
    if (typeof this.onInviteReceivedCustom === 'function') {
      const handled = this.onInviteReceivedCustom(invite);
      if (handled) return;
    }

    const targetRoom = invite.roomId || invite.fromUser?.roomId;

    // 1. Host Broadcast Lock: If host is broadcasting live or on index.html studio, block invitations to leave and join other rooms
    if (this.isStudioAdmin || (this.isLive && this.currentRole === 'host')) {
      if (targetRoom && targetRoom !== this.currentRoomId) {
        console.warn(`[Presence] Host is sovereign in studio stage (${this.currentRoomId || 'active'}); auto-declining external invitation to ${targetRoom}`);
        this.respondInvite(invite.id, false, 'Host is currently broadcasting live');
        return;
      }
    }

    // Default: show authentic BGMI / Free Fire game style invite popup
    showGameInviteDialog(
      invite,
      // onAccept
      async (inv) => {
        await this.respondInvite(inv.id, true);
        const invTargetRoom = inv.roomId || inv.fromUser?.roomId;
        // On studio admin page or while broadcasting, NEVER navigate away to audience.html
        if (this.isStudioAdmin || (this.isLive && this.currentRole === 'host')) {
          console.info('[Presence] Host accepted duet request; admitting guest into active stage:', this.currentRoomId);
          return;
        }
        if (invTargetRoom) {
          if (typeof window !== 'undefined') window.__bypassUnloadWarning = true;
          // If already on audience.html for this exact room, promote in-page smoothly without reload
          if (typeof window !== 'undefined' && window.location.pathname.includes('audience.html') && this.currentRoomId === invTargetRoom) {
            if (typeof window.promoteToDuet === 'function') {
              window.promoteToDuet();
              return;
            }
          }
          const targetUrl = `./audience.html?room=${encodeURIComponent(invTargetRoom)}&role=duet&autoJoin=1`;
          window.location.href = targetUrl;
        }
      },
      // onDecline
      async (inv) => {
        await this.respondInvite(inv.id, false);
      }
    );
  }

  async sendInvite(targetUserId, type = 'duet') {
    try {
      // Ensure there is always a valid room ID so recipient joins the same stage
      if (!this.currentRoomId) {
        this.currentRoomId = 'room_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
        this.currentRoomName = this.user.name ? `${this.user.name}'s Stage` : 'Live Karaoke Stage';
        this.updateLiveStatus({
          role: this.isStudioAdmin ? 'host' : 'duet',
          roomId: this.currentRoomId,
          roomName: this.currentRoomName,
          isLive: true
        });
      }

      const r = await fetch('/api/presence/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fromUser: {
            id: this.user.id,
            name: this.user.name,
            avatar: this.user.avatar,
            roomId: this.currentRoomId,
            roomName: this.currentRoomName || (this.isLive ? 'My Live Stage' : 'Karaoke Studio'),
            type
          },
          toUserId: targetUserId,
          roomId: this.currentRoomId,
          roomName: this.currentRoomName,
          type
        })
      });
      const data = await r.json();
      return data;
    } catch (err) {
      console.error('[Presence] sendInvite error:', err);
      throw err;
    }
  }

  async respondInvite(inviteId, accepted, reason = '') {
    try {
      const r = await fetch('/api/presence/respond-invite', {
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

  startHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => this.pushHeartbeat(), 12000);
  }

  async pushHeartbeat() {
    try {
      const res = await fetch('/api/presence/heartbeat', {
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
          for (const resp of data.inviteResponses) {
            if (typeof this.onInviteResponse === 'function') {
              this.onInviteResponse(resp);
            }
          }
        }
      }
    } catch (_) {}
  }
}
