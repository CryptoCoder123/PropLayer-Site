-- supabase/tests/database/rls.test.sql
-- Contract PL-ACCOUNT-1 / C9: clients may READ their own rows and nothing else.
-- Run with `npm run test:db` (needs Docker + `npx supabase start`).
-- The same assertions run against a plain PostgreSQL 15+ instance via
-- `node scripts/db-test-psql.mjs`, which stubs auth.users / auth.uid() / anon / authenticated.

begin;
select plan(27);

-- ---------------------------------------------------------------- fixtures (service role)
insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-111111111111', 'a@example.com'),
  ('22222222-2222-4222-8222-222222222222', 'b@example.com');

insert into public.customers (user_id, stripe_customer_id) values
  ('11111111-1111-4111-8111-111111111111', 'cus_A'),
  ('22222222-2222-4222-8222-222222222222', 'cus_B');

insert into public.subscriptions
  (id, user_id, stripe_customer_id, status, price_lookup_key, current_period_end, stripe_created_at) values
  ('sub_A', '11111111-1111-4111-8111-111111111111', 'cus_A', 'active',   'proplayer_monthly', now() + interval '20 days', now()),
  ('sub_B', '22222222-2222-4222-8222-222222222222', 'cus_B', 'past_due', 'proplayer_monthly', now() + interval '10 days', now());

insert into public.stripe_events (id, type) values ('evt_1', 'customer.subscription.updated');

-- ---------------------------------------------------------------- structure
select has_table('public', 'customers',     'public.customers exists');
select has_table('public', 'subscriptions', 'public.subscriptions exists');
select has_table('public', 'stripe_events', 'public.stripe_events exists');

select is((select relrowsecurity from pg_class where oid = 'public.customers'::regclass),
  true, 'RLS is enabled on public.customers');
select is((select relrowsecurity from pg_class where oid = 'public.subscriptions'::regclass),
  true, 'RLS is enabled on public.subscriptions');
select is((select relrowsecurity from pg_class where oid = 'public.stripe_events'::regclass),
  true, 'RLS is enabled on public.stripe_events');

-- Only the two read-own policies exist; no client write policy anywhere.
select is(
  (select count(*)::int from pg_policies where schemaname = 'public'
     and tablename in ('customers', 'subscriptions', 'stripe_events')),
  2, 'exactly two RLS policies exist, both SELECT-own');
select is(
  (select count(*)::int from pg_policies where schemaname = 'public'
     and tablename in ('customers', 'subscriptions', 'stripe_events') and cmd <> 'SELECT'),
  0, 'no INSERT/UPDATE/DELETE policy exists for clients');

-- The status CHECK keeps unknown Stripe statuses out of the table the app trusts.
select throws_ok(
  $$insert into public.subscriptions (id, user_id, stripe_customer_id, status, stripe_created_at)
    values ('sub_bad', '11111111-1111-4111-8111-111111111111', 'cus_A', 'not_a_status', now())$$,
  '23514', null, 'an unknown subscription status is rejected by the CHECK constraint');

-- ---------------------------------------------------------------- user A reads only A
set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}';

select is((select count(*)::int from public.customers), 1, 'user A sees exactly one customers row');
select is((select stripe_customer_id from public.customers), 'cus_A', 'user A sees only their own customers row');
select is((select count(*)::int from public.subscriptions), 1, 'user A sees exactly one subscriptions row');
select is((select id from public.subscriptions), 'sub_A', 'user A sees only their own subscription');
select is((select count(*)::int from public.customers where user_id = '22222222-2222-4222-8222-222222222222'),
  0, 'user A cannot read user B''s customers row');
select is((select count(*)::int from public.subscriptions where user_id = '22222222-2222-4222-8222-222222222222'),
  0, 'user A cannot read user B''s subscription');

-- ---------------------------------------------------------------- clients cannot write
select throws_ok(
  $$insert into public.customers (user_id, stripe_customer_id)
    values ('11111111-1111-4111-8111-111111111111', 'cus_FORGED')$$,
  '42501', null, 'authenticated cannot insert into customers');
select throws_ok(
  $$update public.customers set stripe_customer_id = 'cus_FORGED'$$,
  '42501', null, 'authenticated cannot update customers');
select throws_ok(
  $$delete from public.customers$$,
  '42501', null, 'authenticated cannot delete from customers');
select throws_ok(
  $$insert into public.subscriptions (id, user_id, stripe_customer_id, status, stripe_created_at)
    values ('sub_FORGED', '11111111-1111-4111-8111-111111111111', 'cus_A', 'active', now())$$,
  '42501', null, 'authenticated cannot insert a subscription (self-granted entitlement)');
select throws_ok(
  $$update public.subscriptions set status = 'active', current_period_end = now() + interval '99 years'$$,
  '42501', null, 'authenticated cannot update a subscription');
select throws_ok(
  $$delete from public.subscriptions$$,
  '42501', null, 'authenticated cannot delete a subscription');

-- stripe_events is invisible to every client role.
select throws_ok(
  $$select * from public.stripe_events$$,
  '42501', null, 'authenticated cannot read the stripe_events ledger');

-- ---------------------------------------------------------------- anonymous sees nothing
reset role;
set local role anon;
set local request.jwt.claims = '{"role":"anon"}';

select throws_ok($$select * from public.customers$$,
  '42501', null, 'anon cannot select customers');
select throws_ok($$select * from public.subscriptions$$,
  '42501', null, 'anon cannot select subscriptions');
select throws_ok($$select * from public.stripe_events$$,
  '42501', null, 'anon cannot select stripe_events');

-- ---------------------------------------------------------------- cascade on user deletion
reset role;
reset request.jwt.claims;
delete from auth.users where id = '22222222-2222-4222-8222-222222222222';
select is((select count(*)::int from public.customers where user_id = '22222222-2222-4222-8222-222222222222'),
  0, 'deleting a user cascades to customers');
select is((select count(*)::int from public.subscriptions where user_id = '22222222-2222-4222-8222-222222222222'),
  0, 'deleting a user cascades to subscriptions');

select * from finish();
rollback;
