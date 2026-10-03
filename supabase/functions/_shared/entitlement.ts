// The access decision (contract C5). Pure: no I/O, no clock of its own, no Stripe.
// Everything the website and the desktop app rely on is decided here, so the whole
// decision table is unit-tested against the shared fixtures.

import type { AuthUser } from './auth.ts';
import type { Config } from './env.ts';

export const SUBSCRIPTION_STATUSES = [
  'incomplete',
  'incomplete_expired',
  'trialing',
  'active',
  'past_due',
  'canceled',
  'unpaid',
  'paused'
] as const;

export type SubscriptionStatus = typeof SUBSCRIPTION_STATUSES[number];

export const REASONS = [
  'active',
  'trialing',
  'canceled_pending',
  'past_due_grace',
  'no_subscription',
  'expired',
  'payment_failed',
  'incomplete'
] as const;

export type Reason = typeof REASONS[number];

/** A row of `public.subscriptions`, as the service-role client returns it. */
export interface SubscriptionRow {
  id: string;
  user_id: string;
  stripe_customer_id: string;
  status: SubscriptionStatus;
  price_id?: string | null;
  price_lookup_key?: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  cancel_at?: string | null;
  canceled_at?: string | null;
  ended_at?: string | null;
  livemode?: boolean;
  stripe_created_at: string;
}

export interface Decision {
  readonly entitled: boolean;
  readonly reason: Reason;
  /** The "most relevant subscription", or null when the user never subscribed. */
  readonly row: SubscriptionRow | null;
  /** Epoch ms, or null. */
  readonly accessUntil: number | null;
  /**
   * True when the chosen row claims a live status (`active`/`trialing`/`past_due`) but its
   * period end has already passed. The `entitlement` handler re-syncs from Stripe once and
   * recomputes before answering (guide 5.3 step 5a), because the row may simply be stale.
   */
  readonly stale: boolean;
}

export interface EntitlementResponse {
  schema: 1;
  user: { id: string; email: string };
  entitled: boolean;
  reason: Reason;
  subscription: {
    status: SubscriptionStatus;
    plan: string;
    current_period_end: string | null;
    cancel_at_period_end: boolean;
    access_until: string | null;
  } | null;
  checked_at: string;
  recheck_after_seconds: number;
  offline_grace_seconds: number;
  links: { account: string; subscribe: string; manage: string; download: string };
}

/** RFC 3339 UTC with second precision and a `Z` suffix (contract C5). */
export function rfc3339(value: number | string | Date | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  const ms = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.000Z$/, 'Z');
}

function epoch(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

interface RowVerdict {
  entitled: boolean;
  reason: Reason;
  accessUntil: number | null;
  stale: boolean;
}

/**
 * One row's verdict. A scheduled cancellation is `cancel_at_period_end = true` **or** a
 * non-null `cancel_at`; when both a period end and a `cancel_at` exist, access ends at the
 * earlier of the two, so a cancellation can never extend access past the paid period.
 */
function verdictFor(row: SubscriptionRow, now: number, pastDueEntitled: boolean): RowVerdict {
  const periodEnd = epoch(row.current_period_end);
  const cancelAt = epoch(row.cancel_at);
  const live = periodEnd !== null && periodEnd > now;
  const scheduledCancellation = row.cancel_at_period_end === true || cancelAt !== null;
  const accessUntil = cancelAt !== null && periodEnd !== null ? Math.min(periodEnd, cancelAt) : periodEnd;

  switch (row.status) {
    case 'active':
    case 'trialing': {
      // Period end at or before now means the row is out of date (or really over);
      // the handler re-syncs from Stripe before this becomes the final answer.
      if (!live) return { entitled: false, reason: 'expired', accessUntil: null, stale: true };
      if (scheduledCancellation) return { entitled: true, reason: 'canceled_pending', accessUntil, stale: false };
      return { entitled: true, reason: row.status === 'active' ? 'active' : 'trialing', accessUntil: periodEnd, stale: false };
    }
    case 'past_due': {
      if (!live) return { entitled: false, reason: 'expired', accessUntil: null, stale: true };
      if (!pastDueEntitled) return { entitled: false, reason: 'payment_failed', accessUntil: null, stale: false };
      // Bounded by Stripe's retry schedule: "retry for up to 1 week, then cancel".
      return { entitled: true, reason: 'past_due_grace', accessUntil, stale: false };
    }
    case 'unpaid':
      return { entitled: false, reason: 'payment_failed', accessUntil: null, stale: false };
    case 'incomplete':
      return { entitled: false, reason: 'incomplete', accessUntil: null, stale: false };
    case 'incomplete_expired':
    case 'canceled':
    case 'paused':
      return { entitled: false, reason: 'expired', accessUntil: null, stale: false };
    default:
      // An unknown status must never grant access. The database CHECK makes this unreachable.
      return { entitled: false, reason: 'expired', accessUntil: null, stale: false };
  }
}

/** Newest first, with the id as a tie-break so the choice is deterministic. */
function newestFirst(a: SubscriptionRow, b: SubscriptionRow): number {
  const byCreated = (epoch(b.stripe_created_at) ?? 0) - (epoch(a.stripe_created_at) ?? 0);
  return byCreated !== 0 ? byCreated : a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * The decision. "Most relevant subscription" = an entitled one if any exists, otherwise
 * the most recently created one.
 */
export function decide(
  rows: readonly SubscriptionRow[],
  now: number,
  config: Pick<Config, 'pastDueEntitled'>
): Decision {
  const candidates = (rows ?? []).filter(Boolean);
  if (candidates.length === 0) {
    return Object.freeze({ entitled: false, reason: 'no_subscription' as Reason, row: null, accessUntil: null, stale: false });
  }

  const ranked = [...candidates].sort(newestFirst)
    .map(row => ({ row, verdict: verdictFor(row, now, config.pastDueEntitled) }));

  const chosen = ranked.find(entry => entry.verdict.entitled) ?? ranked[0];
  return Object.freeze({
    entitled: chosen.verdict.entitled,
    reason: chosen.verdict.reason,
    row: chosen.row,
    accessUntil: chosen.verdict.accessUntil,
    stale: chosen.verdict.stale
  });
}

export function links(siteUrl: string): EntitlementResponse['links'] {
  const base = siteUrl.replace(/\/+$/, '');
  return {
    account: `${base}/account.html`,
    subscribe: `${base}/account.html#subscribe`,
    manage: `${base}/account.html#billing`,
    download: `${base}/download.html`
  };
}

/** The wire format. Validated against contract/entitlement.v1.schema.json in the tests. */
export function buildResponse(
  user: AuthUser,
  decision: Decision,
  now: number,
  config: Pick<Config, 'priceLookupKey' | 'siteUrl' | 'recheckAfterSeconds' | 'offlineGraceSeconds'>
): EntitlementResponse {
  const row = decision.row;
  return {
    schema: 1,
    user: { id: user.id, email: user.email },
    entitled: decision.entitled,
    reason: decision.reason,
    subscription: row
      ? {
          status: row.status,
          // `plan` is the Stripe Price lookup key; the configured key is the fallback for
          // rows written before a lookup key existed (the schema requires a non-empty string).
          plan: row.price_lookup_key || config.priceLookupKey,
          current_period_end: rfc3339(row.current_period_end),
          cancel_at_period_end: Boolean(row.cancel_at_period_end),
          access_until: decision.entitled ? rfc3339(decision.accessUntil) : null
        }
      : null,
    checked_at: rfc3339(now) as string,
    recheck_after_seconds: config.recheckAfterSeconds,
    offline_grace_seconds: config.offlineGraceSeconds,
    links: links(config.siteUrl)
  };
}
