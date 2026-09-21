const fs = require('fs');
const text = fs.readFileSync('C:/Users/sachi/.gemini/antigravity-cli/brain/2ae038d1-0fe2-4bfa-a8b5-2dc46a78ea26/.system_generated/steps/759/content.md', 'utf8');

const regexes = [
  /"status":\s*"([^"]+)"/,
  /"reason":\s*"([^"]+)"/,
  /"playabilityStatus":\s*({[^}]+})/,
  /"title":\s*"([^"]+)"/,
  /"isLiveStream":\s*(true|false)/,
  /"liveBroadcastDetails":\s*({[^}]+})/
];

for (const r of regexes) {
  const m = text.match(r);
  if (m) console.log(m[0]);
}
