# AGENTS.md — Nirmal Karaoke

Guide for AI coding agents (and humans) working in this repo. Read this before changing anything.
Keep it current: if you change architecture, deployment or a gotcha below, update this file.

## What this project is

A browser-only **karaoke studio + live broadcast app**. A host sings over a backing track (local file,
JioSaavn search, tab/system audio), applies real-time voice effects and Auto-Tune, and goes **live**:
audience members (desktop/mobile) watch/listen, chat, request songs, or join the stage as **duet**
singers. The host can also restream to YouTube/Twitch/Facebook (RTMP) and can feed the studio mix to
a call app (Zoom/Meet) through a virtual audio cable.

There is no bundler and no framework: plain HTML pages + native ES modules + CSS. No tests exist.

## Architecture at a glance

```
Browser (host)  index.html + js/app.js ──► Web Audio engine ──► program track (48 kHz stereo)
                      │                                                │
                      │ presence (SSE + REST)                          ▼
                      ▼                                          LiveKit Cloud (SFU)  ◄── audience.html (viewers / duet guests)
        Render: server.js (Express) ◄── netlify.toml proxies/functions (fallback)
          • /api/presence/*  real-time user directory + invites (in-memory, SSE)
          • /api/livekit/token, end-room, room-status
          • /api/stream/*    RTMP relay (WebSocket → FFmpeg → YouTube/Twitch/…)
          • /api/music/*, /api/saavn/*   music search (JioSaavn)
Netlify: serves the static site (dist/) + 3 serverless functions (token, presence, music-search)
Vercel:  unofficial JioSaavn API proxy (jiosaavn-api-main-mu.vercel.app) used by music search
LRCLIB (lrclib.net): synced lyrics, queried straight from the browser
```

| Service | Role | Where in code |
|---|---|---|
| **Netlify** | Hosts the frontend (`dist/`), functions, redirects, cache headers | `netlify.toml`, `scripts/build-netlify.mjs`, `netlify/functions/*` |
| **Render** | Always-on Node server (Docker, FFmpeg). **Primary presence/invite backend**, RTMP relay | `server.js`, `Dockerfile`, `render.yaml` |
| **LiveKit Cloud** | Real-time audio/video between host, audience and duet guests | `js/livekit-host.js`, `audience.html`, token in `server.js` + `netlify/functions/livekit-token.mjs` |
| **Vercel** | JioSaavn data proxy | `js/config.js` (`SAAVN_API_URLS`), `netlify.toml` `/api/saavn/*` |

Production frontend (Netlify): primary domain `https://nirmalkaraoke.site` (`www` redirects to it); the same site is also reachable at `https://nirmalkaraokeaivoicechanger.netlify.app` (canonical tags point at `.site`). Old URL: `https://precious-stardust-3d67c3.netlify.app`. Render backend:
`https://nirmal-karaoke.onrender.com` (also the default RTMP relay URL and presence origin).

### Key rule: Netlify functions are stateless
Each invocation can run on a different instance, so **never keep shared state in a function's memory**
(users, invites, "ended rooms"…). That caused random invite loss and random "broadcast ended" errors.
Shared/real-time state belongs in `server.js` (Render, single process) or in LiveKit itself.
`netlify/functions/presence.mjs` is only a fallback and is knowingly unreliable.

## Pages

| File | Purpose |
|---|---|
| `index.html` | **Home / landing page** (root URL; css/home.css, js/home.js). Describes every tool and links to the studio. Old studio bookmarks like `/#mixer` are redirected to `studio.html#mixer`. |
| `studio.html` | **Studio / host** (was index.html). Mixer, effects, Auto-Tune, lyrics, library, Go Live, lobby modal, multistream, call output. Driven by `js/app.js`. |
| `audience.html` | Viewer + duet guest page (very large inline `<script type="module">`, ~3000 lines). Connects to a room by `?room=<id>&role=audience|duet&autoJoin=1`. |
| `users.html` | Standalone "Live Singers" lobby (online users, invite, watch/join). |
| `about/`, `couples/`, `privacy/`, `terms/`, `contact/`, `voice-changer-for-zoom-discord/` (each `index.html`) | Static info pages for SEO / AdSense trust. Use `/css/style.css` + `home.css` + `pages.css` (`nk-*` classes) and only `/js/home.js` (burger menu). No studio JS, no donation UI. Canonicals, sitemap, OG tags and JSON-LD use the production domain `https://nirmalkaraoke.site`; if the domain changes, `grep -r nirmalkaraoke.site` and replace. |
| `googleb691adf1eb31de8a.html`, `sitemap.xml`, `robots.txt` | SEO/verification files. |

Mobile uses a tabbed layout (`.mobile-screen` sections with `data-screen-group`, switched by
`body[data-mobile-screen]`; CSS in `css/style.css` ~line 31). **A card must belong to exactly one group
unless you really want it duplicated** (it used to be duplicated between Mixer and Effects).

## JavaScript map (`js/`)

| Module | Responsibility |
|---|---|
| `app.js` | Entry for index.html: wires every control, Go Live UI, lobby, Reset-all, call output setup. Exposes `window.audioEngine/presence/visualizer/searchManager/callOutput/resetAllSettings` (handy for debugging/tests). |
| `audio-engine.js` | Web Audio graph (`AudioEngine`): mic → pro vocal chain → Auto-Tune worklet → FX → mix bus → reverb/echo → limiter → `dest` (program MediaStream) + local monitor. Backing track, system audio, guest bridging, recording. |
| `dsp-code.js` | AudioWorklet source as a string (`polyphonic-shifter`, `auto-tune`); loaded via a data URI. Also imported by audience.html. |
| `worklets/*` | Extra worklets loaded by URL (`native-pcm-player.js`). |
| `livekit-host.js` | `LiveKitLiveStreamHost`: create room (`sing-xxxxxxx`, identity `host-<room>`), publish program audio, audience monitoring, data messages, reconnect. Token fetch with endpoint fallbacks + connect retry. |
| `live-stream.js` | Thin facade over the host. |
| `presence-manager.js` | `PresenceManager`: profile (localStorage), SSE + heartbeat, invites, shared live state. See "Presence & invites". |
| `game-invite.js` | BGMI-style invite popup. |
| `name-prompt.js` | `ensureSingerName()`: one-time name modal, saved in the profile. |
| `lyrics.js` | `LyricsManager`: LRC parse/render/sync, LRCLIB search. `reset()` clears lyrics and broadcasts `[]`. |
| `music-search.js` | `MusicSearchManager`: JioSaavn search/queue/autoplay; triggers lyric fetch per track. |
| `visualizer.js` + `workers/visualizer.worker.js` | Stage visualizer. Drawing is done in an **OffscreenCanvas worker**; main thread only samples the analyser. Falls back to main-thread drawing. Audience visualizer in `audience.html` uses the same worker (`mode: 'audience'`). |
| `broadcast-compositor.js`, `multistream.js` | 1280×720 canvas scene + audio → MediaRecorder → WebSocket → server FFmpeg → RTMP. |
| `artist-tools.js` | Metronome, auto-ducking, peak/VU meter. |
| `call-output.js` | `CallOutputManager`: plays the finished program mix to a chosen output device (virtual cable) so call apps can use it as a mic. Desktop Chrome/Edge only (`setSinkId`). |
| `voice-fx.js` | **Voice modulator stage** (ring mod, vibrato/chorus, tremolo, bit-crush, echo) shared by the studio chain and the audience guest chain. A plain pass-through (no nodes in the path) unless the active preset sets `ringMix/vibMix/tremDepth/crushMix/echoMix`. |
| `soundboard.js` | Soundboard: built-in synth sounds + user uploads (IndexedDB `nirmal-karaoke/sounds`), per-sound volume, page-level hotkeys (`localStorage.nirmal_soundboard_keys`, `KeyboardEvent.code`), Stop all. Plays through the shared master bus in `sfx.js`. |
| `stats.js` | `StatsManager`: local-only usage stats (`localStorage.nirmal_stats_v1`): mic time, live time/broadcasts, songs, sounds, top voices. Counts via a 1 s tick and the `nirmal:sfx` event. |
| `face-filters.js`, `sfx.js`, `media-session.js`, `wake-lock.js`, `config.js` | Camera filters, built-in SFX + master sound bus (`getSfxMaster/stopAllSfx`), mobile background keep-alive, wake lock, presets/constants. |

`visualizer-engine.js` / `visualizer-worker.js` are stubs kept for compatibility.

## Presence & invites (read before touching)

- Primary backend: `server.js` `/api/presence/{stream,heartbeat,users,invite,respond-invite}`. On Netlify the
  client calls **Render directly** (cross-origin, CORS `*`); same-origin `/api/presence` (Netlify function) is
  only a fallback. Origin selection: `resolveApiOrigins()` in `presence-manager.js` (localhost/Render → same
  origin; otherwise `localStorage.nirmal_stream_relay_url` or the default Render URL).
- Each person has a profile in `localStorage.nirmal_singer_profile` `{id, name, avatar, named}`. `named:false`
  means the auto name `Singer_123`; Go Live / duet join asks for a name once (`ensureSingerName`).
- **Live state is shared across a person's own tabs** via `localStorage.nirmal_presence_state` (written by the
  studio page, restored by `users.html`/`audience.html` if < 30 s old). Without it, `users.html` overwrote the
  live record with "idle" and the person saw their own stage as someone to invite.
- Flow: A is live (real LiveKit room) → `presence.sendInvite(B)` (refuses if A is not live) → server pushes
  `invite_received` over SSE (poll fallback via heartbeat) → B sees the popup → accept →
  `respondInvite(true)` → B navigates to `audience.html?room=<A room>&role=duet&autoJoin=1` → one tap
  ("Join Live Stage Now", required for browser autoplay) → connects and auto-enables the mic. A gets
  `invite_response`. Only someone **actually live as host** auto-declines other rooms; an idle studio user accepts.
- Responses arrive over SSE *and* the next poll; `deliverInviteResponse` de-duplicates.
- Viewers/duet guests are `isLive:false` (they are in a room but are not a stage).

## LiveKit

- Roles: `host` (identity `host-<room>`), `duet`, `audience` (identity `guest-<uuid>`). Room ids are random
  `sing-xxxxxxx`. Token endpoint order (client): `/api/livekit/token` → `/.netlify/functions/livekit-token` →
  saved relay URL → Render. Tokens carry the singer's display `name`.
- The token function lets a non-host join only if LiveKit reports the room exists (ending a broadcast deletes
  the room). If LiveKit can't be queried it does **not** block. A 404 from an endpoint means "try the next one",
  not "ended"; 410 / `roomEnded` means ended.
- Connect is retried (3 attempts + SDK `maxRetries`). Program audio: 128 kbps stereo Opus, DTX off, published
  from the `dest` MediaStream track. Audience mics are monitored locally by the host only.

## Deployment

### Netlify (`netlify.toml`)
- Build command `node scripts/build-netlify.mjs` → publishes **`dist/`** (gitignored). It copies only the public
  frontend, stamps every local `.js/.css` reference with a per-deploy `?v=<commit>` (so assets can be cached
  `immutable`), and hoists the Google Fonts `@import` into `<link>` tags. Do **not** publish the repo root
  (it would expose `server.js`, `package.json`, notes…).
- Headers: `/js/*`, `/css/*` immutable; HTML revalidates. Redirects: `/api/livekit|presence|stream|music/*` →
  functions, `/api/saavn/*` → Vercel.
- `[dev] publish = "."` and `npm start` runs a non-fatal `prestart` build so previews that look for `dist/` work.
- When you add a new local module, reference it with a quoted relative path (`'./x.js?v=1'`); the build stamps it.

### Render (`render.yaml`, `Dockerfile`)
Docker, Node 22 + FFmpeg, `CMD node server.js`, health check `/api/health`. Needs `LIVEKIT_URL`,
`LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`. **Pushing to main does not guarantee Render redeploys server.js
changes — check.** Server-side changes (e.g. token `name` support) only take effect after Render redeploys.

### Environment variables
`LIVEKIT_URL` (wss://…livekit.cloud), `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` (Netlify function scope *and*
Render), optional `PORT`. There is no `.env` in the repo: **locally LiveKit is "not configured"**, so Go Live /
joining a room fails at the token step. That is expected in local dev.

## Local development

```bash
npm install
npm start            # builds dist/ (prestart), then node server.js on http://localhost:3000
```
`server.js` serves the repo root statically (not `dist/`) plus all `/api/*` routes, so presence, SSE and
music search work locally; LiveKit does not (no credentials).

### Testing tips (what has worked)
- **Two users locally:** open `http://localhost:3000` and `http://127.0.0.1:3000` — separate origins have
  separate localStorage, so they are two different users against the same presence server.
- **Fake microphone:** wrap `navigator.mediaDevices.getUserMedia` to return an oscillator-driven
  `MediaStreamDestination` stream, then click `#btnMic` (see git history/conversation for the snippet).
- **Perf profiling:** wrap `setInterval/setTimeout/requestAnimationFrame` to time callbacks; use the Long
  Animation Frames API; measure timer-delay jitter with the mic on.
- The Claude desktop browser pane blocks many external hosts (CDNs, ads, song art) → expect
  `ERR_CONNECTION_REFUSED` console noise that is unrelated to the app.
- Simulate "live" without LiveKit: `presence.updateLiveStatus({role:'host', roomId:'sing-test', roomName:'x', isLive:true})`.

## Gotchas (learned the hard way)

1. **Syntax-check ES modules correctly.** `node --check file.js` can treat `.js` as CommonJS and miss errors.
   Copy to a `.mjs` first: `cp js/app.js "$TEMP/x.mjs" && node --check "$TEMP/x.mjs"`. For inline scripts in
   `audience.html`/`users.html`, extract the last `<script type="module">` body and check that.
2. **Shell/Python escaping on Windows:** when editing via heredocs, `\\n` inside JS string literals turned into
   real newlines and broke the page. Prefer the editor tool for strings containing `\n`, and regexes with `\p{…}`
   or control characters. Always reload the page after JS edits.
3. **CRLF:** files are CRLF in the working tree. When editing with Python read with `newline=''`, normalise,
   then restore. Git warns about LF→CRLF; that is harmless.
4. **`node_modules/` is tracked in git** (≈14 MB) despite `.gitignore`; don't commit changes inside it.
   `Recording …mp4` was tracked and deleted in the working tree (uncommitted); `scratch/` is junk.
5. **Layout thrash kills FPS with the mic on.** Do not write DOM text or style at audio/telemetry rate and then
   read layout (`offsetParent`, `clientWidth`) in the same frame. Write only on change, cache visibility
   (IntersectionObserver / ResizeObserver), animate with `transform` not `width`, avoid `backdrop-filter` over
   animated canvases. The pitch HUD, VU meter and visualizer were fixed for this.
6. **Auto-Tune worklet cost:** pitch detection runs even when auto-tune is off (it feeds the HUD); the hop is
   4× longer while bypassed. Enabled auto-tune is still heavy (~40 % of a core in a Node benchmark).
7. **Silent keep-alive `<audio>`** (`media-session.js`) is mobile-only. On desktop it caused mixer contention and
   mic-only lag.
8. **"Start-up state" ≠ HTML defaults.** The app applies a preset on load (Retune Speed starts at 16, HTML says 20).
   Reset-all snapshots controls at the end of `initApp()`; keep that ordering if you add controls/handlers.
9. `audience.html` and `presence-manager.js` were calling methods that did not exist (`getUser`, `updateStatus`)
   and reassigning a `const` — grep for similar mismatches when changing shared objects.
10. Several `?v=NN` cache-busters in source are stale/mixed (the Netlify build overwrites them all). Don't rely on them locally.

## Features added recently (so you know they exist)

- Worker-based visualizers (admin + audience); forced-layout fixes; mobile-only keep-alive.
- Netlify `dist/` build with immutable caching; fonts preconnect; deferred CDN scripts.
- **Call output** card (Mixer, desktop): send the program mix to a virtual cable (VB-Cable / BlackHole).
- **Reset all** buttons (Mixer + Voice effects headers): restore every sound/effect/Auto-Tune control to start-up state.
- Lyrics: new song clears old lyrics (also on audience), stale searches ignored, search box prefilled with the song.
- Mobile: Auto-Tune card only in Effects; "Track & Karaoke Tools" card (`#trackToolsCard`) only in Mixer.
- Presence/invite rework, name prompt, LiveKit join reliability (see sections above).
- **Theme v2 (navy + sky blue, Inter / JetBrains Mono)**: tokens in `:root` of `css/style.css` (`--primary`, `--primary-hi`,
  `--primary-dim`, `--font-sans/-mono`, glows) plus a "THEME V2" override block at the end of that file. The legacy
  `--pink/--purple/--cyan` variable names remain as aliases of the new palette (`--pink` = primary blue, `--accent-pink` = red
  for live/record). `scripts/retheme-colors.py` is the one-off record of the old-pink/purple → blue remap. Reds are kept for
  live/record/error. Do not reintroduce neon pink/purple.
- **Voice lab**: 13 effect voices (Drone, Cyborg, Underwater, Ghost, Helium, Demon, Villain, Monster, Megaphone, Telephone,
  8-bit, Cave, Nervous), the 9 character voices, and a **Custom voice** builder (pitch, body/presence, grit, brightness, echo →
  `AudioEngine.applyCustomVoice`, saved in `localStorage.nirmal_custom_voice`). Presets may use the modulator fields listed in
  `voice-fx.js`; the audience guest chain applies them too.
- **Soundboard card** (Effects tab), **Mic boost & noise suppression + IN/OUT meters** (Mixer tab; engine nodes `nsHighpass →
  micBoostGain → (limiter only when boosting) → gateGain`; levels Off/Low/Medium/High drive the rumble filter, the browser
  `noiseSuppression` constraint and the noise gate), **Stats** card (Mixer tab). All are included in Reset all.
- **Character voices**: 9 original voice archetypes (Baritone, Romantic, Gravel, Announcer, Hero, Melody, Husky,
  Diva, Pop Star) in `PRESETS` (`js/config.js`) with buttons in the studio and audience pages. Presets are only
  `pitch` ratio + high/low cut + one EQ band + drive, applied by `AudioEngine.applyPreset` (host) and
  `applyGuestPreset` (audience). **Policy: do not add presets named after, or tuned to imitate, real people**
  (personality/publicity rights, and impersonation risk with the call-output feature).

## SEO + support message (added Oct 2026)

- Homepage has JSON-LD (WebSite, Organization, WebApplication, FAQPage). The FAQPage text must stay word-for-word equal
  to the visible `#faq` text: if you edit one, edit the other. `/users.html` is `noindex` and not in the sitemap.
- `scripts/build-netlify.mjs` has an explicit `FILES` list: **add every new HTML page/asset there** (it also decides which
  pages get the hoisted Google Fonts link), or it will not reach `dist/`. `_headers` (nosniff + referrer policy only, no CSP).
- `/studio` (no `.html`) works on Netlify but 404s on the Render Express server (no `extensions` option). The canonical uses `/studio`.
- **Support / donation (UPI + email)**: `js/donate.js` + `css/donate.css` (all classes `nkd-*`) + `donate/upi-qr.{svg,png}`
  (generated offline with `segno`, level M, encodes the exact `upi://pay?...` link). Loaded only by `index.html` and `studio.html`.
  Home: static top strip + bottom section (work without JS) and a modal after 10 s and (60 % scroll or 45 s). Studio: corner card
  after 5 min visible and 10 s without click/key. Caps in `localStorage.nk_support` `{lastShown, dismissCount, coffeeAt, stripHidden}`:
  7 days after a dismissal, never after 3, 30 days after copy/coffee, once per session. The script must **never** add a global
  `keydown` listener except while the popup is open (soundboard hotkeys). Idle detection uses `keyup` + `pointerdown`.
  Phones (`(hover:none) and (pointer:coarse)`) also get a floating "Buy me a coffee" `upi://` link after `PILL_AFTER_SEC` (300 s) of
  cumulative visible time (`sessionStorage.nkd_vis`, counted across pages); its own x sets `nk_support.pillHiddenAt` (7 days).

- **Couples** (Oct 2026): home section `#couples` (nav link + footer link) and the guide `/couples`; styles in `css/couples.css`
  (`nkc-*`, also loaded by index.html). Copy rules from the owner: only describe real features, never claim a private room,
  end-to-end encryption, anonymity, cloud-saved recordings, ratings or testimonials. The `/couples` FAQ text must stay equal to
  its FAQPage JSON-LD: edit both together. The room has no password or approval gate:
  anyone with the link can join and (participant link) publish mic/camera.

## Known limitations / ideas

- Not implemented on purpose: neural voice cloning / celebrity voices (consent + personality-rights + impersonation risk),
  AI music generation, Whisper dictation, system-wide hotkeys (a web page can only bind keys while focused).

- Phones cannot expose a virtual microphone to other apps; the call-output feature is desktop-only by design.
- Presence is in-memory on one Render process: restarting it clears the user list (clients re-register on the next heartbeat).
- Presence polling fallback every 3.5 s uses serverless invocations if SSE is down.
- No automated tests or linting; verify changes in the browser (see Testing tips).
- Audience page script is huge and inline; extracting it into modules would help maintainability.
- `server.js` is ~2000 lines and mixes presence, token, music and RTMP relay.

## Working agreements with the repo owner

- Make changes, **verify in the browser**, then **commit with a clear message** ending with the
  `Co-Authored-By` trailer your tool provides. **Ask before pushing to `main`** — the owner usually answers
  "push it". Netlify auto-deploys from `main`.
- Don't commit generated/temporary files (`dist/`, `.claude/launch.json`, test pages). Clean up temp test files.
- Prefer small, targeted fixes that don't break other features; keep UI text and behaviour consistent with the
  existing style (single-file-per-feature modules, inline styles for one-off dialogs).
- Report honestly what you could and could not test (e.g. real LiveKit audio cannot be tested locally).
