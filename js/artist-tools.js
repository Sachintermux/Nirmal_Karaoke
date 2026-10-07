/**
 * Nirmal Karaoke - Professional Live Performing Artist Suite
 * Stage tools for live musicians, vocalists, acoustic singers & broadcasters.
 *
 * Capabilities:
 *   1. Precision Stage Metronome (40-240 BPM, Tap Tempo, 1-4 Beat Accents)
 *   2. Concert Pitch Reference & Chromatic Vocal Pitch Pipe (440Hz / 432Hz / C-D-E-F-G-A-B / Guitar EADGBE)
 *   3. Auto-Ducking / DJ Talkover (Automatically dims backing music when artist talks)
 *   4. Broadcast Safety Peak & Clip Guard (Real-time broadcast loudness & clip detection)
 */

export class ArtistToolsManager {
  constructor(audioEngine) {
    this.audioEngine = audioEngine;

    // ─── 1. Metronome State ──────────────────────────────────────────────────
    this.isPlayingMetronome = false;
    this.bpm = 120;
    this.beatsPerBar = 4;
    this.currentBeat = 0;
    this.metronomeRouting = 'inEar'; // 'inEar' (Headphones only) | 'broadcast' (Mix bus)
    this._metronomeTimer = null;
    this._nextNoteTime = 0.0;
    this._scheduleAheadTime = 0.1;
    this._tapTimestamps = [];
    this._onBeatCallbacks = [];
    this.onMetronomeTick = null;

    // ─── 2. Auto-Ducking State ───────────────────────────────────────────────
    this.isAutoDuckingEnabled = false;
    this._duckingTimer = null;
    this._isDucked = false;
    this._userMediaGain = 1.0;
    this._duckThreshold = 0.02; // ~ -34dBFS (responsive to singing and speech)
    this._duckReleaseTimeout = null;

    // ─── 3. Pitch Reference State ────────────────────────────────────────────
    this.concertReference = 440;
    this.quickKeyShift = 0;
    this._activePitchOsc = null;
    this._activePitchGain = null;

    // ─── 4. Peak Meter State ─────────────────────────────────────────────────
    this._peakTimer = null;
    this._onPeakCallbacks = [];
    this._onPeakUpdateHandler = null;
  }

  // ─── Metronome Engine ─────────────────────────────────────────────────────

  get isMetronomeRunning() {
    return this.isPlayingMetronome;
  }

  setBpm(newBpm) {
    this.bpm = Math.max(40, Math.min(240, Math.round(newBpm)));
    return this.bpm;
  }

  setBeatsPerBar(beats) {
    this.beatsPerBar = Math.max(1, Math.min(12, parseInt(beats, 10) || 4));
    return this.beatsPerBar;
  }

  setMetronomeRouting(route) {
    this.metronomeRouting = route === 'broadcast' ? 'broadcast' : 'inEar';
    return this.metronomeRouting;
  }

  setMetronomeBroadcast(enable) {
    return this.setMetronomeRouting(enable ? 'broadcast' : 'inEar');
  }

  onBeat(callback) {
    if (typeof callback === 'function') {
      this._onBeatCallbacks.push(callback);
    }
  }

  async startMetronome() {
    if (this.isPlayingMetronome) return;
    await this.audioEngine.boot();
    const ctx = this.audioEngine.ctx;
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      await ctx.resume().catch(() => {});
    }

    this.isPlayingMetronome = true;
    this.currentBeat = 0;
    this._nextNoteTime = ctx.currentTime + 0.05;

    const scheduler = () => {
      if (!this.isPlayingMetronome) return;
      while (this._nextNoteTime < ctx.currentTime + this._scheduleAheadTime) {
        this._scheduleMetronomeClick(this._nextNoteTime, this.currentBeat);
        this._nextBeat();
      }
      this._metronomeTimer = setTimeout(scheduler, 25);
    };
    scheduler();
  }

  stopMetronome() {
    this.isPlayingMetronome = false;
    if (this._metronomeTimer) {
      clearTimeout(this._metronomeTimer);
      this._metronomeTimer = null;
    }
    this.currentBeat = 0;
    this._emitBeatEvent(-1, false);
  }

  toggleMetronome() {
    if (this.isPlayingMetronome) {
      this.stopMetronome();
      return false;
    } else {
      this.startMetronome();
      return true;
    }
  }

  _scheduleMetronomeClick(time, beat) {
    const ctx = this.audioEngine.ctx;
    if (!ctx) return;
    const isAccent = beat === 0;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = isAccent ? 'triangle' : 'sine';
    osc.frequency.value = isAccent ? 1200 : 800;

    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.linearRampToValueAtTime(isAccent ? 0.35 : 0.22, time + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + (isAccent ? 0.08 : 0.05));

    // Route to headphones only or into main program broadcast bus
    const dest = (this.metronomeRouting === 'broadcast' && this.audioEngine.engine?.mixBus)
      ? this.audioEngine.engine.mixBus
      : ctx.destination;

    osc.connect(gain);
    gain.connect(dest);

    osc.start(time);
    osc.stop(time + (isAccent ? 0.08 : 0.05));

    // Trigger visual flash synchronized to audio clock
    const delayMs = Math.max(0, (time - ctx.currentTime) * 1000);
    setTimeout(() => {
      if (this.isPlayingMetronome) {
        this._emitBeatEvent(beat, isAccent);
      }
    }, delayMs);
  }

  _nextBeat() {
    const secondsPerBeat = 60.0 / this.bpm;
    this._nextNoteTime += secondsPerBeat;
    this.currentBeat = (this.currentBeat + 1) % this.beatsPerBar;
  }

  _emitBeatEvent(beat, isAccent) {
    if (typeof this.onMetronomeTick === 'function') {
      try { this.onMetronomeTick(beat, isAccent); } catch (_) {}
    }
    for (const cb of this._onBeatCallbacks) {
      try { cb(beat, isAccent, this.bpm); } catch (_) {}
    }
  }

  /**
   * Tap Tempo: Records user taps and calculates moving average BPM
   */
  recordTap() {
    const now = performance.now();
    // Reset if last tap was longer than 2.2 seconds ago
    if (this._tapTimestamps.length > 0 && now - this._tapTimestamps[this._tapTimestamps.length - 1] > 2200) {
      this._tapTimestamps = [];
    }
    this._tapTimestamps.push(now);
    if (this._tapTimestamps.length > 5) this._tapTimestamps.shift();

    if (this._tapTimestamps.length >= 2) {
      const intervals = [];
      for (let i = 1; i < this._tapTimestamps.length; i++) {
        intervals.push(this._tapTimestamps[i] - this._tapTimestamps[i - 1]);
      }
      const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      const rawBpm = Math.round(60000 / avgInterval);
      const calculatedBpm = Math.max(40, Math.min(240, rawBpm));
      this.setBpm(calculatedBpm);
      return { bpm: calculatedBpm, tapsCount: this._tapTimestamps.length };
    }
    return { bpm: this.bpm, tapsCount: this._tapTimestamps.length };
  }

  tapTempo() {
    const res = this.recordTap();
    return res.bpm;
  }

  // ─── Pitch Pipe & Concert Reference ───────────────────────────────────────

  async playPitch(freq, duration = 2.5) {
    await this.audioEngine.boot();
    const ctx = this.audioEngine.ctx;
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      await ctx.resume().catch(() => {});
    }

    // Stop any currently sounding pitch tone
    this.stopPitch();

    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, t);

    // Warm harmonics filter
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = freq * 4;

    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(0.25, t + 0.04);
    gain.gain.setValueAtTime(0.25, t + duration - 0.15);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);

    osc.start(t);
    osc.stop(t + duration);

    this._activePitchOsc = osc;
    this._activePitchGain = gain;
    osc.onended = () => {
      if (this._activePitchOsc === osc) {
        this._activePitchOsc = null;
        this._activePitchGain = null;
      }
    };
  }

  stopPitch() {
    if (this._activePitchOsc) {
      try {
        const ctx = this.audioEngine?.ctx;
        const t = ctx ? ctx.currentTime : 0;
        if (this._activePitchGain && ctx) {
          this._activePitchGain.gain.setValueAtTime(this._activePitchGain.gain.value, t);
          this._activePitchGain.gain.linearRampToValueAtTime(0.0001, t + 0.05);
        }
        this._activePitchOsc.stop(t + 0.05);
      } catch (_) {
        try { this._activePitchOsc.stop(); } catch (_) {}
      }
      this._activePitchOsc = null;
      this._activePitchGain = null;
    }
  }

  setConcertReference(refHz) {
    this.concertReference = parseFloat(refHz) || 440;
    return this.concertReference;
  }

  playPitchTone(noteStr, duration = 2.5) {
    const ref = this.concertReference || 440;
    let freq = 440;
    if (typeof noteStr === 'number') {
      freq = noteStr;
    } else if (typeof noteStr === 'string') {
      const match = noteStr.trim().match(/^([A-Ga-g])(#|b)?(\d)?$/);
      if (match) {
        const noteLetter = match[1].toUpperCase();
        const accidental = match[2] || '';
        const octave = match[3] !== undefined ? parseInt(match[3], 10) : 4;
        const semitoneMap = { 'C': 0, 'C#': 1, 'DB': 1, 'D': 2, 'D#': 3, 'EB': 3, 'E': 4, 'F': 5, 'F#': 6, 'GB': 6, 'G': 7, 'G#': 8, 'AB': 8, 'A': 9, 'A#': 10, 'BB': 10, 'B': 11 };
        const key = noteLetter + (accidental === '#' ? '#' : (accidental.toLowerCase() === 'b' ? 'B' : ''));
        const semitonesFromC0 = (octave * 12) + (semitoneMap[key] ?? 9);
        const semitonesFromA4 = semitonesFromC0 - 57;
        freq = ref * Math.pow(2, semitonesFromA4 / 12);
      } else {
        const parsed = parseFloat(noteStr);
        if (!isNaN(parsed) && parsed > 0) freq = parsed;
      }
    }
    return this.playPitch(freq, duration);
  }

  stopPitchTone() {
    return this.stopPitch();
  }

  setQuickKeyShift(semitones) {
    this.quickKeyShift = parseInt(semitones, 10) || 0;
    return this.quickKeyShift;
  }

  // ─── Auto-Ducking / DJ Talkover Engine ────────────────────────────────────

  async enableAutoDucking(enable = true) {
    this.isAutoDuckingEnabled = !!enable;
    if (this.isAutoDuckingEnabled) {
      await this.audioEngine.boot();
      this._startAutoDuckingLoop();
    } else {
      this._stopAutoDuckingLoop();
    }
    return this.isAutoDuckingEnabled;
  }

  _startAutoDuckingLoop() {
    if (this._duckingTimer) return;
    const checkIntervalMs = 50;
    const sampleBuffer = new Float32Array(256);
    const statusEl = document.getElementById('lblDuckingStatus');

    const loop = () => {
      if (!this.isAutoDuckingEnabled) {
        this._duckingTimer = null;
        return;
      }
      const engine = this.audioEngine?.engine;
      const ctx = this.audioEngine?.ctx;

      if (engine?.micAnalyser && engine?.mediaGain && ctx) {
        engine.micAnalyser.getFloatTimeDomainData(sampleBuffer);
        let sum = 0;
        for (let i = 0; i < sampleBuffer.length; i++) {
          sum += sampleBuffer[i] * sampleBuffer[i];
        }
        const rms = Math.sqrt(sum / sampleBuffer.length);

        if (rms > this._duckThreshold) {
          // Vocal detected: Duck music smoothly by ~10dB (gain ~ 0.30)
          if (!this._isDucked) {
            const slider = document.getElementById('sliderMediaVol');
            this._userMediaGain = parseFloat(slider?.value || 1.0);
            const duckedGain = this._userMediaGain * 0.30;
            engine.mediaGain.gain.setTargetAtTime(duckedGain, ctx.currentTime, 0.06);
            this._isDucked = true;
            if (statusEl) {
              statusEl.style.display = 'block';
              statusEl.textContent = '⚡ Auto-Ducking: Music ducked (-10dB) for vocal clarity';
            }
          }
          if (this._duckReleaseTimeout) {
            clearTimeout(this._duckReleaseTimeout);
            this._duckReleaseTimeout = null;
          }
        } else if (this._isDucked && !this._duckReleaseTimeout) {
          // Singer finished talking: hold for 650ms then restore music smoothly
          this._duckReleaseTimeout = setTimeout(() => {
            this._duckReleaseTimeout = null;
            if (this.isAutoDuckingEnabled && engine.mediaGain && ctx) {
              const slider = document.getElementById('sliderMediaVol');
              const targetGain = parseFloat(slider?.value || this._userMediaGain || 1.0);
              engine.mediaGain.gain.setTargetAtTime(targetGain, ctx.currentTime, 0.22);
              this._isDucked = false;
              if (statusEl) {
                statusEl.textContent = '⚡ Auto-Ducking Active: Music ducks dynamically with vocals';
              }
            }
          }, 650);
        }
      }
      this._duckingTimer = setTimeout(loop, checkIntervalMs);
    };
    loop();
  }

  _stopAutoDuckingLoop() {
    if (this._duckingTimer) {
      clearTimeout(this._duckingTimer);
      this._duckingTimer = null;
    }
    if (this._duckReleaseTimeout) {
      clearTimeout(this._duckReleaseTimeout);
      this._duckReleaseTimeout = null;
    }
    if (this._isDucked) {
      const engine = this.audioEngine?.engine;
      const ctx = this.audioEngine?.ctx;
      if (engine?.mediaGain && ctx) {
        const slider = document.getElementById('sliderMediaVol');
        const targetGain = parseFloat(slider?.value || this._userMediaGain || 1.0);
        engine.mediaGain.gain.setTargetAtTime(targetGain, ctx.currentTime, 0.1);
      }
      this._isDucked = false;
    }
  }

  // ─── Broadcast Peak & Clip Meter ──────────────────────────────────────────

  set onPeakUpdate(callback) {
    this._onPeakUpdateHandler = callback;
    if (callback && !this._peakTimer) {
      this._startPeakMeter();
    }
  }

  get onPeakUpdate() {
    return this._onPeakUpdateHandler;
  }

  onPeak(callback) {
    if (typeof callback === 'function') {
      this._onPeakCallbacks.push(callback);
      if (!this._peakTimer) this._startPeakMeter();
    }
  }

  _startPeakMeter() {
    const data = new Float32Array(512);
    let lastTime = 0;
    const isMobile = typeof window !== 'undefined' && (
      window.innerWidth <= 850 ||
      /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
    );
    const interval = isMobile ? 50 : 30;
    let vuObserved = false;
    let vuVisible = true;

    const meterLoop = (ts) => {
      if (!this._onPeakCallbacks.length && !this._onPeakUpdateHandler) {
        this._peakTimer = null;
        return;
      }
      this._peakTimer = requestAnimationFrame(meterLoop);

      if (typeof document !== 'undefined' && document.hidden) return;

      // Throttle rate (20 FPS on mobile saves substantial CPU)
      if (ts - lastTime < interval) return;
      lastTime = ts;

      // Lazy check: skip all processing if artistSuiteCard is hidden on mobile.
      // Visibility comes from an IntersectionObserver; reading offsetParent here
      // would force a synchronous layout on every tick.
      if (!vuObserved) {
        vuObserved = true;
        const card = document.getElementById('artistSuiteCard');
        if (card && typeof IntersectionObserver !== 'undefined') {
          try {
            new IntersectionObserver((entries) => {
              for (const en of entries) vuVisible = en.isIntersecting;
            }).observe(card);
          } catch (_) { vuVisible = true; }
        }
      }
      if (!vuVisible) return;

      const analyser = this.audioEngine?.engine?.analyser;
      if (analyser) {
        analyser.getFloatTimeDomainData(data);
        let peak = 0;
        for (let i = 0; i < data.length; i++) {
          const abs = Math.abs(data[i]);
          if (abs > peak) peak = abs;
        }
        const peakDb = peak > 0.00001 ? 20 * Math.log10(peak) : -60;
        const isClipping = peak >= 0.98 || peakDb >= -0.5;

        if (typeof this._onPeakUpdateHandler === 'function') {
          try {
            this._onPeakUpdateHandler({ peak, peakDb, isClipping });
          } catch (_) {}
        }
        for (const cb of this._onPeakCallbacks) {
          try { cb(peak, isClipping); } catch (_) {}
        }
      }
    };
    this._peakTimer = requestAnimationFrame(meterLoop);
  }
}
