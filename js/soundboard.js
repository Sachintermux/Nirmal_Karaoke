/**
 * Soundboard: built-in synthesised sounds + the user's own uploaded sounds, with hotkeys.
 *
 *  - Built-ins come from sfx.js (no files). Uploads are stored in IndexedDB on this device only.
 *  - Every sound plays through the shared master bus in sfx.js (program mix + local speakers),
 *    so the master volume and "Stop all" cover built-ins and uploads alike.
 *  - Hotkeys are page-level (a browser cannot register system-wide hotkeys). They are ignored while
 *    typing in a field, and are stored in localStorage as KeyboardEvent.code values.
 */
import { playSFX, getSfxMaster, setSfxVolume, stopAllSfx } from './sfx.js?v=31';

export const BUILTIN_SOUNDS = [
  { id: 'cheer', emoji: '👏', name: 'Cheer', elId: 'sfxCheer' },
  { id: 'airhorn', emoji: '🎺', name: 'Airhorn', elId: 'sfxAirhorn' },
  { id: 'drumroll', emoji: '🥁', name: 'Drumroll', elId: 'sfxDrumroll' },
  { id: 'beatdrop', emoji: '💥', name: '808 Drop', elId: 'sfxBeatdrop' },
  { id: 'guitar', emoji: '🎸', name: 'Chime', elId: 'sfxGuitar' },
  { id: 'sparkle', emoji: '✨', name: 'Sparkle', elId: 'sfxSparkle' },
  { id: 'scratch', emoji: '🎚️', name: 'Scratch', elId: 'sfxScratch' },
  { id: 'bleep', emoji: '🔇', name: 'Bleep', elId: 'sfxBleep' }
];

const DB_NAME = 'nirmal-karaoke';
const STORE = 'sounds';
const KEYS_STORAGE = 'nirmal_soundboard_keys';
const MAX_SOUNDS = 40;
const MAX_BYTES = 10 * 1024 * 1024;
// Keys that would fight with normal page use
const RESERVED_CODES = new Set(['Space', 'Tab', 'Enter', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight', 'CapsLock']);

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB unavailable'));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let result;
    try { result = fn(store); } catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(result?.result ?? result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export function codeLabel(code) {
  if (!code) return 'Set key';
  return code.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Numpad/, 'Num ').replace('Backquote', '`')
    .replace('Minus', '-').replace('Equal', '=').replace('BracketLeft', '[').replace('BracketRight', ']')
    .replace('Semicolon', ';').replace('Quote', "'").replace('Comma', ',').replace('Period', '.').replace('Slash', '/');
}

export class SoundboardManager {
  constructor(audioEngine) {
    this.audioEngine = audioEngine;
    this.db = null;
    this.custom = [];            // {id, name, volume}
    this.buffers = new Map();    // id -> AudioBuffer
    this.keys = this.loadKeys(); // soundId -> KeyboardEvent.code
    this.bindingFor = null;
    this.grid = null;
    this.msg = null;
  }

  loadKeys() {
    try { return JSON.parse(localStorage.getItem(KEYS_STORAGE) || '{}') || {}; } catch (_) { return {}; }
  }

  saveKeys() {
    try { localStorage.setItem(KEYS_STORAGE, JSON.stringify(this.keys)); } catch (_) {}
  }

  say(text, isError = false) {
    if (!this.msg) return;
    this.msg.textContent = text || '';
    this.msg.style.color = isError ? 'var(--red)' : '';
    this.msg.style.display = text ? 'block' : 'none';
  }

  async init() {
    this.grid = document.getElementById('sbGrid');
    this.msg = document.getElementById('sbMsg');
    if (!this.grid) return;

    try {
      this.db = await openDb();
      const all = await tx(this.db, 'readonly', (store) => store.getAll());
      this.custom = (all || []).sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0))
        .map((r) => ({ id: r.id, name: r.name, volume: r.volume ?? 1 }));
    } catch (err) {
      console.warn('[Soundboard] storage unavailable, uploads will not persist:', err?.message || err);
      this.db = null;
    }

    this.render();
    this.wireControls();
    document.addEventListener('keydown', (e) => this.onKeyDown(e));
  }

  wireControls() {
    const file = document.getElementById('sbFileInput');
    file?.addEventListener('change', async () => {
      const files = [...(file.files || [])];
      file.value = '';
      for (const f of files) await this.addFile(f);
    });
    document.getElementById('btnSbStop')?.addEventListener('click', () => this.stopAll());
    const vol = document.getElementById('sliderSbVol');
    const lbl = document.getElementById('valSbVol');
    vol?.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      if (lbl) lbl.textContent = `${Math.round(v * 100)}%`;
      setSfxVolume(this.audioEngine, v);
    });
  }

  // ── rendering ────────────────────────────────────────────────────────────────────────────────
  render() {
    if (!this.grid) return;
    this.grid.textContent = '';
    for (const s of BUILTIN_SOUNDS) this.grid.appendChild(this.buildTile({ id: s.id, label: s.name, emoji: s.emoji, builtin: true, elId: s.elId }));
    for (const c of this.custom) this.grid.appendChild(this.buildTile({ id: c.id, label: c.name, emoji: '🎵', builtin: false, volume: c.volume }));
  }

  buildTile({ id, label, emoji, builtin, elId, volume }) {
    const tile = document.createElement('div');
    tile.className = 'sb-tile';
    tile.dataset.sound = id;

    const play = document.createElement('button');
    play.type = 'button';
    play.className = 'sb-play';
    if (elId) play.id = elId;
    const em = document.createElement('span');
    em.className = 'sb-emoji';
    em.textContent = emoji;
    const nm = document.createElement('span');
    nm.className = 'sb-name';
    nm.textContent = label;
    play.append(em, nm);
    play.addEventListener('click', () => this.play(id));

    const meta = document.createElement('div');
    meta.className = 'sb-meta';
    const key = document.createElement('button');
    key.type = 'button';
    key.className = 'sb-key' + (this.keys[id] ? ' is-set' : '');
    key.textContent = codeLabel(this.keys[id]);
    key.title = 'Click, then press a key to bind a hotkey (Backspace clears)';
    key.addEventListener('click', () => this.startBinding(id, key));
    meta.appendChild(key);

    if (!builtin) {
      const vol = document.createElement('input');
      vol.type = 'range';
      vol.min = '0';
      vol.max = '2';
      vol.step = '0.05';
      vol.value = String(volume ?? 1);
      vol.className = 'sb-vol';
      vol.title = 'Volume of this sound';
      vol.addEventListener('input', () => this.setVolume(id, parseFloat(vol.value)));
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'sb-del';
      del.textContent = '🗑';
      del.title = 'Remove this sound';
      del.addEventListener('click', () => this.remove(id));
      meta.append(vol, del);
    }

    tile.append(play, meta);
    return tile;
  }

  flash(id) {
    const tile = this.grid?.querySelector(`.sb-tile[data-sound="${CSS.escape(id)}"]`);
    if (!tile) return;
    tile.classList.add('is-playing');
    setTimeout(() => tile.classList.remove('is-playing'), 260);
  }

  // ── playback ─────────────────────────────────────────────────────────────────────────────────
  async play(id) {
    this.flash(id);
    const builtin = BUILTIN_SOUNDS.find((s) => s.id === id);
    if (builtin) return playSFX(id, this.audioEngine);

    const meta = this.custom.find((c) => c.id === id);
    if (!meta) return;
    try {
      await this.audioEngine.boot();
      const ctx = this.audioEngine.ctx;
      if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
      let buf = this.buffers.get(id);
      if (!buf) {
        const rec = await tx(this.db, 'readonly', (store) => store.get(id));
        if (!rec?.blob) throw new Error('Sound data missing');
        buf = await ctx.decodeAudioData(await rec.blob.arrayBuffer());
        this.buffers.set(id, buf);
      }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const g = ctx.createGain();
      g.gain.value = meta.volume ?? 1;
      src.connect(g);
      g.connect(getSfxMaster(this.audioEngine));
      (this.audioEngine._sfxSources ||= new Set()).add(src);
      src.onended = () => { this.audioEngine._sfxSources?.delete(src); try { g.disconnect(); } catch (_) {} };
      src.start();
      try { document.dispatchEvent(new CustomEvent('nirmal:sfx', { detail: { type: 'custom' } })); } catch (_) {}
    } catch (err) {
      console.warn('[Soundboard] play failed:', err);
      this.say(`Could not play "${meta.name}". The file may not be a supported audio format.`, true);
    }
  }

  stopAll() {
    stopAllSfx(this.audioEngine);
  }

  // ── custom sounds ───────────────────────────────────────────────────────────────────────────
  async addFile(file) {
    if (!this.db) { this.say('Saving sounds is not available in this browser (private mode?).', true); return; }
    if (!file.type.startsWith('audio/') && !/\.(mp3|wav|ogg|m4a|aac|flac|webm)$/i.test(file.name)) {
      this.say(`"${file.name}" is not an audio file.`, true);
      return;
    }
    if (file.size > MAX_BYTES) { this.say(`"${file.name}" is larger than 10 MB.`, true); return; }
    if (this.custom.length >= MAX_SOUNDS) { this.say(`You can keep up to ${MAX_SOUNDS} sounds.`, true); return; }
    try {
      // Fail early on files the browser cannot decode
      await this.audioEngine.boot();
      await this.audioEngine.ctx.decodeAudioData(await file.arrayBuffer());
    } catch (_) {
      this.say(`Could not read "${file.name}" as audio.`, true);
      return;
    }
    const id = 'snd_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const name = file.name.replace(/\.[^/.]+$/, '').slice(0, 24) || 'Sound';
    try {
      await tx(this.db, 'readwrite', (store) => store.put({ id, name, volume: 1, blob: file, addedAt: Date.now() }));
      this.custom.push({ id, name, volume: 1 });
      this.render();
      this.say(`Added "${name}". Click its key badge to give it a hotkey.`);
    } catch (err) {
      this.say('Could not save the sound (storage full?).', true);
    }
  }

  async setVolume(id, volume) {
    const c = this.custom.find((x) => x.id === id);
    if (!c) return;
    c.volume = volume;
    clearTimeout(this._volTimer);
    this._volTimer = setTimeout(async () => {
      try {
        const rec = await tx(this.db, 'readonly', (store) => store.get(id));
        if (rec) await tx(this.db, 'readwrite', (store) => store.put({ ...rec, volume }));
      } catch (_) {}
    }, 300);
  }

  async remove(id) {
    const c = this.custom.find((x) => x.id === id);
    if (!c || !window.confirm(`Remove "${c.name}" from your soundboard?`)) return;
    try { await tx(this.db, 'readwrite', (store) => store.delete(id)); } catch (_) {}
    this.custom = this.custom.filter((x) => x.id !== id);
    this.buffers.delete(id);
    delete this.keys[id];
    this.saveKeys();
    this.render();
  }

  // ── hotkeys ──────────────────────────────────────────────────────────────────────────────────
  startBinding(id, keyBtn) {
    this.cancelBinding();
    this.bindingFor = { id, keyBtn };
    keyBtn.textContent = 'Press a key…';
    keyBtn.classList.add('is-binding');
  }

  cancelBinding() {
    if (!this.bindingFor) return;
    const { id, keyBtn } = this.bindingFor;
    keyBtn.textContent = codeLabel(this.keys[id]);
    keyBtn.classList.remove('is-binding');
    this.bindingFor = null;
  }

  onKeyDown(e) {
    if (this.bindingFor) {
      e.preventDefault();
      e.stopPropagation();
      const { id } = this.bindingFor;
      if (e.code === 'Escape') return this.cancelBinding();
      if (e.code === 'Backspace' || e.code === 'Delete') {
        delete this.keys[id];
      } else if (RESERVED_CODES.has(e.code)) {
        this.say('That key is reserved. Try a letter, number or F-key.', true);
        return this.cancelBinding();
      } else {
        for (const k of Object.keys(this.keys)) if (this.keys[k] === e.code) delete this.keys[k]; // one sound per key
        this.keys[id] = e.code;
      }
      this.bindingFor = null;
      this.saveKeys();
      this.render();
      return;
    }

    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    const id = Object.keys(this.keys).find((k) => this.keys[k] === e.code);
    if (!id) return;
    e.preventDefault();
    this.play(id);
  }
}
