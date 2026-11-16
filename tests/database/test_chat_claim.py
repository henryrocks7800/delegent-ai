"""Execute the shipped SQL on disposable, loopback-only PostgreSQL.

Run with PGHOST=127.0.0.1 PGDATABASE=delegent_review_test and optional
PGPORT, PGUSER, PGPASSWORD. Requires psycopg[binary]. Never accepts production.
"""
import concurrent.futures
import json
import os
from pathlib import Path
import threading
import unittest
import psycopg

ROOT = Path(__file__).resolve().parents[2]
A = '11111111-2222-4333-8444-555555555555'
B = '22222222-2222-4333-8444-555555555555'
C = '33333333-2222-4333-8444-555555555555'


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
                        output.extend(json.dumps(row[0]) if isinstance(row[0], dict) else str(row[0]) for row in cursor.fetchall())
                    if not cursor.nextset():
                        break
        if failure:
            raise AssertionError('Expected SQL rejection')
        return '\n'.join(output)
    except psycopg.Error as exc:
        if failure:
            return str(exc)
        raise


def claim(user=A, key='same-send', instruction='hello', attachments='[]', *, failure=False):
    # All inputs are fixed test values. Quotes are still escaped for invalid-input tests.
    literal = lambda value: "'" + value.replace("'", "''") + "'"
    return sql(f"""set role authenticated;
        set request.jwt.claim.sub = {literal(user)};
        select row_to_json(r) from public.claim_chat_message(
          {literal(instruction)}, {literal(attachments)}::jsonb, {literal(key)}) r;
    """, failure=failure)


class ChatClaimDatabaseTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Minimal relational fixture, real enqueue and claim functions below.
        # Refuse to overwrite a nonempty public schema even in the test database.
        if sql("select count(*) from pg_tables where schemaname='public'") != '0':
            raise RuntimeError('Use an empty disposable test database')
        sql("""
          create role anon nologin; create role authenticated nologin; create role service_role nologin;
          create schema auth;
          create function auth.uid() returns uuid language sql stable as
            $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
          grant usage on schema auth to authenticated;
          create table public.subscriptions(user_id uuid primary key, status text not null);
          create table public.messages(
            id uuid primary key default gen_random_uuid(), user_id uuid not null,
            conversation_id uuid not null, role text not null, content text not null,
            attachment_metadata jsonb not null, status text not null,
            created_at timestamptz not null, task_run_id uuid);
          create table public.task_runs(
            id uuid primary key default gen_random_uuid(), user_id uuid not null,
            message_id uuid not null references public.messages(id), status text not null,
            instruction text not null, kind text not null, created_at timestamptz not null,
            updated_at timestamptz not null, client_run_id text);
          alter table public.messages add foreign key(task_run_id) references public.task_runs(id);
          create unique index task_runs_client_run_id on public.task_runs(user_id, client_run_id)
            where client_run_id is not null;
        """)
        sql(f"insert into public.subscriptions values ('{A}', 'active'), ('{B}', 'active'), ('{C}', 'canceled');")
        for name in ['0035_chat_message_cap_alignment.sql', '0063_atomic_chat_dispatch_claim.sql']:
            sql((ROOT / 'supabase/migrations' / name).read_text(encoding='utf-8'))

    def test_concurrent_claims_create_exactly_one_run_and_pair(self):
        barrier = threading.Barrier(16)
        def submit(_):
            barrier.wait(timeout=20)
            return json.loads(claim())
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            rows = list(pool.map(submit, range(16)))
        self.assertEqual(sum(row['claimed'] for row in rows), 1)
        for field in ['task_run_id', 'user_message_id', 'assistant_message_id']:
            self.assertEqual(len({row[field] for row in rows}), 1)
        self.assertEqual(sql(f"select count(*) from public.task_runs where user_id='{A}' and client_run_id='same-send'"), '1')
        self.assertEqual(sql(f"select count(*) from public.messages where user_id='{A}' and content in ('hello', '')"), '2')
        self.assertTrue(json.loads(claim(B))['claimed'], 'another tenant owns a separate key')
        self.assertTrue(json.loads(claim(A, 'another-send'))['claimed'], 'a new key starts a new run')

    def test_invalid_requests_rollback_and_cannot_claim(self):
        self.assertIn('instruction_required', claim(key='retry-invalid', instruction='', failure=True))
        self.assertIn('attachment_metadata_must_be_array', claim(key='retry-invalid', attachments='{}', failure=True))
        self.assertTrue(json.loads(claim(key='retry-invalid'))['claimed'])
        self.assertIn('invalid_client_run_id', claim(key=' ', failure=True))
        self.assertIn('invalid_client_run_id', claim(key='x' * 81, failure=True))
        self.assertIn('no_active_subscription', claim(C, failure=True))
        self.assertIn('unauthenticated', claim('', failure=True))
        self.assertIn('permission denied', sql("set role anon; select * from public.claim_chat_message('x');", failure=True))


class CompletionUsageDatabaseTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # ChatClaimDatabaseTest creates this disposable schema first.
        sql("""
          alter table public.messages add column updated_at timestamptz,
            add column tool_calls jsonb not null default '[]';
          alter table public.task_runs add column error_code text,
            add column completed_at timestamptz;
          create table public.artifacts(id uuid default gen_random_uuid(), user_id uuid,
            task_run_id uuid, title text, kind text, detail text, status text, created_at timestamptz);
          create table public.token_usage_events(id uuid primary key default gen_random_uuid(),
            user_id uuid not null, prompt_tokens integer not null, completion_tokens integer not null,
            total_tokens integer not null, source text not null, model text);
        """)
        sql((ROOT / 'supabase/migrations/0064_atomic_chat_completion_and_usage.sql').read_text(encoding='utf-8'))

    def test_concurrent_completion_has_one_winner_and_artifact(self):
        row = json.loads(claim(key='completion-race'))
        barrier = threading.Barrier(12)
        def finish(i):
            barrier.wait(timeout=20)
            value = sql(f"""set role service_role; select public.finalize_chat_message(
              '{row['assistant_message_id']}', '{row['task_run_id']}', 'answer-{i}',
              '[{{"title":"answer-{i}"}}]'::jsonb);""")
            return i, value
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
            results = list(pool.map(finish, range(12)))
        winners = [i for i, value in results if value == 'True']
        self.assertEqual(len(winners), 1, results)
        self.assertEqual(sql(f"select content from public.messages where id='{row['assistant_message_id']}'"), f'answer-{winners[0]}')
        self.assertEqual(sql(f"select count(*) from public.artifacts where task_run_id='{row['task_run_id']}'"), '1')
        self.assertEqual(sql(f"select title from public.artifacts where task_run_id='{row['task_run_id']}'"), f'answer-{winners[0]}')

    def test_finalizer_rejects_mismatched_message_and_unprivileged_call(self):
        a = json.loads(claim(key='completion-a'))
        b = json.loads(claim(B, key='completion-b'))
        args = f"'{a['assistant_message_id']}', '{b['task_run_id']}', 'wrong owner'"
        self.assertEqual(sql(f'set role service_role; select public.finalize_chat_message({args});'), 'False')
        self.assertIn('permission denied', sql(f'set role authenticated; select public.finalize_chat_message({args});', failure=True))
        self.assertEqual(sql(f"select status from public.task_runs where id='{b['task_run_id']}'"), 'queued')

    def test_usage_settlement_replay_conflict_and_ownership(self):
        reservation = sql(f"insert into public.token_usage_events(user_id,prompt_tokens,completion_tokens,total_tokens,source,model) values ('{A}',0,0,100,'worker_reservation','fixture') returning id")
        args = f"'{reservation}', '{A}', 100, 10, 67, 90, 0.00006, 'provider-fixture', 'request-fixture'"
        barrier = threading.Barrier(12)
        def settle(_):
            barrier.wait(timeout=20)
            return sql(f'set role service_role; select public.settle_chat_usage({args});')
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
            self.assertEqual(list(pool.map(settle, range(12))), ['True'] * 12)
        self.assertEqual(sql(f"select sum(total_tokens) from public.token_usage_events where id='{reservation}'"), '67')
        self.assertEqual(sql(f"select cached_tokens from public.token_usage_events where id='{reservation}'"), '90')
        self.assertEqual(sql(f"select provider_cost_usd from public.token_usage_events where id='{reservation}'"), '0.00006')
        self.assertIn('usage_settlement_conflict', sql(f"select public.settle_chat_usage('{reservation}','{A}',1,1,2)", failure=True))
        self.assertIn('usage_reservation_not_found', sql(f"select public.settle_chat_usage('{reservation}','{B}',100,10,67)", failure=True))
        self.assertIn('permission denied', sql(f'set role authenticated; select public.settle_chat_usage({args});', failure=True))

    def test_released_reservation_can_settle_but_cannot_be_reclaimed_afterwards(self):
        reservation = sql(f"insert into public.token_usage_events(user_id,prompt_tokens,completion_tokens,total_tokens,source,model) values ('{A}',0,0,0,'worker_reservation','fixture') returning id")
        self.assertEqual(sql(f"select public.settle_chat_usage('{reservation}','{A}',10,2,19)"), 'True')
        sql(f"update public.token_usage_events set total_tokens=0 where id='{reservation}' and source='worker_reservation'")
        self.assertEqual(sql(f"select total_tokens from public.token_usage_events where id='{reservation}'"), '19')


class FleetLifecycleDatabaseTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        sql("""
          alter table subscriptions add column tier_id text default 'studio';
          create table profiles(id uuid primary key, agent_name text);
          create table hermes_instances(user_id uuid primary key, status text, provider text,
            volume_retention_until timestamptz, suspended_at timestamptz, updated_at timestamptz,
            public_status_message text, error_code text, provisioning_idempotency_key text,
            provisioning_claimed_at timestamptz, provisioning_lease_expires_at timestamptz,
            provisioning_tier_id text, provisioning_requested_at timestamptz,
            base_url text, last_health_at timestamptz, ready_at timestamptz, error text,
            image_ref_label text,region_label text,storage_quota_gb integer,deleted_at timestamptz,
            check ((provisioning_claimed_at is null and provisioning_lease_expires_at is null)
              or (provisioning_claimed_at is not null and provisioning_lease_expires_at > provisioning_claimed_at)));
          create table hermes_instance_private(user_id uuid primary key, provider text,
            fly_org text,fly_app_name text,fly_machine_id text,fly_volume_id text,fly_region text,
            runner_base_url text,runner_shared_secret text,image_ref text,image_digest text,
            deleted_at timestamptz,updated_at timestamptz,railway_project_id text,railway_workflow_id text);
        """)
        original = (ROOT / 'supabase/migrations/0021_series4_fly_machines_runner_provider.sql').read_text(encoding='utf-8')
        start = original.index('create or replace function public.record_hermes_runner_deleted(')
        end = original.index('$$;', start) + 3
        sql(original[start:end])
        sql((ROOT / 'supabase/migrations/0032_reclaim_provisioning_after_deleted_private_binding.sql').read_text(encoding='utf-8'))
        sql((ROOT / 'supabase/migrations/0065_fleet_lifecycle_fences.sql').read_text(encoding='utf-8'))

    def setUp(self):
        sql('truncate hermes_instances,hermes_instance_private,subscriptions,profiles')
        self.at = sql("select date_trunc('milliseconds',now()-interval '2 hours')")
        sql(f"""
          insert into subscriptions(user_id,status) values ('{A}','canceled');
          insert into profiles values ('{A}','Fixture');
          insert into hermes_instances(user_id,status,updated_at,volume_retention_until,
            provisioning_idempotency_key,provisioning_claimed_at,provisioning_lease_expires_at,
            provisioning_tier_id,provider)
          values ('{A}','sleeping',now()-interval '2 hours',now()-interval '1 day',
            'same-intent','{self.at}',now()-interval '1 hour','studio','fly_machines');
          insert into hermes_instance_private(user_id,provider,fly_app_name,fly_machine_id,fly_volume_id,runner_base_url)
          values ('{A}','fly_machines','app_fixture','machine_fixture','volume_fixture','https://fixture.invalid');
        """)

    def claim(self):
        return sql('select claimed_at from public.claim_next_hermes_runner_grace_expired()')

    def guard(self, claim, finish=False):
        function = 'finish_hermes_grace_deletion' if finish else 'authorize_hermes_grace_deletion'
        return sql(f"select public.{function}('{A}','{claim}','app_fixture','machine_fixture','volume_fixture')")

    def transition(self, outcome, at=None):
        return sql(f"select public.transition_hermes_provisioning('{A}','same-intent','{at or self.at}',"
                   f"'{outcome}','https://fixture.invalid','fixture_error','Fixture','{at or self.at}')")

    def test_paid_workspace_never_claimed_and_renewal_cancels_unstarted_claim(self):
        sql(f"update subscriptions set status='active' where user_id='{A}'")
        self.assertEqual(self.claim(), '')
        sql(f"update subscriptions set status='canceled' where user_id='{A}'")
        claimed = self.claim()
        self.assertTrue(claimed)
        sql(f"update subscriptions set status='active' where user_id='{A}'")
        self.assertEqual(self.guard(claimed), 'False')
        self.assertEqual(sql('select status from hermes_instances'), 'sleeping')

    def test_started_delete_blocks_renewal_and_stale_claim_cannot_finish_recovery(self):
        claimed = self.claim()
        self.assertEqual(self.guard(claimed), 'True')
        self.assertIn('workspace_retirement_in_progress', sql("update subscriptions set status='active'", failure=True))
        sql("update hermes_instances set updated_at=now()-interval '1 hour'")
        replacement = self.claim()
        self.assertNotEqual(claimed, replacement)
        self.assertEqual(self.guard(claimed), 'False')
        self.assertEqual(self.guard(claimed, finish=True), 'False')
        self.assertEqual(self.guard(replacement, finish=True), 'True')
        sql("update subscriptions set status='active'")
        self.assertEqual(sql('select status from hermes_instances'), 'deleted')
        self.assertEqual(sql('select deletion_started_at is null from hermes_instances'), 'True')
        self.assertIn('permission denied', sql(f"set role service_role; select record_hermes_runner_deleted('{A}')", failure=True))

    def test_stale_readiness_and_failure_cannot_resurrect_cancellation(self):
        for outcome in ['ready','retry','reconcile']:
            self.assertEqual(self.transition(outcome), 'False')
        self.assertEqual(sql('select status from hermes_instances'), 'sleeping')
        sql("update subscriptions set status='active'; update hermes_instances set status='provisioning'")
        claimed = sql('select claimed_at from claim_next_series4_stuck_readiness(now(),300)')
        self.assertTrue(claimed)
        self.assertEqual(sql('select provisioning_claimed_at from hermes_instances'), claimed)
        self.assertNotEqual(claimed, self.at)
        self.assertEqual(self.transition('ready'), 'False')
        self.assertEqual(self.transition('ready', claimed), 'True')
        self.assertEqual(sql('select status from hermes_instances'), 'ready')

    def test_partial_creation_retries_preserve_intent_and_stop_after_five_failures(self):
        sql("update subscriptions set status='active'; update hermes_instances set status='provisioning'; delete from hermes_instance_private")
        claimed = self.at
        for attempt in range(1,6):
            self.assertEqual(self.transition('retry', claimed), 'True')
            self.assertEqual(sql('select provisioning_failure_count from hermes_instances'), str(attempt))
            self.assertEqual(sql('select provisioning_idempotency_key from hermes_instances'), 'same-intent')
            if attempt < 5:
                self.assertEqual(sql(f"select count(*) from claim_next_hermes_provisioning_job('{claimed}')"), '0')
                claimed = sql("select claimed_at from claim_next_hermes_provisioning_job((select provisioning_lease_expires_at+interval '1 second' from hermes_instances))")
                self.assertTrue(claimed)
        self.assertEqual(sql('select status from hermes_instances'), 'error')
        self.assertEqual(sql('select count(*) from claim_next_hermes_provisioning_job()'), '0')

    def test_binding_record_keeps_canceled_resources_for_cleanup_but_rejects_cleared_claim(self):
        args = f"'{A}','same-intent','{self.at}','org','app_fixture','machine_fixture','volume_fixture','lhr','https://fixture.invalid','fixture-secret','image','digest','image','lhr',10"
        self.assertEqual(sql(f'select record_hermes_fly_provisioning_output({args})'), 'True')
        self.assertEqual(sql('select status from hermes_instances'), 'sleeping')
        sql('update hermes_instances set provisioning_claimed_at=null,provisioning_lease_expires_at=null')
        self.assertEqual(sql(f'select record_hermes_fly_provisioning_output({args})'), 'False')
        self.assertIn('permission denied', sql(f"set role authenticated; select authorize_hermes_grace_deletion('{A}',now(),'app_fixture','machine_fixture','volume_fixture')", failure=True))

    def test_concurrent_grace_claims_have_one_winner(self):
        barrier = threading.Barrier(8)
        def claim(_):
            barrier.wait(timeout=20)
            return self.claim()
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            claims = list(pool.map(claim,range(8)))
        self.assertEqual(len([claim for claim in claims if claim]),1)

    def test_renewal_and_delete_authorization_cannot_both_win(self):
        for _ in range(8):
            self.setUp()
            claimed = self.claim()
            barrier = threading.Barrier(2)
            def authorize():
                barrier.wait(timeout=20)
                return self.guard(claimed)
            def renew():
                barrier.wait(timeout=20)
                try:
                    sql("update subscriptions set status='active'")
                    return 'renewed'
                except psycopg.Error as exc:
                    self.assertEqual(exc.sqlstate, '40001')
                    return 'retry'
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                deletion, renewal = pool.submit(authorize), pool.submit(renew)
                results = deletion.result(), renewal.result()
            self.assertIn(results, [('True','retry'),('False','renewed')])
            self.assertEqual(sql(f"select public.runner_has_entitlement('{A}') and deletion_started_at is not null from hermes_instances"), 'False')


class ZBillingTransactionDatabaseTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        sql("""
          truncate hermes_instances,hermes_instance_private,subscriptions,profiles;
          alter table subscriptions add column stripe_customer_id text,add column stripe_subscription_id text,
            add column price_id text,add column current_period_start timestamptz,add column current_period_end timestamptz,
            add column cancel_at_period_end boolean,add column provider_updated_at timestamptz,add column updated_at timestamptz;
          create table usage_quotas(user_id uuid primary key,tier_id text,monthly_token_quota integer,
            storage_quota_bytes bigint,voice_seconds_quota integer,provider_updated_at timestamptz,updated_at timestamptz,
            consumed_storage_bytes bigint default 0,consumed_voice_seconds integer default 0);
        """)
        sql((ROOT/'supabase/migrations/0054_apple_iap.sql').read_text(encoding='utf-8'))
        sql((ROOT/'supabase/migrations/0066_atomic_billing_entitlements.sql').read_text(encoding='utf-8'))
        # Columns used by the shipped product-state view, without provider traffic.
        sql("""
          alter table profiles add column email text,add column full_name text,add column avatar_url text,
            add column region text,add column created_at timestamptz default now(),add column updated_at timestamptz;
          alter table hermes_instances add column coworker_update_available boolean,add column coworker_update_status text,
            add column reimage_requested_at timestamptz,add column reimaged_at timestamptz;
          alter table token_usage_events add column created_at timestamptz default now();
          create table acknowledgements(user_id uuid,text_version text,accepted_at timestamptz);
          create table gateway_connections(id uuid,user_id uuid,gateway_id text,status text,
            connected_at timestamptz,disconnected_at timestamptz,updated_at timestamptz);
        """)
        sql((ROOT/'supabase/migrations/0055_product_state_billing_provider.sql').read_text(encoding='utf-8'))
        sql((ROOT/'supabase/migrations/0067_verified_service_deadlines.sql').read_text(encoding='utf-8'))
        sql((ROOT/'supabase/migrations/0068_coordinated_purchase_intents.sql').read_text(encoding='utf-8'))
        sql((ROOT/'supabase/migrations/0069_cancel_apple_purchase_intent.sql').read_text(encoding='utf-8'))

    def setUp(self):
        sql("""truncate billing_purchase_conflicts,billing_purchase_intents,acknowledgements,gateway_connections,token_usage_events,billing_payment_reversals,billing_entitlement_commits,billing_subscription_ownership,apple_iap_events,hermes_instances,hermes_instance_private,subscriptions,usage_quotas,profiles;
          drop trigger if exists billing_fixture_fail on hermes_instances;
          drop trigger if exists billing_fixture_fail on usage_quotas;""")
        sql(f"insert into profiles(id,agent_name) values ('{A}','Fixture A'),('{B}','Fixture B')")

    def apply(self, provider='stripe', *, user=A, external=None, status='active', switch=False, event='event-1',
              timestamp='2026-09-13T12:00:00Z', environment='Production', invoice=None,
              start='2026-09-13T00:00:00Z',end='2026-10-13T00:00:00Z',service_until='default',intent=None,failure=False):
        sub = dict(user_id=user,status=status,tier_id='studio',current_period_start=start,
          current_period_end=end,provider_updated_at=timestamp,cancel_at_period_end=False)
        if provider=='stripe':
            sub.update(stripe_customer_id='cus_fixture',stripe_subscription_id=external or 'sub_fixture',price_id='price_fixture')
            if invoice is not None: sub['stripe_entitlement_invoice_id']=invoice
        else:
            sub.update(apple_original_transaction_id=external or 'apple_fixture',apple_product_id='com.sidekick.v2.studio.monthly',apple_environment=environment,service_access_until=end if service_until=='default' else service_until)
        if intent is not None: sub['purchase_intent_id']=intent
        quota = dict(user_id=user,tier_id='studio',monthly_token_quota=19_550_000,storage_quota_bytes=10*1024**3,voice_seconds_quota=3600)
        result = sql(f"select apply_billing_entitlement('{provider}','{json.dumps(sub)}','{json.dumps(quota)}','{event}',{str(switch).lower()})",failure=failure)
        return result if failure else json.loads(result)

    def test_apple_grace_keeps_trial_access_and_usage_inside_the_original_period(self):
        start = sql("select now()-interval '5 days'")
        end = sql("select now()-interval '1 day'")
        grace = sql("select now()+interval '1 day'")
        self.apply('apple',status='trialing',start=start,end=end,service_until=grace)
        self.assertEqual(sql(f"select runner_has_entitlement('{A}')"),'True')
        self.assertEqual(sql("select expire_unpaid_trials()"),'0')
        self.assertEqual(sql('select status from hermes_instances'),'queued')
        self.assertTrue(json.loads(claim(key='apple-grace'))['claimed'])
        sql(f"""insert into acknowledgements values ('{A}','v2',now());
          insert into token_usage_events(user_id,prompt_tokens,completion_tokens,total_tokens,source,created_at)
          values ('{A}',80,0,80,'fixture',now()-interval '2 days'),
                 ('{A}',20,0,20,'fixture',now()-interval '1 hour');""")
        state = json.loads(sql(f"""set role authenticated; set request.jwt.claim.sub='{A}';
          select row_to_json(s) from my_product_state s"""))
        self.assertEqual(state['used_tokens'],100)
        self.assertEqual(state['gate_kind'],'subscribed_pending_worker')
        self.assertEqual(sql("select current_period_end < now() and service_access_until > now() from subscriptions"),'True')
        # Another provider cannot start while this grace remains valid.
        self.assertEqual(self.apply('stripe',switch=True,event='competing-checkout')['outcome'],'purchase_conflict')
        self.assertEqual(sql("select count(*) from my_product_state"),'0','view stays scoped to auth.uid()')

    def test_expired_apple_access_is_denied_before_sweep_and_cannot_backdate_chat_to_bypass_it(self):
        self.apply('apple',service_until=sql("select now()+interval '1 hour'"))
        sql("update subscriptions set service_access_until=now()-interval '1 second'")
        self.assertEqual(sql(f"select runner_has_entitlement('{A}')"),'False')
        self.assertEqual(sql('select count(*) from claim_next_hermes_provisioning_job()'),'0')
        self.assertIn('no_active_subscription',claim(key='after-expiry',failure=True))
        self.assertIn('no_active_subscription',sql(f"""set role authenticated; set request.jwt.claim.sub='{A}';
          select * from enqueue_chat_message('late','[]','2020-01-01T00:00:00Z')""",failure=True))
        sql(f"insert into acknowledgements values ('{A}','v2',now())")
        self.assertEqual(sql(f"""set role authenticated; set request.jwt.claim.sub='{A}';
          select gate_kind from my_product_state"""),'needs_subscription')
        self.assertEqual(sql("select expire_unpaid_trials()"),'1')
        self.assertEqual(sql("select status from hermes_instances"),'sleeping')
        retention = sql("select volume_retention_until from hermes_instances")
        self.assertEqual(sql("select volume_retention_until-suspended_at=interval '60 days' from hermes_instances"),'True')
        self.assertEqual(sql("select expire_unpaid_trials()"),'0')
        self.assertEqual(sql("select volume_retention_until from hermes_instances"),retention)
        self.assertEqual(sql("select count(*) from claim_next_hermes_runner_grace_expired()"),'0')
        self.assertIn('permission denied',sql("set role authenticated; select expire_unpaid_trials()",failure=True))

    def test_apple_expiry_rolls_back_if_suspension_fails_and_later_verified_renewal_restores(self):
        self.apply('apple',service_until=sql("select now()+interval '1 hour'"))
        sql("""update subscriptions set service_access_until=now()-interval '1 second';
          create or replace function grace_fixture_fail() returns trigger language plpgsql as
            $$ begin raise exception 'fixture_suspend_failed'; end; $$;
          create trigger billing_fixture_fail before update on hermes_instances for each row execute function grace_fixture_fail();""")
        self.assertIn('fixture_suspend_failed',sql("select expire_unpaid_trials()",failure=True))
        self.assertEqual(sql("select status from subscriptions"),'active')
        sql("drop trigger billing_fixture_fail on hermes_instances")
        # A provider renewal and the fallback sweeper serialize on the same row.
        barrier = threading.Barrier(2)
        def sweep():
            barrier.wait(timeout=20)
            return sql("select expire_unpaid_trials()")
        def renew():
            barrier.wait(timeout=20)
            return self.apply('apple',event='renewal',timestamp='2026-09-13T12:01:00Z',
                start=sql("select now()"),end=sql("select now()+interval '1 month'"))
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            jobs = [pool.submit(sweep),pool.submit(renew)]
            for job in jobs: job.result()
        self.assertEqual(sql("select status from subscriptions"),'active')
        self.assertIn(sql("select status from hermes_instances"),['queued','provisioning'])
        self.assertEqual(sql("select expire_unpaid_trials()"),'0')
        self.assertTrue(json.loads(claim(key='after-renewal'))['claimed'])

    def test_apple_deadline_is_required_and_stripe_past_due_policy_is_preserved(self):
        self.assertIn('missing_apple_service_deadline',self.apply('apple',service_until=None,failure=True))
        self.assertEqual(sql("select count(*) from subscriptions"),'0')
        self.apply(status='past_due',end=sql("select now()-interval '1 day'"),start=sql("select now()-interval '1 month'"))
        self.assertEqual(sql(f"select runner_has_entitlement('{A}')"),'True')
        self.assertEqual(sql("select expire_unpaid_trials()"),'0')
        self.assertTrue(json.loads(claim(key='stripe-past-due'))['claimed'])

    def reverse(self, *, revision=0, user=A, invoice='in_fixture', event='stripe:reversal', failure=False):
        return sql(f"""select apply_stripe_payment_reversal('{user}','cus_fixture','sub_fixture','{invoice}','ch_fixture',
          {revision},'2026-09-13T00:00:00Z','2026-10-13T00:00:00Z','{event}','2026-09-13T12:01:00Z','refund',5184000)""",failure=failure)

    def test_reversal_is_atomic_replay_safe_and_cannot_be_undone_by_the_same_invoice(self):
        self.apply(invoice='in_fixture')
        self.assertEqual(self.reverse(),'applied')
        self.assertEqual(sql('select status from subscriptions'),'canceled')
        self.assertEqual(sql('select status from hermes_instances'),'sleeping')
        self.assertEqual(self.reverse(),'duplicate')
        self.assertEqual(self.apply(event='later-active',invoice='in_fixture',timestamp='2026-09-13T12:02:00Z')['outcome'],'ignored_reversed_payment')
        self.assertEqual(self.apply(event='unknown-invoice',timestamp='2026-09-13T12:02:00Z')['outcome'],'ignored_reversed_payment')
        self.assertEqual(self.apply(event='new-paid',invoice='in_new_paid',timestamp='2026-09-13T12:03:00Z')['outcome'],'applied')
        self.assertEqual(sql('select status from subscriptions'),'active')

    def test_historical_reversal_cannot_cancel_another_provider_or_account(self):
        self.apply(invoice='in_fixture')
        self.assertIn('reversal_subscription_owner_mismatch',self.reverse(user=B,failure=True))
        self.apply(status='canceled',event='ended')
        self.apply('apple',event='apple-current',switch=True)
        self.assertEqual(self.reverse(),'ignored_historical_subscription')
        self.assertEqual(sql('select status from subscriptions'),'active')
        self.assertEqual(sql('select count(*) from billing_payment_reversals'),'0')

    def test_reversal_requires_the_same_revision_and_invoice_even_with_identical_provider_timestamps(self):
        self.apply(invoice='in_fixture')
        self.apply(invoice='in_upgrade',event='upgrade')
        self.assertIn('reversal_subscription_state_changed',self.reverse(failure=True))
        self.assertIn('reversal_subscription_state_changed',self.reverse(revision=1,failure=True))
        self.assertEqual(sql('select status from subscriptions'),'active')

    def test_failed_reversal_suspension_rolls_back_status_revision_and_receipt(self):
        self.apply(invoice='in_fixture')
        sql("create or replace function billing_fixture_failure() returns trigger language plpgsql as $$ begin raise exception 'fixture_suspend_failure'; end; $$")
        sql('create trigger billing_fixture_fail before update on hermes_instances for each row execute function billing_fixture_failure()')
        self.assertIn('fixture_suspend_failure',self.reverse(failure=True))
        self.assertEqual(sql('select status from subscriptions'),'active')
        self.assertEqual(sql('select billing_revision from subscriptions'),'0')
        self.assertEqual(sql('select count(*) from billing_payment_reversals'),'0')
        self.assertEqual(sql('select count(*) from billing_entitlement_commits'),'1')
        sql('drop trigger billing_fixture_fail on hermes_instances')
        self.assertEqual(self.reverse(),'applied')

    def test_future_paid_period_is_not_blocked_by_an_earlier_refund(self):
        self.apply(invoice='in_fixture')
        self.reverse()
        self.assertEqual(self.apply(event='renewal',invoice='in_next_month',timestamp='2026-10-13T12:00:00Z',
          start='2026-10-13',end='2026-11-13')['outcome'],'applied')
        self.assertEqual(sql('select status from subscriptions'),'active')

    def test_reversal_and_concurrent_upgrade_never_remove_the_new_payment(self):
        self.apply(invoice='in_fixture')
        barrier=threading.Barrier(2)
        def reverse():
            barrier.wait(timeout=20)
            try: return self.reverse()
            except psycopg.Error as exc: return str(exc)
        def upgrade():
            barrier.wait(timeout=20)
            return self.apply(event='upgrade',invoice='in_upgrade',timestamp='2026-09-13T12:02:00Z')['outcome']
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            first,second=pool.submit(reverse),pool.submit(upgrade)
            reversal,updated=first.result(),second.result()
        self.assertEqual(updated,'applied')
        self.assertTrue(reversal=='applied' or 'reversal_subscription_state_changed' in reversal)
        self.assertEqual(sql('select status from subscriptions'),'active')
        self.assertEqual(sql('select stripe_entitlement_invoice_id from subscriptions'),'in_upgrade')

    def test_atomic_switch_clears_current_identity_but_keeps_historical_owner(self):
        self.assertEqual(self.apply('apple')['outcome'],'applied')
        self.apply('apple',status='canceled',event='apple-ended')
        self.assertEqual(self.apply(switch=True,event='stripe-new')['outcome'],'applied')
        self.assertEqual(sql('select billing_provider from subscriptions'),'stripe')
        self.assertEqual(sql('select apple_original_transaction_id is null from subscriptions'),'True')
        self.assertEqual(sql('select count(*) from billing_subscription_ownership'),'2')
        self.assertEqual(self.apply('apple',event='old-apple-notice')['outcome'],'ignored_historical')
        self.assertEqual(sql('select billing_provider from subscriptions'),'stripe')
        self.assertIn('billing_subscription_owned_elsewhere',self.apply('apple',user=B,event='steal',switch=True,failure=True))
        self.apply(status='canceled',event='stripe-ended')
        self.assertEqual(self.apply('apple',switch=True,event='apple-return')['outcome'],'applied')
        self.assertEqual(sql('select stripe_subscription_id is null and stripe_customer_id is null and price_id is null from subscriptions'),'True')
        self.assertEqual(self.apply('apple',event='apple-renew')['outcome'],'applied')

    def test_failed_quota_or_provisioning_write_rolls_back_entitlement(self):
        sql("create or replace function billing_fixture_failure() returns trigger language plpgsql as $$ begin raise exception 'fixture_write_failure'; end; $$")
        for table in ['usage_quotas','hermes_instances']:
            sql(f'create trigger billing_fixture_fail before insert or update on {table} for each row execute function billing_fixture_failure()')
            self.assertIn('fixture_write_failure',self.apply(failure=True))
            self.assertEqual(sql('select count(*) from subscriptions'),'0')
            self.assertEqual(sql('select count(*) from usage_quotas'),'0')
            self.assertEqual(sql('select count(*) from billing_subscription_ownership'),'0')
            self.assertEqual(sql('select count(*) from billing_entitlement_commits'),'0')
            sql(f'drop trigger billing_fixture_fail on {table}')
        self.assertEqual(self.apply()['outcome'],'applied')
        self.assertEqual(sql('select status from hermes_instances'),'queued')

    def test_apple_environment_is_part_of_identity_even_when_original_ids_overlap(self):
        self.apply('apple')
        self.assertEqual(self.apply('apple',environment='Sandbox',status='canceled',event='sandbox-ended')['outcome'],'ignored_historical')
        self.assertEqual(self.apply('apple',environment='Sandbox',switch=True,event='sandbox-purchase')['outcome'],'purchase_conflict')
        self.assertEqual(sql('select apple_environment from subscriptions'),'Production')
        self.assertEqual(sql('select status from subscriptions'),'active')
        self.assertIn('billing_subscription_owned_elsewhere',self.apply('apple',user=B,environment='Sandbox',switch=True,event='sandbox-steal',failure=True))

    def test_distinct_apple_environments_can_have_distinct_owners_for_overlapping_ids(self):
        self.apply('apple')
        self.assertEqual(self.apply('apple',user=B,environment='Sandbox',switch=True,event='sandbox-other-user')['outcome'],'applied')
        self.assertEqual(sql('select count(*) from subscriptions'),'2')

    def test_retry_duplicate_and_stale_events_preserve_quota_counters(self):
        self.apply()
        sql('update usage_quotas set consumed_storage_bytes=123,consumed_voice_seconds=7')
        self.assertEqual(self.apply()['outcome'],'duplicate')
        self.assertEqual(self.apply(event='older',timestamp='2026-09-12')['outcome'],'ignored_stale')
        self.assertEqual(self.apply(event='next')['outcome'],'applied')
        self.assertEqual(sql('select consumed_storage_bytes from usage_quotas'),'123')
        self.assertEqual(sql('select consumed_voice_seconds from usage_quotas'),'7')
        self.assertEqual(sql('select count(*) from hermes_instances'),'1')

    def test_new_provider_requires_explicit_activation_and_never_overwrites_active_provider(self):
        self.apply()
        self.assertEqual(self.apply('apple',switch=True)['outcome'],'purchase_conflict')
        self.apply(status='canceled',event='ended')
        self.assertEqual(self.apply('apple',event='notification')['outcome'],'purchase_conflict')
        # Simulate explicit operator reconciliation of the recorded paid conflict.
        sql('update billing_purchase_conflicts set resolved_at=now()')
        self.assertEqual(self.apply('apple',event='notification')['outcome'],'activation_pending')
        self.assertEqual(self.apply('apple',switch=True,event='verified-purchase')['outcome'],'applied')

    def test_response_lost_replay_after_a_later_same_second_event_cannot_reactivate(self):
        self.apply(event='first')
        self.apply(status='canceled',event='second')
        self.assertEqual(self.apply(event='first')['outcome'],'duplicate')
        self.assertEqual(sql('select status from subscriptions'),'canceled')
        self.assertEqual(sql('select status from hermes_instances'),'sleeping')
        self.assertEqual(sql('select count(*) from billing_entitlement_commits'),'2')

    def test_concurrent_paid_providers_choose_one_current_entitlement(self):
        barrier=threading.Barrier(2)
        def activate(provider):
            barrier.wait(timeout=20)
            return self.apply(provider,switch=True)['outcome']
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            outcomes=list(pool.map(activate,['stripe','apple']))
        self.assertCountEqual(outcomes,['applied','purchase_conflict'])
        self.assertEqual(sql('select count(*) from billing_purchase_conflicts'),'1')
        self.assertEqual(sql('select count(*) from subscriptions'),'1')
        self.assertEqual(sql('select count(*) from billing_subscription_ownership'),'2')

    def test_retirement_boundary_retries_and_failed_resume_is_atomic(self):
        self.apply()
        self.apply(status='canceled',event='ended')
        sql("update hermes_instances set status='deleting',deletion_started_at=now()")
        self.assertIn('workspace_retirement_in_progress',self.apply(event='renewal',failure=True))
        self.assertEqual(sql('select status from subscriptions'),'canceled')
        sql("update hermes_instances set status='sleeping',deletion_started_at=null")
        sql("create or replace function billing_fixture_failure() returns trigger language plpgsql as $$ begin raise exception 'fixture_resume_failure'; end; $$")
        sql('create trigger billing_fixture_fail before update on hermes_instances for each row execute function billing_fixture_failure()')
        self.assertIn('fixture_resume_failure',self.apply(event='renewal',failure=True))
        self.assertEqual(sql('select status from subscriptions'),'canceled')
        sql('drop trigger billing_fixture_fail on hermes_instances')
        self.assertTrue(self.apply(event='renewal')['resumed'])
        self.assertEqual(sql('select status from hermes_instances'),'provisioning')

    def test_ownership_and_entitlement_rpc_are_service_owned(self):
        self.assertIn('permission denied',sql('set role authenticated; select * from billing_subscription_ownership',failure=True))
        self.assertEqual(sql("select has_function_privilege('authenticated','apply_billing_entitlement(text,jsonb,jsonb,text,boolean,integer)','EXECUTE')"),'False')



class ZZPurchaseIntentDatabaseTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        pass  # ZBillingTransactionDatabaseTest already loaded the full billing migration chain.

    def setUp(self):
        sql("""truncate billing_purchase_conflicts,billing_purchase_intents,billing_payment_reversals,
          billing_entitlement_commits,billing_subscription_ownership,apple_iap_events,hermes_instances,
          hermes_instance_private,subscriptions,usage_quotas,profiles;""")
        sql(f"insert into profiles(id,agent_name) values ('{A}','Fixture A'),('{B}','Fixture B')")

    def claim(self,user=A,provider='stripe',tier='studio'):
        return json.loads(sql(f"select claim_billing_purchase_intent('{user}','{provider}','{tier}')"))

    def update(self,intent,action,value=None,*,failure=False,user=None):
        payload=json.dumps(value or {}).replace("'","''")
        return sql(f"select update_billing_purchase_intent('{user or intent['user_id']}','{intent['id']}',"
          f"'{intent['lease_token']}','{action}','{payload}')",failure=failure)

    def prepared(self,intent):
        deadline=int(sql(f"select floor(extract(epoch from expires_at))::bigint from billing_purchase_intents where id='{intent['id']}'"))
        metadata=dict(sidekickUserId=intent['user_id'],tierId=intent['tier_id'],purchaseIntentId=intent['id'])
        return dict(metadata=metadata,subscription_data=dict(metadata=metadata),client_reference_id=intent['user_id'],expires_at=deadline)

    def test_concurrent_claims_have_one_account_winner_and_preserve_attempt_on_retry(self):
        barrier=threading.Barrier(16)
        def call(_):
            barrier.wait(timeout=20)
            return self.claim()
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            results=list(pool.map(call,range(16)))
        winners=[r for r in results if r['kind']=='claimed']
        self.assertEqual(len(winners),1)
        self.assertEqual(sum(r['kind']=='busy' for r in results),15)
        intent=winners[0]['intent']
        self.assertEqual(self.update(intent,'release'),'True')
        retry=self.claim()
        self.assertEqual(retry['intent']['id'],intent['id'])
        self.assertNotEqual(retry['intent']['lease_token'],intent['lease_token'])
        self.assertEqual(self.claim(user=B)['kind'],'claimed')
        self.assertEqual(sql('select count(*) from billing_purchase_intents'),'2')

    def test_parameters_are_frozen_and_stale_or_foreign_claims_cannot_write(self):
        intent=self.claim()['intent']
        params=self.prepared(intent)
        self.assertEqual(self.update(intent,'prepare',params),'True')
        self.assertEqual(self.update(intent,'prepare',params),'True')
        self.assertIn('purchase_parameters_already_frozen',self.update(intent,'prepare',{**params,'different':True},failure=True))
        self.assertIn('invalid_prepared_purchase',self.update(intent,'prepare',{**params,'expires_at':1},failure=True))
        self.assertEqual(self.update(intent,'release',user=B),'False')
        sql("update billing_purchase_intents set lease_expires_at=now()-interval '1 second'")
        next_intent=self.claim()['intent']
        self.assertEqual(self.update(intent,'session',dict(id='cs_old',status='open')),'False')
        self.assertEqual(self.update(next_intent,'session',dict(id='cs_new',status='open')),'True')
        self.assertEqual(sql('select provider_session_id from billing_purchase_intents'),'cs_new')

    def test_other_tier_or_provider_replaces_stripe_only_after_expiry_is_recorded(self):
        intent=self.claim()['intent']
        self.update(intent,'prepare',self.prepared(intent))
        self.update(intent,'session',dict(id='cs_pending',status='open'))
        self.update(intent,'release')
        replacement=self.claim(provider='apple',tier='pro-office')
        self.assertEqual(replacement['action'],'replace')
        self.assertEqual(replacement['intent']['id'],intent['id'])
        self.assertEqual(sql('select count(*) from billing_purchase_intents'),'1')
        self.assertIn('purchase_absence_not_safe',self.update(replacement['intent'],'expire_missing',failure=True))
        self.update(replacement['intent'],'session',dict(id='cs_pending',status='expired'))
        apple=self.claim(provider='apple',tier='pro-office')
        self.assertEqual(apple['action'],'create')
        self.assertNotEqual(apple['intent']['id'],intent['id'])
        self.assertEqual(apple['intent']['provider'],'apple')

    def test_completed_payment_blocks_replacement_and_cannot_be_relabelled_expired(self):
        intent=self.claim()['intent']
        self.update(intent,'prepare',self.prepared(intent))
        self.update(intent,'session',dict(id='cs_paid',status='complete',subscription='sub_paid'))
        self.assertIn('purchase_already_paid',self.update(intent,'session',dict(id='cs_paid',status='expired'),failure=True))
        self.update(intent,'release')
        self.assertEqual(self.claim(provider='apple')['kind'],'payment_pending')
        self.assertEqual(self.claim(tier='pro-office')['kind'],'payment_pending')

    def test_apple_pending_claim_blocks_stripe_and_expiry_keeps_old_identity_for_late_payment_fence(self):
        intent=self.claim(provider='apple')['intent']
        self.update(intent,'authorize_apple'); self.update(intent,'release')
        self.assertEqual(self.claim()['kind'],'purchase_pending')
        sql("update billing_purchase_intents set expires_at=now()-interval '1 second'")
        self.assertEqual(self.claim()['kind'],'claimed')
        self.assertEqual(sql(f"select phase from billing_purchase_intents where id='{intent['id']}'"),'abandoned')
        self.assertEqual(sql('select count(*) from billing_purchase_intents'),'2')

    def test_purchase_admission_is_service_owned_and_preserves_billing_history(self):
        self.assertIn('permission denied',sql(f"set role authenticated; select claim_billing_purchase_intent('{A}','stripe','studio')",failure=True))
        self.assertIn('permission denied',sql('set role authenticated; select * from billing_purchase_intents',failure=True))
        ZBillingTransactionDatabaseTest.apply(self,status='canceled')
        intent=self.claim()['intent']
        self.assertTrue(intent['request']['hasPriorSubscription'])
        self.update(intent,'release')
        sql("update subscriptions set status='active'")
        self.assertEqual(self.claim()['kind'],'already_entitled')
        self.assertEqual(self.claim(provider='apple')['kind'],'already_entitled')

    def test_apple_cancel_is_owned_idempotent_and_cannot_cancel_stripe_or_paid_intents(self):
        intent=self.claim(provider='apple')['intent']
        self.update(intent,'authorize_apple'); self.update(intent,'release')
        cancel=lambda user=A: sql(f"select cancel_billing_apple_purchase_intent('{user}','{intent['id']}')")
        self.assertEqual(cancel(B),'not_found')
        self.assertEqual(cancel(),'canceled')
        self.assertEqual(cancel(),'canceled')
        self.assertEqual(sql('select phase from billing_purchase_intents'),'abandoned')
        stripe=self.claim()['intent']
        self.assertEqual(sql(f"select cancel_billing_apple_purchase_intent('{A}','{stripe['id']}')"),'not_found')
        self.assertIn('permission denied',sql(f"set role authenticated; select cancel_billing_apple_purchase_intent('{A}','{intent['id']}')",failure=True))

    def test_canceled_apple_attempt_keeps_late_payment_identity_and_current_stripe_plan(self):
        old=self.claim(provider='apple')['intent']
        self.update(old,'authorize_apple'); self.update(old,'release')
        sql(f"select cancel_billing_apple_purchase_intent('{A}','{old['id']}')")
        current=self.claim()['intent']
        self.update(current,'prepare',self.prepared(current))
        self.assertEqual(ZBillingTransactionDatabaseTest.apply(self,intent=current['id'])['outcome'],'applied')
        self.assertEqual(ZBillingTransactionDatabaseTest.apply(self,'apple',intent=old['id'],switch=True,event='late')['outcome'],'purchase_conflict')
        self.assertEqual(sql('select billing_provider from subscriptions'),'stripe')
        self.assertEqual(sql('select count(*) from billing_purchase_conflicts'),'1')

    def test_admitted_apple_notification_can_finish_purchase_before_device_verification(self):
        intent=self.claim(provider='apple')['intent']
        self.update(intent,'authorize_apple'); self.update(intent,'release')
        result=ZBillingTransactionDatabaseTest.apply(self,'apple',intent=intent['id'],switch=False,event='notification-first')
        self.assertEqual(result['outcome'],'applied')
        self.assertEqual(sql('select phase from billing_purchase_intents'),'completed')
        self.assertEqual(sql('select provider_subscription_id from billing_purchase_intents'),'apple_fixture')
        self.assertEqual(sql('select count(*) from billing_subscription_ownership'),'1')

    def test_apple_cancellation_racing_payment_never_discards_a_paid_completion(self):
        for _ in range(4):
            self.setUp()
            intent=self.claim(provider='apple')['intent']
            self.update(intent,'authorize_apple'); self.update(intent,'release')
            barrier=threading.Barrier(2)
            def cancel():
                barrier.wait(timeout=20)
                return sql(f"select cancel_billing_apple_purchase_intent('{A}','{intent['id']}')")
            def pay():
                barrier.wait(timeout=20)
                return ZBillingTransactionDatabaseTest.apply(self,'apple',intent=intent['id'],switch=True)['outcome']
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                canceled,paid=[future.result() for future in [pool.submit(cancel),pool.submit(pay)]]
            self.assertIn((canceled,paid), [('canceled','purchase_conflict'),('completed','applied')])
            if paid=='applied':
                self.assertEqual(sql('select phase from billing_purchase_intents'),'completed')
                self.assertEqual(sql('select billing_provider from subscriptions'),'apple')
            else:
                self.assertEqual(sql('select count(*) from subscriptions'),'0')
                self.assertEqual(sql('select count(*) from billing_purchase_conflicts'),'1')


    def test_purchase_completion_is_atomic_and_completed_owner_can_renew(self):
        intent=self.claim()['intent']
        self.update(intent,'prepare',self.prepared(intent))
        result=ZBillingTransactionDatabaseTest.apply(self,intent=intent['id'])
        self.assertEqual(result['outcome'],'applied')
        self.assertEqual(sql('select phase from billing_purchase_intents'),'completed')
        self.assertEqual(sql('select provider_subscription_id from billing_purchase_intents'),'sub_fixture')
        self.assertEqual(self.update(intent,'session',dict(id='cs_late_response',status='open')),'False')
        self.assertEqual(ZBillingTransactionDatabaseTest.apply(self,intent=intent['id'],event='renewal')['outcome'],'applied')
        self.assertEqual(sql('select count(*) from billing_purchase_conflicts'),'0')
        self.assertIn('permission denied',sql("""set role service_role;
          select apply_billing_entitlement_core('stripe','{}','{}','attempt')""",failure=True))

    def test_failed_entitlement_keeps_purchase_pending_for_retry(self):
        intent=self.claim()['intent']
        self.update(intent,'prepare',self.prepared(intent))
        sql("""create or replace function purchase_fixture_failure() returns trigger language plpgsql as
          $$ begin raise exception 'fixture_quota_failure'; end; $$;
          create trigger billing_fixture_fail before insert on usage_quotas for each row execute function purchase_fixture_failure();""")
        try:
            self.assertIn('fixture_quota_failure',ZBillingTransactionDatabaseTest.apply(self,intent=intent['id'],failure=True))
            self.assertEqual(sql('select count(*) from subscriptions'),'0')
            self.assertEqual(sql('select phase from billing_purchase_intents'),'prepared')
            self.assertEqual(sql('select count(*) from billing_entitlement_commits'),'0')
        finally:
            sql('drop trigger billing_fixture_fail on usage_quotas')
        self.assertEqual(ZBillingTransactionDatabaseTest.apply(self,intent=intent['id'])['outcome'],'applied')

    def test_superseded_apple_payment_and_legacy_old_checkout_cannot_take_new_entitlement(self):
        old=self.claim(provider='apple')['intent']
        self.update(old,'authorize_apple'); self.update(old,'release')
        sql("update billing_purchase_intents set expires_at=now()-interval '1 second'")
        current=self.claim()['intent']
        self.update(current,'prepare',self.prepared(current))
        self.assertEqual(ZBillingTransactionDatabaseTest.apply(self,intent=current['id'])['outcome'],'applied')
        late=ZBillingTransactionDatabaseTest.apply(self,'apple',intent=old['id'],event='late-apple',switch=True)
        self.assertEqual(late['outcome'],'purchase_conflict')
        self.assertEqual(sql('select billing_provider from subscriptions'),'stripe')
        self.assertEqual(sql('select count(*) from billing_purchase_conflicts'),'1')
        self.assertEqual(sql('select count(*) from usage_quotas'),'1')
        # Even once current service ends, the paid conflict remains unresolved.
        ZBillingTransactionDatabaseTest.apply(self,status='canceled',event='current-ended')
        self.assertEqual(ZBillingTransactionDatabaseTest.apply(self,external='sub_legacy_late',event='legacy',switch=True)['outcome'],'purchase_conflict')
        self.assertEqual(sql('select stripe_subscription_id from subscriptions'),'sub_fixture')


    def test_legacy_provider_account_token_can_migrate_before_any_coordinated_attempt(self):
        # Historical appAccountToken values need not be purchase intent IDs.
        result=ZBillingTransactionDatabaseTest.apply(self,'apple',intent='99999999-9999-4999-8999-999999999999')
        self.assertEqual(result['outcome'],'applied')
        self.assertEqual(sql('select count(*) from billing_purchase_conflicts'),'0')

    def test_valid_purchase_can_activate_before_checkout_completed_webhook_and_late_old_event_is_replay_safe(self):
        ZBillingTransactionDatabaseTest.apply(self,'apple',status='canceled')
        intent=self.claim()['intent']
        self.update(intent,'prepare',self.prepared(intent))
        self.assertEqual(ZBillingTransactionDatabaseTest.apply(self,intent=intent['id'],switch=False,event='sub-created')['outcome'],'applied')
        self.assertEqual(ZBillingTransactionDatabaseTest.apply(self,intent=intent['id'],switch=True,event='checkout-completed')['outcome'],'applied')
        self.assertEqual(sql('select phase from billing_purchase_intents'),'completed')
        self.assertEqual(sql('select count(*) from billing_purchase_conflicts'),'0')

    def test_unresolved_paid_conflict_blocks_new_admission_and_deleted_owner_is_not_reassigned(self):
        intent=self.claim()['intent']
        sql(f"insert into billing_purchase_conflicts(provider,event_key,user_id,purchase_intent_id,provider_subscription_id,reason)"
          f" values ('stripe','late-paid','{A}','{intent['id']}','sub_late','superseded_intent')")
        self.update(intent,'release')
        self.assertEqual(self.claim()['kind'],'reconciliation_required')
        sql(f"delete from profiles where id='{A}'")
        self.assertEqual(sql('select user_id is null from billing_purchase_intents'),'True')
        self.assertEqual(sql('select user_id is null from billing_purchase_conflicts'),'True')


class ZZZConnectionRefreshDatabaseTest(unittest.TestCase):
    VERSION = '44444444-2222-4333-8444-555555555555'
    ATTEMPT = '55555555-2222-4333-8444-555555555555'
    OTHER = '66666666-2222-4333-8444-555555555555'

    @classmethod
    def setUpClass(cls):
        sql('alter role service_role bypassrls;')
        sql('create table auth.users(id uuid primary key);')
        sql(f"insert into auth.users values ('{A}'),('{B}');")
        sql((ROOT / 'supabase/migrations/0047_oauth_connections.sql').read_text(encoding='utf-8'))
        sql(f"insert into user_connections(user_id,provider,refresh_lease_until) values ('{B}','freeagent',now()-interval '1 hour');")
        sql((ROOT / 'supabase/migrations/0070_native_connection_refresh_fences.sql').read_text(encoding='utf-8'))
        cls.legacy_migrated = json.loads(sql(f"select row_to_json(c) from user_connections c where user_id='{B}';"))

    def setUp(self):
        sql('truncate user_connections;')
        sql(f"""insert into user_connections(user_id,provider,credential_version,access_token_enc,
            refresh_token_enc,access_expires_at) values ('{A}','freeagent','{self.VERSION}',
            'v1.old.access','v1.old.refresh',now()-interval '1 hour');""")

    def claim(self, attempt=None, version=None, user=A, role='service_role', failure=False):
        return sql(f"set role {role}; select claim_native_connection_refresh('{user}','freeagent',"
                   f"'{version or self.VERSION}','{attempt or self.ATTEMPT}');", failure=failure)

    def finish(self, outcome='succeeded', attempt=None, version=None, user=A, role='service_role', failure=False):
        return sql(f"set role {role}; select finish_native_connection_refresh('{user}','freeagent',"
                   f"'{version or self.VERSION}','{attempt or self.ATTEMPT}','{outcome}',"
                   "'v1.new.access','v1.new.refresh','2099-01-01T00:00:00Z');", failure=failure)

    def reconnect(self):
        sql(f"""set role service_role; update user_connections set credential_version='{self.OTHER}',
          access_token_enc='v1.reconnect.access',refresh_token_enc='v1.reconnect.refresh',
          status='connected',refresh_attempt_id=null,refresh_attempt_state=null,
          refresh_lease_until=null where user_id='{A}';""")

    def expire(self):
        # Time travel only in this disposable fixture; the shipping RPC fixes 60s.
        sql("set delegent.connection_refresh_rpc='on'; update user_connections set refresh_lease_until=now()-interval '1 minute';")

    def test_concurrent_claims_have_one_owner_and_retrying_owner_does_not_replace_lease(self):
        barrier = threading.Barrier(12)
        def start(i):
            barrier.wait(timeout=20)
            attempt = f'77777777-2222-4333-8444-{i:012d}'
            return attempt, self.claim(attempt)
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
            results = list(pool.map(start, range(12)))
        winners = [attempt for attempt, outcome in results if outcome == 'claimed']
        self.assertEqual(len(winners), 1, results)
        lease = sql('select refresh_lease_until from user_connections')
        self.assertEqual(self.claim(winners[0]), 'claimed')
        self.assertEqual(sql('select refresh_lease_until from user_connections'), lease)
        self.assertEqual(self.finish(attempt=winners[0]), 'stored')
        self.assertEqual(sql('select credential_version from user_connections'), winners[0])

    def test_migration_quarantines_even_expired_legacy_refresh_leases(self):
        self.assertEqual(self.legacy_migrated['status'], 'needs_reauth')
        self.assertEqual(self.legacy_migrated['refresh_attempt_state'], 'uncertain')
        self.assertIsNotNone(self.legacy_migrated['refresh_attempt_id'])
        self.assertIsNone(self.legacy_migrated['refresh_lease_until'])

    def test_persistence_response_loss_is_idempotent_and_different_payload_is_refused(self):
        self.assertEqual(self.claim(), 'claimed')
        self.assertEqual(self.finish(), 'stored')
        before = sql('select row_to_json(c) from user_connections c')
        self.assertEqual(self.finish(), 'stored')
        self.assertEqual(sql('select row_to_json(c) from user_connections c'), before)
        self.assertEqual(sql(f"set role service_role; select finish_native_connection_refresh('{A}','freeagent',"
          f"'{self.VERSION}','{self.ATTEMPT}','succeeded','v1.wrong.access','v1.new.refresh','2099-01-01');"), 'changed')

    def test_a_reconnect_fences_every_old_refresh_outcome(self):
        self.assertEqual(self.claim(), 'claimed')
        self.reconnect()
        before = sql('select row_to_json(c) from user_connections c')
        for outcome in ['succeeded','terminal','uncertain']:
            self.assertEqual(self.finish(outcome), 'changed')
        self.assertEqual(sql('select row_to_json(c) from user_connections c'), before)
        self.assertEqual(self.claim(), 'changed')

    def test_expired_in_flight_attempt_cannot_be_replayed_and_late_pair_can_recover(self):
        self.assertEqual(self.claim(), 'claimed')
        self.expire()
        self.assertEqual(self.claim(self.OTHER), 'refresh_recovery_required')
        self.assertEqual(sql('select refresh_attempt_id from user_connections'), self.ATTEMPT)
        self.assertEqual(sql('select status from user_connections'), 'needs_reauth')
        self.assertEqual(self.claim(), 'refresh_recovery_required')
        self.assertEqual(self.finish(), 'stored', 'same returned pair can still be persisted after lease expiry')
        self.assertEqual(sql('select status from user_connections'), 'connected')

    def test_uncertain_provider_result_keeps_evidence_and_requires_recovery(self):
        self.assertEqual(self.claim(), 'claimed')
        self.assertEqual(self.finish('uncertain'), 'stored')
        self.assertEqual(self.finish('uncertain'), 'stored')
        self.assertEqual(sql('select refresh_token_enc from user_connections'), 'v1.old.refresh')
        self.assertEqual(self.claim(self.OTHER), 'refresh_recovery_required')
        self.reconnect()
        self.assertEqual(self.claim(version=self.OTHER), 'claimed')

    def test_terminal_failure_is_durable_and_retry_safe(self):
        self.assertEqual(self.claim(), 'claimed')
        self.assertEqual(self.finish('terminal'), 'stored')
        self.assertEqual(self.finish('terminal'), 'stored')
        self.assertEqual(sql('select access_token_enc is null and refresh_token_enc is null from user_connections'), 'True')
        self.assertEqual(self.claim(self.OTHER, self.ATTEMPT), 'needs_reauth')

    def test_deleted_connection_is_not_recreated_by_late_refresh(self):
        self.assertEqual(self.claim(), 'claimed')
        sql(f"set role service_role; delete from user_connections where user_id='{A}';")
        self.assertEqual(self.finish(), 'changed')
        self.assertEqual(sql('select count(*) from user_connections'), '0')

    def test_no_client_role_can_read_tokens_or_claim_and_wrong_owner_cannot_finish(self):
        for role in ['anon','authenticated']:
            self.assertIn('permission denied', self.claim(role=role, failure=True))
            self.assertIn('permission denied', self.finish(role=role, failure=True))
            self.assertIn('permission denied', sql(f'set role {role}; select * from user_connections;', failure=True))
        self.assertEqual(self.claim(user=B), 'not_connected')
        self.assertEqual(self.claim(), 'claimed')
        self.assertEqual(self.finish(user=B), 'changed')

    def test_legacy_claim_and_unfenced_token_or_lease_writes_are_disabled(self):
        self.assertEqual(sql(f"set role service_role; select claim_connection_refresh('{A}','freeagent');"), 'False')
        for patch in ["access_token_enc='v1.wrong.access'", "refresh_lease_until=now()", "status='needs_reauth'"]:
            self.assertIn('connection_credential_version_required', sql(f'set role service_role; update user_connections set {patch};', failure=True))
        self.assertEqual(self.claim(), 'claimed')
        self.assertEqual(self.finish(), 'stored')

    def test_reconnect_wins_against_concurrent_finish_whatever_lock_order(self):
        self.assertEqual(self.claim(), 'claimed')
        barrier = threading.Barrier(2)
        def complete():
            barrier.wait(timeout=20)
            return self.finish()
        def reconnect():
            barrier.wait(timeout=20)
            self.reconnect()
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            a = pool.submit(complete)
            b = pool.submit(reconnect)
            self.assertIn(a.result(), ['stored','changed'])
            b.result()
        self.assertEqual(sql('select access_token_enc from user_connections'), 'v1.reconnect.access')
        self.assertEqual(sql('select credential_version from user_connections'), self.OTHER)


if __name__ == '__main__':
    unittest.main(verbosity=2)
