const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const sourceDir = path.join(root, 'frontend');
const outputDir = path.join(root, 'www');
const sourceIndex = path.join(sourceDir, 'index.html');
const outputIndex = path.join(outputDir, 'index.html');
const publicConfig = path.join(outputDir, 'app-config.js');
const nativePlugins = path.join(outputDir, 'native-plugins.js');

if (!fs.existsSync(sourceIndex)) throw new Error(`Missing frontend entry point: ${sourceIndex}`);
if (!fs.existsSync(publicConfig) || !fs.existsSync(nativePlugins)) {
  throw new Error('The existing www/app-config.js and www/native-plugins.js are required for the Android build.');
}

execFileSync(process.execPath, [path.join(__dirname, 'build-native-plugins.js')], { cwd: root, stdio: 'inherit' });

let html = fs.readFileSync(sourceIndex, 'utf8');
const tailwindTag = '  <script src="https://cdn.tailwindcss.com"></script>';
if (!html.includes(tailwindTag)) throw new Error('Could not find the frontend script insertion point.');

html = html.replace(tailwindTag, `  <!-- TEMPCHAT ANDROID BOOTSTRAP -->
  <script src="app-config.js"></script>
  <script>if (window.Capacitor?.isNativePlatform?.()) document.write('<script src="native-plugins.js"><\\/script>');</script>
${tailwindTag}`);

const socketStart = html.indexOf('  <script src="https://cdn.socket.io/4.7.5/socket.io.min.js"></script>');
const fallbackUrl = html.indexOf('socket.io-client@4.7.5/dist/socket.io.min.js', socketStart);
const fallbackStart = fallbackUrl >= 0 ? html.lastIndexOf('  <script>', fallbackUrl) : -1;
const socketBlockEnd = fallbackStart >= 0 ? html.indexOf('</script>', fallbackStart) + '</script>'.length : -1;
if (socketStart < 0 || fallbackStart < 0 || socketBlockEnd < fallbackStart) {
  throw new Error('Could not locate the Socket.IO CDN block for native-safe packaging.');
}

const nativeSafeSocketLoaders = `  <script>if (!window.Capacitor?.isNativePlatform?.()) document.write('<script src="https://cdn.socket.io/4.7.5/socket.io.min.js"><\\/script>');</script>
  <script>if (!window.Capacitor?.isNativePlatform?.() && typeof window.io !== 'function') document.write('<script src="https://cdnjs.cloudflare.com/ajax/libs/socket.io/4.7.5/socket.io.min.js"><\\/script>');</script>
  <script>if (!window.Capacitor?.isNativePlatform?.() && typeof window.io !== 'function') document.write('<script src="https://cdn.jsdelivr.net/npm/socket.io-client@4.7.5/dist/socket.io.min.js"><\\/script>');</script>`;
html = html.slice(0, socketStart) + nativeSafeSocketLoaders + html.slice(socketBlockEnd);

fs.mkdirSync(outputDir, { recursive: true });
const sourceAssets = path.join(sourceDir, 'assets');
if (fs.existsSync(sourceAssets)) {
  const copyAssets = (from, to) => {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const source = path.join(from, entry.name);
      const target = path.join(to, entry.name);
      if (entry.isDirectory()) copyAssets(source, target);
      else {
        const sourceHash = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');
        const targetHash = fs.existsSync(target) ? crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex') : null;
        if (sourceHash !== targetHash) fs.copyFileSync(source, target);
      }
    }
  };
  copyAssets(sourceAssets, path.join(outputDir, 'assets'));
}

fs.writeFileSync(outputIndex, html);
console.log(`Built Android web assets from ${path.relative(root, sourceIndex)} into ${path.relative(root, outputDir)}.`);
