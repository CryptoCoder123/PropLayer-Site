// `stripe-webhook`. Signatures are generated with Stripe's own
// `generateTestHeaderStringAsync` and verified by the real `constructEventAsync`, so these
// tests exercise the actual verification path rather than a stub of it.

import { assert, assertEquals } from 'jsr:@std/assert@1';
import { createHandler, HANDLED_EVENTS } from '../stripe-webhook/index.ts';
import { StripeSdk, subtleCryptoProvider } from '../_shared/stripe.ts';
import { config, fakeDb, fakeLogger, fakeSync, FIXED_NOW, USER } from './fakes.ts';

const SECRET = 'whsec_test_fake';
const url = 'https://project.supabase.co/functions/v1/stripe-webhook';

const stripe = new StripeSdk('sk_test_fake', { httpClient: StripeSdk.createFetchHttpClient() });
const cryptoProvider = subtleCryptoProvider();

/** Real verification, exactly as index.ts wires it in production. */
const constructEvent = (body: string, signature: string, secret: string) =>
  stripe.webhooks.constructEventAsync(body, signature, secret, undefined, cryptoProvider);

function event(type: string, object: unknown, id = `evt_${type.replace(/\W/g, '_')}`) {
  return { id, object: 'event', type, api_version: '2025-09-30', created: Math.floor(FIXED_NOW / 1000), data: { object } };
}

async function signed(payload: unknown, secret = SECRET): Promise<Request> {
  const body = JSON.stringify(payload);
  const signature = await stripe.webhooks.generateTestHeaderStringAsync({ payload: body, secret, cryptoProvider });
  return new Request(url, { method: 'POST', body, headers: { 'stripe-signature': signature, 'content-type': 'application/json' } });
}

function handlerWith(options: {
  env?: Record<string, string | undefined>;
  db?: ReturnType<typeof fakeDb>;
  sync?: ReturnType<typeof fakeSync>;
} = {}) {
  const db = options.db ?? fakeDb();
  const sync = options.sync ?? fakeSync();
  const log = fakeLogger();
  const handler = createHandler({
    config: config(options.env),
    now: () => FIXED_NOW,
    db,
    sync,
    log,
    constructEvent
  });
  return { handler, db, sync, log };
}

// ---------------------------------------------------------------- signature
Deno.test('webhook: a missing signature header is 400 bad_signature and writes nothing', async () => {
  const { handler, db, sync } = handlerWith();
  const response = await handler(new Request(url, { method: 'POST', body: JSON.stringify(event('invoice.paid', {})) }));
  assertEquals(response.status, 400);
  assertEquals((await response.json()).error, 'bad_signature');
  assertEquals(db.calls, [], 'an unverified body must never reach the database');
  assertEquals(sync.subscriptionCalls, []);
});

Deno.test('webhook: a signature made with the wrong secret is 400 and writes nothing', async () => {
  const { handler, db } = handlerWith();
  const response = await handler(await signed(event('customer.subscription.updated', { id: 'sub_1' }), 'whsec_attacker'));
  assertEquals(response.status, 400);
  assertEquals(db.calls, []);
});

Deno.test('webhook: a tampered body fails verification even with a valid-looking signature', async () => {
  const { handler, db } = handlerWith();
  const original = await signed(event('customer.subscription.updated', { id: 'sub_1' }));
  const tampered = new Request(url, {
    method: 'POST',
    body: JSON.stringify(event('customer.subscription.updated', { id: 'sub_ATTACKER' })),
    headers: original.headers
  });
  assertEquals((await handler(tampered)).status, 400);
  assertEquals(db.calls, []);
});

Deno.test('webhook: the bad-signature log carries no body and no header', async () => {
  const { handler, log } = handlerWith();
  await handler(new Request(url, { method: 'POST', body: '{"secretish":"value"}', headers: { 'stripe-signature': 'nope' } }));
  const serialised = JSON.stringify(log.entries);
  assertEquals(serialised.includes('secretish'), false);
  assertEquals(serialised.includes('nope'), false);
});

Deno.test('webhook: GET is 405 and a missing webhook secret is 503', async () => {
  assertEquals((await handlerWith().handler(new Request(url, { method: 'GET' }))).status, 405);
  const unconfigured = handlerWith({ env: { STRIPE_WEBHOOK_SECRET: '' } });
  assertEquals((await unconfigured.handler(await signed(event('invoice.paid', {})))).status, 503);
});

// ---------------------------------------------------------------- idempotency
Deno.test('webhook: a verified event is processed and marked processed', async () => {
  const { handler, db, sync } = handlerWith();
  const response = await handler(await signed(event('customer.subscription.updated', { id: 'sub_1' })));
  assertEquals(response.status, 200);
  assertEquals(await response.json(), { received: true });
  assertEquals(sync.subscriptionCalls, ['sub_1']);
  assertEquals(db.state.events.get('evt_customer_subscription_updated')?.processed_at, '2026-10-03T16:00:00.000Z');
});

Deno.test('webhook: a redelivered event is acknowledged but processed only once', async () => {
  const { handler, sync, log } = handlerWith();
  const payload = event('customer.subscription.updated', { id: 'sub_1' });
  assertEquals((await handler(await signed(payload))).status, 200);
  assertEquals((await handler(await signed(payload))).status, 200);
  assertEquals(sync.subscriptionCalls, ['sub_1'], 'the second delivery is a no-op');
  assert(log.entries.some(e => e.message === 'event_duplicate'));
});

Deno.test('webhook: a redelivery while the first attempt is still unprocessed does the work', async () => {
  // Row exists with processed_at = null, i.e. a previous attempt returned 500.
  const db = fakeDb({ events: [{ id: 'evt_retry', type: 'customer.subscription.updated', processed_at: null }] });
  const { handler, sync } = handlerWith({ db });
  const response = await handler(await signed(event('customer.subscription.updated', { id: 'sub_1' }, 'evt_retry')));
  assertEquals(response.status, 200);
  assertEquals(sync.subscriptionCalls, ['sub_1']);
});

Deno.test('webhook: a handler failure is 500 and leaves the event unprocessed so Stripe retries', async () => {
  const sync = fakeSync({ onSubscription: () => { throw new Error('Stripe timeout'); } });
  const { handler, db, log } = handlerWith({ sync });
  const response = await handler(await signed(event('customer.subscription.updated', { id: 'sub_1' })));
  assertEquals(response.status, 500);
  assertEquals(db.state.events.get('evt_customer_subscription_updated')?.processed_at, null);
  assert(log.entries.some(e => e.message === 'event_failed'));
});

// ---------------------------------------------------------------- dispatch
Deno.test('webhook: checkout.session.completed links the customer, then syncs with the user hint', async () => {
  const { handler, db, sync } = handlerWith();
  await handler(await signed(event('checkout.session.completed', {
    id: 'cs_1', mode: 'subscription', client_reference_id: USER.id, customer: 'cus_1', subscription: 'sub_1'
  })));
  const linkIndex = db.calls.indexOf(`insertCustomer:${USER.id}:cus_1`);
  assert(linkIndex >= 0, 'the customer must be linked');
  assertEquals(sync.subscriptionCalls, ['sub_1']);
  assertEquals(db.state.customers.get(USER.id)?.stripe_customer_id, 'cus_1');
});

Deno.test('webhook: checkout.session.completed falls back to metadata.user_id', async () => {
  const { handler, db } = handlerWith();
  await handler(await signed(event('checkout.session.completed', {
    id: 'cs_1', mode: 'subscription', client_reference_id: null, metadata: { user_id: USER.id },
    customer: { id: 'cus_1' }, subscription: { id: 'sub_1' }
  })));
  assertEquals(db.state.customers.get(USER.id)?.stripe_customer_id, 'cus_1');
});

Deno.test('webhook: a one-off payment session is ignored', async () => {
  const { handler, db, sync } = handlerWith();
  const response = await handler(await signed(event('checkout.session.completed', {
    id: 'cs_1', mode: 'payment', client_reference_id: USER.id, customer: 'cus_1'
  })));
  assertEquals(response.status, 200);
  assertEquals(sync.subscriptionCalls, []);
  assertEquals(db.state.customers.size, 0);
});

Deno.test('webhook: a subscription session with no subscription id is logged, not crashed', async () => {
  const { handler, log, sync } = handlerWith();
  const response = await handler(await signed(event('checkout.session.completed', {
    id: 'cs_1', mode: 'subscription', client_reference_id: USER.id, customer: 'cus_1', subscription: null
  })));
  assertEquals(response.status, 200);
  assertEquals(sync.subscriptionCalls, []);
  assert(log.entries.some(e => e.message === 'checkout_completed_without_subscription'));
});

Deno.test('webhook: every subscription lifecycle event re-syncs the subscription', async () => {
  for (const type of [
    'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted',
    'customer.subscription.paused', 'customer.subscription.resumed', 'customer.subscription.trial_will_end'
  ]) {
    const { handler, sync } = handlerWith();
    const response = await handler(await signed(event(type, { id: 'sub_1', status: 'active' })));
    assertEquals(response.status, 200, type);
    assertEquals(sync.subscriptionCalls, ['sub_1'], type);
  }
});

Deno.test('webhook: invoice events find the subscription under parent.subscription_details', async () => {
  const { handler, sync } = handlerWith();
  await handler(await signed(event('invoice.paid', {
    id: 'in_1', parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_current' } }
  })));
  assertEquals(sync.subscriptionCalls, ['sub_current']);
});

Deno.test('webhook: invoice events also accept the legacy invoice.subscription field', async () => {
  const { handler, sync } = handlerWith();
  await handler(await signed(event('invoice.payment_failed', { id: 'in_1', subscription: 'sub_legacy' })));
  assertEquals(sync.subscriptionCalls, ['sub_legacy']);
});

Deno.test('webhook: an expanded subscription object on an invoice is accepted', async () => {
  const { handler, sync } = handlerWith();
  await handler(await signed(event('invoice.paid', {
    id: 'in_1', parent: { subscription_details: { subscription: { id: 'sub_expanded' } } }
  })));
  assertEquals(sync.subscriptionCalls, ['sub_expanded']);
});

Deno.test('webhook: an invoice with no subscription is acknowledged and ignored', async () => {
  const { handler, sync, log } = handlerWith();
  const response = await handler(await signed(event('invoice.paid', { id: 'in_1' })));
  assertEquals(response.status, 200);
  assertEquals(sync.subscriptionCalls, []);
  assert(log.entries.some(e => e.message === 'invoice_without_subscription'));
});

Deno.test('webhook: an unknown event type is acknowledged so Stripe stops retrying', async () => {
  const { handler, sync, log } = handlerWith();
  const response = await handler(await signed(event('payout.paid', { id: 'po_1' })));
  assertEquals(response.status, 200);
  assertEquals(await response.json(), { received: true });
  assertEquals(sync.subscriptionCalls, []);
  assert(log.entries.some(e => e.message === 'event_ignored'));
});

Deno.test('webhook: HANDLED_EVENTS is the list the dispatcher actually acts on', async () => {
  for (const type of HANDLED_EVENTS) {
    const { handler, sync, db, log } = handlerWith();
    const object = type === 'checkout.session.completed'
      ? { id: 'cs_1', mode: 'subscription', client_reference_id: USER.id, customer: 'cus_1', subscription: 'sub_1' }
      : type.startsWith('invoice.')
        ? { id: 'in_1', parent: { subscription_details: { subscription: 'sub_1' } } }
        : { id: 'sub_1', status: 'active' };
    await handler(await signed(event(type, object)));
    assertEquals(sync.subscriptionCalls, ['sub_1'], type);
    assertEquals(log.entries.some(e => e.message === 'event_ignored'), false, type);
    assert(db.calls.includes('markEventProcessed:' + `evt_${type.replace(/\W/g, '_')}`), type);
  }
});

Deno.test('webhook: logs carry event and subscription ids, never the payload', async () => {
  const { handler, log } = handlerWith();
  await handler(await signed(event('customer.subscription.updated', { id: 'sub_1', secret_field: 'should-not-appear' })));
  assertEquals(JSON.stringify(log.entries).includes('should-not-appear'), false);
  assert(log.entries.some(e => e.fields.event === 'evt_customer_subscription_updated'));
});
