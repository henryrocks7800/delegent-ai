"""Execute migration 0073 on disposable, loopback-only PostgreSQL.

Run with PGHOST=127.0.0.1 PGDATABASE=delegent_review_test and optional
PGPORT, PGUSER, PGPASSWORD. Requires psycopg[binary]. Never accepts production.

The migration collapses a runaway audit log and makes the runaway impossible to
write again. Both halves are checked here by running the shipped SQL, because
the fault it answers (511,861 rows from 107 distinct denials) was produced by
code that every unit test was happy with.
"""
from datetime import timezone
import os
from pathlib import Path
import unittest
import psycopg

ROOT = Path(__file__).resolve().parents[2]
A = '11111111-2222-4333-8444-555555555555'
B = '22222222-2222-4333-8444-555555555555'


def connect():
    if os.environ.get('PGHOST') != '127.0.0.1' or os.environ.get('PGDATABASE') != 'delegent_review_test':
        raise RuntimeError('This test requires its named disposable loopback database')
    return psycopg.connect(host='127.0.0.1', dbname='delegent_review_test',
                           autocommit=True, options='-c statement_timeout=25000')


class UsageViolationDedupe(unittest.TestCase):
    def setUp(self):
        with connect() as conn, conn.cursor() as cursor:
            cursor.execute('select count(*) from information_schema.tables '
                           "where table_schema = 'public'")
            if cursor.fetchone()[0]:
                raise RuntimeError('public schema is not empty; reset the fixture first')
            # The minimum of 0026 this migration needs. Deliberately not the
            # whole file: the point is to exercise 0073, not to re-test 0026.
            cursor.execute("""
                create table public.usage_violations (
                  id bigserial primary key,
                  user_id uuid not null,
                  cap_kind text not null,
                  requested integer,
                  available integer,
                  billing_cycle_start timestamptz,
                  notes text,
                  occurred_at timestamptz not null default now()
                );
            """)

    def tearDown(self):
        with connect() as conn, conn.cursor() as cursor:
            cursor.execute('drop schema public cascade; create schema public')

    def seed(self, rows):
        with connect() as conn, conn.cursor() as cursor:
            cursor.executemany(
                'insert into public.usage_violations (user_id, cap_kind, requested, available, occurred_at)'
                ' values (%s, %s, %s, %s, %s)', rows)

    def apply_migration(self):
        sql = (ROOT / 'supabase' / 'migrations' / '0073_usage_violation_dedupe.sql').read_text(encoding='utf-8')
        with connect() as conn, conn.cursor() as cursor:
            cursor.execute(sql)

    @staticmethod
    def utc(value):
        """occurred_at is a timestamptz and comes back in the SESSION timezone.

        Asserting on its local rendering makes the test pass or fail depending
        on who runs it and what month it is: this fixture returned 09:07+00 as
        10:07 under British Summer Time. Compare in UTC, which is also the
        reason the migration's own hour bucket converts before truncating.
        """
        return value.astimezone(timezone.utc).strftime('%H:%M')

    def rows(self, columns='user_id, cap_kind, requested, available, occurred_at'):
        with connect() as conn, conn.cursor() as cursor:
            cursor.execute(f'select {columns} from public.usage_violations order by occurred_at, id')
            return cursor.fetchall()

    def test_collapses_a_repeated_denial_to_the_earliest_of_each_hour(self):
        # The real shape: one denial that could never succeed, retried every few
        # seconds. Two hours of it, plus a genuinely different denial that must
        # survive untouched.
        rows = []
        for hour, minutes in ((9, range(0, 60, 5)), (10, range(0, 60, 5))):
            for minute in minutes:
                rows.append((A, 'token', 28266, 22677, f'2026-08-20 {hour:02d}:{minute:02d}:00+00'))
        rows.append((A, 'token', 25052, 22677, '2026-08-20 09:30:00+00'))
        rows.append((B, 'storage', 0, 5, '2026-08-20 09:30:00+00'))
        self.seed(rows)
        self.assertEqual(len(self.rows()), 26)

        self.apply_migration()

        kept = self.rows()
        # One per (user, kind, requested, available, hour): two hours of the
        # repeated denial, plus the two one-offs.
        self.assertEqual(len(kept), 4)
        self.assertEqual(
            sorted((str(r[0]), r[1], r[2], self.utc(r[4])) for r in kept),
            sorted([(A, 'token', 28266, '09:00'), (A, 'token', 28266, '10:00'),
                    (A, 'token', 25052, '09:30'), (B, 'storage', 0, '09:30')]))

    def test_the_row_kept_is_the_first_refusal_of_the_hour(self):
        self.seed([(A, 'token', 100, 1, '2026-08-20 09:41:00+00'),
                   (A, 'token', 100, 1, '2026-08-20 09:07:00+00'),
                   (A, 'token', 100, 1, '2026-08-20 09:59:00+00')])
        self.apply_migration()
        kept = self.rows()
        self.assertEqual(len(kept), 1)
        # The first refusal in the hour is the one whose timestamp means
        # something; an arbitrary survivor would misreport when it started.
        self.assertEqual(self.utc(kept[0][4]), '09:07')

    def test_a_denial_already_recorded_this_hour_cannot_be_written_again(self):
        self.seed([(A, 'token', 28266, 22677, '2026-08-20 09:00:00+00')])
        self.apply_migration()
        with connect() as conn, conn.cursor() as cursor:
            with self.assertRaises(psycopg.errors.UniqueViolation):
                cursor.execute('insert into public.usage_violations (user_id, cap_kind, requested, available, occurred_at)'
                               " values (%s, 'token', 28266, 22677, '2026-08-20 09:59:59+00')", (A,))
        # The Worker's insert is best-effort and ignores the response, so this
        # refusal costs the user's request nothing.
        self.assertEqual(len(self.rows()), 1)

    def test_the_next_hour_and_a_different_denial_are_both_still_recorded(self):
        self.seed([(A, 'token', 28266, 22677, '2026-08-20 09:00:00+00')])
        self.apply_migration()
        with connect() as conn, conn.cursor() as cursor:
            cursor.executemany(
                'insert into public.usage_violations (user_id, cap_kind, requested, available, occurred_at)'
                ' values (%s, %s, %s, %s, %s)',
                [(A, 'token', 28266, 22677, '2026-08-20 10:00:00+00'),   # next hour
                 (A, 'token', 99999, 22677, '2026-08-20 09:10:00+00'),   # different ask
                 (A, 'storage', 28266, 22677, '2026-08-20 09:10:00+00'), # different cap
                 (B, 'token', 28266, 22677, '2026-08-20 09:10:00+00')])  # different person
        self.assertEqual(len(self.rows()), 5)

    def test_null_amounts_collapse_too(self):
        # Without NULLS NOT DISTINCT every NULL is unique, and the same loop
        # would simply write NULLs forever instead.
        self.seed([(A, 'global_spend', None, None, '2026-08-20 09:00:00+00'),
                   (A, 'global_spend', None, None, '2026-08-20 09:30:00+00')])
        self.apply_migration()
        self.assertEqual(len(self.rows()), 1)
        with connect() as conn, conn.cursor() as cursor:
            with self.assertRaises(psycopg.errors.UniqueViolation):
                cursor.execute('insert into public.usage_violations (user_id, cap_kind, requested, available, occurred_at)'
                               " values (%s, 'global_spend', null, null, '2026-08-20 09:45:00+00')", (A,))

    def test_the_hour_bucket_is_utc_whatever_the_session_timezone(self):
        # date_trunc on a timestamptz follows the session TimeZone, which is why
        # the column converts to UTC first. If it did not, the index would mean
        # something different depending on who connected.
        self.seed([(A, 'token', 5, 1, '2026-08-20 09:10:00+00')])
        self.apply_migration()
        with connect() as conn, conn.cursor() as cursor:
            for zone in ('UTC', 'Asia/Kathmandu', 'America/New_York'):
                cursor.execute(f"set time zone '{zone}'")
                cursor.execute('select occurred_hour from public.usage_violations')
                self.assertEqual(cursor.fetchone()[0].strftime('%Y-%m-%d %H:%M'), '2026-08-20 09:00', zone)


if __name__ == '__main__':
    unittest.main()
