---
tags: runbook, apple, identity, rollback, production
confirm: true
profile: passbook-owner
env:
  D1_NAME: wallet-platform
---
# Platform Identity Switch Rollback

Owner only. Agents never deploy or use `--remote` (AGENTS.md).

Makes the legacy `pass.im.plrs.wallet` the default again after [[Platform Identity Switch]] step 6. New passes sign on it; passes already issued on `pass.mobile.passbook` keep updating there. It needs the legacy `SIGNER_PLATFORM_*` secrets and the `APNS` binding still in place, so do it before [[Platform Identity Retire]].

## Prerequisites

- Same profile as the switch note.
- The legacy certificate is not expired (valid to 2027-11-30).

```sh name=legacy-state confirm=no
npx wrangler d1 execute "$D1_NAME" --remote --command "SELECT pass_type_identifier, is_default, issuing, not_after FROM signing_identities WHERE org_id IS NULL"
```

## 1. Make the legacy row default

Console, Platform, Make default on the `pass.im.plrs.wallet` card (API: `POST /api/v1/platform/apple/identities/{id}/default`, step-up). It sets `issuing=1` on `platform` again.

## 2. Check

```sh name=rollback-check confirm=no
npx wrangler d1 execute "$D1_NAME" --remote --command "SELECT pass_type_identifier, is_default, issuing FROM signing_identities WHERE org_id IS NULL"
```

```text
Expect pass.im.plrs.wallet with is_default=1 and issuing=1.
```
