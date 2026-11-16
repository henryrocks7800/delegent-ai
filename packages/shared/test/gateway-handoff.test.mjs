import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractGatewayConnectCode,
  resolveTelegramWebhookHandoff,
} from '../dist/index.js';

const telegramUpdate = {
  update_id: 1001,
  message: {
    message_id: 77,
    date: 1777981500,
    chat: { id: 8538156772, type: 'private' },
    from: { id: 12345, first_name: 'Alex', username: 'alex_test' },
    text: ' Please chase this supplier quote and tell me the cheapest sensible option. ',
  },
};

test('Telegram private text resolves to a stable task handoff without provider secrets', () => {
  const handoff = resolveTelegramWebhookHandoff({
    update: telegramUpdate,
    linkedUserId: 'user_123',
    now: '2026-05-05T13:30:00.000Z',
  });

  assert.equal(handoff.kind, 'task_handoff');
  assert.equal(handoff.gatewayId, 'telegram');
  assert.equal(handoff.userId, 'user_123');
  assert.equal(handoff.instruction, 'Please chase this supplier quote and tell me the cheapest sensible option.');
  assert.equal(handoff.sourceEventId, 'telegram:update:1001');
  assert.equal(handoff.sourceConversationId, 'telegram:chat:8538156772');
  assert.equal(handoff.sourceMessageId, 'telegram:message:77');
  assert.equal(handoff.idempotencyKey, 'telegram:1001:77');
  assert.equal(handoff.requesterDisplayName, 'Alex');
  assert.equal(handoff.publicReply, "Got it. I'm on it.");
  assert.doesNotMatch(JSON.stringify(handoff), /supabase|oauth|railway|cloudflare|openrouter|hermes|service-role|api key|secret|container|runtime|\bworker\b|bot token/i);
});

test('Telegram connect codes are recognized from bare codes and start commands', () => {
  assert.equal(extractGatewayConnectCode('tg-7kq9z2'), 'TG7KQ9Z2');
  assert.equal(extractGatewayConnectCode(' tg 7kq 9z2 '), 'TG7KQ9Z2');
  assert.equal(extractGatewayConnectCode('/start TG7KQ9Z2'), 'TG7KQ9Z2');
  assert.equal(extractGatewayConnectCode('/start tg 7kq 9z2'), 'TG7KQ9Z2');
  assert.equal(extractGatewayConnectCode('/start not-a-code'), null);
  assert.equal(extractGatewayConnectCode('/start TG7KQ9Z2 please connect'), null);

  const handoff = resolveTelegramWebhookHandoff({
    update: {
      update_id: 1002,
      message: {
        message_id: 78,
        chat: { id: 8538156772, type: 'private' },
        from: { id: 12345, first_name: 'Alex' },
        text: '/start TG7KQ9Z2',
      },
    },
    linkedUserId: null,
    now: '2026-05-05T13:30:00.000Z',
  });

  assert.equal(handoff.kind, 'connect_code');
  assert.equal(handoff.code, 'TG7KQ9Z2');
  assert.equal(handoff.idempotencyKey, 'telegram:1002:78:connect');
  assert.equal(handoff.publicReply, 'Almost connected. Finish the link in the Delegent AI app.');
});

test('Telegram messages fail closed when unlinked, empty, group, or oversized', () => {
  const unlinked = resolveTelegramWebhookHandoff({ update: telegramUpdate, linkedUserId: null, now: '2026-05-05T13:30:00.000Z' });
  assert.equal(unlinked.kind, 'needs_connection');
  assert.equal(unlinked.publicReply, 'Connect Telegram in the Delegent AI app first, then resend this task.');

  const empty = resolveTelegramWebhookHandoff({
    update: { update_id: 1003, message: { message_id: 79, chat: { id: 1, type: 'private' }, text: '   ' } },
    linkedUserId: 'user_123',
  });
  assert.deepEqual({ kind: empty.kind, reason: empty.reason }, { kind: 'ignored', reason: 'empty_text' });

  const group = resolveTelegramWebhookHandoff({
    update: { update_id: 1004, message: { message_id: 80, chat: { id: -1, type: 'group' }, text: 'Do this' } },
    linkedUserId: 'user_123',
  });
  assert.deepEqual({ kind: group.kind, reason: group.reason }, { kind: 'ignored', reason: 'unsupported_chat' });

  const oversized = resolveTelegramWebhookHandoff({
    update: { update_id: 1005, message: { message_id: 81, chat: { id: 1, type: 'private' }, text: 'x'.repeat(4_001) } },
    linkedUserId: 'user_123',
    maxInstructionChars: 4_000,
  });
  assert.deepEqual({ kind: oversized.kind, reason: oversized.reason }, { kind: 'ignored', reason: 'too_long' });
});
