---
tags: runbook, polaris-id, auth, production
confirm: true
---
# Polaris ID Group Rename

Owner only. Agents never deploy or use `--remote` (AGENTS.md).

Use to rename the Polaris ID groups `wallet_admins` to `passbook_platform_admins`, `wallet_org_admins` to `passbook_console`, and `wallet_users` to `passbook_users`. Each `OIDC_*_GROUP` var takes a comma list of exact names, and every name in a var grants that var's role only, so the rename is three steps across two deploys. Ids and members stay when a group is renamed.

## Prerequisites

- Polaris ID admin access.
- A clean checkout on `main`.

## 1. Deploy with both names

Edit `wrangler.jsonc` (`wrangler.jsonc` already ships this):

- `OIDC_PLATFORM_ADMIN_GROUP`: `wallet_admins,passbook_platform_admins`
- `OIDC_ADMIN_GROUP`: `wallet_org_admins,passbook_console`
- `OIDC_USER_GROUP`: `wallet_users,passbook_users`

Commit, then [[Deploy]] (or let CI do it).

## 2. Rename in Polaris ID

Rename the three groups in Polaris ID and keep the PassBook client's allowed groups in step.

## 3. Deploy the new names only

Drop the old names from the three vars in `wrangler.jsonc`, commit, then [[Deploy]]. A near miss (a claim that differs from a configured name only by case or punctuation) grants nothing and logs `auth.oidc_group_near_miss`.

## Verify

Settings, Polaris ID in the admin console shows the group lists. Sign in as a member of each group.
