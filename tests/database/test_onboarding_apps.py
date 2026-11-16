"""Prove app preferences stay account-scoped using the real migration on PostgreSQL."""
import os
from pathlib import Path
import unittest
import psycopg

ROOT = Path(__file__).resolve().parents[2]
A = '11111111-2222-4333-8444-555555555555'
B = '22222222-2222-4333-8444-555555555555'

def connect():
    if os.environ.get('PGHOST') != '127.0.0.1' or os.environ.get('PGDATABASE') != 'delegent_review_test':
        raise RuntimeError('Only the named disposable loopback database is permitted')
    return psycopg.connect(host='127.0.0.1', dbname='delegent_review_test', autocommit=True)

class OnboardingApps(unittest.TestCase):
    def setUp(self):
        with connect() as conn:
            self.assertEqual(conn.execute("select count(*) from pg_tables where schemaname='public'").fetchone()[0], 0)
            conn.execute("""
              do $$ begin
                if not exists(select from pg_roles where rolname='anon') then create role anon; end if;
                if not exists(select from pg_roles where rolname='authenticated') then create role authenticated; end if;
              end $$;
              create schema auth;
              create function auth.uid() returns uuid language sql stable as
                $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
              grant usage on schema public, auth to authenticated, anon;
              create table auth.users(id uuid primary key);
              create table profiles(id uuid primary key references auth.users(id) on delete cascade,
                email text not null, updated_at timestamptz default now());
              alter table profiles enable row level security;
            """)
            conn.execute('insert into auth.users values (%s), (%s)', (A, B))
            conn.execute((ROOT / 'supabase/migrations/0060_onboarding_goal.sql').read_text(encoding='utf-8'))
            conn.execute((ROOT / 'supabase/migrations/0075_onboarding_apps.sql').read_text(encoding='utf-8'))

    def tearDown(self):
        with connect() as conn:
            conn.execute('drop schema public cascade; create schema public; drop schema auth cascade')

    def rpc(self, user, name, ids=None, role='authenticated'):
        with connect() as conn:
            conn.execute(f'set role {role}')
            conn.execute("select set_config('request.jwt.claim.sub', %s, false)", (user or '',))
            if name == 'set':
                return conn.execute('select set_my_onboarding_apps(%s::text[])', (ids,)).fetchone()[0]
            return conn.execute('select get_my_onboarding_apps()').fetchone()[0]

    def test_own_account_roundtrip_isolation_deduplication_and_legacy_goal(self):
        self.rpc(A, 'set', ['gmail', 'dropbox', 'gmail'])
        self.assertEqual(self.rpc(A, 'get'), ['dropbox', 'gmail'])
        self.assertIsNone(self.rpc(B, 'get'))
        self.rpc(B, 'set', ['slack'])
        self.assertEqual(self.rpc(A, 'get'), ['dropbox', 'gmail'])
        with connect() as conn:
            self.assertEqual(conn.execute('select onboarding_goal from profiles where id=%s', (A,)).fetchone()[0], 'something_else')
        self.rpc(A, 'set', [])
        self.assertEqual(self.rpc(A, 'get'), [])

    def test_invalid_ids_nulls_dimensions_and_oversized_selection_rejected(self):
        for ids in [None, ['unknown'], [None], ['gmail'] * 51, [['gmail']]]:
            with self.subTest(ids=ids), self.assertRaises(psycopg.errors.InvalidParameterValue):
                self.rpc(A, 'set', ids)
        self.assertIsNone(self.rpc(A, 'get'))

    def test_anonymous_and_missing_identity_cannot_write(self):
        with self.assertRaises(psycopg.errors.InsufficientPrivilege):
            self.rpc(A, 'set', ['gmail'], role='anon')
        with self.assertRaises(psycopg.errors.InsufficientPrivilege):
            self.rpc(A, 'get', role='anon')
        with self.assertRaises(psycopg.errors.InvalidAuthorizationSpecification):
            self.rpc(None, 'set', ['gmail'])
        self.assertIsNone(self.rpc(None, 'get'))

    def test_account_erasure_removes_preferences(self):
        self.rpc(A, 'set', ['gmail'])
        with connect() as conn:
            conn.execute('delete from auth.users where id=%s', (A,))
            self.assertEqual(conn.execute('select count(*) from profiles').fetchone()[0], 0)

if __name__ == '__main__':
    unittest.main(verbosity=2)
