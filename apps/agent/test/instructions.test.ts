import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// agent.ts imports the Workers runtime, so its instructions are read as source.
const agent = readFileSync(new URL('../src/agent.ts', import.meta.url), 'utf8');
const style = agent.match(/^Style: .+$/m)?.[0] ?? '';
const chatHtml = readFileSync(new URL('../../mobile/assets/chat-webview/index.html', import.meta.url), 'utf8');

test('replies never use tables, because the chat cannot draw them', () => {
  // The chat's markdown renderer (md() in the chat document) has no table rule,
  // so a markdown table arrives as rows of pipes. Seen on 2026-09-15 in a
  // robot-vacuum comparison. If the renderer learns tables, this can go.
  const renderer = chatHtml.slice(chatHtml.indexOf('function md(text)'), chatHtml.indexOf('// History'));
  assert.ok(renderer.length > 0, 'md() found in the chat document');
  assert.doesNotMatch(renderer, /<table/);
  assert.match(style, /Never use tables in the chat/);
  assert.doesNotMatch(style, /Use a small table/);
  assert.match(style, /give each one its own bullet/);
  // Alex reads every reply, and his rule is no em dashes (forensic R-STYLE-08 found them, 2026-09-15).
  assert.match(style, /Never use em dashes/);
});

test('travel and live-fact rules that made the Connections "Try it" prompts work', () => {
  // Measured 2026-09-15 against COMPOSIO_SEARCH_FLIGHTS: a city name in `query`
  // fails ("Could not determine arrival airport") and LON finds nothing, while
  // LHR to EDI returns full results.
  assert.match(agent, /- Flights: call COMPOSIO_SEARCH_FLIGHTS with departure_id and arrival_id as specific 3-letter airport codes/);
  assert.match(agent, /Do not use the query field, and never a city code such as LON/);
  // The weather tool has current conditions only, so a forecast question was refused.
  assert.match(agent, /- Weather: WEATHERMAP_WEATHER only has current conditions\. For a forecast, search the web/);
  // A VAT threshold question was answered from memory with no source.
  assert.match(agent, /- Facts that change \(prices, rates, thresholds, rules, opening hours, news\): search the web and link the source/);
});

test('an instructions change reaches accounts whose prompt is already frozen', () => {
  // Think keeps the first rendered system prompt across deploys, so without this
  // an existing account never saw a fix to instructions().
  assert.match(agent, /private async refreshPromptIfInstructionsChanged\(\) \{[\s\S]*?instructions\(this\.agentName\(\)\)[\s\S]*?if \(this\.meta\('instructions_fingerprint'\) === fingerprint\) return;\s*\n\s*await this\.context\.refreshSystemPrompt\(\);\s*\n\s*this\.setMeta\('instructions_fingerprint', fingerprint\);/);
  const setName = agent.slice(agent.indexOf('private async setAgentName('), agent.indexOf('private async refreshPromptIfInstructionsChanged('));
  assert.match(setName, /await this\.refreshPromptIfInstructionsChanged\(\);/);
  // Both ways into a reply, warming and starting a run, pass through it.
  assert.equal((agent.match(/await this\.setAgentName\((agentName|input\.agentName)\);/g) ?? []).length, 2);
});

test('an existing file can be attached after the user says yes', () => {
  // create_pdf could only stage an attachment at the moment it made the file, so
  // "make it", "email it", "yes" failed with an expired attachment (2026-09-15).
  assert.match(agent, /attach_file: tool\(\{/);
  assert.match(agent, /const id = this\.findFileId\(file\);/);
  assert.match(agent, /An attachment object only works straight away, so never reuse one from an earlier reply/);
  assert.match(agent, /result: Record<string, unknown> = \{ ok: true, fileId: stored\.file\.id,/, 'create_pdf hands back the id to attach later');
});

test('the engine is told the name and id of each file the user attaches', () => {
  // Without this the model saw the photo but had no id to pass attach_file, and
  // guessed "attached photo" (local repro of Alex's photo, 2026-09-15).
  assert.match(agent, /attached\.push\(`\$\{file\.name\} \(\$\{attachment\.id\}\)`\);/);
  assert.match(agent, /parts: \[\.\.\.fileParts, \.\.\.attachedNote, \.\.\.tooLargeNote, \.\.\.\(text \?/);
  assert.match(agent, /if \(wanted\.toLowerCase\(\) === 'latest'\) \{/);
});

test('it checks an app before saying it is not connected, and calls itself an assistant', () => {
  // Alex asked about Facebook with his Page connected (2026-09-15). Twice it said
  // it could not see Facebook and told him to connect it, and only found the
  // Page when he asked a third time.
  // Since 2026-09-23 it is told which apps are connected each turn; without that
  // line it still checks before saying an app is not connected.
  assert.match(agent, /If there is no line saying which apps are connected, check before saying an app is not connected: search its tools and try a read action\./);
  assert.match(agent, /If a tool says there is no active connection, believe it and do not retry/);
  // The product is "your connected AI coworker" (Alex, 2026-09-16), not an assistant.
  assert.match(agent, /You are the user's connected AI coworker in the Delegent AI app/);
  assert.doesNotMatch(agent.slice(agent.indexOf('export function instructions('), agent.indexOf('type LiveRun')), /AI assistant/);
});

test("it knows the product's apps and which the user has connected (live QA, 2026-09-23)", () => {
  // "Can you build me a website?" got "no" with Webflow and Shopify on offer, a
  // vague money question went to Gmail with Stripe connected, and Composio's
  // "call COMPOSIO_MANAGE_CONNECTIONS" (a tool we switch off) went unanswered.
  assert.match(agent, /These are the apps you can work in once they are connected, and no others:\n\$\{appCatalogueText\(\)\}/);
  assert.match(agent, /that you will carry on as soon as they say it is done/);
  assert.match(agent, /COMPOSIO_MANAGE_CONNECTIONS: that tool does not exist here/);
  assert.match(agent, /const apps = await this\.connectedApps\(\);/);
  assert.ok(agent.includes("${apps ? `\\n\\n${apps}` : ''}"), 'the apps line joins the turn instructions');
  assert.match(agent, /const apps = this\.connectedApps\(true\);/, 'warm fetches a fresh list while the person types');
});

test('calendar reads use the primary calendar, not tools the grant cannot run (live QA, 2026-09-23)', () => {
  assert.match(agent, /Read events with GOOGLECALENDAR_EVENTS_LIST on calendarId "primary"/);
  assert.match(agent, /Never use GOOGLECALENDAR_FIND_FREE_SLOTS, GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS/);
});

test('a reply always ends with words, even when every step went on tools (live QA, 2026-09-23)', () => {
  assert.match(agent, /maxSteps = 10;/);
  assert.match(agent, /const last = typeof ctx\.stepNumber === 'number' && ctx\.stepNumber >= this\.maxSteps - 1;\n\s*if \(last\) return \{ \.\.\.\(messages \? \{ messages \} : \{\}\), toolChoice: 'none' \} as StepConfig;/);
  assert.match(agent, /Never end a reply without writing to the user\./);
});

test('it can make plain files, saves them to the right field, and cannot pay for things', () => {
  assert.match(agent, /create_file: tool\(\{/);
  assert.match(agent, /You cannot make payments, pay bills, move money or buy things\./);
  assert.match(agent, /Never use an upload-from-URL action with one of our download links/);
});
