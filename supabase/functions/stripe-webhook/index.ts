// POST stripe-webhook — Stripe's only way into our database (guide 5.6).
//
// Three rules hold this function together:
//   1. The signature is verified over the *raw* request body. An unverified body is never
//      parsed, logged or acted on, so a forged event cannot grant anyone a subscription.
//   2. Every delivery is recorded in `stripe_events` first, so a replay is a no-op.
//   3. Nothing trusts the payload's own state: each handler re-retrieves the subscription
//      from Stripe, which makes out-of-order delivery harmless.

import type { Db } from '../_shared/db.ts';
import { isWebhookConfigured, type Config } from '../_shared/env.ts';
import { describeError, error, json } from '../_shared/http.ts';
import { createRuntime } from '../_shared/runtime.ts';
import { subscriptionIdFromInvoice, type Stripe } from '../_shared/stripe.ts';
import type { Logger, Sync } from '../_shared/sync.ts';

/** The events the endpoint subscribes to. `setup-billing.mjs` registers exactly this list. */
export const HANDLED_EVENTS = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.resumed',
  'customer.subscription.trial_will_end',
  'invoice.paid',
  'invoice.payment_failed'
] as const;

export interface WebhookDeps {
  config: Config;
  now(): number;
  db: Db;
  sync: Sync;
  log: Logger;
  /** Verifies the signature over the raw body, or throws. */
  constructEvent(rawBody: string, signature: string, secret: string): Promise<Stripe.Event>;
}

function idOf(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value || null;
  const id = (value as { id?: string }).id;
  return id || null;
}

export function createHandler(deps: WebhookDeps): (request: Request) => Promise<Response> {
  const { config, now, db, sync, log } = deps;

  async function dispatch(event: Stripe.Event): Promise<void> {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.mode !== 'subscription') return;

        const userId = session.client_reference_id || (session.metadata?.user_id ?? '') || null;
        const customerId = idOf(session.customer);
        // Link the customer before syncing so the subscription can resolve its owner even
        // when Stripe's subscription metadata has not propagated yet.
        if (userId && customerId) await db.insertCustomer({ user_id: userId, stripe_customer_id: customerId });

        const subscriptionId = idOf(session.subscription);
        if (subscriptionId) await sync.syncSubscription(subscriptionId, userId);
        else log.warn('checkout_completed_without_subscription', { session: session.id });
        return;
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
      case 'customer.subscription.paused':
      case 'customer.subscription.resumed':
      case 'customer.subscription.trial_will_end': {
        const subscription = event.data.object as Stripe.Subscription;
        // Even for `deleted`: the fresh retrieve returns status `canceled`, which is what
        // the decision table needs, and avoids trusting a possibly out-of-date payload.
        await sync.syncSubscription(subscription.id);
        return;
      }

      case 'invoice.paid':
      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        const subscriptionId = subscriptionIdFromInvoice(invoice);
        if (subscriptionId) await sync.syncSubscription(subscriptionId);
        else log.info('invoice_without_subscription', { event: event.id });
        return;
      }

      default:
        // Anything else is acknowledged and ignored, so Stripe stops retrying it.
        log.info('event_ignored', { event: event.id, type: event.type });
    }
  }

  return async function handler(request: Request): Promise<Response> {
    if (request.method !== 'POST') return error(405, 'method_not_allowed');
    if (!isWebhookConfigured(config)) return error(503, 'not_configured');

    // Read the body as text and keep it that way until the signature checks out.
    const rawBody = await request.text();
    const signature = request.headers.get('stripe-signature') ?? '';

    let event: Stripe.Event;
    try {
      event = await deps.constructEvent(rawBody, signature, config.stripeWebhookSecret);
    } catch (thrown) {
      // Deliberately terse: no body, no header, nothing an attacker could use as an oracle.
      log.warn('bad_signature', { detail: thrown instanceof Error ? thrown.name : 'unknown' });
      return error(400, 'bad_signature');
    }

    try {
      const { alreadyProcessed } = await db.recordEvent(event.id, event.type);
      if (alreadyProcessed) {
        log.info('event_duplicate', { event: event.id, type: event.type });
        return json(200, { received: true });
      }

      await dispatch(event);

      await db.markEventProcessed(event.id, new Date(now()).toISOString());
      log.info('event_processed', { event: event.id, type: event.type });
      return json(200, { received: true });
    } catch (thrown) {
      // Left unmarked on purpose: returning 500 makes Stripe retry, and the unmarked row
      // means the retry will do the work rather than being swallowed as a duplicate.
      log.error('event_failed', { event: event.id, type: event.type, detail: describeError(thrown) });
      return error(500, 'internal');
    }
  };
}

if (import.meta.main) {
  const runtime = createRuntime('stripe-webhook');
  const { subtleCryptoProvider } = await import('../_shared/stripe.ts');
  // Deno has no Node crypto: HMAC verification goes through WebCrypto, which is async.
  const cryptoProvider = subtleCryptoProvider();

  Deno.serve(createHandler({
    ...runtime,
    constructEvent: (rawBody, signature, secret) =>
      runtime.stripe().webhooks.constructEventAsync(rawBody, signature, secret, undefined, cryptoProvider)
  }));
}
