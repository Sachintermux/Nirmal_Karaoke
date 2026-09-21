import { RoomServiceClient } from 'livekit-server-sdk';

// Global Lambda execution context memory for active users and invites
const activeUsers = new Map();
const activeInvites = new Map();
const inviteResponses = new Map(); // toUserId -> array of responses

const apiKey = process.env.LIVEKIT_API_KEY;
const apiSecret = process.env.LIVEKIT_API_SECRET;
const livekitUrl = process.env.LIVEKIT_URL;

let svc = null;
if (apiKey && apiSecret && livekitUrl) {
  const apiHost = livekitUrl.replace(/^wss:\/\//i, 'https://').replace(/^ws:\/\//i, 'http://').replace(/\/$/, '');
  try {
    svc = new RoomServiceClient(apiHost, apiKey, apiSecret);
  } catch (_) {}
}

function cleanupStale() {
  const now = Date.now();
  for (const [id, u] of activeUsers.entries()) {
    if (now - u.lastSeen > 40000) {
      activeUsers.delete(id);
    }
  }
  for (const [invId, inv] of activeInvites.entries()) {
    if (now > inv.expiresAt || now - inv.createdAt > 60000) {
      activeInvites.delete(invId);
    }
  }
}

async function getLiveRoomsFromLiveKit() {
  if (!svc) return [];
  try {
    const rooms = await svc.listRooms();
    return rooms || [];
  } catch (_) {
    return [];
  }
}

export default async (req) => {
  // CORS Preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
      }
    });
  }

  cleanupStale();

  try {
    const url = new URL(req.url);
    let body = {};
    if (req.method === 'POST') {
      body = await req.json().catch(() => ({}));
    }

    const pathname = url.pathname.toLowerCase();
    const action = String(body.action || url.searchParams.get('action') || '').trim().toLowerCase();

    // 1. GET USERS LIST
    if (pathname.endsWith('/users') || action === 'users') {
      const liveRooms = await getLiveRoomsFromLiveKit();
      
      // Inject LiveKit active broadcasting stages if not already in presence
      for (const r of liveRooms) {
        if (r.numParticipants > 0) {
          const alreadyHosted = Array.from(activeUsers.values()).some(u => u.roomId === r.name && (u.isLive || u.role === 'host'));
          if (!alreadyHosted) {
            const hostId = `host_${r.name}`;
            if (!activeUsers.has(hostId)) {
              activeUsers.set(hostId, {
                id: hostId,
                name: `Live Host (${r.name.slice(0, 8)})`,
                avatar: '🎤',
                role: 'host',
                roomId: r.name,
                roomName: 'Live Karaoke Stage',
                isLive: true,
                device: 'desktop',
                lastSeen: Date.now()
              });
            }
          }
        }
      }

      const usersList = Array.from(activeUsers.values()).map(u => ({
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

      return json({ ok: true, count: usersList.length, users: usersList });
    }

    // 2. HEARTBEAT / PRESENCE SYNC
    if (pathname.endsWith('/heartbeat') || action === 'heartbeat') {
      const { userId, name, avatar, role, roomId, roomName, isLive, device } = body;
      if (!userId) {
        return json({ error: 'userId is required' }, 400);
      }

      const existing = activeUsers.get(userId) || {};
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

      // Find any pending invites directed to this user
      const now = Date.now();
      const myPendingInvites = [];
      for (const [invId, inv] of activeInvites.entries()) {
        if (inv.toUserId === userId && inv.status === 'pending' && now <= inv.expiresAt) {
          myPendingInvites.push(inv);
        }
      }

      // Find any responses to invites sent by this user
      const myResponses = inviteResponses.get(userId) || [];
      if (myResponses.length > 0) {
        inviteResponses.delete(userId);
      }

      const usersList = Array.from(activeUsers.values()).map(u => ({
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

      return json({
        ok: true,
        users: usersList,
        pendingInvites: myPendingInvites,
        inviteResponses: myResponses
      });
    }

    // 3. SEND DUET / AUDIENCE INVITATION
    if (pathname.endsWith('/invite') || action === 'invite') {
      const { fromUser, toUserId, roomId, roomName, type } = body;
      if (!fromUser?.id || !toUserId) {
        return json({ error: 'fromUser and toUserId are required' }, 400);
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
          type: type || 'duet'
        },
        toUserId,
        roomId: roomId || fromUser.roomId || null,
        roomName: roomName || fromUser.roomName || 'Live Karaoke Stage',
        status: 'pending',
        createdAt: Date.now(),
        expiresAt: Date.now() + 18000
      };

      activeInvites.set(inviteId, invite);
      return json({ ok: true, inviteId, invite });
    }

    // 4. RESPOND TO INVITATION
    if (pathname.endsWith('/respond-invite') || action === 'respond-invite') {
      const { inviteId, responderId, accepted } = body;
      if (!inviteId) return json({ error: 'inviteId is required' }, 400);

      const inv = activeInvites.get(inviteId);
      if (!inv) {
        return json({ ok: false, error: 'Invite expired or not found' }, 404);
      }

      inv.status = accepted ? 'accepted' : 'declined';
      const senderId = inv.fromUser?.id;
      if (senderId) {
        const responderUser = activeUsers.get(responderId) || { id: responderId, name: 'Singer' };
        const resList = inviteResponses.get(senderId) || [];
        resList.push({
          inviteId,
          status: inv.status,
          accepted: !!accepted,
          responder: {
            id: responderUser.id,
            name: responderUser.name,
            avatar: responderUser.avatar || '🎤'
          },
          roomId: inv.roomId,
          type: inv.fromUser?.type || 'duet'
        });
        inviteResponses.set(senderId, resList);
      }

      return json({ ok: true, status: inv.status });
    }

    // 5. SSE STREAM FALLBACK (Initial handshake for Netlify)
    if (pathname.endsWith('/stream') || action === 'stream') {
      const userId = String(url.searchParams.get('userId') || '').trim();
      const name = String(url.searchParams.get('name') || 'Singer').trim();
      const avatar = String(url.searchParams.get('avatar') || '🎤').trim();
      const role = String(url.searchParams.get('role') || 'idle').trim();
      const roomId = String(url.searchParams.get('roomId') || '').trim() || null;
      const roomName = String(url.searchParams.get('roomName') || '').trim() || null;
      const isLive = url.searchParams.get('isLive') === '1' || url.searchParams.get('isLive') === 'true';
      const device = String(url.searchParams.get('device') || 'desktop').trim();

      if (userId) {
        activeUsers.set(userId, {
          id: userId,
          name,
          avatar,
          role,
          roomId,
          roomName,
          isLive,
          device,
          lastSeen: Date.now()
        });
      }

      const usersList = Array.from(activeUsers.values()).map(u => ({
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

      // In serverless, send immediate user_list chunk
      const sseContent = `event: user_list\ndata: ${JSON.stringify(usersList)}\n\n`;
      return new Response(sseContent, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    return json({ error: 'Endpoint not found' }, 404);
  } catch (err) {
    console.error('[presence function error]', err);
    return json({ error: err?.message || 'Presence function error' }, 500);
  }
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Cache-Control': 'no-store, no-cache, must-revalidate'
    }
  });
}
