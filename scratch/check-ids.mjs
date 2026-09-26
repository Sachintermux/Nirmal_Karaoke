import fs from 'fs';
import path from 'path';

const html = fs.readFileSync('index.html', 'utf8');
const htmlIds = new Set();
const idRegex = /id=["']([^"']+)["']/g;
let m;
while ((m = idRegex.exec(html)) !== null) {
  htmlIds.add(m[1]);
}

const jsFiles = fs.readdirSync('js').filter(f => f.endsWith('.js'));
const missing = [];
for (const file of jsFiles) {
  const content = fs.readFileSync(path.join('js', file), 'utf8');
  const getElemRegex = /getElementById\(["']([^"']+)["']\)/g;
  while ((m = getElemRegex.exec(content)) !== null) {
    const id = m[1];
    if (!htmlIds.has(id)) {
      missing.push({ file, id });
    }
  }
}
console.log('Missing IDs from index.html:');
console.log(missing);
