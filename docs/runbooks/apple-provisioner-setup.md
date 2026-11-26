---
tags: runbook, apple, provisioner, production
confirm: true
profile: passbook-apple-provisioner
---
# Apple Provisioner Setup

Owner only. Agents never deploy or use `--remote` (AGENTS.md).

One-time setup of `workers/apple-provisioner`, the separate Worker that holds the App Store Connect key. The main Worker reaches it only through the `APPLE` service binding; it has no route and no `workers.dev` host. Limits, the revoke rules and the trust boundary are in [docs/operations.md](../operations.md#apple-provisioner). Until it is deployed, `ascClient` reports `ASC_UNAVAILABLE`.

Never give CI a Cloudflare token that can deploy `apple-provisioner`.

## Prerequisites

- In App Store Connect, create a Team key with the Admin role named `passbook-provisioner`. The `.p8` downloads once.
- Profile `passbook-apple-provisioner` defines `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `ASC_KEY_ID` and `ASC_ISSUER_ID` (both from the key page).
- The `.p8` file stays outside the repo.

## Parameters

```sh name=set-params confirm=no
export ASC_KEY_FILE="${ASC_KEY_FILE:-}"
```

## 1. Create the database

Put the printed id in `workers/apple-provisioner/wrangler.jsonc`.

```sh name=d1-create confirm="Create the apple-provisioner D1 database in the production account?"
npx wrangler d1 create apple-provisioner
```

## 2. Apply its migrations

```sh name=d1-migrate confirm="Apply migrations to the apple-provisioner D1 database?"
npx wrangler d1 migrations apply apple-provisioner --config workers/apple-provisioner/wrangler.jsonc --remote
```

## 3. Set the secrets

The key and ids come from the file and the profile through stdin.

```sh name=put-key-p8 confirm="Set ASC_KEY_P8 on the apple-provisioner Worker?"
: "${ASC_KEY_FILE:?run the params block and set ASC_KEY_FILE}" && npx wrangler secret put ASC_KEY_P8 --config workers/apple-provisioner/wrangler.jsonc < "$ASC_KEY_FILE"
```

```sh name=put-key-id confirm="Set ASC_KEY_ID on the apple-provisioner Worker?"
: "${ASC_KEY_ID:?add it to the profile}" && printf %s "$ASC_KEY_ID" | npx wrangler secret put ASC_KEY_ID --config workers/apple-provisioner/wrangler.jsonc
```

```sh name=put-issuer-id confirm="Set ASC_ISSUER_ID on the apple-provisioner Worker?"
: "${ASC_ISSUER_ID:?add it to the profile}" && printf %s "$ASC_ISSUER_ID" | npx wrangler secret put ASC_ISSUER_ID --config workers/apple-provisioner/wrangler.jsonc
```

## 4. Deploy the provisioner first

Cloudflare fails a main Worker deploy if the `APPLE` service binding names a Worker that does not exist yet.

```sh name=deploy-provisioner confirm="Deploy the apple-provisioner Worker to production?"
npx wrangler deploy --config workers/apple-provisioner/wrangler.jsonc
```

Then deploy the main Worker: [[Deploy]] (with `--first` if the deploy tool asks: [[Deploy First]]).

## 5. Seed the allowlist

Seeds the platform pass type. Without `--apply` the tool prints the command. The first `findPassType('pass.im.plrs.wallet')` call fills in Apple's id.

```sh name=seed-plan confirm=no
node tools/apple-provisioner-seed.ts
```

```sh name=seed-apply confirm="Seed the apple-provisioner allowlist in the production database?"
node tools/apple-provisioner-seed.ts --apply --remote
```

## Platform certificates are manual

The provisioner never orders or revokes for `pass.im.plrs.wallet`, `pass.mobile.passbook.wallet` or any identifier outside `pass.mobile.passbook.<handle>`. Order and renew those yourself in the developer portal (or Xcode) and upload the result as `SIGNER_PLATFORM_*`: [[Platform Certificate Renewal]].

Rotate the key: [[Apple Provisioner Key Rotation]].
