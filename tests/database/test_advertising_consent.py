"""Exercise the shipped consent SQL, including races, on disposable PostgreSQL."""
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import time
import unittest
import psycopg

ROOT = Path(__file__).resolve().parents[2]
A = '11111111-2222-4333-8444-555555555555'
B = '22222222-2222-4333-8444-555555555555'

def connect():
    if os.environ.get('PGHOST') != '127.0.0.1' or os.environ.get('PGDATABASE') != 'delegent_review_test':
        raise RuntimeError('Only the named disposable loopback database is permitted')
    return psycopg.connect(host='127.0.0.1', dbname='delegent_review_test',
                          autocommit=True, options='-c statement_timeout=25000')

def query(sql, params=()):
    with connect() as conn:
        return conn.execute(sql, params).fetchall()

class AdvertisingConsent(unittest.TestCase):
    def setUp(self):
        with connect() as conn:
            self.assertEqual(conn.execute("select count(*) from information_schema.tables where table_schema='public'").fetchone()[0], 0)
            conn.execute("""
              do $$ begin
                if not exists(select from pg_roles where rolname='anon') then create role anon; end if;
                if not exists(select from pg_roles where rolname='authenticated') then create role authenticated; end if;
                if not exists(select from pg_roles where rolname='service_role') then create role service_role; end if;
              end $$;
              create schema if not exists auth;
              create table auth.users(id uuid primary key);
              create table public.profiles(id uuid primary key references auth.users(id) on delete cascade);
            """)
            for pattern in ['0051_*.sql', '0057_*.sql', '0058_*.sql', '0072_*.sql']:
                files = list((ROOT / 'supabase/migrations').glob(pattern))
                self.assertEqual(len(files), 1)
                conn.execute(files[0].read_text(encoding='utf-8'))
            conn.execute('insert into auth.users values (%s), (%s)', (A, B))
            conn.execute('insert into profiles(id) values (%s), (%s)', (A, B))
            conn.execute('update profiles set advertising_consent = true where id=%s', (A,))
            for user in (A, B):
                conn.execute('insert into install_attribution(user_id,raw_referrer,utm_campaign,fbclid) values (%s,%s,%s,%s)',
                             (user, 'fbclid=secret&gclid=hidden&utm_content=encrypted', 'campaign', 'FIRST_CLICK'))
            conn.execute((ROOT / 'supabase/migrations/0074_advertising_consent_boundary.sql').read_text(encoding='utf-8'))

    def tearDown(self):
        with connect() as conn:
            conn.execute('drop schema public cascade; create schema public; drop schema auth cascade')

    def consent(self, user, granted):
        return query('select set_advertising_consent(%s,%s)', (user, granted))[0][0]

    def capture(self, user, click='REINSTALL_CLICK'):
        return query('select record_consented_install_attribution(%s,%s::jsonb)',
                     (user, json.dumps({'raw_referrer': 'fbclid=secret&gclid=hidden', 'fbclid': click,
                                       'utm_campaign': 'new-campaign', 'unknown_click_id': 'hidden'})))[0][0]

    def test_scrubs_historical_raw_and_nonconsented_clicks_preserving_campaign(self):
        self.assertEqual(query('select raw_referrer,utm_campaign,fbclid from install_attribution order by user_id'),
                         [('', 'campaign', 'FIRST_CLICK'), ('', 'campaign', None)])

    def test_withdrawal_erases_click_and_all_reads_fail_closed(self):
        self.assertTrue(self.consent(A, False))
        self.assertEqual(query('select raw_referrer,fbclid from install_attribution where user_id=%s', (A,)), [('', None)])
        self.assertEqual(query('select * from get_consented_install_attribution(%s)', (A,)), [])
        self.assertFalse(self.capture(A))
        self.assertFalse(self.capture(B))

    def test_first_capture_wins_even_after_withdrawal_and_regrant(self):
        self.assertTrue(self.capture(A))
        self.assertEqual(query('select fbclid from install_attribution where user_id=%s', (A,)), [('FIRST_CLICK',)])
        self.consent(A, False); self.consent(A, True); self.assertTrue(self.capture(A))
        self.assertEqual(query('select fbclid from install_attribution where user_id=%s', (A,)), [(None,)])

    def test_legacy_direct_insert_obeys_consent_and_drops_unknown_raw_fields(self):
        with connect() as conn:
            conn.execute('delete from install_attribution')
            conn.execute('insert into install_attribution(user_id,raw_referrer,fbclid) values (%s,%s,%s)', (B, 'gclid=HIDDEN', 'CLICK_ID'))
            self.assertEqual(conn.execute('select count(*) from install_attribution').fetchone()[0], 0)
            conn.execute('insert into install_attribution(user_id,raw_referrer,fbclid) values (%s,%s,%s)', (A, 'gclid=HIDDEN', 'CLICK_ID'))
            self.assertEqual(conn.execute('select raw_referrer,fbclid from install_attribution').fetchall(), [('', 'CLICK_ID')])

    def test_a_delayed_grant_and_duplicate_grant_cannot_override_withdrawal(self):
        def intent(device, revision, granted):
            return query('select set_advertising_consent_versioned(%s,%s,%s,%s)', (A, granted, device, revision))[0][0]
        self.assertTrue(intent('phone', 2, True))
        self.assertTrue(intent('phone', 3, False))
        self.assertFalse(intent('phone', 2, True))
        self.assertTrue(intent('phone', 3, False))
        self.assertTrue(intent('phone', 4, True))
        self.assertTrue(intent('tablet', 1, False))
        self.assertFalse(intent('phone', 4, True), 'replay must not override the other device')
        self.assertFalse(query('select advertising_consent from profiles where id=%s', (A,))[0][0])

    def test_concurrent_capture_waits_for_withdrawal_and_cannot_restore_click(self):
        with connect() as first, ThreadPoolExecutor(1) as pool:
            first.execute('begin')
            first.execute('select set_advertising_consent(%s,false)', (A,))
            pending = pool.submit(self.capture, A)
            time.sleep(0.15)
            self.assertFalse(pending.done(), 'capture must wait on the same profile lock')
            first.execute('commit')
            self.assertFalse(pending.result(timeout=5))
        self.assertEqual(query('select fbclid from install_attribution where user_id=%s', (A,)), [(None,)])

    def test_withdrawal_waits_for_capture_then_clears_it(self):
        with connect() as first, ThreadPoolExecutor(1) as pool:
            first.execute('delete from install_attribution where user_id=%s', (A,))
            first.execute('begin')
            first.execute('select record_consented_install_attribution(%s,%s::jsonb)', (A, '{"fbclid":"NEW_CLICK"}'))
            pending = pool.submit(self.consent, A, False)
            time.sleep(0.15)
            self.assertFalse(pending.done())
            first.execute('commit')
            self.assertTrue(pending.result(timeout=5))
        self.assertEqual(query('select fbclid,raw_referrer from install_attribution where user_id=%s', (A,)), [(None, '')])

    def test_client_roles_cannot_access_new_records_or_functions_and_deletion_cascades(self):
        for role in ('anon', 'authenticated'):
            self.assertFalse(query("select has_table_privilege(%s,'advertising_consent_devices','SELECT')", (role,))[0][0])
            for fn in ('record_consented_install_attribution(uuid,jsonb)', 'get_consented_install_attribution(uuid)',
                       'set_advertising_consent_versioned(uuid,boolean,text,bigint)'):
                self.assertFalse(query('select has_function_privilege(%s,%s,\'EXECUTE\')', (role, fn))[0][0])
        query('select set_advertising_consent_versioned(%s,false,\'phone\',1)', (A,))
        with connect() as conn:
            conn.execute('delete from auth.users where id=%s', (A,))
        self.assertEqual(query('select count(*) from advertising_consent_devices'), [(0,)])

if __name__ == '__main__':
    unittest.main(verbosity=2)
