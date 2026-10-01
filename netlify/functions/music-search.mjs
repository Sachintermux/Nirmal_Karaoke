import CryptoJS from 'crypto-js';

// In-memory cache for Netlify serverless instance lifecycle
const musicSearchCache = new Map();
const MUSIC_CACHE_TTL = 15 * 60 * 1000;

function decryptSaavnUrl(encryptedUrl) {
  if (!encryptedUrl) return '';
  try {
    const key = CryptoJS.enc.Utf8.parse('38346591');
    const decrypted = CryptoJS.DES.decrypt(
      { ciphertext: CryptoJS.enc.Base64.parse(encryptedUrl) },
      key,
      { mode: CryptoJS.mode.ECB, padding: CryptoJS.pad.Pkcs7 }
    );
    const url = decrypted.toString(CryptoJS.enc.Utf8);
    if (!url) return '';
    return url.replace('_96.mp4', '_320.mp4');
  } catch (e) {
    return '';
  }
}

function cleanHtmlEntities(str) {
  return String(str || '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

export default async function handler(req) {
  // CORS Preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'GET, OPTIONS'
      }
    });
  }

  const url = new URL(req.url, 'http://localhost');
  let query = (url.searchParams.get('query') || url.searchParams.get('q') || url.searchParams.get('category') || '').trim();
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit'), 10) || 25, 1), 50);

  if (!query && (url.pathname.includes('/trending') || url.pathname.endsWith('/trending'))) {
    query = 'Latest Bollywood Hits';
  }

  if (!query) {
    return new Response(JSON.stringify({ ok: true, results: [] }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }

  const cacheKey = `${query.toLowerCase()}_${limit}`;
  const cached = musicSearchCache.get(cacheKey);
  if (cached && (Date.now() - cached.time < MUSIC_CACHE_TTL)) {
    return new Response(JSON.stringify({ ok: true, results: cached.tracks }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'X-Cache': 'HIT'
      }
    });
  }

  // 1. Try User's Primary Vercel JioSaavn API first
  try {
    const vercelUrl = `https://jiosaavn-api-main-mu.vercel.app/song/?query=${encodeURIComponent(query)}`;
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 6000);
    const vRes = await fetch(vercelUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*'
      },
      signal: ctrl.signal
    });
    clearTimeout(timeout);

    if (vRes.ok) {
      const vData = await vRes.json();
      const rawList = Array.isArray(vData) ? vData : (vData?.results || []);
      if (rawList.length > 0) {
        const tracks = rawList.slice(0, limit).map(t => {
          let mediaUrl = t.media_url || t.url || '';
          if (mediaUrl.includes('preview.saavncdn.com')) {
            mediaUrl = mediaUrl.replace('preview.saavncdn.com', 'aac.saavncdn.com').replace('_96_p', '_320');
          } else if (mediaUrl.includes('_96.mp4')) {
            mediaUrl = mediaUrl.replace('_96.mp4', '_320.mp4');
          } else if (mediaUrl.includes('_160.mp4')) {
            mediaUrl = mediaUrl.replace('_160.mp4', '_320.mp4');
          }

          let img = (t.image || '').replace('50x50', '500x500').replace('150x150', '500x500');

          return {
            id: t.id || `saavn_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            title: cleanHtmlEntities(t.song || t.name || t.title || 'Unknown Title'),
            artist: cleanHtmlEntities(t.singers || t.primary_artists || t.artist || 'Artist'),
            album: cleanHtmlEntities(t.album || ''),
            url: mediaUrl,
            image: img,
            duration: parseInt(t.duration || 0, 10),
            has_lyrics: t.has_lyrics === 'true' || t.has_lyrics === true
          };
        }).filter(t => !!t.url);

        if (tracks.length > 0) {
          musicSearchCache.set(cacheKey, { tracks, time: Date.now() });
          return new Response(JSON.stringify({ ok: true, results: tracks }), {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            }
          });
        }
      }
    }
  } catch (vercelErr) {
    console.warn('[Netlify music-search] Primary Vercel endpoint notice:', vercelErr.message);
  }

  // 2. Direct JioSaavn scrape + DES-ECB decryption fallback
  try {
    const saavnUrl = `https://www.jiosaavn.com/api.php?__call=search.getResults&_format=json&_marker=0&api_version=4&ctx=web6dot0&n=${limit}&p=1&q=${encodeURIComponent(query)}`;
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(saavnUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*'
      },
      signal: ctrl.signal
    });
    clearTimeout(timeout);

    if (!res.ok) throw new Error(`JioSaavn HTTP status: ${res.status}`);
    const data = await res.json();
    const rawList = Array.isArray(data.results) ? data.results : [];
    const tracks = rawList.map(t => {
      const more = t.more_info || {};
      const enc = more.encrypted_media_url;
      const audioUrl = decryptSaavnUrl(enc);
      let artist = '';
      if (more.artistMap && more.artistMap.primary_artists && more.artistMap.primary_artists.length > 0) {
        artist = more.artistMap.primary_artists.map(a => a.name).join(', ');
      } else if (more.singers) {
        artist = more.singers;
      } else if (more.primary_artists) {
        artist = more.primary_artists;
      }
      let image = t.image || more.image || '';
      if (image) image = image.replace('50x50', '500x500').replace('150x150', '500x500');

      return {
        id: t.id,
        title: cleanHtmlEntities(t.title || t.song || ''),
        artist: cleanHtmlEntities(artist || 'Artist'),
        album: cleanHtmlEntities(more.album || t.album || ''),
        url: audioUrl,
        image: image,
        duration: parseInt(more.duration || t.duration || 0, 10),
        has_lyrics: more.has_lyrics === 'true'
      };
    }).filter(t => !!t.url);

    musicSearchCache.set(cacheKey, { tracks, time: Date.now() });

    return new Response(JSON.stringify({ ok: true, results: tracks }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message, results: [] }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
}
