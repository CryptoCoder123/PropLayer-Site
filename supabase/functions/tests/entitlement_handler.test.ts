// The `entitlement` endpoint: CORS, method, configuration, auth and the two self-heal paths.

import { assert, assertEquals, assertObjectMatch } from 'jsr:@std/assert@1';
import { createHandler, CUSTOMER_RESYNC_AFTER_MS } from '../entitlement/index.ts';
import { ALLOW_HEADERS, ALLOW_METHODS } from '../_shared/cors.ts';
import {
  config, contractJson, fakeAuth, fakeDb, fakeLogger, fakeSync, FIXED_NOW, request, subscriptionRow, USER
} from './fakes.ts';

function handlerWith(options: {
  env?: Record<string, string | undefined>;
  db?: ReturnType<typeof fakeDb>;
  sync?: ReturnType<typeof fakeSync>;
  auth?: ReturnType<typeof fakeAuth>;
  now?: number;
} = {}) {
  const db = options.db ?? fakeDb();
  const sync = options.sync ?? fakeSync();
  const log = fakeLogger();
  const handler = createHandler({
    config: config(options.env),
    now: () => options.now ?? FIXED_NOW,
    db,
    auth: options.auth ?? fakeAuth(),
    sync,
    log
  });
  return { handler, db, sync, log };
}

// ---------------------------------------------------------------- CORS and method
Deno.test('OPTIONS answers 204 and echoes an allowed origin', async () => {
  const { handler } = handlerWith();
  const response = await handler(request(undefined, { method: 'OPTIONS', origin: 'https://prop-layer.com' }));
  assertEquals(response.status, 204);
  assertEquals(response.headers.get('access-control-allow-origin'), 'https://prop-layer.com');
  assertEquals(response.headers.get('access-control-allow-headers'), ALLOW_HEADERS);
  assertEquals(response.headers.get('access-control-allow-methods'), ALLOW_METHODS);
  assertEquals(await response.text(), '');
});

Deno.test('localhost:4173 is an allowed origin by default', async () => {
  const { handler } = handlerWith();
  const response = await handler(request(undefined, { method: 'OPTIONS', origin: 'http://localhost:4173' }));
  assertEquals(response.headers.get('access-control-allow-origin'), 'http://localhost:4173');
});

Deno.test('a disallowed origin gets no Access-Control-Allow-Origin header', async () => {
  const { handler } = handlerWith();
  for (const method of ['OPTIONS', 'GET']) {
    const response = await handler(request(undefined, { method, origin: 'https://evil.example.com' }));
    assertEquals(response.headers.get('access-control-allow-origin'), null, method);
  }
});

Deno.test('POST to entitlement is 405 method_not_allowed', async () => {
  const { handler } = handlerWith();
  const response = await handler(request(undefined, { method: 'POST' }));
  assertEquals(response.status, 405);
  assertEquals((await response.json()).error, 'method_not_allowed');
});

Deno.test('every answer is JSON and uncacheable', async () => {
  const { handler } = handlerWith();
  const response = await handler(request());
  assertEquals(response.headers.get('content-type'), 'application/json');
  assertEquals(response.headers.get('cache-control'), 'no-store');
});

// ---------------------------------------------------------------- configuration and auth
Deno.test('a missing service-role key answers 503 not_configured', async () => {
  const { handler } = handlerWith({ env: { SUPABASE_SERVICE_ROLE_KEY: '', SUPABASE_SECRET_KEYS: '' } });
  const response = await handler(request());
  assertEquals(response.status, 503);
  assertEquals((await response.json()).error, 'not_configured');
});

Deno.test('a missing Stripe key answers 503 not_configured', async () => {
  const { handler } = handlerWith({ env: { STRIPE_SECRET_KEY: '' } });
  assertEquals((await handler(request())).status, 503);
});

Deno.test('SUPABASE_SECRET_KEYS stands in for SUPABASE_SERVICE_ROLE_KEY', async () => {
  const { handler } = handlerWith({
    env: { SUPABASE_SERVICE_ROLE_KEY: '', SUPABASE_SECRET_KEYS: JSON.stringify({ default: 'sb_secret_abc' }) }
  });
  assertEquals((await handler(request())).status, 200);
});

Deno.test('a malformed SUPABASE_SECRET_KEYS fails closed rather than crashing', async () => {
  const { handler } = handlerWith({ env: { SUPABASE_SERVICE_ROLE_KEY: '', SUPABASE_SECRET_KEYS: '{not json' } });
  assertEquals((await handler(request())).status, 503);
});

Deno.test('no Authorization header is 401 with the contract envelope', async () => {
  const { handler } = handlerWith();
  const response = await handler(request(undefined, { token: null }));
  assertEquals(response.status, 401);
  assertEquals(await response.json(), await contractJson('fixtures/error.unauthorized.json'));
});

Deno.test('a malformed Authorization header is 401', async () => {
  const { handler } = handlerWith();
  for (const header of ['Bearer', 'Basic abc', 'token abc', '']) {
    const response = await handler(new Request('https://p.supabase.co/functions/v1/entitlement', { headers: { authorization: header } }));
    assertEquals(response.status, 401, header);
  }
});

Deno.test('a rejected token is 401 and never reaches the database', async () => {
  const { handler, db } = handlerWith({ auth: fakeAuth(null) });
  assertEquals((await handler(request())).status, 401);
  assertEquals(db.calls, []);
});

// ---------------------------------------------------------------- happy paths
Deno.test('a user with no rows and no customer gets the no_subscription fixture', async () => {
  const { handler, sync } = handlerWith();
  const response = await handler(request());
  assertEquals(response.status, 200);
  assertEquals(await response.json(), await contractJson('fixtures/entitlement.no_subscription.json'));
  assertEquals(sync.customerCalls, [], 'with no customers row there is nothing to re-sync');
});

Deno.test('an active row returns the active fixture and no Stripe traffic', async () => {
  const db = fakeDb({ subscriptions: [subscriptionRow({ status: 'active', current_period_end: '2026-11-03T16:00:00Z' })] });
  const { handler, sync } = handlerWith({ db });
  const response = await handler(request());
  assertEquals(await response.json(), await contractJson('fixtures/entitlement.active.json'));
  assertEquals(sync.subscriptionCalls, []);
  assertEquals(sync.customerCalls, []);
});

Deno.test('the response never includes a token or any header the caller sent', async () => {
  const db = fakeDb({ subscriptions: [subscriptionRow()] });
  const { handler, log } = handlerWith({ db });
  const body = await (await handler(request())).text();
  assert(!body.includes('Bearer'), body);
  assertEquals(JSON.stringify(log.entries).includes('Bearer'), false);
});

Deno.test('logs record ids and the outcome, never the email address', async () => {
  const db = fakeDb({ subscriptions: [subscriptionRow()] });
  const { handler, log } = handlerWith({ db });
  await handler(request());
  const entry = log.entries.find(e => e.message === 'entitlement');
  assertObjectMatch(entry!.fields, { user: USER.id, entitled: true, reason: 'active', subscription: 'sub_1' });
  assertEquals(JSON.stringify(log.entries).includes(USER.email), false);
});

// ---------------------------------------------------------------- self-heal (a): stale row
Deno.test('a stale active row triggers exactly one syncSubscription', async () => {
  const db = fakeDb({ subscriptions: [subscriptionRow({ status: 'active', current_period_end: '2026-09-30T16:00:00Z' })] });
  const { handler, sync } = handlerWith({ db });
  const body = await (await handler(request())).json();
  assertEquals(sync.subscriptionCalls, ['sub_1']);
  assertEquals(body.reason, 'expired');
  assertEquals(body.entitled, false);
});

Deno.test('a stale row that Stripe confirms is still active becomes entitled again', async () => {
  const db = fakeDb({ subscriptions: [subscriptionRow({ status: 'active', current_period_end: '2026-09-30T16:00:00Z' })] });
  const sync = fakeSync({
    onSubscription: async () => {
      // Stripe says the renewal did go through; the webhook was simply late.
      await db.upsertSubscription({
        ...subscriptionRow({ status: 'active', current_period_end: '2026-11-03T16:00:00Z' }),
        updated_at: '2026-10-03T16:00:00Z'
      } as never);
    }
  });
  const { handler } = handlerWith({ db, sync });
  const body = await (await handler(request())).json();
  assertEquals(body.entitled, true);
  assertEquals(body.reason, 'active');
  assertEquals(sync.subscriptionCalls.length, 1, 'one re-sync, not a loop');
});

Deno.test('a Stripe failure while re-syncing a stale row answers 502 stripe_error', async () => {
  const db = fakeDb({ subscriptions: [subscriptionRow({ status: 'active', current_period_end: '2026-09-30T16:00:00Z' })] });
  const sync = fakeSync({ onSubscription: () => { throw new Error('Stripe is down'); } });
  const { handler, log } = handlerWith({ db, sync });
  const response = await handler(request());
  assertEquals(response.status, 502);
  assertEquals((await response.json()).error, 'stripe_error');
  assert(log.entries.some(e => e.message === 'stale_resync_failed'));
});

Deno.test('a canceled row is never re-synced: it is not stale, just over', async () => {
  const db = fakeDb({ subscriptions: [subscriptionRow({ status: 'canceled', current_period_end: '2026-09-30T16:00:00Z' })] });
  const { handler, sync } = handlerWith({ db });
  const body = await (await handler(request())).json();
  assertEquals(await Promise.resolve(body), await contractJson('fixtures/entitlement.expired.json'));
  assertEquals(sync.subscriptionCalls, []);
});

// ---------------------------------------------------------------- self-heal (b): customer re-sync
Deno.test('no entitled row plus a never-synced customer triggers syncCustomer and marks it synced', async () => {
  const db = fakeDb({ customers: [{ user_id: USER.id, stripe_customer_id: 'cus_1', last_synced_at: null }] });
  const { handler, sync } = handlerWith({ db });
  await handler(request());
  assertEquals(sync.customerCalls, ['cus_1']);
  assertEquals(db.state.customers.get(USER.id)?.last_synced_at, '2026-10-03T16:00:00.000Z');
});

Deno.test('a customer synced within the last ten minutes is not re-synced', async () => {
  const recent = new Date(FIXED_NOW - 60_000).toISOString();
  const db = fakeDb({ customers: [{ user_id: USER.id, stripe_customer_id: 'cus_1', last_synced_at: recent }] });
  const { handler, sync } = handlerWith({ db });
  await handler(request());
  assertEquals(sync.customerCalls, []);
});

Deno.test('a customer synced longer than ten minutes ago is re-synced', async () => {
  const stale = new Date(FIXED_NOW - CUSTOMER_RESYNC_AFTER_MS - 1000).toISOString();
  const db = fakeDb({ customers: [{ user_id: USER.id, stripe_customer_id: 'cus_1', last_synced_at: stale }] });
  const { handler, sync } = handlerWith({ db });
  await handler(request());
  assertEquals(sync.customerCalls, ['cus_1']);
});

Deno.test('a cleared last_synced_at (just after checkout) re-syncs immediately and can flip to active', async () => {
  const db = fakeDb({ customers: [{ user_id: USER.id, stripe_customer_id: 'cus_1', last_synced_at: null }] });
  const sync = fakeSync({
    onCustomer: async () => {
      await db.upsertSubscription({
        ...subscriptionRow({ status: 'active', current_period_end: '2026-11-03T16:00:00Z' }),
        updated_at: '2026-10-03T16:00:00Z'
      } as never);
    }
  });
  const { handler } = handlerWith({ db, sync });
  const body = await (await handler(request())).json();
  assertEquals(body.entitled, true);
  assertEquals(body.reason, 'active');
});

Deno.test('an entitled user never triggers a customer re-sync', async () => {
  const db = fakeDb({
    customers: [{ user_id: USER.id, stripe_customer_id: 'cus_1', last_synced_at: null }],
    subscriptions: [subscriptionRow({ status: 'active', current_period_end: '2026-11-03T16:00:00Z' })]
  });
  const { handler, sync } = handlerWith({ db });
  await handler(request());
  assertEquals(sync.customerCalls, []);
});

Deno.test('a Stripe failure during the customer re-sync still returns the database decision', async () => {
  const db = fakeDb({
    customers: [{ user_id: USER.id, stripe_customer_id: 'cus_1', last_synced_at: null }],
    subscriptions: [subscriptionRow({ status: 'canceled', current_period_end: '2026-09-30T16:00:00Z' })]
  });
  const sync = fakeSync({ onCustomer: () => { throw new Error('Stripe is down'); } });
  const { handler, log } = handlerWith({ db, sync });
  const response = await handler(request());
  assertEquals(response.status, 200, 'this path degrades, it does not fail');
  assertEquals((await response.json()).reason, 'expired');
  assert(log.entries.some(e => e.message === 'customer_resync_failed' && e.level === 'warn'));
});

// ---------------------------------------------------------------- failures
Deno.test('an unexpected database failure answers 500 internal', async () => {
  const db = fakeDb();
  db.listSubscriptions = () => Promise.reject(new Error('connection reset'));
  const { handler, log } = handlerWith({ db });
  const response = await handler(request());
  assertEquals(response.status, 500);
  assertEquals((await response.json()).error, 'internal');
  assert(log.entries.some(e => e.message === 'entitlement_failed'));
});

Deno.test('an error response still carries the CORS header for an allowed origin', async () => {
  const { handler } = handlerWith();
  const response = await handler(request(undefined, { token: null, origin: 'https://prop-layer.com' }));
  assertEquals(response.status, 401);
  assertEquals(response.headers.get('access-control-allow-origin'), 'https://prop-layer.com');
});
