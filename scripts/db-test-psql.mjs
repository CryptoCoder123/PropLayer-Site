#!/usr/bin/env node
// Runs the RLS assertions of supabase/tests/database/rls.test.sql against a plain
// PostgreSQL 15+ instance, for environments where Docker (and therefore
// `supabase start` + pgTAP) is unavailable. Contract PL-ACCOUNT-1 / C9.
//
//   DATABASE_URL=postgres://user:pw@host:5432/db  node scripts/db-test-psql.mjs
//   PG_BIN=/path/to/postgres/bin                  node scripts/db-test-psql.mjs
//
// With PG_BIN (and no DATABASE_URL) the script initialises a throwaway cluster in
// a temporary directory, runs the assertions and removes it again.
//
// It stubs the parts of Supabase the migration depends on — the `auth` schema,
// `auth.users`, `auth.uid()`, and the `anon` / `authenticated` / `service_role`
// roles with Supabase's default table grants — so the migration's own REVOKEs are
// what actually denies access, exactly as on a real project.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = path.join(root, 'supabase/migrations/20261003000000_accounts_billing.sql');

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const INSUFFICIENT_PRIVILEGE = '42501';
const CHECK_VIOLATION = '23514';

let pg;
try {
  pg = await import('pg');
} catch {
  console.error('✗ The "pg" dev dependency is missing. Run `npm ci`.');
  process.exit(1);
}

// ---------------------------------------------------------------- tiny assertion harness
const results = [];
function record(ok, name, detail) {
  results.push({ ok, name, detail });
  console.log(`${ok ? 'ok  ' : 'NOT OK'} ${results.length} - ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
}
async function is(client, sql, expected, name) {
  try {
    const { rows } = await client.query(sql);
    const actual = rows[0] ? Object.values(rows[0])[0] : undefined;
    const ok = String(actual) === String(expected);
    record(ok, name, ok ? '' : `expected ${expected}, got ${actual}`);
  } catch (error) {
    record(false, name, `query failed: ${error.message}`);
  }
}
async function throwsCode(client, sql, code, name) {
  try {
    await client.query(sql);
    record(false, name, 'the statement succeeded but should have been rejected');
  } catch (error) {
    record(error.code === code, name, error.code === code ? '' : `expected SQLSTATE ${code}, got ${error.code}: ${error.message}`);
  }
}

// ---------------------------------------------------------------- optional throwaway cluster
async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function run(exe, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('error', reject);
    child.on('exit', code => (code === 0 ? resolve(out) : reject(new Error(`${path.basename(exe)} exited ${code}\n${out}`))));
  });
}

async function startCluster(binDir) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proplayer-rls-'));
  const pwFile = path.join(dataDir, '..', `pw-${crypto.randomBytes(6).toString('hex')}`);
  const password = crypto.randomBytes(18).toString('hex');
  fs.writeFileSync(pwFile, password);
  const exe = n => path.join(binDir, process.platform === 'win32' ? `${n}.exe` : n);

  console.log('• initialising a throwaway PostgreSQL cluster');
  await run(exe('initdb'), ['-D', dataDir, '-U', 'postgres', '--auth=md5', `--pwfile=${pwFile}`, '-E', 'UTF8']);
  fs.rmSync(pwFile, { force: true });

  const port = await freePort();
  const server = spawn(exe('postgres'), ['-D', dataDir, '-p', String(port), '-h', '127.0.0.1', '-k', ''], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', () => {});

  const url = `postgres://postgres:${encodeURIComponent(password)}@127.0.0.1:${port}/postgres`;
  for (let attempt = 0; attempt < 60; attempt++) {
    const probe = new pg.default.Client({ connectionString: url });
    try {
      await probe.connect();
      await probe.end();
      return {
        url,
        version: null,
        async stop() {
          server.kill();
          await new Promise(resolve => server.once('exit', resolve)).catch(() => {});
          try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows file locks */ }
        }
      };
    } catch {
      await probe.end().catch(() => {});
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  server.kill();
  throw new Error('the throwaway cluster did not accept connections within 30 s');
}

// ---------------------------------------------------------------- Supabase stubs
const STUBS = `
create schema if not exists auth;

create table if not exists auth.users (
  id    uuid primary key,
  email text unique
);

-- Supabase's auth.uid(): the "sub" claim of the request's JWT, exposed as a GUC.
create or replace function auth.uid() returns uuid
  language sql stable as $fn$
  select nullif(current_setting('request.jwt.claims', true)::json ->> 'sub', '')::uuid
$fn$;

do $do$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon')          then create role anon          nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role')  then create role service_role  nologin noinherit bypassrls; end if;
end $do$;

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth   to anon, authenticated, service_role;

-- Supabase grants these by default, so the migration's REVOKEs are what denies access.
alter default privileges in schema public grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
`;

// ---------------------------------------------------------------- the assertions
async function assertions(client) {
  // --- fixtures, written as the service role (which bypasses RLS, like an Edge Function)
  await client.query('begin');
  await client.query(
    'insert into auth.users (id, email) values ($1, $2), ($3, $4)',
    [USER_A, 'a@example.com', USER_B, 'b@example.com']
  );
  await client.query(
    'insert into public.customers (user_id, stripe_customer_id) values ($1, $2), ($3, $4)',
    [USER_A, 'cus_A', USER_B, 'cus_B']
  );
  await client.query(`
    insert into public.subscriptions
      (id, user_id, stripe_customer_id, status, price_lookup_key, current_period_end, stripe_created_at)
    values
      ('sub_A', $1, 'cus_A', 'active',   'proplayer_monthly', now() + interval '20 days', now()),
      ('sub_B', $2, 'cus_B', 'past_due', 'proplayer_monthly', now() + interval '10 days', now())`,
    [USER_A, USER_B]
  );
  await client.query("insert into public.stripe_events (id, type) values ('evt_1', 'customer.subscription.updated')");

  // --- structure
  for (const table of ['customers', 'subscriptions', 'stripe_events']) {
    await is(client,
      `select count(*)::int from information_schema.tables where table_schema = 'public' and table_name = '${table}'`,
      1, `public.${table} exists`);
  }
  for (const table of ['customers', 'subscriptions', 'stripe_events']) {
    await is(client,
      `select relrowsecurity from pg_class where oid = 'public.${table}'::regclass`,
      true, `RLS is enabled on public.${table}`);
  }
  await is(client,
    `select count(*)::int from pg_policies where schemaname = 'public'
       and tablename in ('customers', 'subscriptions', 'stripe_events')`,
    2, 'exactly two RLS policies exist, both SELECT-own');
  await is(client,
    `select count(*)::int from pg_policies where schemaname = 'public'
       and tablename in ('customers', 'subscriptions', 'stripe_events') and cmd <> 'SELECT'`,
    0, 'no INSERT/UPDATE/DELETE policy exists for clients');

  // --- the status CHECK keeps unknown Stripe statuses out of the table the app trusts
  await client.query('savepoint before_bad_status');
  await throwsCode(client,
    `insert into public.subscriptions (id, user_id, stripe_customer_id, status, stripe_created_at)
     values ('sub_bad', '${USER_A}', 'cus_A', 'not_a_status', now())`,
    CHECK_VIOLATION, 'an unknown subscription status is rejected by the CHECK constraint');
  await client.query('rollback to savepoint before_bad_status');

  // --- user A reads only A
  await client.query('set local role authenticated');
  await client.query(`set local request.jwt.claims = '{"sub":"${USER_A}","role":"authenticated"}'`);

  await is(client, 'select count(*)::int from public.customers', 1, 'user A sees exactly one customers row');
  await is(client, 'select stripe_customer_id from public.customers', 'cus_A', 'user A sees only their own customers row');
  await is(client, 'select count(*)::int from public.subscriptions', 1, 'user A sees exactly one subscriptions row');
  await is(client, 'select id from public.subscriptions', 'sub_A', 'user A sees only their own subscription');
  await is(client, `select count(*)::int from public.customers where user_id = '${USER_B}'`,
    0, "user A cannot read user B's customers row");
  await is(client, `select count(*)::int from public.subscriptions where user_id = '${USER_B}'`,
    0, "user A cannot read user B's subscription");

  // --- clients cannot write
  const denied = [
    [`insert into public.customers (user_id, stripe_customer_id) values ('${USER_A}', 'cus_FORGED')`,
      'authenticated cannot insert into customers'],
    ["update public.customers set stripe_customer_id = 'cus_FORGED'",
      'authenticated cannot update customers'],
    ['delete from public.customers',
      'authenticated cannot delete from customers'],
    [`insert into public.subscriptions (id, user_id, stripe_customer_id, status, stripe_created_at)
      values ('sub_FORGED', '${USER_A}', 'cus_A', 'active', now())`,
      'authenticated cannot insert a subscription (self-granted entitlement)'],
    ["update public.subscriptions set status = 'active', current_period_end = now() + interval '99 years'",
      'authenticated cannot update a subscription'],
    ['delete from public.subscriptions',
      'authenticated cannot delete a subscription'],
    ['select * from public.stripe_events',
      'authenticated cannot read the stripe_events ledger']
  ];
  for (const [sql, name] of denied) {
    await client.query('savepoint denied');
    await throwsCode(client, sql, INSUFFICIENT_PRIVILEGE, name);
    await client.query('rollback to savepoint denied');
  }

  // --- anonymous sees nothing
  await client.query('reset role');
  await client.query('set local role anon');
  await client.query(`set local request.jwt.claims = '{"role":"anon"}'`);
  for (const table of ['customers', 'subscriptions', 'stripe_events']) {
    await client.query('savepoint anon_denied');
    await throwsCode(client, `select * from public.${table}`, INSUFFICIENT_PRIVILEGE, `anon cannot select ${table}`);
    await client.query('rollback to savepoint anon_denied');
  }

  // --- cascade on user deletion
  await client.query('reset role');
  await client.query('reset request.jwt.claims');
  await client.query('delete from auth.users where id = $1', [USER_B]);
  await is(client, `select count(*)::int from public.customers where user_id = '${USER_B}'`,
    0, 'deleting a user cascades to customers');
  await is(client, `select count(*)::int from public.subscriptions where user_id = '${USER_B}'`,
    0, 'deleting a user cascades to subscriptions');

  await client.query('rollback');
}

// ---------------------------------------------------------------- main
let cluster = null;
let client = null;
try {
  let url = process.env.DATABASE_URL;
  if (!url) {
    const binDir = process.env.PG_BIN;
    if (!binDir) {
      console.error('✗ Set DATABASE_URL to a PostgreSQL 15+ instance, or PG_BIN to a directory containing initdb and postgres.');
      process.exit(2);
    }
    cluster = await startCluster(binDir);
    url = cluster.url;
  }

  client = new pg.default.Client({ connectionString: url });
  await client.connect();
  const { rows: [{ version, num }] } = await client.query('select version() as version, current_setting($1)::int as num', ['server_version_num']);
  console.log(`• ${version.split(' ').slice(0, 2).join(' ')}`);
  if (num < 150000) {
    console.error('✗ PostgreSQL 15 or newer is required.');
    process.exit(2);
  }

  console.log('• installing the Supabase auth/role stubs');
  await client.query(STUBS);
  console.log('• applying supabase/migrations/20261003000000_accounts_billing.sql');
  await client.query(fs.readFileSync(MIGRATION, 'utf8'));

  console.log(`\n# RLS assertions (contract PL-ACCOUNT-1 / C9)`);
  await assertions(client);

  const failed = results.filter(r => !r.ok);
  console.log(`\n1..${results.length}`);
  console.log(failed.length
    ? `✗ ${failed.length} of ${results.length} assertions failed`
    : `✓ ${results.length} of ${results.length} assertions passed`);
  process.exitCode = failed.length ? 1 : 0;
} catch (error) {
  console.error('✗', error.message);
  process.exitCode = 1;
} finally {
  if (client) await client.end().catch(() => {});
  if (cluster) await cluster.stop();
}
