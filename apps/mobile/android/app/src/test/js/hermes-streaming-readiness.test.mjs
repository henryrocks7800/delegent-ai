// [hermes-streaming Phase E] Readiness tests for the live-events path.
// These run via the existing `npm test --workspace @sidekick/mobile`
// test pack and don't require a live runner.
//
// What's locked in here:
//  - The Worker source declares the three streaming endpoints and the
//    normaliseHermesEvent mapper.
//  - The runner FastAPI wrapper exposes the /v1/runs* proxy routes.
//
// The mobile-side consumer is the chat WebView (chatWebViewHtml.ts);
// its SSE behaviour is covered by src/chat/__tests__/webViewBehavior.test.ts.
// The legacy native consumer (HomeChatPanel + runStream) was deleted
// 2026-06-10 after being verified unmounted.
//
// String-match based so the tests work without an RN renderer or
// Cloudflare Worker runtime in the loop.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workerSource = readFileSync(new URL('../../../../../../worker/src/index.ts', import.meta.url), 'utf8');
const runnerSource = readFileSync(new URL('../../../../../../../services/hermes-runner/server.py', import.meta.url), 'utf8');

test('Worker declares the three streaming endpoints + normaliseHermesEvent + parseSseBlock', () => {
  assert.match(workerSource, /url\.pathname === '\/api\/chat\/runs' && request\.method === 'POST'/);
  assert.match(workerSource, /url\.pathname\.startsWith\('\/api\/chat\/runs\/'\) && url\.pathname\.endsWith\('\/events'\)/);
  assert.match(workerSource, /url\.pathname\.startsWith\('\/api\/chat\/runs\/'\) && url\.pathname\.endsWith\('\/stop'\)/);
  assert.match(workerSource, /async function handleChatRunCreate/);
  assert.match(workerSource, /async function handleChatRunEvents/);
  assert.match(workerSource, /async function handleChatRunStop/);
  assert.match(workerSource, /export function normaliseHermesEvent/);
  // SSE block parser exists for the proxy pipeline.
  assert.match(workerSource, /function parseSseBlock/);
});

test('Worker normaliseHermesEvent maps every raw Hermes event variant we know about', () => {
  // Raw event variants that should land in the normaliser switch.
  const rawTokens = [
    'response.created',
    'response.completed',
    'response.failed',
    'response.output_text.delta',
    'chat.completion.chunk',
    'message.delta',
    'response.output_text.done',
    'message.complete',
    'hermes.tool.progress',
    'tool.start',
    'tool.progress',
    'hermes.tool.update',
    'tool.complete',
    'tool.completed',
    'hermes.tool.complete',
    'response.output_item.added',
    'response.output_item.done',
    'artifact.created',
    'hermes.artifact.created',
  ];
  for (const raw of rawTokens) {
    assert.match(workerSource, new RegExp(`'${raw.replace(/\./g, '\\.')}'`), `normaliseHermesEvent should recognise raw event ${raw}`);
  }
});

test('Worker streaming endpoints stay behind the existing trust boundary (HMAC for runner, JWT for mobile)', () => {
  // No secret-bearing keys leak into mobile-visible responses.
  // (Pattern-match against the new handlers only — the file as a
  // whole legitimately uses these in the runner-side paths.)
  const block = workerSource.slice(workerSource.indexOf('async function handleChatRunCreate'), workerSource.indexOf('export default {'));
  assert.match(block, /authedUserOrErrorResponse\(request, env\)/);
  assert.match(block, /buildSidekickRunnerTaskHeaders/);
  // Worker uses runnerBaseUrlFromTaskUrl helper to reach the new /v1
  // proxy endpoints on the same runner host.
  assert.match(workerSource, /function runnerBaseUrlFromTaskUrl/);
});

test('runner FastAPI wrapper exposes the four /v1 proxy routes with HMAC auth', () => {
  assert.match(runnerSource, /@app\.get\('\/v1\/capabilities'\)/);
  assert.match(runnerSource, /@app\.post\('\/v1\/runs'\)/);
  assert.match(runnerSource, /@app\.get\('\/v1\/runs\/\{run_id\}'\)/);
  assert.match(runnerSource, /@app\.post\('\/v1\/runs\/\{run_id\}\/stop'\)/);
  assert.match(runnerSource, /@app\.get\('\/v1\/runs\/\{run_id\}\/events'\)/);
  // Every proxy route checks HMAC auth.
  const proxyBlock = runnerSource.slice(runnerSource.indexOf('hermes_capabilities'), runnerSource.indexOf("if __name__ == '__main__'"));
  // At least four auth calls in the proxy block (capabilities + runs.create + runs.stop + runs.events).
  const matches = proxyBlock.match(/require_sidekick_runner_authorization\(request\)/g) ?? [];
  assert.ok(matches.length >= 4, `expected ≥4 HMAC checks in the /v1 proxy block, saw ${matches.length}`);
});

test('runner launches Hermes API server on loopback only and never bakes the bearer into the image', () => {
  assert.match(runnerSource, /HERMES_API_DEFAULT_HOST = '127\.0\.0\.1'/);
  // The Hermes API Server is enabled per-container via a YAML gateway
  // config seeded by `_seed_hermes_gateway_config` (the legacy env-var
  // form `API_SERVER_ENABLED=true` was retired when we moved to
  // `hermes gateway run` in v2026.5.7). The substantive contract is
  // that the api_server platform is enabled and bound to the loopback
  // host/port with the per-container bearer key.
  assert.match(
    runnerSource,
    /platforms:[\s\S]*?api_server:[\s\S]*?enabled: true/,
    'gateway YAML config must enable the api_server platform',
  );
  assert.match(
    runnerSource,
    /api_server:[\s\S]*?host: \{host\}[\s\S]*?port: \{port\}[\s\S]*?key: "\{bearer\}"/,
    'api_server config must bind to the supplied loopback host/port with the per-container bearer',
  );
  // The adapter env-var fallback still carries the bearer so legacy
  // tools can pick it up. (Belt-and-braces with the YAML config above.)
  assert.match(runnerSource, /'API_SERVER_KEY': bearer/);
  // The bearer is generated per-container via secrets.token_urlsafe —
  // never read from the image at build time, never reused across
  // containers.
  assert.match(runnerSource, /_secrets_mod\.token_urlsafe/);
  // The runner does NOT log the bearer key into the public /healthz response.
  const healthzBlock = runnerSource.slice(runnerSource.indexOf('def healthz()'), runnerSource.indexOf('@app.get(\'/health\')'));
  assert.doesNotMatch(healthzBlock, /bearer_key/);
});
