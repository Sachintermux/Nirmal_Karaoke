const https = require('https');

https.get('https://developers.google.com/youtube/v3/live/getting-started', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    const article = data.match(/<article[\s\S]*?<\/article>/i);
    if (article) {
      const clean = article[0]
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<h1[\s\S]*?>/gi, '\n\n# ')
        .replace(/<h2[\s\S]*?>/gi, '\n\n## ')
        .replace(/<h3[\s\S]*?>/gi, '\n\n### ')
        .replace(/<li[\s\S]*?>/gi, '\n* ')
        .replace(/<p[\s\S]*?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"');
      console.log(clean.slice(10000, 18000));
    } else {
      console.log('No article tag found, length:', data.length);
    }
  });
}).on('error', console.error);
