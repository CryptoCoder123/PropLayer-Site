// Contract PL-ACCOUNT-1 / C9: the shared `contract/` files must still be the ones the
// desktop repository has. A failure here means the two sides have drifted apart.

import { assert, assertEquals } from 'jsr:@std/assert@1';
import Ajv2020 from 'npm:ajv@8.20.0/dist/2020.js';
import { ERROR_CODES } from '../_shared/http.ts';
import { REASONS, SUBSCRIPTION_STATUSES } from '../_shared/entitlement.ts';
import { contractFile, contractJson } from './fakes.ts';

const CONTRACT_FILES = [
  'entitlement.v1.schema.json',
  'fixtures/entitlement.active.json',
  'fixtures/entitlement.canceled_pending.json',
  'fixtures/entitlement.expired.json',
  'fixtures/entitlement.no_subscription.json',
  'fixtures/entitlement.past_due_grace.json',
  'fixtures/error.unauthorized.json'
] as const;

/** sha256( JSON.stringify( JSON.parse(fileText) ) ) — see contract/FINGERPRINTS.md. */
async function fingerprint(relativePath: string): Promise<string> {
  const canonical = JSON.stringify(JSON.parse(await contractFile(relativePath)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** The canonical table, read from FINGERPRINTS.md so there is only one copy of it. */
async function canonicalTable(): Promise<Map<string, string>> {
  const table = new Map<string, string>();
  for (const line of (await contractFile('FINGERPRINTS.md')).split(/\r?\n/)) {
    const row = line.match(/^\|\s*`contract\/([^`]+)`\s*\|\s*`([0-9a-f]{64})`\s*\|$/);
    if (row) table.set(row[1], row[2]);
  }
  return table;
}

Deno.test('contract: FINGERPRINTS.md covers exactly the seven shared files', async () => {
  assertEquals([...(await canonicalTable()).keys()].sort(), [...CONTRACT_FILES].sort());
});

Deno.test('contract: every file matches its canonical fingerprint', async () => {
  const table = await canonicalTable();
  for (const file of CONTRACT_FILES) {
    assertEquals(await fingerprint(file), table.get(file), `contract/${file} no longer matches the shared contract`);
  }
});

const ajv = new (Ajv2020 as unknown as { new (options: unknown): any })({ strict: true, allErrors: true });
const validate = ajv.compile(await contractJson('entitlement.v1.schema.json'));

Deno.test('contract: every entitlement fixture validates against the schema', async () => {
  for (const file of CONTRACT_FILES.filter(name => name.startsWith('fixtures/entitlement.'))) {
    assert(validate(await contractJson(file)), `${file}: ${ajv.errorsText(validate.errors)}`);
  }
});

Deno.test('contract: the schema enforces the entitled/reason invariants', async () => {
  const base = await contractJson<Record<string, any>>('fixtures/entitlement.active.json');
  const rejected: [string, unknown][] = [
    ['entitled true with a not-entitled reason', { ...base, reason: 'expired' }],
    ['entitled false with an entitled reason', { ...base, entitled: false }],
    ['no_subscription carrying a subscription', { ...base, entitled: false, reason: 'no_subscription' }],
    ['entitled true with a null access_until', { ...base, subscription: { ...base.subscription, access_until: null } }],
    ['an unknown reason', { ...base, reason: 'something_new' }],
    ['an unknown status', { ...base, subscription: { ...base.subscription, status: 'something_new' } }],
    ['an extra top-level field', { ...base, extra: true }],
    ['schema other than 1', { ...base, schema: 2 }],
    ['a recheck below the contract minimum', { ...base, recheck_after_seconds: 299 }],
    ['a grace above the contract maximum', { ...base, offline_grace_seconds: 604_801 }],
    ['a non-UTC timestamp', { ...base, checked_at: '2026-10-03T16:00:00+02:00' }],
    ['sub-second precision', { ...base, checked_at: '2026-10-03T16:00:00.500Z' }],
    ['a non-https link', { ...base, links: { ...base.links, download: 'http://prop-layer.com/download.html' } }]
  ];
  for (const [why, value] of rejected) {
    assertEquals(validate(value), false, `the schema should reject: ${why}`);
  }
});

Deno.test('contract: the code and the schema agree on the reason and status vocabularies', async () => {
  const schema = await contractJson<any>('entitlement.v1.schema.json');
  assertEquals([...REASONS].sort(), [...schema.properties.reason.enum].sort());
  const statuses = schema.properties.subscription.oneOf[1].properties.status.enum;
  assertEquals([...SUBSCRIPTION_STATUSES].sort(), [...statuses].sort());
});

Deno.test('contract: the error envelope codes are exactly the eight in C4', async () => {
  assertEquals([...ERROR_CODES].sort(), [
    'already_subscribed', 'bad_signature', 'internal', 'method_not_allowed',
    'no_customer', 'not_configured', 'stripe_error', 'unauthorized'
  ]);
  const envelope = await contractJson<Record<string, string>>('fixtures/error.unauthorized.json');
  assertEquals(Object.keys(envelope).sort(), ['error', 'message']);
  assert(ERROR_CODES.includes(envelope.error as never));
});
