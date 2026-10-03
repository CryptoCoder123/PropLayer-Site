// Contract PL-ACCOUNT-1 checks that need no browser and no Deno toolchain.
// Proves: every contract/ file matches its canonical fingerprint (contract C5),
// and every fixture validates against entitlement.v1.schema.json.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Ajv = require('ajv/dist/2020');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

// Parsed out of contract/FINGERPRINTS.md so the table and the test can never drift apart.
function canonicalFingerprints() {
  const table = new Map();
  for (const line of read('contract/FINGERPRINTS.md').split(/\r?\n/)) {
    const row = line.match(/^\|\s*`(contract\/[^`]+)`\s*\|\s*`([0-9a-f]{64})`\s*\|$/);
    if (row) table.set(row[1], row[2]);
  }
  return table;
}

function fingerprint(file) {
  return crypto.createHash('sha256').update(JSON.stringify(JSON.parse(read(file))), 'utf8').digest('hex');
}

const checks = [];
function check(name, fn) { fn(); checks.push(name); console.log('PASS', name); }

const expected = canonicalFingerprints();

check('FINGERPRINTS.md lists all seven contract files', () => {
  assert.deepEqual([...expected.keys()].sort(), [
    'contract/entitlement.v1.schema.json',
    'contract/fixtures/entitlement.active.json',
    'contract/fixtures/entitlement.canceled_pending.json',
    'contract/fixtures/entitlement.expired.json',
    'contract/fixtures/entitlement.no_subscription.json',
    'contract/fixtures/entitlement.past_due_grace.json',
    'contract/fixtures/error.unauthorized.json'
  ]);
});

check('Every contract file matches its canonical fingerprint (contract C5)', () => {
  for (const [file, hash] of expected) {
    assert.equal(fingerprint(file), hash, `${file} no longer matches the shared contract`);
  }
});

check('No contract file on disk is missing from the fingerprint table', () => {
  const onDisk = ['contract/entitlement.v1.schema.json',
    ...fs.readdirSync(path.join(root, 'contract/fixtures')).sort().map(f => 'contract/fixtures/' + f)];
  assert.deepEqual(onDisk.filter(f => f.endsWith('.json')).sort(), [...expected.keys()].sort());
});

const ajv = new Ajv({ strict: true, allErrors: true });
const schema = JSON.parse(read('contract/entitlement.v1.schema.json'));
const validate = ajv.compile(schema);

check('Every entitlement fixture validates against the schema', () => {
  for (const name of ['active', 'canceled_pending', 'past_due_grace', 'expired', 'no_subscription']) {
    const fixture = JSON.parse(read(`contract/fixtures/entitlement.${name}.json`));
    assert.ok(validate(fixture), `${name}: ${ajv.errorsText(validate.errors)}`);
  }
});

check('The schema rejects objects that break the entitled/reason invariants', () => {
  const base = JSON.parse(read('contract/fixtures/entitlement.active.json'));
  const bad = [
    ['entitled true with a not-entitled reason', { ...base, reason: 'expired' }],
    ['entitled false with an entitled reason', { ...base, entitled: false }],
    ['no_subscription with a subscription object', { ...base, entitled: false, reason: 'no_subscription' }],
    ['entitled true with a null access_until', { ...base, subscription: { ...base.subscription, access_until: null } }],
    ['unknown reason', { ...base, reason: 'nope' }],
    ['unknown status', { ...base, subscription: { ...base.subscription, status: 'nope' } }],
    ['extra top-level field', { ...base, surprise: 1 }],
    ['schema other than 1', { ...base, schema: 2 }],
    ['recheck below the contract minimum', { ...base, recheck_after_seconds: 299 }],
    ['grace above the contract maximum', { ...base, offline_grace_seconds: 604801 }],
    ['non-UTC timestamp', { ...base, checked_at: '2026-10-03T16:00:00+02:00' }],
    ['http link', { ...base, links: { ...base.links, account: 'http://prop-layer.com/account.html' } }]
  ];
  for (const [why, value] of bad) assert.equal(validate(value), false, `schema should reject: ${why}`);
});

check('The unauthorized fixture is the contract error envelope', () => {
  const envelope = JSON.parse(read('contract/fixtures/error.unauthorized.json'));
  assert.deepEqual(Object.keys(envelope).sort(), ['error', 'message']);
  assert.equal(envelope.error, 'unauthorized');
  assert.equal(typeof envelope.message, 'string');
});

console.log(`${checks.length} contract checks passed.`);
