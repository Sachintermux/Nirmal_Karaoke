import fs from 'fs';
import path from 'path';

function walk(dir) {
  const files = [];
  for (const item of fs.readdirSync(dir)) {
    if (item === 'node_modules' || item === '.git' || item === 'scratch') continue;
    const full = path.join(dir, item);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      files.push(...walk(full));
    } else if (/\.(js|mjs|html)$/.test(item)) {
      files.push(full);
    }
  }
  return files;
}

const allFiles = walk('.');
const catches = [];

for (const file of allFiles) {
  const content = fs.readFileSync(file, 'utf8');
  // Find catch blocks that are empty: catch (_) {}, catch (e) {}
  const regex = /catch\s*\([^)]*\)\s*\{\s*\}/g;
  let m;
  while ((m = regex.exec(content)) !== null) {
    catches.push({ file, pos: m.index, match: m[0] });
  }
}

console.log(`Total empty catch blocks: ${catches.length}`);
const fileCount = {};
catches.forEach(c => { fileCount[c.file] = (fileCount[c.file] || 0) + 1; });
console.log(fileCount);
