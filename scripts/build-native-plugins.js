'use strict';

const path = require('node:path');

const root = path.resolve(__dirname, '..');
(async () => {
  const [{ rollup }, { nodeResolve }, commonjsModule] = await Promise.all([
    import('rollup'), import('@rollup/plugin-node-resolve'), import('@rollup/plugin-commonjs')
  ]);
  const bundle = await rollup({
    input: path.join(root, 'scripts', 'native-plugin-entry.js'),
    plugins: [nodeResolve({ browser: true }), commonjsModule.default()],
    onwarn(warning, warn) {
      if (warning.code === 'CIRCULAR_DEPENDENCY') return;
      warn(warning);
    }
  });
  await bundle.write({ file: path.join(root, 'www', 'native-plugins.js'), format: 'iife', name: 'TempChatPlugins', inlineDynamicImports: true });
  await bundle.close();
  console.log('Bundled Capacitor app, network, status-bar, and secure-storage plugins.');
})().catch((error) => {
  console.error(`Capacitor plugin bundle failed: ${error.message}`);
  process.exitCode = 1;
});
