import CryptoJS from 'crypto-js';

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
  const url = new URL(req.url, 'http://localhost');
  const query = (url.searchParams.get('query') || url.searchParams.get('q') || '').trim();
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit'), 10) || 25, 1), 50);

  if (!query) {
    return new Response(JSON.stringify({ ok: true, results: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

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

    if (!res.ok) throw new Error(`JioSaavn HTTP ${res.status}`);
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

    return new Response(JSON.stringify({ ok: true, results: tracks }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message, results: [] }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
}

// Quick run
const testReq = new Request('http://localhost/api/music/search?query=Pasoori');
handler(testReq).then(async res => {
  const json = await res.json();
  console.log('Test search handler status:', res.status, 'tracks found:', json.results?.length);
  if (json.results?.[0]) {
    console.log('Sample track:', json.results[0].title, '-', json.results[0].artist);
    console.log('Audio URL:', json.results[0].url);
  }
});
