---
tags: runbook, apple, identity, switch, production
confirm: true
profile: passbook-owner
env:
  D1_NAME: wallet-platform
---
# Platform Identity Switch

Owner only. Agents never deploy or use `--remote` (AGENTS.md).

Moves new passes from the legacy identity `pass.im.plrs.wallet` to the connector-managed `pass.mobile.passbook`. Installed passes cannot move by update: the legacy row keeps signing and pushing for them until it retires. Steps 1 to 9 of the design's switch order; O1 to O7 are the owner steps inside it. Console steps are in Wallet accounts, Apple, Platform, and each write asks for step-up.

## Prerequisites

- PI-1 to PI-4 and PI-7 are merged and CI has deployed the main Worker. Without PI-4 the Platform section has no Set up and Make default actions.
- Profile `passbook-owner` defines `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. The connector's ASC key lives in the connector Worker's secrets, never here.
- You sign in to the console as a platform admin.
- `PLATFORM_PASS_TYPE_ID` stays `pass.im.plrs.wallet` and `PLATFORM_TEAM_ID` does not change. `npm run deploy:check` fails otherwise.

```sh name=deploy-check confirm=no
npm run deploy:check
```

## 1. Read prod (O1)

Read only. Expect row `platform` (`pass.im.plrs.wallet`, `source=env`) as the only default.

```sh name=o1-identities confirm=no
npx wrangler d1 execute "$D1_NAME" --remote --command "SELECT id, org_id, pass_type_identifier, source, is_default, issuing, not_after FROM signing_identities"
```

Henry's passes should sit on `platform`:

```sh name=o1-passes confirm=no
npx wrangler d1 execute "$D1_NAME" --remote --command "SELECT identity_id, org_id, status, COUNT(*) AS passes FROM passes GROUP BY identity_id, org_id, status"
```

```sh name=o1-registrations confirm=no
npx wrangler d1 execute "$D1_NAME" --remote --command "SELECT identity_id, COUNT(*) AS registrations FROM registrations GROUP BY identity_id"
```

Step 3 needs a team push key. Zero rows means O2 is required.

```sh name=o1-apns-keys confirm=no
npx wrangler d1 execute "$D1_NAME" --remote --command "SELECT team_identifier, key_id FROM apns_keys"
```

```sh name=o1-defaults confirm=no
npx wrangler d1 execute "$D1_NAME" --remote --command "SELECT id, slug, default_identity_id FROM orgs WHERE default_identity_id IS NOT NULL"
```

Migration 0234 must have held `devtest` for the platform (`org_id` empty):

```sh name=o1-devtest confirm=no
npx wrangler d1 execute "$D1_NAME" --remote --command "SELECT * FROM identity_handles WHERE handle = 'devtest'"
```

## 2. Deploy the connector (O3)

The connector is not in CI. The policy must allow `pass.mobile.passbook` before step 4. Its ASC secrets rotate with [[Apple Provisioner Key Rotation]]; do not change them here.

```sh name=deploy-connector confirm="Deploy the apple-provisioner Worker to production?"
npx wrangler deploy --config workers/apple-provisioner/wrangler.jsonc
```

## 3. Team push key (O2)

Skip when `o1-apns-keys` returned a row. The new identity pushes with the team `.p8` key; the ASC API has no endpoint for it.

1. Developer portal, Keys: create a key with Apple Push Notifications, scoped to the team. The `.p8` downloads once.
2. Console, Wallet accounts, Apple, any identity on the team, Push key card: upload it. API: `PUT /api/v1/identities/{id}/push-key` (admin session, step-up).

Check:

```sh name=o2-check confirm=no
npx wrangler d1 execute "$D1_NAME" --remote --command "SELECT team_identifier, key_id FROM apns_keys"
```

## 4. Set up `pass.mobile.passbook` (O4)

Console, Platform, Set up on the `pass.mobile.passbook` card. The connector creates the Pass Type ID, orders the certificate, activates it and probes APNs. The identity ends issuing but not default.

If Apple refuses because the identifier exists, register it in the developer portal (Identifiers, Pass Type IDs) and run Set up again; the run adopts it.

```sh name=o4-check confirm=no
npx wrangler d1 execute "$D1_NAME" --remote --command "SELECT id, pass_type_identifier, source, is_default, issuing, apns_health, not_after FROM signing_identities WHERE pass_type_identifier = 'pass.mobile.passbook'"
```

```text
Expect source=db, is_default=0, issuing=1, apns_health=healthy.
```

## 5. Device test (O5)

On your iPhone:

1. In your personal org, issue a pass with `identityId` set to the new row.
2. Add it to Wallet.
3. Change a field. The update must arrive by push.

Make default refuses with `IDENTITY_NOT_READY` until a device is registered on a pass this identity signed.

```sh name=o5-registrations confirm=no
npx wrangler d1 execute "$D1_NAME" --remote --command "SELECT r.identity_id, COUNT(*) AS registrations FROM registrations r JOIN signing_identities s ON s.id = r.identity_id WHERE s.pass_type_identifier = 'pass.mobile.passbook' GROUP BY r.identity_id"
```

## 6. Make default

Console, Platform, Make default on `pass.mobile.passbook` (API: `POST /api/v1/platform/apple/identities/{id}/default`). One batch: it becomes default and row `platform` gets `issuing=0`. New passes now sign on it. Repeating is safe.

```sh name=switch-check confirm=no
npx wrangler d1 execute "$D1_NAME" --remote --command "SELECT pass_type_identifier, is_default, issuing FROM signing_identities WHERE org_id IS NULL"
```

Undo: [[Platform Identity Switch Rollback]].

## 7. Set up `devtest`

Console, Platform, Set up device test (`pass.mobile.passbook.devtest`). It is never default and orgs cannot sign on it. Turn on `DEVICE_PASS_ENABLED` only after the Workbench device-pass review passes.

## 8. Henry's passes

Default: do nothing. They keep updating on the legacy row until 2027-11-30. To move them before then, run Move passes on the org page (dry run first). Each holder gets a replacement pass by email; the old one voids 24 hours after the new one registers. Cancelling keeps replacements already issued.

## 9. Retire the legacy identity (O7)

Only when row `platform` is dormant or expired and no pass is registered on it: [[Platform Identity Retire]].

## Not part of this procedure (O6)

Revoking the connector's ASC key, creating a new ASC key, or revoking a platform certificate for compromise stay manual. Do them in App Store Connect or the developer portal, never through this note.

## Links

- Undo the default: [[Platform Identity Switch Rollback]]
- Renew the legacy certificate once, if passes still need updates near expiry: [[Platform Certificate Renewal]]
