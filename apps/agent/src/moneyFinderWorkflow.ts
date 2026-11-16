/**
 * The background half of Money Finder, on Cloudflare Workflows through the
 * Agents SDK, like inbox sorting (inboxSortWorkflow.ts). Steps: run each fixed
 * search, then read candidates in small batches and extract facts, then hand
 * the facts to the Agent, which applies the rules and posts the report.
 * Report-only: nothing is sent, moved or changed in the mailbox.
 *
 * Step results are message IDs and extracted facts (company, amounts, dates),
 * never an email's text.
 */
import { AgentWorkflow, type AgentWorkflowEvent, type AgentWorkflowStep } from 'agents/workflows';
import type { AgentEnv, CoworkerAgent } from './agent.ts';
import { createGmailInboxProvider } from './inboxGmail.ts';
import { createOutlookInboxProvider } from './inboxOutlook.ts';
import { withReadRetry } from './inboxSortRun.ts';
import { MONEY_CANDIDATES_PER_SEARCH, moneySearches, yahooMoneySearches, type MoneyFacts, type MoneyProvider } from './moneyFinder.ts';
import { createYahooInboxProvider } from './inboxYahoo.ts';
import { fetchConnectionToken } from './connectionToken.ts';
import { extractMoneyFacts, MONEY_BATCH, type MoneyEmail } from './moneyFinderModel.ts';
import { agentModel } from './model.ts';

export type MoneyFinderParams = { runId: string; userId: string; provider: MoneyProvider };
export const MONEY_FINDER_WORKFLOW = 'MONEY_FINDER';
const EMAILS_PER_STEP = MONEY_BATCH * 2;

export class MoneyFinderWorkflow extends AgentWorkflow<CoworkerAgent, MoneyFinderParams> {
  async run(event: AgentWorkflowEvent<MoneyFinderParams>, step: AgentWorkflowStep) {
    const { runId, userId, provider } = event.payload;
    const env = this.env as unknown as AgentEnv;
    const agent = this.agent;
    const counted = () => {
      const counter = { calls: 0 };
      const fetch = ((input: RequestInfo | URL, init?: RequestInit) => { counter.calls += 1; return globalThis.fetch(input, init); }) as typeof globalThis.fetch;
      return { counter, options: { apiKey: env.COMPOSIO_API_KEY, userId, fetch } };
    };
    const yahoo = () => createYahooInboxProvider({ getToken: () => fetchConnectionToken({
      apiBase: env.PUBLIC_API_BASE, secret: env.SIDEKICK_AGENT_SHARED_SECRET, userId, provider: 'yahoo_mail' }) });
    const model = () => agentModel(env.OPENROUTER_API_KEY, (reason, attempt) => console.warn(`[money_finder] model retry ${attempt}: ${reason}`));

    // 1. Candidates: the fixed searches, newest first, de-duplicated.
    const ids: string[] = [];
    const started = Date.parse(await step.do('started', async () => new Date().toISOString()));
    const searches: { key: string; query?: string; criteria?: ReturnType<typeof yahooMoneySearches>[number]['criteria'] }[] =
      provider === 'yahoo' ? yahooMoneySearches(started) : moneySearches(provider, started);
    for (const search of searches) {
      const found = await step.do(`search ${search.key}`, { retries: { limit: 2, delay: '20 seconds', backoff: 'exponential' }, timeout: '10 minutes' }, async () => {
        const { counter, options } = counted();
        let list: string[];
        if (provider === 'yahoo') {
          const reader = yahoo();
          try {
            await reader.resolveAccount();
            list = await withReadRetry(() => reader.searchIds(search.criteria!, MONEY_CANDIDATES_PER_SEARCH));
          } finally { await reader.close(); }
        } else if (provider === 'gmail') {
          const gmail = createGmailInboxProvider(options);
          await withReadRetry(() => gmail.resolveAccount());
          list = await withReadRetry(() => gmail.searchIds(search.query!, MONEY_CANDIDATES_PER_SEARCH));
        } else {
          const outlook = createOutlookInboxProvider(options);
          await withReadRetry(() => outlook.resolveAccount());
          list = (await withReadRetry(() => outlook.searchMessages(search.query!, MONEY_CANDIDATES_PER_SEARCH))).map((m) => m.id);
        }
        await agent.moneyFinderUsage(runId, { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }, counter.calls, 0);
        return list;
      });
      for (const id of found) if (!ids.includes(id)) ids.push(id);
    }

    // 2. Read and extract, a few emails per durable step.
    const facts: MoneyFacts[] = [];
    for (let offset = 0; offset < ids.length; offset += EMAILS_PER_STEP) {
      const batch = ids.slice(offset, offset + EMAILS_PER_STEP);
      const extracted = await step.do(`read ${offset / EMAILS_PER_STEP}`, { retries: { limit: 2, delay: '20 seconds', backoff: 'exponential' }, timeout: '10 minutes' }, async () => {
        const { counter, options } = counted();
        const reader = provider === 'yahoo' ? yahoo() : provider === 'gmail' ? createGmailInboxProvider(options) : createOutlookInboxProvider(options);
        const emails: MoneyEmail[] = [];
        // The mailbox is only open while reading; it is closed before the slower model calls.
        try {
          await withReadRetry(() => reader.resolveAccount());
          for (const [index, id] of batch.entries()) {
            try {
              const message = await withReadRetry(() => reader.messageText(id));
              emails.push({ ref: `e${index}`, from: message.from, subject: message.subject, date: message.date, text: message.text });
            } catch { /* One unreadable message is skipped, not fatal. */ }
          }
        } finally { if ('close' in reader) await reader.close(); }
        const out: MoneyFacts[] = []; const usage = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
        for (let start = 0; start < emails.length; start += MONEY_BATCH) {
          // A failed batch is retried, never silently skipped: a missing refund email turns a
          // settled charge into a false "money owed" (seen live on 2026-09-25).
          let result = await extractMoneyFacts(model, emails.slice(start, start + MONEY_BATCH));
          for (let attempt = 0; result.failed && attempt < 2; attempt += 1) {
            usage.calls += result.usage.calls; usage.inputTokens += result.usage.inputTokens;
            usage.outputTokens += result.usage.outputTokens; usage.costUsd += result.usage.costUsd;
            result = await extractMoneyFacts(model, emails.slice(start, start + MONEY_BATCH));
          }
          usage.calls += result.usage.calls; usage.inputTokens += result.usage.inputTokens;
          usage.outputTokens += result.usage.outputTokens; usage.costUsd += result.usage.costUsd;
          if (result.failed) {
            // Bill what was spent, then let the durable step retry; if it keeps failing the run
            // ends as failed and the user is told, rather than getting a wrong report.
            await agent.moneyFinderUsage(runId, usage, counter.calls, 0);
            throw new Error('MONEY_MODEL_FAILED');
          }
          // Refs are per-step, so tag them with the step to keep them unique.
          out.push(...result.facts.map((fact) => ({ ...fact, ref: `${offset}:${fact.ref}` })));
        }
        await agent.moneyFinderUsage(runId, usage, counter.calls, emails.length);
        return out.filter((fact) => fact.kind !== 'none');
      });
      facts.push(...extracted);
    }

    await step.do('finish', async () => { await agent.moneyFinderFinished(runId, facts); return true; });
  }
}
