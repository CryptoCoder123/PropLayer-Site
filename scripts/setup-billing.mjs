#!/usr/bin/env node
// Idempotent Stripe setup: product, price, Customer Portal configuration and webhook
// endpoint (guide 8.2).
//
//   npm run billing:setup -- --price-cents 1499
//   npm run billing:setup -- --price-cents 1499 --currency usd
//   npm run billing:setup -- --price-cents 1499 --recreate-webhook
//   npm run billing:setup -- --price-cents 1499 --dry-run
//
// Re-running with the same price changes nothing. Re-running with a different price creates
// the new price, moves the lookup key to it and deactivates the old one, so existing
// subscriptions keep billing at the price their customer agreed to.

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

const flag = name => {
  const index = args.indexOf(`--${name}`);
  if (index >= 0 && args[index + 1] && !args[index + 1].startsWith('--')) return args[index + 1];
  const inline = args.find(a => a.startsWith(`--${name}=`));
  return inline ? inline.slice(name.length + 3) : null;
};

const dryRun = args.includes('--dry-run');
const recreateWebhook = args.includes('--recreate-webhook');
const currency = (flag('currency') ?? 'usd').toLowerCase();

const PRODUCT_NAME = 'Prop Layer';
const PRODUCT_MARKER = 'proplayer';
const LOOKUP_KEY_DEFAULT = 'proplayer_monthly';

/** Exactly the events supabase/functions/stripe-webhook/index.ts acts on. */
const WEBHOOK_EVENTS = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.resumed',
  'customer.subscription.trial_will_end',
  'invoice.paid',
  'invoice.payment_failed'
];

let failures = 0;
const ok = (message, detail) => console.log('✓', message + (detail ? ` — ${detail}` : ''));
const skip = (message, why) => console.log('–', message + (why ? ` — ${why}` : ''));
const bad = (message, detail) => { failures++; console.error('✗', message + (detail ? `\n    ${detail}` : '')); };
const info = message => console.log(' ', message);

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

const STRIPE_KEY = get('STRIPE_SECRET_KEY');
if (!STRIPE_KEY) {
  console.error('✗ STRIPE_SECRET_KEY is not set. Nothing was changed.');
  process.exit(2);
}
const live = STRIPE_KEY.startsWith('sk_live_') || STRIPE_KEY.startsWith('rk_live_');
if (live && !args.includes('--allow-live')) {
  console.error('✗ STRIPE_SECRET_KEY is a LIVE key. Re-run with --allow-live to set up live billing.');
  process.exit(2);
}

const PROJECT_REF = get('SUPABASE_PROJECT_REF');
const LOOKUP_KEY = get('STRIPE_PRICE_LOOKUP_KEY') || LOOKUP_KEY_DEFAULT;
const SITE_URL = (get('SITE_URL') || 'https://prop-layer.com').replace(/\/+$/, '');

const priceCentsRaw = flag('price-cents');
const priceCents = priceCentsRaw === null ? null : Number.parseInt(priceCentsRaw, 10);
if (priceCentsRaw !== null && (!Number.isInteger(priceCents) || priceCents <= 0)) {
  console.error('✗ --price-cents must be a positive whole number of minor units (e.g. 1499 for $14.99).');
  process.exit(2);
}

// A banner, not a footnote: setting up live billing by accident is expensive to undo.
console.log('');
console.log(live ? '  ####  STRIPE LIVE MODE  ####' : '  ----  Stripe TEST mode  ----');
console.log('');
if (dryRun) console.log('(dry run: nothing will be created or changed)\n');

const Stripe = (await import('stripe')).default;
const stripe = new Stripe(STRIPE_KEY);

// ---------------------------------------------------------------- Supabase secrets
const CLI_ENTRY = path.join(root, 'node_modules/supabase/dist/supabase.js');

/**
 * Stores a secret as an Edge Function secret. The value goes through a temporary env file
 * rather than argv, so it never appears in a process listing or shell history.
 */
function setFunctionSecret(name, value) {
  if (dryRun) { skip(`set ${name} as a function secret`, 'dry run'); return true; }
  if (!PROJECT_REF || !get('SUPABASE_ACCESS_TOKEN')) {
    skip(`set ${name} as a function secret`, 'SUPABASE_PROJECT_REF / SUPABASE_ACCESS_TOKEN not set');
    info(`Set it by hand: supabase secrets set ${name}=<value>`);
    return false;
  }
  if (!fs.existsSync(CLI_ENTRY)) {
    bad(`cannot set ${name}`, 'the pinned Supabase CLI is missing — run "npm ci"');
    return false;
  }

  const envFile = path.join(os.tmpdir(), `proplayer-billing-${crypto.randomBytes(8).toString('hex')}.env`);
  try {
    fs.writeFileSync(envFile, `${name}=${value}\n`, { mode: 0o600 });
    const result = spawnSync(process.execPath,
      [CLI_ENTRY, 'secrets', 'set', '--env-file', envFile, '--project-ref', PROJECT_REF],
      { cwd: root, encoding: 'utf8', env: { ...process.env, SUPABASE_ACCESS_TOKEN: get('SUPABASE_ACCESS_TOKEN') } }
    );
    if (result.status === 0) { ok(`set ${name} as a function secret`); return true; }
    bad(`could not set ${name}`, `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().slice(0, 600));
    return false;
  } finally {
    try { fs.rmSync(envFile, { force: true }); } catch { /* best effort */ }
  }
}

// ---------------------------------------------------------------- 1. product
let product = null;
try {
  // Found by marker, not by name, so renaming the product in the Dashboard is harmless.
  const search = await stripe.products.search({ query: `metadata['app']:'${PRODUCT_MARKER}'`, limit: 1 });
  product = search.data[0] ?? null;

  if (product) {
    ok(`product exists`, `${product.name} (${product.id})`);
  } else if (dryRun) {
    skip('create the product', 'dry run');
  } else {
    product = await stripe.products.create({
      name: PRODUCT_NAME,
      description: 'Player information anchored to the action, as an overlay for your Windows PC.',
      metadata: { app: PRODUCT_MARKER },
      url: SITE_URL
    }, { idempotencyKey: `product-${PRODUCT_MARKER}` });
    ok('created the product', `${product.name} (${product.id})`);
  }
} catch (error) {
  bad('product setup failed', describe(error));
}

// ---------------------------------------------------------------- 2. price
let price = null;
if (!failures && (product || dryRun)) {
  try {
    const existing = await stripe.prices.list({ lookup_keys: [LOOKUP_KEY], active: true, limit: 1 });
    price = existing.data[0] ?? null;

    if (price && priceCents === null) {
      ok(`price exists`, `${formatAmount(price.unit_amount, price.currency)} (${price.id})`);
    } else if (price && price.unit_amount === priceCents && price.currency === currency) {
      ok('price already matches', `${formatAmount(price.unit_amount, price.currency)} (${price.id})`);
    } else if (priceCents === null) {
      bad('no price exists yet', 'pass --price-cents <n> to create one (e.g. --price-cents 1499).');
    } else if (dryRun) {
      skip(price ? 'replace the price' : 'create the price', 'dry run');
    } else {
      const previous = price;
      // transfer_lookup_key moves the key atomically, so `prices.list({lookup_keys})` in
      // create-checkout-session never sees a window with no price.
      price = await stripe.prices.create({
        product: product.id,
        currency,
        unit_amount: priceCents,
        recurring: { interval: 'month' },
        lookup_key: LOOKUP_KEY,
        transfer_lookup_key: true,
        metadata: { app: PRODUCT_MARKER }
      });
      ok('created the monthly price', `${formatAmount(priceCents, currency)} (${price.id}), lookup key ${LOOKUP_KEY}`);

      if (previous) {
        await stripe.prices.update(previous.id, { active: false });
        ok('deactivated the previous price', previous.id);
        info('Existing subscriptions keep billing at the price their customer agreed to; Stripe does not migrate them.');
      }
    }
  } catch (error) {
    bad('price setup failed', describe(error));
  }
}

// ---------------------------------------------------------------- 3. Customer Portal
if (!failures) {
  try {
    const CONFIG_MARKER = `${PRODUCT_MARKER}_portal`;
    const existing = await stripe.billingPortal.configurations.list({ limit: 100 });
    const current = existing.data.find(entry => entry.metadata?.app === CONFIG_MARKER) ?? null;

    /*
      "Cancel at period end" is the setting that gives the contract's "keep access through
      the paid period" with no code of ours. Email and address updates are off because
      Supabase Auth owns the email address; letting Stripe change it would split identity
      across two systems.
    */
    const features = {
      customer_update: { enabled: false },
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      subscription_cancel: {
        enabled: true,
        mode: 'at_period_end',
        cancellation_reason: {
          enabled: true,
          options: ['too_expensive', 'missing_features', 'switched_service', 'unused', 'customer_service', 'too_complex', 'low_quality', 'other']
        }
      },
      subscription_update: { enabled: false }
    };
    const businessProfile = {
      headline: 'Prop Layer — manage your subscription',
      privacy_policy_url: `${SITE_URL}/privacy.html`,
      terms_of_service_url: `${SITE_URL}/terms.html`
    };
    const params = {
      features,
      business_profile: businessProfile,
      default_return_url: `${SITE_URL}/account.html#billing`,
      metadata: { app: CONFIG_MARKER }
    };

    let configuration = current;
    if (dryRun) {
      skip(current ? 'update the portal configuration' : 'create the portal configuration', 'dry run');
    } else if (current) {
      configuration = await stripe.billingPortal.configurations.update(current.id, params);
      ok('updated the portal configuration', configuration.id);
    } else {
      configuration = await stripe.billingPortal.configurations.create(params);
      ok('created the portal configuration', configuration.id);
    }

    if (configuration) setFunctionSecret('STRIPE_PORTAL_CONFIGURATION_ID', configuration.id);
  } catch (error) {
    bad('portal configuration failed', describe(error));
  }
}

// ---------------------------------------------------------------- 4. webhook
if (!failures) {
  if (!PROJECT_REF) {
    bad('cannot set up the webhook', 'SUPABASE_PROJECT_REF is not set, so the endpoint URL is unknown.');
  } else {
    const url = `https://${PROJECT_REF}.supabase.co/functions/v1/stripe-webhook`;
    try {
      const endpoints = await stripe.webhookEndpoints.list({ limit: 100 });
      let endpoint = endpoints.data.find(entry => entry.url === url) ?? null;

      if (endpoint && recreateWebhook && !dryRun) {
        await stripe.webhookEndpoints.del(endpoint.id);
        ok('deleted the old webhook endpoint', endpoint.id);
        endpoint = null;
      }

      if (endpoint) {
        const missingEvents = WEBHOOK_EVENTS.filter(event => !endpoint.enabled_events.includes(event));
        if (missingEvents.length && !dryRun) {
          endpoint = await stripe.webhookEndpoints.update(endpoint.id, { enabled_events: WEBHOOK_EVENTS });
          ok('updated the webhook event list', `added ${missingEvents.join(', ')}`);
        } else if (missingEvents.length) {
          skip('update the webhook event list', 'dry run');
        } else {
          ok('webhook endpoint exists with the right events', endpoint.id);
        }

        // Stripe reveals a signing secret only at creation.
        if (!get('STRIPE_WEBHOOK_SECRET')) {
          bad('STRIPE_WEBHOOK_SECRET is not available',
            'Stripe only shows a signing secret when the endpoint is created. Either copy it from\n'
            + `    Dashboard → Developers → Webhooks → ${endpoint.id} → "Reveal" into your environment,\n`
            + '    or re-run this script with --recreate-webhook to make a new endpoint and set it automatically.');
        } else {
          setFunctionSecret('STRIPE_WEBHOOK_SECRET', get('STRIPE_WEBHOOK_SECRET'));
        }
      } else if (dryRun) {
        skip('create the webhook endpoint', 'dry run');
      } else {
        endpoint = await stripe.webhookEndpoints.create({
          url,
          enabled_events: WEBHOOK_EVENTS,
          description: 'Prop Layer accounts backend (contract PL-ACCOUNT-1)',
          metadata: { app: PRODUCT_MARKER }
        });
        ok('created the webhook endpoint', `${endpoint.id} → ${url}`);
        // Set immediately: this is the only moment the secret is visible.
        if (endpoint.secret) setFunctionSecret('STRIPE_WEBHOOK_SECRET', endpoint.secret);
        else bad('the new endpoint returned no signing secret', 'copy it from the Dashboard and set it by hand');
      }
    } catch (error) {
      bad('webhook setup failed', describe(error));
    }
  }
}

// ---------------------------------------------------------------- 5. priceDisplay
const CONFIG_FILE = path.join(root, 'assets/config.js');
if (!failures && price) {
  const display = `${formatAmount(price.unit_amount, price.currency)} / month`;
  if (dryRun) {
    skip('write priceDisplay into assets/config.js', `would be "${display}"`);
  } else {
    const before = fs.readFileSync(CONFIG_FILE, 'utf8');
    const after = before.replace(/(\bpriceDisplay:\s*)'[^']*'/, `$1'${display}'`);
    if (after === before) ok('assets/config.js already shows this price', display);
    else {
      fs.writeFileSync(CONFIG_FILE, after);
      ok('wrote priceDisplay into assets/config.js', display);
      info('Commit assets/config.js so the site shows the price.');
    }
  }
}

// ---------------------------------------------------------------- helpers
function formatAmount(minorUnits, code) {
  // Stripe's zero-decimal currencies have no minor unit to divide by.
  const ZERO_DECIMAL = new Set(['bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf']);
  const divisor = ZERO_DECIMAL.has(String(code).toLowerCase()) ? 1 : 100;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: String(code).toUpperCase() })
      .format(minorUnits / divisor);
  } catch {
    return `${(minorUnits / divisor).toFixed(divisor === 1 ? 0 : 2)} ${String(code).toUpperCase()}`;
  }
}

function describe(error) {
  const requestId = error?.requestId ? ` (stripe request ${error.requestId})` : '';
  return `${error?.type ?? error?.name ?? 'Error'}: ${error?.message ?? error}${requestId}`;
}

// ---------------------------------------------------------------- 6. manual checklist
console.log('');
if (failures) {
  console.error(`✗ billing:setup finished with ${failures} failed step${failures === 1 ? '' : 's'}.`);
  process.exit(1);
}
console.log(`✓ billing:setup complete (${live ? 'LIVE' : 'TEST'} mode).`);
console.log('');
console.log('Dashboard-only settings — these cannot be set by API and must be done once per mode:');
console.log('  1. Billing → Revenue recovery → Retries: retry for up to 1 week, then CANCEL the subscription.');
console.log('     The entitlement decision relies on this to end access after a failed renewal.');
console.log('  2. Settings → Customer emails: enable receipts and failed-payment emails.');
console.log('  3. Settings → Public business information: name, support email and address (shown at checkout).');
if (live) {
  console.log('  4. Confirm the product is described as an informational sports overlay, with no wagering.');
  console.log('  5. Re-run `npm run backend:deploy` so the live STRIPE_SECRET_KEY reaches the functions.');
} else {
  console.log('  4. Next: `npm run e2e:billing` proves website, backend and Stripe agree, end to end.');
}
