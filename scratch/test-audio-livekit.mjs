import fs from 'fs';

console.log('=== TEST: Comprehensive DOM & Contract Verification ===');

// Check index.html DOM Elements
const indexHtml = fs.readFileSync('index.html', 'utf8');
const indexElements = [
  'btnOpenDiagnostics',
  'diagnosticsModal',
  'btnCloseDiagnostics',
  'diagCtxState',
  'diagSampleRate',
  'diagBaseLatency',
  'diagOutputLatency',
  'diagChannels',
  'diagProgramLevel',
  'diagWorklets',
  'diagMonitorMode',
  'diagMicActive',
  'diagMicRate',
  'diagMicChannels',
  'diagLkState',
  'diagLkRoom',
  'diagLkAudience',
  'diagLkPubAudio',
  'diagLkDuets',
  'diagLkDuetMonitor',
  'diagRecState',
  'diagRecStream',
  'btnRecord',
  'sliderVol',
  'monitorToggle'
];

for (const id of indexElements) {
  if (!indexHtml.includes(`id="${id}"`)) {
    throw new Error(`index.html is missing expected element id="${id}"`);
  }
}
console.log('PASS: All index.html diagnostics HUD and audio controls verified ✅');

// Check audience.html DOM Elements
const audienceHtml = fs.readFileSync('audience.html', 'utf8');
const audienceElements = [
  'btnTuneIn',
  'btnLeaveStage',
  'btnRequestMic',
  'btnEnableMic',
  'btnToggleMute',
  'btnToggleCamera',
  'liveAudio',
  'duetNotice',
  'liveIndicator'
];

for (const id of audienceElements) {
  if (!audienceHtml.includes(`id="${id}"`)) {
    throw new Error(`audience.html is missing expected element id="${id}"`);
  }
}
console.log('PASS: All audience.html interaction and duet elements verified ✅');

// Verify AudioEngine exports & methods
const audioEngineJs = fs.readFileSync('js/audio-engine.js', 'utf8');
const engineMethods = [
  'isGraphComplete',
  'updateMonitorRouting',
  'setMasterVolume',
  'getRecordingStream',
  'getAudioDiagnostics',
  'applyPreset',
  'updateKey',
  'createBroadcastDestination',
  'bridgeGuestAudioTrack',
  'removeGuestAudioTrack',
  'setGuestAudioVolume'
];

for (const m of engineMethods) {
  if (!audioEngineJs.includes(m)) {
    throw new Error(`js/audio-engine.js is missing method ${m}`);
  }
}
console.log('PASS: All AudioEngine dual-bus and diagnostics methods verified ✅');

// Verify LiveKitHost methods & data handlers
const livekitHostJs = fs.readFileSync('js/livekit-host.js', 'utf8');
const lkMethods = [
  'approveDuetRequest',
  'rejectDuetRequest',
  'getLiveKitDiagnostics',
  'REQUEST_MIC',
  'APPROVE_MIC',
  'REJECT_MIC'
];

for (const m of lkMethods) {
  if (!livekitHostJs.includes(m)) {
    throw new Error(`js/livekit-host.js is missing ${m}`);
  }
}
console.log('PASS: All LiveKit host duet handling and diagnostics methods verified ✅');

// Verify app.js wires the new duet request handler and diagnostics HUD
const appJs = fs.readFileSync('js/app.js', 'utf8');
const appHooks = [
  'handleDuetRequest',
  'refreshDiagnosticsHUD',
  'openDiagnosticsHUD',
  'closeDiagnosticsHUD',
  'devicechange',
  'getRecordingStream'
];

for (const h of appHooks) {
  if (!appJs.includes(h)) {
    throw new Error(`js/app.js is missing hook ${h}`);
  }
}
console.log('PASS: All app.js duet modals, hardware listeners, and diagnostics HUD hooks verified ✅');

console.log('\nALL CONTRACT & ARCHITECTURE TESTS PASSED! 🎉');
