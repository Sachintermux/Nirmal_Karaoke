# LiveKit SFU for Nirmal Karaoke

This folder is the media server side of the web-only architecture.

## Local test

1. Install Docker Desktop.
2. Change the development key in `livekit.yaml` if the server is exposed beyond your machine.
3. Run `docker compose up -d` from this directory.
4. For the browser app, set the Node server `.env`:

```env
LIVEKIT_URL=ws://YOUR_HOST:7880
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=secret
```

For a real public deployment, use `wss://` behind TLS and configure LiveKit's public WebRTC networking/TURN as appropriate for your infrastructure.

## Why SFU

The host uploads one program audio track. LiveKit forwards it to every listener. Duet singers publish their vocal tracks independently. This avoids the upload fan-out and renegotiation problems of the old peer-to-peer transport.

## Audio policy

Nirmal Karaoke publishes a 48 kHz stereo music-oriented Opus track with DTX disabled. The browser creates the host program track by mixing microphone, karaoke/media and supported Windows system/browser audio before publishing.
