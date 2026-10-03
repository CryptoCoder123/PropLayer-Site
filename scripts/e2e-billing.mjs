#!/usr/bin/env node
// End-to-end proof that the website, the backend and Stripe agree (guide 7.5).
//
//   npm run e2e:billing
//
// Creates a throwaway confirmed user, signs in with the password grant exactly as the
// desktop app does, drives a real subscription through a Stripe **test clock**, and asserts
// the `entitlement` answer at each stage. Everything it creates is deleted afterwards, even
// when an assertion fails.
//
// Refuses to run against a live Stripe key. This is a test-mode tool only.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------- environment
function readDotEnv(file) {
  if (!fs.existsSync(file)) return {};
  const values = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (/^(['"]).*\1$/s.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '').trim();
    values[match[1]] = value;
  }
  return values;
}

const env = { ...readDotEnv(path.join(root, '.env')), ...process.env };
const get = name => String(env[name] ?? '').trim();

const SUPABASE_URL = get('SUPABASE_URL') ||
  (get('SUPABASE_PROJECT_REF') ? `https://${get('SUPABASE_PROJECT_REF')}.supabase.co` : '');
const SERVICE_KEY = get('SUPABASE_SERVICE_ROLE_KEY') || get('SUPABASE_SECRET_KEY');
const PUBLISHABLE_KEY = get('SUPABASE_PUBLISHABLE_KEY') || get('SUPABASE_ANON_KEY');
const STRIPE_KEY = get('STRIPE_SECRET_KEY');
const LOOKUP_KEY = get('STRIPE_PRICE_LOOKUP_KEY') || 'proplayer_monthly';

const prerequisites = [
  ['SUPABASE_URL (or SUPABASE_PROJECT_REF)', SUPABASE_URL],
  ['SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEY)', SERVICE_KEY],
  ['SUPABASE_PUBLISHABLE_KEY (or SUPABASE_ANON_KEY)', PUBLISHABLE_KEY],
  ['STRIPE_SECRET_KEY', STRIPE_KEY]
].filter(([, value]) => !value).map(([name]) => name);

if (prerequisites.length) {
  console.log('– e2e:billing skipped. Missing: ' + prerequisites.join(', '));
  console.log('  This test needs a deployed project and an sk_test_ key. Nothing was changed.');
  process.exit(0);
}

if (!STRIPE_KEY.startsWith('sk_test_') && !STRIPE_KEY.startsWith('rk_test_')) {
  console.error('✗ e2e:billing refuses to run without a Stripe TEST key (sk_test_…).');
  console.error('  It creates and deletes real objects; running it against live data is never correct.');
  process.exit(2);
}

// ---------------------------------------------------------------- reporting
const results = [];
function record(name, passed, detail = '') {
  results.push({ name, passed, detail });
  console.log(`${passed ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}
function expect(name, condition, detail = '') {
  record(name, Boolean(condition), detail);
  return Boolean(condition);
}

const Stripe = (await import('stripe')).default;
const stripe = new Stripe(STRIPE_KEY);

// ---------------------------------------------------------------- helpers
const authHeaders = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' };

async function adminRequest(method, endpoint, body) {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/admin${endpoint}`, {
    method,
    headers: authHeaders,
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`admin ${method} ${endpoint} → ${response.status}: ${JSON.stringify(payload).slice(0, 300)}`);
  return payload;
}

async function signInWithPassword(email, password) {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: PUBLISHABLE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`sign-in → ${response.status}: ${JSON.stringify(payload).slice(0, 300)}`);
  return payload;
}

/** Calls `entitlement` the way the desktop app does, including its client header. */
async function entitlement(accessToken) {
  const response = await fetch(`${SUPABASE_URL}/functions/v1/entitlement`, {
    headers: {
      apikey: PUBLISHABLE_KEY,
      Authorization: `Bearer ${accessToken}`,
      'X-PropLayer-Client': 'e2e/0.0.0 (node)'
    }
  });
  const payload = await response.json().catch(() => null);
  return { status: response.status, body: payload };
}

/** Polls until `predicate` holds, so a webhook has a fair chance to land. */
async function waitForEntitlement(accessToken, predicate, { timeoutMs = 90_000, intervalMs = 2000, label } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await entitlement(accessToken);
    if (last.status === 200 && predicate(last.body)) return last;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timed out waiting for ${label}; last answer: ${JSON.stringify(last?.body ?? last).slice(0, 400)}`);
}

const rfc3339 = seconds => new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

// ---------------------------------------------------------------- the run
const created = { userId: null, customerId: null, testClockId: null, subscriptionId: null };
const suffix = crypto.randomBytes(6).toString('hex');
const email = `proplayer-e2e-${suffix}@example.com`;
const password = `E2e-${crypto.randomBytes(12).toString('base64url')}`;

console.log(`Stripe TEST mode · project ${SUPABASE_URL}`);
console.log(`Throwaway user: ${email}\n`);

let fatal = null;
try {
  // -- 1. a confirmed user, created the way an operator would
  const user = await adminRequest('POST', '/users', { email, password, email_confirm: true });
  created.userId = user.id;
  expect('created a confirmed throwaway user', Boolean(user.id), user.id);

  // -- 2. the desktop app's sign-in path
  const session = await signInWithPassword(email, password);
  const accessToken = session.access_token;
  expect('password grant returns an access token and a refresh token',
    Boolean(accessToken && session.refresh_token));
  expect('the token belongs to the new user', session.user?.id === created.userId);

  // -- 3. a brand-new account has no subscription
  const initial = await entitlement(accessToken);
  expect('entitlement answers 200', initial.status === 200, `status ${initial.status}`);
  expect('a new account is not entitled', initial.body?.entitled === false);
  expect('reason is no_subscription', initial.body?.reason === 'no_subscription', String(initial.body?.reason));
  expect('subscription is null', initial.body?.subscription === null);
  expect('schema is 1', initial.body?.schema === 1);
  expect('links point at the site', String(initial.body?.links?.download ?? '').endsWith('/download.html'));

  // -- 4. the price the backend will use
  const prices = await stripe.prices.list({ lookup_keys: [LOOKUP_KEY], active: true, limit: 1 });
  const price = prices.data[0];
  if (!expect(`the ${LOOKUP_KEY} price exists`, Boolean(price),
    price ? price.id : 'run `npm run billing:setup -- --price-cents <n>` first')) {
    throw new Error('no price to subscribe to');
  }

  // -- 5. a test clock, so the period end can be crossed on demand
  const clock = await stripe.testHelpers.testClocks.create({
    frozen_time: Math.floor(Date.now() / 1000),
    name: `proplayer-e2e-${suffix}`
  });
  created.testClockId = clock.id;
  expect('created a Stripe test clock', Boolean(clock.id), clock.id);

  // metadata.user_id is how syncSubscription resolves the owner without the webhook
  // having to guess, and without ever matching on an email address.
  const customer = await stripe.customers.create({
    email,
    test_clock: clock.id,
    metadata: { user_id: created.userId }
  });
  created.customerId = customer.id;
  expect('created a customer on the test clock', Boolean(customer.id), customer.id);

  await stripe.paymentMethods.attach('pm_card_visa', { customer: customer.id });
  await stripe.customers.update(customer.id, { invoice_settings: { default_payment_method: 'pm_card_visa' } });
  expect('attached a test card', true, 'pm_card_visa');

  const subscription = await stripe.subscriptions.create({
    customer: customer.id,
    items: [{ price: price.id }],
    metadata: { user_id: created.userId }
  });
  created.subscriptionId = subscription.id;
  expect('created the subscription', Boolean(subscription.id), `${subscription.id} (${subscription.status})`);

  // -- 6. the deployed webhook must make this active without any help from us
  const activated = await waitForEntitlement(accessToken, body => body.entitled === true, { label: 'entitled:true' });
  expect('the deployed webhook activated the subscription', activated.body.entitled === true);
  expect('reason is active', activated.body.reason === 'active', String(activated.body.reason));
  expect('access_until is set while entitled', Boolean(activated.body.subscription?.access_until));
  expect('plan is the lookup key', activated.body.subscription?.plan === LOOKUP_KEY,
    String(activated.body.subscription?.plan));
  expect('recheck_after_seconds is within the contract range',
    activated.body.recheck_after_seconds >= 300 && activated.body.recheck_after_seconds <= 86_400,
    String(activated.body.recheck_after_seconds));

  const item = await stripe.subscriptionItems.list({ subscription: subscription.id, limit: 1 });
  const periodEnd = item.data[0]?.current_period_end;
  expect('current_period_end matches the subscription item',
    activated.body.subscription?.current_period_end === rfc3339(periodEnd),
    `${activated.body.subscription?.current_period_end} vs ${rfc3339(periodEnd)}`);

  // -- 7. cancelling keeps access to the end of the paid period
  await stripe.subscriptions.update(subscription.id, { cancel_at_period_end: true });
  const pending = await waitForEntitlement(accessToken, body => body.reason === 'canceled_pending',
    { label: 'reason:canceled_pending' });
  expect('a scheduled cancellation keeps access', pending.body.entitled === true);
  expect('reason is canceled_pending', pending.body.reason === 'canceled_pending');
  expect('cancel_at_period_end is reported', pending.body.subscription?.cancel_at_period_end === true);
  expect('access_until is still the period end',
    pending.body.subscription?.access_until === rfc3339(periodEnd),
    `${pending.body.subscription?.access_until} vs ${rfc3339(periodEnd)}`);

  // -- 8. past the period end, access is over
  console.log('  advancing the test clock past the period end (this takes a moment)…');
  await stripe.testHelpers.testClocks.advance(clock.id, { frozen_time: periodEnd + 3600 });
  for (let attempt = 0; attempt < 60; attempt++) {
    const state = await stripe.testHelpers.testClocks.retrieve(clock.id);
    if (state.status === 'ready') break;
    if (state.status === 'internal_failure') throw new Error('the test clock failed to advance');
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  const expired = await waitForEntitlement(accessToken, body => body.entitled === false,
    { label: 'entitled:false after the period end' });
  expect('access ends after the paid period', expired.body.entitled === false);
  expect('reason is expired', expired.body.reason === 'expired', String(expired.body.reason));
  expect('access_until is null once access is over', expired.body.subscription?.access_until === null);

  // -- 9. an unauthenticated call is rejected
  const anonymous = await fetch(`${SUPABASE_URL}/functions/v1/entitlement`, { headers: { apikey: PUBLISHABLE_KEY } });
  const anonymousBody = await anonymous.json().catch(() => null);
  expect('an unauthenticated entitlement call is 401 unauthorized',
    anonymous.status === 401 && anonymousBody?.error === 'unauthorized',
    `status ${anonymous.status}`);
} catch (error) {
  fatal = error;
  record('run completed without an unexpected error', false, error.message);
} finally {
  // ---------------------------------------------------------------- cleanup
  console.log('\nCleaning up:');
  const cleanup = [
    ['subscription', async () => {
      if (created.subscriptionId) await stripe.subscriptions.cancel(created.subscriptionId).catch(() => {});
    }],
    ['Stripe customer', async () => {
      if (created.customerId) await stripe.customers.del(created.customerId);
    }],
    ['Stripe test clock', async () => {
      if (created.testClockId) await stripe.testHelpers.testClocks.del(created.testClockId);
    }],
    ['Supabase user', async () => {
      if (created.userId) await adminRequest('DELETE', `/users/${created.userId}`);
    }]
  ];
  for (const [what, run] of cleanup) {
    try {
      await run();
      console.log('  ✓ deleted the', what);
    } catch (error) {
      console.error('  ! could not delete the', what, '—', error.message.slice(0, 200));
      console.error('    Remove it by hand so it does not linger in test mode.');
    }
  }
}

// ---------------------------------------------------------------- the table
const width = Math.max(...results.map(r => r.name.length), 10);
console.log('\n' + 'Result'.padEnd(8) + 'Assertion');
console.log('-'.repeat(8 + width));
for (const { name, passed } of results) console.log((passed ? 'pass' : 'FAIL').padEnd(8) + name);

const failed = results.filter(r => !r.passed);
console.log('');
if (failed.length || fatal) {
  console.error(`✗ e2e:billing failed: ${failed.length} of ${results.length} assertions.`);
  process.exit(1);
}
console.log(`✓ e2e:billing passed: ${results.length} of ${results.length} assertions.`);
console.log('  Website, backend and Stripe agree. The desktop tests use this same deployed backend.');
