#!/usr/bin/env node
/**
 * Speed and cost per model route, on the coworker's real prompt and tools.
 *   node eval/speed.mjs [--runs 3] [--only name,name]
 * Streams one realistic request three times per route (cold, then warm for the
 * prompt cache) and reports time to first output, total time, hidden reasoning
 * tokens, cache hits and cost. Synthetic request, no customer data.
 */
import { readFileSync } from 'node:fs';
import { env, openSession } from './composio.mjs';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const RUNS = Number(arg('runs', '3'));
const only = (arg('only', '') || '').split(',').filter(Boolean);
const DS = (provider) => ({ model: 'deepseek/deepseek-v4.1-flash', provider: { order: [provider], allow_fallbacks: false, data_collection: 'deny' }, reasoning: { enabled: false } });
const ROUTES = {
  'luna-5.6 azure/eu (current)': { model: 'openai/gpt-5.6-luna', provider: { order: ['azure/eu'], allow_fallbacks: false, zdr: true, data_collection: 'deny' }, reasoning: { effort: 'none' } },
  'luna-6 openai': { model: 'openai/gpt-6-luna', provider: { order: ['openai'], allow_fallbacks: false, data_collection: 'deny' }, reasoning: { effort: 'none' } },
  'luna-6 openai/fast': { model: 'openai/gpt-6-luna', provider: { order: ['openai/fast'], allow_fallbacks: false, data_collection: 'deny' }, reasoning: { effort: 'none' } },
  'luna-6 bedrock': { model: 'openai/gpt-6-luna', provider: { order: ['amazon-bedrock/us-east-1'], allow_fallbacks: false, data_collection: 'deny' }, reasoning: { effort: 'none' } },
  'deepseek deepinfra': DS('deepinfra/fp8'),
  'deepseek fireworks': DS('fireworks'),
  'deepseek together': DS('together'),
  'deepseek morph': DS('morph'),
  'deepseek wafer': DS('wafer'),
  'deepseek deepseek': DS('deepseek'),
  'deepseek parasail': DS('parasail/fp8'),
  'deepseek novita': DS('novita/fp8'),
};

const source = readFileSync(new URL('../src/agent.ts', import.meta.url), 'utf8');
const template = source.slice(source.indexOf('return `Your name is') + 'return `'.length, source.indexOf('`;\n}', source.indexOf('return `Your name is')));
const system = `${template.replaceAll('${agentName}', 'Barry')}\n\nToday's date (UK): Tuesday 22 September 2026. Each user message starts with the UK time it was sent.`;
const session = await openSession();
const tools = session.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
const messages = [{ role: 'system', content: system }, { role: 'user', content: '[Sent 10:15 UK time] Add "Team lunch" to my Google Calendar next Monday from 12:30 to 13:30.' }];

async function once(route) {
  const started = Date.now();
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST',
    headers: { authorization: `Bearer ${env.OPENROUTER_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: route.model, provider: route.provider, reasoning: route.reasoning, messages, tools, stream: true, usage: { include: true }, max_tokens: 800 }) });
  if (!response.ok) return { error: `${response.status} ${(await response.text()).slice(0, 160)}` };
  const reader = response.body.getReader(); const decoder = new TextDecoder();
  let buffer = ''; let first = null; let usage = null; let provider = null; let calls = 0; let text = '';
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n'); buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data: ') || line.includes('[DONE]')) continue;
      let event; try { event = JSON.parse(line.slice(6)); } catch { continue; }
      provider ??= event.provider;
      const delta = event.choices?.[0]?.delta ?? {};
      if (first === null && (delta.content || delta.tool_calls || delta.reasoning)) first = Date.now() - started;
      if (delta.tool_calls) calls += delta.tool_calls.filter((c) => c.function?.name).length;
      if (delta.content) text += delta.content;
      if (event.usage) usage = event.usage;
    }
  }
  return { firstMs: first, totalMs: Date.now() - started, provider, toolCalls: calls, text: text.slice(0, 80),
    prompt: usage?.prompt_tokens, cached: usage?.prompt_tokens_details?.cached_tokens ?? 0, output: usage?.completion_tokens,
    reasoning: usage?.completion_tokens_details?.reasoning_tokens ?? 0, cost: usage?.cost };
}

for (const [name, route] of Object.entries(ROUTES)) {
  if (only.length && !only.some((o) => name.includes(o))) continue;
  const rows = [];
  for (let i = 0; i < RUNS; i++) rows.push(await once(route));
  const ok = rows.filter((r) => !r.error);
  if (!ok.length) { console.log(`${name.padEnd(30)} ERROR ${rows[0].error}`); continue; }
  const avg = (key) => Math.round(ok.reduce((n, r) => n + (r[key] ?? 0), 0) / ok.length);
  const cost = ok.reduce((n, r) => n + (r.cost ?? 0), 0) / ok.length;
  console.log(`${name.padEnd(30)} first ${String(avg('firstMs')).padStart(5)} ms  total ${String(avg('totalMs')).padStart(5)} ms  prompt ${avg('prompt')} cached ${avg('cached')} out ${avg('output')} think ${avg('reasoning')}  $${cost.toFixed(5)}  tool calls ${ok.map((r) => r.toolCalls).join('/')}  via ${ok[0].provider}${rows.length > ok.length ? `  (${rows.length - ok.length} errors: ${rows.find((r) => r.error).error})` : ''}`);
}
