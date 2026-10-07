/**
 * Call / Meeting Output ("use this studio as your microphone")
 *
 * A web page cannot register itself as a microphone in other apps, so this sends the
 * studio's finished program mix (your effected voice + backing music, after reverb/echo
 * and the limiter) to a chosen *output device* on its own audio stream. Pick a virtual
 * audio cable here (VB-Cable / VoiceMeeter on Windows, BlackHole on macOS) and then pick
 * that cable's OUTPUT as the microphone in Zoom / Meet / Teams / Discord.
 *
 * It is independent from the normal speaker/headphone output (ctx.destination), so you
 * keep monitoring on your headphones while the call hears the cable.
 */

const STORAGE_KEY = 'nirmal_call_output_device';
const VIRTUAL_CABLE_RE = /cable input|vb-audio|voicemeeter|blackhole|virtual (audio|cable)|loopback|vac\b/i;

export class CallOutputManager {
  constructor(audioEngine) {
    this.audioEngine = audioEngine;
    this.audioEl = null;
    this.gain = null;
    this.dest = null;
    this.sourceNode = null;
    this.active = false;
    this.deviceId = '';
    this.volume = 1;
    this.onStateChange = null;
  }

  static isSupported() {
    return typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
  }

  static isVirtualCableLabel(label) {
    return VIRTUAL_CABLE_RE.test(label || '');
  }

  static getSavedDevice() {
    try { return localStorage.getItem(STORAGE_KEY) || ''; } catch (_) { return ''; }
  }

  async listOutputDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'default' && d.deviceId !== 'communications')
      .map((d, i) => ({
        deviceId: d.deviceId,
        label: d.label || `Output ${i + 1}`,
        hasLabel: !!d.label,
        isVirtual: CallOutputManager.isVirtualCableLabel(d.label)
      }));
  }

  // Device names are hidden by browsers until the page has mic permission once.
  async requestLabels() {
    if (!navigator.mediaDevices?.getUserMedia) return;
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
  }

  _emit(state, detail = '') {
    try { this.onStateChange?.(state, detail); } catch (_) {}
  }

  _teardownGraph() {
    try { this.sourceNode?.disconnect(); } catch (_) {}
    try { this.gain?.disconnect(); } catch (_) {}
    this.sourceNode = null;
    this.gain = null;
    this.dest = null;
  }

  async start(deviceId, { monitorDeviceId = '' } = {}) {
    if (!CallOutputManager.isSupported()) {
      throw new Error('This browser cannot choose an output device. Use Chrome or Edge on desktop.');
    }
    if (!deviceId) {
      throw new Error('Pick your virtual cable (for example "CABLE Input") first.');
    }
    if (deviceId === monitorDeviceId) {
      throw new Error('That is the same device as your main audio output, so the call would also play out loud and echo. Choose the virtual cable instead.');
    }

    const engine = await this.audioEngine.boot();
    const ctx = this.audioEngine.ctx;
    const source = engine?.stereoMerge || this.audioEngine.engine?.stereoMerge;
    if (!ctx || !source) throw new Error('Audio engine is not ready yet. Start the mic or play a song once, then try again.');
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});

    // (Re)build a dedicated tap of the finished program mix.
    this._teardownGraph();
    this.gain = ctx.createGain();
    this.gain.gain.value = this.volume;
    try {
      this.dest = new MediaStreamAudioDestinationNode(ctx, {
        channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers'
      });
    } catch (_) {
      this.dest = ctx.createMediaStreamDestination();
    }
    source.connect(this.gain);
    this.gain.connect(this.dest);

    if (!this.audioEl) {
      this.audioEl = document.createElement('audio');
      this.audioEl.id = 'nirmal_call_output_audio';
      this.audioEl.autoplay = true;
      this.audioEl.style.display = 'none';
      document.body.appendChild(this.audioEl);
    }
    this.audioEl.srcObject = this.dest.stream;
    await this.audioEl.setSinkId(deviceId);
    await this.audioEl.play();

    this.deviceId = deviceId;
    this.active = true;
    try { localStorage.setItem(STORAGE_KEY, deviceId); } catch (_) {}
    this._emit('live');
  }

  stop() {
    try { this.audioEl?.pause(); } catch (_) {}
    if (this.audioEl) this.audioEl.srcObject = null;
    this._teardownGraph();
    this.active = false;
    this._emit('off');
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(2, Number(v) || 0));
    if (this.gain && this.audioEngine.ctx) {
      try { this.gain.gain.setTargetAtTime(this.volume, this.audioEngine.ctx.currentTime, 0.02); }
      catch (_) { this.gain.gain.value = this.volume; }
    }
  }

  async changeDevice(deviceId, opts) {
    if (!this.active) return;
    await this.start(deviceId, opts);
  }
}
