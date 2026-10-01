import { AccessToken, RoomServiceClient, EgressClient, StreamProtocol } from 'livekit-server-sdk';

// Track rooms explicitly closed by host
const endedRooms = new Set();
// Track active external RTMP streaming egress instances (YouTube, Twitch, etc.)
const activeEgressStreams = new Map();

export default async (req) => {
  // Handle CORS preflight
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

  try {
    if (!['POST', 'GET'].includes(req.method)) {
      return json({ error: 'Method not allowed' }, 405);
    }

    const url = new URL(req.url);
    let body = {};
    if (req.method === 'POST') {
      body = await req.json().catch(() => ({}));
    }

    const pathname = url.pathname.toLowerCase();
    const action = String(body.action || url.searchParams.get('action') || '').trim().toLowerCase();
    const roomName = String(body.roomName || body.room_name || body.room || url.searchParams.get('room') || url.searchParams.get('roomName') || '').trim();
    const identity = String(body.identity || body.participant_identity || url.searchParams.get('identity') || '').trim();
    const role = String(body.role || url.searchParams.get('role') || 'audience').trim();

    const apiKey = String(body.apiKey || process.env.LIVEKIT_API_KEY || '').trim();
    const apiSecret = String(body.apiSecret || process.env.LIVEKIT_API_SECRET || '').trim();
    const livekitUrl = String(body.livekitUrl || process.env.LIVEKIT_URL || '').trim();

    if (!apiKey || !apiSecret || !livekitUrl) {
      return json({ error: 'Server configuration error: LiveKit credentials missing. Set LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET in Netlify environment variables, or enter them in the app settings.' }, 500);
    }

    const apiHost = livekitUrl.replace(/^wss:\/\//i, 'https://').replace(/^ws:\/\//i, 'http://').replace(/\/$/, '');
    let svc = null;
    let egressClient = null;
    try {
      svc = new RoomServiceClient(apiHost, apiKey, apiSecret);
      egressClient = new EgressClient(apiHost, apiKey, apiSecret);
    } catch (svcErr) {
      console.warn('[livekit-token] Service client init notice:', svcErr?.message || svcErr);
    }

    // -------------------------------------------------------------
    // 1. LiveKit Config Endpoint
    // -------------------------------------------------------------
    if (action === 'config' || pathname.endsWith('/config')) {
      return json({
        enabled: true,
        url: livekitUrl,
        mode: 'sfu',
        audio: {
          sampleRate: 48000,
          channels: 2,
          dtx: false,
          red: true,
          priority: 'audio-over-video'
        }
      });
    }

    // -------------------------------------------------------------
    // 2. End-Room Endpoint
    // -------------------------------------------------------------
    if (action === 'end_room' || action === 'end-room' || pathname.endsWith('/end-room')) {
      if (!roomName) return json({ error: 'roomName is required' }, 400);
      endedRooms.add(roomName);

      // Stop any running external RTMP streams for this room directly via LiveKit API
      if (egressClient) {
        try {
          const list = await egressClient.listEgress({ roomName });
          if (Array.isArray(list)) {
            for (const eg of list) {
              if (eg.status === 0 || eg.status === 1 || eg.status === 'EGRESS_STARTING' || eg.status === 'EGRESS_ACTIVE') {
                try { await egressClient.stopEgress(eg.egressId); } catch (_) {}
              }
            }
          }
        } catch (_) {}
      }
      activeEgressStreams.delete(roomName);

      if (svc) {
        try {
          await svc.deleteRoom(roomName);
        } catch (_) {}
      }
      return json({ ok: true, room: roomName, status: 'ended' }, 200);
    }

    // -------------------------------------------------------------
    // 3. Room Status Endpoint
    // -------------------------------------------------------------
    if (action === 'room_status' || action === 'room-status' || pathname.endsWith('/room-status')) {
      if (!roomName) return json({ error: 'room parameter required' }, 400);
      if (endedRooms.has(roomName)) {
        return json({ ok: true, room: roomName, active: false, status: 'ended' }, 200);
      }
      let active = false;
      if (svc) {
        try {
          const rooms = await svc.listRooms([roomName]);
          if (rooms && rooms.length > 0) active = true;
        } catch (_) {}
      }
      return json({ ok: true, room: roomName, active, status: active ? 'active' : 'idle' }, 200);
    }

    // -------------------------------------------------------------
    // 4. Multistream RTMP Egress Endpoints (YouTube, Twitch, Facebook)
    // -------------------------------------------------------------
    // A. Start External Stream
    if (action === 'start-egress' || action === 'start_egress' || pathname.endsWith('/start-egress')) {
      if (!roomName) return json({ error: 'roomName is required' }, 400);
      const platform = String(body.platform || 'youtube').toLowerCase();
      const streamKey = String(body.streamKey || body.key || '').trim();
      let customRtmpUrl = String(body.rtmpUrl || '').trim();

      if (!streamKey) {
        return json({ error: 'Stream Key is required to broadcast to ' + platform }, 400);
      }

      // Build platform destination RTMP endpoint
      let fullRtmpUrl = '';
      if (platform === 'youtube') {
        fullRtmpUrl = `rtmp://a.rtmp.youtube.com/live2/${streamKey}`;
      } else if (platform === 'twitch') {
        fullRtmpUrl = `rtmp://live.twitch.tv/app/${streamKey}`;
      } else if (platform === 'facebook') {
        fullRtmpUrl = `rtmps://live-api-s.facebook.com:443/rtmp/${streamKey}`;
      } else {
        if (!customRtmpUrl) return json({ error: 'Custom RTMP Server URL is required' }, 400);
        fullRtmpUrl = `${customRtmpUrl.replace(/\/$/, '')}/${streamKey}`;
      }

      if (!egressClient) {
        return json({ error: 'LiveKit Egress client is not available' }, 500);
      }

      try {
        console.info(`[Multistream] Starting RTMP Egress for room ${roomName} to ${platform}`);
        const streamOutput = {
          protocol: StreamProtocol.RTMP,
          urls: [fullRtmpUrl]
        };

        // Strategy: Try full composite (video + audio) first using 'speaker' layout.
        // Even with no video track, LiveKit renders a black background with audio —
        // which is accepted by YouTube. Fall back to audio-only if composite tier unavailable.
        let info;
        let usedLayout = 'speaker';
        try {
          info = await egressClient.startRoomCompositeEgress(roomName, streamOutput, {
            layout: 'speaker',
            audioOnly: false,
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
        const streamRecord = {
          egressId,
          roomName,
          platform,
          layout: usedLayout,
          startedAt: Date.now(),
          status: 'live'
        };
        activeEgressStreams.set(roomName, streamRecord);

        return json({
          ok: true,
          egressId,
          platform,
          layout: usedLayout,
          status: 'live',
          startedAt: streamRecord.startedAt
        }, 200);
      } catch (egressErr) {
        console.error('[Multistream Egress Error]', egressErr);
        const msg = String(egressErr?.message || egressErr);
        return json({
          ok: false,
          error: `LiveKit Egress service error: ${msg}. Make sure: 1) Egress is enabled on your LiveKit Cloud project, 2) Your plan supports Egress, 3) The room exists and has participants.`
        }, 502);
      }
    }

    // B. Stop External Stream
    if (action === 'stop-egress' || action === 'stop_egress' || pathname.endsWith('/stop-egress')) {
      const activeEgress = activeEgressStreams.get(roomName);
      let egressId = String(body.egressId || activeEgress?.egressId || '').trim();

      if (egressClient) {
        if (roomName) {
          try {
            const list = await egressClient.listEgress({ roomName });
            if (Array.isArray(list)) {
              for (const eg of list) {
                if (eg.status === 0 || eg.status === 1 || eg.status === 'EGRESS_STARTING' || eg.status === 'EGRESS_ACTIVE') {
                  try { await egressClient.stopEgress(eg.egressId); } catch (_) {}
                }
              }
            }
          } catch (listErr) {
            console.warn('[Multistream listEgress fallback notice]:', listErr?.message || listErr);
          }
        }
        if (egressId) {
          try {
            await egressClient.stopEgress(egressId);
          } catch (stopErr) {
            console.warn('[Multistream stopEgress notice]:', stopErr?.message || stopErr);
          }
        }
      }

      if (roomName) activeEgressStreams.delete(roomName);
      return json({ ok: true, status: 'stopped' }, 200);
    }

    // Route stop-ffmpeg action so it does not fail with missing token parameters
    if (action === 'stop-ffmpeg' || action === 'stop_ffmpeg' || pathname.endsWith('/stop-ffmpeg')) {
      return json({ ok: true, status: 'stopped', message: 'FFmpeg relay runs on Node backend relay server.' }, 200);
    }

    // C. External Stream Status
    if (action === 'stream-status' || action === 'stream_status' || pathname.endsWith('/stream-status') || pathname.endsWith('/status')) {
      const activeEgress = activeEgressStreams.get(roomName);
      return json({
        ok: true,
        active: !!activeEgress,
        stream: activeEgress || null
      }, 200);
    }

    // -------------------------------------------------------------
    // 5. Token Issuance (Default for /api/livekit/token)
    // -------------------------------------------------------------
    if (!roomName || !identity) {
      return json({ error: 'roomName and identity are required' }, 400);
    }
    if (!['host', 'duet', 'audience'].includes(role)) {
      return json({ error: 'Invalid role' }, 400);
    }

    // If room was explicitly ended by host, inform audience/duet
    if (endedRooms.has(roomName) && role !== 'host') {
      return json({
        error: 'This live broadcast has ended or is discontinued by the host.',
        roomEnded: true,
        discontinued: true,
        room: roomName
      }, 410);
    }

    // If host is re-creating or joining the room, unmark ended
    if (role === 'host') {
      endedRooms.delete(roomName);
    }

    // Generate JWT token with full room permissions
    const token = new AccessToken(apiKey, apiSecret, {
      identity,
      name: identity,
      ttl: '24h'
    });

    token.addGrant({
      roomJoin: true,
      room: roomName,
      canSubscribe: true,
      canPublish: true,
      canPublishData: true,
      canUpdateOwnMetadata: true
    });

    const jwt = await token.toJwt();

    return json({
      token: jwt,
      url: livekitUrl,
      server_url: livekitUrl,
      participant_token: jwt
    }, 200);
  } catch (error) {
    console.error('[livekit-token error]', error);
    return json({ error: error?.message || 'Unable to process LiveKit request' }, 500);
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
