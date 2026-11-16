// The connectable-service catalogue. Pure — no vault, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONNECTABLE_SERVICES,
  findConnectableService,
  connectionCategoryGroups,
  connectedAnnouncement,
  connectionReturnNotice,
  findConnectionState,
  firstPromptLabel,
  handoffNotice,
  isServiceOffered,
  CONNECTIONS_CUSTODY_NOTE,
} from '../dist/index.js';

test('every service has a vault-safe id and a name the user can read', () => {
  assert.ok(CONNECTABLE_SERVICES.length > 0);
  const seen = new Set();
  for (const service of CONNECTABLE_SERVICES) {
    // The id doubles as the /api/connections path segment, which the worker
    // validates against exactly this pattern.
    assert.match(service.id, /^[a-z0-9_-]{1,64}$/, `bad id: ${service.id}`);
    assert.equal(seen.has(service.id), false, `duplicate id: ${service.id}`);
    seen.add(service.id);
    assert.ok(service.name.length > 0);
    assert.ok(service.blurb.length > 0);
  }
});

// The typed-credential mode is gone. It asked the reader to paste a password
// into a screen we drew, which is the exact habit the brokered hand-off exists
// to break, so the guard is that no entry can quietly reintroduce it.
test('nothing on the screen asks the user to type a credential', () => {
  for (const service of CONNECTABLE_SERVICES) {
    assert.equal(service.mode, 'oauth', `${service.id} has mode ${service.mode}`);
    assert.equal('fields' in service, false, `${service.id} still carries typed fields`);
  }
});

// Setting a connection up by talking to the agent was the other route around the
// broker: it ends with a secret in a chat transcript. Only the phone ever drew
// it, so it was also a way for the browser to disagree about the same service.
test('no service offers a way round the broker', () => {
  for (const service of CONNECTABLE_SERVICES) {
    assert.equal('chatPrompt' in service, false, `${service.id} still carries a chat prompt`);
  }
});

test('an oauth service states what it can do, what it is granted, and the risk', () => {
  // The pre-handoff sheet is the one screen where we are asking for real
  // access to somebody's account. Shipping it with an empty section would
  // mean asking for consent without saying what to.
  for (const service of CONNECTABLE_SERVICES.filter((s) => s.mode === 'oauth')) {
    assert.ok(service.capabilities.length > 0, `${service.id} lists no capabilities`);
    assert.ok(service.permissions.length > 0, `${service.id} lists no permissions`);
    assert.ok(service.safety.length > 0, `${service.id} has no safety statements`);
    for (const statement of service.safety) {
      assert.ok(statement.heading.length > 0);
      assert.ok(statement.body.length > 0);
    }
    // Honesty check: a connected-app sheet that only reassures is a sales
    // pitch. One of the statements has to name the downside.
    const body = service.safety.map((s) => `${s.heading} ${s.body}`).join(' ');
    assert.match(body, /risk|hidden instructions|check with you/i, `${service.id} never names the risk`);
    assert.ok(service.helpUrl, `${service.id} gives the user no way to revoke at the provider`);
  }
});

test('no user-facing connection copy leaks provider internals', () => {
  const banned = /supabase|cloudflare|fly\.io|openrouter|hermes|railway|service-role/i;
  for (const service of CONNECTABLE_SERVICES) {
    const text = [
      service.name,
      service.blurb,
      ...service.capabilities,
      ...service.permissions,
      ...service.safety.flatMap((s) => [s.heading, s.body]),
    ].join(' ');
    assert.equal(banned.test(text), false, `${service.id} leaks an internal name`);
  }
});

test('findConnectableService refuses unknown ids', () => {
  assert.equal(findConnectableService('does-not-exist'), null);
  assert.equal(findConnectableService(''), null);
});

test('the catalogue groups into labelled categories in a fixed order', () => {
  const groups = connectionCategoryGroups();
  assert.ok(groups.length > 0);
  for (const group of groups) {
    assert.ok(group.label.length > 0, `${group.category} has no label`);
    assert.ok(group.services.length > 0, `${group.category} is empty`);
  }
  // Every advertised service reaches a group, or it is invisible in the UI.
  const grouped = groups.flatMap((g) => g.services.map((s) => s.id)).sort();
  assert.deepEqual(grouped, CONNECTABLE_SERVICES.map((s) => s.id).sort());
});

test('the connected announcement names the account and never the token', () => {
  const dropbox = findConnectableService('dropbox');
  const line = connectedAnnouncement(dropbox, 'alex@example.com');
  assert.match(line, /Dropbox/);
  assert.match(line, /alex@example\.com/);
  assert.ok(line.length > 0);
  // Works without a label too: the provider may not return one.
  assert.ok(connectedAnnouncement(dropbox, null).length > 0);
});

// The announcement and the button under it used to be written separately, so
// connecting Slack produced a coworker saying it had connected Slack above a
// button offering to look inside Dropbox. Both now come off the service.
test('the announcement and its button are about the service that was just connected', () => {
  for (const service of CONNECTABLE_SERVICES.filter((s) => s.mode === 'oauth')) {
    const line = connectedAnnouncement(service, null);
    assert.ok(line.includes(service.name), `${service.id} announcement never names it`);
    assert.ok(line.includes(service.firstPrompt), `${service.id} announcement drops its opening move`);
    assert.ok(firstPromptLabel(service).includes(service.name), `${service.id} button never names it`);
    for (const other of CONNECTABLE_SERVICES) {
      if (other.id === service.id || other.mode !== 'oauth') continue;
      // Google Drive and Google Calendar share the word "Google", so compare
      // on the full name only where the names do not nest.
      if (service.name.includes(other.name) || other.name.includes(service.name)) continue;
      assert.equal(line.includes(other.name), false, `${service.id} announcement mentions ${other.id}`);
    }
  }
});

// drive.file reaches files this app created and nothing else, and there is no
// file picker in the product to hand it an existing one. Any copy promising to
// search or read the user's Drive would be a claim the scope cannot back.
test('Google Drive never claims to reach files it did not create', () => {
  const drive = findConnectableService('google_drive');
  const text = [
    drive.blurb,
    drive.connectedSummary,
    ...drive.capabilities,
    ...drive.permissions,
    ...drive.safety.flatMap((s) => [s.heading, s.body]),
  ].join(' ');
  assert.equal(/search (your|the) (google )?drive/i.test(text), false, 'claims whole-Drive search');
  assert.equal(/find (any|a) file/i.test(text), false, 'claims to find an arbitrary file');
  assert.equal(/read (your|all) (existing )?files/i.test(text), false, 'claims to read existing files');
  // And it has to say the limit out loud rather than merely avoid the claim.
  assert.match(text, /only|created/i, 'never states the app-created-files limit');
});

// The granted scopes are channels:read, channels:history, groups:read,
// groups:history, search:read, chat:write and users:read. Private channels are
// deliberately included: most of the conversation worth catching up on lives
// there, and a coworker that silently cannot see them would keep saying it
// could not find a message the user knows exists. search:read is the one that
// reaches further than the channel list suggests, because Slack search covers
// direct messages, so the sheet has to say so rather than let a reader infer
// from "channels" that their DMs are out of reach.
test('Slack says out loud that search reaches direct messages', () => {
  const slack = findConnectableService('slack');
  const text = [
    ...slack.permissions,
    ...slack.safety.flatMap((s) => [s.heading, s.body]),
  ].join(' ');
  assert.match(text, /direct message/i, 'never mentions direct messages');
  // And it must not overclaim the other way: no DM history scope is granted.
  assert.equal(/read (your|all) direct messages\b/i.test(text), false, 'claims to read DM history');
});

// Drive earned the right to say "only the files it made" because drive.file
// exists. Outlook has no equivalent: Microsoft offers no per-folder delegated
// mail permission, so connecting really does hand over the whole mailbox. The
// temptation is to soften that into something like "the emails it needs", which
// would read better and be untrue, so the limit is pinned as a required claim
// rather than merely an avoided one.
test('Outlook says the grant covers the whole mailbox, and that it cannot send', () => {
  const outlook = findConnectableService('microsoft_outlook');
  // Deliberately separate. The safety sheet is the screen shown BEFORE the user
  // is handed to Microsoft, so a limit stated only in connectedSummary is
  // stated only after they have already agreed. An earlier version of this test
  // pooled all the copy together and passed while the sheet said neither thing.
  const sheet = outlook.safety.flatMap((s) => [s.heading, s.body]).join(' ');
  const text = [
    outlook.blurb,
    outlook.connectedSummary,
    ...outlook.capabilities,
    ...outlook.permissions,
    sheet,
  ].join(' ');
  assert.match(sheet, /whole mailbox|any email/i, 'the sheet never states this is the whole mailbox');
  // Mail.Send is deliberately not requested, so the sheet promises this and the
  // promise has to survive anyone widening the scopes later.
  assert.match(sheet, /cannot send/i, 'the sheet never states that it cannot send mail');
  assert.equal(/send (an? )?(email|reply|message) (for|as) you/i.test(text), false, 'claims it can send mail');
  assert.equal(/only the (emails?|messages?) it/i.test(text), false, 'implies a per-folder limit that does not exist');
});

// Chat.Read covers one-to-one and group chats. Channels need
// ChannelMessage.Read.All, which is admin-consent-only, so "your Teams" without
// qualification would promise the half we cannot give an ordinary employee.
test('Teams says chats not channels, and that it cannot post', () => {
  const teams = findConnectableService('microsoft_teams');
  const sheet = teams.safety.flatMap((s) => [s.heading, s.body]).join(' ');
  const text = [
    teams.blurb,
    teams.connectedSummary,
    ...teams.capabilities,
    ...teams.permissions,
    sheet,
  ].join(' ');
  assert.match(sheet, /channel/i, 'the sheet never mentions that channels are excluded');
  assert.match(sheet, /cannot post|cannot say anything as you/i, 'the sheet never states that it cannot post');
  assert.equal(/read (your|all) (team )?channels/i.test(text), false, 'claims to read channels');
  assert.equal(/post|reply|react/i.test(teams.capabilities.join(' ')), false, 'offers a write it cannot do');
});

test('an oauth service says what it can now do and offers an opening move', () => {
  for (const service of CONNECTABLE_SERVICES.filter((s) => s.mode === 'oauth')) {
    assert.ok(service.connectedSummary, `${service.id} has no connected summary`);
    assert.ok(service.firstPrompt, `${service.id} has no first prompt`);
    // The prompt is typed into chat as the user, so it has to read like the
    // user asking rather than like an instruction we wrote for the agent.
    assert.match(service.firstPrompt, /[.?]$/, `${service.id} first prompt is not a sentence`);
  }
});

// Alex reads every one of these lines. An em dash in shipped copy is a
// standing no, so the catalogue is held to it rather than trusted to it.
test('no connection copy uses an em dash', () => {
  for (const service of CONNECTABLE_SERVICES) {
    const text = [
      service.name,
      service.blurb,
      service.connectedSummary ?? '',
      service.firstPrompt ?? '',
      ...service.capabilities,
      ...service.permissions,
      ...service.safety.flatMap((s) => [s.heading, s.body]),
    ].join(' ');
    assert.equal(text.includes('—'), false, `${service.id} uses an em dash`);
  }
});

// A listed provider the broker has no credentials for would hand the reader a
// failure the moment they tapped it. The broker is the only thing that knows,
// so the catalogue is filtered by what it reports rather than by what we shipped.
test('an oauth service is only offered once the broker holds credentials for it', () => {
  const dropbox = findConnectableService('dropbox');
  const slack = findConnectableService('slack');

  assert.equal(isServiceOffered(dropbox, ['dropbox']), true);
  assert.equal(isServiceOffered(slack, ['dropbox']), false);
  assert.equal(isServiceOffered(slack, []), false);
  // Null is "we could not ask", which shows the catalogue as written rather
  // than emptying the screen on a transient failure.
  assert.equal(isServiceOffered(slack, null), true);
});

test('backing out of the provider screen is not reported as a failure', () => {
  const dropbox = findConnectableService('dropbox');
  const declined = connectionReturnNotice(dropbox, 'declined');
  assert.equal(declined.tone, 'info');
  assert.match(declined.message, /nothing was connected/i);

  // Everything else is a real failure, and each one has to leave the reader
  // with a move to make rather than just an apology.
  for (const code of ['invalid_state', 'exchange_failed', 'store_failed', 'something_new']) {
    const notice = connectionReturnNotice(dropbox, code);
    assert.equal(notice.tone, 'danger', code);
    assert.match(notice.message, /again/i, code);
  }
  // A provider we have no card for still gets a sentence, not "undefined".
  assert.match(connectionReturnNotice(null, 'declined').message, /that account/);
});

test('the hand-off line says whose screen comes next', () => {
  const dropbox = findConnectableService('dropbox');
  const notice = handoffNotice(dropbox);
  assert.match(notice, /Dropbox/);
  assert.match(notice, /not to us/);
});

// The note used to promise that a connection went straight to the user's own
// private workspace, which was only ever true of the typed credential. Nothing
// on this screen works that way now, so the wording must not go back.
test('the custody note does not claim a connection lands on the workspace', () => {
  assert.ok(CONNECTIONS_CUSTODY_NOTE.length > 0);
  assert.equal(/workspace/i.test(CONNECTIONS_CUSTODY_NOTE), false);
  assert.match(CONNECTIONS_CUSTODY_NOTE, /encrypted/i);
  assert.match(CONNECTIONS_CUSTODY_NOTE, /chat/i);
});

test('findConnectionState reports disconnected rather than guessing', () => {
  const states = [{ provider: 'dropbox', status: 'needs_reauth', accountLabel: null, connectedAt: null }];
  assert.equal(findConnectionState(states, 'dropbox').status, 'needs_reauth');
  assert.equal(findConnectionState(states, 'slack').status, 'disconnected');
  assert.equal(findConnectionState([], 'dropbox').status, 'disconnected');
});
