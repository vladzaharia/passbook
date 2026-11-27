---
tags: runbook, apple, identity, retire, production
confirm: true
profile: passbook-owner
env:
  D1_NAME: passbook-platform
---
# Platform Identity Retire

Owner only. Agents never deploy or use `--remote` (AGENTS.md).

Step 9 of [[Platform Identity Switch]]. Removes the legacy `pass.im.plrs.wallet` signing secrets and APNs mTLS binding. After this, a sign on that row refuses `IDENTITY_RETIRED`, and passes still on it stop updating. Restoring means `secret put` from `.secrets/`, which only works before the certificate expires (2027-11-30).

## Prerequisites

- The switch is done and `pass.mobile.passbook` is default.
- Profile `passbook-owner` defines `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
- The legacy row is dormant (console Platform card) or expired.

## 1. Confirm nothing uses it

Both counts must be 0, or accepted as lost. The Move passes operation in the switch note step 8 clears them.

```sh name=active-passes confirm=no
npx wrangler d1 execute "$D1_NAME" --remote --command "SELECT COUNT(*) AS active_passes FROM passes p JOIN signing_identities s ON s.id = p.identity_id WHERE s.pass_type_identifier = 'pass.im.plrs.wallet' AND p.status = 'active'"
```

```sh name=registrations confirm=no
npx wrangler d1 execute "$D1_NAME" --remote --command "SELECT COUNT(*) AS registrations FROM registrations r JOIN signing_identities s ON s.id = r.identity_id WHERE s.pass_type_identifier = 'pass.im.plrs.wallet'"
```

## 2. Delete the signer secrets

Each delete deploys at once.

```sh name=delete-certificate confirm="Delete SIGNER_PLATFORM_CERTIFICATE from the production Worker?"
npx wrangler secret delete SIGNER_PLATFORM_CERTIFICATE
```

```sh name=delete-key confirm="Delete SIGNER_PLATFORM_PRIVATE_KEY from the production Worker?"
npx wrangler secret delete SIGNER_PLATFORM_PRIVATE_KEY
```

## 3. Drop the APNs binding

Remove the `APNS` entry from `mtls_certificates` in `wrangler.jsonc`, commit, then [[Deploy]]. Keep `PLATFORM_PASS_TYPE_ID` and `PLATFORM_TEAM_ID`.

```sh name=find-binding confirm=no
grep -n -B1 -A3 '"APNS"' wrangler.jsonc
```
