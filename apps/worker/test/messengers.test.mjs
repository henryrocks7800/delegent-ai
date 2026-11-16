import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  handleWhatsAppWebhook,
  handleSignalWebhook,
  parseWhatsAppWebhookPayload,
  parseSignalWebhookPayload,
} from '../dist/messengers.js';

// -----------------------------------------------------------------------------
// WhatsApp
// -----------------------------------------------------------------------------

test('GIVEN WhatsApp webhook disabled WHEN any request arrives THEN respond 501 with safe error', async () => {
  const env = {};
  const get = await handleWhatsAppWebhook(new Request('https://example/webhook', { method: 'GET' }), env);
  const post = await handleWhatsAppWebhook(new Request('https://example/webhook', { method: 'POST' }), env);
  assert.equal(get.status, 501);
  assert.equal(post.status, 501);
});

test('GIVEN WhatsApp webhook enabled WHEN Meta sends the verification handshake with matching token THEN echo the challenge as 200', async () => {
  const env = {
    SIDEKICK_WHATSAPP_WEBHOOK_ENABLED: 'true',
    WHATSAPP_WEBHOOK_VERIFY_TOKEN: 'expected-secret',
  };
  const url = 'https://example/webhook?hub.mode=subscribe&hub.challenge=abc123&hub.verify_token=expected-secret';
  const response = await handleWhatsAppWebhook(new Request(url, { method: 'GET' }), env);
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.equal(body, 'abc123');
});

test('GIVEN WhatsApp webhook enabled WHEN Meta sends a verification handshake with a wrong token THEN respond 403', async () => {
  const env = {
    SIDEKICK_WHATSAPP_WEBHOOK_ENABLED: 'true',
    WHATSAPP_WEBHOOK_VERIFY_TOKEN: 'expected-secret',
  };
  const url = 'https://example/webhook?hub.mode=subscribe&hub.challenge=abc123&hub.verify_token=wrong';
  const response = await handleWhatsAppWebhook(new Request(url, { method: 'GET' }), env);
  assert.equal(response.status, 403);
});

test('GIVEN an inbound WhatsApp text message WHEN parsed THEN normalize sender, body, WAMID, and phone-number id', () => {
  const sample = {
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: '999111222' },
              contacts: [{ profile: { name: 'Alex' }, wa_id: '447801283442' }],
              messages: [
                {
                  id: 'wamid.ABC',
                  from: '447801283442',
                  timestamp: '1715844000',
                  type: 'text',
                  text: { body: 'hello agent' },
                },
              ],
            },
          },
        ],
      },
    ],
  };
  const parsed = parseWhatsAppWebhookPayload(sample);
  assert.deepEqual(parsed, {
    text: 'hello agent',
    fromPhone: '+447801283442',
    toPhoneNumberId: '999111222',
    wamid: 'wamid.ABC',
    fromName: 'Alex',
    timestamp: 1715844000,
  });
});

test('GIVEN a WhatsApp status update (read receipt) WHEN parsed THEN it is ignored (returns null) so we 200 the webhook quickly', () => {
  const sample = {
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: { statuses: [{ id: 'wamid.X', status: 'delivered' }] },
          },
        ],
      },
    ],
  };
  assert.equal(parseWhatsAppWebhookPayload(sample), null);
});

test('GIVEN WhatsApp webhook enabled AND an inbound text WHEN POSTed THEN reply 202 pending_binding so Meta does not disable the subscription', async () => {
  const env = { SIDEKICK_WHATSAPP_WEBHOOK_ENABLED: 'true' };
  const body = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: 'PNID' },
              contacts: [{ profile: { name: 'Alex' }, wa_id: '447801283442' }],
              messages: [
                {
                  id: 'wamid.001',
                  from: '447801283442',
                  timestamp: '1715844000',
                  type: 'text',
                  text: { body: 'hi' },
                },
              ],
            },
          },
        ],
      },
    ],
  });
  const response = await handleWhatsAppWebhook(
    new Request('https://example/webhook', { method: 'POST', body, headers: { 'content-type': 'application/json' } }),
    env,
  );
  assert.equal(response.status, 202);
  const payload = await response.json();
  assert.equal(payload.gatewayId, 'whatsapp');
  assert.equal(payload.kind, 'pending_binding');
});

// -----------------------------------------------------------------------------
// Signal
// -----------------------------------------------------------------------------

test('GIVEN Signal webhook disabled WHEN POSTed THEN respond 501', async () => {
  const response = await handleSignalWebhook(new Request('https://example/signal', { method: 'POST' }), {});
  assert.equal(response.status, 501);
});

test('GIVEN Signal enabled but no bearer configured WHEN POSTed THEN respond 503', async () => {
  const env = { SIDEKICK_SIGNAL_WEBHOOK_ENABLED: 'true' };
  const response = await handleSignalWebhook(new Request('https://example/signal', { method: 'POST' }), env);
  assert.equal(response.status, 503);
});

test('GIVEN Signal bearer required AND wrong bearer supplied WHEN POSTed THEN respond 403', async () => {
  const env = { SIDEKICK_SIGNAL_WEBHOOK_ENABLED: 'true', SIGNAL_REST_API_BEARER: 'expected-bearer' };
  const response = await handleSignalWebhook(
    new Request('https://example/signal', { method: 'POST', headers: { authorization: 'Bearer wrong' }, body: '{}' }),
    env,
  );
  assert.equal(response.status, 403);
});

test('GIVEN a Signal data message WHEN parsed THEN normalize sender, account, body, and timestamp', () => {
  const sample = {
    account: '+447000000000',
    envelope: {
      source: '+447801283442',
      sourceNumber: '+447801283442',
      timestamp: 1715844000123,
      dataMessage: { message: 'hello agent' },
    },
  };
  assert.deepEqual(parseSignalWebhookPayload(sample), {
    text: 'hello agent',
    fromPhone: '+447801283442',
    toAccount: '+447000000000',
    timestamp: 1715844000123,
  });
});

test('GIVEN Signal webhook enabled AND valid bearer AND inbound text WHEN POSTed THEN reply 202 pending_binding', async () => {
  const env = { SIDEKICK_SIGNAL_WEBHOOK_ENABLED: 'true', SIGNAL_REST_API_BEARER: 'expected-bearer' };
  const body = JSON.stringify({
    account: '+447000000000',
    envelope: {
      source: '+447801283442',
      sourceNumber: '+447801283442',
      timestamp: 1715844000123,
      dataMessage: { message: 'hi' },
    },
  });
  const response = await handleSignalWebhook(
    new Request('https://example/signal', {
      method: 'POST',
      headers: { authorization: 'Bearer expected-bearer', 'content-type': 'application/json' },
      body,
    }),
    env,
  );
  assert.equal(response.status, 202);
  const payload = await response.json();
  assert.equal(payload.gatewayId, 'signal');
  assert.equal(payload.kind, 'pending_binding');
});
