// Regenerates the Delegent AI brand assets from a single source PNG.
//
// Source: apps/mobile/assets/delegent-logo-source.png (1254x1254 RGB).
// The source has a near-white background; this generator flood-fills the
// background to transparent so the mark composites cleanly on the splash
// and adaptive-icon backgrounds, then writes every density variant the
// Android build needs plus the four bundled Expo asset slots.
//
// Run with: `node apps/mobile/scripts/generate-coworker-brand-assets.mjs`
//
// The filename keeps the historical "coworker" prefix to avoid churning
// the brand-strings-scan allowlist and the build wiring that points at
// it. The output paths and file names also stay the same so the Expo
// config in app.json / app.config.ts continues to resolve them.

import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const root = path.resolve(import.meta.dirname, '..');
const assets = path.join(root, 'assets');
const res = path.join(root, 'android/app/src/main/res');

const SOURCE = path.join(assets, 'delegent-logo-source.png');

// ⛔ THIS SCRIPT IS STALE AND WILL UNDO THE BRAND IF YOU RUN IT.
//
// delegent-logo-source.png is the OLD BLUE ROBOT. The brand moved to the brain
// mark in #423 (Android, splash, adaptive icon) and on 2026-09-01 for the iOS
// app icon, the Play listing icon and the Play feature graphic. Those assets
// were replaced directly; nobody updated this generator, so it still points at
// the robot.
//
// Running it would silently rewrite icon.png, adaptive-icon.png,
// splash-icon.png AND every Android density variant back to the robot, and the
// next store build would ship it. The commit message on #423 suspected an
// earlier icon regression came from exactly this path.
//
// To use it again, repoint SOURCE at a brain source. apps/website/public/
// app-icon.png is the brain on the #FAFAF7 tile at 1024 and is what the
// current icons were cut from; the flood-fill below would strip that tile the
// same way it strips the robot's. Then delete this guard, run it, and LOOK at
// the output before committing.
if (!process.env.DELEGENT_ALLOW_STALE_BRAND_REGEN) {
  console.error(
    'REFUSING TO RUN: this generator still sources the retired robot logo and\n'
    + 'would revert the brain brand across every icon and density variant.\n'
    + 'Read the comment above SOURCE in this file. If you genuinely mean to,\n'
    + 'set DELEGENT_ALLOW_STALE_BRAND_REGEN=1.',
  );
  process.exit(1);
}

// The Expo splash and Android adaptive icon both sit on this warm off-white
// background (see app.json and app.config.ts). Where we need a solid-icon
// variant (e.g. the legacy square `ic_launcher.webp` shown in launchers that
// don't support adaptive icons), we composite the transparent mark onto this
// colour so the icon does not show a hard white square against the off-white
// system surface.
const SPLASH_BG = { r: 0xFA, g: 0xFA, b: 0xF7 };

// Flood-fills any pixel that is (a) connected to the image edge and (b)
// near-white into transparent. The threshold is picked so that the white
// outer shell of the robot in the source remains opaque — only the framing
// near-white background is removed. Returns a raw RGBA buffer + info so
// callers can feed it back through sharp.
async function loadSourceWithTransparentBackground() {
  const { data: src, info } = await sharp(SOURCE)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const buf = Buffer.from(src);
  const w = info.width;
  const h = info.height;
  const visited = new Uint8Array(w * h);

  // The threshold is generous (≥230 in each channel). The source background
  // samples 237–255 around the edges, while the robot's white shell pixels
  // sit at 255 internally but are not edge-connected — the flood fill only
  // reaches background pixels.
  const threshold = 230;

  const stack = [];
  // Seed the flood from every edge pixel so cuts at the source border are
  // covered even if a single corner happens to land on a coloured pixel.
  for (let x = 0; x < w; x += 1) {
    stack.push(x);
    stack.push((h - 1) * w + x);
  }
  for (let y = 1; y < h - 1; y += 1) {
    stack.push(y * w);
    stack.push(y * w + (w - 1));
  }

  while (stack.length > 0) {
    const idx = stack.pop();
    if (visited[idx]) continue;
    const off = idx * 4;
    if (buf[off] < threshold || buf[off + 1] < threshold || buf[off + 2] < threshold) {
      continue;
    }
    visited[idx] = 1;
    buf[off + 3] = 0;
    const x = idx % w;
    const y = (idx - x) / w;
    if (x > 0) stack.push(idx - 1);
    if (x < w - 1) stack.push(idx + 1);
    if (y > 0) stack.push(idx - w);
    if (y < h - 1) stack.push(idx + w);
  }

  return { data: buf, width: w, height: h };
}

// Cached transparent-bg source so we only flood-fill once per run.
let cachedTransparent = null;
async function transparentSource() {
  if (cachedTransparent === null) {
    cachedTransparent = await loadSourceWithTransparentBackground();
  }
  return cachedTransparent;
}

function pipeline(source) {
  return sharp(source.data, {
    raw: { width: source.width, height: source.height, channels: 4 },
  }).png();
}

async function emit(targetPath, size, options = {}) {
  const { format = 'png', background = null } = options;
  await fs.mkdir(path.dirname(targetPath), { recursive: true });

  const source = await transparentSource();
  let image = pipeline(source).resize({
    width: size,
    height: size,
    fit: 'contain',
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  });

  if (background) {
    image = image.flatten({ background });
  }

  if (format === 'webp') {
    await image.webp({ quality: 92 }).toFile(targetPath);
  } else {
    await image.png({ compressionLevel: 9 }).toFile(targetPath);
  }
}

// Top-level Expo assets ------------------------------------------------------
// `icon.png` is the square app icon shown in some Android launcher fallbacks
// and on Expo Go. We composite onto the splash background so non-adaptive
// surfaces show the mark inside a warm off-white square rather than over a
// transparent checkerboard.
await emit(path.join(assets, 'icon.png'), 1024, { background: SPLASH_BG });

// `adaptive-icon.png` is the foreground layer for Android adaptive icons.
// The system masks it to a circle / squircle and composites it over the
// adaptive-icon background colour configured in app.json. Keep this one
// transparent so the system background colour shows through behind the mark.
await emit(path.join(assets, 'adaptive-icon.png'), 1024, {});

// `splash-icon.png` is shown on the Expo splash screen, which itself draws
// the splash background colour. Transparent again so the off-white shows
// through.
await emit(path.join(assets, 'splash-icon.png'), 1024, {});

// `coworker-ai-mark.png` is the small header / hero mark imported by
// App.tsx via `require('./assets/coworker-ai-mark.png')`. Transparent so it
// composites against the live theme surface.
await emit(path.join(assets, 'coworker-ai-mark.png'), 256, {});

// Android density variants ---------------------------------------------------
// Pixel sizes copied from the previous generator: launcher = 48dp,
// foreground = 108dp (the standard Android adaptive-icon foreground size),
// and the splash logo matches the densities the Android splash screen
// renders at.
const densities = [
  ['mdpi', 48, 108, 288],
  ['hdpi', 72, 162, 432],
  ['xhdpi', 96, 216, 576],
  ['xxhdpi', 144, 324, 864],
  ['xxxhdpi', 192, 432, 1152],
];

for (const [density, launcher, foreground, splash] of densities) {
  // ic_launcher / ic_launcher_round are the legacy single-image launchers
  // used when the device does not honour the adaptive-icon XML. Solid
  // background so they don't render as a hard white square against the
  // system surface.
  await emit(path.join(res, `mipmap-${density}/ic_launcher.webp`), launcher, {
    format: 'webp',
    background: SPLASH_BG,
  });
  await emit(path.join(res, `mipmap-${density}/ic_launcher_round.webp`), launcher, {
    format: 'webp',
    background: SPLASH_BG,
  });
  // The adaptive-icon foreground stays transparent — the system pairs it
  // with the background colour set by the adaptive-icon XML.
  await emit(path.join(res, `mipmap-${density}/ic_launcher_foreground.webp`), foreground, {
    format: 'webp',
  });
  // The splash drawable sits on the splash background colour configured
  // in styles.xml, so it stays transparent.
  await emit(path.join(res, `drawable-${density}/splashscreen_logo.png`), splash, {});
}

console.log('Regenerated Delegent AI brand assets from delegent-logo-source.png.');
