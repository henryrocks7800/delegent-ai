import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// The uptime probe (2026-09-23). The Worker's deep health used to check the
// database and the model account only, so a broken engine alerted nobody. It
// now signs a request as the ops-probe identity to GET /ops/health.
const index = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
const agent = readFileSync(new URL('../src/agent.ts', import.meta.url), 'utf8');

test('/ops/health answers only for the probe instance, never a customer', () => {
  const route = index.slice(index.indexOf("path === '/ops/health'"), index.indexOf("path === '/ops/memory'"));
  assert.ok(route.length > 0, 'the route exists');
  assert.match(route, /request\.method === 'GET'/);
  assert.match(route, /if \(userId !== PROBE_USER\) return json\(\{ error: 'not_found' \}, 404\);/);
  assert.ok(route.indexOf('PROBE_USER') < route.indexOf('agent.health()'), 'the identity is checked before the instance does anything');
  assert.match(route, /health\.ok \? 200 : 503/, 'a failing engine answers 503 so the probe fails');
});

test('health() proves storage round-trips and the model key is accepted', () => {
  const health = agent.slice(agent.indexOf('async health()'), agent.indexOf('/** Account deletion'));
  assert.ok(health.length > 0, 'health() exists');
  assert.match(health, /this\.setMeta\('health_checked_at', at\)/);
  assert.match(health, /this\.meta\('health_checked_at'\) === at/, 'reads back what it wrote');
  assert.match(health, /openrouter\.ai\/api\/v1\/auth\/key/, 'asks the model provider about the engine key, which costs no tokens');
  assert.match(health, /AbortSignal\.timeout\(/, 'a hung provider cannot hang the probe');
  assert.match(health, /ok: storage && modelKey/);
});
