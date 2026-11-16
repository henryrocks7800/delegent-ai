/**
 * The background half of "sort my inbox", on Cloudflare Workflows through the
 * Agents SDK. Each step is durable and retried on its own: plan, wait for the
 * user's one approval, then file page by page (Outlook) or search by search
 * (Gmail). The Agent owns state, notices and billing; this class owns pacing.
 *
 * Nothing here holds email content between steps. Step results are counts and
 * a date cursor; the plan lives in the Agent's SQLite until filing ends.
 */
import { AgentWorkflow, type AgentWorkflowEvent, type AgentWorkflowStep } from 'agents/workflows';
import type { AgentEnv, CoworkerAgent } from './agent.ts';
import { createGmailInboxProvider } from './inboxGmail.ts';
import { createOutlookInboxProvider } from './inboxOutlook.ts';
import { agentModel } from './model.ts';
import type { SortProvider } from './inboxSort.ts';
import { applyGmailSort, applyOutlookPage, planGmailSort, planOutlookSort, withReadRetry } from './inboxSortRun.ts';

export type InboxSortParams = { sortId: string; userId: string; provider: SortProvider; purpose?: string };
export const INBOX_SORT_WORKFLOW = 'INBOX_SORT';
const MAX_OUTLOOK_PAGES = 120; // 120,000 messages, above the census cap

export class InboxSortWorkflow extends AgentWorkflow<CoworkerAgent, InboxSortParams> {
  async run(event: AgentWorkflowEvent<InboxSortParams>, step: AgentWorkflowStep) {
    const { sortId, userId, provider, purpose } = event.payload;
    const env = this.env as unknown as AgentEnv;
    // Every Composio call is counted, so the background work is billed like chat app actions.
    const counted = () => {
      const counter = { calls: 0 };
      const fetch = ((input: RequestInfo | URL, init?: RequestInit) => { counter.calls += 1; return globalThis.fetch(input, init); }) as typeof globalThis.fetch;
      return { counter, options: { apiKey: env.COMPOSIO_API_KEY, userId, fetch } };
    };
    const model = () => agentModel(env.OPENROUTER_API_KEY, (reason, attempt) => console.warn(`[inbox_sort] model retry ${attempt}: ${reason}`));
    const agent = this.agent;

    const planned = await step.do('plan', { retries: { limit: 1, delay: '20 seconds', backoff: 'constant' }, timeout: '20 minutes' }, async () => {
      const { counter, options } = counted();
      const result = provider === 'gmail'
        ? await planGmailSort({ provider: createGmailInboxProvider(options), model, ...(purpose ? { purpose } : {}) })
        : await planOutlookSort({ provider: createOutlookInboxProvider(options), model, ...(purpose ? { purpose } : {}) });
      // RPC results are stubs; a step must return plain data.
      const saved = await agent.inboxSortPlanned(sortId, result.plan, counter.calls);
      return { toFile: Number(saved.toFile) };
    });
    if (!planned.toFile) return;

    await this.waitForApproval(step, { timeout: '24 hours' });
    const started = await step.do('start filing', async () => ({ ok: await agent.inboxSortFilingStarted(sortId), at: new Date().toISOString() }));
    if (!started.ok) return;

    if (provider === 'gmail') {
      const queries = await step.do('gmail searches', async () => await agent.inboxSortQueryCount(sortId));
      for (let index = 0; index < queries; index++) {
        await step.do(`gmail ${index}`, { retries: { limit: 3, delay: '30 seconds', backoff: 'exponential' }, timeout: '15 minutes' }, async () => {
          const plan = await agent.inboxSortPlan(sortId);
          const query = plan?.gmailQueries?.[index];
          if (!plan || !query) return { moved: 0 };
          const moves: { messageId: string; folderId: string }[] = [];
          const { counter, options } = counted();
          const gmail = createGmailInboxProvider(options);
          await withReadRetry(() => gmail.resolveAccount());
          const result = await applyGmailSort({ provider: gmail, plan: { ...plan, gmailQueries: [query] },
            journal: (entry) => { for (const messageId of entry.ids) moves.push({ messageId, folderId: entry.folderId }); } });
          await agent.inboxSortMoved(sortId, moves, { moved: result.moved, skipped: 0, failed: 0 }, counter.calls);
          return { moved: result.moved };
        });
      }
    } else {
      let before = new Date(Date.parse(started.at) + 60_000).toISOString();
      for (let page = 0; page < MAX_OUTLOOK_PAGES; page++) {
        const next = await step.do(`outlook ${page}`, { retries: { limit: 3, delay: '30 seconds', backoff: 'exponential' }, timeout: '20 minutes' }, async () => {
          const plan = await agent.inboxSortPlan(sortId);
          if (!plan) return { done: true, before };
          const { counter, options } = counted();
          const outlook = createOutlookInboxProvider(options);
          await withReadRetry(() => outlook.resolveAccount());
          const result = await applyOutlookPage({ provider: outlook, plan, before });
          await agent.inboxSortMoved(sortId, result.moves, { moved: result.moved, skipped: result.skipped, failed: result.failed }, counter.calls);
          return { done: !result.full || !result.oldest, before: result.oldest ?? before };
        });
        if (next.done) break;
        before = next.before;
      }
    }
    await step.do('finish', async () => { await agent.inboxSortFinished(sortId, 'done'); return true; });
  }
}
