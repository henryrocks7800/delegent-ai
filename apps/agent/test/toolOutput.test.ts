import assert from 'node:assert/strict';
import test from 'node:test';
import type { ModelMessage } from 'ai';
import { modelMessageSchema } from 'ai';
import { TOOL_OUTPUT_MAX_CHARS, TOOL_CONTEXT_MAX_CHARS, capToolResultsInMessages, cappedStructured, cappedText } from '../src/toolOutput.ts';

const toolMessage = (output: unknown, toolName = 'tool_ab12_GMAIL_FETCH_EMAILS'): ModelMessage =>
  ({
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId: 'call_1', toolName, output }],
  }) as unknown as ModelMessage;

const resultPart = (messages: ModelMessage[], index = 0) =>
  (messages[index] as unknown as { content: Array<{ toolCallId: string; toolName: string; output: { type: string; value: string } }> }).content[0];

const big = (over = 1) => 'x'.repeat(TOOL_OUTPUT_MAX_CHARS + over);

test('messages with nothing oversized are left exactly as they are', () => {
  const messages: ModelMessage[] = [
    { role: 'user', content: 'read my email' } as ModelMessage,
    toolMessage({ type: 'json', value: { messages: [{ subject: 'hello' }] } }),
  ];
  assert.equal(capToolResultsInMessages(messages), null, 'null means the step is left untouched');
});

test('an oversized result becomes bounded text that says what to do instead', () => {
  const capped = capToolResultsInMessages([toolMessage({ type: 'json', value: { body: big(5_000) } })]);
  assert.ok(capped, 'the messages were rewritten');
  const part = resultPart(capped!);
  assert.equal(part.output.type, 'text');
  assert.ok(part.output.value.length < TOOL_OUTPUT_MAX_CHARS + 500, 'the value is bounded');
  assert.match(part.output.value, /about 20 items at a time/);
  assert.match(part.output.value, /never the message bodies/);
  assert.match(part.output.value, /Do not mention this to the user/);
});

test('the tool call id and name survive, or the provider rejects the transcript', () => {
  const capped = capToolResultsInMessages([toolMessage({ type: 'text', value: big() })]);
  const part = resultPart(capped!);
  assert.equal(part.toolCallId, 'call_1');
  assert.equal(part.toolName, 'tool_ab12_GMAIL_FETCH_EMAILS');
});

test('a plain string output and a bare object output are both measured', () => {
  assert.ok(capToolResultsInMessages([toolMessage(big())]), 'bare string output');
  assert.ok(capToolResultsInMessages([toolMessage({ type: 'json', value: [big()] })]), 'array value');
});

test('small errors retain their shape; oversized errors and denial reasons cannot bypass the cap', () => {
  for (const type of ['error-text', 'error-json']) {
    assert.equal(capToolResultsInMessages([toolMessage({ type, value: 'failed' })]), null, type);
    const capped = capToolResultsInMessages([toolMessage({ type, value: big() })]);
    assert.equal(resultPart(capped!).output.type, 'error-text');
    assert.ok(resultPart(capped!).output.value.length <= TOOL_OUTPUT_MAX_CHARS);
  }
  const denied = capToolResultsInMessages([toolMessage({ type: 'execution-denied', reason: big() })]);
  const denial = resultPart(denied!).output as unknown as { type: string; reason: string };
  assert.equal(denial.type, 'execution-denied');
  assert.ok(denial.reason.length <= TOOL_OUTPUT_MAX_CHARS);
  assert.ok(modelMessageSchema.safeParse(denied![0]).success);
});

test('only the oversized message is rewritten; the others keep their identity', () => {
  const small = toolMessage({ type: 'json', value: { ok: true } }, 'tool_ab12_GMAIL_SEND_EMAIL');
  const user = { role: 'user', content: 'and the rest?' } as ModelMessage;
  const capped = capToolResultsInMessages([user, small, toolMessage({ type: 'text', value: big() })]);
  assert.ok(capped);
  assert.equal(capped![0], user, 'untouched messages are the same objects');
  assert.equal(capped![1], small);
  assert.notEqual(capped![2], undefined);
  assert.equal(resultPart(capped!, 2).output.type, 'text');
});

test('cappedText keeps the start of the result and appends the note', () => {
  const text = cappedText(`${'A sentence. '.repeat(TOOL_OUTPUT_MAX_CHARS)}TAIL`);
  assert.ok(text.startsWith('A sentence. '));
  assert.ok(text.length <= TOOL_OUTPUT_MAX_CHARS);
  assert.equal(text.includes('TAIL'), false, 'the overflow is dropped');
  assert.match(text, /\[Delegent: this result was too large/);
});

// ---------------------------------------------------------------------------
// The half-an-id fault, 2026-09-19. A paying customer asked her coworker to
// sort six months of Outlook mail into folders. The cap sliced the serialised
// list at 24,000 characters, which on her mailbox lands inside message 3 of
// 20, and the model sent the fragment of a 140-character id to the move tool.
// Her transcript: "Outlook is rejecting every newly retrieved message ID as
// malformed". Real measurements from her toolkit are used below.
// ---------------------------------------------------------------------------
const OUTLOOK_ID_CHARS = 140;
const outlookMessage = (n: number) => ({
  id: `AAMkAD${String(n).padStart(4, '0')}${'Q'.repeat(OUTLOOK_ID_CHARS - 10)}`,
  subject: `Message ${n}`,
  from: { emailAddress: { address: `sender${n}@example.com` } },
  receivedDateTime: '2026-09-19T08:00:00Z',
  isRead: false,
  // Measured average on the real mailbox: about 32,000 characters per body.
  body: { contentType: 'html', content: 'b'.repeat(32_000) },
});
const outlookListing = (count = 20) => ({ response_data: { value: Array.from({ length: count }, (_, i) => outlookMessage(i + 1)) } });

test('a capped listing never contains a half-written id', () => {
  const capped = capToolResultsInMessages([toolMessage({ type: 'json', value: outlookListing() }, 'tool_ab12_OUTLOOK_OUTLOOK_LIST_MESSAGES')]);
  const value = resultPart(capped!).output.value;
  const ids = [...value.matchAll(/"id":"(AAMkAD[^"]*)"/g)].map((m) => m[1]);
  assert.ok(ids.length > 0, 'ids survive the cap: an empty result would be its own bug');
  for (const id of ids) {
    assert.equal(id.length, OUTLOOK_ID_CHARS, `every id is whole, not the ${id.length} characters a slice would leave`);
  }
});

test('a capped listing keeps whole records and says how many it left out', () => {
  const capped = capToolResultsInMessages([toolMessage({ type: 'json', value: outlookListing() }, 'tool_ab12_OUTLOOK_OUTLOOK_LIST_MESSAGES')]);
  const value = resultPart(capped!).output.value;
  const shown = JSON.parse(value.slice(0, value.indexOf('[Delegent:')));
  assert.equal(shown.length, 20, 'all 20 fit once the bodies are gone: 655,000 characters becomes about 11,000');
  for (const record of shown) {
    assert.ok(record.id && record.subject && record.receivedDateTime, 'the fields that identify a message are kept');
    assert.equal(record.body, undefined, 'the 32,000 character body is not');
  }
  assert.match(value, /20 of 20 items shown/);
  assert.match(value, /Large fields were removed from each item: body/);
  assert.match(value, /Every id here is complete/);
});

test('when the bodies alone still do not fit, whole records are dropped rather than cut', () => {
  // 400 messages of metadata: more than the budget even with no bodies.
  const capped = capToolResultsInMessages([toolMessage({ type: 'json', value: outlookListing(400) }, 'tool_ab12_OUTLOOK_OUTLOOK_LIST_MESSAGES')]);
  const value = resultPart(capped!).output.value;
  const shown = JSON.parse(value.slice(0, value.indexOf('[Delegent:')));
  assert.ok(shown.length > 0 && shown.length < 400, `a partial page: ${shown.length} of 400`);
  for (const record of shown) assert.equal(String(record.id).length, OUTLOOK_ID_CHARS, 'still whole ids');
  assert.match(value, new RegExp(`${400 - shown.length} items not shown`));
  assert.match(value, /Do not skip omitted items using the next-page cursor/);
  assert.match(value, /smaller page from the original cursor/);
});

test('reading ONE message keeps its body: this cap is for listings, not for the thing the user asked to read', () => {
  const single = { response_data: { value: [outlookMessage(1)] } };
  const capped = capToolResultsInMessages([toolMessage({ type: 'json', value: single }, 'tool_ab12_OUTLOOK_OUTLOOK_GET_MESSAGE')]);
  const value = resultPart(capped!).output.value;
  assert.ok(value.includes('bbbb'), 'the body the user asked for is still there, sliced rather than stripped');
});

test('cappedStructured declines anything that is not a list of records', () => {
  assert.equal(cappedStructured('a very long string'), null);
  assert.equal(cappedStructured({ html: 'x'.repeat(50_000) }), null, 'one big blob has no record to keep whole');
});

test('long identifiers and pagination cursors survive structured capping whole', () => {
  const id = `whole-id-${'q'.repeat(900)}`;
  const cursor = `https://graph.microsoft.com/v1.0/me/messages?$skiptoken=${'c'.repeat(1000)}`;
  const listing = outlookListing();
  listing.response_data.value[0].id = id;
  const capped = capToolResultsInMessages([toolMessage({ type: 'json', value: {
    ...listing, '@odata.nextLink': cursor, next_page_token: 'opaque-cursor+with/slashes==',
  } })]);
  const value = resultPart(capped!).output.value;
  assert.ok(value.includes(JSON.stringify(id)));
  assert.ok(value.includes(JSON.stringify(cursor)));
  assert.ok(value.includes('opaque-cursor+with/slashes=='));
  assert.ok(value.length <= TOOL_OUTPUT_MAX_CHARS);
});

test('single-message reads and JSON encoded inside MCP text never slice an ID after a large body', () => {
  const id = `message-${'Q'.repeat(140)}`;
  const data = { body: { content: 'body text '.repeat(10000) }, id, nextPageToken: 'whole-cursor==' };
  for (const value of [data, { content: [{ type: 'text', text: JSON.stringify(data) }] }]) {
    const capped = capToolResultsInMessages([toolMessage({ type: 'json', value })]);
    const text = resultPart(capped!).output.value;
    assert.ok(text.includes(JSON.stringify(id)), 'a whole ID after the body still survives');
    assert.ok(text.includes('whole-cursor=='));
    assert.ok(text.includes('body text'), 'the requested body remains readable');
    JSON.parse(text.slice(0, text.indexOf('\n\n[Delegent:')));
    assert.ok(text.length <= TOOL_OUTPUT_MAX_CHARS);
  }
});

const exchange = (n: number, value: unknown, input: unknown = { page: n }): ModelMessage[] => [
  { role: 'assistant', content: [{ type: 'tool-call', toolCallId: `call_${n}`, toolName: 'fetch_mail', input }] },
  { role: 'tool', content: [{ type: 'tool-result', toolCallId: `call_${n}`, toolName: 'fetch_mail', output: { type: 'json', value } }] },
] as ModelMessage[];

function assertPairedAndValid(messages: ModelMessage[]) {
  const calls: string[] = [];
  const results: string[] = [];
  for (const message of messages) {
    assert.ok(modelMessageSchema.safeParse(message).success, 'every rewritten message satisfies the actual AI SDK schema');
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type === 'tool-call') calls.push(part.toolCallId);
      if (part.type === 'tool-result') results.push(part.toolCallId);
    }
  }
  assert.deepEqual(calls.sort(), results.sort(), 'retained calls and results pair exactly');
}

function toolHistorySize(messages: ModelMessage[]) {
  return JSON.stringify(messages.filter((message) => message.role === 'tool'
    || message.role === 'assistant')).length;
}

test('many individually small pages cannot accumulate beyond the aggregate tool history budget', () => {
  const input = Array.from({ length: 80 }, (_, n) => exchange(n, { records: 'readable body '.repeat(1200) })).flat();
  const capped = capToolResultsInMessages(input)!;
  assert.ok(capped);
  assert.ok(toolHistorySize(capped) <= TOOL_CONTEXT_MAX_CHARS);
  assertPairedAndValid(capped);
  const newest = resultPart(capped, capped.length - 1);
  assert.equal(newest.toolCallId, 'call_79');
  assert.ok(JSON.stringify(newest.output).includes('readable body'), 'newest result stays useful');
  assert.equal(capped.filter((message) => typeof message.content === 'string' && message.content.startsWith('[Delegent tool history:')).length, 1);
  assert.equal(capToolResultsInMessages(capped), null, 'bounded model input is stable when checked again');
});

test('thousands of pages with huge mail bodies have bounded context, intact latest IDs and cursor, and complete pairing', () => {
  const oversized = { messages: [0, 1, 2, 3].map((n) => ({ id: `mail-${n}`, subject: 'Hello', body: 'b'.repeat(40_000) })) };
  for (const count of [1000, 2000]) {
    const input = Array.from({ length: count }, (_, n) => exchange(n, {
      ...oversized, next_page_token: `cursor-for-page-${n + 1}`,
    })).flat();
    const capped = capToolResultsInMessages(input)!;
    assert.ok(toolHistorySize(capped) <= TOOL_CONTEXT_MAX_CHARS, `${count} pages stay inside the same fixed budget`);
    assertPairedAndValid(capped);
    const newest = resultPart(capped, capped.length - 1);
    assert.equal(newest.toolCallId, `call_${count - 1}`);
    assert.ok(newest.output.value.includes(`cursor-for-page-${count}`));
    assert.ok(newest.output.value.includes('"id":"mail-3"'));
    assert.ok(newest.output.value.length <= TOOL_OUTPUT_MAX_CHARS);
  }
});

test('aggregate budget includes huge completed call arguments, not only result payloads', () => {
  const input = [
    ...exchange(1, { ok: true }, { source: 'x'.repeat(200_000), messageId: 'never-slice-this-id' }),
    ...exchange(2, { id: 'latest-whole-id', subject: 'Current page' }),
  ];
  const capped = capToolResultsInMessages(input)!;
  assert.ok(toolHistorySize(capped) <= TOOL_CONTEXT_MAX_CHARS);
  assertPairedAndValid(capped);
  assert.ok(!JSON.stringify(capped).includes('call_1'), 'both halves of the oversized earlier exchange are omitted');
  assert.ok(JSON.stringify(capped).includes('latest-whole-id'));
});

test('mixed messages retain ordinary prose and pending tool calls unchanged while old complete pairs are removed', () => {
  const user = { role: 'user', content: 'Please keep the folders called Family and Receipts.' } as ModelMessage;
  const prose = { type: 'text', text: 'I have finished the first batch and will continue.' } as const;
  const old = exchange(1, { ok: true }, { body: 'x'.repeat(200_000) });
  const oldAssistant = old[0] as Extract<ModelMessage, { role: 'assistant' }>;
  oldAssistant.content = [prose, ...(oldAssistant.content as Exclude<typeof oldAssistant.content, string>)];
  const pending = { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'pending', toolName: 'fetch_mail', input: { cursor: 'still-pending-cursor' } }] } as ModelMessage;
  const capped = capToolResultsInMessages([user, ...old, ...exchange(2, { latest: true }), pending])!;
  assert.equal(capped[0], user);
  assert.ok(capped.some((message) => Array.isArray(message.content) && message.content.some((part) => part === prose)));
  assert.ok(JSON.stringify(capped).includes('still-pending-cursor'));
  assert.ok(!JSON.stringify(capped).includes('call_1'));
  for (const message of capped) assert.ok(modelMessageSchema.safeParse(message).success);
});

test('large ordinary user and assistant prose is not reduced by a tool-only budget', () => {
  const messages = [
    { role: 'user', content: 'u'.repeat(200_000) },
    { role: 'assistant', content: 'a'.repeat(200_000) },
    ...exchange(1, { ok: true }),
  ] as ModelMessage[];
  assert.equal(capToolResultsInMessages(messages), null);
});

test('approval parts for an omitted completed exchange are removed together without leaving orphan approvals', () => {
  const first = exchange(1, { ok: true }, { body: 'x'.repeat(200_000) });
  const assistant = first[0] as Extract<ModelMessage, { role: 'assistant' }>;
  assistant.content = [
    ...(assistant.content as Exclude<typeof assistant.content, string>),
    { type: 'tool-approval-request', approvalId: 'approval_1', toolCallId: 'call_1' },
  ];
  const response = { role: 'tool', content: [{ type: 'tool-approval-response', approvalId: 'approval_1', approved: true }] } as ModelMessage;
  const capped = capToolResultsInMessages([first[0], response, first[1], ...exchange(2, { latest: true })])!;
  assertPairedAndValid(capped);
  assert.ok(!JSON.stringify(capped).includes('approval_1'));
  assert.ok(!JSON.stringify(capped).includes('call_1'));
});

test('large provider metadata on a completed tool message is counted in the history budget', () => {
  const old = exchange(1, { ok: true });
  old[1] = { ...old[1], providerOptions: { provider: { largeMetadata: 'x'.repeat(200_000) } } } as ModelMessage;
  const capped = capToolResultsInMessages([...old, ...exchange(2, { id: 'current-id' })])!;
  assert.ok(toolHistorySize(capped) <= TOOL_CONTEXT_MAX_CHARS);
  assertPairedAndValid(capped);
  assert.ok(!JSON.stringify(capped).includes('call_1'));
});

test('repeated growth keeps the aggregate bound and only one history marker', () => {
  let messages: ModelMessage[] = [];
  for (let n = 0; n < 100; n++) {
    messages.push(...exchange(n, { records: 'mail content '.repeat(1500) }));
    messages = capToolResultsInMessages(messages) ?? messages;
    assert.ok(toolHistorySize(messages) <= TOOL_CONTEXT_MAX_CHARS);
  }
  assertPairedAndValid(messages);
  assert.equal(messages.filter((message) => typeof message.content === 'string' && message.content.startsWith('[Delegent tool history:')).length, 1);
});
