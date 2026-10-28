const fs = require('node:fs');
const vm = require('node:vm');

for (const file of ['frontend/index.html', 'www/index.html']) {
  const html = fs.readFileSync(file, 'utf8');
  const scripts = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  let count = 0;
  while ((match = scripts.exec(html))) {
    if (!match[1].trim()) continue;
    new vm.Script(match[1], { filename: `${file}#inline-${++count}` });
  }
  console.log(`${file}: parsed ${count} inline scripts`);
}

const nativeHtml = fs.readFileSync('www/index.html', 'utf8');
for (const required of [
  'TEMPCHAT ANDROID BOOTSTRAP',
  'https://tempchat-app-backend.onrender.com',
  'native-plugins.js',
  'room-empty-notice',
  'message:delivered',
  '/^\\d{6}$/'
]) {
  if (!nativeHtml.includes(required)) throw new Error(`Android bundle is missing expected frontend marker: ${required}`);
}
console.log('Android bundle includes the configured production endpoint and current TempChat UI/reliability changes.');
