const fs = require('fs');
const content = fs.readFileSync('users.html', 'utf8');
const scriptMatches = content.match(/<script type="module">([\s\S]*?)<\/script>/i);
if (scriptMatches) {
  fs.writeFileSync('scratch/test_users_module.mjs', scriptMatches[1]);
  console.log('Successfully wrote scratch/test_users_module.mjs');
}
