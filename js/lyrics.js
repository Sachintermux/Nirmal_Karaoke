export class LyricsManager {
  constructor() {
    this.parsedLyrics = [];
    this.currentLyricIndex = -1;
    this.lyricSyncOffset = 0.0;
    this.currentActiveLyricEl = null;

    this.lyricsContent = document.getElementById('lyricsContent');
    this.lblLyricsStatus = document.getElementById('lblLyricsStatus');
    this.lyricsDisplayContainer = document.getElementById('lyricsDisplayContainer');
    this.btnDownloadAutoLrc = document.getElementById('btnDownloadAutoLrc');
    this.lyricSyncControls = document.getElementById('lyricSyncControls');
    this.lblSyncOffset = document.getElementById('lblSyncOffset');
    this.filePlayer = document.getElementById('filePlayer');
    this.btnAdminFollowLyrics = document.getElementById('btnAdminFollowLyrics');
    this.onLyricsUpdated = null;
    this._rafId = null;
    this.isUserScrolling = false;
    this._userScrollTimer = null;

    const onUserScroll = () => {
      this.isUserScrolling = true;
      if (this.btnAdminFollowLyrics && this.currentLyricIndex >= 0) {
        this.btnAdminFollowLyrics.style.display = 'inline-flex';
      }
      if (this._userScrollTimer) clearTimeout(this._userScrollTimer);
      this._userScrollTimer = setTimeout(() => {
        this.isUserScrolling = false;
        if (this.btnAdminFollowLyrics) this.btnAdminFollowLyrics.style.display = 'none';
        if (this.currentLyricIndex >= 0) {
          this.scrollToActiveLyric(true);
        }
      }, 2600);
    };

    this.lyricsDisplayContainer?.addEventListener('wheel', onUserScroll, { passive: true });
    this.lyricsDisplayContainer?.addEventListener('touchstart', onUserScroll, { passive: true });

    this.btnAdminFollowLyrics?.addEventListener('click', () => {
      this.isUserScrolling = false;
      if (this.btnAdminFollowLyrics) this.btnAdminFollowLyrics.style.display = 'none';
      if (this.currentLyricIndex >= 0) {
        this.scrollToActiveLyric(true);
      }
    });

    this.filePlayer?.addEventListener('play', () => this.startSmoothAnimation());
    this.filePlayer?.addEventListener('pause', () => this.stopSmoothAnimation());
    this.filePlayer?.addEventListener('ended', () => this.stopSmoothAnimation());
    this.filePlayer?.addEventListener('seeked', () => this.updateLyricScrollPosition());
  }

  startSmoothAnimation() {
    if (this._rafId) cancelAnimationFrame(this._rafId);
    const loop = () => {
      if (this.filePlayer && !this.filePlayer.paused && !this.filePlayer.ended) {
        this.updateLyricScrollPosition();
        this._rafId = requestAnimationFrame(loop);
      } else {
        this._rafId = null;
      }
    };
    this._rafId = requestAnimationFrame(loop);
  }

  stopSmoothAnimation() {
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    this.updateLyricScrollPosition();
  }

  formatDuration(sec) {
    if (!sec) return '';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60).toString().padStart(2, '0');
    return `(${m}:${s})`;
  }

  // Cleans messy movie / artist tags from song titles for accurate LRCLIB searching
  sanitizeSongTitle(title) {
    if (!title) return '';
    let clean = title
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/&#039;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/\.[^/.]+$/, '');
    clean = clean.replace(/\(feat\..*?\)/gi, '');
    clean = clean.replace(/\[feat\..*?\]/gi, '');
    clean = clean.replace(/\(from\s+.*?\)/gi, '');
    clean = clean.replace(/\[from\s+.*?\]/gi, '');
    clean = clean.replace(/\(.*?\)/g, '');
    clean = clean.replace(/\[.*?\]/g, '');
    clean = clean.replace(/[_\-+]/g, ' ');
    return clean.replace(/\s+/g, ' ').trim();
  }

  cleanFileName(fileName) {
    return this.sanitizeSongTitle(fileName);
  }

  getID3Tags(file) {
    return new Promise((resolve) => {
      if (!window.jsmediatags) return resolve(null);
      window.jsmediatags.read(file, {
        onSuccess: (tag) => resolve(tag.tags),
        onError: () => resolve(null)
      });
    });
  }

  parseLRC(text) {
    this.parsedLyrics = [];
    if (!text) return;

    const tagRegex = /\[(\d{2}):(\d{2}(?:\.\d{1,3})?)\]/g;
    text.split('\n').forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const timestamps = [];
      let match;
      while ((match = tagRegex.exec(trimmed)) !== null) {
        const minutes = parseInt(match[1], 10);
        const seconds = parseFloat(match[2]);
        timestamps.push(minutes * 60 + seconds);
      }
      const lyricText = trimmed.replace(tagRegex, '').trim();
      if (lyricText && timestamps.length > 0) {
        timestamps.forEach((time) => {
          this.parsedLyrics.push({ time, text: lyricText });
        });
      }
    });

    this.parsedLyrics.sort((a, b) => a.time - b.time);
    this.lyricSyncOffset = 0.0;
    this.updateSyncUI();
    this.renderLyrics();

    if (this.parsedLyrics.length > 0) {
      if (this.lblLyricsStatus) {
        this.lblLyricsStatus.textContent = `✔️ ${this.parsedLyrics.length} Lines Synced`;
        this.lblLyricsStatus.style.color = 'var(--accent-green)';
      }
      if (this.lyricSyncControls) this.lyricSyncControls.style.display = 'flex';
      if (this.btnDownloadAutoLrc) this.btnDownloadAutoLrc.style.display = 'block';

      // Notify live broadcast
      if (this.onLyricsUpdated) {
        this.onLyricsUpdated(this.parsedLyrics);
      }
    } else {
      if (this.lblLyricsStatus) {
        this.lblLyricsStatus.textContent = '⚠️ No Synced Lines Found';
        this.lblLyricsStatus.style.color = 'var(--accent-orange)';
      }
      if (this.lyricSyncControls) this.lyricSyncControls.style.display = 'none';
    }
  }

  renderLyrics() {
    if (!this.lyricsContent) return;
    this.lyricsContent.innerHTML = '';
    if (this.parsedLyrics.length === 0) {
      this.lyricsContent.innerHTML = '<div class="lyric-line" style="color: var(--text-dim); opacity: 0.5;">Instrumental or No Lyrics Found.</div>';
      return;
    }

    this.parsedLyrics.forEach((lyric, index) => {
      const div = document.createElement('div');
      div.className = 'lyric-line';
      div.id = `lyric-${index}`;
      div.textContent = lyric.text;
      div.title = `Click to seek to ${this.formatDuration(lyric.time)}`;
      div.addEventListener('click', () => {
        if (this.filePlayer && Number.isFinite(lyric.time)) {
          this.filePlayer.currentTime = Math.max(0, lyric.time + this.lyricSyncOffset);
          this.updateLyricScrollPosition();
        }
      });
      this.lyricsContent.appendChild(div);
    });

    this.currentLyricIndex = -1;
    this.currentActiveLyricEl = null;
    this.isUserScrolling = false;
    if (this.btnAdminFollowLyrics) this.btnAdminFollowLyrics.style.display = 'none';
    if (this.lyricsDisplayContainer) {
      this.lyricsDisplayContainer.scrollTo({ top: 0, behavior: 'auto' });
    }
  }

  scrollToActiveLyric(smooth = true) {
    if (!this.currentActiveLyricEl || !this.lyricsDisplayContainer) return;
    const container = this.lyricsDisplayContainer;
    const el = this.currentActiveLyricEl;
    let top = 0;
    let curr = el;
    while (curr && curr !== container) {
      top += curr.offsetTop;
      curr = curr.offsetParent;
    }
    const targetTop = top - (container.clientHeight / 2) + (el.clientHeight / 2);
    container.scrollTo({
      top: Math.max(0, targetTop),
      behavior: smooth ? 'smooth' : 'auto'
    });
  }

  updateSyncUI() {
    if (this.lblSyncOffset) {
      this.lblSyncOffset.textContent = (this.lyricSyncOffset > 0 ? '+' : '') + this.lyricSyncOffset.toFixed(1) + 's';
    }
    this.updateLyricScrollPosition();
  }

  updateLyricScrollPosition() {
    if (this.parsedLyrics.length === 0 || !this.filePlayer) return;
    const t = this.filePlayer.currentTime - this.lyricSyncOffset;
    let idx = -1;

    for (let i = 0; i < this.parsedLyrics.length; i++) {
      if (t >= this.parsedLyrics[i].time) {
        idx = i;
      } else {
        break;
      }
    }

    if (idx !== this.currentLyricIndex) {
      this.currentLyricIndex = idx;
      if (this.currentActiveLyricEl) {
        this.currentActiveLyricEl.classList.remove('active');
        this.currentActiveLyricEl = null;
      }
      if (idx !== -1) {
        const el = document.getElementById(`lyric-${idx}`);
        if (el) {
          el.classList.add('active');
          this.currentActiveLyricEl = el;
          // When lyric comes to next line, automatically smoothly scroll to that line!
          this.isUserScrolling = false;
          if (this.btnAdminFollowLyrics) this.btnAdminFollowLyrics.style.display = 'none';
          this.scrollToActiveLyric(true);
        }
      }
    }

    // Dynamic gradient progress fill for active lyric line
    if (idx !== -1 && this.currentActiveLyricEl) {
      const current = this.parsedLyrics[idx];
      const nextTime = (idx < this.parsedLyrics.length - 1) ? this.parsedLyrics[idx + 1].time : (current.time + 4.0);
      const span = Math.max(0.2, nextTime - current.time);
      const progress = Math.max(0, Math.min(100, ((t - current.time) / span) * 100));
      this.currentActiveLyricEl.style.setProperty('--fill', `${progress}%`);
    }
  }

  generateOffsetLrcText() {
    let out = '';
    this.parsedLyrics.forEach((l) => {
      const nt = Math.max(0, l.time + this.lyricSyncOffset);
      const m = Math.floor(nt / 60).toString().padStart(2, '0');
      const s = (nt % 60).toFixed(2).padStart(5, '0');
      out += `[${m}:${s}]${l.text}\n`;
    });
    return out;
  }

  downloadLrc(filename) {
    if (this.parsedLyrics.length === 0) return;
    const blob = new Blob([this.generateOffsetLrcText()], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    }, 100);
  }

  async triggerLRCLibSearch(cleanTitle, displayArtist, audioDuration) {
    if (this.lblLyricsStatus) {
      this.lblLyricsStatus.textContent = `Searching lyrics for: "${cleanTitle}"...`;
      this.lblLyricsStatus.style.color = 'var(--text-dim)';
    }

    const searchQueries = [
      `${cleanTitle} ${displayArtist}`.trim(),
      cleanTitle.trim()
    ];

    let candidates = [];
    for (const q of searchQueries) {
      try {
        const response = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(q)}`);
        if (!response.ok) continue;
        const data = await response.json();
        if (Array.isArray(data) && data.length > 0) {
          candidates = data.filter((t) => t.syncedLyrics);
          if (candidates.length > 0) break;
        }
      } catch (e) {
        console.warn('LRCLIB candidate query failed:', q);
      }
    }

    if (candidates.length === 0) {
      if (this.lblLyricsStatus) {
        this.lblLyricsStatus.textContent = `No synced lyrics found for "${cleanTitle}".`;
        this.lblLyricsStatus.style.color = 'var(--text-dim)';
      }
      this.parseLRC('');
      return;
    }

    let bestMatch = candidates[0];
    if (audioDuration && audioDuration > 0) {
      let minDiff = Infinity;
      candidates.forEach((cand) => {
        const diff = Math.abs(cand.duration - audioDuration);
        if (diff < minDiff) {
          minDiff = diff;
          bestMatch = cand;
        }
      });
    }

    this.parseLRC(bestMatch.syncedLyrics);
    if (this.lblLyricsStatus) {
      this.lblLyricsStatus.textContent = `✔️ Synced: ${bestMatch.trackName} - ${bestMatch.artistName}`;
      this.lblLyricsStatus.style.color = 'var(--accent-green)';
    }
  }

  async autoFetchLyricsFromData(title, artist, duration) {
    const cleanTitle = this.sanitizeSongTitle(title);
    const cleanArtist = this.sanitizeSongTitle(artist || '');
    this.triggerLRCLibSearch(cleanTitle, cleanArtist, duration);
  }

  async autoFetchLyricsWithLengthMatch(audioFile, audioDuration) {
    const tags = await this.getID3Tags(audioFile);
    let title = tags?.title || this.cleanFileName(audioFile.name);
    let artist = tags?.artist || '';
    this.autoFetchLyricsFromData(title, artist, audioDuration);
  }

  reset() {
    this.parsedLyrics = [];
    this.currentLyricIndex = -1;
    this.lyricSyncOffset = 0.0;
    this.updateSyncUI();
    if (this.btnDownloadAutoLrc) this.btnDownloadAutoLrc.style.display = 'none';
    if (this.lyricSyncControls) this.lyricSyncControls.style.display = 'none';
    if (this.lyricsContent) {
      this.lyricsContent.innerHTML = '<div class="lyric-line" style="color: var(--text-dim); opacity: 0.5;">No Lyrics Loaded.</div>';
      this.lyricsContent.style.transform = `translateY(0px)`;
    }
    if (this.lblLyricsStatus) {
      this.lblLyricsStatus.textContent = 'Upload or search music to scan for lyrics.';
      this.lblLyricsStatus.style.color = 'var(--text-dim)';
    }
    if (this.onLyricsUpdated) {
      this.onLyricsUpdated([]);
    }
  }
}