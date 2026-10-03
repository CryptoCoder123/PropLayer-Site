// Stripe client factory and the handful of shape helpers the handlers need.
// Pinned to a single version; the SDK's default API version is used deliberately, so the
// code reads the *current* object shapes (billing periods on subscription items, invoice
// parents) with a fallback for payloads produced before those moves.

import Stripe from 'npm:stripe@18.5.0';
import { STRIPE_VERSION } from './env.ts';

export type { Stripe };
export { Stripe as StripeSdk, STRIPE_VERSION };

export function createStripe(secretKey: string): Stripe {
  return new Stripe(secretKey, {
    // Deno has no Node http stack: use fetch and WebCrypto.
    httpClient: Stripe.createFetchHttpClient(),
    appInfo: { name: 'PropLayer', url: 'https://prop-layer.com' }
  });
}

/** Webhook verification in Deno needs the SubtleCrypto provider (async HMAC). */
export function subtleCryptoProvider(): Stripe.CryptoProvider {
  return Stripe.createSubtleCryptoProvider();
}

type MaybeLegacySubscription = Stripe.Subscription & { current_period_end?: number | null };

/**
 * The subscription's current period end, in epoch milliseconds.
 *
 * Stripe API 2025-03-31 moved billing periods from the subscription to its items, so the
 * item is read first and the top-level field is only a fallback for older payloads.
 */
export function periodEnd(subscription: Stripe.Subscription | null | undefined): number | null {
  if (!subscription) return null;
  const item = subscription.items?.data?.[0] as (Stripe.SubscriptionItem & { current_period_end?: number | null }) | undefined;
  const seconds = item?.current_period_end ?? (subscription as MaybeLegacySubscription).current_period_end ?? null;
  return typeof seconds === 'number' && Number.isFinite(seconds) ? seconds * 1000 : null;
}

function idOf(value: string | { id?: string } | null | undefined): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value || null;
  return value.id || null;
}

type MaybeLegacyInvoice = Stripe.Invoice & { subscription?: string | Stripe.Subscription | null };

/**
 * The subscription an invoice belongs to. Current API nests it under
 * `parent.subscription_details.subscription`; older payloads put it on `invoice.subscription`.
 * Either may be an id or an expanded object.
 */
export function subscriptionIdFromInvoice(invoice: Stripe.Invoice | null | undefined): string | null {
  if (!invoice) return null;
  const parent = invoice.parent?.subscription_details?.subscription;
  return idOf(parent) ?? idOf((invoice as MaybeLegacyInvoice).subscription);
}

/** Unix seconds (or null) → epoch milliseconds (or null). */
export function secondsToMs(seconds: number | null | undefined): number | null {
  return typeof seconds === 'number' && Number.isFinite(seconds) ? seconds * 1000 : null;
}

export function msToIso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

interface CachedPrice {
  price: Stripe.Price | null;
  expiresAt: number;
}

/**
 * Price lookup by lookup key, cached for ten minutes per (key, mode) pair. Checkout is the
 * only caller and a price changes at most a few times a year, so this removes one Stripe
 * round trip from the common path without risking a stale price for long.
 */
export function createPriceLookup(stripe: Stripe, now: () => number = Date.now) {
  const cache = new Map<string, CachedPrice>();
  const TTL_MS = 10 * 60 * 1000;

  return {
    async byLookupKey(lookupKey: string): Promise<Stripe.Price | null> {
      const cached = cache.get(lookupKey);
      if (cached && cached.expiresAt > now()) return cached.price;

      const { data } = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
      const price = data[0] ?? null;
      cache.set(lookupKey, { price, expiresAt: now() + TTL_MS });
      return price;
    },
    clear() {
      cache.clear();
    }
  };
}

export type PriceLookup = ReturnType<typeof createPriceLookup>;
