// `create-portal-session`: the 404 the account page uses to hide the button, and the
// return URL / configuration id the portal is opened with.

import { assert, assertEquals } from 'jsr:@std/assert@1';
import { createHandler } from '../create-portal-session/index.ts';
import { config, fakeAuth, fakeDb, fakeLogger, request, USER } from './fakes.ts';

const PORTAL_URL = 'https://billing.stripe.com/p/session/test_123';
const POST = { method: 'POST' } as const;
const url = 'https://project.supabase.co/functions/v1/create-portal-session';

function fakeStripe(behaviour: { create?: (params: unknown) => unknown } = {}) {
  const creates: any[] = [];
  return {
    creates,
    billingPortal: {
      sessions: {
        create(params: any) {
          creates.push(params);
          return Promise.resolve(behaviour.create?.(params) ?? { id: 'bps_1', url: PORTAL_URL });
        }
      }
    }
  };
}

function handlerWith(options: {
  env?: Record<string, string | undefined>;
  db?: ReturnType<typeof fakeDb>;
  stripe?: ReturnType<typeof fakeStripe>;
  auth?: ReturnType<typeof fakeAuth>;
} = {}) {
  const db = options.db ?? fakeDb({ customers: [{ user_id: USER.id, stripe_customer_id: 'cus_1', last_synced_at: null }] });
  const stripe = options.stripe ?? fakeStripe();
  const log = fakeLogger();
  const handler = createHandler({
    config: config(options.env),
    db,
    auth: options.auth ?? fakeAuth(),
    log,
    stripe: () => stripe as never
  });
  return { handler, db, stripe, log };
}

Deno.test('portal: GET is 405', async () => {
  const { handler } = handlerWith();
  assertEquals((await handler(request(url, { method: 'GET' }))).status, 405);
});

Deno.test('portal: OPTIONS is 204 with the CORS headers', async () => {
  const { handler } = handlerWith();
  const response = await handler(request(url, { method: 'OPTIONS' }));
  assertEquals(response.status, 204);
  assertEquals(response.headers.get('access-control-allow-origin'), 'https://prop-layer.com');
});

Deno.test('portal: no token is 401 and no session is created', async () => {
  const { handler, stripe } = handlerWith();
  assertEquals((await handler(request(url, { ...POST, token: null }))).status, 401);
  assertEquals(stripe.creates, []);
});

Deno.test('portal: not configured is 503', async () => {
  const { handler } = handlerWith({ env: { SUPABASE_SERVICE_ROLE_KEY: '', SUPABASE_SECRET_KEYS: '' } });
  assertEquals((await handler(request(url, POST))).status, 503);
});

Deno.test('portal: a user with no customers row is 404 no_customer', async () => {
  const { handler, stripe } = handlerWith({ db: fakeDb() });
  const response = await handler(request(url, POST));
  assertEquals(response.status, 404);
  assertEquals((await response.json()).error, 'no_customer');
  assertEquals(stripe.creates, [], 'nothing to manage means nothing to ask Stripe');
});

Deno.test('portal: the return URL points at the billing card', async () => {
  const { handler, stripe } = handlerWith();
  const response = await handler(request(url, POST));
  assertEquals(await response.json(), { url: PORTAL_URL });
  assertEquals(stripe.creates[0].customer, 'cus_1');
  assertEquals(stripe.creates[0].return_url, 'https://prop-layer.com/account.html#billing');
});

Deno.test('portal: SITE_URL drives the return URL', async () => {
  const { handler, stripe } = handlerWith({ env: { SITE_URL: 'http://localhost:4173' } });
  await handler(request(url, POST));
  assertEquals(stripe.creates[0].return_url, 'http://localhost:4173/account.html#billing');
});

Deno.test('portal: a configuration id is passed through when set', async () => {
  const { handler, stripe } = handlerWith({ env: { STRIPE_PORTAL_CONFIGURATION_ID: 'bpc_123' } });
  await handler(request(url, POST));
  assertEquals(stripe.creates[0].configuration, 'bpc_123');
});

Deno.test('portal: an unset configuration id is omitted, not sent as an empty string', async () => {
  const { handler, stripe } = handlerWith();
  await handler(request(url, POST));
  assertEquals(stripe.creates[0].configuration, undefined);
});

Deno.test('portal: a Stripe failure is 502 stripe_error', async () => {
  const stripe = fakeStripe({ create: () => { throw new Error('portal configuration missing'); } });
  const { handler, log } = handlerWith({ stripe });
  const response = await handler(request(url, POST));
  assertEquals(response.status, 502);
  assertEquals((await response.json()).error, 'stripe_error');
  assert(log.entries.some(e => e.message === 'portal_failed'));
});

Deno.test('portal: logs carry ids, not the email address', async () => {
  const { handler, log } = handlerWith();
  await handler(request(url, POST));
  assertEquals(JSON.stringify(log.entries).includes(USER.email), false);
});
