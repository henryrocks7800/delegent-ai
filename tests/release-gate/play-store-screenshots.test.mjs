// Release-gate scanner for the Google Play store screenshots.
//
// Why this exists: the four screenshots captured on 2026-07-26 came off a
// modern tall-aspect handset at 1080x2410. That is 2.23:1, and Play rejects
// any image whose long side is more than twice its short side. Every one of
// them would have bounced at upload, and nothing in the repo would have caught
// it, because a screenshot looks fine to a human right up until Play refuses
// the release.
//
// Play's spec (support.google.com/googleplay/android-developer/answer/9866151):
//   PNG (24-bit, no alpha) or JPEG, each side 320px to 3840px,
//   long side at most 2x the short side, 2 to 8 images per device type.
//
// A file with REJECTED in its name is a deliberate record of a frame we must
// never upload. Those are excluded from the spec checks and from the count,
// but the reason has to be written down next to them.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../docs/play-store/screenshots/', import.meta.url));

const PLAY = {
  minSide: 320,
  maxSide: 3840,
  maxRatio: 2,
  minCount: 2,
  maxCount: 8,
};

function readPng(path) {
  const buf = readFileSync(path);
  const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buf.subarray(0, 8).equals(SIG)) return null;
  // IHDR data starts at byte 16: width, height, bit depth, colour type.
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    bitDepth: buf[24],
    colourType: buf[25],
  };
}

function collect() {
  if (!existsSync(ROOT)) return [];
  const out = [];
  for (const dir of readdirSync(ROOT, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const name of readdirSync(join(ROOT, dir.name))) {
      if (!/\.(png|jpg|jpeg)$/i.test(name)) continue;
      out.push({ set: dir.name, name, path: join(ROOT, dir.name, name) });
    }
  }
  return out;
}

const all = collect();
const rejected = all.filter((f) => /REJECTED/i.test(f.name));
const usable = all.filter((f) => !/REJECTED/i.test(f.name));

test('a screenshot set exists', () => {
  assert.ok(all.length > 0, `no screenshots found under ${ROOT}`);
});

test('every usable screenshot is a format Play accepts', () => {
  const bad = usable.filter((f) => !/\.(png|jpg|jpeg)$/i.test(f.name));
  assert.deepEqual(bad.map((f) => f.name), [], 'Play accepts PNG and JPEG only');
});

test('no usable screenshot carries an alpha channel', () => {
  // Play asks for 24-bit PNG with no alpha. Colour type 4 is grey+alpha and 6
  // is RGBA; an Android screencap is RGBA by default, so this is easy to trip.
  const offenders = [];
  for (const f of usable.filter((x) => x.name.toLowerCase().endsWith('.png'))) {
    const png = readPng(f.path);
    assert.ok(png, `${f.name} is not a valid PNG`);
    if (png.colourType === 4 || png.colourType === 6) {
      offenders.push(`${f.name} (colour type ${png.colourType})`);
    }
  }
  assert.deepEqual(offenders, [], 'flatten onto an opaque background before upload');
});

test('every usable screenshot is within Play dimension limits', () => {
  const offenders = [];
  for (const f of usable.filter((x) => x.name.toLowerCase().endsWith('.png'))) {
    const { width, height } = readPng(f.path);
    const short = Math.min(width, height);
    const long = Math.max(width, height);
    if (short < PLAY.minSide) offenders.push(`${f.name}: short side ${short}px, min ${PLAY.minSide}`);
    if (long > PLAY.maxSide) offenders.push(`${f.name}: long side ${long}px, max ${PLAY.maxSide}`);
  }
  assert.deepEqual(offenders, [], offenders.join('\n'));
});

test('no usable screenshot exceeds Play 2:1 aspect ratio', () => {
  // The one that actually bit us. Any handset taller than 20:9 produces a
  // native capture Play will not take.
  const offenders = [];
  for (const f of usable.filter((x) => x.name.toLowerCase().endsWith('.png'))) {
    const { width, height } = readPng(f.path);
    const ratio = Math.max(width, height) / Math.min(width, height);
    if (ratio > PLAY.maxRatio) {
      offenders.push(`${f.name}: ${width}x${height} is ${ratio.toFixed(3)}:1, Play allows at most ${PLAY.maxRatio}:1`);
    }
  }
  assert.deepEqual(offenders, [], offenders.join('\n'));
});

test('each set has a uploadable number of screenshots', () => {
  const bySet = new Map();
  for (const f of usable) bySet.set(f.set, (bySet.get(f.set) || 0) + 1);
  for (const [set, count] of bySet) {
    assert.ok(count >= PLAY.minCount, `${set} has ${count} usable screenshots, Play requires at least ${PLAY.minCount}`);
    assert.ok(count <= PLAY.maxCount, `${set} has ${count} usable screenshots, Play allows at most ${PLAY.maxCount}`);
  }
});

test('the declared screenshot order matches the frames on disk', () => {
  // Play renders phone screenshots in UPLOAD order, so the list in LISTING.md is
  // the store's running order. If a frame is added to the folder but not to the
  // list it never reaches the store, and if the list names a file that no longer
  // exists the upload dies part-way through an edit. Both directions fail here.
  const listing = fileURLToPath(new URL('../../docs/play-store/LISTING.md', import.meta.url));
  const md = readFileSync(listing, 'utf8');
  const block = md.match(/<!-- play:screenshot-order -->\s*\n```\n([\s\S]*?)\n```/);
  assert.ok(block, 'LISTING.md has no play:screenshot-order block');

  const ordered = block[1].split('\n').map((l) => l.trim()).filter(Boolean);
  // The set that is actually uploaded. Older dated folders stay on disk for the
  // record and are still spec-checked above, but only this one has to match
  // the running order.
  const SET = 'device-2026-09-17';
  const onDisk = usable.filter((f) => f.set === SET).map((f) => f.name).sort();

  assert.deepEqual(
    [...ordered].sort(),
    onDisk,
    `the order in LISTING.md and the usable frames in ${SET} disagree:\n` +
      `  listed only: ${ordered.filter((n) => !onDisk.includes(n)).join(', ') || 'none'}\n` +
      `  on disk only: ${onDisk.filter((n) => !ordered.includes(n)).join(', ') || 'none'}`,
  );
  assert.equal(new Set(ordered).size, ordered.length, 'a screenshot is listed twice');
  for (const name of ordered) {
    assert.ok(!/REJECTED/i.test(name), `${name} is a rejected frame and must not be in the order`);
  }
});

test('every rejected screenshot says why, next to the file', () => {
  // A frame is only marked REJECTED because uploading it would misrepresent
  // the product. Without the reason recorded it just looks like a stray file
  // and someone uploads it anyway.
  for (const f of rejected) {
    const readme = join(ROOT, f.set, 'README.md');
    assert.ok(existsSync(readme), `${f.set} has a REJECTED screenshot but no README.md explaining it`);
    const text = readFileSync(readme, 'utf8');
    assert.ok(text.includes(f.name), `${f.set}/README.md does not mention ${f.name}`);
  }
});
