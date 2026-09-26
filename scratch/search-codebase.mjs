import fs from 'fs';
import path from 'path';

const patterns = [/TODO/i, /FIXME/i, /HACK/i, /mock/i, /fake/i, /dummy/i, /console\.error/i, /console\.warn/i];

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
const findings = [];

for (const file of allFiles) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, idx) => {
    for (const pat of patterns) {
      if (pat.test(line)) {
        findings.push({ file, line: idx + 1, text: line.trim(), match: pat.toString() });
        break;
      }
    }
  });
}

console.log(`Total findings: ${findings.length}`);
console.log(findings.filter(f => /TODO|FIXME|HACK|mock|fake|dummy/i.test(f.text)));
