// Route B (docs/CHAT_ROUTE_B_DESIGN.md) — delegent gateway-platform SSE
// translation. The runner's streaming bridge emits `event: delegent` frames of
// { kind, text, final, outcome, reason } where text is the FULL accumulated
// reply each time (Hermes' edit transport), possibly carrying the streaming
// cursor (U+2589). createDelegentTranslator() turns that into the SAME
// NormalisedRunEvent schema the app already consumes from /v1/runs, and
// parseDelegentSseBlock() extracts a frame from one SSE block. These lock the
// invariants the live chat depends on: cursor stripping, monotonic deltas
// (incl. across segment breaks), terminal mapping, and resync on divergence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDelegentTranslator,
  parseDelegentSseBlock,
  decideDelegentReconcileStep,
  isDelegentApprovalPrompt,
  shouldFinalizeApprovalPause,
  delegentDateStamp,
  buildDelegentDispatchText,
  DELEGENT_RECONCILE_BYPASS_FINALIZE_MS,
  DELEGENT_RECONCILE_GIVEUP_MS,
  DELEGENT_RECONCILE_POLL_MS,
} from '../dist/index.js';

const RUN = 'app-run-1';

function deltas(events) {
  return events.filter((e) => e.type === 'assistant.text.delta').map((e) => e.payload.delta);
}

test('parseDelegentSseBlock: extracts the data frame, ignores comment-only keepalives', () => {
  assert.deepEqual(
    parseDelegentSseBlock('event: delegent\ndata: {"kind":"edit","text":"hi","final":false}'),
    { kind: 'edit', text: 'hi', final: false },
  );
  assert.equal(parseDelegentSseBlock(': ka'), null);
  assert.equal(parseDelegentSseBlock(': open'), null);
  assert.equal(parseDelegentSseBlock('event: delegent\ndata: not-json'), null);
});

test('translator: monotonic edits become incremental deltas; cursor (U+2589) is stripped', () => {
  const t = createDelegentTranslator(RUN);
  const start = t.started();
  assert.equal(start.type, 'run.started');
  // edits carry the FULL accumulated text each time, suffixed with the " ▉"
  // cursor (space + block). The cursor (and its leading space) is stripped.
  const e1 = t.push({ kind: 'send', text: 'Hel ▉' });
  const e2 = t.push({ kind: 'edit', text: 'Hello wor ▉' });
  const e3 = t.push({ kind: 'edit', text: 'Hello world ▉' });
  // No cursor (and no spurious trailing space) anywhere in the emitted deltas.
  assert.deepEqual(deltas(e1), ['Hel']);
  assert.deepEqual(deltas(e2), ['lo wor']);
  assert.deepEqual(deltas(e3), ['ld']);
  // The concatenation of all deltas equals the cursor-stripped final text.
  assert.equal('Hel' + 'lo wor' + 'ld', 'Hello world');
  assert.equal(t.finalText, 'Hello world');
});

test('translator: an unchanged edit emits nothing (no duplicate delta)', () => {
  const t = createDelegentTranslator(RUN);
  t.push({ kind: 'send', text: 'Hello' });
  const again = t.push({ kind: 'edit', text: 'Hello' });
  assert.deepEqual(deltas(again), []);
});

test('translator: a new send after a segment commits the prior text (deltas stay additive)', () => {
  const t = createDelegentTranslator(RUN);
  // segment 1 (one Telegram-style message bubble upstream)
  t.push({ kind: 'send', text: 'Part one.' });
  // segment 2 begins with a fresh, SHORTER send — the prior segment must be
  // committed so the cumulative text keeps growing rather than resetting.
  // 2026-07-22: committed bubbles are separated by a blank line (they are
  // distinct upstream messages — interim narration / tool progress / the
  // final reply), so the separator rides at the front of the next delta.
  const s2a = t.push({ kind: 'send', text: 'Pa' });
  const s2b = t.push({ kind: 'edit', text: 'Part two.' });
  assert.deepEqual(deltas(s2a), ['\n\nPa']);
  assert.deepEqual(deltas(s2b), ['rt two.']);
  assert.equal(t.finalText, 'Part one.\n\nPart two.');
});

test('narration bubbles (2026-07-22): interim text + tool progress + final reply read as paragraphs, not word-mush', () => {
  const t = createDelegentTranslator(RUN);
  // The live defect: "…system limits.✍️ Writing …hello_world.py## Hello World
  // App — Created" — three upstream bubbles concatenated with no separator.
  t.push({ kind: 'send', text: "I'll create a Hello World app." });   // interim narration
  t.push({ kind: 'send', text: '✍️ Writing hello_world.py' });         // tool-progress bubble
  const final = t.push({ kind: 'send', text: '## Hello World — Created' }); // final reply
  assert.deepEqual(deltas(final), ['\n\n## Hello World — Created']);
  assert.equal(
    t.finalText,
    "I'll create a Hello World app.\n\n✍️ Writing hello_world.py\n\n## Hello World — Created",
  );
  // Terminal completion carries the separated text.
  const done = t.push({ kind: 'done', outcome: 'success' });
  assert.equal(done[0].type, 'run.completed');
  assert.equal(done[0].payload.finalText, t.finalText);
});

test('narration bubbles: an ACCUMULATING tool-progress bubble still grows monotonically across the separator', () => {
  const t = createDelegentTranslator(RUN);
  t.push({ kind: 'send', text: 'Working on it.' });
  // tool_progress_grouping=accumulate edits ONE bubble, appending a line per tool.
  t.push({ kind: 'send', text: '✍️ Writing a.md' });
  const grow = t.push({ kind: 'edit', text: '✍️ Writing a.md\n✍️ Writing b.md' });
  assert.deepEqual(deltas(grow), ['\n✍️ Writing b.md']);
  assert.equal(t.finalText, 'Working on it.\n\n✍️ Writing a.md\n✍️ Writing b.md');
});

test('narration bubbles: a replayed send (reconnect re-delivery) still does not double the text', () => {
  const t = createDelegentTranslator(RUN);
  t.push({ kind: 'send', text: 'Hello.' });
  t.push({ kind: 'send', text: 'World.' });
  // Reconnect re-delivers the same current bubble — must be a no-op.
  assert.deepEqual(t.push({ kind: 'send', text: 'World.' }), []);
  assert.equal(t.finalText, 'Hello.\n\nWorld.');
});

test('translator: non-monotonic divergence resyncs via assistant.text.completed', () => {
  const t = createDelegentTranslator(RUN);
  t.push({ kind: 'edit', text: 'aaaa' });
  // upstream replaced the text with something that is NOT a prefix-extension.
  const ev = t.push({ kind: 'edit', text: 'bbbb' });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, 'assistant.text.completed');
  assert.equal(ev[0].payload.text, 'bbbb');
  assert.equal(t.finalText, 'bbbb');
});

test('translator: typing frames are heartbeats only (no events)', () => {
  const t = createDelegentTranslator(RUN);
  assert.deepEqual(t.push({ kind: 'typing' }), []);
  assert.equal(t.terminal, false);
});

// 2026-06-15 dangerous-command approval BUTTONS (send_exec_approval parity with
// the messaging adapters): a kind:'approval' frame is the gate presented as a
// button card — surfaced as a structured assistant.approval.requested event,
// NOT text and NOT terminal, so the SAME run keeps streaming the reply after the
// user's press resolves it.
test('parseDelegentSseBlock: extracts an approval frame with its structured fields', () => {
  const frame = parseDelegentSseBlock('event: delegent\ndata: {"kind":"approval","approval_id":"u:1","command":"rm -rf /tmp/x","description":"delete in root path","choices":["once","always","deny"]}');
  assert.equal(frame.kind, 'approval');
  assert.equal(frame.approval_id, 'u:1');
  assert.equal(frame.command, 'rm -rf /tmp/x');
  assert.equal(frame.description, 'delete in root path');
  assert.deepEqual(frame.choices, ['once', 'always', 'deny']);
});

test('translator: an approval frame becomes assistant.approval.requested (not terminal, not text)', () => {
  const t = createDelegentTranslator(RUN);
  t.push({ kind: 'send', text: 'I will delete that file.' });
  const ev = t.push({
    kind: 'approval',
    approval_id: 'u:1',
    command: 'rm -rf /tmp/x',
    description: 'delete in root path',
    choices: ['once', 'always', 'deny'],
  });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, 'assistant.approval.requested');
  assert.equal(ev[0].payload.approvalId, 'u:1');
  assert.equal(ev[0].payload.command, 'rm -rf /tmp/x');
  assert.equal(ev[0].payload.description, 'delete in root path');
  assert.deepEqual(ev[0].payload.choices, ['once', 'always', 'deny']);
  // Must NOT terminate the run or disturb the already-streamed text.
  assert.equal(t.terminal, false);
  assert.equal(t.finalText, 'I will delete that file.');
  // The SAME run keeps streaming after the gate: a later edit still deltas.
  const after = t.push({ kind: 'edit', text: 'I will delete that file. Done.' });
  assert.deepEqual(deltas(after), [' Done.']);
  // and a normal done finalizes cleanly.
  assert.equal(t.push({ kind: 'done', outcome: 'success' })[0].type, 'run.completed');
});

test('translator: approval frame with omitted choices/description applies safe defaults', () => {
  const t = createDelegentTranslator(RUN);
  const ev = t.push({ kind: 'approval', approval_id: 'u:2', command: 'sudo rm -rf /' });
  assert.equal(ev[0].type, 'assistant.approval.requested');
  assert.deepEqual(ev[0].payload.choices, ['once', 'session', 'always', 'deny']);
  assert.equal(ev[0].payload.description, 'dangerous command');
});

test('translator: done(success) -> run.completed with the final text; sets terminal', () => {
  const t = createDelegentTranslator(RUN);
  t.push({ kind: 'edit', text: 'final answer ▉' });
  const ev = t.push({ kind: 'done', final: true, outcome: 'success' });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, 'run.completed');
  assert.equal(ev[0].payload.finalText, 'final answer');
  assert.equal(t.terminal, true);
  assert.equal(t.finalizeReason, 'completed');
});

test('translator: done(failure|cancelled) map to run.failed / run.cancelled', () => {
  const f = createDelegentTranslator(RUN);
  const fe = f.push({ kind: 'done', final: true, outcome: 'failure' });
  assert.equal(fe[0].type, 'run.failed');
  assert.equal(f.finalizeReason, 'failed');

  const c = createDelegentTranslator(RUN);
  const ce = c.push({ kind: 'done', final: true, outcome: 'cancelled' });
  assert.equal(ce[0].type, 'run.cancelled');
  assert.equal(c.finalizeReason, 'cancelled');
});

test('translator: sequence numbers increase across emitted events', () => {
  const t = createDelegentTranslator(RUN);
  const seqs = [];
  seqs.push(t.started().sequence);
  for (const e of t.push({ kind: 'send', text: 'a' })) seqs.push(e.sequence);
  for (const e of t.push({ kind: 'edit', text: 'ab' })) seqs.push(e.sequence);
  for (const e of t.push({ kind: 'done', outcome: 'success' })) seqs.push(e.sequence);
  for (let i = 1; i < seqs.length; i++) assert.ok(seqs[i] > seqs[i - 1], `sequence must increase: ${seqs}`);
});

// ---------------------------------------------------------------------------
// 2026-06-12 dropped-reply regression (the "what were we talking about
// yesterday" transcript): the agent relayed a preamble + tool markers, went
// relay-silent during session_search, the bridge idle-closed with a synthetic
// done(reason=idle), and the Worker fabricated run.completed from the PARTIAL
// text — the real answer never reached the app. These tests pin the fix.
// ---------------------------------------------------------------------------

test('REGRESSION 2026-06-12: synthetic done(reason=idle) must NOT complete the run with partial text', () => {
  const t = createDelegentTranslator(RUN);
  // the exact shape of the failing turn: preamble + tool markers, then silence
  t.push({ kind: 'send', text: 'I need to search my past conversations to see what we discussed.' });
  t.push({ kind: 'edit', text: 'I need to search my past conversations to see what we discussed.\n🔍 session_search: "recall: yesterday"', final: true });
  // the bridge gives up after its idle window — NOT a turn outcome
  const ev = t.push({ kind: 'done', final: true, reason: 'idle' });
  assert.deepEqual(ev, [], 'a synthetic idle close must not emit run.completed');
  assert.equal(t.terminal, true, 'translator must still mark the bridge stream as ended');
  assert.equal(t.synthetic, true, 'the terminal must be flagged synthetic so the relay reconciles');
});

test('synthetic done(reason=max_lifetime) is also inconclusive', () => {
  const t = createDelegentTranslator(RUN);
  t.push({ kind: 'edit', text: 'partial' });
  const ev = t.push({ kind: 'done', final: true, reason: 'max_lifetime' });
  assert.deepEqual(ev, []);
  assert.equal(t.synthetic, true);
});

test('a done WITH an explicit outcome stays organic even when a reason is present', () => {
  const t = createDelegentTranslator(RUN);
  t.push({ kind: 'edit', text: 'answer' });
  const ev = t.push({ kind: 'done', outcome: 'success', reason: 'idle' });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, 'run.completed');
  assert.equal(t.synthetic, false);
});

test('translator.resync: adopts the run-record text — growth as delta, divergence as completed', () => {
  const t = createDelegentTranslator(RUN);
  t.push({ kind: 'send', text: 'Searching…' });
  // record caught up PAST what the dead stream delivered
  const grow = t.resync('Searching…Found it: the answer is 42.');
  assert.equal(grow.length, 1);
  assert.equal(grow[0].type, 'assistant.text.delta');
  assert.equal(grow[0].payload.delta, 'Found it: the answer is 42.');
  assert.equal(t.finalText, 'Searching…Found it: the answer is 42.');
  // identical text → no event
  assert.deepEqual(t.resync('Searching…Found it: the answer is 42.'), []);
  // divergent text → full resync event
  const div = t.resync('Completely different.');
  assert.equal(div[0].type, 'assistant.text.completed');
  assert.equal(t.finalText, 'Completely different.');
});

test('translator: lastContentFinal tracks the final flag of the latest content frame', () => {
  const t = createDelegentTranslator(RUN);
  t.push({ kind: 'edit', text: 'a', final: false });
  assert.equal(t.lastContentFinal, false);
  t.push({ kind: 'edit', text: 'ab', final: true });
  assert.equal(t.lastContentFinal, true);
});

// --- decideDelegentReconcileStep: the reconcile policy matrix ---------------

const BASE = { emittedText: 'partial', noGrowthMs: 0, totalMs: 0, cmdRun: false };

test('reconcile policy: record done(success) finalizes with the AUTHORITATIVE text', () => {
  const action = decideDelegentReconcileStep({
    ...BASE,
    probe: { ok: true, done: true, outcome: 'success', text: 'the full real answer', lastFinal: true },
  });
  assert.deepEqual(action, { kind: 'finalize', reason: 'completed', text: 'the full real answer' });
});

test('reconcile policy: record done(failure|cancelled) map to failed/cancelled', () => {
  assert.equal(decideDelegentReconcileStep({ ...BASE, probe: { ok: true, done: true, outcome: 'failure', text: '' } }).reason, 'failed');
  assert.equal(decideDelegentReconcileStep({ ...BASE, probe: { ok: true, done: true, outcome: 'cancelled', text: '' } }).reason, 'cancelled');
});

test('reconcile policy: a live turn keeps polling while the record is not done', () => {
  const action = decideDelegentReconcileStep({
    ...BASE,
    probe: { ok: true, done: false, text: 'partial', lastFinal: true },
    noGrowthMs: DELEGENT_RECONCILE_BYPASS_FINALIZE_MS + 1,
  });
  // NOT a cmd run: a finalized segment + long silence is a tool call, not
  // completion — finalizing here would re-introduce the dropped-reply bug.
  assert.deepEqual(action, { kind: 'continue' });
});

test('reconcile policy: a CMD (slash) run with a stable final reply finalizes after the bypass window', () => {
  const action = decideDelegentReconcileStep({
    ...BASE,
    cmdRun: true,
    probe: { ok: true, done: false, text: 'New session started.', lastFinal: true },
    noGrowthMs: DELEGENT_RECONCILE_BYPASS_FINALIZE_MS + 1,
  });
  assert.deepEqual(action, { kind: 'finalize', reason: 'completed', text: 'New session started.' });
});

test('reconcile policy: 404 (pre-fix runner image) falls back to the legacy close-out', () => {
  assert.deepEqual(decideDelegentReconcileStep({ ...BASE, probe: { ok: false, notFound: true } }), { kind: 'legacy_finalize' });
});

// 2026-06-14 mid-turn approval composer-lock: Hermes' native gate blocks the
// turn (done stays false up to 300s) and emits the approval prose. Finalize the
// prompt turn cleanly so the bubble resolves + composer unlocks; the literal
// /approve|/deny is the NEXT turn that resolves the gate on-box.
const APPROVAL_PROMPT = '⚠️ Dangerous command requires approval:\n```\nrm -rf /tmp/x\n```\nReason: delete in root path\n\nReply `/approve` to execute, `/approve session`, `/approve always`, or `/deny` to cancel.';

test('isDelegentApprovalPrompt: matches the native gate HEADER + tokens, not loose mentions/explanations', () => {
  assert.equal(isDelegentApprovalPrompt(APPROVAL_PROMPT), true);
  assert.equal(isDelegentApprovalPrompt('you can reply with /approve later'), false);
  // FALSE-POSITIVE GUARD (review blocker): an agent EXPLAINING approvals has the
  // loose words + both tokens but NOT the gate's "dangerous command" header.
  assert.equal(isDelegentApprovalPrompt('This action requires approval. Reply /approve to proceed or /deny to cancel.'), false);
  assert.equal(isDelegentApprovalPrompt('a normal answer'), false);
  assert.equal(isDelegentApprovalPrompt(''), false);
  assert.equal(isDelegentApprovalPrompt(null), false);
});

test('shouldFinalizeApprovalPause: only when the gate prompt is STABLE (no-growth) — never mid-stream', () => {
  // the durability blocker: an answer containing the prompt but STILL GROWING
  // (noGrowth below the window) must NOT be finalized/truncated.
  assert.equal(shouldFinalizeApprovalPause(APPROVAL_PROMPT, 0), false);
  assert.equal(shouldFinalizeApprovalPause(APPROVAL_PROMPT, DELEGENT_RECONCILE_POLL_MS - 1), false);
  // stable for the window -> safe to finalize the paused gate.
  assert.equal(shouldFinalizeApprovalPause(APPROVAL_PROMPT, DELEGENT_RECONCILE_POLL_MS), true);
  // ordinary stable text is never an approval pause.
  assert.equal(shouldFinalizeApprovalPause('a long but finished normal answer', DELEGENT_RECONCILE_POLL_MS * 10), false);
});

test('reconcile policy: a NON-cmd run paused on the native approval gate finalizes (completed) once the prompt is stable', () => {
  const action = decideDelegentReconcileStep({
    ...BASE,
    cmdRun: false,
    probe: { ok: true, done: false, text: APPROVAL_PROMPT, lastFinal: false },
    noGrowthMs: DELEGENT_RECONCILE_POLL_MS,
  });
  assert.deepEqual(action, { kind: 'finalize', reason: 'completed', text: APPROVAL_PROMPT });
});

test('reconcile policy: the gate prompt STILL GROWING (noGrowth below the window) is NOT finalized', () => {
  const action = decideDelegentReconcileStep({
    ...BASE,
    cmdRun: false,
    probe: { ok: true, done: false, text: APPROVAL_PROMPT, lastFinal: false },
    noGrowthMs: DELEGENT_RECONCILE_POLL_MS - 1,
  });
  assert.deepEqual(action, { kind: 'continue' });
});

test('reconcile policy: a non-approval silent tool call is STILL not finalized (dropped-reply guard intact)', () => {
  // identical shape to the approval case EXCEPT the text is ordinary -> must keep polling
  const action = decideDelegentReconcileStep({
    ...BASE,
    cmdRun: false,
    probe: { ok: true, done: false, text: 'Working on it, running a long tool call...', lastFinal: false },
    noGrowthMs: DELEGENT_RECONCILE_POLL_MS,
  });
  assert.deepEqual(action, { kind: 'continue' });
});

test('reconcile policy: transient probe errors keep polling; the hard cap gives up IN-FLIGHT', () => {
  assert.deepEqual(decideDelegentReconcileStep({ ...BASE, probe: null }), { kind: 'continue' });
  assert.deepEqual(decideDelegentReconcileStep({ ...BASE, probe: { ok: false } }), { kind: 'continue' });
  assert.deepEqual(
    decideDelegentReconcileStep({ ...BASE, probe: null, totalMs: DELEGENT_RECONCILE_GIVEUP_MS }),
    { kind: 'giveup' },
  );
});

// ---------------------------------------------------------------------------
// Route B date stamp (2026-06-13 frozen-date defect): Route B is text-only and
// the durable session never rotates, so without a per-turn date the agent's
// "today" freezes at the cutover date (it told the user "today is June 11" on
// June 13). Every NORMAL turn must carry the real UTC date; slash commands must
// stay verbatim so the gateway still parses the leading "/".
// ---------------------------------------------------------------------------

test('delegentDateStamp: emits the real UTC date + weekday, no em-dash (release-gate)', () => {
  const stamp = delegentDateStamp(new Date('2026-06-13T07:25:50Z'));
  assert.equal(stamp, '[Current date: Saturday 2026-06-13 (UTC). The user is messaging you now; treat this as today.]');
  // The provisioner prompt + release-gate scanner forbid em-dashes in agent-facing text.
  assert.ok(!stamp.includes('—'), 'date stamp must not contain an em-dash');
});

test('delegentDateStamp: derives the date from UTC, not local time (no day drift)', () => {
  // 23:30 UTC is still the 13th in UTC even where a local tz would roll to the 14th.
  assert.match(delegentDateStamp(new Date('2026-06-13T23:30:00Z')), /2026-06-13 \(UTC\)/);
});

test('buildDelegentDispatchText: a NORMAL turn is prefixed with the date stamp then the message', () => {
  const now = new Date('2026-06-13T07:25:50Z');
  const { text, isSlashCommand } = buildDelegentDispatchText('what were we talking about yesterday?', now);
  assert.equal(isSlashCommand, false);
  assert.equal(text, `${delegentDateStamp(now)}\n\nwhat were we talking about yesterday?`);
  assert.ok(text.startsWith('[Current date: Saturday 2026-06-13'));
  assert.ok(text.endsWith('what were we talking about yesterday?'));
});

test('buildDelegentDispatchText: a slash-command turn is sent VERBATIM (gateway parses the leading /)', () => {
  const { text, isSlashCommand } = buildDelegentDispatchText('/new', new Date('2026-06-13T07:25:50Z'));
  assert.equal(isSlashCommand, true);
  assert.equal(text, '/new'); // no date prefix: prepending would break the gateway's "/" detection
});

test('buildDelegentDispatchText: leading whitespace before / still counts as a slash command', () => {
  const { text, isSlashCommand } = buildDelegentDispatchText('   /goal ship it', new Date('2026-06-13T07:25:50Z'));
  assert.equal(isSlashCommand, true);
  assert.equal(text, '   /goal ship it');
});
