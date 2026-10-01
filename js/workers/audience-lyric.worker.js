/**
 * Nirmal Karaoke - Audience Background Lyric Processing & Sync Worker
 * Offloads lyric parsing, LRC formatting, timestamp sorting, and binary-search
 * time synchronization from the main thread.
 */

let lyrics = [];
let currentIndex = -1;
let lastFillInt = -1;
let clockState = {
  hostTime: 0,
  receivedPerf: 0,
  playing: false,
  clientSyncOffset: 0
};

self.onmessage = function (e) {
  const msg = e.data;
  if (!msg) return;

  switch (msg.type) {
    case 'PARSE':
      parseLyrics(msg.payload);
      break;

    case 'CLOCK_UPDATE':
      if (msg.clock) {
        clockState = { ...clockState, ...msg.clock };
      }
      break;

    case 'EVAL_TIME':
      evaluateTime(msg.time);
      break;

    case 'RESET':
      lyrics = [];
      currentIndex = -1;
      lastFillInt = -1;
      break;
  }
};

function parseLyrics(payload) {
  lyrics = [];
  currentIndex = -1;
  lastFillInt = -1;

  if (!payload) {
    self.postMessage({ type: 'PARSED', lyrics: [] });
    return;
  }

  // Case 1: Payload is already an Array
  if (Array.isArray(payload)) {
    lyrics = payload.map(l => ({
      time: Number(l?.time ?? l?.timestamp ?? l?.startTime ?? 0),
      text: String(l?.text ?? l?.line ?? '').trim()
    })).filter(l => Number.isFinite(l.time) && l.text);
  }
  // Case 2: Payload is an LRC string
  else if (typeof payload === 'string') {
    const lrcLines = payload.split(/\r?\n/);
    const timeRegex = /\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/g;

    for (const rawLine of lrcLines) {
      const trimmed = rawLine.trim();
      if (!trimmed || trimmed.startsWith('[ar:') || trimmed.startsWith('[ti:') || trimmed.startsWith('[al:')) continue;

      let match;
      const timestamps = [];
      timeRegex.lastIndex = 0;
      while ((match = timeRegex.exec(trimmed)) !== null) {
        const min = parseInt(match[1], 10);
        const sec = parseInt(match[2], 10);
        const msRaw = match[3] || '0';
        const ms = msRaw.length === 3 ? parseInt(msRaw, 10) / 1000 : parseInt(msRaw, 10) / 100;
        timestamps.push(min * 60 + sec + ms);
      }

      const text = trimmed.replace(timeRegex, '').trim();
      if (text) {
        for (const t of timestamps) {
          lyrics.push({ time: t, text });
        }
      }
    }
  }

  // Sort ascending by timestamp
  lyrics.sort((a, b) => a.time - b.time);

  self.postMessage({ type: 'PARSED', lyrics });
}

function binarySearchIndex(time) {
  if (!lyrics.length) return -1;
  if (time < lyrics[0].time) return -1;
  if (time >= lyrics[lyrics.length - 1].time) return lyrics.length - 1;

  let low = 0;
  let high = lyrics.length - 1;
  let ans = -1;

  while (low <= high) {
    const mid = (low + high) >>> 1;
    if (lyrics[mid].time <= time) {
      ans = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return ans;
}

function evaluateTime(targetTime) {
  if (!lyrics.length) return;

  let time = targetTime;
  if (time === undefined && clockState.playing && clockState.receivedPerf) {
    const elapsed = Math.max(0, performance.now() - clockState.receivedPerf) / 1000;
    time = Math.max(0, clockState.hostTime + elapsed - (clockState.clientSyncOffset || 0));
  }

  if (time === undefined || !Number.isFinite(time)) return;

  const idx = binarySearchIndex(time);
  let progressInt = 0;

  if (idx >= 0) {
    const curTime = lyrics[idx].time;
    const nextTime = idx < lyrics.length - 1 ? lyrics[idx + 1].time : curTime + 4.0;
    const span = Math.max(0.2, nextTime - curTime);
    const progress = Math.max(0, Math.min(100, ((time - curTime) / span) * 100));
    progressInt = Math.round(progress);
  }

  const indexChanged = idx !== currentIndex;
  const progressChanged = progressInt !== lastFillInt;

  if (indexChanged || progressChanged) {
    currentIndex = idx;
    lastFillInt = progressInt;

    self.postMessage({
      type: 'TICK_UPDATE',
      index: idx,
      progressInt,
      indexChanged
    });
  }
}
