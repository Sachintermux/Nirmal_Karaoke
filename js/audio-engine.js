import { PRESETS, SCALE_MAP } from './config.js?v=24';
import { dspWorkletCode } from './dsp-code.js?v=24';

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.bootPromise = null;
    this.engine = {};
    this.currentKey = 0;
    this.activeTabStream = null;
    this.activeTabNode = null;
    this.systemAudioStream = null;
    this.systemAudioNode = null;
    this.systemAudioCaptureSurface = null;
    this.systemAudioCapturesSpeakerMix = false;
    this.systemAudioLowLatency = true;
    this.nativeSystemNode = null;
    this.nativeSystemWorklet = null;
    this.nativeSystemBuffer = null;
    this.mediaElementSource = null;
    this.activeMicStream = null;
    this.activeMicNode = null;
    this.recorder = null;
    this.recChunks = [];
  }

  boot() {
    if (!this.bootPromise) {
      this.bootPromise = this._buildEngine().catch((err) => {
        this.bootPromise = null;
        throw err;
      });
    }
    return this.bootPromise;
  }

  makeDistortionCurve(amount) {
    const k = typeof amount === 'number' ? amount : 0;
    if (k <= 0) return null;
    const n_samples = 44100;
    const curve = new Float32Array(n_samples);
    const drive = Math.max(0.1, Math.min(k, 8));
    const norm = 1 / Math.sqrt(1 + drive);
    for (let i = 0; i < n_samples; ++i) {
      const x = (i * 2) / n_samples - 1;
      const y = x / Math.sqrt(1 + drive * x * x);
      curve[i] = y / norm;
    }
    return curve;
  }

  createReverbBuffer(audioCtx, duration = 2.0, decay = 2.0) {
    const rate = audioCtx.sampleRate;
    const length = Math.floor(rate * duration);
    const impulse = audioCtx.createBuffer(2, length, rate);
    const left = impulse.getChannelData(0);
    const right = impulse.getChannelData(1);
    for (let i = 0; i < length; i++) {
      const n = i / length;
      const mult = Math.pow(1 - n, decay);
      left[i] = ((Math.random() * 2) - 1) * mult;
      right[i] = ((Math.random() * 2) - 1) * mult;
    }
    return impulse;
  }

  async _buildEngine() {
    try {
      if (!this.ctx) {
        try {
          this.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive', sampleRate: 48000 });
        } catch (_) {
          this.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
        }
        const dataUri = "data:application/javascript;base64," + btoa(unescape(encodeURIComponent(dspWorkletCode)));
        await this.ctx.audioWorklet.addModule(dataUri);
        try {
          await this.ctx.audioWorklet.addModule('./js/worklets/native-pcm-player.js');
        } catch (workletErr) {
          console.warn('[Nirmal] native-pcm-player worklet optional load skipped:', workletErr?.message || workletErr);
        }
      }
      if (this.ctx.state === 'suspended') {
        await this.ctx.resume().catch(() => {});
      }

      const e = this.engine;
    if (!e.mediaGain) {
      // Pin an AudioNode to 2-ch stereo so no intermediate node collapses
      // the stereo field mid-graph. Silently ignores read-only nodes.
      const setStereo = (node) => {
        try { node.channelCount = 2; } catch (_) {}
        try { node.channelCountMode = 'explicit'; } catch (_) {}
        try { node.channelInterpretation = 'discrete'; } catch (_) {}
      };

      const sliderMediaVol = document.getElementById('sliderMediaVol');
      const sliderMicVol = document.getElementById('sliderMicVol');
      const autoTuneToggle = document.getElementById('autoTuneToggle');
      const vocalRemoverToggle = document.getElementById('vocalRemoverToggle');
      const fxRouteMedia = document.getElementById('fxRouteMedia');
      const fxRouteMic = document.getElementById('fxRouteMic');
      const airSlider = document.getElementById('sliderAir');
      const reverbToggle = document.getElementById('reverbToggle');
      const sliderReverb = document.getElementById('sliderReverb');
      const echoToggle = document.getElementById('echoToggle');
      const echoSlider = document.getElementById('sliderEcho');
      const volSlider = document.getElementById('sliderVol');
      const monitorToggle = document.getElementById('monitorToggle');
      const hudNote = document.getElementById('hudNote');
      const hudCoach = document.getElementById('hudCoach');
      const sliderGuideVol = document.getElementById('sliderGuideVol');

      e.mediaGain = this.ctx.createGain();
      e.mediaGain.gain.value = parseFloat(sliderMediaVol?.value || 1);

      e.micGain = this.ctx.createGain();
      e.micGain.gain.value = parseFloat(sliderMicVol?.value || 1);

      // Mic Analyser
      e.micAnalyser = this.ctx.createAnalyser();
      e.micAnalyser.fftSize = 256;
      e.micGain.connect(e.micAnalyser);

      // Auto-Tune Node & Pitch Detector
      e.autoTuneNode = new AudioWorkletNode(this.ctx, 'auto-tune', { outputChannelCount: [2] });
      e.autoTuneDry = this.ctx.createGain();
      e.autoTuneDry.gain.value = autoTuneToggle?.checked ? 0.0 : 1.0;
      e.autoTuneWet = this.ctx.createGain();
      e.autoTuneWet.gain.value = autoTuneToggle?.checked ? 1.0 : 0.0;

      const noteNames = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
      this._autoTuneTelemetryListeners = [];
      e.autoTuneNode.port.onmessage = (msg) => {
        const data = msg.data;
        if (!data) return;

        if (data.detectedFreq) {
          const midi = Math.round(69 + 12 * Math.log2(data.detectedFreq / 440));
          const note = noteNames[((midi % 12) + 12) % 12];
          const oct = Math.floor(midi / 12) - 1;
          if (hudNote) hudNote.textContent = `🎤 PITCH: ${note}${oct}`;

          const isAutoTuneOn = document.getElementById('autoTuneToggle')?.checked;
          if (data.targetFreq && hudCoach && isAutoTuneOn) {
            const diff = data.detectedFreq - data.targetFreq;
            if (Math.abs(diff) < 3.5) {
              hudCoach.textContent = `🎯 COACH: PERFECT (${note})`;
              hudCoach.style.color = "var(--accent-green)";
              hudCoach.style.borderColor = "rgba(0, 255, 136, 0.4)";
            } else if (diff < 0) {
              hudCoach.textContent = `⬆ COACH: FLAT (${note})`;
              hudCoach.style.color = "var(--accent-orange)";
              hudCoach.style.borderColor = "rgba(255, 153, 0, 0.4)";
            } else {
              hudCoach.textContent = `⬇ COACH: SHARP (${note})`;
              hudCoach.style.color = "var(--accent-pink)";
              hudCoach.style.borderColor = "rgba(255, 0, 127, 0.4)";
            }
          }
        }

        // Broadcast to all Pro X telemetry listeners (pitch needle, roll graph, HUD, piano keys)
        if (this._autoTuneTelemetryListeners && this._autoTuneTelemetryListeners.length) {
          for (let i = 0; i < this._autoTuneTelemetryListeners.length; i++) {
            try { this._autoTuneTelemetryListeners[i](data); } catch (_) {}
          }
        }
      };

      e.micGain.connect(e.autoTuneNode);
      e.autoTuneNode.connect(e.autoTuneWet);
      e.micGain.connect(e.autoTuneDry);
      e.micOutBus = this.ctx.createGain();
      e.autoTuneDry.connect(e.micOutBus);
      e.autoTuneWet.connect(e.micOutBus);

      // Backing Track Center Vocal Remover & Key Pitcher
      e.mediaPitcher = new AudioWorkletNode(this.ctx, 'polyphonic-shifter', { outputChannelCount: [2] });
      e.mediaVrDry = this.ctx.createGain();
      e.mediaVrDry.gain.value = vocalRemoverToggle?.checked ? 0.0 : 1.0;
      e.mediaVrWet = this.ctx.createGain();
      e.mediaVrWet.gain.value = vocalRemoverToggle?.checked ? 1.0 : 0.0;

      e.guideVocalGain = this.ctx.createGain();
      e.guideVocalGain.gain.value = parseFloat(sliderGuideVol?.value || 0);

      e.vrSplitter = this.ctx.createChannelSplitter(2);
      e.vrInvert = this.ctx.createGain();
      e.vrInvert.gain.value = -1.0;
      e.vrMix = this.ctx.createGain();
      e.vrMerger = this.ctx.createChannelMerger(2);

      e.vrSplitter.connect(e.vrMix, 0);
      e.vrSplitter.connect(e.vrInvert, 1);
      e.vrInvert.connect(e.vrMix);
      e.vrMix.connect(e.vrMerger, 0, 0);
      e.vrMix.connect(e.vrMerger, 0, 1);

      e.mediaGain.connect(e.mediaPitcher);
      e.mediaPitcher.connect(e.mediaVrDry);
      e.mediaPitcher.connect(e.vrSplitter);
      e.vrMerger.connect(e.mediaVrWet);
      e.mediaPitcher.connect(e.guideVocalGain);

      e.mediaOutBus = this.ctx.createGain();
      e.mediaVrDry.connect(e.mediaOutBus);
      e.mediaVrWet.connect(e.mediaOutBus);
      e.guideVocalGain.connect(e.mediaOutBus);

      // Voice Changer Matrix
      e.mediaToFx = this.ctx.createGain();
      e.mediaToFx.gain.value = fxRouteMedia?.checked ? 1.0 : 0.0;
      e.mediaToDry = this.ctx.createGain();
      e.mediaToDry.gain.value = fxRouteMedia?.checked ? 0.0 : 1.0;
      e.micToFx = this.ctx.createGain();
      e.micToFx.gain.value = fxRouteMic?.checked ? 1.0 : 0.0;
      e.micToDry = this.ctx.createGain();
      e.micToDry.gain.value = fxRouteMic?.checked ? 0.0 : 1.0;

      e.mediaOutBus.connect(e.mediaToFx);
      e.mediaOutBus.connect(e.mediaToDry);

      // Pro vocal channel: clean, low-latency processing applied to the microphone only.
      e.proInput = this.ctx.createGain();
      e.proComp = this.ctx.createDynamicsCompressor();
      e.proComp.threshold.value = -18;
      e.proComp.knee.value = 18;
      e.proComp.ratio.value = 3.5;
      e.proComp.attack.value = 0.006;
      e.proComp.release.value = 0.12;
      e.deEsser = this.ctx.createBiquadFilter();
      e.deEsser.type = 'peaking';
      e.deEsser.frequency.value = 6500;
      e.deEsser.Q.value = 2.2;
      e.deEsser.gain.value = -2.5;
      e.proPresence = this.ctx.createBiquadFilter();
      e.proPresence.type = 'peaking';
      e.proPresence.frequency.value = 3200;
      e.proPresence.Q.value = 0.8;
      e.proPresence.gain.value = 2;
      e.proSaturator = this.ctx.createWaveShaper();
      e.proSaturator.curve = this.makeDistortionCurve(2);
      e.proSaturator.oversample = '2x';
      e.proOutput = this.ctx.createGain();
      e.proInput.connect(e.proComp);
      e.proComp.connect(e.deEsser);
      e.deEsser.connect(e.proPresence);
      e.proPresence.connect(e.proSaturator);
      e.proWet = this.ctx.createGain();
      e.proDry = this.ctx.createGain();
      e.proWet.gain.value = 0.96;
      e.proDry.gain.value = 0.04;
      e.proSaturator.connect(e.proWet);
      e.proInput.connect(e.proDry);
      e.proWet.connect(e.proOutput);
      e.proDry.connect(e.proOutput);
      e.proOutput.connect(e.micToFx);
      e.proOutput.connect(e.micToDry);

      // Vocal noise gate: inserted into the microphone path so when the singer
      // is silent, vocal room noise is gated without muting the backing music.
      e.gateGain = this.ctx.createGain();
      e.gateGain.gain.value = 1.0;
      e.micOutBus.connect(e.gateGain);
      e.gateGain.connect(e.proInput);

      e.fxInBus = this.ctx.createGain();
      e.dryInBus = this.ctx.createGain();
      e.mediaToFx.connect(e.fxInBus);
      e.micToFx.connect(e.fxInBus);
      e.mediaToDry.connect(e.dryInBus);
      e.micToDry.connect(e.dryInBus);

      e.fxBypassGain = this.ctx.createGain();
      e.fxBypassGain.gain.value = 1.0;
      e.fxActiveGain = this.ctx.createGain();
      e.fxActiveGain.gain.value = 0.0;
      e.fxInBus.connect(e.fxBypassGain);
      e.fxInBus.connect(e.fxActiveGain);

      e.pitcher = new AudioWorkletNode(this.ctx, 'polyphonic-shifter', { outputChannelCount: [2] });
      e.hp = this.ctx.createBiquadFilter();
      e.hp.type = 'highpass';
      e.hp.frequency.value = 20;
      e.lp = this.ctx.createBiquadFilter();
      e.lp.type = 'lowpass';
      e.lp.frequency.value = 20000;
      e.formantEq = this.ctx.createBiquadFilter();
      e.formantEq.type = 'peaking';
      e.formantEq.Q.value = 0.8;
      e.waveshaper = this.ctx.createWaveShaper();
      e.waveshaper.oversample = '4x';

      e.fxActiveGain.connect(e.pitcher);
      e.pitcher.connect(e.hp);
      e.hp.connect(e.lp);
      e.lp.connect(e.formantEq);
      e.formantEq.connect(e.waveshaper);

      e.fxOutBus = this.ctx.createGain();
      e.waveshaper.connect(e.fxOutBus);
      e.fxBypassGain.connect(e.fxOutBus);

      // Mix Bus
      e.mixBus = this.ctx.createGain();
      e.fxOutBus.connect(e.mixBus);
      e.dryInBus.connect(e.mixBus);

      // System audio stays outside the vocal DSP chain so desktop/browser audio is preserved.
      e.systemAudioGain = this.ctx.createGain();
      e.systemAudioGain.gain.value = 1.0;
      // Keep loud desktop audio from slamming the master limiter when the
      // duet microphone arrives at the same time. This reduces pumping and
      // audible recovery gaps without changing the vocal chain.
      e.systemAudioComp = this.ctx.createDynamicsCompressor();
      e.systemAudioComp.threshold.value = -8;
      e.systemAudioComp.knee.value = 10;
      e.systemAudioComp.ratio.value = 2;
      e.systemAudioComp.attack.value = 0.01;
      e.systemAudioComp.release.value = 0.12;
      // Screen/system audio is already mastered by the source application. Avoid
      // inserting a dynamics compressor into the transport path: compression
      // can pump the music and consumes another processing stage. The final
      // master limiter still protects the combined karaoke output.
      e.systemAudioGain.connect(e.mixBus);

      // Air EQ
      e.airEq = this.ctx.createBiquadFilter();
      e.airEq.type = 'highshelf';
      e.airEq.frequency.value = 8500;
      e.airEq.gain.value = parseFloat(airSlider?.value || 2.0);
      e.mixBus.connect(e.airEq);

      // Studio Reverb Node
      e.reverbConvolver = this.ctx.createConvolver();
      e.reverbConvolver.buffer = this.createReverbBuffer(this.ctx);
      e.reverbGain = this.ctx.createGain();
      e.reverbGain.gain.value = reverbToggle?.checked ? parseFloat(sliderReverb?.value || 0.35) : 0.0;
      e.airEq.connect(e.reverbConvolver);
      e.reverbConvolver.connect(e.reverbGain);

      // Space Echo Delay
      e.echoTap = this.ctx.createGain();
      e.echoTap.gain.value = echoToggle?.checked ? 1.0 : 0.0;
      e.echoDelay = this.ctx.createDelay(1.0);
      e.echoDelay.delayTime.value = parseFloat(echoSlider?.value || 0.22);
      e.echoFeed = this.ctx.createGain();
      e.echoFeed.gain.value = 0.25;
      e.echoDamp = this.ctx.createBiquadFilter();
      e.echoDamp.type = 'lowpass';
      e.echoDamp.frequency.value = 3000;

      e.airEq.connect(e.echoTap);
      e.echoTap.connect(e.echoDelay);
      e.echoDelay.connect(e.echoDamp);
      e.echoDamp.connect(e.echoFeed);
      e.echoFeed.connect(e.echoDelay);

      // Master Stage
      e.masterGain = this.ctx.createGain();
      e.masterGain.gain.value = parseFloat(volSlider?.value || 1);
      e.airEq.connect(e.masterGain);
      e.reverbGain.connect(e.masterGain);
      e.echoDelay.connect(e.masterGain);

      e.limiter = this.ctx.createDynamicsCompressor();
      e.limiter.threshold.value = -1.0;
      e.limiter.knee.value = 5.0;
      e.limiter.ratio.value = 8.0;
      e.limiter.attack.value = 0.005;
      e.limiter.release.value = 0.1;
      e.analyser = this.ctx.createAnalyser();
      e.analyser.fftSize = 512;
      e.analyser.smoothingTimeConstant = 0.8;

      e.programOut = this.ctx.createGain();
      e.programOut.gain.value = 1.35;

      e.masterGain.connect(e.limiter);
      e.limiter.connect(e.programOut);

      // Final live program bus: explicitly create a 2-channel, discrete stereo
      // WebRTC source. Using the MediaStreamAudioDestinationNode constructor
      // with explicit channelCount avoids relying on browser defaults. MDN
      // documents that this node's stream carries the same number of channels
      // as the destination node.
      try {
        e.dest = new MediaStreamAudioDestinationNode(this.ctx, {
          channelCount: 2,
          channelCountMode: 'explicit',
          channelInterpretation: 'discrete'
        });
      } catch (_) {
        e.dest = this.ctx.createMediaStreamDestination();
        try {
          e.dest.channelCount = 2;
          e.dest.channelCountMode = 'explicit';
          e.dest.channelInterpretation = 'discrete';
        } catch (_) {}
      }
      e.stereoOutputBus = this.ctx.createGain();
      try {
        e.stereoOutputBus.channelCount = 2;
        e.stereoOutputBus.channelCountMode = 'explicit';
        e.stereoOutputBus.channelInterpretation = 'discrete';
      } catch (_) {}

      // A final splitter/merger pins the left/right channels independently and
      // prevents any intermediate speakers-style remapping from collapsing the
      // music program to mono before WebRTC publication.
      e.stereoSplit = this.ctx.createChannelSplitter(2);
      e.stereoMerge = this.ctx.createChannelMerger(2);
      e.stereoMerge.channelCountMode = 'explicit';
      e.stereoMerge.channelInterpretation = 'discrete';
      e.stereoSplit.connect(e.stereoMerge, 0, 0);
      e.stereoSplit.connect(e.stereoMerge, 1, 1);
      e.monitorGain = this.ctx.createGain();
      e.monitorGain.gain.value = monitorToggle?.checked ? 1.0 : 0.0;

      e.programOut.connect(e.stereoOutputBus);
      e.stereoOutputBus.connect(e.stereoSplit);
      e.stereoMerge.connect(e.analyser);
      e.stereoMerge.connect(e.dest);
      e.stereoMerge.connect(e.monitorGain);
      e.monitorGain.connect(this.ctx.destination);

      // Fix A: pin every intermediate node to 2-ch explicit/discrete so the
      // stereo field is never collapsed mid-graph.  Splitter/merger nodes
      // intentionally excluded — their channel counts are fixed by
      // construction and must not be overridden.
      [
        e.mediaGain, e.micGain, e.micAnalyser,
        e.autoTuneDry, e.autoTuneWet, e.micOutBus,
        e.mediaVrDry, e.mediaVrWet, e.guideVocalGain,
        e.vrInvert, e.vrMix,
        e.mediaToFx, e.mediaToDry, e.micToFx, e.micToDry,
        e.mediaOutBus,
        e.proInput, e.proComp, e.deEsser, e.proPresence,
        e.proSaturator, e.proWet, e.proDry, e.proOutput,
        e.gateGain,
        e.fxInBus, e.dryInBus,
        e.fxBypassGain, e.fxActiveGain,
        e.hp, e.lp, e.formantEq, e.waveshaper,
        e.fxOutBus, e.mixBus,
        e.systemAudioGain, e.systemAudioComp,
        e.airEq,
        e.reverbConvolver, e.reverbGain,
        e.echoTap, e.echoDelay, e.echoFeed, e.echoDamp,
        e.masterGain, e.limiter, e.analyser,
        e.programOut, e.stereoOutputBus, e.monitorGain
      ].forEach(n => { if (n) setStereo(n); });

      const dspLed = document.getElementById('led-dsp');
      if (dspLed) dspLed.classList.add('active-blue');

      this.startGateAndVoiceAssists();
      this.updateAutoTuneSettings();
    }
  } catch (err) {
    console.error('[Nirmal] AudioEngine boot failed, cleaning up state:', err);
    try {
      if (this.ctx && typeof this.ctx.close === 'function') {
        await this.ctx.close().catch(() => {});
      }
    } catch (_) {}
    this.ctx = null;
    this.engine = {};
    this.bootPromise = null;
    throw err;
  }
}

  async startSystemAudioShare() {
    await this.boot();
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error('System audio sharing is not available in this browser. Use a recent Chrome/Edge desktop browser.');
    }
    this.stopSystemAudioShare();

    // Browsers expose system audio through the display-capture picker. The user must
    // explicitly select a screen/window/tab and enable its audio-sharing option.
    const supported = navigator.mediaDevices.getSupportedConstraints?.() || {};
    const captureAudio = {
      channelCount: { ideal: 2 },
      sampleRate: { ideal: 48000 },
      sampleSize: { ideal: 16 },
      // Ultra-low-latency hint for the browser's display-audio capture stage.
      // Chromium may ignore this constraint; it must never be treated as a
      // guarantee. Do not enable speech-oriented echo/noise processing.
      latency: { ideal: 0.005 },
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false
    };

    const stream = await navigator.mediaDevices.getDisplayMedia({
      // Keep video capture light because the application only uses the audio track.
      video: { frameRate: 1 },
      audio: captureAudio,
      systemAudio: 'include',
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
      windowAudio: 'window',
      monitorTypeSurfaces: 'include'
    });

    const audioTracks = stream.getAudioTracks();
    if (!audioTracks.length) {
      stream.getTracks().forEach((track) => track.stop());
      throw new Error('No system audio was shared. In the browser picker, enable Share audio/System audio before confirming.');
    }

    this.systemAudioStream = stream;
    try {
      const systemTrack = audioTracks[0];
      systemTrack.contentHint = 'music';
      await systemTrack.applyConstraints({ channelCount: { ideal: 2 }, latency: { ideal: 0.005 } }).catch(() => {});
    } catch (_) {}

    // A full-monitor capture with system audio captures the computer's final
    // speaker mix. That mix can contain LiveKit guest audio and the local mic
    // monitor, so feeding it back into the karaoke bus would duplicate/loop
    // those signals. Keep the information available for diagnostics and let
    // the host UI know which surface was selected.
    const displaySurface = stream.getVideoTracks()[0]?.getSettings?.().displaySurface || 'unknown';
    this.systemAudioCaptureSurface = displaySurface;
    this.systemAudioCapturesSpeakerMix = displaySurface === 'monitor';

    this.systemAudioNode = this.ctx.createMediaStreamSource(stream);
    // Preserve stereo when the browser supplies 2 channels and upmix mono
    // sources to L/R when the capture provider only exposes one channel.
    try {
      this.systemAudioNode.channelCount = 2;
      this.systemAudioNode.channelCountMode = 'explicit';
      this.systemAudioNode.channelInterpretation = 'discrete';
    } catch (_) {}
    try {
      this.engine.systemAudioGain.channelCount = 2;
      this.engine.systemAudioGain.channelCountMode = 'explicit';
      this.engine.systemAudioGain.channelInterpretation = 'discrete';
    } catch (_) {}
    this.systemAudioNode.connect(this.engine.systemAudioGain);

    const videoTrack = stream.getVideoTracks()[0];
    if (videoTrack) videoTrack.addEventListener('ended', () => this.stopSystemAudioShare(), { once: true });
    audioTracks[0].addEventListener('ended', () => this.stopSystemAudioShare(), { once: true });
    return stream;
  }

  stopSystemAudioShare() {
    if (this.systemAudioNode) {
      try { this.systemAudioNode.disconnect(); } catch (e) {}
      this.systemAudioNode = null;
    this.nativeSystemNode = null;
    this.nativeSystemWorklet = null;
    this.nativeSystemBuffer = null;
    }
    if (this.systemAudioStream) {
      this.systemAudioStream.getTracks().forEach((track) => track.stop());
      this.systemAudioStream = null;
    }
  }

  setProVocalEnabled(enabled) {
    if (!this.engine.proInput || !this.engine.proOutput || !this.ctx) return;
    const t = this.ctx.currentTime;
    this.engine.proWet.gain.setTargetAtTime(enabled ? 0.96 : 0.0, t, 0.02);
    this.engine.proDry.gain.setTargetAtTime(enabled ? 0.04 : 1.0, t, 0.02);
  }

  updateProVocalSettings() {
    if (!this.engine.proComp || !this.ctx) return;
    const enabled = document.getElementById('proChainToggle')?.checked ?? true;
    const comp = parseFloat(document.getElementById('sliderVocalComp')?.value || 0.45);
    const deEss = parseFloat(document.getElementById('sliderDeEsser')?.value || 0.35);
    const sat = parseFloat(document.getElementById('sliderVocalSat')?.value || 0.08);
    const presence = parseFloat(document.getElementById('sliderVocalPresence')?.value || 2);
    const t = this.ctx.currentTime;

    this.engine.proComp.threshold.setTargetAtTime(-10 - comp * 22, t, 0.02);
    this.engine.proComp.ratio.setTargetAtTime(1.5 + comp * 6, t, 0.02);
    this.engine.deEsser.gain.setTargetAtTime(-deEss * 10, t, 0.02);
    this.engine.proPresence.gain.setTargetAtTime(presence, t, 0.02);
    this.engine.proSaturator.curve = this.makeDistortionCurve(Math.max(0, sat * 35));
    this.engine.proInput.gain.setTargetAtTime(1, t, 0.02);
    this.engine.proWet.gain.setTargetAtTime(enabled ? 0.96 : 0.0, t, 0.02);
    this.engine.proDry.gain.setTargetAtTime(enabled ? 0.04 : 1.0, t, 0.02);
  }

  applyPreset(presetKey) {
    const p = PRESETS[presetKey];
    if (!p || !this.engine.pitcher) return;

    if (p.isBypass) {
      this.engine.fxBypassGain.gain.setTargetAtTime(1.0, this.ctx.currentTime, 0.02);
      this.engine.fxActiveGain.gain.setTargetAtTime(0.0, this.ctx.currentTime, 0.02);
    } else {
      this.engine.fxBypassGain.gain.setTargetAtTime(0.0, this.ctx.currentTime, 0.02);
      this.engine.fxActiveGain.gain.setTargetAtTime(1.0, this.ctx.currentTime, 0.02);

      this.engine.pitcher.parameters.get('pitch').setTargetAtTime(p.pitch, this.ctx.currentTime, 0.02);
      this.engine.hp.frequency.setTargetAtTime(p.lowCut, this.ctx.currentTime, 0.02);
      this.engine.lp.frequency.setTargetAtTime(p.highCut, this.ctx.currentTime, 0.02);
      this.engine.formantEq.frequency.setTargetAtTime(p.eqFreq, this.ctx.currentTime, 0.02);
      this.engine.formantEq.gain.setTargetAtTime(p.eqGain, this.ctx.currentTime, 0.02);
      this.engine.waveshaper.curve = p.drive > 0 ? this.makeDistortionCurve(p.drive * 1.5) : null;
    }
  }

  startGateAndVoiceAssists() {
    if (!this.engine.gateGain || !this.engine.micAnalyser) return;
    const micBuf = new Float32Array(this.engine.micAnalyser.fftSize);
    let lastGateTarget = -1;
    let lastGuideTarget = -1;

    // Cache DOM references
    const gateToggle = document.getElementById('gateToggle');
    const gateSlider = document.getElementById('sliderGate');
    const guideDuckingToggle = document.getElementById('guideDuckingToggle');
    const sliderGuideVol = document.getElementById('sliderGuideVol');

    const mainDspLoop = () => {
      if (!this.ctx || this.ctx.state === 'closed') return;

      // Vocal Noise Gate
      if (gateToggle?.checked && this.engine.gateGain) {
        this.engine.micAnalyser.getFloatTimeDomainData(micBuf);
        let sum = 0;
        for (let i = 0; i < micBuf.length; i++) sum += micBuf[i] * micBuf[i];
        const rms = Math.sqrt(sum / micBuf.length);
        const db = 20 * Math.log10(Math.max(rms, 1e-5));
        const thresh = parseFloat(gateSlider?.value || -50);
        const targetGain = db < thresh ? 0.0 : 1.0;
        if (Math.abs(targetGain - lastGateTarget) > 0.01) {
          lastGateTarget = targetGain;
          this.engine.gateGain.gain.setTargetAtTime(targetGain, this.ctx.currentTime, 0.04);
        }
      } else if (this.engine.gateGain && lastGateTarget !== 1.0) {
        lastGateTarget = 1.0;
        this.engine.gateGain.gain.setTargetAtTime(1.0, this.ctx.currentTime, 0.02);
      }

      // Guide Vocal Ducking
      if (this.engine.guideVocalGain) {
        const maxGuide = parseFloat(sliderGuideVol?.value || 0);
        if (guideDuckingToggle?.checked) {
          this.engine.micAnalyser.getFloatTimeDomainData(micBuf);
          let micSum = 0;
          for (let i = 0; i < micBuf.length; i++) micSum += micBuf[i] * micBuf[i];
          const micRms = Math.sqrt(micSum / micBuf.length);
          const isUserSinging = micRms > 0.018;
          const targetGuideGain = isUserSinging ? (maxGuide * 0.12) : maxGuide;
          if (Math.abs(targetGuideGain - lastGuideTarget) > 0.01) {
            lastGuideTarget = targetGuideGain;
            this.engine.guideVocalGain.gain.setTargetAtTime(targetGuideGain, this.ctx.currentTime, isUserSinging ? 0.05 : 0.4);
          }
        } else if (Math.abs(maxGuide - lastGuideTarget) > 0.01) {
          lastGuideTarget = maxGuide;
          this.engine.guideVocalGain.gain.setTargetAtTime(maxGuide, this.ctx.currentTime, 0.05);
        }
      }
    };

    if (this._dspAssistTimer) clearInterval(this._dspAssistTimer);
    this._dspAssistTimer = setInterval(mainDspLoop, 30);
  }

  async connectNativeSystemAudio(arrayBuffer) {
    await this.boot();
    if (!this.engine.systemAudioGain) return;
    if (!this.nativeSystemWorklet) {
      this.nativeSystemWorklet = new AudioWorkletNode(this.ctx, 'native-pcm-player', { outputChannelCount: [2] });
      this.nativeSystemWorklet.connect(this.engine.systemAudioGain);
    }
    const bytes = arrayBuffer instanceof ArrayBuffer ? arrayBuffer : arrayBuffer.buffer;
    if (bytes.byteLength < 24) return;
    const view = new DataView(bytes);
    const magic = view.getUint32(0, true);
    const type = view.getUint32(4, true);
    const channels = view.getUint32(12, true);
    const payloadBytes = view.getUint32(20, true);
    if (magic !== 0x46414B4E || type !== 1 || payloadBytes <= 0 || 24 + payloadBytes > bytes.byteLength) return;
    const payload = bytes.slice(24, 24 + payloadBytes);
    this.nativeSystemWorklet.port.postMessage(new Float32Array(payload), [payload]);
  }

  disconnectNativeSystemAudio() {
    if (this.nativeSystemWorklet) {
      try { this.nativeSystemWorklet.disconnect(); } catch (e) {}
      this.nativeSystemWorklet = null;
    }
  }

  async applyOutputRouting() {
    const speakerSelect = document.getElementById('speakerSelect');
    const ledOut = document.getElementById('led-out');
    const targetId = speakerSelect?.value;
    if (this.ctx && 'setSinkId' in this.ctx) {
      try {
        await this.ctx.setSinkId(targetId || '');
        if (ledOut) ledOut.classList.toggle('active-green', !!targetId);
      } catch (err) {
        if (ledOut) ledOut.classList.remove('active-green');
      }
    }
  }

  onAutoTuneTelemetry(callback) {
    if (!this._autoTuneTelemetryListeners) this._autoTuneTelemetryListeners = [];
    this._autoTuneTelemetryListeners.push(callback);
    return () => {
      const idx = this._autoTuneTelemetryListeners.indexOf(callback);
      if (idx !== -1) this._autoTuneTelemetryListeners.splice(idx, 1);
    };
  }

  updateAutoTuneSettings(customConfig = null) {
    if (!this.engine.autoTuneNode || !this.ctx) return;

    const atScale = customConfig?.scale ?? document.getElementById('atScale')?.value ?? 'chromatic';
    const atKey = customConfig?.key ?? parseInt(document.getElementById('atKey')?.value || '0', 10);
    const atSpeed = customConfig?.speed ?? parseFloat(document.getElementById('atSpeed')?.value || '20');
    const atFlex = customConfig?.flexTune ?? parseFloat(document.getElementById('atFlex')?.value || '0');
    const atHumanize = customConfig?.humanize ?? parseFloat(document.getElementById('atHumanize')?.value || '0');
    const atMix = customConfig?.mix ?? parseFloat(document.getElementById('atMix')?.value || '1.0');
    const atInputType = customConfig?.inputType ?? document.getElementById('atInputType')?.value ?? 'altoTenor';
    const atTracking = customConfig?.tracking ?? parseFloat(document.getElementById('atTracking')?.value || '0.85');
    const atMode = customConfig?.mode ?? (document.querySelector('input[name="atMode"]:checked')?.value || 'modern');
    const atDetune = customConfig?.detune ?? parseFloat(document.getElementById('atDetune')?.value || '0');
    const atTranspose = customConfig?.transpose ?? parseInt(document.getElementById('atTranspose')?.value || '0', 10);
    const atFormant = customConfig?.formant ?? (document.getElementById('atFormantToggle')?.checked ?? true);
    const atThroat = customConfig?.throat ?? parseFloat(document.getElementById('atThroat')?.value || '1.0');
    const atVibrato = customConfig?.vibrato ?? (document.getElementById('atVibratoToggle')?.checked ?? false);
    const atVibShape = customConfig?.vibShape ?? document.getElementById('atVibShape')?.value ?? 'sine';
    const atVibDepth = customConfig?.vibDepth ?? parseFloat(document.getElementById('atVibDepth')?.value || '0');
    const atVibRate = customConfig?.vibRate ?? parseFloat(document.getElementById('atVibRate')?.value || '5.5');
    const atVibDelay = customConfig?.vibDelay ?? parseFloat(document.getElementById('atVibDelay')?.value || '0');
    const atVibVariation = customConfig?.vibVariation ?? parseFloat(document.getElementById('atVibVariation')?.value || '0');
    const noteStates = customConfig?.noteStates ?? this._atNoteStates ?? [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
    const isEnabled = document.getElementById('autoTuneToggle')?.checked ?? true;

    const scaleNotes = SCALE_MAP[atScale] || SCALE_MAP.chromatic;

    const msg = {
      scale: scaleNotes,
      root: atKey,
      noteStates,
      speed: atSpeed,
      flex: atFlex,
      humanize: atHumanize,
      mix: atMix,
      inputType: atInputType,
      tracking: atTracking,
      mode: atMode,
      detune: atDetune,
      transpose: atTranspose,
      formant: atFormant,
      throat: atThroat,
      vibrato: atVibrato,
      vibShape: atVibShape,
      vibDepth: atVibDepth,
      vibRate: atVibRate,
      vibDelay: atVibDelay,
      vibVariation: atVibVariation,
      enabled: isEnabled
    };

    this.engine.autoTuneNode.port.postMessage(msg);

    const t = this.ctx.currentTime;
    try {
      const pSpeed = this.engine.autoTuneNode.parameters.get('speed');
      if (pSpeed) pSpeed.setValueAtTime(atSpeed, t);
      const pFlex = this.engine.autoTuneNode.parameters.get('flex');
      if (pFlex) pFlex.setValueAtTime(atFlex, t);
      const pHum = this.engine.autoTuneNode.parameters.get('humanize');
      if (pHum) pHum.setValueAtTime(atHumanize, t);
      const pMix = this.engine.autoTuneNode.parameters.get('mix');
      if (pMix) pMix.setValueAtTime(atMix, t);
    } catch (_) {}
  }

  async updateKey(val) {
    this.currentKey = val;
    const lblKey = document.getElementById('lblKey');
    if (lblKey) lblKey.textContent = this.currentKey > 0 ? `+${this.currentKey}` : this.currentKey;
    await this.boot();
    if (this.engine.mediaPitcher && this.ctx) {
      this.engine.mediaPitcher.parameters.get('pitch').setTargetAtTime(Math.pow(2, this.currentKey / 12), this.ctx.currentTime, 0.05);
    }
  }

  connectMediaElement(mediaEl) {
    if (!mediaEl || !this.ctx || !this.engine.mediaGain) return;
    // A MediaElementSource can only be created once for a given HTMLMediaElement.
    // Reusing the same element is required; changing src is safe and keeps the
    // audio routed through the master MediaStreamDestination.
    if (!this.mediaElementSource) {
      this.mediaElementSource = this.ctx.createMediaElementSource(mediaEl);
      // Fix B: pin to 2-ch stereo so a stereo music file is never collapsed
      // to mono by the browser's default channel-count negotiation.
      try { this.mediaElementSource.channelCount = 2; } catch (_) {}
      try { this.mediaElementSource.channelCountMode = 'explicit'; } catch (_) {}
      try { this.mediaElementSource.channelInterpretation = 'discrete'; } catch (_) {}
      this.mediaElementSource.connect(this.engine.mediaGain);
    }
  }

  getProgramStereoDiagnostics() {
    const track = this.engine?.dest?.stream?.getAudioTracks?.()[0];
    if (!track) return { channels: 0, sampleRate: this.ctx?.sampleRate || 0, readyState: 'missing' };
    let settings = {};
    try { settings = track.getSettings?.() || {}; } catch (_) {}
    return {
      channels: Number(settings.channelCount || this.engine?.dest?.channelCount || 2),
      sampleRate: Number(settings.sampleRate || this.ctx?.sampleRate || 48000),
      readyState: track.readyState
    };
  }

  getProgramLevel() {
    if (!this.engine.analyser) return 0;
    const data = new Float32Array(this.engine.analyser.fftSize);
    this.engine.analyser.getFloatTimeDomainData(data);
    let sum = 0;
    for (const sample of data) sum += sample * sample;
    return Math.sqrt(sum / data.length);
  }
}