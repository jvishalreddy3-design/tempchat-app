const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const webDir = path.join(root, 'www');
const androidAssets = path.join(root, 'android', '.tempchat-assets');
const publicDir = path.join(androidAssets, 'public');
const generatedAssets = path.join(root, 'android', 'app', 'src', 'main', 'assets');

function copyTree(sourceDir, destinationDir) {
  fs.mkdirSync(destinationDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const source = path.join(sourceDir, entry.name);
    const destination = path.join(destinationDir, entry.name);
    if (entry.isDirectory()) {
      copyTree(source, destination);
      continue;
    }
    const sourceBuffer = fs.readFileSync(source);
    const sourceHash = crypto.createHash('sha256').update(sourceBuffer).digest('hex');
    const destinationHash = fs.existsSync(destination)
      ? crypto.createHash('sha256').update(fs.readFileSync(destination)).digest('hex')
      : null;
    if (sourceHash !== destinationHash) fs.writeFileSync(destination, sourceBuffer);
  }
}

if (!fs.existsSync(webDir) || !fs.existsSync(path.join(webDir, 'index.html'))) {
  throw new Error('Run the frontend build before materializing Android assets.');
}
if (!fs.existsSync(path.join(generatedAssets, 'capacitor.config.json')) || !fs.existsSync(path.join(generatedAssets, 'capacitor.plugins.json'))) {
  throw new Error('Run Capacitor sync before materializing Android assets.');
}

fs.mkdirSync(androidAssets, { recursive: true });
copyTree(webDir, publicDir);
for (const file of ['capacitor.config.json', 'capacitor.plugins.json']) {
  const source = path.join(generatedAssets, file);
  const destination = path.join(androidAssets, file);
  const sourceBuffer = fs.readFileSync(source);
  const sourceHash = crypto.createHash('sha256').update(sourceBuffer).digest('hex');
  const destinationHash = fs.existsSync(destination)
    ? crypto.createHash('sha256').update(fs.readFileSync(destination)).digest('hex')
    : null;
  if (sourceHash !== destinationHash) fs.writeFileSync(destination, sourceBuffer);
}

const cordovaPublic = path.join(generatedAssets, 'public');
for (const file of ['cordova.js', 'cordova_plugins.js']) {
  const source = path.join(cordovaPublic, file);
  if (!fs.existsSync(source)) continue;
  const destination = path.join(publicDir, file);
  const sourceBuffer = fs.readFileSync(source);
  if (!fs.existsSync(destination) || !fs.readFileSync(destination).equals(sourceBuffer)) {
    fs.writeFileSync(destination, sourceBuffer);
  }
}

console.log(`Materialized current www and Capacitor metadata in ${path.relative(root, androidAssets)}.`);
