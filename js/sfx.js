/**
 * Nirmal Karaoke Live Artist Soundboard & Performance SFX Engine
 * Synthesizes high-fidelity broadcast sound effects directly into Web Audio mixBus
 * Zero external audio files, zero network latency, 100% offline & mobile compatible.
 */

export function spawnSFXParticles(emojiArr) {
  const container = document.querySelector('.stage-visual') || document.body;
  if (!container) return;
  const count = window.innerWidth <= 600 ? 8 : 14;
  for (let i = 0; i < count; i++) {
    const el = document.createElement('div');
    el.className = 'sfx-particle';
    el.textContent = emojiArr[Math.floor(Math.random() * emojiArr.length)];
    el.style.left = (45 + (Math.random() - 0.5) * 60) + '%';
    el.style.bottom = '12%';
    el.style.animationDelay = (Math.random() * 0.15) + 's';
    el.style.setProperty('--drift', ((Math.random() - 0.5) * 160) + 'px');
    container.appendChild(el);
    setTimeout(() => el.remove(), 1200);
  }
}

export async function playSFX(type, audioEngine) {
  try {
    if (!audioEngine) return;
    await audioEngine.boot();
    const ctx = audioEngine.ctx;
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      await ctx.resume().catch(() => {});
    }

    const mixBus = audioEngine.engine?.mixBus;
    const sfxOut = ctx.createGain();
    sfxOut.gain.value = 1.0;
    if (mixBus) {
      sfxOut.connect(mixBus);
    }
    // Also connect to local audio output so the host hears their soundboard triggers
    sfxOut.connect(ctx.destination);
    const bus = sfxOut;
    const t = ctx.currentTime;

    switch (type) {
      case 'cheer': {
        // 👏 Stadium Applause & Cheering
        spawnSFXParticles(['👏', '🎉', '🎊', '🙌', '⭐']);
        const dur = 2.4;
        const bufferSize = Math.floor(ctx.sampleRate * dur);
        const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
          data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 1.4));
        }
        const noise = ctx.createBufferSource();
        noise.buffer = buffer;

        const filter = ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.value = 1200;
        filter.Q.value = 0.9;

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.75, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + dur);

        noise.connect(filter);
        filter.connect(gain);
        gain.connect(bus);
        noise.start(t);
        break;
      }

      case 'airhorn': {
        // 🎺 High-Energy DJ Airhorn
        spawnSFXParticles(['🎺', '💥', '🔥', '🚨', '⚡']);
        const freqs = [466.16, 311.13, 233.08];
        freqs.forEach((freq) => {
          const osc = ctx.createOscillator();
          osc.type = 'sawtooth';
          const g = ctx.createGain();
          osc.frequency.setValueAtTime(freq, t);
          osc.frequency.setValueAtTime(freq * 1.05, t + 0.1);
          osc.frequency.exponentialRampToValueAtTime(freq * 0.92, t + 0.65);
          g.gain.setValueAtTime(0.25, t);
          g.gain.exponentialRampToValueAtTime(0.001, t + 0.65);
          osc.connect(g);
          g.connect(bus);
          osc.start(t);
          osc.stop(t + 0.65);
        });
        break;
      }

      case 'sparkle': {
        // ✨ Shimmering Magic Bell Glissando
        spawnSFXParticles(['✨', '💫', '🌟', '🔮', '💎']);
        const notes = [523.25, 659.25, 783.99, 1046.50, 1318.51, 1567.98];
        notes.forEach((freq, i) => {
          const osc = ctx.createOscillator();
          osc.type = 'sine';
          const g = ctx.createGain();
          osc.frequency.value = freq;
          g.gain.setValueAtTime(0.0, t + i * 0.07);
          g.gain.linearRampToValueAtTime(0.24, t + i * 0.07 + 0.02);
          g.gain.exponentialRampToValueAtTime(0.001, t + i * 0.07 + 0.75);
          osc.connect(g);
          g.connect(bus);
          osc.start(t + i * 0.07);
          osc.stop(t + i * 0.07 + 0.75);
        });
        break;
      }

      case 'drumroll': {
        // 🥁 Suspense Snare Drum Roll into Crash Cymbal
        spawnSFXParticles(['🥁', '💥', '🔥', '⚡', '🎶']);
        const rollDur = 1.6;
        const totalHits = 28;
        for (let i = 0; i < totalHits; i++) {
          const hitTime = t + (i / totalHits) * rollDur * (0.8 + (i / totalHits) * 0.2);
          const noiseBuffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.04), ctx.sampleRate);
          const nd = noiseBuffer.getChannelData(0);
          for (let k = 0; k < nd.length; k++) nd[k] = (Math.random() * 2 - 1) * Math.exp(-k / (ctx.sampleRate * 0.01));
          const src = ctx.createBufferSource();
          src.buffer = noiseBuffer;
          const hitGain = ctx.createGain();
          const amp = 0.15 + 0.45 * (i / totalHits);
          hitGain.gain.setValueAtTime(amp, hitTime);
          hitGain.gain.exponentialRampToValueAtTime(0.001, hitTime + 0.04);
          src.connect(hitGain);
          hitGain.connect(bus);
          src.start(hitTime);
        }

        // Final Crash Cymbal
        const crashTime = t + rollDur;
        const crashBuffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 1.2), ctx.sampleRate);
        const cd = crashBuffer.getChannelData(0);
        for (let k = 0; k < cd.length; k++) cd[k] = (Math.random() * 2 - 1) * Math.exp(-k / (ctx.sampleRate * 0.4));
        const crashSrc = ctx.createBufferSource();
        crashSrc.buffer = crashBuffer;
        const crashFilter = ctx.createBiquadFilter();
        crashFilter.type = 'highpass';
        crashFilter.frequency.value = 3500;
        const crashGain = ctx.createGain();
        crashGain.gain.setValueAtTime(0.65, crashTime);
        crashGain.gain.exponentialRampToValueAtTime(0.001, crashTime + 1.2);
        crashSrc.connect(crashFilter);
        crashFilter.connect(crashGain);
        crashGain.connect(bus);
        crashSrc.start(crashTime);
        break;
      }

      case 'beatdrop': {
        // 💥 Deep 808 Sub-Bass Drop
        spawnSFXParticles(['💣', '💥', '🔊', '🌊', '🔥']);
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(145, t);
        osc.frequency.exponentialRampToValueAtTime(36, t + 0.85);

        g.gain.setValueAtTime(0.85, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 1.2);

        // Add punchy transient click
        const clickOsc = ctx.createOscillator();
        const clickGain = ctx.createGain();
        clickOsc.type = 'triangle';
        clickOsc.frequency.setValueAtTime(220, t);
        clickOsc.frequency.exponentialRampToValueAtTime(40, t + 0.05);
        clickGain.gain.setValueAtTime(0.4, t);
        clickGain.gain.exponentialRampToValueAtTime(0.001, t + 0.05);

        clickOsc.connect(clickGain);
        clickGain.connect(bus);
        clickOsc.start(t);
        clickOsc.stop(t + 0.05);

        osc.connect(g);
        g.connect(bus);
        osc.start(t);
        osc.stop(t + 1.2);
        break;
      }

      case 'guitar': {
        // 🎸 Resonant Acoustic Chime / Strum (C-E-G-B Chord)
        spawnSFXParticles(['🎸', '🎶', '🎵', '✨', '🤍']);
        const chord = [261.63, 329.63, 392.00, 493.88, 523.25];
        chord.forEach((freq, idx) => {
          const osc = ctx.createOscillator();
          osc.type = 'triangle';
          const g = ctx.createGain();
          const strumTime = t + idx * 0.035;
          osc.frequency.setValueAtTime(freq, strumTime);

          g.gain.setValueAtTime(0.0, strumTime);
          g.gain.linearRampToValueAtTime(0.22, strumTime + 0.015);
          g.gain.exponentialRampToValueAtTime(0.001, strumTime + 1.4);

          osc.connect(g);
          g.connect(bus);
          osc.start(strumTime);
          osc.stop(strumTime + 1.4);
        });
        break;
      }

      case 'scratch': {
        // 💿 Turntable DJ Vinyl Scratch
        spawnSFXParticles(['💿', '🎧', '⚡', '🔥', '🎛']);
        const dur = 0.35;
        const bufferSize = Math.floor(ctx.sampleRate * dur);
        const buf = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
          const ph = (i / bufferSize) * Math.PI * 4;
          data[i] = (Math.sin(ph) * 0.5 + (Math.random() * 2 - 1) * 0.5);
        }
        const src = ctx.createBufferSource();
        src.buffer = buf;

        const filter = ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.setValueAtTime(800, t);
        filter.frequency.linearRampToValueAtTime(2600, t + dur * 0.5);
        filter.frequency.linearRampToValueAtTime(600, t + dur);
        filter.Q.value = 4.0;

        const g = ctx.createGain();
        g.gain.setValueAtTime(0.4, t);
        g.gain.exponentialRampToValueAtTime(0.01, t + dur);

        src.connect(filter);
        filter.connect(g);
        g.connect(bus);
        src.start(t);
        break;
      }

      case 'bleep': {
        // 🛑 Broadcast Standard 1 kHz Censor Bleep (-12 dBFS)
        spawnSFXParticles(['🛑', '🚫', '⚠️', '🤐', '🎙']);
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = 1000;

        g.gain.setValueAtTime(0.3, t);
        g.gain.setValueAtTime(0.3, t + 0.45);
        g.gain.linearRampToValueAtTime(0.0001, t + 0.48);

        osc.connect(g);
        g.connect(bus);
        osc.start(t);
        osc.stop(t + 0.48);
        break;
      }

      default:
        console.warn('[SFX] Unknown effect type:', type);
    }
  } catch (err) {
    console.warn('[Nirmal] SFX playback notice:', err?.message || err);
    if (type === 'cheer') spawnSFXParticles(['👏', '🎉', '🎊', '🙌']);
    else if (type === 'airhorn') spawnSFXParticles(['🎺', '💥', '🔥', '🚨']);
    else if (type === 'sparkle') spawnSFXParticles(['✨', '💫', '🌟', '🔮']);
    else spawnSFXParticles(['🎶', '🎵', '✨']);
  }
}