import { build } from 'vite';
import { mkdir, readFile, writeFile, rm, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { deflateSync } from 'node:zlib';

await rm('dist', { recursive: true, force: true });
await build({ configFile: false, build: { outDir: 'dist', emptyOutDir: false, target: 'es2022',
  lib: { entry: resolve('src/content/index.ts'), name: 'ChatOrganizer', formats: ['iife'], fileName: () => 'content.js' },
  rollupOptions: { output: { inlineDynamicImports: true } } } });
await build({ configFile: false, build: { outDir: 'dist', emptyOutDir: false, target: 'es2022',
  rollupOptions: { input: { background: resolve('src/background/index.ts'), settings: resolve('settings.html') },
    output: { entryFileNames: '[name].js', chunkFileNames: 'assets/[name]-[hash].js', assetFileNames: 'assets/[name]-[hash][extname]' } } } });
await copyFile('manifest.json', 'dist/manifest.json');
await mkdir('dist/icons', { recursive: true });

function crc32(b) { let c = 0xffffffff; for (const x of b) { c ^= x; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const t = Buffer.from(type), b = Buffer.alloc(12 + data.length); b.writeUInt32BE(data.length); t.copy(b, 4); data.copy(b, 8); b.writeUInt32BE(crc32(Buffer.concat([t, data])), b.length - 4); return b; }
function icon(size) {
  const pixels = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const px = x / size, py = y / size, offset = y * (size * 4 + 1) + 1 + x * 4;
    const r = .2, dx = Math.max(r - px, 0, px - (1 - r)), dy = Math.max(r - py, 0, py - (1 - r));
    const inside = dx * dx + dy * dy < r * r;
    const folder = px > .2 && px < .8 && py > .32 && py < .71;
    const tab = px > .2 && px < .46 && py > .24 && py < .36;
    const cutout = px > .25 && px < .75 && py > .39 && py < .66;
    const dot = (px - .5) ** 2 + (py - .52) ** 2 < .002;
    const white = (folder || tab) && !cutout || dot;
    pixels.set(white ? [255, 255, 255, inside ? 255 : 0] : [32, 32, 32, inside ? 255 : 0], offset);
  }
  const hdr = Buffer.alloc(13); hdr.writeUInt32BE(size); hdr.writeUInt32BE(size, 4); hdr[8] = 8; hdr[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', hdr), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
for (const size of [16, 32, 48, 128]) await writeFile(`dist/icons/icon${size}.png`, icon(size));
const manifest = JSON.parse(await readFile('dist/manifest.json', 'utf8'));
console.log(`Built ${manifest.name} ${manifest.version} → dist/`);
