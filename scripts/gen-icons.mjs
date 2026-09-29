#!/usr/bin/env node
/**
 * gen-icons.mjs — one-off icon generator for the Beam PWA.
 *
 * Rasterizes `public/beam-logo.svg` (viewBox 0 0 64 64, blue→violet gradient
 * mark of two devices + a beam arc) into the PNG icons required by the Web
 * App Manifest, the apple-touch-icon link, and the small browser favicon.
 *
 * Outputs (all under public/):
 *   icons/icon-192.png           192×192  transparent bg  (purpose "any")
 *   icons/icon-512.png           512×512  transparent bg  (purpose "any")
 *   icons/icon-maskable-192.png  192×192  white bg, logo @ 60% (purpose "maskable")
 *   icons/icon-maskable-512.png  512×512  white bg, logo @ 60% (purpose "maskable")
 *   apple-touch-icon.png         180×180  white bg, logo @ 64%
 *   icon-32.png                   32×32  transparent bg  (favicon substitute)
 *
 * Run from project root:  bun scripts/gen-icons.mjs
 */
import sharp from 'sharp';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const ICONS_DIR = path.join(PUBLIC, 'icons');
const SOURCE_SVG = path.join(PUBLIC, 'beam-logo.svg');

/**
 * Rasterize an SVG string to a transparent PNG of an exact pixel size.
 * We supersample (2× density) then downscale with lanczos3 for crisp edges.
 */
async function renderTransparent(svgString, size, outPath) {
  const density = Math.max(72, Math.ceil((size / 64) * 72 * 2)); // 2× supersample
  await sharp(Buffer.from(svgString), { density })
    .resize(size, size, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png({ compressionLevel: 9 })
    .toFile(outPath);
  console.log(`  ✓ ${path.relative(ROOT, outPath)}  (${size}×${size}, transparent)`);
}

/**
 * Render the logo on a solid white background, centered and scaled to `scale`
 * of the canvas. Used for maskable icons (60% — leaves the ~20% safe zone
 * Android requires) and the apple-touch-icon (64% — iOS aesthetic).
 */
async function renderOnWhite(svgString, size, scale, outPath) {
  const logoSize = Math.round(size * scale);
  const inset = Math.floor((size - logoSize) / 2);

  // Solid white full-bleed background.
  const bg = await sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  })
    .png()
    .toBuffer();

  // Logo rendered with transparency so it composites cleanly over white.
  const density = Math.max(72, Math.ceil((logoSize / 64) * 72 * 2));
  const logo = await sharp(Buffer.from(svgString), { density })
    .resize(logoSize, logoSize, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();

  await sharp(bg)
    .composite([{ input: logo, left: inset, top: inset }])
    .png({ compressionLevel: 9 })
    .toFile(outPath);
  const pct = Math.round(scale * 100);
  console.log(`  ✓ ${path.relative(ROOT, outPath)}  (${size}×${size}, white, logo @ ${pct}%)`);
}

async function main() {
  const sourceSvg = await readFile(SOURCE_SVG, 'utf8');
  await mkdir(ICONS_DIR, { recursive: true });

  console.log(`Generating Beam PWA icons from ${path.relative(ROOT, SOURCE_SVG)}\n`);

  // 1. Plain icons — transparent background (clean on both light & dark surfaces).
  await renderTransparent(sourceSvg, 192, path.join(ICONS_DIR, 'icon-192.png'));
  await renderTransparent(sourceSvg, 512, path.join(ICONS_DIR, 'icon-512.png'));

  // 2. Maskable icons — white full-bleed + logo at 60% (Android safe zone is inner 80%).
  await renderOnWhite(sourceSvg, 192, 0.60, path.join(ICONS_DIR, 'icon-maskable-192.png'));
  await renderOnWhite(sourceSvg, 512, 0.60, path.join(ICONS_DIR, 'icon-maskable-512.png'));

  // 3. Apple touch icon — 180×180, white bg, logo @ 64%.
  await renderOnWhite(sourceSvg, 180, 0.64, path.join(PUBLIC, 'apple-touch-icon.png'));

  // 4. Small favicon substitute (32×32, transparent) — referenced in <link rel="icon">.
  await renderTransparent(sourceSvg, 32, path.join(PUBLIC, 'icon-32.png'));

  console.log('\nAll icons generated.');
}

main().catch((err) => {
  console.error('Icon generation failed:', err);
  process.exit(1);
});
