import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const chatSource = readFileSync(new URL('../../../../../assets/chat-webview/index.html', import.meta.url), 'utf8');
const packageSource = readFileSync(new URL('../../../../../package.json', import.meta.url), 'utf8');

// An inline onclick is HTML first and JavaScript second: the browser decodes
// the attribute value, THEN parses the result as code. Interpolating a runtime
// value into it therefore has to survive two grammars at once, and neither of
// our escapers does that. esc() encodes a quote as &#39;, which decodes back to
// a quote before the JS is parsed, so an id carrying one closes the string and
// runs what follows. JSON.stringify() emits real double quotes, which end the
// attribute outright and leave a handler that will not even parse.
//
// Both mistakes were live in this file: the gate-approval card interpolated an
// SSE-supplied approvalId through esc(), and the Telegram Copy button was a
// syntax error that had never copied anything. The rule below is what stops the
// next one: values ride in data attributes, handlers read this.dataset.
const inlineHandlers = [...chatSource.matchAll(/on(?:click|change|input|submit)="([^"]*)"/g)];

test('no inline handler interpolates a value into a JavaScript string literal', () => {
  assert.ok(inlineHandlers.length > 0, 'the chat surface should still use inline handlers');
  for (const [, body] of inlineHandlers) {
    assert.doesNotMatch(
      body,
      /'\$\{|\}'/,
      `inline handler interpolates into a quoted string, which escaping cannot make safe: ${body}`,
    );
    assert.doesNotMatch(
      body,
      /JSON\.stringify\(/,
      `JSON.stringify emits double quotes that terminate the attribute, leaving a handler that cannot parse: ${body}`,
    );
  }
});

test('the values those handlers need come from data attributes instead', () => {
  assert.match(
    chatSource,
    /data-approval-id="\$\{esc\(ap\.approvalId\)\}"/,
    'the gate approval id should be an escaped attribute value',
  );
  assert.match(
    chatSource,
    /gateApprovalDecision\(this\.dataset\.approvalId, this\.dataset\.choice\)/,
    'the approval buttons should read the id back off themselves',
  );
  assert.match(
    chatSource,
    /data-tg-code="\$\{esc\(code\)\}"[^>]*onclick="tgCopyCode\(this, this\.dataset\.tgCode\)"/,
    'the Telegram Copy button should read the code off itself',
  );
});

test('every inline handler in the chat surface actually parses as JavaScript', () => {
  for (const [, body] of inlineHandlers) {
    // Template holes stand in for values the handler will receive at runtime;
    // substituting a literal proves the surrounding syntax is well formed.
    const source = body.replace(/\$\{[^}]*\}/g, '0');
    assert.doesNotThrow(
      () => new Function(source),
      `inline handler does not parse, so the control is dead on tap: ${body}`,
    );
  }
});

test('mobile test suite includes the inline-handler safety guard', () => {
  const scripts = JSON.parse(packageSource).scripts;
  assert.match(scripts.test, /chat-inline-handler-safety\.test\.mjs/);
});
