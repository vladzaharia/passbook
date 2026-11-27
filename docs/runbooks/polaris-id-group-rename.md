---
tags: runbook, polaris-id, auth, production
confirm: true
---
# Polaris ID Group Rename

Owner only. Agents never deploy or use `--remote` (AGENTS.md).

Optional. Set up works with the current names: the binding's `GROUPS` lists each role's names (`wallet_admins` and `passbook_platform_admins`, `wallet_users` and `passbook_users`, console `passbook_console`) and the registry accepts aliases, so a rename is only for tidiness. Do it if you want one name per role.

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

## 4. Re-place a renamed protected group

Only if Set up already recorded a protected group under its old name. The binding keeps its D1 record and refuses writes on a name mismatch (`group_name_mismatch`). Mark the record gone so Set up can place the new name, then Preview and Apply again. Run it against the binding's D1, and look first:

```sh name=list-protected-records confirm=no
npx wrangler d1 execute passbook-id-connector --config workers/passbook-id-connector/wrangler.jsonc --remote --command "SELECT key, name, state FROM idp_groups WHERE kind = 'role'"
```

Set `RECORD_KEY` to the `key` of the renamed group's row: `<role>:<old name>`, for example `users:wallet_users`.

```sh name=set-record-key confirm=no
export RECORD_KEY="${RECORD_KEY:-}"
```

```sh name=mark-record-gone confirm="Mark the idp_groups record named by RECORD_KEY as gone in the passbook-id-connector D1, so Set up places the new name?"
: "${RECORD_KEY:?set RECORD_KEY first}" && npx wrangler d1 execute passbook-id-connector --config workers/passbook-id-connector/wrangler.jsonc --remote --command "UPDATE idp_groups SET state = 'gone' WHERE kind = 'role' AND key = '$RECORD_KEY'"
```

## Verify

Settings, Polaris ID in the admin console shows the group lists. Sign in as a member of each group.
