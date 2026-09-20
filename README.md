# Nirmal Karaoke — Final Web + LiveKit Edition

A browser-only karaoke studio and live duet app using Web Audio and LiveKit Cloud/SFU.

## Production architecture

```text
Chrome / Edge
  ├─ local file / karaoke player
  ├─ microphone
  └─ optional Windows/tab/system audio capture
          ↓
     Web Audio master bus
          ↓
   MediaStreamDestination
          ↓
  one 48 kHz stereo program track
          ↓
       LiveKit SFU
       /        \
  Audience     Duet
```

### Live audio fix

The host now publishes the actual `MediaStreamTrack` produced by the Web Audio `MediaStreamDestination`. The audience uses LiveKit's supported `RemoteAudioTrack.attach()` playback path and explicitly calls `room.startAudio()` from the Tune In interaction when the browser requires an audio unlock.

LiveKit documents direct publishing of `MediaStreamTrack`s, high-quality stereo audio presets, and `RemoteAudioTrack.attach()` for browser playback.

### System audio

System/browser audio remains browser-controlled. On supported Chrome/Edge desktop configurations, click **Share system sound**, choose an appropriate source in the browser picker and enable audio sharing. The captured audio is mixed into the same program track; the capture video is never published.

### Music from external URLs

The Web Audio graph can process media elements, but a cross-origin audio server must allow CORS for the browser to expose that media to Web Audio. A local uploaded file does not have this issue. If an external music provider does not send the required CORS header, use browser system/tab audio sharing for that playback source rather than expecting Web Audio to access the cross-origin element.

## Netlify deployment

The repository includes:

```text
netlify/
  functions/
    livekit-token.mjs
netlify.toml
```

Add these Netlify environment variables with **Functions/runtime scope**:

```env
LIVEKIT_URL=wss://YOUR-PROJECT.livekit.cloud
LIVEKIT_API_KEY=YOUR_LIVEKIT_API_KEY
LIVEKIT_API_SECRET=YOUR_LIVEKIT_API_SECRET
```

Never put the API secret in frontend JavaScript or commit a real secret to Git.

Deploy the repository to Netlify. Netlify will build the static site and deploy the token function automatically.

The function is available at:

```text
/.netlify/functions/livekit-token
```

The `/api/livekit/token` redirect is also included for compatibility.

## Local development

```bash
npm install
npm start
```

Then open `http://localhost:3000`.

For microphone/display capture in production, use HTTPS. Localhost is treated as a secure context by browsers.

## LiveKit Cloud

The frontend does not contain the LiveKit secret. The Netlify Function creates short-lived participant tokens for host, duet and audience roles.

## Latency

The application minimizes intentional buffering and uses music-oriented LiveKit settings with DTX/RED disabled. The audience requests a low playout delay where the browser exposes that control. Internet jitter and packet loss still require some receiver buffering; literal zero-latency delivery cannot be guaranteed by a web application.


## Independent audience audio/video

Every audience participant receives a token that permits publishing only `camera` and `microphone` tracks. The host token can also publish the mixed `screen_share_audio` program track. This means:
- the host microphone can be off while the audience microphone remains live;
- an audience member can turn their microphone off without turning their camera off;
- an audience member can turn their camera off without turning their microphone off;
- multiple audience/duet participants can publish microphone and camera simultaneously;
- the admin subscribes to remote audience microphone/camera tracks independently;
- audience clients subscribe to host/program audio and remote cameras, not other audience microphones, reducing feedback;
- the host can locally mute a guest, which sends a mute command to that guest and also mutes the host's local monitor;
- host camera is independent from host program audio.

LiveKit's current JS SDK supports `setMicrophoneEnabled`, `setCameraEnabled`, `publishTrack`, `TrackSubscribed`, and `RemoteTrack.attach()` for these flows.


### v10 core transport behavior
Go Live first establishes the LiveKit room. Program audio is published as a separate step and can be retried without destroying the room. Admin audience monitoring is local-only and consumes remote audience microphone tracks independently from the broadcast program mix.


### v11 stability model
The LiveKit transport is kept independent from the browser DSP engine. Remote audience monitoring is local-only. Program audio is a separate publication that can be retried without destroying the room.


## v12 core transport/audio fix
- Unified token endpoint at `/api/livekit/token` with Netlify-function fallback.
- The first host token joins the named room directly; LiveKit auto-creates rooms when the first participant joins, so Go Live does not depend on a separate Room Service pre-create call.
- Admin audience monitor treats every remote non-host audio publication as an audience microphone, avoiding fragile source/name filtering.
- Admin monitoring uses LiveKit `RemoteAudioTrack.attach()` and explicit `room.startAudio()` user-gesture unlock.
- Audience clients subscribe to host/program audio and cameras, not other audience microphones, preventing audience feedback loops.
- Host reconnect and token refresh are retried with backoff. Participant tokens use a 24-hour TTL; active LiveKit sessions are not terminated merely because the JWT clock expires.


## v14 core repair (2026-09-18)
- Rebuilt the admin audience microphone monitor around a dedicated local Web Audio graph.
- The monitor is unlocked from the actual admin click before remote subscriptions are reconciled, avoiding the delayed-autoplay race in previous versions.
- Remote non-host microphone publications are explicitly subscribed, including publications whose source metadata is missing.
- LiveKit RemoteAudioTrack media tracks are routed only to the admin monitor context; the program broadcast destination is never used for guest monitoring.
- Kept an HTMLAudioElement fallback if a browser cannot create a MediaStreamAudioSourceNode from the remote track.
- Go Live no longer depends on @livekit/protocol/RoomConfiguration in the token function. LiveKit auto-creates a room when the host connects.
- Unified the transport error path so program-audio/DSP preparation cannot tear down a successfully connected room.

### Stereo live audio
The browser live-program path is configured for 48 kHz, 2-channel stereo. LiveKit publishing uses `forceStereo: true` with the `musicHighQualityStereo`/`musicStereo` preset, DTX disabled, and RED disabled. The Web Audio master and system-audio buses are explicitly 2-channel so shared music is not intentionally published as mono.


## Live audio transport
The host program is published as 48 kHz stereo Opus with DTX/RED disabled. v18 uses a 96 kbps high-priority audio ceiling and leaves the audience receiver's audio jitter/playout handling adaptive instead of forcing an aggressive fixed delay. Cameras use lower bandwidth presets to protect music playback on mobile/variable networks.

## v19 Smooth Stereo Transport
The LiveKit transport is configured for continuous stereo music: 48 kHz, Opus at up to 128 kbps, DTX disabled, RED enabled, and high RTP priority. Admin and audience clients use separate publisher/subscriber peer connections.

Audience receivers use an adaptive playout controller based on LiveKit receiver jitter/loss statistics. The normal target is 100 ms and the controller temporarily increases to 160 or 240 ms only when network conditions justify it; it slowly reduces the delay after recovery. LiveKit's `RemoteTrack.setPlayoutDelay()` is used rather than a permanently large buffer.

The audience client also applies an audio-first video policy: when the receiver detects degraded conditions, the host camera is requested at the low quality layer so music has additional downstream bandwidth headroom.

## v24 audio/latency core
The browser receiver now uses LiveKit's supported `webAudioMix: { audioContext }` path with an interactive 48 kHz context and `RemoteAudioTrack.attach()` for the host program audio. The app does not build a second custom remote MediaStreamAudioSource graph. Receiver playout starts at 30 ms and adapts only after measured packet loss/jitter/concealment/stalls. Host program audio is published as a high-priority stereo audio track (128 kbps, RED on, DTX off, forceStereo on).

Lyrics use a reliable initial state plus an explicit `REQUEST_STAGE_STATE` recovery message for late joiners. Audience playback clock is interpolated locally from the host clock. Guest voice presets have an explicit apply function and mobile-safe buttons.
