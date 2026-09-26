import { SAAVN_API_URLS } from './config.js';

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

export class MusicSearchManager {
  constructor(audioEngine, lyricsManager) {
    this.audioEngine = audioEngine;
    this.lyricsManager = lyricsManager;

    // Up-Next continuous playback playlist
    this.playlist = [];
    this.currentTrackIndex = -1;

    // UI elements
    this.musicSearchBox = document.getElementById('musicSearchBox');
    this.musicSearchInput = document.getElementById('musicSearchInput');
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

    // Auto-load initial default playlist immediately
    const initialCategory = this.presetPlaylistSelect?.value || 'Trending Top 50 Hindi';
    this.loadCategoryPlaylist(initialCategory);
  }

  async fetchTracksFromQuery(query) {
    for (const apiUrl of SAAVN_API_URLS) {
      try {
        const response = await fetch(`${apiUrl}${encodeURIComponent(query)}`);
        if (!response.ok) continue;
        const json = await response.json();
        if (json) return json;
      } catch (e) {
        console.warn('API provider error on:', apiUrl);
      }
    }
    return null;
  }

  extractTracks(data) {
    if (!data) return [];
    if (data.data && Array.isArray(data.data.results)) return data.data.results;
    if (data.data && Array.isArray(data.data)) return data.data;
    if (data.results && Array.isArray(data.results)) return data.results;
    if (Array.isArray(data)) return data;
    return [];
  }

  cleanAudioUrl(track) {
    let audioUrl = '';
    if (Array.isArray(track.downloadUrl) && track.downloadUrl.length > 0) {
      const last = track.downloadUrl[track.downloadUrl.length - 1];
      audioUrl = typeof last === 'string' ? last : (last.url || last.link || '');
    } else if (typeof track.downloadUrl === 'string') {
      audioUrl = track.downloadUrl;
    } else if (track.media_url) {
      audioUrl = track.media_url;
    } else if (track.audio_url) {
      audioUrl = track.audio_url;
    }

    if (audioUrl) {
      audioUrl = audioUrl
        .replace(/^http:\/\//i, 'https://')
        .replace('preview.saavncdn.com', 'aac.saavncdn.com')
        .replace('_96_p', '_320')
        .replace('_160_p', '_320');
    }
    return audioUrl;
  }

  // Hydrates the queue with tracks from a curated category
  async loadCategoryPlaylist(categoryQuery) {
    if (this.playlistContainer) {
      this.playlistContainer.innerHTML = '<div style="font-size: 0.7rem; color: var(--text-dim); text-align: center; padding: 6px 0;">Loading category tracks...</div>';
    }

    const data = await this.fetchTracksFromQuery(categoryQuery);
    const rawTracks = this.extractTracks(data);

    this.playlist = [];
    rawTracks.forEach((t) => {
      const audioUrl = this.cleanAudioUrl(t);
      if (!audioUrl) return;

      let artist = t.primaryArtists || t.primary_artists || t.artist || '';
      if (!artist && t.artists && Array.isArray(t.artists.primary)) {
        artist = t.artists.primary.map((a) => a.name).join(', ');
      }

      this.playlist.push({
        title: t.name || t.song || t.title,
        artist: artist || 'Bollywood Artist',
        url: audioUrl,
        duration: t.duration || 0
      });
    });

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
      this.playlistContainer.innerHTML = '<div style="font-size: 0.7rem; color: var(--text-dim); text-align: center; padding: 6px 0;">Queue empty. Pick a category above or search songs!</div>';
      return;
    }

    this.playlist.forEach((track, idx) => {
      const item = document.createElement('div');
      item.className = 'search-result-item';
      item.style.padding = '5px 8px';
      item.style.fontSize = '0.72rem';
      item.style.display = 'flex';
      item.style.justifyContent = 'space-between';
      item.style.alignItems = 'center';

      const isCurrent = idx === this.currentTrackIndex;
      if (isCurrent) {
        item.style.background = 'rgba(0, 229, 255, 0.15)';
        item.style.border = '1px solid var(--accent-blue)';
      }

      item.innerHTML = `
        <div style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; cursor:pointer;">
          <span style="color:${isCurrent ? 'var(--accent-blue)' : 'var(--accent-purple)'}; font-weight:bold;">${idx + 1}.</span>
          <strong>${escapeHtml(track.title)}</strong> <span style="color:var(--text-dim)">- ${escapeHtml(track.artist)}</span>
        </div>
        <div style="display:flex; gap:6px;">
          <button data-idx="${idx}" class="btn-play-item" style="background:none; border:none; color:var(--accent-blue); cursor:pointer; font-weight:bold;">▶</button>
          <button data-idx="${idx}" class="btn-del-item" style="background:none; border:none; color:var(--accent-red); cursor:pointer; font-weight:bold;">✕</button>
        </div>
      `;

      item.querySelector('div').addEventListener('click', () => {
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
    // Flash status message
    if (this.lyricsManager.lblLyricsStatus) {
      this.lyricsManager.lblLyricsStatus.textContent = `➕ Added "${trackObj.title}" to Up-Next Queue!`;
      this.lyricsManager.lblLyricsStatus.style.color = 'var(--accent-purple)';
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
    await this.audioEngine.boot();

    this.filePlayer.crossOrigin = 'anonymous';
    this.filePlayer.src = track.url;
    if (this.playerWrapper) this.playerWrapper.style.display = 'block';

    this.audioEngine.connectMediaElement(this.filePlayer);
    this.filePlayer.play().catch(() => console.log('Autoplay permissions needed'));

    this.btnOpenMusicSearch?.classList.add('active-file');
    if (this.btnStopMedia) this.btnStopMedia.style.display = 'flex';
    this.ledIn?.classList.add('active-blue');

    // Update stage now playing card
    const npTitle = document.getElementById('nowPlayingTitle');
    const npArtist = document.getElementById('nowPlayingArtist');
    if (npTitle) npTitle.textContent = track.title || 'Unknown Title';
    if (npArtist) npArtist.textContent = track.artist || 'Karaoke Backing Track';

    // Auto-fetch synchronized lyrics
    this.lyricsManager.autoFetchLyricsFromData(track.title, track.artist, parseInt(track.duration || 0));
  }

  // Search Results Rendering
  renderSearchResults(tracks) {
    if (!this.musicSearchResults) return;
    this.musicSearchResults.innerHTML = '';

    if (!tracks || tracks.length === 0) {
      this.musicSearchResults.innerHTML = '<span style="color:var(--text-dim); font-size: 0.8rem;">No matching songs found.</span>';
      return;
    }

    tracks.forEach((t) => {
      const audioUrl = this.cleanAudioUrl(t);
      if (!audioUrl) return;

      let artist = t.primaryArtists || t.primary_artists || t.artist || '';
      if (!artist && t.artists && Array.isArray(t.artists.primary)) {
        artist = t.artists.primary.map((a) => a.name).join(', ');
      }

      const trackObj = {
        title: t.name || t.song || t.title,
        artist: artist || 'Artist',
        url: audioUrl,
        duration: t.duration || 0
      };

      const div = document.createElement('div');
      div.className = 'search-result-item';
      div.style.display = 'flex';
      div.style.justifyContent = 'space-between';
      div.style.alignItems = 'center';

      div.innerHTML = `
        <div style="flex: 1; cursor: pointer; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; padding-right:8px;">
          🎵 <strong>${escapeHtml(trackObj.title)}</strong><br>
          <span style="color:var(--text-dim); font-size:0.7rem;">${escapeHtml(trackObj.artist)}</span>
        </div>
        <div style="display: flex; gap: 4px;">
          <button class="btn-play-now" style="background: none; border: 1px solid var(--accent-blue); color: var(--accent-blue); padding: 4px 8px; border-radius: 4px; font-size: 0.68rem; cursor: pointer;">▶ Play</button>
          <button class="btn-add-queue" style="background: none; border: 1px solid var(--accent-purple); color: var(--accent-purple); padding: 4px 8px; border-radius: 4px; font-size: 0.68rem; cursor: pointer;">+ Queue</button>
        </div>
      `;

      // Play Now: Inserts at front and plays immediately
      div.querySelector('.btn-play-now').addEventListener('click', (e) => {
        e.stopPropagation();
        this.playlist.splice(this.currentTrackIndex + 1, 0, trackObj);
        this.playTrackAtIndex(this.currentTrackIndex + 1);
        if (this.musicSearchBox) this.musicSearchBox.style.display = 'none';
      });

      div.querySelector('div').addEventListener('click', () => {
        this.playlist.splice(this.currentTrackIndex + 1, 0, trackObj);
        this.playTrackAtIndex(this.currentTrackIndex + 1);
        if (this.musicSearchBox) this.musicSearchBox.style.display = 'none';
      });

      // Add to upcoming queue
      div.querySelector('.btn-add-queue').addEventListener('click', (e) => {
        e.stopPropagation();
        this.addToUpcomingQueue(trackObj);
      });

      this.musicSearchResults.appendChild(div);
    });
  }

  async searchMusic() {
    const q = this.musicSearchInput?.value.trim();
    if (!q) return;

    if (this.musicListTitle) this.musicListTitle.textContent = `RESULTS FOR: "${q}"`;
    if (this.musicSearchResults) this.musicSearchResults.innerHTML = '<span style="color:var(--text-dim); font-size: 0.8rem;">Searching music...</span>';

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
        }, 60);
      }
      if (!this.musicSearchResults || !this.musicSearchResults.hasChildNodes() || this.musicSearchResults.children.length === 0) {
        this.renderTrending();
      }
    }
  }

  async renderTrending() {
    if (this.musicListTitle) this.musicListTitle.textContent = '🔥 TOP KARAOKE TRACKS';
    if (this.musicSearchResults) this.musicSearchResults.innerHTML = '<span style="color:var(--text-dim); font-size: 0.8rem;">Loading trending tracks...</span>';
    try {
      const data = await this.fetchTracksFromQuery('top hindi 50');
      const tracks = this.extractTracks(data);
      if (tracks && tracks.length > 0) {
        this.renderSearchResults(tracks);
      } else {
        if (this.musicSearchResults) {
          this.musicSearchResults.innerHTML = '<span style="color:var(--text-dim); font-size: 0.8rem;">Type a song or artist name above and press Enter to search millions of tracks.</span>';
        }
      }
    } catch (_) {
      if (this.musicSearchResults) {
        this.musicSearchResults.innerHTML = '<span style="color:var(--text-dim); font-size: 0.8rem;">Type a song or artist name above to search.</span>';
      }
    }
  }
}