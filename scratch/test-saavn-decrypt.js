const CryptoJS = require('crypto-js');

function decryptMediaUrl(encryptedUrl) {
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

function decodeEntities(str) {
  return String(str || '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

async function searchJioSaavn(query) {
  const url = 'https://www.jiosaavn.com/api.php?__call=search.getResults&_format=json&_marker=0&api_version=4&ctx=web6dot0&n=25&p=1&q=' + encodeURIComponent(query);
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*'
    }
  });
  const data = await res.json();
  const rawList = data.results || [];
  const tracks = rawList.map(t => {
    const more = t.more_info || {};
    const enc = more.encrypted_media_url;
    const audioUrl = decryptMediaUrl(enc);
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
      title: decodeEntities(t.title || t.song || ''),
      artist: decodeEntities(artist || 'Artist'),
      album: decodeEntities(more.album || t.album || ''),
      url: audioUrl,
      image: image,
      duration: parseInt(more.duration || t.duration || 0, 10),
      has_lyrics: more.has_lyrics === 'true'
    };
  }).filter(t => !!t.url);
  return tracks;
}

searchJioSaavn('Kesariya').then(tracks => {
  console.log('Got tracks:', tracks.length);
  if (tracks[0]) console.log('Track 0:', JSON.stringify(tracks[0], null, 2));
}).catch(console.error);
