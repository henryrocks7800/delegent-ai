import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  RunEventEncoder,
  conversationExchanges,
  displayTool,
  friendlyEngineError,
  sseFrame,
  stripWorkspaceNote,
  toolResultSummary,
} from '../src/events.ts';

// The chat screen's own headline function, loaded from the real chat HTML, so a
// tool name that reads badly on the phone fails here rather than in Alex's hand.
const chatHtml = readFileSync(new URL('../../mobile/assets/chat-webview/index.html', import.meta.url), 'utf8');
const headlineSource = chatHtml.slice(
  chatHtml.indexOf('const FRIENDLY_CMD_MAP'),
  chatHtml.indexOf('function friendlyVoiceError'),
);
const friendlyToolHeadline = new Function(`${headlineSource}; return friendlyToolHeadline;`)() as (tool: string, summary: string) => string;
/** What the chat screen shows: an empty summary becomes "Working…" there. */
const headline = (card: { tool: string; summary: string }) => friendlyToolHeadline(card.tool, card.summary || 'Working…');

test('app tools read as plain English on the chat screen', () => {
  assert.equal(headline(displayTool('tool_ab12_GMAIL_FETCH_EMAILS', {})), 'Working on email');
  assert.equal(headline(displayTool('GOOGLECALENDAR_EVENTS_LIST', {})), 'Checking the calendar');
  assert.equal(headline(displayTool('DROPBOX_READ_FILE', { path: '/Invoices/march.pdf' })), 'Reading march.pdf');
  assert.equal(headline(displayTool('COMPOSIO_SEARCH_WEB', { query: 'VAT threshold 2026' })), 'Searching the web for "VAT threshold 2026"');
  assert.equal(headline(displayTool('COMPOSIO_SEARCH_WEB', {})), 'Searching the web');
  assert.equal(headline(displayTool('create_pdf', { filename: 'invoice-001.pdf' })), 'Working on invoice-001.pdf');
  assert.equal(headline(displayTool('create_pdf', {})), 'Working on a document');
  assert.equal(headline(displayTool('attach_file', { file: 'invoice-001.pdf', attach_to: 'GMAIL_SEND_EMAIL' })), 'Working on invoice-001.pdf');
  assert.equal(headline(displayTool('attach_file', { file: `file_${'a'.repeat(32)}`, attach_to: 'GMAIL_SEND_EMAIL' })), 'Working on the attachment');
  assert.equal(headline(displayTool('set_context', {})), 'Checking my notes');
  for (const name of ['sort_inbox', 'inbox_sort_status', 'approve_inbox_sort', 'cancel_inbox_sort']) {
    assert.equal(headline(displayTool(name, { jobId: 'private-id' })), 'Working on email');
  }
  assert.equal(headline(displayTool('COMPOSIO_SEARCH_TOOLS', {})), 'Planning the next step');
});

test('travel and everyday tools have their own headlines, never "Working on Working…"', () => {
  assert.equal(headline(displayTool('COMPOSIO_SEARCH_FLIGHTS', { departure_id: 'LHR', arrival_id: 'EDI' })), 'Searching flights: LHR to EDI');
  assert.equal(headline(displayTool('COMPOSIO_SEARCH_FLIGHTS', {})), 'Searching flights');
  assert.equal(headline(displayTool('TRIVAGO_MCP_TRIVAGO_ACCOMMODATION_SEARCH', { query: 'Manchester' })), 'Looking for hotels: Manchester');
  assert.equal(headline(displayTool('COMPOSIO_SEARCH_HOTELS', { q: 'Bath' })), 'Looking for hotels: Bath');
  assert.equal(headline(displayTool('VIATOR_MCP_SEARCH_EXPERIENCES', { searchTerm: 'food tour in Edinburgh' })), 'Finding things to do: food tour in Edinburgh');
  assert.equal(headline(displayTool('COMPOSIO_SEARCH_SHOPPING', { query: 'office chair' })), 'Comparing prices: office chair');
  assert.equal(headline(displayTool('COMPOSIO_SEARCH_GOOGLE_MAPS', { q: 'plumbers near Leeds' })), 'Looking up places: plumbers near Leeds');
  assert.equal(headline(displayTool('COMPOSIO_SEARCH_NEWS', {})), 'Checking the news');
  assert.equal(headline(displayTool('WEATHERMAP_WEATHER', { location: 'London' })), 'Checking the weather: London');
  for (const name of ['COMPOSIO_SEARCH_FLIGHTS', 'TRIVAGO_MCP_TRIVAGO_DESTINATION_PRICE_TRENDS', 'VIATOR_MCP_GET_EXPERIENCE_DETAILS', 'COMPOSIO_SEARCH_WALMART']) {
    assert.doesNotMatch(headline(displayTool(name, {})), /Working…|Working on Working/);
  }
});

test('the action run through Composio names the card, not the wrapper', () => {
  const card = displayTool('COMPOSIO_MULTI_EXECUTE_TOOL', { tools: [{ tool_slug: 'OUTLOOK_SEND_EMAIL', arguments: {} }] });
  assert.equal(card.tool, 'email');
  assert.equal(displayTool('COMPOSIO_MULTI_EXECUTE_TOOL', {}).tool, 'app');
});

test('a reply streams as the run events the Worker relays', () => {
  const encoder = new RunEventEncoder('0b0e6b3c-5ad4-4e8a-9e0e-3c0e2a1b7c11');
  const events = [
    encoder.started(),
    ...encoder.chunk(JSON.stringify({ type: 'text-delta', delta: 'Checking ' })),
    ...encoder.chunk(JSON.stringify({ type: 'tool-input-available', toolCallId: 'c1', toolName: 'tool_x_GMAIL_FETCH_EMAILS', input: {} })),
    ...encoder.chunk(JSON.stringify({ type: 'tool-output-available', toolCallId: 'c1', output: { successful: true } })),
    ...encoder.chunk(JSON.stringify({ type: 'text-delta', delta: 'your inbox.' })),
    ...encoder.chunk('not json'),
  ];
  const usage = { steps: 2, inputTokens: 1200, outputTokens: 40, cachedTokens: 900, costUsd: 0.0006, toolCalls: 1 };
  events.push(encoder.finish('completed', usage));
  assert.deepEqual(events.map((e) => e.type), ['run.started', 'assistant.text.delta', 'tool.started', 'tool.completed', 'assistant.text.delta', 'run.completed']);
  assert.deepEqual(events.map((e) => e.sequence), [1, 2, 3, 4, 5, 6]);
  assert.equal(events[3].payload?.summary, 'Done');
  assert.equal(events[3].payload?.output, null, 'tool output never reaches the app');
  assert.deepEqual(events[5].payload, { finalText: 'Checking your inbox.', usage });
  assert.deepEqual(encoder.cards, [{ tool: 'email', summary: '' }]);
  assert.match(sseFrame(events[1]), /^data: \{"type":"assistant\.text\.delta".*\}\n\n$/);
  assert.equal(sseFrame('[DONE]'), 'data: [DONE]\n\n');
});

test('a failed reply ends in run.failed with a plain message, never provider detail', () => {
  const encoder = new RunEventEncoder('0b0e6b3c-5ad4-4e8a-9e0e-3c0e2a1b7c11');
  encoder.chunk(JSON.stringify({ type: 'error', errorText: 'Provider returned 429: rate-limited upstream (azure/eu)' }));
  const end = encoder.finish('completed');
  assert.equal(end.type, 'run.failed');
  assert.equal(end.payload?.errorCode, 'agent_error');
  assert.match(end.payload?.message as string, /^Your coworker is very busy for a moment\. Please send that again\./);
  // The payload only: the event's timestamp is the clock, and one run in a
  // thousand lands on a millisecond of .429 (CI, 29 Sep, 08:06:32.429Z).
  assert.doesNotMatch(JSON.stringify(end.payload), /azure|429|Provider/);
  assert.match(friendlyEngineError('socket hang up'), /^That reply did not finish\. Please send it again\./);
  // Every generic failure offers the way out of a conversation that is itself
  // broken, which is the one thing a stuck person cannot guess (2026-09-16).
  for (const raw of ['socket hang up', 'rate limited', null]) {
    assert.match(friendlyEngineError(raw), /open the menu and tap Start a fresh chat/);
  }
  assert.equal(new RunEventEncoder('r').finish('cancelled').type, 'run.cancelled');
});

test('tool results are summarised, never passed through', () => {
  assert.equal(toolResultSummary({ successful: true, data: { secret: 'x' } }), 'Done');
  assert.equal(toolResultSummary('{"successful": false, "error": "No active connection for gmail"}'), 'Could not complete this step');
  assert.equal(toolResultSummary(undefined, 'Provider exception: private-id secret-value'), 'Could not complete this step');
  assert.equal(toolResultSummary({ ok: false, error: 'inbox_preview_unavailable' }), 'Could not complete this step');
});

test('the old engine\'s workspace note is removed from attached-file messages', () => {
  const sent = '[The user attached 2 files to your workspace: invoice.pdf, receipt.jpg. Open them from the uploads folder.]\n\nWhat do I owe?';
  assert.equal(stripWorkspaceNote(sent), 'What do I owe?');
  assert.equal(stripWorkspaceNote('Plain message'), 'Plain message');
});

test('a finished conversation becomes searchable exchanges, with attachment names', () => {
  const exchanges = conversationExchanges(
    [
      { id: '1', role: 'user', parts: [{ type: 'file', filename: 'quote-17.pdf' }, { type: 'text', text: 'Is this quote fair?' }] },
      { id: '2', role: 'assistant', parts: [{ type: 'text', text: 'It is £420, about average.' }] },
      { id: '3', role: 'user', parts: [{ type: 'text', text: 'Remind me the plumber is Dave.' }] },
      { id: '4', role: 'assistant', parts: [{ type: 'tool-set_context' }, { type: 'text', text: 'Noted.' }] },
    ],
    '2026-09-15T13:05:00.000Z',
  );
  assert.deepEqual(exchanges, [
    '2026-09-15 13:05 User: Is this quote fair? (attached: quote-17.pdf)\n2026-09-15 13:05 Coworker: It is £420, about average.',
    '2026-09-15 13:05 User: Remind me the plumber is Dave.\n2026-09-15 13:05 Coworker: Noted.',
  ]);
});

test('a late replay carries the stored cards, then the text and the outcome, in order', () => {
  const events = new RunEventEncoder('run-1').replay({
    status: 'succeeded',
    finalText: 'Here are three flights.',
    toolCalls: [{ tool: 'flights', summary: 'LHR to EDI' }],
    usage: null,
  });
  assert.deepEqual(events.map((e) => e.type), ['run.started', 'tool.started', 'tool.completed', 'assistant.text.delta', 'run.completed']);
  assert.deepEqual(events.map((e) => e.sequence), [1, 2, 3, 4, 5]);
  assert.deepEqual(events[1].payload, { toolCallId: 'replay_0', tool: 'flights', summary: 'LHR to EDI' });
  assert.equal(events[4].payload?.finalText, 'Here are three flights.');

  const failed = new RunEventEncoder('run-2').replay({ status: 'failed', finalText: '', toolCalls: [{ tool: 'email', summary: '' }], usage: null });
  assert.deepEqual(failed.map((e) => e.type), ['run.started', 'tool.started', 'tool.completed', 'run.failed']);
  const working = new RunEventEncoder('run-3').replay({ status: 'working', finalText: '', toolCalls: [], usage: null });
  assert.deepEqual(working.map((e) => e.type), ['run.started'], 'no outcome is invented for a run still working');
});
