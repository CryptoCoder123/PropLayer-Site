#!/usr/bin/env node
// Secret-leak and placeholder checks over tracked files (guide 7.4).
//
//   npm run check:config              # fails on a leaked secret, warns on __SET_ME__
//   npm run check:config -- --release # also fails on __SET_ME__
//
// Only files git actually tracks are scanned, because that is what would be published.
// This runs before every deploy and should run in CI.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const release = process.argv.includes('--release');

let failures = 0;
let warnings = 0;
const ok = message => console.log('✓', message);
const warn = message => { warnings++; console.warn('!', message); };
const fail = message => { failures++; console.error('✗', message); };

// ---------------------------------------------------------------- what counts as a secret
/**
 * Each pattern is something that must never be committed. `allow` lets a file mention the
 * *name* of a secret — documentation and these scripts have to — while still failing if a
 * real value appears.
 */
const SECRET_PATTERNS = [
  { name: 'Stripe live secret key', pattern: /\bsk_live_[A-Za-z0-9]{10,}/ },
  { name: 'Stripe test secret key', pattern: /\bsk_test_[A-Za-z0-9]{10,}/ },
  { name: 'Stripe restricted live key', pattern: /\brk_live_[A-Za-z0-9]{10,}/ },
  { name: 'Stripe restricted test key', pattern: /\brk_test_[A-Za-z0-9]{10,}/ },
  { name: 'Stripe webhook signing secret', pattern: /\bwhsec_[A-Za-z0-9+/=]{10,}/ },
  { name: 'Supabase secret key', pattern: /\bsb_secret_[A-Za-z0-9_-]{10,}/ },
  { name: 'service-role JWT', pattern: /"role"\s*:\s*"service_role"/ },
  // A base64url JWT payload whose decoded form claims the service role.
  { name: 'encoded service-role JWT', pattern: /eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/, decodeJwt: true }
];

/** An SMTP password (or any other secret) assigned an actual value. */
const ASSIGNED_SECRET = new RegExp(
  String.raw`\b(SMTP_PASS(?:WORD)?|SMTP_PASS|STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET|SUPABASE_SERVICE_ROLE_KEY|SUPABASE_SECRET_KEYS|SUPABASE_ACCESS_TOKEN|SUPABASE_DB_PASSWORD)\b\s*[:=]\s*(?!$|\s|#|["']?\s*$)(["']?)([^\s"'#,;)}\]]+)\2`,
  'g'
);

/** Values that are obviously not a secret: a placeholder, a variable reference, a comment. */
const NOT_A_VALUE = [
  /^__SET_ME__$/,
  /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/,        // $VAR / ${VAR}
  /^%[A-Za-z_][A-Za-z0-9_]*%$/,              // %VAR%
  /^(''|""|<[^>]*>|\.\.\.|-+|TODO|CHANGEME|xxx+|your-.*|sk_test_\.\.\.)$/i,
  /^process\.env\./,
  /^(Deno\.env|source|env|options|config|request|row)[.[]/,
  /^(true|false|null|undefined|yes|no|0|1)$/i,
  /^(string|boolean|number)$/
];

/** True when the right-hand side is unquoted code rather than a literal value. */
/** A value a test or a document may legitimately carry in place of a real secret. */
const FAKE_VALUE_HINT = /fake|example|placeholder|for-test|-tests?[^a-z]?$/i;
const ELLIPSIS = '.'.repeat(3);

function looksLikeCode(quote, value) {
  return !quote && /[.(\[{]/.test(value);
}

const SKIP_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico', '.mp4', '.webm',
  '.woff', '.woff2', '.ttf', '.otf', '.eot', '.zip', '.exe', '.pdf'
]);

// Files that legitimately describe secrets by name, or that document the patterns above.
const NAME_ONLY_FILES = new Set([
  '.env.example',
  'docs/ACCOUNTS_AND_BILLING.md',
  'docs/implementation/PropLayer-Website-Backend-Guide.md',
  'scripts/check-config.mjs',
  'scripts/deploy-backend.mjs',
  'scripts/setup-billing.mjs',
  'scripts/e2e-billing.mjs',
  'supabase/functions/_shared/env.ts',
  'supabase/functions/tests/fakes.ts',
  'supabase/functions/tests/webhook.test.ts',
  'supabase/functions/tests/checkout.test.ts',
  'supabase/functions/tests/entitlement_handler.test.ts',
  'supabase/functions/tests/portal.test.ts',
  'tools/account-check.cjs'
]);

function trackedFiles() {
  try {
    return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
      .split('\0')
      .filter(Boolean);
  } catch {
    fail('git ls-files failed — run this inside the repository.');
    return [];
  }
}

function decodedJwtClaimsServiceRole(token) {
  const payload = token.split('.')[1];
  if (!payload) return false;
  try {
    return /"role"\s*:\s*"service_role"/.test(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- the scan
const files = trackedFiles();
const placeholderFiles = [];
let scanned = 0;

for (const file of files) {
  if (SKIP_EXTENSIONS.has(path.extname(file).toLowerCase())) continue;

  const absolute = path.join(root, file);
  let text;
  try {
    const stat = fs.statSync(absolute);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) continue;
    text = fs.readFileSync(absolute, 'utf8');
  } catch {
    continue;
  }
  if (text.includes('\0')) continue;
  scanned++;

  const nameOnly = NAME_ONLY_FILES.has(file);

  for (const { name, pattern, decodeJwt } of SECRET_PATTERNS) {
    for (const [lineNumber, line] of text.split(/\r?\n/).entries()) {
      const match = line.match(pattern);
      if (!match) continue;
      if (decodeJwt && !decodedJwtClaimsServiceRole(match[0])) continue;
      // A file allowed to name secrets may still not contain a real one, so the match has
      // to look like a placeholder to be forgiven.
      if (nameOnly && /fake|example|test_fake|placeholder|__SET_ME__|<|\.\.\./i.test(line)) continue;
      fail(`${name} in ${file}:${lineNumber + 1}`);
    }
  }

  for (const match of text.matchAll(ASSIGNED_SECRET)) {
    const [whole, variable, , value] = match;
    const quote = match[2];
    if (NOT_A_VALUE.some(allowed => allowed.test(value))) continue;
    if (looksLikeCode(quote, value)) continue;
    // A file allowed to name secrets may use an obviously fake value for a test.
    if (nameOnly && (FAKE_VALUE_HINT.test(whole) || whole.includes(String.fromCharCode(60)) || whole.includes(ELLIPSIS))) continue;
    const lineNumber = text.slice(0, match.index).split(/\r?\n/).length;
    fail(`${variable} is assigned a value in ${file}:${lineNumber}`);
  }

  if (text.includes('__SET_ME__') && file !== 'scripts/check-config.mjs') placeholderFiles.push(file);
}

ok(`scanned ${scanned} tracked files for leaked secrets`);

// ---------------------------------------------------------------- .env must not be tracked
if (files.includes('.env')) fail('.env is tracked by git. Remove it from the index and rotate every value in it.');
else ok('.env is not tracked');

const gitignore = fs.existsSync(path.join(root, '.gitignore'))
  ? fs.readFileSync(path.join(root, '.gitignore'), 'utf8')
  : '';
if (!/^\.env$/m.test(gitignore)) fail('.gitignore does not ignore .env');
else ok('.gitignore ignores .env');

// ---------------------------------------------------------------- public config sanity
const CONFIG_FILE = 'assets/config.js';
if (!fs.existsSync(path.join(root, CONFIG_FILE))) {
  fail(`${CONFIG_FILE} is missing`);
} else {
  const config = fs.readFileSync(path.join(root, CONFIG_FILE), 'utf8');
  const required = ['supabaseUrl', 'supabasePublishableKey', 'siteUrl', 'releasesRepo', 'planName', 'priceDisplay'];
  const missing = required.filter(key => !new RegExp(`\\b${key}\\s*:`).test(config));
  if (missing.length) fail(`${CONFIG_FILE} is missing: ${missing.join(', ')}`);
  else ok(`${CONFIG_FILE} declares every contract C2 value`);

  // The publishable key is public by design; a secret one in this file would not be.
  if (/\bsb_secret_|service_role|\bsk_(test|live)_/.test(config)) {
    fail(`${CONFIG_FILE} contains something that looks like a secret. Only public values belong here.`);
  } else {
    ok(`${CONFIG_FILE} contains no secret-shaped value`);
  }
}

// ---------------------------------------------------------------- placeholders
if (placeholderFiles.length === 0) {
  ok('no __SET_ME__ placeholders remain');
} else if (release) {
  fail(`__SET_ME__ placeholders remain in: ${placeholderFiles.join(', ')}`);
  console.error('  Run `npm run backend:deploy -- --write-config` and `npm run billing:setup` first.');
} else {
  warn(`__SET_ME__ placeholders remain in: ${placeholderFiles.join(', ')}`);
  console.warn('  That is expected before the backend is deployed. `--release` turns this into a failure.');
}

// ---------------------------------------------------------------- verdict
console.log('');
if (failures) {
  console.error(`✗ check:config failed with ${failures} problem${failures === 1 ? '' : 's'}.`);
  if (warnings) console.error(`  (${warnings} warning${warnings === 1 ? '' : 's'})`);
  process.exit(1);
}
console.log(`✓ check:config passed${warnings ? ` with ${warnings} warning${warnings === 1 ? '' : 's'}` : ''}.`);
