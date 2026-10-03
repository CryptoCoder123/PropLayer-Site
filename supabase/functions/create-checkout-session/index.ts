// POST create-checkout-session — hands the browser a Stripe Checkout URL (guide 5.4).
// No payment UI is built or hosted by us; Stripe collects and stores the card.

import { requireUser, type Auth } from '../_shared/auth.ts';
import { corsHeaders, preflight } from '../_shared/cors.ts';
import type { Db } from '../_shared/db.ts';
import { decide } from '../_shared/entitlement.ts';
import { isConfigured, type Config } from '../_shared/env.ts';
import { describeError, error, HttpError, json } from '../_shared/http.ts';
import { createRuntime } from '../_shared/runtime.ts';
import type { PriceLookup, Stripe } from '../_shared/stripe.ts';
import type { Logger } from '../_shared/sync.ts';

export interface CheckoutDeps {
  config: Config;
  now(): number;
  db: Db;
  auth: Auth;
  log: Logger;
  stripe(): Pick<Stripe, 'customers' | 'checkout'>;
  prices(): PriceLookup;
}

export function createHandler(deps: CheckoutDeps): (request: Request) => Promise<Response> {
  const { config, now, db, auth, log } = deps;

  /**
   * The user's Stripe customer. Created at most once per user: the idempotency key makes a
   * retried request reuse Stripe's own result, and `insert … on conflict do nothing`
   * followed by a re-read makes a double-click reuse whichever row landed first.
   */
  async function ensureCustomer(userId: string, email: string): Promise<string> {
    const existing = await db.getCustomer(userId);
    if (existing?.stripe_customer_id) return existing.stripe_customer_id;

    const created = await deps.stripe().customers.create(
      { email, metadata: { user_id: userId } },
      { idempotencyKey: `customer-${userId}` }
    );
    await db.insertCustomer({ user_id: userId, stripe_customer_id: created.id });

    const stored = await db.getCustomer(userId);
    return stored?.stripe_customer_id ?? created.id;
  }

  return async function handler(request: Request): Promise<Response> {
    const options = preflight(request, config.allowedOrigins);
    if (options) return options;

    const cors = corsHeaders(request, config.allowedOrigins);

    if (request.method !== 'POST') return error(405, 'method_not_allowed', undefined, cors);
    if (!isConfigured(config)) return error(503, 'not_configured', undefined, cors);

    try {
      const user = await requireUser(request, auth);

      // Already paying: send them to the portal instead of selling a second subscription.
      const rows = await db.listSubscriptions(user.id);
      if (decide(rows, now(), config).entitled) {
        return error(409, 'already_subscribed', undefined, cors);
      }

      const customer = await ensureCustomer(user.id, user.email);

      const price = await deps.prices().byLookupKey(config.priceLookupKey);
      if (!price) {
        log.error('price_missing', { lookup_key: config.priceLookupKey });
        return error(503, 'not_configured', 'No subscription plan is set up yet.', cors);
      }

      const params: Stripe.Checkout.SessionCreateParams = {
        mode: 'subscription',
        customer,
        client_reference_id: user.id,
        line_items: [{ price: price.id, quantity: 1 }],
        subscription_data: { metadata: { user_id: user.id } },
        allow_promotion_codes: true,
        success_url: `${config.siteUrl}/account.html?checkout=success`,
        cancel_url: `${config.siteUrl}/account.html?checkout=canceled#subscribe`
      };
      if (config.automaticTax) {
        params.automatic_tax = { enabled: true };
        params.customer_update = { address: 'auto' };
        params.billing_address_collection = 'required';
      }

      const session = await deps.stripe().checkout.sessions.create(params);
      if (!session.url) {
        log.error('checkout_session_without_url', { user: user.id, session: session.id });
        return error(502, 'stripe_error', undefined, cors);
      }

      // Clear the sync marker so the next `entitlement` call re-reads Stripe immediately.
      // Together with the webhook this makes activation feel instant even if one is slow.
      await db.markSynced(user.id, null);

      log.info('checkout_session_created', { user: user.id, session: session.id, customer });
      return json(200, { url: session.url }, cors);
    } catch (thrown) {
      if (thrown instanceof HttpError) return thrown.toResponse(cors);
      log.error('checkout_failed', { detail: describeError(thrown) });
      return error(502, 'stripe_error', undefined, cors);
    }
  };
}

if (import.meta.main) {
  const runtime = createRuntime('create-checkout-session');
  Deno.serve(createHandler(runtime));
}
