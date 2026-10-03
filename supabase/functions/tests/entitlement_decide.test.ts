// Contract C5 decision table and response shape. This is the file to read first when
// asking "when may someone run Prop Layer?" — every row of the table is a case below.

import { assert, assertEquals, assertObjectMatch } from 'jsr:@std/assert@1';
import { buildResponse, decide, rfc3339, type SubscriptionRow } from '../_shared/entitlement.ts';
import { config, contractJson, FIXED_NOW, subscriptionRow, USER } from './fakes.ts';

const cfg = config();
const NOW = FIXED_NOW;
const FUTURE = '2026-11-03T16:00:00Z';
const PAST = '2026-09-30T16:00:00Z';

function decideOne(overrides: Partial<SubscriptionRow>, env = {}) {
  return decide([subscriptionRow(overrides)], NOW, config(env));
}

// ---------------------------------------------------------------- the decision table
Deno.test('decision table: active, period end in the future, no scheduled cancellation', () => {
  const d = decideOne({ status: 'active', current_period_end: FUTURE });
  assertEquals(d.entitled, true);
  assertEquals(d.reason, 'active');
  assertEquals(rfc3339(d.accessUntil), FUTURE);
});

Deno.test('decision table: active with cancel_at_period_end is canceled_pending but still entitled', () => {
  const d = decideOne({ status: 'active', current_period_end: FUTURE, cancel_at_period_end: true });
  assertEquals(d.entitled, true);
  assertEquals(d.reason, 'canceled_pending');
  assertEquals(rfc3339(d.accessUntil), FUTURE);
});

Deno.test('decision table: a non-null cancel_at alone counts as a scheduled cancellation', () => {
  const d = decideOne({ status: 'active', current_period_end: FUTURE, cancel_at: FUTURE });
  assertEquals(d.reason, 'canceled_pending');
  assertEquals(d.entitled, true);
});

Deno.test('decision table: access ends at the earlier of period end and cancel_at', () => {
  const earlier = '2026-10-20T16:00:00Z';
  const d = decideOne({ status: 'active', current_period_end: FUTURE, cancel_at_period_end: true, cancel_at: earlier });
  assertEquals(d.reason, 'canceled_pending');
  assertEquals(rfc3339(d.accessUntil), earlier, 'a cancellation must never extend access');
});

Deno.test('decision table: a cancel_at after the period end does not extend access', () => {
  const later = '2027-01-01T16:00:00Z';
  const d = decideOne({ status: 'active', current_period_end: FUTURE, cancel_at: later });
  assertEquals(rfc3339(d.accessUntil), FUTURE);
});

Deno.test('decision table: trialing, period end in the future', () => {
  const d = decideOne({ status: 'trialing', current_period_end: FUTURE });
  assertEquals(d.entitled, true);
  assertEquals(d.reason, 'trialing');
  assertEquals(rfc3339(d.accessUntil), FUTURE);
});

Deno.test('decision table: trialing with a scheduled cancellation is canceled_pending', () => {
  const d = decideOne({ status: 'trialing', current_period_end: FUTURE, cancel_at_period_end: true });
  assertEquals(d.entitled, true);
  assertEquals(d.reason, 'canceled_pending');
});

Deno.test('decision table: past_due keeps access while PAST_DUE_ENTITLED is true (the default)', () => {
  const d = decideOne({ status: 'past_due', current_period_end: FUTURE });
  assertEquals(d.entitled, true);
  assertEquals(d.reason, 'past_due_grace');
  assertEquals(rfc3339(d.accessUntil), FUTURE);
});

Deno.test('decision table: past_due loses access when PAST_DUE_ENTITLED is false', () => {
  const d = decideOne({ status: 'past_due', current_period_end: FUTURE }, { PAST_DUE_ENTITLED: 'false' });
  assertEquals(d.entitled, false);
  assertEquals(d.reason, 'payment_failed');
  assertEquals(d.accessUntil, null);
});

Deno.test('decision table: unpaid is payment_failed', () => {
  const d = decideOne({ status: 'unpaid', current_period_end: FUTURE });
  assertEquals(d.entitled, false);
  assertEquals(d.reason, 'payment_failed');
});

Deno.test('decision table: incomplete is incomplete', () => {
  const d = decideOne({ status: 'incomplete', current_period_end: FUTURE });
  assertEquals(d.entitled, false);
  assertEquals(d.reason, 'incomplete');
});

Deno.test('decision table: incomplete_expired, canceled and paused are expired', () => {
  for (const status of ['incomplete_expired', 'canceled', 'paused'] as const) {
    const d = decideOne({ status, current_period_end: FUTURE });
    assertEquals(d.entitled, false, status);
    assertEquals(d.reason, 'expired', status);
    assertEquals(d.accessUntil, null, status);
  }
});

Deno.test('decision table: a live status whose period end has passed is expired and marked stale', () => {
  for (const status of ['active', 'trialing', 'past_due'] as const) {
    const d = decideOne({ status, current_period_end: PAST });
    assertEquals(d.entitled, false, status);
    assertEquals(d.reason, 'expired', status);
    assertEquals(d.stale, true, `${status} must trigger an on-demand Stripe re-sync`);
  }
});

Deno.test('decision table: a live status with no period end at all is expired, not entitled', () => {
  const d = decideOne({ status: 'active', current_period_end: null });
  assertEquals(d.entitled, false);
  assertEquals(d.reason, 'expired');
  assertEquals(d.stale, true);
});

Deno.test('decision table: period end exactly now is not entitled (the boundary is exclusive)', () => {
  const d = decideOne({ status: 'active', current_period_end: '2026-10-03T16:00:00Z' });
  assertEquals(d.entitled, false);
  assertEquals(d.reason, 'expired');
});

Deno.test('decision table: one second past now is still entitled', () => {
  const d = decideOne({ status: 'active', current_period_end: '2026-10-03T16:00:01Z' });
  assertEquals(d.entitled, true);
  assertEquals(d.reason, 'active');
});

Deno.test('decision table: no rows at all is no_subscription with a null subscription', () => {
  const d = decide([], NOW, cfg);
  assertEquals(d.entitled, false);
  assertEquals(d.reason, 'no_subscription');
  assertEquals(d.row, null);
  assertEquals(d.stale, false);
});

Deno.test('an unknown status never grants access', () => {
  const d = decide([subscriptionRow({ status: 'something_new' as never, current_period_end: FUTURE })], NOW, cfg);
  assertEquals(d.entitled, false);
  assertEquals(d.reason, 'expired');
});

// ---------------------------------------------------------------- most relevant subscription
Deno.test('most relevant subscription: an entitled row wins over a newer canceled one', () => {
  const d = decide([
    subscriptionRow({ id: 'sub_new', status: 'canceled', stripe_created_at: '2026-10-01T00:00:00Z' }),
    subscriptionRow({ id: 'sub_old', status: 'active', current_period_end: FUTURE, stripe_created_at: '2026-01-01T00:00:00Z' })
  ], NOW, cfg);
  assertEquals(d.entitled, true);
  assertEquals(d.row?.id, 'sub_old');
});

Deno.test('most relevant subscription: with no entitled row the most recent one is reported', () => {
  const d = decide([
    subscriptionRow({ id: 'sub_old', status: 'canceled', stripe_created_at: '2026-01-01T00:00:00Z' }),
    subscriptionRow({ id: 'sub_new', status: 'incomplete', stripe_created_at: '2026-10-01T00:00:00Z' })
  ], NOW, cfg);
  assertEquals(d.entitled, false);
  assertEquals(d.row?.id, 'sub_new');
  assertEquals(d.reason, 'incomplete');
});

Deno.test('most relevant subscription: the choice is deterministic when created dates tie', () => {
  const rows = [
    subscriptionRow({ id: 'sub_b', status: 'canceled', stripe_created_at: '2026-05-01T00:00:00Z' }),
    subscriptionRow({ id: 'sub_a', status: 'unpaid', stripe_created_at: '2026-05-01T00:00:00Z' })
  ];
  const first = decide(rows, NOW, cfg);
  const second = decide([...rows].reverse(), NOW, cfg);
  assertEquals(first.row?.id, second.row?.id);
});

Deno.test('decide does not mutate the rows it is given', () => {
  const rows = [subscriptionRow({ id: 'sub_1' }), subscriptionRow({ id: 'sub_2', stripe_created_at: '2026-10-02T00:00:00Z' })];
  const snapshot = JSON.stringify(rows);
  decide(rows, NOW, cfg);
  assertEquals(JSON.stringify(rows), snapshot);
});

// ---------------------------------------------------------------- clamping
Deno.test('recheck and grace are clamped to the contract ranges', () => {
  assertEquals(config({ ENTITLEMENT_RECHECK_SECONDS: '1' }).recheckAfterSeconds, 300);
  assertEquals(config({ ENTITLEMENT_RECHECK_SECONDS: '999999' }).recheckAfterSeconds, 86_400);
  assertEquals(config({ ENTITLEMENT_RECHECK_SECONDS: 'nonsense' }).recheckAfterSeconds, 3600);
  assertEquals(config({ ENTITLEMENT_RECHECK_SECONDS: '' }).recheckAfterSeconds, 3600);
  assertEquals(config({ OFFLINE_GRACE_SECONDS: '-5' }).offlineGraceSeconds, 0);
  assertEquals(config({ OFFLINE_GRACE_SECONDS: '99999999' }).offlineGraceSeconds, 604_800);
  assertEquals(config({ OFFLINE_GRACE_SECONDS: '600' }).offlineGraceSeconds, 600);
});

// ---------------------------------------------------------------- timestamps
Deno.test('rfc3339 produces UTC with second precision and a Z suffix', () => {
  assertEquals(rfc3339(Date.parse('2026-11-03T16:00:00.750Z')), '2026-11-03T16:00:00Z');
  assertEquals(rfc3339('2026-11-03T18:00:00+02:00'), '2026-11-03T16:00:00Z');
  assertEquals(rfc3339(null), null);
  assertEquals(rfc3339(''), null);
  assertEquals(rfc3339('not a date'), null);
});

// ---------------------------------------------------------------- fixtures
const FIXTURE_STATES: Record<string, Partial<SubscriptionRow> | null> = {
  active: { status: 'active', current_period_end: '2026-11-03T16:00:00Z' },
  canceled_pending: { status: 'active', current_period_end: '2026-10-20T16:00:00Z', cancel_at_period_end: true },
  past_due_grace: { status: 'past_due', current_period_end: '2026-11-01T16:00:00Z' },
  expired: { status: 'canceled', current_period_end: '2026-09-30T16:00:00Z' },
  no_subscription: null
};

for (const [name, state] of Object.entries(FIXTURE_STATES)) {
  Deno.test(`buildResponse deep-equals contract/fixtures/entitlement.${name}.json`, async () => {
    const rows = state ? [subscriptionRow(state)] : [];
    const decision = decide(rows, FIXED_NOW, cfg);
    const response = buildResponse(USER, decision, FIXED_NOW, cfg);
    assertEquals(response, await contractJson(`fixtures/entitlement.${name}.json`));
  });
}

Deno.test('buildResponse falls back to the configured plan when a row has no lookup key', () => {
  const decision = decide([subscriptionRow({ price_lookup_key: null })], FIXED_NOW, cfg);
  const response = buildResponse(USER, decision, FIXED_NOW, cfg);
  assertEquals(response.subscription?.plan, 'proplayer_monthly');
});

Deno.test('buildResponse reports a null access_until whenever entitled is false', () => {
  const decision = decide([subscriptionRow({ status: 'unpaid' })], FIXED_NOW, cfg);
  const response = buildResponse(USER, decision, FIXED_NOW, cfg);
  assertEquals(response.entitled, false);
  assertEquals(response.subscription?.access_until, null);
  assert(response.subscription?.current_period_end, 'the period end is still reported for context');
});

Deno.test('links are derived from SITE_URL', () => {
  const response = buildResponse(USER, decide([], FIXED_NOW, cfg), FIXED_NOW, config({ SITE_URL: 'https://staging.example.com/' }));
  assertObjectMatch(response.links, {
    account: 'https://staging.example.com/account.html',
    subscribe: 'https://staging.example.com/account.html#subscribe',
    manage: 'https://staging.example.com/account.html#billing',
    download: 'https://staging.example.com/download.html'
  });
});
