// Every place that names the chat model must name the SAME model.
//
// 2026-08-01/02: the Worker moved to deepseek-v4-flash and three other places
// silently kept kimi-k2.6, each failing in its own way:
//   - the usage log reported the old model for a day (a hardcoded SQL literal,
//     fixed by migration 0049),
//   - machine HERMES_MODEL stayed stale, so Hermes sized its context budget off
//     the wrong window and the compaction threshold was silently inert, letting
//     prompt cost climb to 173K tokens/turn,
//   - the provider fallback chain listed providers that do not serve the new
//     model at all.
// Nothing complained about any of it. This test is the complaint.
//
// Source-level regex on purpose (same pattern as image-pin-consistency): the
// worker constant lives in built output, the provisioner constant in TS source,
// and importing both would couple this test to two build pipelines.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function extract(file, re, label) {
  const text = readFileSync(join(REPO, file), 'utf8');
  const m = text.match(re);
  assert.ok(m, `${label}: pattern not found in ${file}`);
  return m[1];
}

test('the Worker and the provisioner pin the same chat model', () => {
  const workerModel = extract(
    'apps/worker/src/index.ts',
    /^export const MODEL = '([^']+)';/m,
    'worker MODEL',
  );
  const runnerModel = extract(
    'packages/provisioner/src/delegentAgentDefaults.ts',
    /^export const DELEGENT_RUNNER_MODEL = '([^']+)' as const;/m,
    'provisioner DELEGENT_RUNNER_MODEL',
  );
  assert.equal(
    runnerModel,
    workerModel,
    'DELEGENT_RUNNER_MODEL (baked into each machine as HERMES_MODEL, and the ' +
      'input to Hermes’ context-window lookup that the compaction threshold ' +
      'multiplies) has drifted from the Worker’s MODEL. Change them together, ' +
      'and re-derive DELEGENT_COMPRESSION_THRESHOLD in ' +
      'services/hermes-runner/server.py against the new window. Existing ' +
      'machines also need `fly machine update --env HERMES_MODEL=...`: ' +
      'provisioning only stamps NEW machines.',
  );
});

test('the provider fallback chain is annotated for the pinned model', () => {
  // The chain is curated per model (providers that do not serve the model turn
  // a 429 into random provider scatter). We cannot query OpenRouter from a
  // release gate, but we CAN insist the curation comment names the model that
  // is actually pinned, so a model change cannot leave a stale chain silently.
  const workerSrc = readFileSync(join(REPO, 'apps/worker/src/index.ts'), 'utf8');
  const model = workerSrc.match(/^export const MODEL = '([^']+)';/m)[1];
  const shortName = model.split('/').pop().split('-').slice(0, 2).join('-');
  const orderBlock = workerSrc.match(/\/\/ Provider fallback chain[\s\S]{0,2500}?MODEL_PROVIDER_ORDER/);
  assert.ok(orderBlock, 'MODEL_PROVIDER_ORDER curation comment not found');
  assert.ok(
    orderBlock[0].toLowerCase().includes(shortName.toLowerCase()),
    `the MODEL_PROVIDER_ORDER comment does not mention "${shortName}" — the ` +
      'chain was curated for a different model. Re-derive it from the new ' +
      "model's own endpoint list (filter on context length) before shipping.",
  );
});
