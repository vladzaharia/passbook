---
tags: runbook, wallet, rollback, production
confirm: true
profile: passbook-owner
env:
  PASSBOOK_ORIGIN: https://passbook.mobile
---
# Wallet Provider Flip Rollback

Owner only. Rolls a provider and mode back to `draining` and later to `dark`. Part of [[Wallet Provider Flip]].

## 1. Read the open copies

Copies already in wallets keep getting voids and removals while draining; badges and offers go away. `instances.open` must reach 0 before the dark PR merges.

```sh name=read-open-copies confirm=no
: "${PASSBOOK_SESSION_COOKIE:?profile passbook-owner must define it}" &&
curl -fsS -K - "$PASSBOOK_ORIGIN/api/v1/platform/wallet-release" <<EOT
header = "Cookie: $PASSBOOK_SESSION_COOKIE"
EOT
```

The `draining` and `dark` changes are PRs (one `RELEASE` cell plus one migration statement each), deployed by CI. Nothing in this note changes state.
