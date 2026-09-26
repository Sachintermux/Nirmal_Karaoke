import fs from 'fs';

const html = fs.readFileSync('audience.html', 'utf8');
const htmlIds = new Set();
const idRegex = /id=["']([^"']+)["']/g;
let m;
while ((m = idRegex.exec(html)) !== null) {
  htmlIds.add(m[1]);
}

// Check script in audience.html
const getElemRegex = /getElementById\(["']([^"']+)["']\)/g;
const missing = [];
while ((m = getElemRegex.exec(html)) !== null) {
  const id = m[1];
  if (!htmlIds.has(id)) {
    missing.push(id);
  }
}
console.log('Missing IDs from audience.html:', [...new Set(missing)]);
