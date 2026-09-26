const fs = require('fs');
const content = fs.readFileSync('audience.html', 'utf8');
const scriptMatches = content.match(/<script type="module">([\s\S]*?)<\/script>/i);
if (scriptMatches) {
  if (!fs.existsSync('scratch')) fs.mkdirSync('scratch', { recursive: true });
  fs.writeFileSync('scratch/test_audience_module.mjs', scriptMatches[1]);
  console.log('Successfully wrote scratch/test_audience_module.mjs');
}
