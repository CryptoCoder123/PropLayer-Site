// `syncSubscription` / `syncCustomer`: how a Stripe subscription becomes a database row,
// including the item-level vs legacy period end and the user-resolution order.

import { assert, assertEquals } from 'jsr:@std/assert@1';
import { periodEnd, subscriptionIdFromInvoice } from '../_shared/stripe.ts';
import { createSync, toRow } from '../_shared/sync.ts';
import { fakeDb, fakeLogger, FIXED_NOW, USER } from './fakes.ts';

const SECONDS = (iso: string) => Math.floor(Date.parse(iso) / 1000);

function stripeSubscription(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub_1',
    object: 'subscription',
    customer: 'cus_1',
    status: 'active',
    cancel_at_period_end: false,
    cancel_at: null,
    canceled_at: null,
    ended_at: null,
    livemode: false,
    created: SECONDS('2026-09-03T16:00:00Z'),
    metadata: {},
    items: {
      object: 'list',
      data: [{
        id: 'si_1',
        object: 'subscription_item',
        current_period_end: SECONDS('2026-11-03T16:00:00Z'),
        price: { id: 'price_1', lookup_key: 'proplayer_monthly' }
      }]
    },
    ...overrides
  };
}

function fakeStripe(behaviour: {
  retrieve?: (id: string) => unknown;
  list?: (params: unknown) => unknown;
} = {}) {
  const retrieves: { id: string; params: any }[] = [];
  const lists: any[] = [];
  return {
    retrieves,
    lists,
    subscriptions: {
      retrieve(id: string, params: any) {
        retrieves.push({ id, params });
        return Promise.resolve(behaviour.retrieve?.(id) ?? stripeSubscription());
      },
      list(params: any) {
        lists.push(params);
        return Promise.resolve(behaviour.list?.(params) ?? { data: [stripeSubscription()] });
      }
    }
  };
}

function syncWith(options: { stripe?: ReturnType<typeof fakeStripe>; db?: ReturnType<typeof fakeDb> } = {}) {
  const stripe = options.stripe ?? fakeStripe();
  const db = options.db ?? fakeDb();
  const log = fakeLogger();
  return { sync: createSync({ stripe: stripe as never, db, log, now: () => FIXED_NOW }), stripe, db, log };
}

// ---------------------------------------------------------------- period end
Deno.test('periodEnd reads the subscription item (Stripe API 2025-03-31 and later)', () => {
  assertEquals(periodEnd(stripeSubscription() as never), Date.parse('2026-11-03T16:00:00Z'));
});

Deno.test('periodEnd falls back to the legacy top-level field for older payloads', () => {
  const legacy = stripeSubscription({
    items: { object: 'list', data: [{ id: 'si_1', price: { id: 'price_1', lookup_key: 'proplayer_monthly' } }] },
    current_period_end: SECONDS('2026-12-01T16:00:00Z')
  });
  assertEquals(periodEnd(legacy as never), Date.parse('2026-12-01T16:00:00Z'));
});

Deno.test('periodEnd prefers the item when both are present', () => {
  const both = stripeSubscription({ current_period_end: SECONDS('2026-12-01T16:00:00Z') });
  assertEquals(periodEnd(both as never), Date.parse('2026-11-03T16:00:00Z'));
});

Deno.test('periodEnd is null when neither field exists', () => {
  assertEquals(periodEnd(stripeSubscription({ items: { object: 'list', data: [] } }) as never), null);
  assertEquals(periodEnd(null), null);
});

// ---------------------------------------------------------------- invoice id extraction
Deno.test('subscriptionIdFromInvoice handles both shapes and both forms', () => {
  assertEquals(subscriptionIdFromInvoice({ parent: { subscription_details: { subscription: 'sub_a' } } } as never), 'sub_a');
  assertEquals(subscriptionIdFromInvoice({ parent: { subscription_details: { subscription: { id: 'sub_b' } } } } as never), 'sub_b');
  assertEquals(subscriptionIdFromInvoice({ subscription: 'sub_c' } as never), 'sub_c');
  assertEquals(subscriptionIdFromInvoice({ subscription: { id: 'sub_d' } } as never), 'sub_d');
  assertEquals(subscriptionIdFromInvoice({ parent: { subscription_details: { subscription: null } }, subscription: 'sub_e' } as never), 'sub_e');
  assertEquals(subscriptionIdFromInvoice({ id: 'in_1' } as never), null);
  assertEquals(subscriptionIdFromInvoice(null), null);
});

// ---------------------------------------------------------------- row mapping
Deno.test('toRow maps every column the decision table reads', () => {
  const row = toRow(stripeSubscription({
    cancel_at_period_end: true,
    cancel_at: SECONDS('2026-10-20T16:00:00Z'),
    canceled_at: SECONDS('2026-10-03T12:00:00Z'),
    livemode: true
  }) as never, USER.id, FIXED_NOW);

  assertEquals(row, {
    id: 'sub_1',
    user_id: USER.id,
    stripe_customer_id: 'cus_1',
    status: 'active',
    price_id: 'price_1',
    price_lookup_key: 'proplayer_monthly',
    current_period_end: '2026-11-03T16:00:00.000Z',
    cancel_at_period_end: true,
    cancel_at: '2026-10-20T16:00:00.000Z',
    canceled_at: '2026-10-03T12:00:00.000Z',
    ended_at: null,
    livemode: true,
    stripe_created_at: '2026-09-03T16:00:00.000Z',
    updated_at: '2026-10-03T16:00:00.000Z'
  });
});

Deno.test('toRow accepts an expanded customer object', () => {
  const row = toRow(stripeSubscription({ customer: { id: 'cus_expanded', object: 'customer' } }) as never, USER.id, FIXED_NOW);
  assertEquals(row.stripe_customer_id, 'cus_expanded');
});

Deno.test('toRow leaves price columns null when the item has no price', () => {
  const row = toRow(stripeSubscription({ items: { object: 'list', data: [{ id: 'si_1' }] } }) as never, USER.id, FIXED_NOW);
  assertEquals(row.price_id, null);
  assertEquals(row.price_lookup_key, null);
});

// ---------------------------------------------------------------- syncSubscription
Deno.test('syncSubscription always retrieves fresh state with the price expanded', async () => {
  const { sync, stripe, db } = syncWith();
  const row = await sync.syncSubscription('sub_1', USER.id);
  assertEquals(stripe.retrieves, [{ id: 'sub_1', params: { expand: ['items.data.price'] } }]);
  assertEquals(row?.status, 'active');
  assert(db.calls.includes('upsertSubscription:sub_1:active'));
});

Deno.test('syncSubscription resolves the user from subscription metadata first', async () => {
  const stripe = fakeStripe({ retrieve: () => stripeSubscription({ metadata: { user_id: USER.id } }) });
  const { sync, db } = syncWith({ stripe });
  const row = await sync.syncSubscription('sub_1');
  assertEquals(row?.user_id, USER.id);
  assertEquals(db.calls.includes('getCustomerByStripeId:cus_1'), false, 'metadata made a lookup unnecessary');
});

Deno.test('syncSubscription uses the caller hint when metadata is empty', async () => {
  const { sync } = syncWith();
  const row = await sync.syncSubscription('sub_1', 'hinted-user-id');
  assertEquals(row?.user_id, 'hinted-user-id');
});

Deno.test('syncSubscription falls back to the customers mapping', async () => {
  const db = fakeDb({ customers: [{ user_id: USER.id, stripe_customer_id: 'cus_1', last_synced_at: null }] });
  const { sync } = syncWith({ db });
  const row = await sync.syncSubscription('sub_1');
  assertEquals(row?.user_id, USER.id);
});

Deno.test('syncSubscription prefers metadata over a conflicting customers mapping', async () => {
  const stripe = fakeStripe({ retrieve: () => stripeSubscription({ metadata: { user_id: 'metadata-user' } }) });
  const db = fakeDb({ customers: [{ user_id: 'mapping-user', stripe_customer_id: 'cus_1', last_synced_at: null }] });
  const { sync } = syncWith({ stripe, db });
  assertEquals((await sync.syncSubscription('sub_1'))?.user_id, 'metadata-user');
});

Deno.test('an orphan subscription is logged and never written, and no user is guessed', async () => {
  const { sync, db, log } = syncWith();
  assertEquals(await sync.syncSubscription('sub_1'), null);
  assertEquals(db.state.subscriptions.size, 0);
  const warning = log.entries.find(e => e.message === 'orphan_subscription');
  assertEquals(warning?.fields, { subscription: 'sub_1', customer: 'cus_1' });
});

Deno.test('syncSubscription with no id does nothing', async () => {
  const { sync, stripe } = syncWith();
  assertEquals(await sync.syncSubscription(''), null);
  assertEquals(stripe.retrieves, []);
});

Deno.test('a deleted subscription is stored with the status Stripe reports now', async () => {
  const stripe = fakeStripe({
    retrieve: () => stripeSubscription({
      status: 'canceled',
      metadata: { user_id: USER.id },
      canceled_at: SECONDS('2026-10-03T15:00:00Z'),
      ended_at: SECONDS('2026-10-03T15:00:00Z')
    })
  });
  const { sync } = syncWith({ stripe });
  const row = await sync.syncSubscription('sub_1');
  assertEquals(row?.status, 'canceled');
  assertEquals(row?.ended_at, '2026-10-03T15:00:00.000Z');
});

// ---------------------------------------------------------------- syncCustomer
Deno.test('syncCustomer lists all of a customer\'s subscriptions and stores each', async () => {
  const stripe = fakeStripe({
    list: () => ({
      data: [
        stripeSubscription({ id: 'sub_old', status: 'canceled' }),
        stripeSubscription({ id: 'sub_new', status: 'active' })
      ]
    })
  });
  const { sync, db } = syncWith({ stripe });
  assertEquals(await sync.syncCustomer('cus_1', USER.id), 2);
  assertEquals(stripe.lists[0], {
    customer: 'cus_1',
    status: 'all',
    limit: 10,
    expand: ['data.items.data.price']
  });
  assertEquals([...db.state.subscriptions.keys()].sort(), ['sub_new', 'sub_old']);
});

Deno.test('syncCustomer attributes rows to the user it was given', async () => {
  const { sync, db } = syncWith();
  await sync.syncCustomer('cus_1', USER.id);
  assertEquals((db.state.subscriptions.get('sub_1') as { user_id: string }).user_id, USER.id);
});

Deno.test('syncCustomer with a missing id or user does nothing', async () => {
  const { sync, stripe } = syncWith();
  assertEquals(await sync.syncCustomer('', USER.id), 0);
  assertEquals(await sync.syncCustomer('cus_1', ''), 0);
  assertEquals(stripe.lists, []);
});
