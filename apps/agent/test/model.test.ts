import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { MODEL, PROVIDER_ROUTING, REASONING } from '../src/model.ts';

const worker = readFileSync(new URL('../../worker/src/index.ts', import.meta.url), 'utf8');

test('same model, provider order and privacy routing as the production model proxy', () => {
  assert.equal(MODEL, worker.match(/^export const MODEL = '([^']+)';/m)?.[1]);
  const pin = worker.match(/^export const MODEL_PROVIDER_PIN = '([^']+)';/m)?.[1];
  const tail = worker.match(/^export const MODEL_PROVIDER_ORDER: readonly string\[\] = \[MODEL_PROVIDER_PIN(.*)\];/m)?.[1] ?? '';
  const rest = [...tail.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(PROVIDER_ROUTING.order, [pin, ...rest]);
  const ignored = worker.match(/^export const MODEL_PROVIDER_IGNORE: readonly string\[\] = \[(.*)\];/m)?.[1] ?? '';
  assert.deepEqual(PROVIDER_ROUTING.ignore, [...ignored.matchAll(/'([^']+)'/g)].map((m) => m[1]));
  assert.ok(PROVIDER_ROUTING.ignore.includes('amazon-bedrock'), 'Bedrock failed the safety evaluation');
  assert.match(worker, /export const MODEL_PRIVACY_ROUTING = \{ data_collection: 'deny' \} as const;/);
  assert.equal(PROVIDER_ROUTING.data_collection, 'deny');
  assert.equal(PROVIDER_ROUTING.allow_fallbacks, true);
  assert.match(worker, /reasoning: \{ effort: 'none', exclude: true \}/);
  assert.deepEqual(REASONING, { effort: 'none', exclude: true });
});
