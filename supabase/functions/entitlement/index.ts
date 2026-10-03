// GET entitlement — the only access decision in the product (contract C4/C5).
// The website and the desktop app call this and get the same answer.

import { requireUser, type Auth } from '../_shared/auth.ts';
import { corsHeaders, preflight } from '../_shared/cors.ts';
import type { Db } from '../_shared/db.ts';
import { buildResponse, decide } from '../_shared/entitlement.ts';
import { isConfigured, type Config } from '../_shared/env.ts';
import { describeError, error, HttpError, json } from '../_shared/http.ts';
import { createRuntime } from '../_shared/runtime.ts';
import type { Logger, Sync } from '../_shared/sync.ts';

/** How long a `customers` row may go unsynced before `entitlement` re-reads Stripe. */
export const CUSTOMER_RESYNC_AFTER_MS = 10 * 60 * 1000;

export interface EntitlementDeps {
  config: Config;
  now(): number;
  db: Db;
  auth: Auth;
  sync: Sync;
  log: Logger;
}

export function createHandler(deps: EntitlementDeps): (request: Request) => Promise<Response> {
  const { config, now, db, auth, sync, log } = deps;

  return async function handler(request: Request): Promise<Response> {
    const options = preflight(request, config.allowedOrigins);
    if (options) return options;

    const cors = corsHeaders(request, config.allowedOrigins);

    if (request.method !== 'GET') return error(405, 'method_not_allowed', undefined, cors);
    if (!isConfigured(config)) return error(503, 'not_configured', undefined, cors);

    try {
      const user = await requireUser(request, auth);
      const at = now();

      let rows = await db.listSubscriptions(user.id);
      let decision = decide(rows, at, config);

      // (a) The chosen row claims a live status but its period has run out. The webhook may
      // simply be late, so ask Stripe before telling a paying user they have expired.
      if (decision.stale && decision.row) {
        try {
          await sync.syncSubscription(decision.row.id);
        } catch (stripeError) {
          log.error('stale_resync_failed', { user: user.id, subscription: decision.row.id, detail: describeError(stripeError) });
          return error(502, 'stripe_error', undefined, cors);
        }
        rows = await db.listSubscriptions(user.id);
        decision = decide(rows, at, config);
      }

      // (b) Nothing entitles this user, but they have a Stripe customer. Re-read that
      // customer at most once every ten minutes — and immediately after a checkout, which
      // clears last_synced_at — so activation never waits on webhook delivery.
      if (!decision.entitled) {
        const customer = await db.getCustomer(user.id);
        const lastSynced = customer?.last_synced_at ? Date.parse(customer.last_synced_at) : NaN;
        const due = !Number.isFinite(lastSynced) || at - lastSynced > CUSTOMER_RESYNC_AFTER_MS;
        if (customer && due) {
          try {
            await sync.syncCustomer(customer.stripe_customer_id, user.id);
            await db.markSynced(user.id, new Date(at).toISOString());
            rows = await db.listSubscriptions(user.id);
            decision = decide(rows, at, config);
          } catch (stripeError) {
            // A failure here is not fatal: the database decision is still a valid answer.
            log.warn('customer_resync_failed', { user: user.id, detail: describeError(stripeError) });
          }
        }
      }

      log.info('entitlement', {
        user: user.id,
        entitled: decision.entitled,
        reason: decision.reason,
        subscription: decision.row?.id ?? null
      });

      return json(200, buildResponse(user, decision, at, config), cors);
    } catch (thrown) {
      if (thrown instanceof HttpError) return thrown.toResponse(cors);
      log.error('entitlement_failed', { detail: describeError(thrown) });
      return error(500, 'internal', undefined, cors);
    }
  };
}

// ---------------------------------------------------------------- real wiring
if (import.meta.main) Deno.serve(createHandler(createRuntime('entitlement')));
