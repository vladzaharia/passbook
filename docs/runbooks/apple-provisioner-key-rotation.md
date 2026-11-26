---
tags: runbook, apple, provisioner, key-rotation, production
confirm: true
profile: passbook-apple-provisioner
---
# Apple Provisioner Key Rotation

Owner only. Agents never deploy or use `--remote` (AGENTS.md).

Use to replace the App Store Connect key the provisioner holds, on a schedule or after exposure. Create the new key, set the three secrets, then revoke the old key. If the key is compromised, revoke it in App Store Connect first; losing it stops automated renewal only, and manual certificate upload still works. Calls are in the `apple-provisioner` D1 table `asc_calls`.

## Prerequisites

- In App Store Connect, create a new Team key with the Admin role. The `.p8` downloads once.
- Profile `passbook-apple-provisioner` defines `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `ASC_KEY_ID` and `ASC_ISSUER_ID` for the new key.

## Parameters

```sh name=set-params confirm=no
export ASC_KEY_FILE="${ASC_KEY_FILE:-}"
```

## 1. Set the new secrets

```sh name=put-key-p8 confirm="Replace ASC_KEY_P8 on the apple-provisioner Worker?"
: "${ASC_KEY_FILE:?run the params block and set ASC_KEY_FILE}" && npx wrangler secret put ASC_KEY_P8 --config workers/apple-provisioner/wrangler.jsonc < "$ASC_KEY_FILE"
```

```sh name=put-key-id confirm="Replace ASC_KEY_ID on the apple-provisioner Worker?"
: "${ASC_KEY_ID:?add it to the profile}" && printf %s "$ASC_KEY_ID" | npx wrangler secret put ASC_KEY_ID --config workers/apple-provisioner/wrangler.jsonc
```

```sh name=put-issuer-id confirm="Replace ASC_ISSUER_ID on the apple-provisioner Worker?"
: "${ASC_ISSUER_ID:?add it to the profile}" && printf %s "$ASC_ISSUER_ID" | npx wrangler secret put ASC_ISSUER_ID --config workers/apple-provisioner/wrangler.jsonc
```

## 2. Check it works

Look at the newest ledger rows for a successful call (read only).

```sh name=check-ledger confirm=no
npx wrangler d1 execute apple-provisioner --config workers/apple-provisioner/wrangler.jsonc --remote --command "SELECT * FROM asc_calls ORDER BY rowid DESC LIMIT 5"
```

## 3. Revoke the old key

In App Store Connect (Users and Access, Integrations) revoke the old key.
