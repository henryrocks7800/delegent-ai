import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { RunEventEncoder } from '../src/events.ts';
import { createSessionCompaction, type CompactionEvent, type SummaryResult } from '../src/sessionCompaction.ts';
import type { LanguageModel } from 'ai';

const source = readFileSync(new URL('../src/agent.ts', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('agent.ts', source, ts.ScriptTarget.Latest, true);
const declaration = parsed.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === 'CoworkerAgent')!;
const selected = new Set(['runExecutionTail', 'configureSession', 'addCompactionUsage', 'addInboxSortUsage', 'inboxSortEnabled', 'addMoneyFinderUsage', 'moneyFinderEnabled', 'captureRunUsage', 'onChatResponse', 'startRun', 'stopRun', 'enqueueRun', 'executeRun']);
const members = declaration.members.filter((member) => member.name && selected.has(member.name.getText(parsed)));
assert.equal(members.length, selected.size);
const compiled = ts.transpileModule(`class UsageHarness { ${members.map((member) => member.getText(parsed)).join('\n')} }`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const Harness = new Function('SSE_KEEPALIVE_MS', 'KEEP_FINISHED_RUN_MS', 'STOP_GRACE_MS', 'SESSION_COMPACT_AFTER_TOKENS', 'RunEventEncoder', 'stripWorkspaceNote',
  `${compiled}; return UsageHarness;`)(1000, 0, 0, 48_000, RunEventEncoder, (value: string) => value);

const empty = () => ({ calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 });
function fixture() {
  let pending = { calls: 1, inputTokens: 100, outputTokens: 10, cachedTokens: 20, costUsd: 0.001 };
  const agent = new Harness();
  Object.assign(agent, { turn: null, lastUsage: null, maxSteps: 8, live: new Map(), ensureTables: () => {}, sql: () => [],
    emit: () => {}, close: () => {}, sessionCompactionValue: { drainUsage: () => { const value = pending; pending = empty(); return value; } } });
  return { agent, setPending: (value: typeof pending) => { pending = value; } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function startFixture() {
  const setup = fixture(); setup.setPending(empty());
  const rows = new Map<string, { run_id: string; status: string; usage_json?: string }>();
  const executions: Promise<void>[] = [];
  setup.agent.sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join('?');
    if (query.startsWith('SELECT * FROM agent_runs') || query.startsWith('SELECT status FROM agent_runs')) {
      const row = rows.get(String(values[0])); return row ? [row] : [];
    }
    if (query.startsWith('INSERT INTO agent_runs')) {
      assert.equal(rows.has(String(values[0])), false, 'one admission per run ID');
      rows.set(String(values[0]), { run_id: String(values[0]), status: 'working' });
    }
    if (query.startsWith('UPDATE agent_runs')) {
      const row = rows.get(String(values[6]))!;
      row.status = String(values[0]); row.usage_json = String(values[5]);
    }
    return [];
  };
  setup.agent.setAgentName = async () => {};
  setup.agent.keepAliveWhile = (work: () => Promise<void>) => {
    const running = work(); executions.push(running); void running.catch(() => {}); return running;
  };
  setup.agent.write = () => {};
  const start = (runId: string) => setup.agent.startRun({ runId, message: 'Synthetic request', attachments: [], agentName: null });
  const usage = (runId: string) => JSON.parse(rows.get(runId)!.usage_json!);
  const stats = (inputTokens: number, costUsd: number) => ({ started: Date.now(), firstTextMs: 1, steps: 1,
    inputTokens, outputTokens: 10, cachedTokens: 0, costUsd, tools: [], toolMs: 0, retries: 0 });
  return { ...setup, rows, executions, start, usage, stats };
}

test('pre-beforeTurn inference failure still finalizes reported compaction usage on the failed run', async () => {
  const { agent } = fixture();
  agent.runTurn = async () => { throw new Error('synthetic setup failure'); };
  let error = false;
  const run = { runId: 'origin-run', controller: new AbortController(), listeners: new Set(), done: false,
    encoder: { failed: (value?: string) => { if (value) error = true; return error; }, finalText: '', cards: [], errorText: '', finish: () => ({}) } };
  await agent.executeRun(run, { role: 'user', parts: [] });
  assert.deepEqual(agent.lastUsage, { steps: 0, inputTokens: 100, outputTokens: 10, cachedTokens: 20, costUsd: 0.001, toolCalls: 0 });
  assert.equal(agent.activeRunId, undefined);
  assert.deepEqual(agent.captureRunUsage(), agent.lastUsage, 'a second final drain never charges twice');
});

test('response hook and final drain count compaction once without increasing tool or inference step counts', () => {
  const { agent, setPending } = fixture();
  agent.turn = { started: Date.now(), firstTextMs: 1, steps: 2, inputTokens: 1000, outputTokens: 50,
    cachedTokens: 100, costUsd: 0.01, tools: ['one'], toolMs: 1, retries: 0 };
  agent.onChatResponse({ status: 'completed' });
  assert.deepEqual(agent.lastUsage, { steps: 2, inputTokens: 1100, outputTokens: 60, cachedTokens: 120, costUsd: 0.011, toolCalls: 1 });
  assert.deepEqual(agent.captureRunUsage(), agent.lastUsage);
  setPending({ calls: 1, inputTokens: 20, outputTokens: 2, cachedTokens: 0, costUsd: 0.001 });
  agent.lastUsage = agent.captureRunUsage();
  assert.equal(agent.lastUsage.inputTokens, 1120); assert.equal(agent.lastUsage.toolCalls, 1);
  assert.equal(agent.captureRunUsage().inputTokens, 1120);
});

test('session compaction runs for every account, pilot or not', () => {
  // It was pilot-only until 2026-09-22; without it Think keeps every message and
  // each reply costs more than the last.
  const { agent } = fixture();
  const compact = () => undefined;
  let configured = false; let threshold = 0;
  const session = { onCompaction: (value: unknown) => { assert.equal(value, compact); configured = true; return session; },
    compactAfter: (value: number) => { threshold = value; return session; } };
  agent.inboxSortEnabled = () => false;
  agent.sessionCompaction = () => ({ compact });
  assert.equal(agent.configureSession(session), session); assert.equal(configured, true); assert.equal(threshold, 48_000);
});

test('distinct accepted starts serialize outer accounting and preserve late compaction origin across runs', async () => {
  const f = startFixture();
  const enteredA = deferred<void>(); const releaseA = deferred<void>();
  const enteredB = deferred<void>(); const releaseB = deferred<void>();
  const summary = deferred<SummaryResult>(); const lateEvents: CompactionEvent[] = [];
  const helper = createSessionCompaction({ model: () => 'synthetic-model' as LanguageModel,
    getRunId: () => f.agent.activeRunId, timeoutMs: 5, generate: () => summary.promise,
    onEvent: (event) => lateEvents.push(event) });
  f.agent.sessionCompactionValue = helper;
  const messages = Array.from({ length: 9 }, (_, i) => ({ id: `history-${i}`, role: i % 2 ? 'assistant' : 'user',
    parts: [{ type: 'text' as const, text: 'x'.repeat(i >= 3 ? 30_000 : 10) }] }));
  const calls: string[] = [];
  f.agent.runTurn = async () => {
    const id = f.agent.activeRunId; calls.push(id);
    if (id === 'run-A') {
      enteredA.resolve();
      await assert.rejects(helper.compact(messages), { message: 'compaction_timeout' });
      await releaseA.promise;
      assert.equal(f.agent.activeRunId, 'run-A');
      f.agent.turn = f.stats(101, 0.001);
    } else {
      assert.equal(id, 'run-B');
      enteredB.resolve(); await releaseB.promise;
      assert.equal(f.agent.activeRunId, 'run-B');
      f.agent.turn = f.stats(202, 0.002);
    }
    f.agent.onChatResponse({ status: 'completed' });
  };
  assert.equal((await f.start('run-A')).status, 'started'); await enteredA.promise;
  assert.equal((await f.start('run-B')).status, 'started');
  assert.equal(f.agent.activeRunId, 'run-A', 'queued acceptance cannot reset current accounting');
  assert.deepEqual(calls, ['run-A']);
  releaseA.resolve(); await enteredB.promise;
  summary.resolve({ text: 'Ignored late summary', usage: { inputTokens: 999, outputTokens: 9 },
    providerMetadata: { openrouter: { usage: { cost: 0.09 } } } });
  await Promise.resolve(); await Promise.resolve();
  releaseB.resolve(); await Promise.all(f.executions);
  assert.equal(f.usage('run-A').inputTokens, 101); assert.equal(f.usage('run-A').costUsd, 0.001);
  assert.equal(f.usage('run-B').inputTokens, 202); assert.equal(f.usage('run-B').costUsd, 0.002);
  assert.equal(lateEvents.find((event) => event.status === 'late_usage')?.originRunId, 'run-A');
  assert.equal(f.agent.activeRunId, undefined);
});

test('stopping a queued run skips inference and compaction and records zero usage', async () => {
  const f = startFixture(); const entered = deferred<void>(); const release = deferred<void>();
  const calls: string[] = [];
  f.agent.runTurn = async () => {
    calls.push(f.agent.activeRunId);
    if (f.agent.activeRunId === 'run-A') { entered.resolve(); await release.promise; }
    f.agent.turn = f.stats(f.agent.activeRunId === 'run-A' ? 100 : 300, 0.001);
    f.agent.onChatResponse({ status: 'completed' });
  };
  await f.start('run-A'); await entered.promise;
  await f.start('run-B'); assert.equal(f.agent.stopRun('run-B').status, 'cancelled');
  await f.start('run-C'); release.resolve(); await Promise.all(f.executions);
  assert.deepEqual(calls, ['run-A', 'run-C']);
  assert.equal(f.rows.get('run-B')?.status, 'cancelled');
  assert.deepEqual(f.usage('run-B'), { steps: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0, toolCalls: 0 });
  assert.equal(f.usage('run-C').inputTokens, 300, 'queued cancellation cannot leak prior usage into a later run');
});

test('failed inference and rejected outer execution cannot poison following admitted runs', async () => {
  const f = startFixture();
  f.agent.runTurn = async () => {
    if (f.agent.activeRunId === 'run-A') throw new Error('synthetic turn failure');
    f.agent.turn = f.stats(200, 0.002); f.agent.onChatResponse({ status: 'completed' });
  };
  await Promise.all([f.start('run-A'), f.start('run-B')]); await Promise.all(f.executions);
  assert.equal(f.rows.get('run-A')?.status, 'failed'); assert.equal(f.rows.get('run-B')?.status, 'succeeded');
  const execute = f.agent.executeRun.bind(f.agent);
  f.agent.executeRun = async (run: { runId: string }, message: unknown) => {
    if (run.runId === 'run-C') throw new Error('synthetic finalization failure');
    return execute(run, message);
  };
  await f.start('run-C'); await f.start('run-D');
  const outcomes = await Promise.allSettled(f.executions.slice(2));
  assert.equal(outcomes[0].status, 'rejected'); assert.equal(outcomes[1].status, 'fulfilled');
  assert.equal(f.rows.get('run-D')?.status, 'succeeded'); assert.equal(f.usage('run-D').inputTokens, 200);
});

test('concurrent same-ID starts retain idempotent admission after awaited preparation', async () => {
  const f = startFixture(); let calls = 0;
  f.agent.runTurn = async () => { calls++; f.agent.turn = f.stats(100, 0.001); f.agent.onChatResponse({ status: 'completed' }); };
  const replies = await Promise.all([f.start('same-run'), f.start('same-run')]);
  await Promise.all(f.executions);
  assert.equal(replies.length, 2); assert.equal(f.rows.size, 1); assert.equal(f.executions.length, 1); assert.equal(calls, 1);
});

test('background inbox sort model usage is charged to the next chat turn, once', () => {
  const { agent, setPending } = fixture(); setPending(empty());
  let unbilled = { calls: 3, inputTokens: 900, outputTokens: 90, costUsd: 0.02, actions: 25 };
  agent.inboxSortEnabled = () => true;
  agent.inboxSortStore = () => ({ drainUsage: () => { const value = unbilled; unbilled = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, actions: 0 }; return value; } });
  agent.turn = { steps: 1, inputTokens: 100, outputTokens: 10, cachedTokens: 0, costUsd: 0.001, tools: [], retries: 0, toolMs: 0 };
  const first = agent.captureRunUsage();
  assert.equal(first.inputTokens, 1000); assert.equal(first.outputTokens, 100); assert.equal(Math.round(first.costUsd * 1e6), 21_000);
  assert.equal(first.toolCalls, 25, 'background Composio calls are billed like chat app actions');
  const second = agent.captureRunUsage();
  assert.equal(second.inputTokens, 1000, 'drained usage is not charged twice');
  agent.inboxSortEnabled = () => false; unbilled = { calls: 1, inputTokens: 5, outputTokens: 5, costUsd: 1, actions: 9 };
  assert.equal(agent.captureRunUsage().inputTokens, 1000, 'accounts without sorting never drain');
});
