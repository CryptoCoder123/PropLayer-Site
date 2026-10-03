// Typed, narrow wrapper over the three tables. Every call here runs with the service-role
// key, which bypasses RLS — that is exactly why nothing in this file takes a table name or
// a filter from the caller, and why every read is scoped by a user id or a Stripe id.

import type { SubscriptionRow } from './entitlement.ts';

export interface CustomerRow {
  user_id: string;
  stripe_customer_id: string;
  last_synced_at: string | null;
  created_at?: string;
}

export interface SubscriptionUpsert {
  id: string;
  user_id: string;
  stripe_customer_id: string;
  status: SubscriptionRow['status'];
  price_id: string | null;
  price_lookup_key: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  cancel_at: string | null;
  canceled_at: string | null;
  ended_at: string | null;
  livemode: boolean;
  stripe_created_at: string;
  updated_at: string;
}

export interface Db {
  getCustomer(userId: string): Promise<CustomerRow | null>;
  getCustomerByStripeId(stripeCustomerId: string): Promise<CustomerRow | null>;
  /** `on conflict (user_id) do nothing`, so double-clicks and webhook races are harmless. */
  insertCustomer(row: { user_id: string; stripe_customer_id: string }): Promise<void>;
  listSubscriptions(userId: string): Promise<SubscriptionRow[]>;
  upsertSubscription(row: SubscriptionUpsert): Promise<void>;
  /** `null` forces the next `entitlement` call to re-sync from Stripe. */
  markSynced(userId: string, at: string | null): Promise<void>;
  /** Returns the ledger row as it stands *before* this call inserted anything. */
  recordEvent(id: string, type: string): Promise<{ alreadyProcessed: boolean }>;
  markEventProcessed(id: string, at: string): Promise<void>;
}

/** Minimal shape of the supabase-js client this module uses, so tests can fake it. */
export interface SupabaseLike {
  from(table: string): any;
}

function firstRow<T>(result: { data: unknown; error: { message?: string; code?: string } | null }): T | null {
  if (result.error) throw new Error(`database error: ${result.error.message ?? result.error.code ?? 'unknown'}`);
  const data = result.data as T[] | T | null;
  if (!data) return null;
  return Array.isArray(data) ? (data[0] ?? null) : data;
}

function assertOk(result: { error: { message?: string; code?: string } | null }): void {
  if (result.error) throw new Error(`database error: ${result.error.message ?? result.error.code ?? 'unknown'}`);
}

export function createDb(client: SupabaseLike): Db {
  return {
    async getCustomer(userId) {
      return firstRow<CustomerRow>(
        await client.from('customers').select('user_id, stripe_customer_id, last_synced_at').eq('user_id', userId).limit(1)
      );
    },

    async getCustomerByStripeId(stripeCustomerId) {
      return firstRow<CustomerRow>(
        await client.from('customers').select('user_id, stripe_customer_id, last_synced_at')
          .eq('stripe_customer_id', stripeCustomerId).limit(1)
      );
    },

    async insertCustomer(row) {
      // ignoreDuplicates keeps an existing mapping intact: a user's Stripe customer id is
      // never silently repointed by a retried request.
      assertOk(await client.from('customers').upsert(row, { onConflict: 'user_id', ignoreDuplicates: true }));
    },

    async listSubscriptions(userId) {
      const result = await client.from('subscriptions').select('*').eq('user_id', userId)
        .order('stripe_created_at', { ascending: false }).limit(20);
      if (result.error) throw new Error(`database error: ${result.error.message ?? 'unknown'}`);
      return (result.data as SubscriptionRow[] | null) ?? [];
    },

    async upsertSubscription(row) {
      assertOk(await client.from('subscriptions').upsert(row, { onConflict: 'id' }));
    },

    async markSynced(userId, at) {
      assertOk(await client.from('customers').update({ last_synced_at: at }).eq('user_id', userId));
    },

    async recordEvent(id, type) {
      // Insert first; a conflict means another delivery of the same event got here first.
      const inserted = await client.from('stripe_events')
        .upsert({ id, type }, { onConflict: 'id', ignoreDuplicates: true }).select('id');
      assertOk(inserted);
      const wonTheRace = Array.isArray(inserted.data) && inserted.data.length > 0;
      if (wonTheRace) return { alreadyProcessed: false };

      const existing = firstRow<{ processed_at: string | null }>(
        await client.from('stripe_events').select('processed_at').eq('id', id).limit(1)
      );
      return { alreadyProcessed: Boolean(existing?.processed_at) };
    },

    async markEventProcessed(id, at) {
      assertOk(await client.from('stripe_events').update({ processed_at: at }).eq('id', id));
    }
  };
}
