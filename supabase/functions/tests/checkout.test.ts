// `create-checkout-session`: the 409 guard, one-customer-per-user, and the exact session
// parameters Stripe receives (a wrong success_url or missing metadata breaks activation).

import { assert, assertEquals, assertObjectMatch } from 'jsr:@std/assert@1';
import { createHandler } from '../create-checkout-session/index.ts';
import { config, fakeAuth, fakeDb, fakeLogger, FIXED_NOW, request, subscriptionRow, USER } from './fakes.ts';

const CHECKOUT_URL = 'https://checkout.stripe.com/c/pay/cs_test_123';
const POST = { method: 'POST' } as const;
const url = 'https://project.supabase.co/functions/v1/create-checkout-session';

function fakeStripe(behaviour: {
  customerCreate?: (params: unknown, options: unknown) => unknown;
  sessionCreate?: (params: unknown) => unknown;
} = {}) {
  const customerCreates: { params: any; options: any }[] = [];
  const sessionCreates: any[] = [];
  return {
    customerCreates,
    sessionCreates,
    customers: {
      create(params: any, options: any) {
        customerCreates.push({ params, options });
        return Promise.resolve(behaviour.customerCreate?.(params, options) ?? { id: 'cus_new' });
      }
    },
    checkout: {
      sessions: {
        create(params: any) {
          sessionCreates.push(params);
          return Promise.resolve(behaviour.sessionCreate?.(params) ?? { id: 'cs_test_123', url: CHECKOUT_URL });
        }
      }
    }
  };
}

function fakePrices(price: { id: string; lookup_key?: string } | null = { id: 'price_1', lookup_key: 'proplayer_monthly' }) {
  const lookups: string[] = [];
  return { lookups, byLookupKey: (key: string) => { lookups.push(key); return Promise.resolve(price as never); }, clear() {} };
}

function handlerWith(options: {
  env?: Record<string, string | undefined>;
  db?: ReturnType<typeof fakeDb>;
  stripe?: ReturnType<typeof fakeStripe>;
  prices?: ReturnType<typeof fakePrices>;
  auth?: ReturnType<typeof fakeAuth>;
} = {}) {
  const db = options.db ?? fakeDb();
  const stripe = options.stripe ?? fakeStripe();
  const prices = options.prices ?? fakePrices();
  const log = fakeLogger();
  const handler = createHandler({
    config: config(options.env),
    now: () => FIXED_NOW,
    db,
    auth: options.auth ?? fakeAuth(),
    log,
    stripe: () => stripe as never,
    prices: () => prices as never
  });
  return { handler, db, stripe, prices, log };
}

// ---------------------------------------------------------------- guards
Deno.test('checkout: GET is 405', async () => {
  const { handler } = handlerWith();
  assertEquals((await handler(request(url, { method: 'GET' }))).status, 405);
});

Deno.test('checkout: OPTIONS is 204', async () => {
  const { handler } = handlerWith();
  assertEquals((await handler(request(url, { method: 'OPTIONS' }))).status, 204);
});

Deno.test('checkout: no token is 401 and nothing is created', async () => {
  const { handler, stripe } = handlerWith();
  assertEquals((await handler(request(url, { ...POST, token: null }))).status, 401);
  assertEquals(stripe.sessionCreates, []);
  assertEquals(stripe.customerCreates, []);
});

Deno.test('checkout: not configured is 503', async () => {
  const { handler } = handlerWith({ env: { STRIPE_SECRET_KEY: '' } });
  assertEquals((await handler(request(url, POST))).status, 503);
});

Deno.test('checkout: an entitled user gets 409 already_subscribed and no Stripe call', async () => {
  const db = fakeDb({ subscriptions: [subscriptionRow({ status: 'active', current_period_end: '2026-11-03T16:00:00Z' })] });
  const { handler, stripe } = handlerWith({ db });
  const response = await handler(request(url, POST));
  assertEquals(response.status, 409);
  const body = await response.json();
  assertEquals(body.error, 'already_subscribed');
  assert(body.message.includes('Manage billing'), body.message);
  assertEquals(stripe.sessionCreates, []);
});

Deno.test('checkout: a canceled_pending user is still entitled, so still 409', async () => {
  const db = fakeDb({
    subscriptions: [subscriptionRow({ status: 'active', current_period_end: '2026-10-20T16:00:00Z', cancel_at_period_end: true })]
  });
  const { handler } = handlerWith({ db });
  assertEquals((await handler(request(url, POST))).status, 409);
});

Deno.test('checkout: an expired user may subscribe again', async () => {
  const db = fakeDb({ subscriptions: [subscriptionRow({ status: 'canceled', current_period_end: '2026-09-30T16:00:00Z' })] });
  const { handler } = handlerWith({ db });
  assertEquals((await handler(request(url, POST))).status, 200);
});

// ---------------------------------------------------------------- the customer
Deno.test('checkout: a new customer is created once, with an idempotency key and the user id in metadata', async () => {
  const { handler, stripe, db } = handlerWith();
  assertEquals((await handler(request(url, POST))).status, 200);

  assertEquals(stripe.customerCreates.length, 1);
  assertObjectMatch(stripe.customerCreates[0].params, { email: USER.email, metadata: { user_id: USER.id } });
  assertEquals(stripe.customerCreates[0].options, { idempotencyKey: `customer-${USER.id}` });
  assertEquals(db.state.customers.get(USER.id)?.stripe_customer_id, 'cus_new');
});

Deno.test('checkout: an existing customer is reused and never recreated', async () => {
  const db = fakeDb({ customers: [{ user_id: USER.id, stripe_customer_id: 'cus_existing', last_synced_at: null }] });
  const { handler, stripe } = handlerWith({ db });
  await handler(request(url, POST));
  assertEquals(stripe.customerCreates, []);
  assertEquals(stripe.sessionCreates[0].customer, 'cus_existing');
});

Deno.test('checkout: a race that inserts another customer row first wins, and that id is used', async () => {
  // Two concurrent clicks: Stripe creates cus_new, but another request already stored cus_first.
  const db = fakeDb();
  const original = db.insertCustomer;
  db.insertCustomer = async row => {
    db.state.customers.set(row.user_id, { user_id: row.user_id, stripe_customer_id: 'cus_first', last_synced_at: null });
    await original.call(db, row);
  };
  const { handler, stripe } = handlerWith({ db });
  await handler(request(url, POST));
  assertEquals(stripe.sessionCreates[0].customer, 'cus_first', 'the stored row is authoritative');
});

// ---------------------------------------------------------------- the price
Deno.test('checkout: the price is looked up by the configured lookup key', async () => {
  const prices = fakePrices();
  const { handler } = handlerWith({ prices, env: { STRIPE_PRICE_LOOKUP_KEY: 'proplayer_annual' } });
  await handler(request(url, POST));
  assertEquals(prices.lookups, ['proplayer_annual']);
});

Deno.test('checkout: no matching price is 503 not_configured', async () => {
  const { handler, log, stripe } = handlerWith({ prices: fakePrices(null) });
  const response = await handler(request(url, POST));
  assertEquals(response.status, 503);
  assertEquals((await response.json()).error, 'not_configured');
  assertEquals(stripe.sessionCreates, []);
  assert(log.entries.some(e => e.message === 'price_missing'));
});

// ---------------------------------------------------------------- the session
Deno.test('checkout: the session parameters are exactly what the contract needs', async () => {
  const { handler, stripe } = handlerWith();
  const response = await handler(request(url, POST));
  assertEquals(await response.json(), { url: CHECKOUT_URL });

  assertEquals(stripe.sessionCreates.length, 1);
  assertEquals(stripe.sessionCreates[0], {
    mode: 'subscription',
    customer: 'cus_new',
    client_reference_id: USER.id,
    line_items: [{ price: 'price_1', quantity: 1 }],
    subscription_data: { metadata: { user_id: USER.id } },
    allow_promotion_codes: true,
    success_url: 'https://prop-layer.com/account.html?checkout=success',
    cancel_url: 'https://prop-layer.com/account.html?checkout=canceled#subscribe'
  });
});

Deno.test('checkout: SITE_URL drives the return URLs', async () => {
  const { handler, stripe } = handlerWith({ env: { SITE_URL: 'http://localhost:4173' } });
  await handler(request(url, POST));
  assertEquals(stripe.sessionCreates[0].success_url, 'http://localhost:4173/account.html?checkout=success');
  assertEquals(stripe.sessionCreates[0].cancel_url, 'http://localhost:4173/account.html?checkout=canceled#subscribe');
});

Deno.test('checkout: automatic tax is off by default', async () => {
  const { handler, stripe } = handlerWith();
  await handler(request(url, POST));
  assertEquals(stripe.sessionCreates[0].automatic_tax, undefined);
  assertEquals(stripe.sessionCreates[0].billing_address_collection, undefined);
  assertEquals(stripe.sessionCreates[0].customer_update, undefined);
});

Deno.test('checkout: STRIPE_AUTOMATIC_TAX=true adds the three tax parameters', async () => {
  const { handler, stripe } = handlerWith({ env: { STRIPE_AUTOMATIC_TAX: 'true' } });
  await handler(request(url, POST));
  assertObjectMatch(stripe.sessionCreates[0], {
    automatic_tax: { enabled: true },
    customer_update: { address: 'auto' },
    billing_address_collection: 'required'
  });
});

Deno.test('checkout: last_synced_at is cleared so the next entitlement call re-syncs', async () => {
  const db = fakeDb({ customers: [{ user_id: USER.id, stripe_customer_id: 'cus_1', last_synced_at: '2026-10-03T15:00:00Z' }] });
  const { handler } = handlerWith({ db });
  await handler(request(url, POST));
  assertEquals(db.state.customers.get(USER.id)?.last_synced_at, null);
  assert(db.calls.includes(`markSynced:${USER.id}:null`));
});

// ---------------------------------------------------------------- failures
Deno.test('checkout: a Stripe failure is 502 stripe_error and is logged without secrets', async () => {
  const stripe = fakeStripe({ sessionCreate: () => { throw Object.assign(new Error('card_declined'), { requestId: 'req_123' }); } });
  const { handler, log } = handlerWith({ stripe });
  const response = await handler(request(url, POST));
  assertEquals(response.status, 502);
  assertEquals((await response.json()).error, 'stripe_error');
  const entry = log.entries.find(e => e.message === 'checkout_failed');
  assert(String(entry?.fields.detail).includes('req_123'), 'the Stripe request id helps support');
  assertEquals(JSON.stringify(log.entries).includes('sk_test'), false);
});

Deno.test('checkout: a session without a URL is 502 rather than a broken redirect', async () => {
  const stripe = fakeStripe({ sessionCreate: () => ({ id: 'cs_1', url: null }) });
  const { handler } = handlerWith({ stripe });
  assertEquals((await handler(request(url, POST))).status, 502);
});
