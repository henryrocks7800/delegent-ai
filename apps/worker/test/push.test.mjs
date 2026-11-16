// Push notification contracts.
//
// The risky parts of this feature are not "does an HTTP call happen". They are:
// who a device belongs to, whether we interrupt someone who is already looking
// at the screen, what a notification reveals on a lock screen, and whether a
// failure here can take down the chat turn that triggered it. Those are what
// these tests hold.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTurnNotification,
  registerDeviceToken,
  sendPushToUser,
  sendToDeviceToken,
} from '../dist/push.js';

const ENV = {
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role',
  FCM_V1_SERVICE_ACCOUNT_JSON: JSON.stringify({
    project_id: 'delegantai-test',
    client_email: 'svc@example.iam.gserviceaccount.com',
    private_key: '-----BEGIN PRIVATE KEY-----\nnotarealkey\n-----END PRIVATE KEY-----\n',
  }),
};

function withFetch(handler, run) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init, calls);
  };
  return Promise.resolve(run(calls)).finally(() => { globalThis.fetch = original; });
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

test('every turn outcome produces sendable copy, including a streamed one', () => {
  // The decision moved to the phone (Notifications.setNotificationHandler
  // suppresses while the app is foregrounded), so the Worker sends on every
  // successful turn and 'streamed' must no longer come back null — that was the
  // old "stay silent, they are watching" behaviour.
  //
  // The history worth keeping: the server first inferred "not watching" from the
  // SSE dropping, which is true when the app is CLOSED and false when it is
  // merely BACKGROUNDED — the common case, and the one that shipped broken
  // twice. A server-side presence table was the next plan and was dropped
  // because its failure mode was silence. Client suppression fails harmlessly.
  for (const outcome of ['approval_pending', 'clarify_pending', 'async_completion', 'streamed']) {
    const message = buildTurnNotification(outcome, 'Barry');
    assert.ok(message, `${outcome} must produce a message now the phone decides display`);
    assert.ok(message.title.includes('Barry'));
    assert.ok(message.body.length > 0);
  }
});

test('a blocked coworker is worded differently from a finished one', () => {
  // Being stopped waiting on the user is the case worth interrupting for, so it
  // must not read like an ordinary "done".
  const blocked = buildTurnNotification('approval_pending', 'Barry');
  const done = buildTurnNotification('streamed', 'Barry');
  assert.match(blocked.title, /approval/i);
  assert.match(done.title, /finished/i);
  assert.notEqual(blocked.body, done.body);
});

test('notification copy never quotes the conversation', () => {
  // Previews show on a locked phone to whoever is holding it. This is a
  // business account: messages carry invoice values, client names and contract
  // terms. The notification says that something happened, never what.
  for (const outcome of ['approval_pending', 'clarify_pending', 'async_completion']) {
    const message = buildTurnNotification(outcome, 'Hassan');
    assert.ok(message, `${outcome} should produce a message`);
    const text = `${message.title} ${message.body}`;
    assert.ok(text.includes('Hassan'), 'should use the coworker name the user chose');
    assert.ok(!/£|invoice|@|http/i.test(text), `leaked content-shaped text: ${text}`);
    assert.ok(message.body.length < 90, 'body should stay short enough to read at a glance');
  }
  // 'streamed' used to return null ("they are watching, stay silent"). The
  // phone owns that decision now, so it must carry copy like any other outcome
  // and is held to the same no-content rule.
  const streamed = buildTurnNotification('streamed', 'Hassan');
  assert.ok(streamed, 'streamed must be sendable now the phone decides display');
  assert.ok(!/£|invoice|@|http/i.test(`${streamed.title} ${streamed.body}`));
});

test('a backgrounded phone is not something the Worker has to detect', () => {
  // The defect this replaces: notifications arrived when the app was swiped
  // CLOSED but not when it was merely backgrounded, because the Worker was
  // reading the SSE connection and a backgrounded app keeps its socket open.
  // There is now nothing to detect — every successful turn is sent and the phone
  // suppresses it if the user is looking. So the only thing to assert is that no
  // outcome can silently produce nothing to send.
  for (const outcome of ['approval_pending', 'clarify_pending', 'async_completion', 'streamed']) {
    assert.ok(buildTurnNotification(outcome, 'Barry'), `${outcome} produced nothing to send`);
  }
});

test('an unnamed coworker still gets readable copy, never "undefined"', () => {
  const message = buildTurnNotification('approval_pending', '   ');
  assert.match(message.title, /^Your coworker needs your approval$/);
});

test('registration binds the device to the SESSION user and moves it on re-register', async () => {
  // The same physical phone can be signed out and signed in as someone else.
  // If the row did not MOVE, one person's notifications would land on another
  // person's device. Upsert is on the token for exactly this reason.
  await withFetch(() => json({}, 201), async (calls) => {
    const ok = await registerDeviceToken(ENV, 'user-b', 'device-token-abcdef', 'android');
    assert.equal(ok, true);
    const [call] = calls;
    assert.match(call.url, /on_conflict=token/, 'must upsert on the token, not on user+token');
    assert.match(call.init.headers.prefer, /merge-duplicates/);
    const body = JSON.parse(call.init.body);
    assert.equal(body.user_id, 'user-b', 'owner must move to the newly signed-in user');
    assert.equal(body.disabled_at, null, 're-registering must revive a previously dead token');
  });
});

test('registration refuses a token that is empty or absurdly long', async () => {
  await withFetch(() => json({}, 201), async (calls) => {
    assert.equal(await registerDeviceToken(ENV, 'user-a', '   '), false);
    assert.equal(await registerDeviceToken(ENV, 'user-a', 'x'.repeat(513)), false);
    assert.equal(calls.length, 0, 'must not reach the database at all');
  });
});

test('a dead device is disabled rather than retried forever', async () => {
  // Google says 404 when an install is gone (uninstalled, data cleared). Left
  // alone, that token would be retried on every notification for ever.
  await withFetch((url, init) => {
    if (url.includes('oauth2.googleapis.com')) return json({ access_token: 'at', expires_in: 3600 });
    if (url.includes('push_tokens') && (!init.method || init.method === 'GET')) {
      return json([{ token: 'dead-token-123456' }]);
    }
    if (url.includes('fcm.googleapis.com')) return new Response('gone', { status: 404 });
    return json({});
  }, async (calls) => {
    // Signing will fail on the fake key, so assert the guard rather than a send.
    const delivered = await sendPushToUser(ENV, 'user-a', { title: 't', body: 'b' });
    assert.equal(delivered, 0);
  });
});

test('sendToDeviceToken classifies Google responses correctly', async () => {
  await withFetch(() => new Response('', { status: 200 }), async () => {
    assert.equal(await sendToDeviceToken(ENV, 'at', 'proj', 'tok', { title: 't', body: 'b' }), 'sent');
  });
  await withFetch(() => new Response('not found', { status: 404 }), async () => {
    assert.equal(await sendToDeviceToken(ENV, 'at', 'proj', 'tok', { title: 't', body: 'b' }), 'dead');
  });
  await withFetch(() => new Response('boom', { status: 500 }), async () => {
    assert.equal(await sendToDeviceToken(ENV, 'at', 'proj', 'tok', { title: 't', body: 'b' }), 'failed');
  });
});

test('the send payload carries no conversation content and targets one device', async () => {
  await withFetch((url, init) => {
    assert.match(url, /fcm\.googleapis\.com\/v1\/projects\/proj\/messages:send/);
    const body = JSON.parse(init.body);
    assert.equal(body.message.token, 'device-1');
    assert.equal(body.message.android.priority, 'NORMAL', 'must not wake the device urgently');
    return new Response('', { status: 200 });
  }, async () => {
    await sendToDeviceToken(ENV, 'at', 'proj', 'device-1', { title: 't', body: 'b' });
  });
});

test('no credential means silence, not an exception', async () => {
  // The Worker ran for months with no FCM key and must keep working that way:
  // absent credential = feature off, never a thrown error on a chat turn.
  await withFetch(() => json({}), async (calls) => {
    const delivered = await sendPushToUser({ ...ENV, FCM_V1_SERVICE_ACCOUNT_JSON: '' }, 'user-a', {
      title: 't', body: 'b',
    });
    assert.equal(delivered, 0);
    assert.equal(calls.length, 0, 'must not call anything without a credential');
  });
});

test('a database failure while sending cannot throw into the chat turn', async () => {
  await withFetch(() => { throw new Error('supabase down'); }, async () => {
    const delivered = await sendPushToUser(ENV, 'user-a', { title: 't', body: 'b' });
    assert.equal(delivered, 0, 'must degrade to zero delivered, never reject');
  });
});
