export function spawnSFXParticles(emojiArr) {
  const container = document.querySelector('.stage-visual');
  if (!container) return;
  for (let i = 0; i < 12; i++) {
    const el = document.createElement('div');
    el.className = 'sfx-particle';
    el.textContent = emojiArr[Math.floor(Math.random() * emojiArr.length)];
    el.style.left = (45 + (Math.random() - 0.5) * 60) + '%';
    el.style.bottom = '10%';
    el.style.animationDelay = (Math.random() * 0.15) + 's';
    el.style.setProperty('--drift', ((Math.random() - 0.5) * 150) + 'px');
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
    if (ctx.state === 'suspended' || !audioEngine.engine?.mixBus) {
      if (type === 'cheer') spawnSFXParticles(['👏', '🎉', '🎊', '🙌']);
      else if (type === 'airhorn') spawnSFXParticles(['🎺', '💥', '🔥', '🚨']);
      else if (type === 'sparkle') spawnSFXParticles(['✨', '💫', '🌟', '🔮']);
      return;
    }
    const t = ctx.currentTime;

  if (type === 'cheer') {
    spawnSFXParticles(['👏', '🎉', '🎊', '🙌']);
    const bufferSize = Math.floor(ctx.sampleRate * 2.5);
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 1.5));
    const noise = ctx.createBufferSource();
    noise.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 1200;
    filter.Q.value = 1.0;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.7, t);
    gain.gain.exponentialRampToValueAtTime(0.01, t + 2.5);
    noise.connect(filter);
    filter.connect(gain);
    gain.connect(audioEngine.engine.mixBus);
    noise.start(t);
  } else if (type === 'airhorn') {
    spawnSFXParticles(['🎺', '💥', '🔥', '🚨']);
    [466.16, 311.13, 233.08].forEach((freq) => {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      const g = ctx.createGain();
      osc.frequency.setValueAtTime(freq, t);
      osc.frequency.setValueAtTime(freq * 1.05, t + 0.1);
      osc.frequency.exponentialRampToValueAtTime(freq * 0.9, t + 0.6);
      g.gain.setValueAtTime(0.2, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
      osc.connect(g);
      g.connect(audioEngine.engine.mixBus);
      osc.start(t);
      osc.stop(t + 0.6);
    });
  } else if (type === 'sparkle') {
    spawnSFXParticles(['✨', '💫', '🌟', '🔮']);
    [523.25, 659.25, 783.99, 1046.50, 1318.51].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      const g = ctx.createGain();
      osc.frequency.value = freq;
      g.gain.setValueAtTime(0.0, t + i * 0.08);
      g.gain.linearRampToValueAtTime(0.25, t + i * 0.08 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t + i * 0.08 + 0.8);
      osc.connect(g);
      g.connect(audioEngine.engine.mixBus);
      osc.start(t + i * 0.08);
      osc.stop(t + i * 0.08 + 0.8);
    });
  }
  } catch (err) {
    console.warn('[Nirmal] SFX playback deferred or unavailable:', err?.message || err);
    if (type === 'cheer') spawnSFXParticles(['👏', '🎉', '🎊', '🙌']);
    else if (type === 'airhorn') spawnSFXParticles(['🎺', '💥', '🔥', '🚨']);
    else if (type === 'sparkle') spawnSFXParticles(['✨', '💫', '🌟', '🔮']);
  }
}