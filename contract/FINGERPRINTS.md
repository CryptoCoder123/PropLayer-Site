# Contract PL-ACCOUNT-1 — canonical fingerprints

These files are **shared, byte-identical in meaning** with the PropLayer desktop repository.
Both repositories keep the same copies and test against the table below.

Each fingerprint is

```
sha256( JSON.stringify( JSON.parse( fileText ) ) )
```

computed over UTF-8 bytes with the platform default `JSON.stringify` (no spacing),
so the hash depends on the JSON **content and key order**, not on indentation or line endings.

A mismatch means the two repositories no longer share the same contract. Do not "fix" the
table to match the code — change the contract in both guides and both `contract/` folders in
the same release, then update this table in both repositories.

| File | Canonical SHA-256 |
|---|---|
| `contract/entitlement.v1.schema.json` | `bab60e69041ce0ab176b442b34a4e0905f636015f88c5da5e80c3acdedf7fd95` |
| `contract/fixtures/entitlement.active.json` | `c9dce7b73a2ed741251906f7e1601996f78433efdf5285d77316523a4d4a968e` |
| `contract/fixtures/entitlement.canceled_pending.json` | `f66b3082d1b11e126eafcc49b87ab5186c855114be40684aa8b87fdcfa1e30c3` |
| `contract/fixtures/entitlement.expired.json` | `ad9f621c3a92526ddd46d56b4523318fca6fd380c8dd42dec7f6da0a3f0d1ffa` |
| `contract/fixtures/entitlement.no_subscription.json` | `4f0d13e98e8d3414a99dcfae84297011ae9a12417410f6e1d6ef024a9708e571` |
| `contract/fixtures/entitlement.past_due_grace.json` | `7fb8538b8b9a3968cc743e3d115e406438b5b19eaf1efc4dda86ffe57a3b55ec` |
| `contract/fixtures/error.unauthorized.json` | `254d62981e0310600d51edefae825611918e98789e6dc2b6c8953b3d91681fe3` |

## How it is tested

| Suite | Command | What it proves |
|---|---|---|
| Deno (backend) | `npm run test:functions` | Every file above matches its fingerprint; every fixture validates against the schema; the entitlement builder's output deep-equals each fixture for the equivalent state |
| Node (site) | `npm run test:contract` | The same fingerprint and schema checks without a Deno toolchain |
