// Builds the real dependency set each function's index.ts injects into its handler.
//
// Construction never throws on missing configuration: a half-configured project must answer
// `503 not_configured` to every request rather than fail to boot, so the pieces that need
// secrets are built lazily and the stand-ins raise `not_configured` if anyone calls them.

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.117.2';
import { createAuth, type Auth } from './auth.ts';
import { createDb, type Db } from './db.ts';
import { isConfigured, readConfig, type Config } from './env.ts';
import { HttpError } from './http.ts';
import { createPriceLookup, createStripe, type PriceLookup, type Stripe } from './stripe.ts';
import { createLogger, createSync, type Logger, type Sync } from './sync.ts';

export interface Runtime {
  config: Config;
  now(): number;
  db: Db;
  auth: Auth;
  sync: Sync;
  log: Logger;
  /** Throws `503 not_configured` when `STRIPE_SECRET_KEY` is absent. */
  stripe(): Stripe;
  prices(): PriceLookup;
}

const notConfigured = (): never => {
  throw new HttpError(503, 'not_configured');
};

export function createRuntime(scope: string, env: Record<string, string | undefined> = Deno.env.toObject()): Runtime {
  const config = readConfig(env);
  const log = createLogger(scope);

  const client: SupabaseClient | null = config.supabaseUrl && config.serviceRoleKey
    ? createClient(config.supabaseUrl, config.serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
      })
    : null;

  const db: Db = client ? createDb(client) : createDb({ from: notConfigured });
  const auth: Auth = client ? createAuth(client) : { getUser: () => Promise.reject(new HttpError(503, 'not_configured')) };

  let stripeClient: Stripe | null = null;
  const stripe = (): Stripe => {
    if (!config.stripeSecretKey) notConfigured();
    stripeClient ??= createStripe(config.stripeSecretKey);
    return stripeClient;
  };

  let priceLookup: PriceLookup | null = null;
  const prices = (): PriceLookup => {
    priceLookup ??= createPriceLookup(stripe());
    return priceLookup;
  };

  // `sync` is only reachable from paths that already checked `isConfigured`, so resolving
  // the Stripe client on each call is safe and keeps construction side-effect free.
  const sync: Sync = createSync({
    stripe: { get subscriptions() { return stripe().subscriptions; } } as never,
    db,
    log,
    now: Date.now
  });

  return { config, now: Date.now, db, auth, sync, log, stripe, prices };
}

export { isConfigured };
