import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { withRateLimitRetry } from './openrouter-retry.ts';

/**
 * The model and its routing. Identical to the production Worker's model proxy
 * (MODEL, MODEL_PROVIDER_ORDER and MODEL_PRIVACY_ROUTING in
 * apps/worker/src/index.ts), so a customer gets the same model and the same
 * privacy promise on either engine. test/model.test.ts fails if they drift.
 *
 * GPT-6 Luna since 2026-09-22, on Alex's decision: in apps/agent/eval it scored
 * the same as gpt-5.6-luna on everyday tasks (117/120 each) for 35% less, and
 * 54% less across the 35 apps. It asks before sending less reliably, which Alex
 * accepted. It has no zero-retention route: OpenAI keeps API data up to 30 days
 * for abuse checks and never trains on it, as the privacy policy now says.
 * Amazon Bedrock also serves it but failed the eval's safety checks (sent an
 * email and an invite unasked, wrote twice), so it is never used.
 * data_collection 'deny' stays: Google's Limited Use rule forbids any provider
 * that trains on Gmail data.
 */
export const MODEL = 'openai/gpt-6-luna';
export const PROVIDER_ROUTING = {
  order: ['openai'],
  allow_fallbacks: true,
  ignore: ['amazon-bedrock'],
  data_collection: 'deny' as const,
};
export const REASONING = { effort: 'none' as const, exclude: true };

export function agentModel(apiKey: string, onRetry: (reason: string, attempt: number) => void) {
  const openrouter = createOpenRouter({ apiKey, fetch: withRateLimitRetry(undefined, onRetry) });
  return openrouter.chat(MODEL, {
    usage: { include: true },
    reasoning: REASONING,
    provider: PROVIDER_ROUTING,
  });
}
