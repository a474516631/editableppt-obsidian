// Builds sample decks from samples/*.md into output/, without Obsidian.
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { deflateSync } from 'node:zlib';
import esbuild from 'esbuild';

const root = new URL('..', import.meta.url).pathname;
const out = join(root, 'output');
await mkdir(out, { recursive: true });
await esbuild.build({
  entryPoints: [join(root, 'scripts/sample-entry.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: join(out, 'sample-lib.mjs'),
  logLevel: 'warning',
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
const { buildDeck, planDeck, readImageSize } = await import(join(out, 'sample-lib.mjs'));

function crc32(bytes) {
  let crc = ~0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}
/** A flat-colour PNG with a darker frame, so image placement is visible. */
function png(width, height, [r, g, b]) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x += 1) {
      const edge = x < 6 || y < 6 || x >= width - 6 || y >= height - 6;
      const at = row + 1 + x * 3;
      raw[at] = edge ? r * 0.6 : r;
      raw[at + 1] = edge ? g * 0.6 : g;
      raw[at + 2] = edge ? b * 0.6 : b;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const images = {
  'chart-growth.png': png(1200, 500, [147, 197, 253]),
  'screen-a.png': png(800, 600, [134, 239, 172]),
  'screen-b.png': png(600, 900, [253, 186, 116]),
};
const loadImage = async (src) => {
  const bytes = images[src];
  if (!bytes) return null;
  const size = readImageSize(bytes);
  return size && { ...size, data: `data:${size.mime};base64,${bytes.toString('base64')}` };
};

const variants = [
  { suffix: '', theme: 'light', ratio: '16:9' },
  { suffix: '-dark-4x3', theme: 'dark', ratio: '4:3' },
];
const only = process.argv[2];
for (const file of (await readdir(join(root, 'samples'))).filter((name) => name.endsWith('.md'))) {
  if (only && !file.includes(only)) continue;
  const markdown = await readFile(join(root, 'samples', file), 'utf8');
  for (const variant of variants) {
    const options = {
      fallbackTitle: basename(file, '.md'),
      split: 'auto',
      titleSlide: true,
      ratio: variant.ratio,
      theme: variant.theme,
      font: 'Arial',
      monoFont: 'Courier New',
      slideNumbers: true,
      loadImage,
    };
    const deck = await buildDeck(markdown, options);
    const name = basename(file, '.md') + variant.suffix;
    await writeFile(join(out, name + '.pptx'), Buffer.from(deck.data));
    const plan = await planDeck(markdown, options);
    await writeFile(join(out, name + '.plan.json'), JSON.stringify(plan.pages, null, 1));
    console.log(`${name}.pptx  ${deck.slides} slides  ${Math.round(deck.data.byteLength / 1024)} KB  missing: ${deck.missingImages.join(', ') || 'none'}`);
  }
}
