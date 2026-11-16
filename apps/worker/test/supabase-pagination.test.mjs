// Defect hunt 2026-09-03: PostgREST caps a response at 1000 rows on this
// project whatever `limit` asks for. Every reader that summed or exported
// "all the rows" read the first page and called it the total, so a heavy
// user's monthly usage was undercounted the moment their cycle held more
// than a thousand usage events. These pin the paged reader and the one
// caller where the undercount changed a decision.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SUPABASE_PAGE_SIZE,
  fetchSupabaseRowsAll,
  fetchUsageSnapshot,
  parseContentRangeTotal,
} from '../dist/index.js';

const ENV = { SUPABASE_URL: 'https://unit.supabase.test', SUPABASE_SERVICE_ROLE_KEY: 'svc-role' };
const USER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function rows(count, totalTokens = 1) {
  return Array.from({ length: count }, (_, i) => ({ id: `row-${i}`, total_tokens: totalTokens }));
}

// Routes each request by table + offset. `pages` is { table: { [offset]: { rows, contentRange } } }.
function stubPaged(pages) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const table = url.pathname.split('/').pop();
    const offset = Number(url.searchParams.get('offset') ?? '0');
    calls.push({ table, offset, limit: url.searchParams.get('limit'), order: url.searchParams.get('order'), headers: init.headers ?? {} });
    const page = pages[table]?.[offset] ?? { rows: [], contentRange: null };
    const headers = page.contentRange ? { 'content-range': page.contentRange } : {};
    return new Response(JSON.stringify(page.rows), { status: 200, headers });
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

test('parseContentRangeTotal reads the total and treats an unknown one as null', () => {
  assert.equal(parseContentRangeTotal('0-999/1500'), 1500);
  assert.equal(parseContentRangeTotal('*/0'), 0);
  assert.equal(parseContentRangeTotal('0-9/*'), null);
  assert.equal(parseContentRangeTotal(null), null);
  assert.equal(parseContentRangeTotal('garbage'), null);
});

test('fetchSupabaseRowsAll walks every page and asks PostgREST for the exact count', async () => {
  const s = stubPaged({
    token_usage_events: {
      0: { rows: rows(SUPABASE_PAGE_SIZE), contentRange: `0-${SUPABASE_PAGE_SIZE - 1}/1500` },
      [SUPABASE_PAGE_SIZE]: { rows: rows(500), contentRange: `${SUPABASE_PAGE_SIZE}-1499/1500` },
    },
  });
  try {
    const all = await fetchSupabaseRowsAll(ENV, 'token_usage_events', { user_id: `eq.${USER}`, select: 'total_tokens', order: 'created_at.asc' });
    assert.equal(all.length, 1500, 'both pages land, not just the first thousand');
    assert.equal(s.calls.length, 2);
    assert.equal(s.calls[0].offset, 0);
    assert.equal(s.calls[1].offset, SUPABASE_PAGE_SIZE);
    assert.equal(s.calls[0].limit, String(SUPABASE_PAGE_SIZE));
    assert.equal(s.calls[0].order, 'created_at.asc', 'the caller-supplied order survives paging');
    assert.equal(s.calls[0].headers.prefer, 'count=exact');
  } finally { s.restore(); }
});

test('fetchSupabaseRowsAll stops after one short page when the server sends no count', async () => {
  const s = stubPaged({ artifacts: { 0: { rows: rows(3), contentRange: null } } });
  try {
    const all = await fetchSupabaseRowsAll(ENV, 'artifacts', { user_id: `eq.${USER}`, select: '*' });
    assert.equal(all.length, 3);
    assert.equal(s.calls.length, 1, 'a short page with no count means there is nothing more to read');
  } finally { s.restore(); }
});

test('fetchSupabaseRowsAll keeps reading a full page without a count until a page comes back empty', async () => {
  const s = stubPaged({ messages: { 0: { rows: rows(SUPABASE_PAGE_SIZE), contentRange: null } } });
  try {
    const all = await fetchSupabaseRowsAll(ENV, 'messages', { user_id: `eq.${USER}`, select: '*' });
    assert.equal(all.length, SUPABASE_PAGE_SIZE);
    assert.equal(s.calls.length, 2, 'a full page is ambiguous, so one more read proves the end');
  } finally { s.restore(); }
});

test('fetchUsageSnapshot sums EVERY page, so a heavy user is hard-limited when they really are', async () => {
  const iso = new Date(Date.now() - 86_400_000).toISOString();
  const pages = {
    subscriptions: { 0: { rows: [{ status: 'active', current_period_start: iso }], contentRange: null } },
    // 1,100,000 quota; 1,200 events of 1,000 tokens = 1,200,000 consumed.
    usage_quotas: { 0: { rows: [{ monthly_token_quota: 1_100_000, tier_id: 'studio' }], contentRange: null } },
    token_usage_events: {
      0: { rows: rows(SUPABASE_PAGE_SIZE, 1_000), contentRange: `0-${SUPABASE_PAGE_SIZE - 1}/1200` },
      [SUPABASE_PAGE_SIZE]: { rows: rows(200, 1_000), contentRange: `${SUPABASE_PAGE_SIZE}-1199/1200` },
    },
  };
  const s = stubPaged(pages);
  try {
    const snapshot = await fetchUsageSnapshot(USER, ENV);
    assert.equal(snapshot.usedTokens, 1_200_000, 'one page would have said 1,000,000 and let them through');
    assert.equal(snapshot.hardLimited, true);
    assert.equal(snapshot.remainingTokens, 0);
  } finally { s.restore(); }
});
