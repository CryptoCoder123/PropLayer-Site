#!/usr/bin/env node
// Deploys the Supabase half of the accounts backend (guide 8.1).
//
//   npm run backend:deploy
//   npm run backend:deploy -- --write-config   # also fills assets/config.js
//   npm run backend:deploy -- --dry-run        # print the plan, change nothing
//
// Every step is idempotent and safe to re-run. Secret *values* are never printed, never
// passed on a command line (where `ps` would show them) and never written to a tracked
// file: they go to the CLI through a temporary env file that is deleted afterwards.

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const writeConfig = args.includes('--write-config');
const dryRun = args.includes('--dry-run');

const MANAGEMENT_API = 'https://api.supabase.com';
const FUNCTIONS = ['entitlement', 'create-checkout-session', 'create-portal-session', 'stripe-webhook'];

// ---------------------------------------------------------------- output
let failures = 0;
const steps = [];
const ok = (message, detail) => { steps.push(['✓', message]); console.log('✓', message + (detail ? ` — ${detail}` : '')); };
const skip = (message, why) => { steps.push(['–', message]); console.log('–', message + (why ? ` — ${why}` : '')); };
const bad = (message, detail) => { failures++; steps.push(['✗', message]); console.error('✗', message + (detail ? `\n    ${detail}` : '')); };
const info = message => console.log(' ', message);

// ---------------------------------------------------------------- environment
/** A deliberately small .env reader: KEY=VALUE, # comments, optional quotes, no expansion. */
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

// The real environment wins over .env, so a shell override behaves as expected.
const env = { ...readDotEnv(path.join(root, '.env')), ...process.env };
const get = name => String(env[name] ?? '').trim();

const ACCESS_TOKEN = get('SUPABASE_ACCESS_TOKEN');
const PROJECT_REF = get('SUPABASE_PROJECT_REF');
const DB_PASSWORD = get('SUPABASE_DB_PASSWORD');

const missing = [
  ['SUPABASE_ACCESS_TOKEN', ACCESS_TOKEN],
  ['SUPABASE_PROJECT_REF', PROJECT_REF],
  ['SUPABASE_DB_PASSWORD', DB_PASSWORD]
].filter(([, value]) => !value).map(([name]) => name);

if (missing.length) {
  console.error(`✗ Missing required variables: ${missing.join(', ')}`);
  console.error('  Set them in your shell or in .env (see .env.example). Nothing was changed.');
  process.exit(2);
}
if (!/^[a-z]{20}$/.test(PROJECT_REF)) {
  console.error(`✗ SUPABASE_PROJECT_REF does not look like a project ref (20 lowercase letters).`);
  process.exit(2);
}

// A live Stripe key is a deliberate act; this script will not take one by accident.
const STRIPE_KEY = get('STRIPE_SECRET_KEY');
if (STRIPE_KEY.startsWith('sk_live_') && !args.includes('--allow-live')) {
  console.error('✗ STRIPE_SECRET_KEY is a LIVE key. Re-run with --allow-live if that is intended.');
  process.exit(2);
}

console.log(`Prop Layer backend deploy → project ${PROJECT_REF}`);
console.log(`Stripe mode: ${STRIPE_KEY.startsWith('sk_live_') ? 'LIVE' : STRIPE_KEY ? 'TEST' : 'not set'}`);
if (dryRun) console.log('(dry run: nothing will be changed)\n');
else console.log('');

// ---------------------------------------------------------------- the CLI
/**
 * Runs the repository's pinned Supabase CLI. The package's own Node entry point is
 * invoked directly rather than through npx, so the version is unambiguous and no shell
 * is involved on any platform.
 *
 * Secrets reach the CLI through the environment only. Nothing secret is ever put in argv,
 * which other processes can read.
 */
const CLI_ENTRY = path.join(root, 'node_modules/supabase/dist/supabase.js');

function supabase(cliArgs, { secretEnv = {}, label } = {}) {
  const printable = cliArgs.join(' ');
  if (dryRun) { skip(label ?? `supabase ${printable}`, 'dry run'); return { ok: true, stdout: '', skipped: true }; }
  if (!fs.existsSync(CLI_ENTRY)) {
    return { ok: false, stdout: `the pinned Supabase CLI is missing at ${CLI_ENTRY} — run "npm ci"` };
  }

  const result = spawnSync(process.execPath, [CLI_ENTRY, ...cliArgs], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, SUPABASE_ACCESS_TOKEN: ACCESS_TOKEN, SUPABASE_DB_PASSWORD: DB_PASSWORD, ...secretEnv },
    maxBuffer: 32 * 1024 * 1024
  });
  if (result.error) return { ok: false, stdout: result.error.message };
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  return { ok: result.status === 0, stdout: output };
}

// ---------------------------------------------------------------- 1. link
{
  const result = supabase(['link', '--project-ref', PROJECT_REF], { label: `link project ${PROJECT_REF}` });
  if (result.skipped) { /* already reported */ }
  else if (result.ok) ok(`linked project ${PROJECT_REF}`);
  else if (/already linked/i.test(result.stdout)) ok(`project ${PROJECT_REF} was already linked`);
  else bad('link failed', result.stdout.slice(0, 1200));
}

// ---------------------------------------------------------------- 2. migrations
if (!failures) {
  const result = supabase(['db', 'push', '--linked'], { label: 'push migrations' });
  if (result.skipped) { /* already reported */ }
  else if (result.ok) {
    ok('migrations are applied', /up to date/i.test(result.stdout) ? 'already up to date' : 'applied');
  } else {
    bad('db push failed', result.stdout.slice(0, 1200));
  }
}

// ---------------------------------------------------------------- 3. functions
if (!failures) {
  // --use-api bundles server-side, so deploying needs no local Docker.
  const result = supabase(['functions', 'deploy', ...FUNCTIONS, '--use-api'], { label: 'deploy Edge Functions' });
  if (result.skipped) { /* already reported */ }
  else if (result.ok) ok(`deployed ${FUNCTIONS.length} Edge Functions`, FUNCTIONS.join(', '));
  else bad('functions deploy failed', result.stdout.slice(0, 1600));
}

// ---------------------------------------------------------------- 4. secrets
/** Guide 5.2. Only non-empty values are sent; the platform provides the SUPABASE_* ones. */
const SECRET_NAMES = [
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_PRICE_LOOKUP_KEY',
  'STRIPE_PORTAL_CONFIGURATION_ID',
  'STRIPE_AUTOMATIC_TAX',
  'SITE_URL',
  'ALLOWED_ORIGINS',
  'ENTITLEMENT_RECHECK_SECONDS',
  'OFFLINE_GRACE_SECONDS',
  'PAST_DUE_ENTITLED'
];

if (!failures) {
  const present = SECRET_NAMES.filter(name => get(name));
  if (present.length === 0) {
    skip('set function secrets', 'none of the section 5.2 variables are set');
  } else {
    // Written to a temp file rather than the command line: argv is visible to other
    // processes, and shell history would keep it.
    const envFile = path.join(os.tmpdir(), `proplayer-secrets-${crypto.randomBytes(8).toString('hex')}.env`);
    try {
      fs.writeFileSync(envFile, present.map(name => `${name}=${get(name)}`).join('\n') + '\n', { mode: 0o600 });
      const result = supabase(['secrets', 'set', '--env-file', envFile], { label: 'set function secrets' });
      if (result.skipped) { /* already reported */ }
      else if (result.ok) ok(`set ${present.length} function secrets`, present.join(', '));
      else bad('secrets set failed', result.stdout.slice(0, 1200));
    } finally {
      try { fs.rmSync(envFile, { force: true }); } catch { /* best effort */ }
    }
  }
}

// ---------------------------------------------------------------- Management API
async function management(method, endpoint, body) {
  const response = await fetch(`${MANAGEMENT_API}/v1/projects/${PROJECT_REF}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  let payload = null;
  try { payload = await response.json(); } catch { payload = null; }
  return { status: response.status, ok: response.ok, payload };
}

// ---------------------------------------------------------------- 5. auth settings
/*
  Field names verified against the current Management API reference
  (https://supabase.com/docs/reference/api/v1-update-auth-service-config):
  `mailer_autoconfirm: false` is what *requires* confirmation — the guide describes this as
  "email confirmations on", which is the same setting read the other way round.
*/
if (!failures) {
  const siteUrl = get('SITE_URL') || 'https://prop-layer.com';
  const redirects = [`${siteUrl.replace(/\/+$/, '')}/account.html`, 'http://localhost:4173/account.html'];

  const authConfig = {
    site_url: siteUrl,
    additional_redirect_urls: redirects.join(','),
    external_email_enabled: true,
    disable_signup: false,
    mailer_autoconfirm: false,
    password_min_length: 8,
    jwt_exp: 3600,
    refresh_token_rotation_enabled: true,
    refresh_token_reuse_interval: 10
  };

  const smtp = {
    host: get('SMTP_HOST'),
    port: get('SMTP_PORT'),
    user: get('SMTP_USER'),
    pass: get('SMTP_PASS') || get('SMTP_PASSWORD'),
    sender: get('SMTP_SENDER_EMAIL')
  };
  const smtpComplete = Object.values(smtp).every(Boolean);
  if (smtpComplete) {
    Object.assign(authConfig, {
      smtp_host: smtp.host,
      smtp_port: smtp.port,
      smtp_user: smtp.user,
      smtp_pass: smtp.pass,
      smtp_sender_email: smtp.sender,
      smtp_sender_name: 'Prop Layer',
      smtp_admin_email: get('SMTP_ADMIN_EMAIL') || smtp.sender
    });
  }

  if (dryRun) {
    skip('apply remote Auth settings', 'dry run');
  } else {
    const result = await management('PATCH', '/config/auth', authConfig);
    if (result.ok) {
      ok('applied remote Auth settings', 'email+password, confirmations required, 8-char minimum, rotation on');
      info(`redirect allow-list: ${redirects.join(', ')}`);
      if (smtpComplete) ok('configured custom SMTP', 'sender name "Prop Layer"');
      else skip('configure custom SMTP', 'SMTP_HOST/PORT/USER/PASS/SENDER_EMAIL not all set');
    } else {
      bad(`Auth settings PATCH returned ${result.status}`,
        `${JSON.stringify(result.payload).slice(0, 600)}\n    Apply these by hand in Dashboard → Authentication → Sign In / Providers and URL Configuration:\n    ${JSON.stringify(authConfig, (key, value) => (/pass/i.test(key) ? '<hidden>' : value), 2).replace(/\n/g, '\n    ')}`);
    }
  }

  if (!smtpComplete) {
    info("Supabase's built-in email only reaches team members and is rate-limited; set SMTP_* before launch.");
  }
}

// ---------------------------------------------------------------- 6. --write-config
const CONFIG_FILE = path.join(root, 'assets/config.js');

/** The publishable key (new-style), falling back to the legacy anon JWT. */
async function fetchPublishableKey() {
  const result = await management('GET', '/api-keys?reveal=true');
  if (!result.ok || !Array.isArray(result.payload)) {
    return { error: `api-keys returned ${result.status}: ${JSON.stringify(result.payload).slice(0, 300)}` };
  }
  const keys = result.payload;
  const publishable = keys.find(key => key?.type === 'publishable' || String(key?.api_key ?? '').startsWith('sb_publishable_'));
  if (publishable?.api_key) return { key: publishable.api_key, kind: 'publishable' };

  const anon = keys.find(key => key?.name === 'anon');
  if (anon?.api_key) return { key: anon.api_key, kind: 'legacy anon' };
  return { error: 'neither a publishable key nor a legacy anon key was returned' };
}

if (writeConfig && !failures) {
  if (dryRun) {
    skip('write assets/config.js', 'dry run');
  } else {
    const resolved = await fetchPublishableKey();
    if (resolved.error) {
      bad('could not read the project API keys', `${resolved.error}\n    Copy the publishable key from Dashboard → Project Settings → API keys into assets/config.js by hand.`);
    } else if (/^sb_secret_|service_role/.test(resolved.key)) {
      bad('refusing to write a secret key into assets/config.js', 'the API returned a secret-shaped key');
    } else {
      const before = fs.readFileSync(CONFIG_FILE, 'utf8');
      const after = before
        .replace(/(\bsupabaseUrl:\s*)'[^']*'/, `$1'https://${PROJECT_REF}.supabase.co'`)
        .replace(/(\bsupabasePublishableKey:\s*)'[^']*'/, `$1'${resolved.key}'`);
      if (after === before) ok('assets/config.js already matches this project');
      else {
        fs.writeFileSync(CONFIG_FILE, after);
        ok('wrote assets/config.js', `supabaseUrl + ${resolved.kind} key`);
      }
      info('Commit assets/config.js: it is public configuration, and GitHub Pages has no build step.');
    }
  }
} else if (writeConfig) {
  skip('write assets/config.js', 'earlier steps failed');
}

// ---------------------------------------------------------------- 7. smoke test
if (!failures && !dryRun) {
  const base = `https://${PROJECT_REF}.supabase.co/functions/v1/entitlement`;

  try {
    const preflight = await fetch(base, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://prop-layer.com',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization, apikey'
      }
    });
    const allowOrigin = preflight.headers.get('access-control-allow-origin');
    if (preflight.status === 204 && allowOrigin === 'https://prop-layer.com') {
      ok('CORS preflight answers 204 and echoes https://prop-layer.com');
    } else {
      bad('CORS preflight is wrong', `status ${preflight.status}, allow-origin ${allowOrigin ?? 'absent'}`);
    }
  } catch (error) {
    bad('CORS preflight request failed', error.message);
  }

  try {
    const anonymous = await fetch(base, { method: 'GET', headers: { Origin: 'https://prop-layer.com' } });
    const body = await anonymous.json().catch(() => null);
    if (anonymous.status === 401 && body?.error === 'unauthorized') {
      ok('an unauthenticated GET entitlement returns the 401 contract envelope');
    } else if (anonymous.status === 503 && body?.error === 'not_configured') {
      bad('entitlement answers 503 not_configured',
        'STRIPE_SECRET_KEY is probably not set as a function secret. Set it and re-run.');
    } else {
      bad('unauthenticated GET entitlement is wrong', `status ${anonymous.status}, body ${JSON.stringify(body).slice(0, 300)}`);
    }
  } catch (error) {
    bad('entitlement smoke request failed', error.message);
  }
}

// ---------------------------------------------------------------- verdict
console.log('');
if (failures) {
  console.error(`✗ backend:deploy finished with ${failures} failed step${failures === 1 ? '' : 's'}.`);
  process.exit(1);
}
console.log('✓ backend:deploy complete.');
if (!get('STRIPE_WEBHOOK_SECRET')) {
  console.log('  Next: `npm run billing:setup -- --price-cents <n>` creates the Stripe product, price,');
  console.log('  portal configuration and webhook, and sets STRIPE_WEBHOOK_SECRET for you.');
}
