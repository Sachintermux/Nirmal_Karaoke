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

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'nirmal-karaoke-web', transport: 'livekit-sfu', livekitConfigured: livekitConfigured() });
});

app.get('/api/stream/diag', async (_req, res) => {
  const dns = require('dns').promises;
  const net = require('net');
  const tls = require('tls');
  const { exec } = require('child_process');

  const results = {
    timestamp: new Date().toISOString(),
    platform: process.platform,
    nodeVersion: process.version,
    env: process.env.NODE_ENV
  };

  // 1. DNS check
  try {
    const ytDns = await dns.lookup('a.rtmps.youtube.com', { all: true });
    results.dns_rtmps = ytDns;
  } catch (e) {
    results.dns_rtmps = { error: e.message };
  }

  try {
    const ytDnsStandard = await dns.lookup('a.rtmp.youtube.com', { all: true });
    results.dns_rtmp = ytDnsStandard;
  } catch (e) {
    results.dns_rtmp = { error: e.message };
  }

  // 2. TCP Port 443 check (RTMPS)
  results.tcp_443 = await new Promise((resolve) => {
    const start = Date.now();
    const sock = net.connect({ host: 'a.rtmps.youtube.com', port: 443, timeout: 3500 }, () => {
      const elapsed = Date.now() - start;
      sock.destroy();
      resolve({ open: true, elapsedMs: elapsed });
    });
    sock.on('timeout', () => { sock.destroy(); resolve({ open: false, error: 'TIMEOUT (3500ms)' }); });
    sock.on('error', (err) => resolve({ open: false, error: err.message }));
  });

  // 3. TCP Port 1935 check (Standard RTMP)
  results.tcp_1935 = await new Promise((resolve) => {
    const start = Date.now();
    const sock = net.connect({ host: 'a.rtmp.youtube.com', port: 1935, timeout: 3500 }, () => {
      const elapsed = Date.now() - start;
      sock.destroy();
      resolve({ open: true, elapsedMs: elapsed });
    });
    sock.on('timeout', () => { sock.destroy(); resolve({ open: false, error: 'TIMEOUT (3500ms)' }); });
    sock.on('error', (err) => resolve({ open: false, error: err.message }));
  });

  // 4. TLS Handshake on 443
  results.tls_443 = await new Promise((resolve) => {
    const start = Date.now();
    const tlsSock = tls.connect({
      host: 'a.rtmps.youtube.com',
      port: 443,
      servername: 'a.rtmps.youtube.com',
      timeout: 3500
    }, () => {
      const elapsed = Date.now() - start;
      const cert = tlsSock.getPeerCertificate(false);
      tlsSock.destroy();
      resolve({ ok: true, elapsedMs: elapsed, subject: cert?.subject?.CN });
    });
    tlsSock.on('timeout', () => { tlsSock.destroy(); resolve({ ok: false, error: 'TIMEOUT (3500ms)' }); });
    tlsSock.on('error', (err) => resolve({ ok: false, error: err.message }));
  });

  // 5. FFmpeg check
  results.ffmpeg = await new Promise((resolve) => {
    exec('ffmpeg -version', (err, stdout) => {
      if (err) return resolve({ installed: false, error: err.message });
      const firstLine = stdout.split('\n')[0] || '';
      resolve({ installed: true, version: firstLine.trim() });
    });
  });

  // 6. Verify FFmpeg advertises the RTMPS protocol.
  results.ffmpeg_rtmps = await new Promise((resolve) => {
    exec('ffmpeg -hide_banner -protocols', (err, stdout, stderr) => {
      if (err) return resolve({ supported: false, error: err.message });
      const protocols = `${stdout || ''}\n${stderr || ''}`;
      resolve({
        supported: /(^|\s)rtmps(\s|$)/m.test(protocols),
        supportedListExcerpt: protocols.split('\n').filter(line => /rtmp/i.test(line)).slice(-5)
      });
    });
  });

  res.json({ ok: true, diagnostics: results });
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
  if (action === 'stop-ffmpeg' || action === 'stop_ffmpeg') {
    req.body = body;
    return app._router.handle(Object.assign(req, { url: '/api/stream/stop-ffmpeg', method: 'POST' }), res, () => {});
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
      const senderId = inv.fromUser?.id;
      const expiredData = { inviteId: invId, status: 'expired', accepted: false };
      if (senderId) {
        const resList = pollInviteResponses.get(senderId) || [];
        resList.push(expiredData);
        pollInviteResponses.set(senderId, resList);
      }
      // Notify sender that invite timed out
      const sender = senderId ? activeUsers.get(senderId) : null;
      if (sender?.sseRes && !sender.sseRes.writableEnded) {
        try {
          sender.sseRes.write(`event: invite_response\ndata: ${JSON.stringify(expiredData)}\n\n`);
        } catch (_) {}
      }
      // Notify recipient that invite timed out so modal dialog auto-dismisses
      const toUser = inv.toUserId ? activeUsers.get(inv.toUserId) : null;
      if (toUser?.sseRes && !toUser.sseRes.writableEnded) {
        try {
          toUser.sseRes.write(`event: invite_expired\ndata: ${JSON.stringify(expiredData)}\n\n`);
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

  const plat = String(platform).toLowerCase().trim();
  let fullRtmpUrl;
  try {
    fullRtmpUrl = buildRtmpUrl(plat, streamKey, rtmpUrl);
  } catch (err) {
    return res.status(400).json({ error: err?.message || String(err) });
  }

  try {
    console.info(`[Multistream] Starting RTMP Egress for room ${roomName} -> ${plat} @ ${fullRtmpUrl.replace(streamKey.trim(), '***')}`);
    const streamOutput = {
      protocol: StreamProtocol.RTMP,
      urls: [fullRtmpUrl]
    };

    // Start a real room composite with video + audio. We do NOT fall back to
    // audio-only because the YouTube destination for this application requires
    // a video stream and an audio-only fallback makes the application report a
    // successful egress while YouTube receives no video.
    const usedLayout = 'speaker';
    let info;
    try {
      info = await egressClient.startRoomCompositeEgress(roomName, streamOutput, {
        layout: usedLayout,
        audioOnly: false,
        videoOnly: false
      });
      console.info(`[Multistream] Video+audio egress started, egressId=${info?.egressId}`);
    } catch (compositeErr) {
      console.error('[Multistream] Video+audio composite egress failed:', compositeErr?.message || compositeErr);
      throw compositeErr;
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
 * Build the primary RTMP/RTMPS URL for a given platform + stream key.
 * On Cloud hosting (Render / AWS / GCP), unencrypted RTMP port 1935 is blocked by firewalls.
 * YouTube officially supports and recommends RTMPS on SSL Port 443.
 */
function buildRtmpUrl(platform, streamKey, customUrl = '') {
  const candidates = getCandidateRtmpUrls(platform, streamKey, customUrl);
  return candidates[0];
}

/**
 * Return the RTMP/RTMPS URL to use for a platform.
 *
 * Important for YouTube:
 * - If the frontend supplies customUrl/rtmpUrl from YouTube Live Control Room,
 *   that exact URL is used.
 * - Otherwise the current YouTube RTMPS endpoint is used as the default.
 * - We deliberately do NOT add ?backup=1 or automatically switch protocols
 *   after a publishing/authentication error because that can hide the real
 *   failure and can create duplicate-publisher conditions.
 */
function getCandidateRtmpUrls(platform, streamKey, customUrl = '') {
  const plat = String(platform || 'youtube').toLowerCase().trim();
  let key = String(streamKey || '').trim().replace(/^['"]+|['"]+$/g, '');

  if (!key) {
    throw new Error('Stream key is required');
  }

  if (key.startsWith('http://') || key.startsWith('https://')) {
    throw new Error('Invalid Stream Key: you entered a webpage URL instead of the secret stream key.');
  }

  // Allow a complete RTMP(S) URL to be entered directly.
  if (key.startsWith('rtmp://') || key.startsWith('rtmps://')) {
    if (/\/live2\/?$/i.test(key)) {
      throw new Error('Invalid RTMP URL: the stream key is missing at the end of the URL.');
    }
    return [key];
  }

  // If YouTube/another platform supplied an exact ingest URL, prefer it.
  if (customUrl) {
    const base = String(customUrl).trim().replace(/['"]+/g, '');

    if (!/^rtmps?:\/\//i.test(base)) {
      throw new Error('RTMP Server URL must start with rtmp:// or rtmps://');
    }

    // Handle either a base server/app URL or an already-complete URL.
    try {
      const parsed = new URL(base);
      const cleanPath = parsed.pathname.replace(/\/+$/, '');
      if (cleanPath.endsWith(`/${key}`)) {
        if (base.includes('youtube.com') && base.startsWith('rtmp://')) {
          const secureBase = base.replace('rtmp://a.rtmp.youtube.com', 'rtmps://a.rtmps.youtube.com:443')
                                 .replace('rtmp://b.rtmp.youtube.com', 'rtmps://b.rtmps.youtube.com:443');
          return [secureBase, base];
        }
        return [base];
      }
    } catch (_) {
      throw new Error('Invalid RTMP Server URL');
    }

    if (base.includes('youtube.com') && base.startsWith('rtmp://')) {
      const secureBase = base.replace('rtmp://a.rtmp.youtube.com', 'rtmps://a.rtmps.youtube.com:443')
                             .replace('rtmp://b.rtmp.youtube.com', 'rtmps://b.rtmps.youtube.com:443');
      return [`${secureBase.replace(/\/+$/, '')}/${key}`, `${base.replace(/\/+$/, '')}/${key}`];
    }

    return [`${base.replace(/\/+$/, '')}/${key}`];
  }

  // YouTube Live: Always prioritize RTMPS port 443 (firewall-friendly on Render/cloud & local)
  if (plat === 'youtube_rtmps' || plat === 'youtube') {
    return [
      `rtmps://a.rtmps.youtube.com:443/live2/${key}`,
      `rtmp://a.rtmp.youtube.com/live2/${key}`
    ];
  }

  if (plat === 'youtube_standard_rtmp') {
    return [
      `rtmp://a.rtmp.youtube.com:1935/live2/${key}`,
      `rtmps://a.rtmps.youtube.com:443/live2/${key}`
    ];
  }

  if (plat === 'twitch') {
    return [
      `rtmps://live.twitch.tv:443/app/${key}`,
      `rtmp://live.twitch.tv/app/${key}`
    ];
  }

  if (plat === 'facebook') {
    return [`rtmps://live-api-s.facebook.com:443/rtmp/${key}`];
  }

  throw new Error('Custom RTMP Server URL is required for this platform');
}

/**
 * Diagnostic endpoint to test FFmpeg live stream ingestion to destination directly
 */
app.get('/api/stream/test-ffmpeg', async (req, res) => {
  res.set('Cache-Control', 'no-store');

  const key = String(req.query.key || '').trim();
  const platform = String(req.query.platform || 'youtube').trim();
  const customUrl = String(req.query.rtmpUrl || req.query.customUrl || '').trim();

  if (!key) {
    return res.status(400).json({
      ok: false,
      error: 'Stream key is required'
    });
  }

  let candidateUrls;
  try {
    candidateUrls = getCandidateRtmpUrls(platform, key, customUrl);
  } catch (err) {
    return res.status(400).json({
      ok: false,
      error: err?.message || String(err)
    });
  }

  const results = [];

  for (const targetUrl of candidateUrls) {
    const safeUrl = maskStreamSecret(targetUrl, key);

    console.info(`[test-ffmpeg] Testing fast live ingestion to: ${safeUrl}`);

    const result = await new Promise((resolve) => {
      const args = [
        '-hide_banner',
        '-loglevel', 'info',

        // Low CPU synthetic test pattern without -re (no artificial clock delays)
        '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=30',
        '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=44100',

        // Explicit output mapping
        '-map', '0:v:0',
        '-map', '1:a:0',

        // Ultrafast container-friendly H.264
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-tune', 'zerolatency',
        '-profile:v', 'main',
        '-pix_fmt', 'yuv420p',
        '-r', '30',
        '-g', '60',
        '-keyint_min', '60',
        '-sc_threshold', '0',
        '-flags', '+cgop',
        '-b:v', '400k',
        '-x264-params', 'subme=0:me=dia:no-mbtree=1:aq-mode=0:ref=1:partitions=none',
        '-threads', '2',

        // AAC audio with synchronized PTS
        '-c:a', 'aac',
        '-b:a', '64k',
        '-ar', '44100',
        '-ac', '2',
        '-af', 'asetpts=PTS-STARTPTS,aresample=async=1:first_pts=0',

        // Quick 3-second test run (90 frames)
        '-t', '3',
        '-flvflags', 'no_duration_filesize',
        '-f', 'flv',
        targetUrl
      ];

      const p = spawn('ffmpeg', args, {
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let out = '';
      let sawRtmpConnect = false;
      let sawOutputFrames = false;
      let settled = false;

      const finish = (value) => {
        if (settled) return;
        settled = true;
        try { p.kill('SIGTERM'); } catch (_) {}
        resolve(value);
      };

      p.stdout.on('data', d => {
        out += d.toString();
      });

      p.stderr.on('data', d => {
        const line = d.toString();
        out += line;

        if (/handshaking|connected|server version/i.test(line)) {
          sawRtmpConnect = true;
        }
        if (/frame=\s*[1-9]\d*/i.test(line)) {
          sawOutputFrames = true;
        }

        // Early handshake success: If connected and frames are publishing without errors
        const lower = line.toLowerCase();
        const hasError = /server error|error publishing|could not write header|operation not permitted|connection refused|timed out|broken pipe|connection reset|invalid data|end of file|error in the pull function|cannot open connection/i.test(lower);
        if (sawRtmpConnect && sawOutputFrames && !hasError) {
          const match = line.match(/frame=\s*(\d+)/i);
          if (match && parseInt(match[1], 10) >= 20) {
            clearTimeout(timer);
            finish({
              url: safeUrl,
              ok: true,
              connected: true,
              frames: true,
              exitCode: 0,
              error: null,
              logTail: out.split('\n').filter(Boolean).slice(-15)
            });
          }
        }
      });

      const timer = setTimeout(() => {
        try { p.kill('SIGKILL'); } catch (_) {}
        const lower = out.toLowerCase();
        const publishError = /server error|error publishing|could not write header|operation not permitted|connection refused|timed out|broken pipe|connection reset|invalid data|end of file|error in the pull function|cannot open connection/i.test(lower);
        const ok = !publishError && sawRtmpConnect && sawOutputFrames;
        finish({
          url: safeUrl,
          ok,
          connected: sawRtmpConnect,
          frames: sawOutputFrames,
          exitCode: ok ? 0 : -1,
          error: ok ? null : 'FFmpeg test timed out after 10 seconds. Ingestion destination did not acknowledge in time.',
          logTail: out.split('\n').filter(Boolean).slice(-30)
        });
      }, 10000);

      p.on('exit', (code, signal) => {
        clearTimeout(timer);

        const lower = out.toLowerCase();
        const publishError = /server error|error publishing|could not write header|operation not permitted|connection refused|timed out|broken pipe|connection reset|invalid data|end of file|error in the pull function|cannot open connection|i\/o error/i.test(lower);
        const ok = code === 0 && !publishError && sawRtmpConnect && sawOutputFrames;

        let errorMsg = null;
        if (!ok) {
          if (/end of file|error in the pull function|i\/o error|cannot open connection/i.test(lower)) {
            errorMsg = 'YouTube closed the connection (End of file / Inactive Stream Key). In YouTube Studio, ensure your live stream is active, click "Reset" next to your Stream Key to generate a fresh key, and try again.';
          } else if (/server error/i.test(lower)) {
            errorMsg = 'YouTube rejected the stream key (Server error). Please check your Stream Key in YouTube Studio.';
          } else if (/connection refused|timed out/i.test(lower)) {
            errorMsg = 'Could not connect to YouTube ingest server. Check your network or firewall.';
          } else if (publishError) {
            errorMsg = 'FFmpeg/RTMP publish failed.';
          }
        }

        finish({
          url: safeUrl,
          ok,
          connected: sawRtmpConnect,
          frames: sawOutputFrames,
          exitCode: code,
          signal,
          error: errorMsg,
          logTail: out.split('\n').filter(Boolean).slice(-30)
        });
      });

      p.on('error', err => {
        clearTimeout(timer);
        finish({
          url: safeUrl,
          ok: false,
          connected: sawRtmpConnect,
          frames: sawOutputFrames,
          exitCode: -1,
          error: err?.message || String(err),
          logTail: out.split('\n').filter(Boolean).slice(-30)
        });
      });
    });

    results.push(result);
    if (result.ok) break;
  }

  return res.json({
    ok: results.some(r => r.ok),
    results
  });
});

/** Ring buffer of recent streaming session telemetry */
const recentStreamSessions = [];

app.get('/api/stream/recent-logs', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  return res.json({ ok: true, sessions: recentStreamSessions.slice(-5) });
});

/**
 * Start an ffmpeg child process that:
 *  - Reads WebM live stream (Canvas Video + Mixed Audio) from stdin (pipe:0)
 *  - Encodes H.264 video (Main profile, CBR-style bitrate, 30 fps, 2-sec GOP)
 *  - Encodes AAC Stereo audio (128 kbps, 44.1 kHz)
 *  - Muxes to FLV and pushes to the RTMP/RTMPS URL (YouTube, Twitch, FB, etc.)
 */
function maskStreamSecret(url, streamKey) {
  const value = String(url || '');
  const key = String(streamKey || '');
  if (!key) return value;
  return value.split(key).join('***');
}

/**
 * Detect whether the incoming WebM buffer has an audio track definition.
 */
function detectAudioInWebM(buf) {
  if (!buf || buf.length < 16) return false;
  if (buf.includes('A_OPUS') || buf.includes('A_VORBIS') || buf.includes('A_AAC')) {
    return true;
  }
  for (let i = 0; i < Math.min(buf.length - 2, 8192); i++) {
    if (buf[i] === 0x83 && (buf[i + 1] === 0x81 || buf[i + 1] === 0x01) && buf[i + 2] === 0x02) {
      return true;
    }
  }
  return false;
}

/**
 * Start FFmpeg for one live publisher.
 * onState receives:
 *   { state: 'starting' | 'connected' | 'streaming' | 'error' | 'stopped', ... }
 */
function spawnFfmpeg(rtmpUrl, onLog, onState, quality = '480p', hasAudio = true) {
  let scaleFilter = 'scale=854:480:flags=fast_bilinear';
  let videoBitrate = '1200k';
  let bufSize = '2400k';
  let fps = 25;
  let gop = 50;

  if (quality === '720p') {
    scaleFilter = 'scale=1280:720:flags=fast_bilinear';
    videoBitrate = '2400k';
    bufSize = '4800k';
    fps = 30;
    gop = 60;
  } else if (quality === '540p') {
    scaleFilter = 'scale=960:540:flags=fast_bilinear';
    videoBitrate = '1500k';
    bufSize = '3000k';
    fps = 30;
    gop = 60;
  } else if (quality === '480p') {
    scaleFilter = 'scale=854:480:flags=fast_bilinear';
    videoBitrate = '1200k';
    bufSize = '2400k';
    fps = 25;
    gop = 50;
  } else if (quality === '360p') {
    scaleFilter = 'scale=640:360:flags=fast_bilinear';
    videoBitrate = '800k';
    bufSize = '1600k';
    fps = 25;
    gop = 50;
  }

  const args = [
    '-hide_banner',
    '-loglevel', 'info',

    // Input 0: continuous WebM/Matroska from browser MediaRecorder with generous thread queue.
    '-thread_queue_size', '1024',
    '-err_detect', 'ignore_err',
    '-fflags', '+genpts+discardcorrupt',
    '-probesize', '1M',
    '-analyzeduration', '1000000',
    '-f', 'matroska,webm',
    '-i', 'pipe:0'
  ];

  if (!hasAudio) {
    // If browser WebM has no audio track, attach synthetic silent stereo audio input.
    // YouTube Live Ingestion REQUIRES an AAC audio stream and drops video-only streams.
    args.push(
      '-f', 'lavfi',
      '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000'
    );
  }

  // Explicit mapping
  args.push('-map', '0:v:0');
  if (hasAudio) {
    args.push('-map', '0:a:0');
  } else {
    args.push('-map', '1:a:0');
  }

  args.push(
    // Video: CFR (Constant Frame Rate) video, standard SDR pixel format, no B-frame latency.
    '-vf', `${scaleFilter},setpts=PTS-STARTPTS,fps=${fps},format=yuv420p`,
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-profile:v', 'main',
    '-level', '3.1',
    '-pix_fmt', 'yuv420p',
    '-r', String(fps),
    '-fps_mode', 'cfr',
    '-g', String(gop),
    '-keyint_min', String(gop),
    '-sc_threshold', '0',
    '-flags', '+cgop',
    '-x264-params', `keyint=${gop}:min-keyint=${gop}:scenecut=0:force-cfr=1:subme=0:me=dia:no-mbtree=1:aq-mode=0:ref=1:partitions=none:rc-lookahead=0`,
    '-threads', '2',

    // YouTube CBR-style configuration.
    '-b:v', videoBitrate,
    '-maxrate', videoBitrate,
    '-bufsize', bufSize,

    // Audio: stereo AAC at 48 kHz with synchronized presentation timestamps.
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '48000',
    '-ac', '2',
    '-af', 'asetpts=PTS-STARTPTS,aresample=async=1000:first_pts=0',

    '-max_muxing_queue_size', '4096',

    // FLV/RTMP(S) output with transmission buffer.
    '-flvflags', 'no_duration_filesize',
    '-rtmp_buffer', '3000',
    '-rtmp_live', 'live',
    '-f', 'flv',
    rtmpUrl
  );

  const safeUrl = maskStreamSecret(rtmpUrl, rtmpUrl.split('/').pop());
  console.info(`[ffmpeg-stream] Spawning FFmpeg [quality=${quality}, ${scaleFilter}] -> ${safeUrl}`);

  const proc = spawn('ffmpeg', args, {
    stdio: ['pipe', 'pipe', 'pipe']
  });

  let connectionReported = false;
  let streamingReported = false;
  let lastFrameCount = 0;

  if (onState) {
    onState({
      state: 'starting',
      url: safeUrl
    });
  }

  const processLog = (line) => {
    if (onLog) onLog(line);

    const lower = line.toLowerCase();

    // Ignore non-fatal input decoder warnings (e.g. discarding initial interframe before keyframe, transient packet drop)
    if (/discarding interframe|dec:vp8|dec:h264|decoding error|packet corrupt|non-existing pps|corrupt frame|missing picture|skipping frame|invalid data found when processing input/i.test(lower)) {
      return;
    }

    // Definitive failures that should immediately surface to the UI.
    if (/server error|error publishing|could not write header to rtmp|connection refused|connection timed out|timed out|broken pipe|connection reset|ssl error|tls error|handshake failed|error in the pull function|cannot open connection|end of file/i.test(lower)) {
      // Ensure this is an RTMP output failure, not a transient input/decoder notice
      if (!/pipe:0|stdin|dec:|vist#/i.test(lower)) {
        let msg = line.trim() || 'FFmpeg/RTMP(S) publish error';
        if (/end of file|error in the pull function|cannot open connection/i.test(lower)) {
          msg = 'YouTube closed the connection (End of file / Inactive Stream Key). In YouTube Studio, ensure your live stream is active, click "Reset" next to your Stream Key to generate a fresh key, and try again.';
        }
        if (onState) {
          onState({
            state: 'error',
            message: msg
          });
        }
        return;
      }
    }

    // Transport-level RTMP(S) connection indicators.
    // FFmpeg logs "Output #0, flv, to 'rtmp..." or "Stream mapping:" when connection to destination succeeds.
    if (!connectionReported && /handshaking|connected|server version|output #0, flv|to 'rtmp|stream mapping:/i.test(lower)) {
      connectionReported = true;
      console.info(`[RELAY STEP 6/7] FFmpeg connected to RTMP destination! Handshake complete -> ${safeUrl}`);
      if (onState) {
        onState({
          state: 'connected',
          message: 'RTMP/RTMPS transport connected'
        });
      }
    }

    // FFmpeg emits periodic stats with frame=... .
    const frameMatch = line.match(/frame=\s*(\d+)/i);
    if (frameMatch) {
      lastFrameCount = Number(frameMatch[1]) || lastFrameCount;

      // If frames are being encoded and muxed, RTMP transport is definitely connected!
      if (!connectionReported) {
        connectionReported = true;
        console.info(`[RELAY STEP 6/7] FFmpeg connected to RTMP destination (confirmed via active frame output) -> ${safeUrl}`);
        if (onState) {
          onState({
            state: 'connected',
            message: 'RTMP/RTMPS transport connected'
          });
        }
      }

      if (!streamingReported && lastFrameCount >= 3) {
        streamingReported = true;
        console.info(`[RELAY STEP 7/7] 🔴 LIVE BROADCAST ACTIVE on YouTube! (Frame: ${lastFrameCount}, Bitrate: ${videoBitrate})`);
        if (onState) {
          onState({
            state: 'streaming',
            frame: lastFrameCount,
            message: 'FFmpeg is encoding and continuously publishing to the RTMP/RTMPS destination'
          });
        }
      } else if (lastFrameCount > 0 && lastFrameCount % 150 === 0) {
        console.info(`[RELAY HEALTH] Transmitted active broadcast: Frame=${lastFrameCount}, Bitrate=${videoBitrate}`);
      }
    }
  };

  proc.stderr.on('data', d => {
    const chunk = d.toString();
    processLog(chunk);
  });

  // Drain stdout even though FFmpeg normally writes diagnostics to stderr.
  proc.stdout.on('data', () => {});

  proc.on('error', err => {
    if (onLog) onLog(`[spawn error] ${err?.message || String(err)}\n`);
    if (onState) {
      onState({
        state: 'error',
        message: err?.message || String(err)
      });
    }
  });

  proc.on('exit', (code, signal) => {
    console.info(`[ffmpeg-stream] FFmpeg exited code=${code} signal=${signal}`);

    if (onState) {
      if (code === 0) {
        onState({
          state: 'stopped',
          message: 'FFmpeg stopped normally'
        });
      } else {
        onState({
          state: 'error',
          message: `FFmpeg exited before a clean stream shutdown (code=${code}, signal=${signal || 'none'})`
        });
      }
    }
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
  const customUrl = url.searchParams.get('rtmpUrl') || url.searchParams.get('customUrl') || '';
  const quality   = url.searchParams.get('quality') || '540p';
  const sessionId = url.searchParams.get('sessionId') || ('ws_' + Math.random().toString(36).slice(2, 9));
  const roomName  = url.searchParams.get('roomName') || sessionId;

  if (!streamKey) {
    ws.send(JSON.stringify({
      type: 'error',
      code: 'MISSING_STREAM_KEY',
      message: 'Stream key is required'
    }));
    ws.close(1008, 'Missing stream key');
    return;
  }

  let candidateUrls;
  try {
    candidateUrls = getCandidateRtmpUrls(platform, streamKey, customUrl);
  } catch (err) {
    ws.send(JSON.stringify({
      type: 'error',
      code: 'INVALID_RTMP_CONFIGURATION',
      message: err?.message || String(err)
    }));
    ws.close(1008, 'Invalid RTMP configuration');
    return;
  }

  // Use one deterministic destination. Automatic cross-protocol failover can
  // hide YouTube authentication/publish errors and can create duplicate streams.
  const rtmpUrl = candidateUrls[0];

  // Stop any prior stream in this room before accepting a new one.
  const existing = ffmpegStreams.get(roomName);
  if (existing?.ffmpeg) {
    console.warn(`[ffmpeg-stream] Replacing existing stream for room=${roomName}`);
    try { existing.ffmpeg.stdin.end(); } catch (_) {}
    try { existing.ffmpeg.kill('SIGTERM'); } catch (_) {}
    ffmpegStreams.delete(roomName);
    activeStreams.delete(roomName);
  }

  let ffmpegProc = null;
  let totalBytes = 0;
  let startedAt = 0;
  let firstChunk = null;
  let encodingStarted = false;
  let rtmpConnected = false;
  let streamingStarted = false;
  let stopping = false;
  let cleaned = false;

  const recentLogs = [];
  const sessionRecord = {
    sessionId,
    roomName,
    platform,
    targetUrl: maskStreamSecret(rtmpUrl, streamKey),
    startedAt: Date.now(),
    endedAt: null,
    totalBytes: 0,
    exitCode: null,
    state: 'starting',
    logs: recentLogs
  };

  recentStreamSessions.push(sessionRecord);
  if (recentStreamSessions.length > 10) recentStreamSessions.shift();

  const handleLog = (line) => {
    recentLogs.push(line);
    if (recentLogs.length > 100) recentLogs.splice(0, recentLogs.length - 100);
  };

  const send = payload => {
    if (ws.readyState === ws.OPEN) {
      try {
        ws.send(JSON.stringify(payload));
      } catch (_) {}
    }
  };

  const setStreamState = (state, extra = {}) => {
    sessionRecord.state = state;

    const current = activeStreams.get(roomName);
    if (current?.sessionId === sessionId || !current) {
      activeStreams.set(roomName, {
        sessionId,
        egressId: sessionId,
        platform,
        roomName,
        startedAt,
        status: state,
        method: 'ffmpeg-ws',
        updatedAt: Date.now(),
        ...extra
      });
    }
  };

  const handleState = (event) => {
    const state = event?.state;

    if (state === 'starting') {
      setStreamState('starting');
      send({
        type: 'ffmpeg-starting',
        sessionId,
        platform,
        message: 'FFmpeg started; waiting for RTMP/RTMPS connection'
      });
      return;
    }

    if (state === 'connected') {
      rtmpConnected = true;
      setStreamState('connected');
      send({
        type: 'rtmp-connected',
        sessionId,
        platform,
        url: maskStreamSecret(rtmpUrl, streamKey),
        message: 'RTMP/RTMPS transport connected. Waiting for stable media publishing.'
      });
      return;
    }

    if (state === 'streaming') {
      encodingStarted = true;
      streamingStarted = true;
      setStreamState('streaming', {
        frames: event.frame || 0,
        rtmpConnected: true
      });
      send({
        type: 'live',
        sessionId,
        platform,
        url: maskStreamSecret(rtmpUrl, streamKey),
        message: 'Media is being encoded and published to the RTMP/RTMPS destination',
        stats: {
          frame: event.frame || 0
        }
      });
      send({
        type: 'streaming',
        sessionId,
        platform,
        url: maskStreamSecret(rtmpUrl, streamKey),
        message: 'Media is being encoded and published to the RTMP/RTMPS destination',
        stats: {
          frame: event.frame || 0
        }
      });
      return;
    }

    if (state === 'error') {
      setStreamState('error', {
        error: event.message || 'FFmpeg/RTMP(S) error',
        rtmpConnected
      });
      send({
        type: 'error',
        code: rtmpConnected ? 'RTMP_PUBLISH_ERROR' : 'RTMP_CONNECTION_ERROR',
        sessionId,
        message: event.message || 'FFmpeg/RTMP(S) error'
      });
      return;
    }

    if (state === 'stopped') {
      setStreamState('stopped');
      if (!stopping) {
        send({
          type: 'stopped',
          sessionId,
          message: 'FFmpeg stopped'
        });
      }
    }
  };

  const startFfmpeg = (hasAudio = true) => {
    startedAt = startedAt || Date.now();

    console.info(
      `[RELAY STEP 5/7] FFmpeg child process spawned for session=${sessionId} platform=${platform} ` +
      `room=${roomName} hasAudio=${hasAudio} target=${maskStreamSecret(rtmpUrl, streamKey)}`
    );

    setStreamState('starting');
    ffmpegProc = spawnFfmpeg(rtmpUrl, handleLog, handleState, quality, hasAudio);

    ffmpegStreams.set(roomName, {
      ffmpeg: ffmpegProc,
      platform,
      streamKey,
      rtmpUrl,
      startedAt,
      sessionId,
      roomName,
      status: 'starting'
    });

    ffmpegProc.on('exit', (code, signal) => {
      sessionRecord.exitCode = code;
      sessionRecord.endedAt = Date.now();
      sessionRecord.totalBytes = totalBytes;
      sessionRecord.state = code === 0 ? 'stopped' : 'error';

      const current = ffmpegStreams.get(roomName);
      if (current?.sessionId === sessionId) {
        ffmpegStreams.delete(roomName);
      }

      const active = activeStreams.get(roomName);
      if (active?.sessionId === sessionId) {
        if (code === 0 || stopping) {
          activeStreams.delete(roomName);
        } else {
          activeStreams.set(roomName, {
            ...active,
            status: 'error',
            error: 'FFmpeg exited unexpectedly',
            endedAt: sessionRecord.endedAt
          });
        }
      }

      if (ws.readyState === ws.OPEN && !stopping) {
        const finalLogs = recentLogs
          .filter(Boolean)
          .join(' ')
          .trim();

        let errMsg = finalLogs.slice(-4000) || `FFmpeg exited with code ${code}`;
        if (/end of file|error in the pull function|cannot open connection/i.test(finalLogs)) {
          errMsg = 'YouTube closed the connection (End of file / Inactive Stream Key). In YouTube Studio (studio.youtube.com), ensure your live stream is active, click "Reset" next to your Stream Key, copy the new key, and try again.';
        }

        console.error(`[RELAY ERROR] FFmpeg exited (code=${code}, signal=${signal}): ${errMsg}`);

        send({
          type: 'error',
          code: rtmpConnected ? 'FFMPEG_EXITED' : 'RTMP_CONNECTION_FAILED',
          sessionId,
          message: errMsg
        });
      }
    });

    ffmpegProc.on('error', err => {
      sessionRecord.state = 'error';
      sessionRecord.error = err?.message || String(err);
      console.error(`[RELAY ERROR at STEP 5] FFmpeg spawn error:`, err?.message || err);
    });

    return ffmpegProc;
  };

  send({
    type: 'ready',
    sessionId,
    platform,
    roomName,
    quality,
    message: 'WebSocket connected. Send the first complete MediaRecorder WebM chunk.'
  });

  console.info(`[RELAY STEP 1/7] Client WebSocket connection accepted (sessionId=${sessionId}, platform=${platform}, room=${roomName})`);
  console.info(`[RELAY STEP 2/7] Resolved candidate RTMP target: ${maskStreamSecret(rtmpUrl, streamKey)}`);
  console.info(`[RELAY STEP 3/7] Waiting for first MediaRecorder chunk from browser client...`);

  let isStdinPaused = false;

  ws.on('message', (chunk, isBinary) => {
    if (!isBinary && typeof chunk === 'string') {
      // Ignore text control messages sent accidentally by the browser.
      return;
    }

    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (!buffer.length) return;

    // Start FFmpeg on the first media chunk. That chunk must contain the
    // WebM/EBML header produced by MediaRecorder.
    if (!ffmpegProc) {
      startedAt = Date.now();
      firstChunk = Buffer.from(buffer);
      const hasAudio = detectAudioInWebM(firstChunk);
      if (hasAudio) {
        console.info(`[RELAY STEP 4/7] First media chunk received (${buffer.length} bytes). Audio track verified (A_OPUS/Audio). Spawning FFmpeg child process...`);
      } else {
        console.warn(`[RELAY STEP 4/7] ⚠️ First media chunk received (${buffer.length} bytes) with NO audio track. Attaching synthetic silent stereo AAC audio generator for YouTube compliance.`);
      }
      ffmpegProc = startFfmpeg(hasAudio);

      send({
        type: 'started',
        sessionId,
        platform,
        hasAudio,
        message: 'First media chunk received; FFmpeg started'
      });
    }

    if (!ffmpegProc?.stdin?.writable) {
      return;
    }

    try {
      totalBytes += buffer.length;
      sessionRecord.totalBytes = totalBytes;

      // Keep a small copy of the first chunk for diagnostics/future restart.
      if (!firstChunk) firstChunk = Buffer.from(buffer);

      const accepted = ffmpegProc.stdin.write(buffer);
      if (!accepted && !isStdinPaused) {
        isStdinPaused = true;
        handleLog(`[backpressure] FFmpeg stdin high-water mark reached at ${totalBytes} bytes; pausing incoming socket\n`);
        try {
          if (typeof ws.pause === 'function') ws.pause();
          else if (ws._socket && typeof ws._socket.pause === 'function') ws._socket.pause();
        } catch (_) {}
        ffmpegProc.stdin.once('drain', () => {
          isStdinPaused = false;
          try {
            if (typeof ws.resume === 'function') ws.resume();
            else if (ws._socket && typeof ws._socket.resume === 'function') ws._socket.resume();
          } catch (_) {}
        });
      }
    } catch (err) {
      handleLog(`[stdin error] ${err?.message || String(err)}\n`);
      send({
        type: 'error',
        code: 'FFMPEG_STDIN_ERROR',
        sessionId,
        message: err?.message || String(err)
      });
    }
  });

  // Heartbeat pings keep the WS alive through proxies.
  const pingTimer = setInterval(() => {
    if (ws.readyState === ws.OPEN) {
      try { ws.ping(); } catch (_) {}
    } else {
      clearInterval(pingTimer);
    }
  }, 15000);

  const cleanup = (reason) => {
    if (cleaned) return;
    cleaned = true;
    stopping = true;
    clearInterval(pingTimer);
    try { ws._socket?.resume?.(); } catch (_) {}

    console.info(
      `[ffmpeg-stream] Closing sessionId=${sessionId} reason=${reason} bytes=${totalBytes} ` +
      `rtmpConnected=${rtmpConnected} streaming=${streamingStarted}`
    );

    sessionRecord.endedAt = Date.now();
    sessionRecord.totalBytes = totalBytes;

    if (ffmpegProc) {
      try { ffmpegProc.stdin.end(); } catch (_) {}
      setTimeout(() => {
        try {
          if (!ffmpegProc.killed) ffmpegProc.kill('SIGTERM');
        } catch (_) {}
      }, 1500);
    }

    const current = ffmpegStreams.get(roomName);
    if (current?.sessionId === sessionId) {
      ffmpegStreams.delete(roomName);
    }

    const active = activeStreams.get(roomName);
    if (active?.sessionId === sessionId) {
      activeStreams.delete(roomName);
    }
  };

  ws.on('close', () => cleanup('websocket closed'));
  ws.on('error', err => {
    console.warn('[ffmpeg-stream] ws error:', err?.message || err);
    cleanup('websocket error');
  });
});

// ---- REST: stop a running ffmpeg stream ----
app.post('/api/stream/stop-ffmpeg', (req, res) => {
  const { roomName, sessionId } = req.body || {};

  let record = roomName ? ffmpegStreams.get(roomName) : null;
  let mapKey = roomName || null;

  if (!record && sessionId) {
    for (const [key, value] of ffmpegStreams.entries()) {
      if (value?.sessionId === sessionId) {
        record = value;
        mapKey = key;
        break;
      }
    }
  }

  if (record?.ffmpeg) {
    try { record.ffmpeg.stdin.end(); } catch (_) {}
    setTimeout(() => {
      try {
        if (!record.ffmpeg.killed) record.ffmpeg.kill('SIGTERM');
      } catch (_) {}
    }, 1500);

    if (mapKey) ffmpegStreams.delete(mapKey);
    if (mapKey) activeStreams.delete(mapKey);
  }

  return res.json({
    ok: true,
    status: 'stopped',
    found: !!record
  });
});

server.listen(PORT, () => {
  console.log(`🎤 Nirmal Karaoke web server: http://localhost:${PORT}`);
  console.log(`   LiveKit SFU: ${livekitConfigured() ? 'configured' : 'NOT configured'}`);
  console.log(`   RTMP Streaming: browser→WebSocket→FFmpeg→RTMP(S) (no LiveKit Egress needed)`);
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

