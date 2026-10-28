import { build } from 'vite';
import { mkdir, readFile, rm, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';

await rm('dist', { recursive: true, force: true });
await build({ configFile: false, build: { outDir: 'dist', emptyOutDir: false, target: 'es2022',
  lib: { entry: resolve('src/content/index.ts'), name: 'ChatOrganizer', formats: ['iife'], fileName: () => 'content.js' },
  rollupOptions: { output: { inlineDynamicImports: true } } } });
await build({ configFile: false, build: { outDir: 'dist', emptyOutDir: false, target: 'es2022',
  rollupOptions: { input: { background: resolve('src/background/index.ts'), settings: resolve('settings.html') },
    output: { entryFileNames: '[name].js', chunkFileNames: 'assets/[name]-[hash].js', assetFileNames: 'assets/[name]-[hash][extname]' } } } });
await copyFile('manifest.json', 'dist/manifest.json');
await mkdir('dist/icons', { recursive: true });

for (const size of [16, 32, 48, 128]) {
  await copyFile(`assets/icons/icon${size}.png`, `dist/icons/icon${size}.png`);
}
const manifest = JSON.parse(await readFile('dist/manifest.json', 'utf8'));
console.log(`Built ${manifest.name} ${manifest.version} → dist/`);
