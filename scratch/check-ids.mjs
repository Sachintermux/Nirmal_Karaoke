import fs from 'fs';

const html = fs.readFileSync('index.html', 'utf8');
const idRegex = /id=["']([^"']+)["']/g;
const htmlIds = new Set();
let match;
while ((match = idRegex.exec(html)) !== null) {
  htmlIds.add(match[1]);
}
console.log('Total IDs found in index.html:', htmlIds.size);

const jsFiles = fs.readdirSync('js').filter(f => f.endsWith('.js'));
let missingTotal = 0;

for (const f of jsFiles) {
  const code = fs.readFileSync('js/' + f, 'utf8');
  const getElemRegex = /document\.getElementById\(['"]([^'"]+)['"]\)/g;
  let m;
  const missingInFile = new Set();
  while ((m = getElemRegex.exec(code)) !== null) {
    const id = m[1];
    // Dynamic or generated IDs like user_*, toast_*, etc. should be ignored
    if (id.includes('${') || id.startsWith('toast') || id.startsWith('user_')) continue;
    if (!htmlIds.has(id)) {
      missingInFile.add(id);
    }
  }
  if (missingInFile.size > 0) {
    console.log('\n--- Missing in js/' + f + ' (' + missingInFile.size + ') ---');
    for (const id of missingInFile) {
      console.log('  ' + id);
      missingTotal++;
    }
  }
}
console.log('\nTotal missing IDs:', missingTotal);
