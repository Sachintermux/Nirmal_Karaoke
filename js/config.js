export const PRESETS = {
  normal: { pitch: 1.0000, lowCut: 20,  highCut: 20000, eqFreq: 1000, eqGain: 0,    drive: 0,   isBypass: true  },
  female: { pitch: 1.2599, lowCut: 80,  highCut: 16000, eqFreq: 3000, eqGain: 1.5, drive: 0,   isBypass: false },
  kid:    { pitch: 1.4983, lowCut: 100, highCut: 18000, eqFreq: 3500, eqGain: 2.0, drive: 0,   isBypass: false },
  deep:   { pitch: 0.7937, lowCut: 40,  highCut: 10000, eqFreq: 180,  eqGain: 1.2, drive: 0.3, isBypass: false },
  old:    { pitch: 0.8908, lowCut: 150, highCut: 5500,  eqFreq: 1400, eqGain:-1.5, drive: 0,   isBypass: false },
  angry:  { pitch: 0.9438, lowCut: 80,  highCut: 9500,  eqFreq: 2200, eqGain: 1.5, drive: 1.2, isBypass: false },
  sad:    { pitch: 0.8908, lowCut: 90,  highCut: 7500,  eqFreq: 900,  eqGain:-1.5, drive: 0,   isBypass: false },
  robot:  { pitch: 1.0000, lowCut: 350, highCut: 4000,  eqFreq: 1100, eqGain: 1.8, drive: 0.8, isBypass: false },
  radio:  { pitch: 1.0594, lowCut: 400, highCut: 3000,  eqFreq: 1500, eqGain: 1.2, drive: 0.6, isBypass: false },
  alien:  { pitch: 1.3348, lowCut: 120, highCut: 15000, eqFreq: 3800, eqGain: 1.5, drive: 0.5, isBypass: false },

  // ── Original character voices ────────────────────────────────────────────────
  // Styled by TONE (pitch shift, chest/presence EQ, band-limiting, grit). They are generic archetypes
  // and are deliberately NOT modelled on, or named after, any real person.
  // pitch ratios: -3 st = .8409, -2 = .8909, -1 = .9439, +1 = 1.0595, +2 = 1.1225, +3 = 1.1892, +4 = 1.2599
  baritone:  { pitch: 0.8409, lowCut: 55,  highCut: 9500,  eqFreq: 150,  eqGain: 3.0, drive: 0.15, isBypass: false }, // deep, resonant leading man
  romantic:  { pitch: 0.9439, lowCut: 65,  highCut: 11000, eqFreq: 260,  eqGain: 2.5, drive: 0.1,  isBypass: false }, // warm, smooth, close-mic
  veteran:   { pitch: 0.8909, lowCut: 90,  highCut: 6500,  eqFreq: 1800, eqGain: 2.0, drive: 1.0,  isBypass: false }, // gruff, gravelly elder
  announcer: { pitch: 0.9439, lowCut: 110, highCut: 8500,  eqFreq: 3000, eqGain: 2.5, drive: 0.3,  isBypass: false }, // crisp, authoritative broadcast
  hero:      { pitch: 1.0595, lowCut: 80,  highCut: 14000, eqFreq: 2800, eqGain: 2.0, drive: 0.1,  isBypass: false }, // bright, confident young lead
  melody:    { pitch: 1.1892, lowCut: 120, highCut: 16000, eqFreq: 3200, eqGain: 2.0, drive: 0,    isBypass: false }, // sweet, clear female lead
  husky:     { pitch: 1.0595, lowCut: 100, highCut: 8000,  eqFreq: 700,  eqGain: 2.5, drive: 0.5,  isBypass: false }, // breathy, smoky alto
  diva:      { pitch: 1.1225, lowCut: 130, highCut: 17000, eqFreq: 2600, eqGain: 3.0, drive: 0.25, isBypass: false }, // powerful, projecting
  popstar:   { pitch: 1.2599, lowCut: 150, highCut: 18000, eqFreq: 4000, eqGain: 2.5, drive: 0,    isBypass: false }, // glossy, airy pop vocal

  // ── Effect voices (use the voice modulator stage in js/voice-fx.js) ──────────────────────────────
  drone:      { pitch: 0.9439, lowCut: 250, highCut: 4500,  eqFreq: 1500, eqGain: 2,   drive: 0.6, ringHz: 30, ringMix: 0.85, isBypass: false },       // metallic ring-mod robot
  cyborg:     { pitch: 0.9439, lowCut: 200, highCut: 6500,  eqFreq: 2200, eqGain: 2.5, drive: 0.4, ringHz: 55, ringMix: 0.55, isBypass: false },       // half human, half machine
  underwater: { pitch: 0.9439, lowCut: 100, highCut: 1700,  eqFreq: 600,  eqGain: 2,   drive: 0,   vibHz: 5, vibDepth: 0.0035, vibMix: 1, isBypass: false }, // wobbly, muffled
  ghost:      { pitch: 0.9439, lowCut: 300, highCut: 9000,  eqFreq: 3000, eqGain: 2,   drive: 0,   vibHz: 6, vibDepth: 0.002, vibMix: 0.5, echoMs: 240, echoFb: 0.5, echoMix: 0.5, isBypass: false },
  helium:     { pitch: 1.7818, lowCut: 180, highCut: 18000, eqFreq: 3800, eqGain: 3,   drive: 0,   isBypass: false },                                  // +10 semitones
  demon:      { pitch: 0.63,   lowCut: 50,  highCut: 6000,  eqFreq: 140,  eqGain: 4,   drive: 1.2, vibHz: 3, vibDepth: 0.0015, vibMix: 0.4, echoMs: 90, echoFb: 0.35, echoMix: 0.3, isBypass: false },
  villain:    { pitch: 0.7492, lowCut: 50,  highCut: 7000,  eqFreq: 120,  eqGain: 4,   drive: 0.6, echoMs: 120, echoFb: 0.25, echoMix: 0.2, isBypass: false },
  monster:    { pitch: 0.5946, lowCut: 45,  highCut: 4500,  eqFreq: 110,  eqGain: 5,   drive: 1.5, ringHz: 20, ringMix: 0.25, isBypass: false },       // -9 semitones, growl
  megaphone:  { pitch: 1.0,    lowCut: 500, highCut: 3500,  eqFreq: 1800, eqGain: 4,   drive: 1.4, isBypass: false },
  telephone:  { pitch: 1.0,    lowCut: 400, highCut: 3000,  eqFreq: 1500, eqGain: 3,   drive: 0.2, crushSteps: 64, crushMix: 0.5, isBypass: false },
  retro8bit:  { pitch: 1.0,    lowCut: 200, highCut: 5000,  eqFreq: 2000, eqGain: 2,   drive: 0,   crushSteps: 16, crushMix: 1, isBypass: false },    // chiptune-style crunch
  cave:       { pitch: 0.9439, lowCut: 100, highCut: 5000,  eqFreq: 400,  eqGain: 1.5, drive: 0,   echoMs: 170, echoFb: 0.55, echoMix: 0.5, isBypass: false },
  nervous:    { pitch: 1.0595, lowCut: 120, highCut: 12000, eqFreq: 3000, eqGain: 1.5, drive: 0,   tremHz: 7, tremDepth: 0.7, isBypass: false },      // trembling voice
  stuffy:     { pitch: 0.9439, lowCut: 300, highCut: 4600,  eqFreq: 1150, eqGain: 5,   drive: 0.3, isBypass: false },                                  // comedy blocked-nose cold: -1 st, thin chest (HP), nasal bump, dull top, soft drive

  // User-built voice (rewritten by AudioEngine.applyCustomVoice from the Custom voice sliders)
  custom:     { pitch: 1.0,    lowCut: 60,  highCut: 16000, eqFreq: 3200, eqGain: 0,   drive: 0,   isBypass: false }
};

export const SCALE_MAP = {
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  melodicMinor: [0, 2, 3, 5, 7, 9, 11],
  pentatonicMajor: [0, 2, 4, 7, 9],
  pentatonicMinor: [0, 3, 5, 7, 10],
  blues: [0, 3, 5, 6, 7, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
  wholeTone: [0, 2, 4, 6, 8, 10],
  arabic: [0, 1, 4, 5, 7, 8, 11]
};

export const AUTOTUNE_PRESETS = {
  hardTune: {
    name: '⚡ Hard Tune (T-Pain / Trap)',
    speed: 0,
    flexTune: 0,
    humanize: 0,
    mode: 'classic',
    inputType: 'altoTenor',
    tracking: 0.88,
    formant: true,
    throat: 1.0,
    transpose: 0,
    detune: 0,
    vibrato: false,
    vibShape: 'sine',
    vibDepth: 0,
    vibRate: 5.5,
    vibDelay: 0,
    vibVariation: 0,
    mix: 1.0
  },
  modernPop: {
    name: '🎙️ Modern Pop Lead',
    speed: 16,
    flexTune: 20,
    humanize: 15,
    mode: 'modern',
    inputType: 'altoTenor',
    tracking: 0.85,
    formant: true,
    throat: 1.0,
    transpose: 0,
    detune: 0,
    vibrato: false,
    vibShape: 'sine',
    vibDepth: 0,
    vibRate: 5.5,
    vibDelay: 0,
    vibVariation: 0,
    mix: 1.0
  },
  subtlePolish: {
    name: '💎 Subtle Natural Polish',
    speed: 48,
    flexTune: 42,
    humanize: 38,
    mode: 'modern',
    inputType: 'altoTenor',
    tracking: 0.80,
    formant: true,
    throat: 1.0,
    transpose: 0,
    detune: 0,
    vibrato: false,
    vibShape: 'sine',
    vibDepth: 0,
    vibRate: 5.5,
    vibDelay: 0,
    vibVariation: 0,
    mix: 0.95
  },
  rnbSmooth: {
    name: '🌊 R&B Smooth Vibrato',
    speed: 24,
    flexTune: 28,
    humanize: 25,
    mode: 'modern',
    inputType: 'altoTenor',
    tracking: 0.85,
    formant: true,
    throat: 1.0,
    transpose: 0,
    detune: 0,
    vibrato: true,
    vibShape: 'sine',
    vibDepth: 25,
    vibRate: 5.4,
    vibDelay: 250,
    vibVariation: 20,
    mix: 1.0
  },
  acousticWarmth: {
    name: '🎸 Acoustic Warmth',
    speed: 75,
    flexTune: 55,
    humanize: 50,
    mode: 'modern',
    inputType: 'altoTenor',
    tracking: 0.75,
    formant: true,
    throat: 1.04,
    transpose: 0,
    detune: 0,
    vibrato: false,
    vibShape: 'sine',
    vibDepth: 0,
    vibRate: 5.5,
    vibDelay: 0,
    vibVariation: 0,
    mix: 0.85
  },
  classic5: {
    name: '🌟 Classic Auto-Tune 5',
    speed: 4,
    flexTune: 0,
    humanize: 0,
    mode: 'classic',
    inputType: 'altoTenor',
    tracking: 0.90,
    formant: false,
    throat: 1.0,
    transpose: 0,
    detune: 0,
    vibrato: false,
    vibShape: 'sine',
    vibDepth: 0,
    vibRate: 5.5,
    vibDelay: 0,
    vibVariation: 0,
    mix: 1.0
  },
  robotVocoder: {
    name: '🤖 Robot Vocoder',
    speed: 0,
    flexTune: 0,
    humanize: 0,
    mode: 'classic',
    inputType: 'instrument',
    tracking: 0.95,
    formant: false,
    throat: 0.92,
    transpose: 0,
    detune: 0,
    vibrato: true,
    vibShape: 'square',
    vibDepth: 45,
    vibRate: 7.5,
    vibDelay: 0,
    vibVariation: 0,
    mix: 1.0
  },
  deepMonster: {
    name: '🪐 Deep Throat / Monster',
    speed: 12,
    flexTune: 10,
    humanize: 10,
    mode: 'modern',
    inputType: 'lowMale',
    tracking: 0.85,
    formant: true,
    throat: 1.28,
    transpose: -12,
    detune: 0,
    vibrato: false,
    vibShape: 'sine',
    vibDepth: 0,
    vibRate: 5.5,
    vibDelay: 0,
    vibVariation: 0,
    mix: 1.0
  },
  hyperpop: {
    name: '🧚 Hyperpop Chipmunk',
    speed: 0,
    flexTune: 0,
    humanize: 0,
    mode: 'modern',
    inputType: 'soprano',
    tracking: 0.85,
    formant: true,
    throat: 0.82,
    transpose: 12,
    detune: 0,
    vibrato: true,
    vibShape: 'triangle',
    vibDepth: 30,
    vibRate: 6.8,
    vibDelay: 100,
    vibVariation: 15,
    mix: 1.0
  },
  liveSafe: {
    name: '🎤 Live Stage Safe',
    speed: 28,
    flexTune: 35,
    humanize: 25,
    mode: 'modern',
    inputType: 'altoTenor',
    tracking: 0.90,
    formant: true,
    throat: 1.0,
    transpose: 0,
    detune: 0,
    vibrato: false,
    vibShape: 'sine',
    vibDepth: 0,
    vibRate: 5.5,
    vibDelay: 0,
    vibVariation: 0,
    mix: 0.90
  }
};

export const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export const SAAVN_API_URLS = [
  "/api/saavn/song/?query=",
  "/api/music/search?query=",
  "https://jiosaavn-api-main-mu.vercel.app/song/?query="
];

export const TRENDING_SEARCH_TERMS = [
  "Latest Bollywood Hits",
  "Romantic Hindi Melodies",
  "Top Punjabi Party Hits",
  "90s Bollywood Evergreen Hits",
  "Bollywood Lo-Fi Chill",
  "Arijit Singh Best Songs"
];