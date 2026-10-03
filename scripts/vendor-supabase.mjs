#!/usr/bin/env node
// Copies the pinned @supabase/supabase-js UMD build into assets/vendor/ (guide 6.2).
//
// The site self-hosts every asset — fonts included — so there are no runtime requests to a
// CDN and nothing a third party can change under us. GitHub Pages has no build step, so the
// output is committed. Re-run this after bumping the dev dependency.
//
//   npm run vendor:supabase

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_DIR = path.join(root, 'node_modules/@supabase/supabase-js');
const OUT_DIR = path.join(root, 'assets/vendor');
const OUT_SCRIPT = path.join(OUT_DIR, 'supabase.js');
const OUT_LICENCE = path.join(OUT_DIR, 'SUPABASE-LICENSE.txt');

// Where the UMD bundle and the licence have lived across recent versions.
const UMD_CANDIDATES = ['dist/umd/supabase.js', 'dist/umd/supabase.min.js'];
const LICENCE_CANDIDATES = ['LICENSE', 'LICENSE.md', 'LICENCE', 'license'];

let failed = false;
const ok = message => console.log('✓', message);
const bad = message => { failed = true; console.error('✗', message); };

function firstExisting(candidates) {
  for (const relative of candidates) {
    const absolute = path.join(PACKAGE_DIR, relative);
    if (fs.existsSync(absolute)) return { relative, absolute };
  }
  return null;
}

if (!fs.existsSync(PACKAGE_DIR)) {
  bad('@supabase/supabase-js is not installed. Run `npm ci` first.');
  process.exit(1);
}

const { version } = JSON.parse(fs.readFileSync(path.join(PACKAGE_DIR, 'package.json'), 'utf8'));
ok(`found @supabase/supabase-js ${version}`);

const umd = firstExisting(UMD_CANDIDATES);
if (!umd) {
  bad(`no UMD build in ${PACKAGE_DIR}. Looked for: ${UMD_CANDIDATES.join(', ')}`);
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const header = [
  '/*!',
  ` * @supabase/supabase-js ${version} — vendored UMD build.`,
  ' * Source: node_modules/@supabase/supabase-js/' + umd.relative,
  ' * Licence: MIT — see SUPABASE-LICENSE.txt in this folder.',
  ' *',
  ' * Do not edit by hand. Regenerate with `npm run vendor:supabase`.',
  ' * Vendored so the site makes no runtime request to a CDN (guide 6.2).',
  ' */',
  ''
].join('\n');

const bundle = fs.readFileSync(umd.absolute, 'utf8');
const next = header + bundle;

// Idempotent: an unchanged copy is reported as already current rather than rewritten.
const previous = fs.existsSync(OUT_SCRIPT) ? fs.readFileSync(OUT_SCRIPT, 'utf8') : null;
if (previous === next) {
  ok(`assets/vendor/supabase.js is already ${version}`);
} else {
  fs.writeFileSync(OUT_SCRIPT, next);
  ok(`wrote assets/vendor/supabase.js (${(next.length / 1024).toFixed(0)} KB)`);
}
console.log(`  sha256 ${crypto.createHash('sha256').update(bundle).digest('hex')}`);

const licence = firstExisting(LICENCE_CANDIDATES);
if (licence) {
  const text = fs.readFileSync(licence.absolute, 'utf8');
  if (fs.existsSync(OUT_LICENCE) && fs.readFileSync(OUT_LICENCE, 'utf8') === text) {
    ok('assets/vendor/SUPABASE-LICENSE.txt is already current');
  } else {
    fs.writeFileSync(OUT_LICENCE, text);
    ok('wrote assets/vendor/SUPABASE-LICENSE.txt');
  }
} else {
  bad(`no licence file in ${PACKAGE_DIR}. Looked for: ${LICENCE_CANDIDATES.join(', ')}`);
}

// A sanity check: the bundle must expose the global account.html loads it for.
if (!/supabase/i.test(bundle.slice(0, 4000)) || !bundle.includes('createClient')) {
  bad('the copied bundle does not look like the supabase-js UMD build (no createClient found)');
}

if (failed) {
  console.error('\n✗ vendor:supabase did not finish cleanly');
  process.exit(1);
}
console.log('\n✓ vendored supabase-js. Commit assets/vendor/ — GitHub Pages has no build step.');
