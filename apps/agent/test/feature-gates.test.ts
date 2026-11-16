import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

// The two feature gates, lifted out of the agent's source the way
// agent-usage.test.ts does it, so the rule under test is the rule that ships.
const source = readFileSync(new URL('../src/agent.ts', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('agent.ts', source, ts.ScriptTarget.Latest, true);
const declaration = parsed.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === 'CoworkerAgent')!;
const picked = new Set(['inboxSortEnabled', 'moneyFinderEnabled']);
const members = declaration.members.filter((member) => member.name && picked.has(member.name.getText(parsed)));
assert.equal(members.length, picked.size);
const compiled = ts.transpileModule(`class Gates { ${members.map((member) => member.getText(parsed)).join('\n')} }`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const Gates = new Function(`${compiled}; return Gates;`)();

const ME = '8f14e45f-ceea-467a-9575-7f9c3c1b2a11';
const OTHER = '11111111-2222-4333-8444-555555555555';
const bindings = { INBOX_SORT: {}, MONEY_FINDER: {}, COMPOSIO_API_KEY: 'key' };
function gates(env: Record<string, unknown>, name = ME) {
  const agent = new Gates();
  Object.assign(agent, { env, name });
  return agent;
}

test('inbox sorting: "*" is every account, a list is those accounts, empty is nobody (Alex, 2026-09-27)', () => {
  assert.equal(gates({ ...bindings, INBOX_SORT_USER_IDS: '*' }).inboxSortEnabled(), true);
  assert.equal(gates({ ...bindings, INBOX_SORT_USER_IDS: `${OTHER}, ${ME}` }).inboxSortEnabled(), true);
  assert.equal(gates({ ...bindings, INBOX_SORT_USER_IDS: OTHER }).inboxSortEnabled(), false);
  assert.equal(gates({ ...bindings, INBOX_SORT_USER_IDS: '' }).inboxSortEnabled(), false, 'committed empty: off');
  assert.equal(gates({ ...bindings }).inboxSortEnabled(), false);
  assert.equal(gates({ ...bindings, INBOX_SORT_USER_IDS: '*' }, 'bench').inboxSortEnabled(), false, 'only real accounts');
  assert.equal(gates({ COMPOSIO_API_KEY: 'key', INBOX_SORT_USER_IDS: '*' }).inboxSortEnabled(), false, 'no Workflows binding');
  assert.equal(gates({ INBOX_SORT: {}, INBOX_SORT_USER_IDS: '*' }).inboxSortEnabled(), false, 'no Composio key');
});

test('Money Finder keeps the same rule', () => {
  assert.equal(gates({ ...bindings, MONEY_FINDER_USER_IDS: '*' }).moneyFinderEnabled(), true);
  assert.equal(gates({ ...bindings, MONEY_FINDER_USER_IDS: OTHER }).moneyFinderEnabled(), false);
  assert.equal(gates({ ...bindings, MONEY_FINDER_USER_IDS: '' }).moneyFinderEnabled(), false);
});
