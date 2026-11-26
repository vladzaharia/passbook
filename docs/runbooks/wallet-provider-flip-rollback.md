---
tags: runbook, wallet, rollback, production
confirm: true
---
# Wallet Provider Flip Rollback

Owner only. Rolls a provider and mode back to `draining` and later to `dark`. Part of [[Wallet Provider Flip]]. Nothing here changes state: the draining and dark changes are PRs (one `RELEASE` cell plus one migration statement each), deployed by CI.

## 1. Read the open copies

Open <https://passbook.mobile/admin/platform/wallet-accounts>, pick the Google or Samsung tab and read the Wallet copies row of the mode. Copies already in wallets keep getting voids and removals while draining; badges and offers go away. Open must reach 0 before the dark PR merges. The card shows the mode as Draining once the draining deploy has run.

## 2. Wait for the deploy

Finds the deploy run of the draining or dark commit. It must end successful before you read the card again.

```sh name=deploy-runs confirm=no
gh run list --workflow deploy.yml --branch main --limit 3
```
