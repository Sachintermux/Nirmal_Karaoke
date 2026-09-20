const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
require('dotenv').config();

const { AccessToken, RoomServiceClient, EgressClient, StreamProtocol } = require('livekit-server-sdk');
const app = express();
const server = http.createServer(app);
const PORT = Number(process.env.PORT || 3000);

// In-memory registry of room statuses: 'active' | 'ended'
const liveRooms = new Map();
const activeStreams = new Map();

app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname)));

function livekitConfigured() {
  return !!(process.env.LIVEKIT_URL && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET);
}

function getRoomServiceClient() {
  if (!livekitConfigured()) return null;
  try {
    const host = livekitApiHost(process.env.LIVEKIT_URL);
    return new RoomServiceClient(host, process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET);
  } catch (err) {
    console.warn('[livekit] failed to init RoomServiceClient:', err?.message || err);
    return null;
  }
}

function getEgressClient() {
  if (!livekitConfigured()) return null;
  try {
    const host = livekitApiHost(process.env.LIVEKIT_URL);
    return new EgressClient(host, process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET);
  } catch (err) {
    console.warn('[livekit] failed to init EgressClient:', err?.message || err);
    return null;
  }
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'nirmal-karaoke-web', transport: 'livekit-sfu', livekitConfigured: livekitConfigured() });
});

app.get('/api/livekit/config', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    enabled: livekitConfigured(),
    url: process.env.LIVEKIT_URL || '',
    mode: 'sfu',
    audio: {
      sampleRate: 48000,
      channels: 2,
      dtx: false,
      red: true,
      priority: 'audio-over-video'
    },
    reason: livekitConfigured() ? '' : 'Set LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET.'
  });
});

app.get('/api/livekit/room-status', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const room = String(req.query.roomName || req.query.room || '').trim();
  if (!room) return res.status(400).json({ error: 'room parameter required' });
  const info = liveRooms.get(room);
  return res.json({
    ok: true,
    room,
    active: info ? info.status === 'active' : false,
    status: info ? info.status : 'not_found'
  });
});

app.post('/api/livekit/end-room', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const room = String(req.body?.roomName || req.body?.room || req.query?.roomName || req.query?.room || '').trim();
    if (!room) return res.status(400).json({ error: 'roomName is required' });

    console.info(`[livekit] Host discontinuing live room: ${room}`);
    liveRooms.set(room, { status: 'ended', endedAt: Date.now() });

    // Kick all participants and delete room from LiveKit SFU
    const svc = getRoomServiceClient();
    if (svc) {
      try {
        await svc.deleteRoom(room);
        console.info(`[livekit] Room ${room} deleted on LiveKit SFU.`);
      } catch (svcErr) {
        console.warn(`[livekit] SFU deleteRoom notice for ${room}:`, svcErr?.message || svcErr);
      }
    }

    return res.json({ ok: true, room, status: 'ended' });
  } catch (err) {
    console.error('[livekit-end-room]', err);
    return res.status(500).json({ error: err?.message || 'Unable to end live room' });
  }
});

function issueLiveKitToken(req, res) {
  return (async () => {
    try {
      if (!livekitConfigured()) {
        return res.status(503).json({ error: 'LiveKit is not configured. Set LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET.' });
      }
      const src = req.method === 'POST' ? (req.body || {}) : (req.query || {});
      const room = String(src.roomName || src.room || '').trim();
      const identity = String(src.identity || '').trim();
      const role = String(src.role || 'audience').trim();
      if (!room || !identity) return res.status(400).json({ error: 'room and identity are required' });
      if (!['host', 'duet', 'audience'].includes(role)) return res.status(400).json({ error: 'Invalid role' });

      // Check if room is discontinued or inactive for non-hosts
      if (role !== 'host') {
        const roomInfo = liveRooms.get(room);
        if (roomInfo && roomInfo.status === 'ended') {
          return res.status(410).json({
            error: 'This live broadcast has ended or is discontinued by the host.',
            roomEnded: true,
            discontinued: true,
            room
          });
        }
      } else {
        // Register or mark room as active
        liveRooms.set(room, {
          status: 'active',
          hostIdentity: identity,
          startedAt: Date.now(),
          endedAt: null
        });
      }

      const token = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, {
        identity,
        name: identity,
        ttl: '24h'
      });
      token.addGrant({
        roomJoin: true,
        room,
        canSubscribe: true,
        canPublish: true,
        canPublishData: true,
        canUpdateOwnMetadata: true
      });
      res.set('Cache-Control', 'no-store');
      return res.json({ token: await token.toJwt(), url: process.env.LIVEKIT_URL });
    } catch (err) {
      console.error('[livekit-token]', err);
      return res.status(500).json({ error: err?.message || 'Unable to create LiveKit token' });
    }
  })();
}

app.get('/api/livekit/token', issueLiveKitToken);
app.post('/api/livekit/token', issueLiveKitToken);
// The Netlify functions alias must handle ALL actions the frontend may POST here,
// including start-egress and stop-egress (used as a fallback by multistream.js).
app.all('/.netlify/functions/livekit-token', async (req, res) => {
  const body = req.method === 'POST' ? (req.body || {}) : {};
  const action = String(body.action || req.query?.action || '').trim().toLowerCase();

  if (action === 'start-egress' || action === 'start_egress') {
    req.body = body;
    return app._router.handle(Object.assign(req, { url: '/api/stream/start-egress', method: 'POST' }), res, () => {});
  }
  if (action === 'stop-egress' || action === 'stop_egress') {
    req.body = body;
    return app._router.handle(Object.assign(req, { url: '/api/stream/stop-egress', method: 'POST' }), res, () => {});
  }
  if (action === 'stream-status' || action === 'stream_status') {
    req.query = { ...req.query, roomName: body.roomName || req.query?.roomName || '' };
    return app._router.handle(Object.assign(req, { url: '/api/stream/status', method: 'GET' }), res, () => {});
  }
  // Default: issue a LiveKit token
  return issueLiveKitToken(req, res);
});

// ============================================================================
// REAL-TIME PRESENCE & GAME-STYLE DUET / AUDIENCE INVITATION ENGINE
// ============================================================================
const activeUsers = new Map();
const activeInvites = new Map();
const pollInviteResponses = new Map();

function broadcastUserList() {
  const now = Date.now();
  const list = [];
  for (const [id, u] of activeUsers.entries()) {
    if (now - u.lastSeen > 35000) {
      if (u.sseRes && !u.sseRes.writableEnded) {
        try { u.sseRes.end(); } catch (_) {}
      }
      activeUsers.delete(id);
      continue;
    }
    list.push({
      id: u.id,
      name: u.name,
      avatar: u.avatar || '🎤',
      role: u.role || 'idle',
      roomId: u.roomId || null,
      roomName: u.roomName || null,
      isLive: !!u.isLive,
      device: u.device || 'desktop',
      lastSeen: u.lastSeen
    });
  }

  const payload = `event: user_list\ndata: ${JSON.stringify(list)}\n\n`;
  for (const user of activeUsers.values()) {
    if (user.sseRes && !user.sseRes.writableEnded) {
      try { user.sseRes.write(payload); } catch (_) {}
    }
  }
}

// Auto-cleanup stale users and expired invites
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [id, u] of activeUsers.entries()) {
    if (now - u.lastSeen > 35000) {
      activeUsers.delete(id);
      changed = true;
    }
  }
  for (const [invId, inv] of activeInvites.entries()) {
    if (now > inv.expiresAt && inv.status === 'pending') {
      inv.status = 'expired';
      // Notify sender that invite timed out
      const sender = activeUsers.get(inv.fromUser?.id);
      if (sender?.sseRes && !sender.sseRes.writableEnded) {
        try {
          sender.sseRes.write(`event: invite_response\ndata: ${JSON.stringify({ inviteId: invId, status: 'expired', accepted: false })}\n\n`);
        } catch (_) {}
      }
      activeInvites.delete(invId);
    } else if (now - inv.createdAt > 60000) {
      activeInvites.delete(invId);
    }
  }
  if (changed) broadcastUserList();
}, 8000);

// SSE Stream for Real-time Presence & Invites
app.get('/api/presence/stream', (req, res) => {
  const userId = String(req.query.userId || '').trim();
  const name = String(req.query.name || 'Singer').trim();
  const avatar = String(req.query.avatar || '🎤').trim();
  const role = String(req.query.role || 'idle').trim();
  const roomId = String(req.query.roomId || '').trim() || null;
  const roomName = String(req.query.roomName || '').trim() || null;
  const isLive = req.query.isLive === 'true' || req.query.isLive === '1';
  const device = String(req.query.device || 'desktop').trim();

  if (!userId) {
    return res.status(400).json({ error: 'userId is required' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.on('error', () => {});
  res.write('\n');

  // Register or update user with active SSE response stream
  const existing = activeUsers.get(userId);
  if (existing?.sseRes && existing.sseRes !== res && !existing.sseRes.writableEnded) {
    try { existing.sseRes.end(); } catch (_) {}
  }

  activeUsers.set(userId, {
    id: userId,
    name,
    avatar,
    role,
    roomId,
    roomName,
    isLive,
    device,
    lastSeen: Date.now(),
    sseRes: res
  });

  // Send immediate user list to this client
  const currentList = Array.from(activeUsers.values()).map(u => ({
    id: u.id,
    name: u.name,
    avatar: u.avatar || '🎤',
    role: u.role || 'idle',
    roomId: u.roomId || null,
    roomName: u.roomName || null,
    isLive: !!u.isLive,
    device: u.device || 'desktop',
    lastSeen: u.lastSeen
  }));
  res.write(`event: user_list\ndata: ${JSON.stringify(currentList)}\n\n`);

  // Broadcast new user arrival to everyone else
  broadcastUserList();

  // Keep-alive heartbeat comment every 15 seconds
  const pingInterval = setInterval(() => {
    if (res.writableEnded) {
      clearInterval(pingInterval);
      return;
    }
    try { res.write(': ping\n\n'); } catch (_) { clearInterval(pingInterval); }
  }, 15000);

  req.on('close', () => {
    clearInterval(pingInterval);
    const user = activeUsers.get(userId);
    if (user?.sseRes === res) {
      activeUsers.delete(userId);
      broadcastUserList();
    }
  });
});

// Heartbeat & status update
app.post('/api/presence/heartbeat', (req, res) => {
  const { userId, name, avatar, role, roomId, roomName, isLive, device } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const existing = activeUsers.get(userId) || { id: userId, sseRes: null };
  const wasChanged = existing.name !== name || existing.role !== role || existing.roomId !== roomId || existing.isLive !== isLive;

  activeUsers.set(userId, {
    ...existing,
    id: userId,
    name: name || existing.name || 'Singer',
    avatar: avatar || existing.avatar || '🎤',
    role: role || existing.role || 'idle',
    roomId: roomId !== undefined ? roomId : existing.roomId,
    roomName: roomName !== undefined ? roomName : existing.roomName,
    isLive: isLive !== undefined ? isLive : existing.isLive,
    device: device || existing.device || 'desktop',
    lastSeen: Date.now()
  });

  const now = Date.now();
  const myPendingInvites = [];
  for (const [invId, inv] of activeInvites.entries()) {
    if (inv.toUserId === userId && inv.status === 'pending' && now <= inv.expiresAt) {
      myPendingInvites.push(inv);
    }
  }

  const myResponses = pollInviteResponses.get(userId) || [];
  if (myResponses.length > 0) {
    pollInviteResponses.delete(userId);
  }

  const usersList = [];
  for (const [id, u] of activeUsers.entries()) {
    if (now - u.lastSeen <= 35000) {
      usersList.push({
        id: u.id,
        name: u.name,
        avatar: u.avatar || '🎤',
        role: u.role || 'idle',
        roomId: u.roomId || null,
        roomName: u.roomName || null,
        isLive: !!u.isLive,
        device: u.device || 'desktop',
        lastSeen: u.lastSeen
      });
    }
  }

  if (wasChanged) broadcastUserList();
  return res.json({
    ok: true,
    users: usersList,
    pendingInvites: myPendingInvites,
    inviteResponses: myResponses
  });
});

// Get all active online users & live rooms
app.get('/api/presence/users', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  const now = Date.now();
  const list = [];
  for (const [id, u] of activeUsers.entries()) {
    if (now - u.lastSeen <= 35000) {
      list.push({
        id: u.id,
        name: u.name,
        avatar: u.avatar || '🎤',
        role: u.role || 'idle',
        roomId: u.roomId || null,
        roomName: u.roomName || null,
        isLive: !!u.isLive,
        device: u.device || 'desktop',
        lastSeen: u.lastSeen
      });
    }
  }
  return res.json({ ok: true, count: list.length, users: list });
});

// Dispatch game-style Duet / Audience invitation
app.post('/api/presence/invite', (req, res) => {
  const { fromUser, toUserId, roomId, roomName, type } = req.body || {};
  if (!fromUser?.id || !toUserId) {
    return res.status(400).json({ error: 'fromUser and toUserId are required' });
  }

  const target = activeUsers.get(toUserId);
  if (!target) {
    return res.status(404).json({ error: 'Target user is no longer online' });
  }

  const inviteId = 'inv_' + Math.random().toString(36).slice(2, 9);
  const invite = {
    id: inviteId,
    fromUser: {
      id: fromUser.id,
      name: fromUser.name || 'Singer',
      avatar: fromUser.avatar || '🎤',
      roomId: roomId || fromUser.roomId || null,
      roomName: roomName || fromUser.roomName || 'Live Karaoke Stage',
      type: type || 'duet' // 'duet' | 'audience'
    },
    toUserId,
    roomId: roomId || fromUser.roomId || null,
    roomName: roomName || fromUser.roomName || 'Live Karaoke Stage',
    status: 'pending',
    createdAt: Date.now(),
    expiresAt: Date.now() + 16000 // 16s window
  };

  activeInvites.set(inviteId, invite);

  // Push SSE event to target user immediately
  if (target.sseRes && !target.sseRes.writableEnded) {
    try {
      target.sseRes.write(`event: invite_received\ndata: ${JSON.stringify(invite)}\n\n`);
    } catch (err) {
      console.warn('[presence] failed to push invite to target SSE:', err);
    }
  }

  return res.json({ ok: true, inviteId, invite });
});

// Respond to Duet / Audience invitation
app.post('/api/presence/respond-invite', (req, res) => {
  const { inviteId, responderId, accepted } = req.body || {};
  if (!inviteId) return res.status(400).json({ error: 'inviteId is required' });

  const invite = activeInvites.get(inviteId);
  if (!invite) {
    return res.status(404).json({ error: 'Invitation has expired or does not exist' });
  }

  invite.status = accepted ? 'accepted' : 'declined';

  // Notify sender via SSE
  const sender = activeUsers.get(invite.fromUser?.id);
  const responder = activeUsers.get(responderId);
  const responseData = {
    inviteId,
    status: invite.status,
    accepted: !!accepted,
    responder: {
      id: responderId,
      name: responder?.name || 'Guest Singer',
      avatar: responder?.avatar || '🎤'
    },
    roomId: invite.roomId,
    roomName: invite.roomName
  };

  const senderId = invite.fromUser?.id;
  if (senderId) {
    const resList = pollInviteResponses.get(senderId) || [];
    resList.push(responseData);
    pollInviteResponses.set(senderId, resList);
  }

  if (sender?.sseRes && !sender.sseRes.writableEnded) {
    try {
      sender.sseRes.write(`event: invite_response\ndata: ${JSON.stringify(responseData)}\n\n`);
    } catch (err) {
      console.warn('[presence] failed to push invite response to sender SSE:', err);
    }
  }

  return res.json({
    ok: true,
    accepted: !!accepted,
    roomId: invite.roomId,
    roomName: invite.roomName,
    invite
  });
});

// Fallback polling for invites
app.get('/api/presence/pending-invites', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const userId = String(req.query.userId || '').trim();
  if (!userId) return res.json({ ok: true, invites: [] });

  const now = Date.now();
  const list = [];
  for (const [id, inv] of activeInvites.entries()) {
    if (inv.toUserId === userId && inv.status === 'pending' && now <= inv.expiresAt) {
      list.push(inv);
    }
  }
  return res.json({ ok: true, invites: list });
});

// Netlify serverless functions compatibility alias
app.all('/.netlify/functions/presence', (req, res) => {
  const action = String(req.query.action || req.body?.action || '').trim().toLowerCase();
  if (action === 'heartbeat') {
    req.url = '/api/presence/heartbeat';
    req.method = 'POST';
    return app._router.handle(req, res);
  }
  if (action === 'invite') {
    req.url = '/api/presence/invite';
    req.method = 'POST';
    return app._router.handle(req, res);
  }
  if (action === 'respond-invite') {
    req.url = '/api/presence/respond-invite';
    req.method = 'POST';
    return app._router.handle(req, res);
  }
  if (action === 'pending-invites') {
    req.url = '/api/presence/pending-invites';
    req.method = 'GET';
    return app._router.handle(req, res);
  }
  req.url = '/api/presence/users';
  req.method = 'GET';
  return app._router.handle(req, res);
});

// ============================================================================
// MULTISTREAM / EXTERNAL RTMP LIVESTREAMING (YouTube, Twitch, Facebook)
// ============================================================================
app.post('/api/stream/start-egress', async (req, res) => {
  const { roomName, platform = 'youtube', streamKey, rtmpUrl } = req.body || {};
  if (!roomName) return res.status(400).json({ error: 'roomName is required' });
  if (!streamKey) return res.status(400).json({ error: 'streamKey is required' });

  const egressClient = getEgressClient();
  if (!egressClient) {
    return res.status(503).json({ error: 'LiveKit server configuration is missing.' });
  }

  let fullRtmpUrl = '';
  const plat = String(platform).toLowerCase();
  if (plat === 'youtube') {
    // YouTube supports both rtmp:// and rtmps:// — use the primary ingest URL.
    // rtmps:// (port 443) is more firewall-friendly but both work; rtmp:// port 1935 is the standard.
    fullRtmpUrl = `rtmp://a.rtmp.youtube.com/live2/${streamKey.trim()}`;
  } else if (plat === 'twitch') {
    fullRtmpUrl = `rtmp://live.twitch.tv/app/${streamKey.trim()}`;
  } else if (plat === 'facebook') {
    fullRtmpUrl = `rtmps://live-api-s.facebook.com:443/rtmp/${streamKey.trim()}`;
  } else {
    if (!rtmpUrl) return res.status(400).json({ error: 'Custom RTMP Server URL is required' });
    fullRtmpUrl = `${rtmpUrl.replace(/\/$/, '')}/${streamKey.trim()}`;
  }

  try {
    console.info(`[Multistream] Starting RTMP Egress for room ${roomName} -> ${plat} @ ${fullRtmpUrl.replace(streamKey.trim(), '***')}`);
    const streamOutput = {
      protocol: StreamProtocol.RTMP,
      urls: [fullRtmpUrl]
    };

    // Strategy: Try full composite (video + audio) first using 'speaker' layout.
    // If the room has no video track, LiveKit will still render a black background
    // with audio — which is valid for YouTube. If the composite tier is unavailable,
    // fall back to audio-only composite (audioOnly:true tells LiveKit to skip the
    // video encoder, which works on lower-tier LiveKit plans).
    let info;
    let usedLayout = 'speaker';
    try {
      info = await egressClient.startRoomCompositeEgress(roomName, streamOutput, {
        layout: 'speaker',
        audioOnly: false,
        // Explicitly include audio to avoid silent streams
        audio: true,
        video: true
      });
      console.info(`[Multistream] Egress started with speaker layout, egressId=${info?.egressId}`);
    } catch (compositeErr) {
      console.warn('[Multistream] speaker composite egress failed, trying audio_only:', compositeErr?.message);
      usedLayout = 'audio_only';
      try {
        info = await egressClient.startRoomCompositeEgress(roomName, streamOutput, {
          layout: 'audio_only',
          audioOnly: true
        });
        console.info(`[Multistream] Egress started with audio_only layout, egressId=${info?.egressId}`);
      } catch (audioOnlyErr) {
        console.error('[Multistream] audio_only egress also failed:', audioOnlyErr?.message);
        throw audioOnlyErr;
      }
    }

    const egressId = info?.egressId || 'egress_' + Math.random().toString(36).slice(2, 9);
    const record = {
      egressId,
      roomName,
      platform: plat,
      layout: usedLayout,
      startedAt: Date.now(),
      status: 'live'
    };
    activeStreams.set(roomName, record);

    return res.json({
      ok: true,
      egressId,
      platform: plat,
      layout: usedLayout,
      status: 'live',
      startedAt: record.startedAt
    });
  } catch (err) {
    console.error('[Multistream Egress Error]', err);
    return res.status(502).json({
      ok: false,
      error: `LiveKit Egress error: ${err?.message || err}. Make sure: 1) Egress is enabled on your LiveKit Cloud project, 2) Your LiveKit plan supports Egress, 3) The room exists and has participants.`
    });
  }
});

app.post('/api/stream/stop-egress', async (req, res) => {
  const { roomName, egressId } = req.body || {};
  const active = activeStreams.get(roomName);
  const targetId = egressId || active?.egressId;

  if (targetId) {
    const egressClient = getEgressClient();
    if (egressClient) {
      try {
        await egressClient.stopEgress(targetId);
      } catch (err) {
        console.warn('[Multistream stop notice]:', err?.message || err);
      }
    }
  }

  if (roomName) activeStreams.delete(roomName);
  return res.json({ ok: true, status: 'stopped' });
});

app.get('/api/stream/status', (req, res) => {
  const roomName = String(req.query.roomName || '').trim();
  const stream = activeStreams.get(roomName);
  return res.json({
    ok: true,
    active: !!stream,
    stream: stream || null
  });
});

// ============================================================================
// BROWSER → WEBSOCKET → FFMPEG → RTMP STREAMING ENGINE
// No LiveKit Egress subscription required — works on any LiveKit plan.
// The browser captures its mixed AudioContext output via MediaRecorder and
// streams WebM/Opus chunks over WebSocket. The server pipes these to ffmpeg
// which muxes them into FLV and pushes to the RTMP destination (YouTube, etc.)
// ============================================================================

/** Map of active ffmpeg-based streams: sessionId → { ffmpeg, platform, startedAt, roomName } */
const ffmpegStreams = new Map();

/**
 * Build the RTMP URL for a given platform + stream key.
 */
function buildRtmpUrl(platform, streamKey, customUrl = '') {
  const plat = String(platform || 'youtube').toLowerCase();
  const key = String(streamKey || '').trim();
  if (plat === 'youtube')  return `rtmp://a.rtmp.youtube.com/live2/${key}`;
  if (plat === 'twitch')   return `rtmp://live.twitch.tv/app/${key}`;
  if (plat === 'facebook') return `rtmps://live-api-s.facebook.com:443/rtmp/${key}`;
  // custom
  if (!customUrl) throw new Error('Custom RTMP URL is required for custom platform');
  return `${String(customUrl).replace(/\/$/, '')}/${key}`;
}

/**
 * Start an ffmpeg child process that:
 *  - Reads WebM/Opus audio from stdin (pipe:0)
 *  - Generates a silent 1280×720 black video (lavfi)
 *  - Muxes to FLV and pushes to the RTMP URL
 *
 * Returns the spawned child process.
 */
function spawnFfmpeg(rtmpUrl) {
  const args = [
    // Video input (Input 0): 1280x720 black frame at 30 fps generated by FFmpeg
    '-f', 'lavfi',
    '-i', 'color=c=black:s=1280x720:r=30',
    // Audio input (Input 1): WebM Opus stream from browser MediaRecorder via stdin
    '-f', 'webm',
    '-i', 'pipe:0',
    // Explicit mapping: video from Input 0, audio from Input 1
    '-map', '0:v:0',
    '-map', '1:a:0',
    // Video encoder: H.264 ultrafast, low CPU, tuned for zero-latency live streaming
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-pix_fmt', 'yuv420p',
    '-g', '60',
    // Audio encoder: AAC stereo 44.1kHz 128kbps (YouTube standard)
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '44100',
    '-ac', '2',
    // Output container: Flash Video for RTMP
    '-f', 'flv',
    '-flvflags', 'no_duration_filesize',
    rtmpUrl
  ];

  console.info('[ffmpeg-stream] Spawning ffmpeg for RTMP:', rtmpUrl.replace(/\/[^/]+$/, '/***'));
  const proc = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });

  proc.stdout.on('data', () => {}); // consume stdout
  proc.stderr.on('data', (d) => {
    const line = d.toString();
    if (/frame=|fps=|bitrate=|speed=/.test(line)) {
      process.stdout.write('[ffmpeg] ' + line.trim() + '\r');
    } else if (/error|fail|invalid|refused/i.test(line)) {
      console.warn('[ffmpeg stderr]', line.trim());
    }
  });

  proc.on('exit', (code, signal) => {
    console.info(`[ffmpeg-stream] ffmpeg exited code=${code} signal=${signal}`);
  });
  proc.on('error', (err) => {
    console.error('[ffmpeg-stream] spawn error:', err.message);
  });

  return proc;
}

// ---- WebSocket server (attaches to the same HTTP server) ----
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/stream/ws') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
      return;
    }
  } catch (err) {
    console.warn('[server upgrade error]', err?.message);
  }
  socket.destroy();
});

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const platform  = url.searchParams.get('platform') || 'youtube';
  const streamKey = url.searchParams.get('key') || '';
  const customUrl = url.searchParams.get('customUrl') || '';
  const sessionId = url.searchParams.get('sessionId') || ('ws_' + Math.random().toString(36).slice(2, 9));
  const roomName  = url.searchParams.get('roomName') || sessionId;

  // Validate
  if (!streamKey) {
    ws.send(JSON.stringify({ type: 'error', message: 'Stream key is required' }));
    ws.close(1008, 'Missing stream key');
    return;
  }

  let rtmpUrl;
  try {
    rtmpUrl = buildRtmpUrl(platform, streamKey, customUrl);
  } catch (err) {
    ws.send(JSON.stringify({ type: 'error', message: err.message }));
    ws.close(1008, err.message);
    return;
  }

  // Kill any existing stream for this room
  const existing = ffmpegStreams.get(roomName);
  if (existing?.ffmpeg) {
    try { existing.ffmpeg.stdin.end(); existing.ffmpeg.kill('SIGTERM'); } catch (_) {}
    ffmpegStreams.delete(roomName);
  }

  const ffmpegProc = spawnFfmpeg(rtmpUrl);
  const record = { ffmpeg: ffmpegProc, platform, streamKey, rtmpUrl, startedAt: Date.now(), sessionId, roomName };
  ffmpegStreams.set(roomName, record);

  // Also update the legacy activeStreams map so /api/stream/status works
  activeStreams.set(roomName, { egressId: sessionId, platform, roomName, startedAt: record.startedAt, status: 'live', method: 'ffmpeg-ws' });

  ws.send(JSON.stringify({ type: 'started', sessionId, platform, message: 'ffmpeg stream started' }));
  console.info(`[ffmpeg-stream] WebSocket stream started sessionId=${sessionId} platform=${platform} room=${roomName}`);

  let totalBytes = 0;
  ws.on('message', (chunk) => {
    if (!ffmpegProc.stdin.writable) return;
    try {
      ffmpegProc.stdin.write(chunk);
      totalBytes += chunk.length;
    } catch (e) {
      console.warn('[ffmpeg-stream] stdin write error:', e.message);
    }
  });

  // Heartbeat pings keep the WS alive through proxies
  const pingTimer = setInterval(() => {
    if (ws.readyState === ws.OPEN) {
      ws.ping();
    } else {
      clearInterval(pingTimer);
    }
  }, 15000);

  const cleanup = (reason) => {
    clearInterval(pingTimer);
    console.info(`[ffmpeg-stream] Closing stream sessionId=${sessionId} reason=${reason} bytes=${totalBytes}`);
    try { ffmpegProc.stdin.end(); } catch (_) {}
    setTimeout(() => {
      try { if (!ffmpegProc.killed) ffmpegProc.kill('SIGTERM'); } catch (_) {}
    }, 2000);
    const current = ffmpegStreams.get(roomName);
    if (current?.sessionId === sessionId) {
      ffmpegStreams.delete(roomName);
      activeStreams.delete(roomName);
    }
  };

  ffmpegProc.on('exit', () => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'stopped', message: 'ffmpeg process exited' }));
      ws.close();
    }
    const current = ffmpegStreams.get(roomName);
    if (current?.sessionId === sessionId) {
      ffmpegStreams.delete(roomName);
      activeStreams.delete(roomName);
    }
  });

  ws.on('close', () => cleanup('websocket closed'));
  ws.on('error', (err) => {
    console.warn('[ffmpeg-stream] ws error:', err.message);
    cleanup('websocket error');
  });
});

// ---- REST: stop a running ffmpeg stream ----
app.post('/api/stream/stop-ffmpeg', (req, res) => {
  const { roomName, sessionId } = req.body || {};
  const key = roomName || sessionId;
  const record = ffmpegStreams.get(key);
  if (record) {
    try { record.ffmpeg.stdin.end(); } catch (_) {}
    setTimeout(() => { try { if (!record.ffmpeg.killed) record.ffmpeg.kill('SIGTERM'); } catch (_) {} }, 1500);
    ffmpegStreams.delete(key);
    activeStreams.delete(key);
  }
  return res.json({ ok: true, status: 'stopped' });
});

server.listen(PORT, () => {
  console.log(`🎤 Nirmal Karaoke web server: http://localhost:${PORT}`);
  console.log(`   LiveKit SFU: ${livekitConfigured() ? 'configured' : 'NOT configured'}`);
  console.log(`   RTMP Streaming: browser→WebSocket→ffmpeg (no LiveKit Egress needed)`);
});


function livekitApiHost(value) {
  return String(value || '').replace(/^wss:\/\//i, 'https://').replace(/^ws:\/\//i, 'http://').replace(/\/$/, '');
}

process.on('uncaughtException', (err) => {
  console.error('[server uncaughtException]', err?.message || err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[server unhandledRejection]', reason?.message || reason);
});
