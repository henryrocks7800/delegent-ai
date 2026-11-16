import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const appSource = readFileSync(new URL('../../../../../App.tsx', import.meta.url), 'utf8');
const productStateSource = readFileSync(new URL('../../../../../src/state/productState.ts', import.meta.url), 'utf8');
const sharedSource = readFileSync(new URL('../../../../../../../packages/shared/src/index.ts', import.meta.url), 'utf8');

function sensitivePattern() {
  return /source_conversation|source_message|source_event|idempotency|code_hash|runner_base_url|railway_|stripe_customer|stripe_subscription|provider_event|payload_hash|storage_path|BOT_TOKEN|SERVICE_ROLE|WEBHOOK_SECRET|OPENROUTER|CLOUDFLARE|runner_task_id/i;
}

test('the client-safe task and message projections are still declared, and still unused by the snapshot read', () => {
  // 2026-09-13: the snapshot no longer hydrates tasks, messages or artifacts.
  // Nothing rendered them, and a 503 on any of the three rejected an otherwise
  // valid entitlement. The projections and their fail-closed mappers stay, with
  // their tests, so a future consumer starts from a safe shape rather than
  // select(*). See live-product-state.test.mjs for the read itself.
  assert.match(sharedSource, /recentTasks:\s*readonly TaskRun\[\]/);
  assert.match(sharedSource, /latestAssistantMessage:\s*ChatMessage \| null/);
  assert.match(productStateSource, /SAFE_TASK_COLUMNS\s*=\s*['"]id,user_id,status,instruction,message_id,error_code,created_at,updated_at,completed_at['"]/);
  assert.match(productStateSource, /SAFE_MESSAGE_COLUMNS\s*=\s*['"]id,user_id,role,content,created_at,task_id['"]/);
  assert.match(productStateSource, /export function mapPublicTaskRows/);
  assert.match(productStateSource, /export function mapPublicMessageRows/);
  assert.doesNotMatch(productStateSource, sensitivePattern());
});

test('task and message mappers fail closed around malformed or unsafe rows', () => {
  assert.match(productStateSource, /function taskRunStatus\(value: unknown\)/);
  assert.match(productStateSource, /return value === 'dispatched' \|\| value === 'running' \|\| value === 'succeeded' \|\| value === 'failed' \|\| value === 'canceled' \? value : 'queued'/);
  assert.match(productStateSource, /function chatRole\(value: unknown\)/);
  assert.match(productStateSource, /return value === 'assistant' \|\| value === 'system' \? value : 'user'/);
  assert.match(productStateSource, /if \(!id \|\| !userId \|\| !instruction \|\| !createdAt\) return \[\]/);
  assert.match(productStateSource, /if \(!id \|\| !userId \|\| !content \|\| !createdAt\) return \[\]/);
});

test('app resume quietly refreshes workspace and file state even without a checkout return', () => {
  assert.match(appSource, /const refreshWorkspaceAfterResume = useCallback\(async \(\) => \{/);
  assert.match(appSource, /await onProductRetry\(\)/);
  assert.match(appSource, /await refreshRunnerFiles\(\)/);
  assert.match(appSource, /if \(!reopened && !checkoutRefreshPending && !billingPortalRefreshPending\) \{/);
  assert.match(appSource, /void refreshWorkspaceAfterResume\(\)\.then\(\(\) => \{/);
  assert.match(appSource, /void refreshWorkspaceAfterResume\(\)/);
});

test('home screen embeds the chat panel and shows agent status without backend vocabulary', () => {
  // 2026-05-16 v1.2.1 chat-first redesign: HomeChatPanel was the entire
  // home surface. No TaskActivityCard, no HomeSummaryCard, no runner
  // status pill — the user lands inside the conversation.
  //
  // v1.3+: that surface migrated to a WebView mirror of the Hermes Runner
  // (WebViewChatScreen renders apps/mobile/assets/chat-webview/index.html).
  // The home-surface contract is the same — only the host component
  // changed — so this assertion accepts either.
  assert.match(appSource, /HomeChatPanel|WebViewChatScreen/);
  assert.match(appSource, /<(HomeChatPanel|WebViewChatScreen)\b/);
  assert.match(appSource, /conversationId=\{productView\.userId\}/);
  assert.match(appSource, /agentName=\{productView\.agentName\}/);
  assert.match(appSource, /hasActiveSubscription=\{productView\.hasActiveSubscription\}/);
  assert.doesNotMatch(appSource, /runnerStatus=/);
});
