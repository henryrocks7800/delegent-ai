// Supabase, from 2026-10-30 (their notice of 2026-09-23, "New tables in public
// need explicit grants from October 30"): a table created in `public` after that
// date gets NO Data API privileges by default, not even for service_role. The
// Worker reaches every table through PostgREST with the service-role key, so a
// new table without an explicit grant would fail every read and write the
// moment its migration ran, with no error until the first request. Tables that
// already exist keep their grants, so the rule starts at the first migration
// written after the notice.
export const GRANTS_REQUIRED_FROM_MIGRATION = 77;

const normalise = (sql) => sql.toLowerCase().replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ');
const escape = (name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Tables a migration creates in `public` without granting them to service_role,
 * and identity or serial columns whose sequence is not granted either.
 * Returns [{ table, problem }]; empty means the migration is ready for the new default.
 */
export function findUngrantedPublicTables(sql) {
  const text = normalise(sql);
  const problems = [];
  for (const match of text.matchAll(/create table (?:if not exists )?public\.([a-z0-9_]+) ?\(/g)) {
    const table = match[1];
    const name = escape(table);
    const tableGranted = new RegExp(
      `grant [a-z, ]+ on (?:table )?(?:[a-z0-9_.]+, )*public\\.${name}(?:, [a-z0-9_.]+)* to [a-z_, ]*\\bservice_role\\b`,
    ).test(text) || /grant [a-z, ]+ on all tables in schema public to [a-z_, ]*\bservice_role\b/.test(text);
    if (!tableGranted) problems.push({ table, problem: 'no explicit grant to service_role' });

    const end = text.indexOf(');', match.index);
    const body = text.slice(match.index, end === -1 ? undefined : end);
    if (/generated (?:always|by default) as identity|\b(?:big|small)?serial\b/.test(body)) {
      const sequenceGranted = new RegExp(`grant [a-z, ]+ on sequence (?:[a-z0-9_.]+, )*public\\.${name}_[a-z0-9_]+_seq(?:, [a-z0-9_.]+)* to [a-z_, ]*\\bservice_role\\b`).test(text)
        || /grant [a-z, ]+ on all sequences in schema public to [a-z_, ]*\bservice_role\b/.test(text);
      if (!sequenceGranted) problems.push({ table, problem: 'identity or serial column without a sequence grant to service_role' });
    }
  }
  return problems;
}

/** The migration number from a file name such as 0077_something.sql, or NaN. */
export function migrationNumber(fileName) {
  return Number.parseInt(String(fileName).split(/[\\/]/).pop(), 10);
}
