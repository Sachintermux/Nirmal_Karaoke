/**
 * Usage stats (this device only, localStorage): mic time, live time + broadcasts, songs, sounds, top voices.
 * Nothing is sent anywhere. A 1 s timer accumulates time while the mic / a live stage is active.
 */

const KEY = 'nirmal_stats_v1';
const KEEP_DAYS = 60;

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function formatDuration(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(sec % 60).padStart(2, '0')}s`;
  return `${sec}s`;
}

function blank() {
  return { since: Date.now(), totals: { micSec: 0, liveSec: 0, liveCount: 0, songs: 0, sfx: 0 }, days: {}, voices: {} };
}

export class StatsManager {
  constructor({ audioEngine, presence, filePlayer }) {
    this.audioEngine = audioEngine;
    this.presence = presence;
    this.filePlayer = filePlayer;
    this.data = this.load();
    this.dirty = false;
    this.wasLive = false;
    this.lastSong = null;
    this.visible = false;
    this.card = document.getElementById('statsCard');
  }

  load() {
    try {
      const d = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (d && d.totals) return { ...blank(), ...d, totals: { ...blank().totals, ...d.totals } };
    } catch (_) {}
    return blank();
  }

  save() {
    if (!this.dirty) return;
    // keep the file small
    const keep = Object.keys(this.data.days).sort().slice(-KEEP_DAYS);
    for (const k of Object.keys(this.data.days)) if (!keep.includes(k)) delete this.data.days[k];
    try { localStorage.setItem(KEY, JSON.stringify(this.data)); this.dirty = false; } catch (_) {}
  }

  day() {
    const k = today();
    return (this.data.days[k] ||= { micSec: 0, liveSec: 0, songs: 0, sfx: 0 });
  }

  start() {
    setInterval(() => this.tick(), 1000);
    setInterval(() => this.save(), 10000);
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.save(); });
    window.addEventListener('pagehide', () => this.save());

    document.addEventListener('nirmal:sfx', () => {
      this.data.totals.sfx++;
      this.day().sfx++;
      this.dirty = true;
    });
    this.filePlayer?.addEventListener('playing', () => {
      const src = this.filePlayer.currentSrc || this.filePlayer.src;
      if (src && src !== this.lastSong) {
        this.lastSong = src;
        this.data.totals.songs++;
        this.day().songs++;
        this.dirty = true;
      }
    });

    if (this.card) {
      try {
        new IntersectionObserver((entries) => { for (const en of entries) this.visible = en.isIntersecting; }).observe(this.card);
      } catch (_) { this.visible = true; }
      document.getElementById('btnResetStats')?.addEventListener('click', () => {
        if (!window.confirm('Reset all usage stats on this device?')) return;
        this.data = blank();
        this.dirty = true;
        this.save();
        this.render();
      });
      setInterval(() => { if (this.visible && !document.hidden) this.render(); }, 2000);
      this.render();
    }
  }

  tick() {
    const micOn = !!this.audioEngine?.activeMicStream?.active;
    if (micOn) {
      this.data.totals.micSec++;
      this.day().micSec++;
      const key = this.audioEngine.currentPreset || 'normal';
      this.data.voices[key] = (this.data.voices[key] || 0) + 1;
      this.dirty = true;
    }
    const liveOn = !!this.presence?.isHostingLive?.();
    if (liveOn) {
      this.data.totals.liveSec++;
      this.day().liveSec++;
      if (!this.wasLive) this.data.totals.liveCount++;
      this.dirty = true;
    }
    this.wasLive = liveOn;
  }

  voiceLabel(key) {
    if (key === 'normal') return 'Natural (bypass)';
    const el = document.querySelector(`.preset-btn[data-preset="${CSS.escape(key)}"] span`);
    return el?.textContent?.trim() || key;
  }

  render() {
    if (!this.card) return;
    const set = (id, text) => { const el = document.getElementById(id); if (el && el.textContent !== text) el.textContent = text; };
    const t = this.data.totals;
    const d = this.data.days[today()] || { micSec: 0, liveSec: 0, songs: 0, sfx: 0 };
    set('stMicToday', formatDuration(d.micSec));
    set('stMicTotal', formatDuration(t.micSec));
    set('stLiveCount', String(t.liveCount));
    set('stLiveTime', formatDuration(t.liveSec));
    set('stSongs', String(t.songs));
    set('stSfx', String(t.sfx));

    const list = document.getElementById('stVoices');
    if (!list) return;
    const entries = Object.entries(this.data.voices).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const total = entries.reduce((s, [, v]) => s + v, 0) || 1;
    const sig = entries.map(([k, v]) => `${k}:${Math.round(v / 5)}`).join('|');
    if (list.dataset.sig === sig) return;
    list.dataset.sig = sig;
    list.textContent = '';
    if (!entries.length) {
      const p = document.createElement('p');
      p.className = 'help-text';
      p.textContent = 'Turn on your mic and pick a voice to start collecting stats.';
      list.appendChild(p);
      return;
    }
    for (const [key, sec] of entries) {
      const row = document.createElement('div');
      row.className = 'st-voice';
      const name = document.createElement('span');
      name.textContent = this.voiceLabel(key);
      const bar = document.createElement('div');
      bar.className = 'st-bar';
      const fill = document.createElement('i');
      fill.style.width = `${Math.max(4, Math.round((sec / total) * 100))}%`;
      bar.appendChild(fill);
      const time = document.createElement('b');
      time.textContent = formatDuration(sec);
      row.append(name, bar, time);
      list.appendChild(row);
    }
  }
}
