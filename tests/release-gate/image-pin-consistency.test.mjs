import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CANONICAL_LOCK_PATH,
  collectPins,
  checkMirror,
} from '../../scripts/check-image-pin-consistency.mjs';

// Go-live tracker #32: a single canonical runner image pin + drift check.
//
// services/hermes-runner/RUNNER_IMAGE.lock.json is CANONICAL because it is the
// file `npm run promote` rotates behind the green-release verdict gate; it is
// the only place a new digest may enter the repo. Every other in-repo copy of
// the digest (RUNNER_IMAGE.json, series-version.json, the internal update
// helper) is a convenience record. If they disagree, a disaster-recovery
// rebuild can silently re-pin an OLDER image; this gate makes that drift loud.
//
// Environment-only sources (the local Doppler mirror, Doppler itself, the
// GitHub Actions secret the series4 cron reads) cannot be asserted from CI;
// they are noted as diagnostics, never failed, unless IMAGE_PIN_STRICT_ENV=1.

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const FULL_REF_RE = /^registry\.fly\.io\/[\w./-]+@sha256:[0-9a-f]{64}$/;

test('canonical lock pins a digest-pinned registry ref (current + rollback target)', () => {
  const { lock, canonicalDigest, previousDigest } = collectPins(repoRoot);

  assert.match(
    lock.current?.digest ?? '',
    FULL_REF_RE,
    `${CANONICAL_LOCK_PATH} current.digest must be a digest-pinned registry.fly.io ref; tag-only refs silently roll forward`,
  );
  assert.ok(canonicalDigest, `${CANONICAL_LOCK_PATH} current.digest must contain a sha256 digest`);

  if (lock.previous?.digest) {
    assert.match(
      lock.previous.digest,
      FULL_REF_RE,
      `${CANONICAL_LOCK_PATH} previous.digest (the rollback target) must also be digest-pinned`,
    );
    assert.notEqual(
      previousDigest,
      canonicalDigest,
      `${CANONICAL_LOCK_PATH} previous.digest equals current.digest; the rollback target is meaningless`,
    );
  }
});

test('every other in-repo pin location matches the canonical lock digest', () => {
  const { canonicalDigest, pins } = collectPins(repoRoot);
  const drifted = pins.filter((pin) => pin.digest !== canonicalDigest);

  const details = drifted
    .map((pin) => `  - ${pin.file} [${pin.field}] pins ${pin.digest ?? '(no digest found)'}`)
    .join('\n');
  assert.equal(
    drifted.length,
    0,
    `IMAGE PIN DRIFT against canonical ${CANONICAL_LOCK_PATH} (current ${canonicalDigest}):\n${details}\n` +
      '  Fix: update the drifted file(s) to the canonical digest. New digests enter ONLY via ' +
      'npm run promote (gated) or scripts/internal/repin-runner-image.mjs, which rotate the lock first.',
  );
});

test('the canonical lock itself only references current/previous digests', () => {
  // Guards the lock's own restore commands: a DR operator following a stale
  // "docker pull <digest>" line would resurrect an ancient image.
  const { canonicalDigest, previousDigest, lockDigests } = collectPins(repoRoot);
  const allowed = new Set([canonicalDigest, previousDigest].filter(Boolean));
  const strays = lockDigests.filter((digest) => !allowed.has(digest));
  assert.deepEqual(
    strays,
    [],
    `${CANONICAL_LOCK_PATH} mentions digest(s) that are neither current nor previous: ${strays.join(', ')}. ` +
      'Update the restore commands whenever the image is repinned.',
  );
});

test('environment-only pin sources are noted, not failed (Doppler mirror / Doppler / GH secret)', (t) => {
  const { canonicalDigest } = collectPins(repoRoot);
  const mirror = checkMirror(canonicalDigest);

  t.diagnostic(`doppler mirror (${mirror.location}): ${mirror.note}`);
  t.diagnostic(
    'Doppler delegent-ai/prd and the GitHub Actions repo secret SIDEKICK_FLY_RUNNER_IMAGE_REF are not readable from this test; ' +
      'they are pushed by scripts/internal/repin-runner-image.mjs and consumed by .github/workflows/series4-cron.yml.',
  );

  if (mirror.readable && mirror.digest && mirror.matches === false) {
    if (process.env.IMAGE_PIN_STRICT_ENV === '1') {
      assert.fail(`Doppler mirror drift (IMAGE_PIN_STRICT_ENV=1): ${mirror.note}`);
    }
    t.diagnostic(`WARNING: ${mirror.note} (set IMAGE_PIN_STRICT_ENV=1 to make this a hard failure)`);
  }
});
