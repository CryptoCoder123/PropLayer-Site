// Test doubles for the injected dependencies. Nothing here touches the network, so
// `npm run test:functions` runs offline and deterministically.

import type { Auth, AuthUser } from '../_shared/auth.ts';
import type { CustomerRow, Db, SubscriptionUpsert } from '../_shared/db.ts';
import type { SubscriptionRow } from '../_shared/entitlement.ts';
import { readConfig, type Config, type EnvSource } from '../_shared/env.ts';
import { HttpError } from '../_shared/http.ts';
import type { Logger, Sync } from '../_shared/sync.ts';

export const FIXED_NOW = Date.parse('2026-10-03T16:00:00Z');
export const USER: AuthUser = Object.freeze({
  id: '3f6c2a1e-8b4d-4c1a-9e2f-5a7b9c0d1e2f',
  email: 'fan@example.com'
});

/** A syntactically valid, unsigned JWT. The handlers never decode it; `auth` is faked. */
export const TEST_TOKEN = [
  btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' })),
  btoa(JSON.stringify({ sub: USER.id, email: USER.email, role: 'authenticated' })),
  'not-a-real-signature'
].join('.').replace(/=/g, '');

export const BASE_ENV: EnvSource = Object.freeze({
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-for-tests',
  STRIPE_SECRET_KEY: 'sk_test_fake',
  STRIPE_WEBHOOK_SECRET: 'whsec_test_fake',
  SITE_URL: 'https://prop-layer.com'
});

export function config(overrides: EnvSource = {}): Config {
  return readConfig({ ...BASE_ENV, ...overrides });
}

export function request(
  url = 'https://project.supabase.co/functions/v1/entitlement',
  init: RequestInit & { token?: string | null; origin?: string | null } = {}
): Request {
  const { token = TEST_TOKEN, origin = 'https://prop-layer.com', ...rest } = init;
  const headers = new Headers(rest.headers);
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (origin) headers.set('origin', origin);
  return new Request(url, { ...rest, headers });
}

// ---------------------------------------------------------------- logger
export interface RecordedLog {
  level: string;
  message: string;
  fields: Record<string, unknown>;
}

export function fakeLogger(): Logger & { entries: RecordedLog[] } {
  const entries: RecordedLog[] = [];
  const push = (level: string) => (message: string, fields?: Record<string, unknown>) =>
    entries.push({ level, message, fields: fields ?? {} });
  return { entries, info: push('info'), warn: push('warn'), error: push('error') };
}

// ---------------------------------------------------------------- auth
export function fakeAuth(user: AuthUser | null = USER): Auth {
  return {
    getUser(token: string) {
      if (!user || !token || token === 'invalid') return Promise.reject(new HttpError(401, 'unauthorized'));
      return Promise.resolve(user);
    }
  };
}

// ---------------------------------------------------------------- subscription rows
export function subscriptionRow(overrides: Partial<SubscriptionRow> = {}): SubscriptionRow {
  return {
    id: 'sub_1',
    user_id: USER.id,
    stripe_customer_id: 'cus_1',
    status: 'active',
    price_id: 'price_1',
    price_lookup_key: 'proplayer_monthly',
    current_period_end: '2026-11-03T16:00:00Z',
    cancel_at_period_end: false,
    cancel_at: null,
    canceled_at: null,
    ended_at: null,
    livemode: false,
    stripe_created_at: '2026-09-03T16:00:00Z',
    ...overrides
  };
}

// ---------------------------------------------------------------- database
export interface FakeDb extends Db {
  readonly calls: string[];
  readonly state: {
    customers: Map<string, CustomerRow>;
    subscriptions: Map<string, SubscriptionUpsert | SubscriptionRow>;
    events: Map<string, { type: string; processed_at: string | null }>;
  };
}

export function fakeDb(seed: {
  customers?: CustomerRow[];
  subscriptions?: SubscriptionRow[];
  events?: { id: string; type: string; processed_at?: string | null }[];
} = {}): FakeDb {
  const calls: string[] = [];
  const customers = new Map((seed.customers ?? []).map(row => [row.user_id, { ...row }]));
  const subscriptions = new Map<string, SubscriptionUpsert | SubscriptionRow>(
    (seed.subscriptions ?? []).map(row => [row.id, { ...row }])
  );
  const events = new Map(
    (seed.events ?? []).map(row => [row.id, { type: row.type, processed_at: row.processed_at ?? null }])
  );

  return {
    calls,
    state: { customers, subscriptions, events },

    getCustomer(userId) {
      calls.push(`getCustomer:${userId}`);
      return Promise.resolve(customers.get(userId) ?? null);
    },
    getCustomerByStripeId(stripeCustomerId) {
      calls.push(`getCustomerByStripeId:${stripeCustomerId}`);
      for (const row of customers.values()) if (row.stripe_customer_id === stripeCustomerId) return Promise.resolve(row);
      return Promise.resolve(null);
    },
    insertCustomer(row) {
      calls.push(`insertCustomer:${row.user_id}:${row.stripe_customer_id}`);
      if (!customers.has(row.user_id)) customers.set(row.user_id, { ...row, last_synced_at: null });
      return Promise.resolve();
    },
    listSubscriptions(userId) {
      calls.push(`listSubscriptions:${userId}`);
      const rows = [...subscriptions.values()].filter(row => row.user_id === userId) as SubscriptionRow[];
      return Promise.resolve(rows.map(row => ({ ...row })));
    },
    upsertSubscription(row) {
      calls.push(`upsertSubscription:${row.id}:${row.status}`);
      subscriptions.set(row.id, { ...row });
      return Promise.resolve();
    },
    markSynced(userId, at) {
      calls.push(`markSynced:${userId}:${at ?? 'null'}`);
      const row = customers.get(userId);
      if (row) customers.set(userId, { ...row, last_synced_at: at });
      return Promise.resolve();
    },
    recordEvent(id, type) {
      calls.push(`recordEvent:${id}`);
      const existing = events.get(id);
      if (!existing) {
        events.set(id, { type, processed_at: null });
        return Promise.resolve({ alreadyProcessed: false });
      }
      return Promise.resolve({ alreadyProcessed: Boolean(existing.processed_at) });
    },
    markEventProcessed(id, at) {
      calls.push(`markEventProcessed:${id}`);
      const existing = events.get(id);
      if (existing) events.set(id, { ...existing, processed_at: at });
      return Promise.resolve();
    }
  };
}

// ---------------------------------------------------------------- sync
export interface FakeSync extends Sync {
  readonly subscriptionCalls: string[];
  readonly customerCalls: string[];
}

export function fakeSync(behaviour: {
  onSubscription?: (id: string, hintedUserId?: string | null) => void | Promise<void>;
  onCustomer?: (stripeCustomerId: string, userId: string) => void | Promise<void>;
} = {}): FakeSync {
  const subscriptionCalls: string[] = [];
  const customerCalls: string[] = [];
  return {
    subscriptionCalls,
    customerCalls,
    async syncSubscription(id, hintedUserId = null) {
      subscriptionCalls.push(id);
      await behaviour.onSubscription?.(id, hintedUserId);
      return null;
    },
    async syncCustomer(stripeCustomerId, userId) {
      customerCalls.push(stripeCustomerId);
      await behaviour.onCustomer?.(stripeCustomerId, userId);
      return 0;
    }
  };
}

export const clockAt = (iso: string) => () => Date.parse(iso);
export const fixedClock = () => FIXED_NOW;

/** Reads a shared contract file from `contract/`, wherever the test is run from. */
export async function contractFile(relativePath: string): Promise<string> {
  const url = new URL(`../../../contract/${relativePath}`, import.meta.url);
  return await Deno.readTextFile(url);
}

export async function contractJson<T = unknown>(relativePath: string): Promise<T> {
  return JSON.parse(await contractFile(relativePath)) as T;
}
