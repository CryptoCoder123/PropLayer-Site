// Pulling fresh truth from Stripe into public.subscriptions.
//
// Every sync *retrieves* the subscription from Stripe rather than trusting the webhook
// payload, so out-of-order or replayed deliveries cannot regress state: whatever Stripe
// says right now is what gets stored.

import type { Db, SubscriptionUpsert } from './db.ts';
import { msToIso, periodEnd, secondsToMs, type Stripe } from './stripe.ts';

export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface SyncDeps {
  stripe: Pick<Stripe, 'subscriptions'>;
  db: Db;
  log: Logger;
  now(): number;
}

export interface Sync {
  /** Fetches the subscription fresh and upserts it. Returns the stored row, or null when the user cannot be resolved. */
  syncSubscription(subscriptionId: string, hintedUserId?: string | null): Promise<SubscriptionUpsert | null>;
  /** Re-reads every subscription Stripe has for a customer. Returns how many rows were stored. */
  syncCustomer(stripeCustomerId: string, userId: string): Promise<number>;
}

function customerIdOf(subscription: Stripe.Subscription): string {
  const customer = subscription.customer as string | { id?: string } | null;
  if (!customer) return '';
  return typeof customer === 'string' ? customer : (customer.id ?? '');
}

export function toRow(subscription: Stripe.Subscription, userId: string, nowMs: number): SubscriptionUpsert {
  const item = subscription.items?.data?.[0];
  const price = item?.price;
  return {
    id: subscription.id,
    user_id: userId,
    stripe_customer_id: customerIdOf(subscription),
    status: subscription.status as SubscriptionUpsert['status'],
    price_id: price?.id ?? null,
    price_lookup_key: price?.lookup_key ?? null,
    current_period_end: msToIso(periodEnd(subscription)),
    cancel_at_period_end: Boolean(subscription.cancel_at_period_end),
    cancel_at: msToIso(secondsToMs(subscription.cancel_at)),
    canceled_at: msToIso(secondsToMs(subscription.canceled_at)),
    ended_at: msToIso(secondsToMs(subscription.ended_at)),
    livemode: Boolean(subscription.livemode),
    stripe_created_at: msToIso(secondsToMs(subscription.created)) ?? new Date(nowMs).toISOString(),
    updated_at: new Date(nowMs).toISOString()
  };
}

export function createSync({ stripe, db, log, now }: SyncDeps): Sync {
  /**
   * User resolution order: the subscription's own metadata, then the hint the caller
   * supplied (a Checkout session's `client_reference_id`), then the `customers` mapping.
   * Users are never matched by email — two Stripe customers can share one.
   */
  async function resolveUserId(subscription: Stripe.Subscription, hintedUserId?: string | null): Promise<string | null> {
    const fromMetadata = (subscription.metadata?.user_id ?? '').trim();
    if (fromMetadata) return fromMetadata;
    if (hintedUserId) return hintedUserId;

    const stripeCustomerId = customerIdOf(subscription);
    if (!stripeCustomerId) return null;
    const customer = await db.getCustomerByStripeId(stripeCustomerId);
    return customer?.user_id ?? null;
  }

  async function store(subscription: Stripe.Subscription, hintedUserId?: string | null): Promise<SubscriptionUpsert | null> {
    const userId = await resolveUserId(subscription, hintedUserId);
    if (!userId) {
      // An orphan is logged and left alone. Guessing an owner would hand one person's
      // subscription to another; a real orphan is an operator problem, not a code path.
      log.warn('orphan_subscription', { subscription: subscription.id, customer: customerIdOf(subscription) });
      return null;
    }
    const row = toRow(subscription, userId, now());
    await db.upsertSubscription(row);
    log.info('subscription_synced', { subscription: row.id, user: row.user_id, status: row.status });
    return row;
  }

  return {
    async syncSubscription(subscriptionId, hintedUserId = null) {
      if (!subscriptionId) return null;
      const subscription = await stripe.subscriptions.retrieve(subscriptionId, { expand: ['items.data.price'] });
      return await store(subscription as Stripe.Subscription, hintedUserId);
    },

    async syncCustomer(stripeCustomerId, userId) {
      if (!stripeCustomerId || !userId) return 0;
      const { data } = await (stripe.subscriptions as Stripe['subscriptions']).list({
        customer: stripeCustomerId,
        status: 'all',
        limit: 10,
        expand: ['data.items.data.price']
      });
      let stored = 0;
      for (const subscription of data) {
        if (await store(subscription as Stripe.Subscription, userId)) stored++;
      }
      log.info('customer_synced', { customer: stripeCustomerId, user: userId, subscriptions: stored });
      return stored;
    }
  };
}

/** Structured console logging. Ids and outcomes only — never tokens, bodies or emails. */
export function createLogger(scope: string): Logger {
  const emit = (level: string, message: string, fields?: Record<string, unknown>) => {
    console.log(JSON.stringify({ level, scope, message, ...(fields ?? {}) }));
  };
  return {
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields)
  };
}
