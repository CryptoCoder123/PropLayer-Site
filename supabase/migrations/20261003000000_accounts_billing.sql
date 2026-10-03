-- supabase/migrations/20261003000000_accounts_billing.sql
-- Accounts and billing for contract PL-ACCOUNT-1.
-- Clients may READ their own rows. Only Edge Functions (service role, which bypasses RLS) write.

create table public.customers (
  user_id            uuid primary key references auth.users (id) on delete cascade,
  stripe_customer_id text not null unique,
  last_synced_at     timestamptz,
  created_at         timestamptz not null default now()
);

create table public.subscriptions (
  id                   text primary key,                    -- Stripe subscription id (sub_...)
  user_id              uuid not null references auth.users (id) on delete cascade,
  stripe_customer_id   text not null,
  status               text not null check (status in (
                         'incomplete', 'incomplete_expired', 'trialing', 'active',
                         'past_due', 'canceled', 'unpaid', 'paused')),
  price_id             text,
  price_lookup_key     text,
  current_period_end   timestamptz,                         -- from the subscription ITEM (Stripe API >= 2025-03-31)
  cancel_at_period_end boolean not null default false,
  cancel_at            timestamptz,
  canceled_at          timestamptz,
  ended_at             timestamptz,
  livemode             boolean not null default false,
  stripe_created_at    timestamptz not null,
  updated_at           timestamptz not null default now()
);

create index subscriptions_user_id_idx  on public.subscriptions (user_id);
create index subscriptions_customer_idx on public.subscriptions (stripe_customer_id);

-- Webhook idempotency ledger. Never exposed to clients.
create table public.stripe_events (
  id           text primary key,                            -- Stripe event id (evt_...)
  type         text not null,
  received_at  timestamptz not null default now(),
  processed_at timestamptz
);

alter table public.customers     enable row level security;
alter table public.subscriptions enable row level security;
alter table public.stripe_events enable row level security;

create policy "customers_select_own" on public.customers
  for select to authenticated using (user_id = (select auth.uid()));

create policy "subscriptions_select_own" on public.subscriptions
  for select to authenticated using (user_id = (select auth.uid()));

-- No insert/update/delete policies exist, so RLS denies all client writes.
-- Belt and braces: remove table privileges clients never need.
revoke insert, update, delete, truncate on public.customers     from anon, authenticated;
revoke insert, update, delete, truncate on public.subscriptions from anon, authenticated;
revoke all                              on public.stripe_events from anon, authenticated;
revoke select                           on public.customers     from anon;
revoke select                           on public.subscriptions from anon;
