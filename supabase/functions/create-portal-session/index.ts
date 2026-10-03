// POST create-portal-session — hands the browser a Stripe Customer Portal URL (guide 5.5).
// Cancelling, resuming, updating the card and downloading invoices all happen there, which
// is why "cancel keeps access to the end of the paid period" needs no code of ours.

import { requireUser, type Auth } from '../_shared/auth.ts';
import { corsHeaders, preflight } from '../_shared/cors.ts';
import type { Db } from '../_shared/db.ts';
import { isConfigured, type Config } from '../_shared/env.ts';
import { describeError, error, HttpError, json } from '../_shared/http.ts';
import { createRuntime } from '../_shared/runtime.ts';
import type { Stripe } from '../_shared/stripe.ts';
import type { Logger } from '../_shared/sync.ts';

export interface PortalDeps {
  config: Config;
  db: Db;
  auth: Auth;
  log: Logger;
  stripe(): Pick<Stripe, 'billingPortal'>;
}

export function createHandler(deps: PortalDeps): (request: Request) => Promise<Response> {
  const { config, db, auth, log } = deps;

  return async function handler(request: Request): Promise<Response> {
    const options = preflight(request, config.allowedOrigins);
    if (options) return options;

    const cors = corsHeaders(request, config.allowedOrigins);

    if (request.method !== 'POST') return error(405, 'method_not_allowed', undefined, cors);
    if (!isConfigured(config)) return error(503, 'not_configured', undefined, cors);

    try {
      const user = await requireUser(request, auth);

      const customer = await db.getCustomer(user.id);
      if (!customer?.stripe_customer_id) {
        // Nothing to manage yet. The account page hides the button on this answer.
        return error(404, 'no_customer', undefined, cors);
      }

      const session = await deps.stripe().billingPortal.sessions.create({
        customer: customer.stripe_customer_id,
        return_url: `${config.siteUrl}/account.html#billing`,
        configuration: config.portalConfigurationId || undefined
      });

      log.info('portal_session_created', { user: user.id, customer: customer.stripe_customer_id });
      return json(200, { url: session.url }, cors);
    } catch (thrown) {
      if (thrown instanceof HttpError) return thrown.toResponse(cors);
      log.error('portal_failed', { detail: describeError(thrown) });
      return error(502, 'stripe_error', undefined, cors);
    }
  };
}

if (import.meta.main) Deno.serve(createHandler(createRuntime('create-portal-session')));
