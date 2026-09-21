import { LiveKitLiveStreamHost } from './livekit-host.js';

// Nirmal Karaoke is now deliberately SFU-first for web broadcasts. There is no
// PeerJS fallback because peer-to-peer fan-out is the source of upload spikes,
// buffering and duet instability as audience size grows.
export class LiveStreamHost {
  constructor(audioEngine) {
    this.audioEngine = audioEngine;
    this.impl = new LiveKitLiveStreamHost(audioEngine);
    this.roomId = null;
  }

  get room() { return this.impl?.room; }
  get hostCamera() { return this.impl?.hostCamera; }
  get filterManager() { return this.impl?.filterManager; }

  isConnected() {
    return !!(this.impl?.isConnected?.() || (this.room && this.room.state === 'connected'));
  }

  init(...args) {
    this.impl.init(...args);
  }

  async createRoom(...args) {
    const id = await this.impl.createRoom(...args);
    this.roomId = id;
    return id;
  }
  async endRoom(...args) {
    const res = await this.impl.endRoom?.(...args);
    this.roomId = null;
    return res;
  }
  ensureProgramAudioPublished(...args) { return this.impl.ensureProgramAudioPublished?.(...args); }

  broadcastChatMessage(...args) { return this.impl.broadcastChatMessage?.(...args); }
  broadcastFullLyrics(...args) { return this.impl.broadcastFullLyrics?.(...args); }
  broadcastTime(...args) { return this.impl.broadcastTime?.(...args); }
  setGuestMute(...args) { return this.impl.setGuestMute?.(...args); }
  toggleHostCamera(...args) { return this.impl.toggleHostCamera?.(...args); }
  switchHostCamera(...args) { return this.impl.switchHostCamera?.(...args); }
  setHostFilter(...args) { return this.impl.setHostFilter?.(...args); }
  getHostFilter(...args) { return this.impl.getHostFilter?.(...args); }
  setAudienceMonitorEnabled(...args) { return this.impl.setAudienceMonitorEnabled?.(...args); }
  setAudienceMonitorEnabledFromGesture(...args) { return this.impl.setAudienceMonitorEnabledFromGesture?.(...args); }
  unlockAudienceAudioFromGesture(...args) { return this.impl.unlockAudienceAudioFromGesture?.(...args); }
  resumeAudienceAudioPlayback(...args) { return this.impl.resumeAudienceAudioPlayback?.(...args); }
  isAudienceMonitorEnabled(...args) { return this.impl.isAudienceMonitorEnabled?.(...args); }
  playAudienceGuest(...args) { return this.impl.playAudienceGuest?.(...args); }
  primeAudienceMonitorFromGesture(...args) { return this.impl.primeAudienceMonitorFromGesture?.(...args); }
  refreshAudienceMonitorOutputDevice(...args) { return this.impl.refreshAudienceMonitorOutputDevice?.(...args); }
}
