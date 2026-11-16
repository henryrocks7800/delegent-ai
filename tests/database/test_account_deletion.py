"""Execute the shipped account-erasure SQL on disposable, loopback-only PostgreSQL.

Run with PGHOST=127.0.0.1 PGDATABASE=delegent_review_test and optional
PGPORT, PGUSER, PGPASSWORD. Requires psycopg[binary]. Never accepts production.

These run the ACTUAL functions from supabase/migrations/0028 and 0071 against a
real server. The three defects they cover were each confirmed against the live
functions first: a retry colliding with the open-request index before it could
reach auth deletion, a Fly teardown reporting `completed` with the auth user
still present, and an expired claimant completing a newer claimant's row.
"""
import json
import os
from pathlib import Path
import unittest
import psycopg

ROOT = Path(__file__).resolve().parents[2]
A = '11111111-3333-4333-8444-555555555555'
B = '22222222-3333-4333-8444-555555555555'


def sql(statement, *, failure=False):
    if os.environ.get('PGHOST') != '127.0.0.1' or os.environ.get('PGDATABASE') != 'delegent_review_test':
        raise RuntimeError('This test requires its named disposable loopback database')
    try:
        with psycopg.connect(host='127.0.0.1', dbname='delegent_review_test',
                             autocommit=True, options='-c statement_timeout=25000') as conn:
            with conn.cursor() as cursor:
                cursor.execute(statement)
                output = []
                while True:
                    if cursor.description:
                        output.extend(json.dumps(row[0]) if isinstance(row[0], dict) else str(row[0])
                                      for row in cursor.fetchall())
                    if not cursor.nextset():
                        break
        if failure:
            raise AssertionError('Expected SQL rejection')
        return '\n'.join(output)
    except psycopg.Error as exc:
        if failure:
            return str(exc)
        raise


def literal(value):
    return "'" + str(value).replace("'", "''") + "'"


def open_request(user=A, email='fixture@example.test', snapshot='{}'):
    return json.loads(sql(f"""
        select row_to_json(r) from public.open_account_deletion_request(
          {literal(user)}::uuid, {literal(email)}, 'mobile_app',
          now() + interval '24 hours', '{{}}'::jsonb, {literal(snapshot)}::jsonb) r;
    """))


def claim():
    rows = sql("select row_to_json(r) from public.claim_next_account_deletion_request() r;")
    return json.loads(rows) if rows else None


def row(request_id):
    return json.loads(sql(f"""
        select row_to_json(r) from (
          select status, completed_at, processing_token, auth_deleted_at, connections_cleared_at,
                 infrastructure_cleared_at, pending_cleanup, cleanup_attempts
            from public.account_deletion_requests where id = {literal(request_id)}::uuid) r;
    """))


def phase(request_id, token, name, pending=None):
    pending_sql = 'null' if pending is None else f"{literal(pending)}::jsonb"
    return sql(f"""
        select public.record_account_deletion_phase(
          {literal(request_id)}::uuid, {literal(token)}::uuid, {literal(name)}, {pending_sql});
    """)


def complete(request_id, token):
    return sql(f"""
        select public.record_account_deletion_request_completed(
          {literal(request_id)}::uuid, {literal(token)}::uuid, '{{"provider":"fly_machines"}}'::jsonb);
    """)


class AccountDeletionDatabaseTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if sql("select count(*) from pg_tables where schemaname='public'") != '0':
            raise RuntimeError('Use an empty disposable test database')
        sql("""
          create role anon nologin; create role authenticated nologin; create role service_role nologin;
          create schema auth;
          create table auth.users(id uuid primary key);
          create function public.set_updated_at() returns trigger language plpgsql as
            $$ begin new.updated_at = now(); return new; end $$;
          create table public.connection_oauth_flows(
            state text primary key, user_id uuid not null, provider text not null,
            code_verifier text not null, return_surface text not null,
            created_at timestamptz not null default now(),
            expires_at timestamptz not null, consumed_at timestamptz);
        """)
        for name in ['0028_account_deletion_requests.sql', '0071_resumable_account_deletion.sql']:
            sql((ROOT / 'supabase/migrations' / name).read_text(encoding='utf-8'))

    def setUp(self):
        sql('delete from public.account_deletion_requests;')

    # --- PASS7-1 -----------------------------------------------------------

    def test_asking_twice_reuses_the_open_request_instead_of_colliding(self):
        # The live reproduction: the endpoint's insert hit the open-request
        # unique index with 23505, so somebody whose first attempt died on a
        # 503 could never get through at all.
        first = open_request()
        second = open_request()
        self.assertEqual(first['id'], second['id'], 'a retry must reuse the request it already has')
        self.assertEqual(sql(f"select count(*) from public.account_deletion_requests where user_id={literal(A)}::uuid"), '1')
        # And a second person is unaffected.
        self.assertNotEqual(open_request(B)['id'], first['id'])

    def test_a_later_attempt_fills_in_a_snapshot_the_first_one_never_had(self):
        # An empty snapshot is exactly the state that produced a teardown
        # reporting success with nothing torn down.
        first = open_request(snapshot='{}')
        self.assertEqual(first['teardown_snapshot'], {})
        second = open_request(snapshot='{"private_teardown_target":{"provider":"fly_machines"}}')
        self.assertEqual(second['id'], first['id'])
        self.assertEqual(second['teardown_snapshot']['private_teardown_target']['provider'], 'fly_machines')
        # But a later EMPTY snapshot cannot erase one we already had.
        third = open_request(snapshot='{}')
        self.assertEqual(third['teardown_snapshot']['private_teardown_target']['provider'], 'fly_machines')

    def test_infrastructure_teardown_alone_cannot_report_an_account_erased(self):
        # The defect in one test. Fly teardown finished, the request said
        # completed, and the person could still sign in.
        request = open_request()
        claimed = claim()
        token = claimed['processing_token']
        self.assertEqual(phase(request['id'], token, 'infrastructure'), 'True')
        self.assertEqual(complete(request['id'], token), 'False', 'auth is still there')
        self.assertEqual(row(request['id'])['status'], 'processing')

        self.assertEqual(phase(request['id'], token, 'auth'), 'True')
        self.assertEqual(complete(request['id'], token), 'False', 'the connectors are still owed')
        self.assertEqual(phase(request['id'], token, 'connections', '[]'), 'True')
        self.assertEqual(complete(request['id'], token), 'True')
        self.assertEqual(row(request['id'])['status'], 'completed')

    def test_a_failed_claim_is_picked_up_again_with_its_phases_intact(self):
        request = open_request()
        first = claim()
        self.assertEqual(phase(request['id'], first['processing_token'], 'auth'), 'True')
        sql(f"update public.account_deletion_requests set status='failed', processing_expires_at=null where id={literal(request['id'])}::uuid;")
        second = claim()
        self.assertEqual(second['id'], request['id'])
        self.assertIsNotNone(second['auth_deleted_at'], 'work already done is not repeated')
        self.assertNotEqual(second['processing_token'], first['processing_token'], 'a new claim is a new token')

    # --- PASS7-2 -----------------------------------------------------------

    def test_what_a_broker_still_owes_outlives_the_account(self):
        # The old evidence lived in provisioning_events, which the same
        # auth/profile cascade deleted. This table has no foreign key to the
        # account on purpose, so the record survives the erasure it describes.
        request = open_request()
        sql(f"insert into auth.users values ({literal(A)}::uuid);")
        owed = '[{"broker":"composio","account_id":"ca_stuck"}]'
        self.assertEqual(sql(f"""
            select public.record_account_deletion_origin_progress(
              {literal(request['id'])}::uuid, {literal(A)}::uuid, {literal(owed)}::jsonb, true, true);
        """), 'True')
        sql(f"delete from auth.users where id={literal(A)}::uuid;")
        after = row(request['id'])
        self.assertEqual(after['pending_cleanup'][0]['account_id'], 'ca_stuck')
        self.assertIsNotNone(after['auth_deleted_at'])
        self.assertIsNone(after['connections_cleared_at'], 'a sweep with work still owed has not finished')

        claimed = claim()
        self.assertEqual(phase(request['id'], claimed['processing_token'], 'infrastructure'), 'True')
        self.assertEqual(complete(request['id'], claimed['processing_token']), 'False',
                         'a grant still live at a broker is not a completed erasure')
        # The retry succeeds and the phase closes.
        self.assertEqual(phase(request['id'], claimed['processing_token'], 'connections', '[]'), 'True')
        self.assertEqual(complete(request['id'], claimed['processing_token']), 'True')
        self.assertEqual(row(request['id'])['cleanup_attempts'], 1)

    def test_the_request_endpoint_can_only_write_to_its_own_account(self):
        mine = open_request(A)
        self.assertEqual(sql(f"""
            select public.record_account_deletion_origin_progress(
              {literal(mine['id'])}::uuid, {literal(B)}::uuid, null, true, true);
        """), 'False')
        self.assertIsNone(row(mine['id'])['auth_deleted_at'])

    # --- PASS7-3 -----------------------------------------------------------

    def test_an_expired_claimant_cannot_finish_a_newer_claimant_work(self):
        # Live SQL allowed exactly this: completion took only the request id.
        request = open_request()
        stale = claim()
        sql(f"update public.account_deletion_requests set processing_expires_at = now() - interval '1 minute' where id={literal(request['id'])}::uuid;")
        fresh = claim()
        self.assertEqual(fresh['id'], request['id'])
        self.assertNotEqual(fresh['processing_token'], stale['processing_token'])

        for name in ['auth', 'infrastructure']:
            self.assertEqual(phase(request['id'], stale['processing_token'], name), 'False',
                             'the retired claimant may not record progress either')
        self.assertEqual(complete(request['id'], stale['processing_token']), 'False')
        self.assertEqual(row(request['id'])['status'], 'processing')

        for name in ['auth', 'infrastructure']:
            self.assertEqual(phase(request['id'], fresh['processing_token'], name), 'True')
        self.assertEqual(phase(request['id'], fresh['processing_token'], 'connections', '[]'), 'True')
        self.assertEqual(complete(request['id'], fresh['processing_token']), 'True')

    def test_a_completed_request_cannot_be_reopened_or_re_completed(self):
        request = open_request()
        claimed = claim()
        for name in ['auth', 'infrastructure']:
            phase(request['id'], claimed['processing_token'], name)
        phase(request['id'], claimed['processing_token'], 'connections', '[]')
        self.assertEqual(complete(request['id'], claimed['processing_token']), 'True')
        self.assertEqual(complete(request['id'], claimed['processing_token']), 'False')
        self.assertIsNone(claim(), 'a finished request is not claimed again')

    def test_an_unknown_phase_is_refused_rather_than_silently_ignored(self):
        request = open_request()
        claimed = claim()
        self.assertEqual(phase(request['id'], claimed['processing_token'], 'everything'), 'False')
        self.assertEqual(complete(request['id'], claimed['processing_token']), 'False')

    def test_the_unfenced_completion_function_is_gone(self):
        # Leaving the old two-argument form reachable would be an unfenced way
        # to declare an account erased, which is the defect.
        self.assertEqual(sql("""
            select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname='public' and p.proname='record_account_deletion_request_completed'
        """), '1')
        self.assertEqual(sql("""
            select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname='public' and p.proname='purge_expired_connection_flows'
        """), '1', 'one signature only, or PostgREST cannot tell them apart')

    # --- PASS7-6 -----------------------------------------------------------

    def test_the_flow_purge_is_bounded_and_leaves_live_handshakes_alone(self):
        sql("delete from public.connection_oauth_flows;")
        sql("""
          insert into public.connection_oauth_flows(state, user_id, provider, code_verifier, return_surface, expires_at, consumed_at)
          select 'expired-' || g, '11111111-3333-4333-8444-555555555555'::uuid, 'freeagent', 'v', 'app',
                 now() - interval '2 hours', null
            from generate_series(1, 5) g;
          insert into public.connection_oauth_flows(state, user_id, provider, code_verifier, return_surface, expires_at, consumed_at)
          values ('live-one', '11111111-3333-4333-8444-555555555555'::uuid, 'freeagent', 'v', 'app',
                  now() + interval '10 minutes', null),
                 ('spent-recently', '11111111-3333-4333-8444-555555555555'::uuid, 'freeagent', 'v', 'app',
                  now() + interval '10 minutes', now());
        """)
        self.assertEqual(sql("select public.purge_expired_connection_flows(2)"), '2', 'the bound is respected')
        self.assertEqual(sql("select public.purge_expired_connection_flows()"), '3')
        self.assertEqual(sql("select public.purge_expired_connection_flows()"), '0')
        remaining = sql("select state from public.connection_oauth_flows order by state").split('\n')
        self.assertEqual(remaining, ['live-one', 'spent-recently'],
                         'a handshake in flight, and one spent minutes ago, both stay')


if __name__ == '__main__':
    unittest.main(verbosity=2)
