import { SAAVN_API_URLS, TRENDING_SEARCH_TERMS } from './config.js';

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function formatDuration(sec) {
  const s = parseInt(sec, 10);
  if (!s || isNaN(s) || s <= 0) return '';
  const m = Math.floor(s / 60);
  const rem = (s % 60).toString().padStart(2, '0');
  return `${m}:${rem}`;
}

const DEFAULT_FALLBACK_TRACKS = [
  {
    title: 'Kesariya',
    artist: 'Pritam, Arijit Singh, Amitabh Bhattacharya',
    album: 'Brahmastra',
    url: 'https://aac.saavncdn.com/871/c2febd353f3a076a406fa37510f31f9f_320.mp4',
    image: 'https://c.saavncdn.com/871/Brahmastra-Original-Motion-Picture-Soundtrack-Hindi-2022-20221006155213-500x500.jpg',
    duration: 268
  },
  {
    title: 'Gehra Hua',
    artist: 'Shashwat Sachdev, Arijit Singh, Armaan Khan',
    album: 'Dhurandhar',
    url: 'https://aac.saavncdn.com/450/f467e05e2825cec2203546333e0d0550_320.mp4',
    image: 'https://c.saavncdn.com/450/Gehra-Hua-From-Dhurandhar-Hindi-2025-20251205154217-500x500.jpg',
    duration: 362
  },
  {
    title: 'Tum Hi Ho',
    artist: 'Arijit Singh, Mithoon',
    album: 'Aashiqui 2',
    url: 'https://aac.saavncdn.com/430/5c5ea5cc00e3bff45616013226f376fe_320.mp4',
    image: 'https://c.saavncdn.com/430/Aashiqui-2-Hindi-2013-500x500.jpg',
    duration: 262
  }
];

export class MusicSearchManager {
  constructor(audioEngine, lyricsManager) {
    this.audioEngine = audioEngine;
    this.lyricsManager = lyricsManager;

    // Up-Next continuous playback playlist
    this.playlist = [];
    this.currentTrackIndex = -1;

    // Autosearch and request cancellation controllers
    this.searchDebounceTimer = null;
    this.currentSearchAbortCtrl = null;

    // UI elements
    this.musicSearchBox = document.getElementById('musicSearchBox');
    this.musicSearchInput = document.getElementById('musicSearchInput');
    this.btnClearMusicSearch = document.getElementById('btnClearMusicSearch');
    this.btnDoMusicSearch = document.getElementById('btnDoMusicSearch');
    this.musicSearchResults = document.getElementById('musicSearchResults');
    this.musicListTitle = document.getElementById('musicListTitle');
    this.filePlayer = document.getElementById('filePlayer');
    this.playerWrapper = document.getElementById('playerWrapper');
    this.btnOpenMusicSearch = document.getElementById('btnOpenMusicSearch');
    this.btnStopMedia = document.getElementById('btnStopMedia');
    this.ledIn = document.getElementById('led-in');
    this.playlistContainer = document.getElementById('playlistContainer');
    this.presetPlaylistSelect = document.getElementById('presetPlaylistSelect');
    this.lblQueueCount = document.getElementById('lblQueueCount');

    this.initPlaylistEngine();
  }

  initPlaylistEngine() {
    // 1. Listen for default category changes and auto-hydrate queue
    this.presetPlaylistSelect?.addEventListener('change', (e) => {
      this.loadCategoryPlaylist(e.target.value);
    });

    // 2. Skip to next song
    document.getElementById('btnSkipNext')?.addEventListener('click', () => {
      this.playNextSong();
    });

    // 3. Clear queue
    document.getElementById('btnClearPlaylist')?.addEventListener('click', () => {
      this.playlist = [];
      this.currentTrackIndex = -1;
      this.renderPlaylist();
    });

    // 4. Autoplay next song when audio finishes
    this.filePlayer?.addEventListener('ended', () => {
      const isAutoplay = document.getElementById('autoplayToggle')?.checked ?? true;
      if (isAutoplay) {
        this.playNextSong();
      }
    });

    // 5. Audio playback error safety recovery
    this.filePlayer?.addEventListener('error', (e) => {
      console.warn('[MusicPlayer] Audio element error:', e);
      if (this.lyricsManager?.lblLyricsStatus) {
        this.lyricsManager.lblLyricsStatus.textContent = '⚠️ Stream error loading track. Skipping to next...';
        this.lyricsManager.lblLyricsStatus.style.color = 'var(--accent-orange, #ff9100)';
      }
      const isAutoplay = document.getElementById('autoplayToggle')?.checked ?? true;
      if (isAutoplay && this.playlist.length > 1) {
        setTimeout(() => this.playNextSong(), 1200);
      }
    });

    // 6. Stop media button reset
    this.btnStopMedia?.addEventListener('click', () => {
      if (this.filePlayer) {
        this.filePlayer.pause();
        this.filePlayer.src = '';
      }
      if (this.playerWrapper) this.playerWrapper.style.display = 'none';
      if (this.btnStopMedia) this.btnStopMedia.style.display = 'none';
      this.btnOpenMusicSearch?.classList.remove('active-file');
      this.ledIn?.classList.remove('active-blue');

      const npTitle = document.getElementById('nowPlayingTitle');
      const npArtist = document.getElementById('nowPlayingArtist');
      if (npTitle) npTitle.textContent = 'Choose a song to begin';
      if (npArtist) npArtist.textContent = 'Your personal karaoke studio';

      const artwork = document.querySelector('.artwork');
      if (artwork) artwork.innerHTML = '♫';

      this.currentTrackIndex = -1;
      this.renderPlaylist();
    });

    // 7. Live debounced autosearch as the user types
    this.musicSearchInput?.addEventListener('input', (e) => {
      const q = e.target.value.trim();
      if (this.btnClearMusicSearch) {
        this.btnClearMusicSearch.style.display = q ? 'block' : 'none';
      }
      if (this.searchDebounceTimer) clearTimeout(this.searchDebounceTimer);

      if (!q) {
        this.renderTrending();
        return;
      }

      this.searchDebounceTimer = setTimeout(() => {
        this.searchMusic(q);
      }, 280);
    });

    // 8. Clear button in search input
    this.btnClearMusicSearch?.addEventListener('click', () => {
      if (this.musicSearchInput) {
        this.musicSearchInput.value = '';
        this.musicSearchInput.focus();
      }
      if (this.btnClearMusicSearch) this.btnClearMusicSearch.style.display = 'none';
      this.renderTrending();
    });

    // 9. Quick Genre / Discovery Chips
    document.querySelectorAll('.music-chip')?.forEach((chip) => {
      chip.addEventListener('click', () => {
        const query = chip.getAttribute('data-query');
        if (!query) return;

        document.querySelectorAll('.music-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');

        if (this.musicSearchInput) {
          this.musicSearchInput.value = query;
          if (this.btnClearMusicSearch) this.btnClearMusicSearch.style.display = 'block';
        }
        this.searchMusic(query);
      });
    });

    // 10. Auto-load initial default playlist immediately
    const initialCategory = this.presetPlaylistSelect?.value || 'Latest Bollywood Hits';
    this.loadCategoryPlaylist(initialCategory);
  }

  async fetchTracksFromQuery(query) {
    if (!query || !query.trim()) return null;
    const trimmed = query.trim();

    // Abort previous in-flight request if searching rapidly
    if (this.currentSearchAbortCtrl) {
      try { this.currentSearchAbortCtrl.abort(); } catch (_) {}
    }
    this.currentSearchAbortCtrl = new AbortController();
    const parentSignal = this.currentSearchAbortCtrl.signal;

    for (const apiUrl of SAAVN_API_URLS) {
      if (parentSignal.aborted) break;
      try {
        const fullUrl = `${apiUrl}${encodeURIComponent(trimmed)}`;
        const fetchCtrl = new AbortController();
        const timeout = setTimeout(() => fetchCtrl.abort(), 4800);

        const onAbort = () => fetchCtrl.abort();
        parentSignal.addEventListener('abort', onAbort, { once: true });

        const response = await fetch(fullUrl, {
          signal: fetchCtrl.signal,
          headers: { 'Accept': 'application/json' }
        });
        clearTimeout(timeout);
        parentSignal.removeEventListener('abort', onAbort);

        if (!response.ok) continue;
        const json = await response.json();
        if (json) {
          const tracks = this.extractTracks(json);
          if (Array.isArray(tracks) && tracks.length > 0) {
            return json;
          }
        }
      } catch (e) {
        if (parentSignal.aborted) return null;
        console.warn('[MusicSearchManager] Provider failed:', apiUrl, e?.message);
      }
    }
    return null;
  }

  extractTracks(data) {
    if (!data) return [];
    // 1. Check normalized our-backend format: { ok: true, results: [...] }
    if (data.results && Array.isArray(data.results)) return data.results;
    if (data.data && Array.isArray(data.data.results)) return data.data.results;
    if (data.data && Array.isArray(data.data)) return data.data;
    if (Array.isArray(data)) return data;
    return [];
  }

  cleanAudioUrl(track) {
    if (!track) return '';
    let audioUrl = '';

    if (track.url && typeof track.url === 'string') {
      audioUrl = track.url;
    } else if (Array.isArray(track.downloadUrl) && track.downloadUrl.length > 0) {
      const last = track.downloadUrl[track.downloadUrl.length - 1];
      audioUrl = typeof last === 'string' ? last : (last.url || last.link || '');
    } else if (typeof track.downloadUrl === 'string') {
      audioUrl = track.downloadUrl;
    } else if (track.media_url) {
      audioUrl = track.media_url;
    } else if (track.audio_url) {
      audioUrl = track.audio_url;
    } else if (track.media_preview_url) {
      audioUrl = track.media_preview_url;
    } else if (track.previewUrl) {
      audioUrl = track.previewUrl;
    }

    if (audioUrl) {
      audioUrl = audioUrl
        .replace(/^http:\/\//i, 'https://')
        .replace('preview.saavncdn.com', 'aac.saavncdn.com')
        .replace('_96_p', '_320')
        .replace('_160_p', '_320')
        .replace('_96.mp4', '_320.mp4');
    }
    return audioUrl;
  }

  // Hydrates the queue with tracks from a curated category
  async loadCategoryPlaylist(categoryQuery) {
    if (this.playlistContainer) {
      this.playlistContainer.innerHTML = '<div class="search-loading-spinner"><span>⏳ Loading playlist tracks...</span></div>';
    }

    const data = await this.fetchTracksFromQuery(categoryQuery);
    const rawTracks = this.extractTracks(data);

    this.playlist = [];
    if (Array.isArray(rawTracks) && rawTracks.length > 0) {
      rawTracks.forEach((t) => {
        const audioUrl = this.cleanAudioUrl(t);
        if (!audioUrl) return;

        let artist = t.artist || t.primaryArtists || t.primary_artists || t.singers || '';
        if (!artist && t.artists && Array.isArray(t.artists.primary)) {
          artist = t.artists.primary.map((a) => a.name).join(', ');
        }
        if (!artist && t.artistName) {
          artist = t.artistName;
        }

        let image = t.image || t.artworkUrl100 || t.artworkUrl60 || '';
        if (image) image = image.replace('50x50', '500x500').replace('150x150', '500x500');

        this.playlist.push({
          id: t.id || Math.random().toString(36).slice(2, 8),
          title: t.title || t.song || t.name || t.trackName || 'Bollywood Track',
          artist: artist || 'Bollywood Artist',
          album: t.album || '',
          url: audioUrl,
          image: image,
          duration: parseInt(t.duration || Math.round((t.trackTimeMillis || 0) / 1000) || 0, 10)
        });
      });
    }

    // Safety fallback if completely offline or empty
    if (this.playlist.length === 0) {
      this.playlist = [...DEFAULT_FALLBACK_TRACKS];
    }

    this.currentTrackIndex = -1;
    this.renderPlaylist();
  }

  renderPlaylist() {
    if (!this.playlistContainer) return;
    this.playlistContainer.innerHTML = '';

    if (this.lblQueueCount) {
      this.lblQueueCount.textContent = `${this.playlist.length} Songs`;
    }

    if (this.playlist.length === 0) {
      this.playlistContainer.innerHTML = '<div style="font-size: 0.75rem; color: var(--text-dim, #8e82a6); text-align: center; padding: 12px 0;">Queue empty. Pick a category above or search songs!</div>';
      return;
    }

    this.playlist.forEach((track, idx) => {
      const item = document.createElement('div');
      item.className = 'search-result-item';
      const isCurrent = idx === this.currentTrackIndex;
      if (isCurrent) {
        item.classList.add('queue-active-track');
      }

      const durText = track.duration ? formatDuration(track.duration) : '';
      const thumbHtml = track.image
        ? `<div class="music-thumb-wrap"><img src="${escapeHtml(track.image)}" class="music-thumb-img" alt="Artwork" onerror="this.parentElement.innerHTML='🎵'"></div>`
        : `<div class="music-thumb-wrap">🎵</div>`;

      item.innerHTML = `
        <span style="font-size:11px; font-weight:800; min-width:18px; color:${isCurrent ? 'var(--accent-cyan, #00f0ff)' : 'var(--accent-purple, #b34bff)'}; text-align:center;">${idx + 1}.</span>
        ${thumbHtml}
        <div class="music-item-info">
          <div class="music-item-title">${escapeHtml(track.title)}</div>
          <div class="music-item-artist">
            <span>${escapeHtml(track.artist)}</span>
            ${durText ? `<span class="music-duration-badge">(${durText})</span>` : ''}
            ${isCurrent ? '<b style="color:var(--accent-cyan,#00f0ff); font-size:10px; margin-left:4px;">▶ PLAYING</b>' : ''}
          </div>
        </div>
        <div class="music-item-actions">
          <button data-idx="${idx}" class="btn-play-item" title="Play track" style="background:none; border:none; color:var(--accent-cyan, #00f0ff); cursor:pointer; font-size:13px; font-weight:bold; padding:4px 6px;">▶</button>
          <button data-idx="${idx}" class="btn-del-item" title="Remove track" style="background:none; border:none; color:var(--accent-red, #ff3b30); cursor:pointer; font-size:13px; font-weight:bold; padding:4px 6px;">✕</button>
        </div>
      `;

      item.querySelector('.music-item-info').addEventListener('click', () => {
        this.playTrackAtIndex(idx);
      });

      item.querySelector('.btn-play-item').addEventListener('click', (e) => {
        e.stopPropagation();
        this.playTrackAtIndex(idx);
      });

      item.querySelector('.btn-del-item').addEventListener('click', (e) => {
        e.stopPropagation();
        const wasCurrent = (idx === this.currentTrackIndex);
        this.playlist.splice(idx, 1);
        if (this.currentTrackIndex > idx) {
          this.currentTrackIndex--;
        } else if (wasCurrent) {
          this.currentTrackIndex = -1;
        }
        this.renderPlaylist();
      });

      this.playlistContainer.appendChild(item);
    });
  }

  // Adds a song chosen from Search results directly into the Up-Next playlist
  addToUpcomingQueue(trackObj) {
    this.playlist.push(trackObj);
    this.renderPlaylist();

    if (this.lyricsManager?.lblLyricsStatus) {
      this.lyricsManager.lblLyricsStatus.textContent = `➕ Added "${trackObj.title}" to Up-Next Queue!`;
      this.lyricsManager.lblLyricsStatus.style.color = 'var(--accent-purple, #b34bff)';
    }
  }

  playNextSong() {
    if (this.playlist.length === 0) return;
    let nextIndex = this.currentTrackIndex + 1;
    if (nextIndex >= this.playlist.length) {
      nextIndex = 0; // Loop back to start of playlist
    }
    this.playTrackAtIndex(nextIndex);
  }

  async playTrackAtIndex(index) {
    if (index < 0 || index >= this.playlist.length) return;
    this.currentTrackIndex = index;
    const track = this.playlist[index];
    this.renderPlaylist();
    await this.startPlayback(track);
  }

  async startPlayback(track) {
    try {
      await this.audioEngine.boot();
    } catch (_) {}

    this.filePlayer.crossOrigin = 'anonymous';
    this.filePlayer.src = track.url;
    if (this.playerWrapper) this.playerWrapper.style.display = 'block';

    try {
      this.audioEngine.connectMediaElement(this.filePlayer);
    } catch (_) {}

    this.filePlayer.play().catch(() => console.log('Autoplay permissions needed'));

    this.btnOpenMusicSearch?.classList.add('active-file');
    if (this.btnStopMedia) this.btnStopMedia.style.display = 'flex';
    this.ledIn?.classList.add('active-blue');

    // Update stage now playing card
    const npTitle = document.getElementById('nowPlayingTitle');
    const npArtist = document.getElementById('nowPlayingArtist');
    if (npTitle) npTitle.textContent = track.title || 'Unknown Title';
    if (npArtist) npArtist.textContent = track.artist || 'Karaoke Backing Track';

    // Update stage artwork if available
    const artwork = document.querySelector('.artwork');
    if (artwork) {
      if (track.image) {
        artwork.innerHTML = `<img src="${escapeHtml(track.image)}" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;" alt="Art" onerror="this.parentElement.innerHTML='♫'">`;
      } else {
        artwork.innerHTML = '♫';
      }
    }

    // Media Session integration
    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: track.title || 'Karaoke Song',
          artist: track.artist || 'Nirmal Karaoke',
          album: track.album || 'Live Studio',
          artwork: track.image ? [{ src: track.image, sizes: '500x500', type: 'image/jpeg' }] : []
        });
      } catch (_) {}
    }

    // Auto-fetch synchronized lyrics
    this.lyricsManager.autoFetchLyricsFromData(track.title, track.artist, parseInt(track.duration || 0, 10));
  }

  // Search Results Rendering
  renderSearchResults(tracks) {
    if (!this.musicSearchResults) return;
    this.musicSearchResults.innerHTML = '';

    if (!tracks || tracks.length === 0) {
      this.musicSearchResults.innerHTML = '<div style="color:var(--text-dim, #8e82a6); font-size: 0.78rem; text-align: center; padding: 12px 0;">No matching songs found. Try a different title or artist name.</div>';
      return;
    }

    let renderedCount = 0;
    tracks.forEach((t) => {
      const audioUrl = this.cleanAudioUrl(t);
      if (!audioUrl) return;

      let artist = t.artist || t.primaryArtists || t.primary_artists || t.singers || '';
      if (!artist && t.artists && Array.isArray(t.artists.primary)) {
        artist = t.artists.primary.map((a) => a.name).join(', ');
      }
      if (!artist && t.artistName) {
        artist = t.artistName;
      }

      let image = t.image || t.artworkUrl100 || t.artworkUrl60 || '';
      if (image) image = image.replace('50x50', '500x500').replace('150x150', '500x500');

      const trackObj = {
        id: t.id || Math.random().toString(36).slice(2, 8),
        title: t.title || t.song || t.name || t.trackName || 'Bollywood Track',
        artist: artist || 'Artist',
        album: t.album || '',
        url: audioUrl,
        image: image,
        duration: parseInt(t.duration || Math.round((t.trackTimeMillis || 0) / 1000) || 0, 10)
      };

      const div = document.createElement('div');
      div.className = 'search-result-item';

      const durText = trackObj.duration ? formatDuration(trackObj.duration) : '';
      const thumbHtml = trackObj.image
        ? `<div class="music-thumb-wrap"><img src="${escapeHtml(trackObj.image)}" class="music-thumb-img" alt="Artwork" onerror="this.parentElement.innerHTML='🎵'"></div>`
        : `<div class="music-thumb-wrap">🎵</div>`;

      div.innerHTML = `
        ${thumbHtml}
        <div class="music-item-info">
          <div class="music-item-title">${escapeHtml(trackObj.title)}</div>
          <div class="music-item-artist">
            <span>${escapeHtml(trackObj.artist)}</span>
            ${durText ? `<span class="music-duration-badge">(${durText})</span>` : ''}
          </div>
        </div>
        <div class="music-item-actions">
          <button class="btn-play-now" title="Play right now">▶ Play</button>
          <button class="btn-add-queue" title="Add to Up-Next queue">+ Queue</button>
        </div>
      `;

      // Play Now: Inserts at front and plays immediately
      div.querySelector('.btn-play-now').addEventListener('click', (e) => {
        e.stopPropagation();
        this.playlist.splice(this.currentTrackIndex + 1, 0, trackObj);
        this.playTrackAtIndex(this.currentTrackIndex + 1);
        if (this.musicSearchBox) this.musicSearchBox.style.display = 'none';
      });

      div.querySelector('.music-item-info').addEventListener('click', () => {
        this.playlist.splice(this.currentTrackIndex + 1, 0, trackObj);
        this.playTrackAtIndex(this.currentTrackIndex + 1);
        if (this.musicSearchBox) this.musicSearchBox.style.display = 'none';
      });

      // Add to upcoming queue with animated visual feedback
      const btnQueue = div.querySelector('.btn-add-queue');
      btnQueue.addEventListener('click', (e) => {
        e.stopPropagation();
        this.addToUpcomingQueue(trackObj);
        btnQueue.textContent = '✓ Added';
        btnQueue.style.background = 'var(--accent-green, #00e676)';
        btnQueue.style.borderColor = 'var(--accent-green, #00e676)';
        btnQueue.style.color = '#000';
        setTimeout(() => {
          btnQueue.textContent = '+ Queue';
          btnQueue.style.background = '';
          btnQueue.style.borderColor = '';
          btnQueue.style.color = '';
        }, 1400);
      });

      this.musicSearchResults.appendChild(div);
      renderedCount++;
    });

    if (renderedCount === 0) {
      this.musicSearchResults.innerHTML = '<div style="color:var(--text-dim, #8e82a6); font-size: 0.78rem; text-align: center; padding: 12px 0;">No playable tracks found for this query.</div>';
    }
  }

  async searchMusic(queryOverride) {
    const q = (typeof queryOverride === 'string' ? queryOverride : this.musicSearchInput?.value || '').trim();
    if (!q) {
      this.renderTrending();
      return;
    }

    if (this.musicListTitle) this.musicListTitle.textContent = `RESULTS FOR: "${q.toUpperCase()}"`;
    if (this.musicSearchResults) {
      this.musicSearchResults.innerHTML = `<div class="search-loading-spinner"><span>🔍 Searching "${escapeHtml(q)}"...</span></div>`;
    }

    const data = await this.fetchTracksFromQuery(q);
    const tracks = this.extractTracks(data);
    this.renderSearchResults(tracks);
  }

  toggleSearchBox(forceOpen) {
    if (!this.musicSearchBox) return;
    const isOpening = forceOpen !== undefined ? !!forceOpen : (this.musicSearchBox.style.display === 'none');
    this.musicSearchBox.style.display = isOpening ? 'block' : 'none';

    if (isOpening) {
      if (this.musicSearchInput) {
        setTimeout(() => {
          this.musicSearchInput.focus();
          this.musicSearchBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }, 50);
      }
      if (!this.musicSearchResults || !this.musicSearchResults.hasChildNodes() || this.musicSearchResults.children.length === 0) {
        this.renderTrending();
      }
    }
  }

  async renderTrending() {
    if (this.musicListTitle) this.musicListTitle.textContent = '🔥 POPULAR KARAOKE TRACKS';
    if (this.musicSearchResults) {
      this.musicSearchResults.innerHTML = '<div class="search-loading-spinner"><span>🔥 Loading popular karaoke hits...</span></div>';
    }

    try {
      const topQuery = TRENDING_SEARCH_TERMS[0] || 'Latest Bollywood Hits';
      const data = await this.fetchTracksFromQuery(topQuery);
      const tracks = this.extractTracks(data);

      if (tracks && tracks.length > 0) {
        this.renderSearchResults(tracks);
      } else {
        this.renderSearchResults(DEFAULT_FALLBACK_TRACKS);
      }
    } catch (_) {
      this.renderSearchResults(DEFAULT_FALLBACK_TRACKS);
    }
  }
}