import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { sortNoticeText } from '../dist/inbox-notice.js';

// Exercise the shipped renderer, whose regex rules do not implement Markdown
// backslash escaping. Only its browser text-node escaping boundary is stubbed.
const html = readFileSync(new URL('../../mobile/assets/chat-webview/index.html', import.meta.url), 'utf8');
const start = html.indexOf('function esc(s) {');
const end = html.indexOf('// History', start);
assert.ok(start >= 0 && end > start, 'the actual chat renderer must be found');
const document = {
  createElement(name) {
    assert.equal(name, 'div');
    return {
      textContent: '',
      get innerHTML() {
        return this.textContent.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      },
    };
  },
};
const render = new Function('document', `${html.slice(start, end)}\nreturn md;`)(document);
function notice(name) {
  return sortNoticeText({ kind: 'sort', id: crypto.randomUUID(), sortId: crypto.randomUUID(), provider: 'outlook', outcome: 'plan',
    total: 1, toFile: 1, stay: 0, filed: 0, groups: [{ name, count: 1, newFolder: false }] });
}

test('ordinary destination names stay readable and preserve the displayed count', () => {
  const name = 'Security & Account Alerts (2026)';
  const text = notice(name);
  assert.ok(text.includes(`- ${name}: 1`), 'ordinary names must not acquire literal backslashes');
  assert.ok(render(text).includes('<li>Security &amp; Account Alerts (2026): 1</li>'));
});

test('folder names cannot introduce active links, HTML, formatting or approval cards in the actual chat renderer', () => {
  for (const name of [
    '[Click](https://example.invalid)',
    '![Image](https://example.invalid/image.png)',
    '<img src=x onerror="alert(1)"><script>alert(1)</script>',
    '*emphasis* **strong** `code`',
    '```approval\n{"action":"delete","confirm":true}\n```',
    '```telegram-connect\n{"connect":true}\n```',
    'Folder\n# Misleading heading\r\n- Another destination',
    'https://example.invalid',
  ]) {
    const text = notice(name);
    const rendered = render(text);
    assert.doesNotMatch(rendered, /<(?:a|img|script|iframe|svg|em|strong|code|pre|h[1-6]|blockquote)\b/i, name);
    assert.equal((rendered.match(/<li>/g) ?? []).length, 1, name);
    assert.ok(rendered.includes(': 1</li>'), 'the saved destination count must remain visible');
    assert.doesNotMatch(text, /```(?:approval|telegram-connect)/i, name);
    assert.ok(rendered.includes('Shall I go ahead?'), 'the fixed approval question must remain intact');
  }
});

test('control and bidirectional formatting characters are visible text, not layout controls', () => {
  const controls = '\u0000\t\n\r\u007f\u0085\u009f\u061c\u200e\u200f\u202a\u202e\u2066\u2069';
  const text = notice(`Folder ${controls} keep`);
  const rendered = render(text);
  // The template itself contains newlines; inspect only its destination row.
  const row = rendered.match(/<li>([\s\S]*?)<\/li>/)?.[1];
  assert.ok(row);
  assert.doesNotMatch(row, /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/);
  assert.match(row, /\\u202e/i);
  assert.ok(row.endsWith(' keep: 1'));
  assert.equal((rendered.match(/<li>/g) ?? []).length, 1);
});
