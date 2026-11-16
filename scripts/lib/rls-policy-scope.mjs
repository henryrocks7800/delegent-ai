// #31 (go-live tracker) — RLS policies must be SCOPED, not merely present.
// The migration validator proves RLS is *enabled*; this module proves the
// final-state policy set actually confines each client-facing policy to the
// requesting user. A policy whose USING / WITH CHECK never references
// auth.uid() grants every authenticated user every row.
//
// Final-state semantics: `create policy` / `drop policy` are replayed in
// migration order, so an early offender cured by a later `drop policy`
// (e.g. the 0002 messages INSERT policy dropped in 0042) passes.
//
// Escape hatch: a `-- rls-scope-exempt: <reason>` comment inside the create
// statement (or on the line directly above it) skips the rule for that
// policy. Use only for deliberately-global policies with a written reason.

const CREATE_POLICY_PATTERN = /create\s+policy\s+"([^"]+)"\s+on\s+(?:public\.)?(\w+)[\s\S]*?;/gi;
const DROP_POLICY_PATTERN = /drop\s+policy\s+(?:if\s+exists\s+)?"([^"]+)"\s+on\s+(?:public\.)?(\w+)/gi;

/**
 * Replay create/drop policy statements over the concatenated migration SQL
 * (files must be concatenated in migration order) and return the policies
 * that SURVIVE to the final state without an auth.uid() scope or an explicit
 * exemption comment.
 *
 * @param {string} rawSql concatenated migration SQL, original casing
 * @returns {{ table: string, policy: string, statement: string }[]}
 */
export function findUnscopedSurvivingPolicies(rawSql) {
  /** @type {Map<string, { table: string, policy: string, statement: string, index: number }>} */
  const surviving = new Map();

  /** @type {{ kind: 'create'|'drop', key: string, table: string, policy: string, statement: string, index: number }[]} */
  const events = [];

  let match;
  CREATE_POLICY_PATTERN.lastIndex = 0;
  while ((match = CREATE_POLICY_PATTERN.exec(rawSql)) !== null) {
    const [statement, policy, table] = match;
    events.push({ kind: 'create', key: `${table.toLowerCase()}::${policy}`, table, policy, statement, index: match.index });
  }
  DROP_POLICY_PATTERN.lastIndex = 0;
  while ((match = DROP_POLICY_PATTERN.exec(rawSql)) !== null) {
    const [statement, policy, table] = match;
    events.push({ kind: 'drop', key: `${table.toLowerCase()}::${policy}`, table, policy, statement, index: match.index });
  }

  // Replay in document order == migration order (caller concatenates sorted files).
  events.sort((a, b) => a.index - b.index);
  for (const event of events) {
    if (event.kind === 'create') surviving.set(event.key, event);
    else surviving.delete(event.key);
  }

  const offenders = [];
  for (const { table, policy, statement, index } of surviving.values()) {
    if (/auth\.uid\s*\(\s*\)/i.test(statement)) continue;
    if (/rls-scope-exempt\s*:/i.test(statement)) continue;
    // Allow the exemption comment on the line(s) directly above the
    // statement, or trailing on the same line after the terminating ';'.
    const preceding = rawSql.slice(Math.max(0, index - 240), index);
    const precedingLines = preceding.split('\n').slice(-3).join('\n');
    if (/rls-scope-exempt\s*:/i.test(precedingLines)) continue;
    const statementEnd = index + statement.length;
    const restOfLine = rawSql.slice(statementEnd, rawSql.indexOf('\n', statementEnd) === -1 ? undefined : rawSql.indexOf('\n', statementEnd));
    if (/rls-scope-exempt\s*:/i.test(restOfLine)) continue;
    offenders.push({ table, policy, statement });
  }
  return offenders;
}
