class NativePcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.offset = 0;
    this.port.onmessage = (event) => {
      const input = event.data;
      if (!input || !input.length) return;
      this.queue.push(new Float32Array(input));
      if (this.queue.length > 24) this.queue.splice(0, this.queue.length - 24);
    };
  }

  process(inputs, outputs) {
    const out = outputs[0];
    for (let ch = 0; ch < out.length; ch++) out[ch].fill(0);
    for (let i = 0; i < out[0].length; i++) {
      if (!this.queue.length) break;
      const chunk = this.queue[0];
      const channels = Math.max(1, Math.min(2, Math.floor(chunk.length / Math.max(1, 128))));
      // Native bridge sends interleaved stereo/mono. Infer stereo for normal output.
      const idx = this.offset;
      if (idx >= chunk.length) { this.queue.shift(); this.offset = 0; i--; continue; }
      out[0][i] = chunk[idx] || 0;
      if (out.length > 1) out[1][i] = chunk[idx + 1] ?? chunk[idx] ?? 0;
      this.offset += out.length > 1 ? 2 : 1;
    }
    return true;
  }
}
registerProcessor('native-pcm-player', NativePcmPlayer);
