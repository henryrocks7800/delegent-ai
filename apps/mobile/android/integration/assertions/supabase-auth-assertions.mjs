#!/usr/bin/env node
import { createClient } from '@supabase/supabase-js';

const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
const missing = required.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error(`Missing required env: ${missing.join(', ')}`);
  process.exit(2);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  },
);

function usage() {
  console.log(`Usage:
  node apps/mobile/android/integration/assertions/supabase-auth-assertions.mjs assert-user <email> [provider]
  node apps/mobile/android/integration/assertions/supabase-auth-assertions.mjs cleanup-user <email>

This script is for local/backend assertions only. It must never be bundled into mobile.`);
}

async function listUsers() {
  const users = [];
  let page = 1;
  const perPage = 1000;
  for (;;) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    users.push(...(data?.users ?? []));
    if (!data?.users || data.users.length < perPage) break;
    page += 1;
  }
  return users;
}

function findUserByEmail(users, email) {
  const normalized = email.trim().toLowerCase();
  return users.find((user) => user.email?.toLowerCase() === normalized);
}

function userProviders(user) {
  return (user.identities ?? [])
    .map((identity) => identity.provider)
    .filter(Boolean)
    .sort();
}

async function assertUser(email, provider) {
  const user = findUserByEmail(await listUsers(), email);
  if (!user) {
    throw new Error(`No auth.users record found for ${email}`);
  }
  const providers = userProviders(user);
  if (provider && !providers.includes(provider)) {
    throw new Error(`User ${email} exists but auth.identities providers were [${providers.join(', ')}], expected ${provider}`);
  }
  console.log(JSON.stringify({
    ok: true,
    userId: user.id,
    email: user.email,
    providers,
    createdAt: user.created_at,
    lastSignInAt: user.last_sign_in_at ?? null,
  }, null, 2));
}

async function cleanupUser(email) {
  const user = findUserByEmail(await listUsers(), email);
  if (!user) {
    console.log(JSON.stringify({ ok: true, deleted: false, reason: 'not_found' }, null, 2));
    return;
  }
  const { error } = await supabase.auth.admin.deleteUser(user.id);
  if (error) throw error;
  console.log(JSON.stringify({ ok: true, deleted: true, userId: user.id }, null, 2));
}

const [command, email, provider] = process.argv.slice(2);
try {
  if (command === 'assert-user' && email) {
    await assertUser(email, provider);
  } else if (command === 'cleanup-user' && email) {
    await cleanupUser(email);
  } else {
    usage();
    process.exit(2);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
