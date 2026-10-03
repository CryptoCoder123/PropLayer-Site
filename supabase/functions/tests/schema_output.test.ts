// The live endpoint's output — not just the builder's — must validate against the shared
// schema for every reachable state. This is the test that would catch a handler adding a
// field the desktop app has never been told about.

import { assert, assertEquals } from 'jsr:@std/assert@1';
import Ajv2020 from 'npm:ajv@8.20.0/dist/2020.js';
import { createHandler } from '../entitlement/index.ts';
import type { SubscriptionRow } from '../_shared/entitlement.ts';
import {
  config, contractJson, fakeAuth, fakeDb, fakeLogger, fakeSync, FIXED_NOW, request, subscriptionRow
} from './fakes.ts';

const ajv = new (Ajv2020 as unknown as { new (options: unknown): any })({ strict: true, allErrors: true });
const validate = ajv.compile(await contractJson('entitlement.v1.schema.json'));

/** One case per reachable `reason`, plus the variants that change `access_until`. */
const STATES: [string, Partial<SubscriptionRow> | null, Record<string, string>?][] = [
  ['active', { status: 'active', current_period_end: '2026-11-03T16:00:00Z' }],
  ['trialing', { status: 'trialing', current_period_end: '2026-11-03T16:00:00Z' }],
  ['canceled_pending', { status: 'active', current_period_end: '2026-10-20T16:00:00Z', cancel_at_period_end: true }],
  ['canceled_pending via cancel_at', { status: 'trialing', current_period_end: '2026-11-03T16:00:00Z', cancel_at: '2026-10-10T16:00:00Z' }],
  ['past_due_grace', { status: 'past_due', current_period_end: '2026-11-01T16:00:00Z' }],
  ['payment_failed via past_due', { status: 'past_due', current_period_end: '2026-11-01T16:00:00Z' }, { PAST_DUE_ENTITLED: 'false' }],
  ['payment_failed via unpaid', { status: 'unpaid', current_period_end: '2026-11-01T16:00:00Z' }],
  ['incomplete', { status: 'incomplete', current_period_end: null }],
  ['expired via canceled', { status: 'canceled', current_period_end: '2026-09-30T16:00:00Z' }],
  ['expired via paused', { status: 'paused', current_period_end: '2026-09-30T16:00:00Z' }],
  ['expired via incomplete_expired', { status: 'incomplete_expired', current_period_end: null }],
  ['no_subscription', null],
  ['no lookup key on the row', { status: 'active', current_period_end: '2026-11-03T16:00:00Z', price_lookup_key: null }],
  ['clamped recheck and grace', { status: 'active', current_period_end: '2026-11-03T16:00:00Z' },
    { ENTITLEMENT_RECHECK_SECONDS: '1', OFFLINE_GRACE_SECONDS: '99999999' }]
];

for (const [name, state, env] of STATES) {
  Deno.test(`entitlement output validates against the schema: ${name}`, async () => {
    const db = fakeDb({ subscriptions: state ? [subscriptionRow(state)] : [] });
    const handler = createHandler({
      config: config(env ?? {}),
      now: () => FIXED_NOW,
      db,
      auth: fakeAuth(),
      sync: fakeSync(),
      log: fakeLogger()
    });
    const response = await handler(request());
    assertEquals(response.status, 200, name);
    const body = await response.json();
    assert(validate(body), `${name}: ${ajv.errorsText(validate.errors)}`);
  });
}

Deno.test('entitlement output never contains a field the schema does not know', async () => {
  const db = fakeDb({ subscriptions: [subscriptionRow()] });
  const handler = createHandler({
    config: config(), now: () => FIXED_NOW, db, auth: fakeAuth(), sync: fakeSync(), log: fakeLogger()
  });
  const body = await (await handler(request())).json();
  const schema = await contractJson<any>('entitlement.v1.schema.json');
  assertEquals(Object.keys(body).sort(), Object.keys(schema.properties).sort());
  assertEquals(
    Object.keys(body.subscription).sort(),
    Object.keys(schema.properties.subscription.oneOf[1].properties).sort()
  );
});
