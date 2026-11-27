---
tags: runbook, apple, identity, switch, production
confirm: true
profile: passbook-owner
env:
  D1_NAME: passbook-platform
  BASE_URL: https://passbook.mobile
---
# Platform Identity Switch

Owner only. Agents never deploy or use `--remote` (AGENTS.md).

Moves new passes from the legacy identity `pass.im.plrs.wallet` to the connector-managed `pass.mobile.passbook`. Installed passes cannot move by update: the legacy row keeps signing and pushing for them until it retires. Steps 1 to 9 of the design's switch order; O1 to O7 are the owner steps inside it. Console actions run through the platform API routes below; each write asks for step-up.

## Prerequisites

- PI-1 to PI-4 and PI-7 are merged and CI has deployed the main Worker. Without PI-4 the platform routes below answer 404.
- Profile `passbook-owner` defines `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. The connector's ASC key lives in the connector Worker's secrets, never here.
- You sign in to the console as a platform admin. Profile `passbook-owner` also defines `PASSBOOK_SESSION` (the `__Host-wallet_sid` cookie value) and `PASSBOOK_CSRF` (the `x-csrf-token` value of that session), copied from the signed-in browser. Every write needs a sign-in less than 10 minutes old: sign in again just before each step that writes, and refresh the profile. No API key reaches these routes.
- `jq` and `curl` are installed.
- `PLATFORM_PASS_TYPE_ID` stays `pass.im.plrs.wallet` and `PLATFORM_TEAM_ID` does not change. `npm run deploy:check` fails otherwise.

```sh name=deploy-check confirm=no
npm run deploy:check
```

## API access

Defines `api`, which sends the session cookie and CSRF token from the profile to the console API. Secrets go in on stdin, not on the command line. Writes add `-X POST` and an `idempotency-key`; the same key replays the same answer.

```sh name=api-helper confirm=no
api() { curl -fsS -K - "$@" <<CFG
header = "cookie: __Host-wallet_sid=$PASSBOOK_SESSION"
header = "x-csrf-token: $PASSBOOK_CSRF"
header = "origin: $BASE_URL"
CFG
} && : "${PASSBOOK_SESSION:?profile passbook-owner needs PASSBOOK_SESSION}" && : "${PASSBOOK_CSRF:?profile passbook-owner needs PASSBOOK_CSRF}" && api "$BASE_URL/api/v1/platform/apple/identities" | jq '[.items[] | {id, slot, managed, isDefault, issuing, registrationCount}]'
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

```sh name=deploy-connector confirm="Deploy the passbook-apple-connector Worker to production?"
npx wrangler deploy --config workers/passbook-apple-connector/wrangler.jsonc
```

## 3. Team push key (O2)

Skip when `o1-apns-keys` returned a row. The new identity pushes with the team `.p8` key; the ASC API has no endpoint for it.

1. Developer portal, Keys: create a key with Apple Push Notifications, scoped to the team. The `.p8` downloads once.
2. Set the key id and the file path, then upload it to any identity on the team (`PUT /api/v1/identities/{id}/push-key`, step-up).

```sh name=push-key-params confirm=no
export PUSH_KEY_ID="${PUSH_KEY_ID:-}"
export PUSH_KEY_FILE="${PUSH_KEY_FILE:-}"
export TEAM_IDENTITY_ID="${TEAM_IDENTITY_ID:-platform}"
```

```sh name=push-key-upload confirm="Upload the APNs push key to the production team?"
: "${PUSH_KEY_ID:?run push-key-params first}" && : "${PUSH_KEY_FILE:?run push-key-params first}" &&
jq -n --arg keyId "$PUSH_KEY_ID" --rawfile p8 "$PUSH_KEY_FILE" '{keyId: $keyId, p8: $p8}' |
api -X PUT -H "content-type: application/json" --data-binary @- "$BASE_URL/api/v1/identities/$TEAM_IDENTITY_ID/push-key" | jq '{id, pushMethod}'
```

Check:

```sh name=o2-check confirm=no
npx wrangler d1 execute "$D1_NAME" --remote --command "SELECT team_identifier, key_id FROM apns_keys"
```

## 4. Set up `pass.mobile.passbook` (O4)

`POST /api/v1/platform/apple/identities` with slot `root` starts the setup run (202). The connector creates the Pass Type ID, orders the certificate, activates it and probes APNs. The identity ends issuing but not default. 409 `IDENTITY_ALREADY_PROVISIONED` means the slot already has a certificate.

```sh name=setup-root confirm="Start the production setup run for pass.mobile.passbook?"
api -X POST -H "content-type: application/json" -H "idempotency-key: setup-root-$(date +%Y%m%d)" --data '{"slot":"root"}' "$BASE_URL/api/v1/platform/apple/identities" | jq '{id, kind, state, targetId}'
```

The run finishes in a few minutes. Wait for a terminal state:

```sh name=setup-root-wait confirm=no
for i in $(seq 40); do api "$BASE_URL/api/v1/identity-runs?targetId=platform:root" | jq -e '.items[0].state | IN("succeeded","failed","cancelled")' >/dev/null && break; sleep 15; done; api "$BASE_URL/api/v1/identity-runs?targetId=platform:root" | jq '.items[0] | {state, errorCode}'
```

If Apple refuses because the identifier exists, register it in the developer portal (Identifiers, Pass Type IDs) and run `setup-root` again with a new key; the run adopts it.

```sh name=o4-check confirm=no
api "$BASE_URL/api/v1/platform/apple/identities" | jq '.items[] | select(.slot == "root") | {id, isDefault, issuing, registrationCount}'
```

Expect `isDefault` false and `issuing` true.

```text
{ "id": "...", "isDefault": false, "issuing": true, "registrationCount": 0 }
```

```sh name=export-root-id confirm=no
export ROOT_ID="$(api "$BASE_URL/api/v1/platform/apple/identities" | jq -r '.items[] | select(.slot == "root") | .id')" && echo "$ROOT_ID"
```

## 5. Device test (O5)

On your iPhone:

1. In your personal org, issue a pass with `identityId` set to the new row. Add it to Wallet.
2. Change a field. The update must arrive by push.
3. Check that the old pass's void arms. The move assumes Wallet sends the same device id for a pass of each pass type, and Apple does not document it. Keep one pass on the legacy identity in your personal org, move that org with the steps in section 8 (`ORG_ID` set to the personal org), add the replacement on the same iPhone, then list the move rows. Expect `state` `registered` and a `voidAt` a day ahead within a minute. `state` `notified` with `reason` `unarmed` after 7 days means the ids differ: run `arm-now` on that row after confirming the same phone holds both.

Make default refuses with `IDENTITY_NOT_READY` until a device is registered on a pass this identity signed.

```sh name=o5-registrations confirm=no
api "$BASE_URL/api/v1/platform/apple/identities" | jq '.items[] | select(.slot == "root") | {id, registrationCount}'
```

```sh name=o5-move-rows confirm=no
api "$BASE_URL/api/v1/platform/apple/identity-moves?orgId=${ORG_ID:?set ORG_ID in section 8}&limit=5" | jq '.items[] | {id, state, reason, voidAt}'
```

One row to arm by hand, only after the same phone holds both passes. `POST /api/v1/platform/apple/identity-moves/{moveId}/arm` starts that row's 24 hours now. 409 `IDENTITY_MOVE_CONFLICT` means the replacement is not registered or the move is not waiting.

```sh name=arm-now-params confirm=no
export MOVE_ID="${MOVE_ID:-}"
```

```sh name=arm-now confirm="Start this move row's 24 hours now?"
: "${MOVE_ID:?set MOVE_ID to a row from o5-move-rows}" &&
api -X POST -H "idempotency-key: arm-$MOVE_ID" "$BASE_URL/api/v1/platform/apple/identity-moves/$MOVE_ID/arm" | jq .
```

## 6. Make default

`POST /api/v1/platform/apple/identities/{id}/default`. One batch: it becomes default and row `platform` gets `issuing=0`. New passes now sign on it. Repeating is safe.

```sh name=make-default confirm="Make pass.mobile.passbook the production default identity?"
: "${ROOT_ID:?run export-root-id first}" &&
api -X POST -H "idempotency-key: default-$ROOT_ID" "$BASE_URL/api/v1/platform/apple/identities/$ROOT_ID/default" | jq .
```

```sh name=switch-check confirm=no
npx wrangler d1 execute "$D1_NAME" --remote --command "SELECT pass_type_identifier, is_default, issuing FROM signing_identities WHERE org_id IS NULL"
```

Undo: [[Platform Identity Switch Rollback]].

## 7. Set up `devtest`

`POST /api/v1/platform/apple/identities` with slot `devtest` (`pass.mobile.passbook.devtest`). It is never default and orgs cannot sign on it. Turn on `DEVICE_PASS_ENABLED` only after the Workbench device-pass review passes.

```sh name=setup-devtest confirm="Start the production setup run for the device-test identity?"
api -X POST -H "content-type: application/json" -H "idempotency-key: setup-devtest-$(date +%Y%m%d)" --data '{"slot":"devtest"}' "$BASE_URL/api/v1/platform/apple/identities" | jq '{id, kind, state, targetId}'
```

## 8. Henry's passes

Default: do nothing. They keep updating on the legacy row until 2027-11-30. To move them before then, run the steps below (the same ones move your personal org in step 5). Each holder gets a replacement pass by email; the old one voids 24 hours after the new one registers on a device that holds the old pass. Cancelling keeps replacements already issued. Only a platform admin session starts, retries or cancels the operation; no token does.

`ORG_ID` is the org to move. `o1-passes` lists the orgs with passes on the legacy row. `FROM_ID` is the identity the passes leave (`platform` for the legacy row). Leave `TO_ID` empty for the org's issuing identity.

```sh name=move-params confirm=no
export ORG_ID="${ORG_ID:-}"
export FROM_ID="${FROM_ID:-platform}"
export TO_ID="${TO_ID:-}"
```

Dry run. Nothing is written. `kept` counts the passes that stay on the old identity, by reason: `connection`, `user_tag`, `transfer`. A Google or Samsung copy does not keep a pass: the replacement is offered a new one, and the old pass is voided with its copies. A saved copy the replacement lacks makes the move wait (`registered`, reason `wallet_copy:google`, `wallet_copy:samsung` or `wallet_copy:google+samsung`); the void runs 24 hours after the new copy is saved, and a holder with no Apple registration is armed by the new copy's save. At 30 days the holder is asked once to save the new copy and the move keeps waiting; a save at any time after that starts the 24 hours. It ends `kept_both`, both passes live, only if the old identity retires while it waits.

```sh name=move-preview confirm=no
api -G "$BASE_URL/api/v1/platform/apple/identity-moves/preview" --data-urlencode "orgId=${ORG_ID:?run move-params first}" --data-urlencode "fromIdentityId=$FROM_ID" ${TO_ID:+--data-urlencode "toIdentityId=$TO_ID"} | jq .
```

```text
{ "toIdentityId": "...", "passes": 120, "registered": 96, "holders": 118, "kept": { "connection": 2 } }
```

Start. Answers 202 with the operation. A repeat of the same start (same key) answers the same operation.

```sh name=move-start confirm="Issue replacement passes for this org and email its holders?"
: "${ORG_ID:?run move-params first}" &&
export MOVE_KEY="move-$ORG_ID-$(date +%Y%m%d)" &&
MOVE_RES="$(jq -n --arg orgId "$ORG_ID" --arg from "$FROM_ID" --arg to "$TO_ID" '{orgId: $orgId, fromIdentityId: $from} + (if $to == "" then {} else {toIdentityId: $to} end)' |
  api -X POST -H "content-type: application/json" -H "idempotency-key: $MOVE_KEY" --data-binary @- "$BASE_URL/api/v1/platform/apple/identity-moves")" &&
export MOVE_OP="$(printf '%s' "$MOVE_RES" | jq -r '.id')" &&
printf '%s' "$MOVE_RES" | jq '{id, status, kind}'
```

The operation issues and emails the replacements, then ends. The old passes void later, one at a time.

```sh name=move-progress confirm=no
api "$BASE_URL/api/v1/operations/${MOVE_OP:?run move-start first}" | jq '{status, step, text}'
```

Rows that need a look: `kept_both` (both passes stay live because a connection or user tag appeared, or a device holds a Google or Samsung copy the replacement lacks when the old identity retires) and `unarmed` (registered for 7 days without arming).

```sh name=move-rows-kept-both confirm=no
api "$BASE_URL/api/v1/platform/apple/identity-moves?operationId=${MOVE_OP:?run move-start first}&state=kept_both" | jq '.items[] | {id, oldPassId, reason}'
```

```sh name=move-rows-unarmed confirm=no
api "$BASE_URL/api/v1/platform/apple/identity-moves?operationId=${MOVE_OP:?run move-start first}&reason=unarmed" | jq '.items[] | {id, oldPassId, state}'
```

Arm a row with `arm-now` in section 5.

## 9. Retire the legacy identity (O7)

Only when row `platform` is dormant or expired and no pass is registered on it: [[Platform Identity Retire]].

## Not part of this procedure (O6)

Revoking the connector's ASC key, creating a new ASC key, or revoking a platform certificate for compromise stay manual. Do them in App Store Connect or the developer portal, never through this note.

## Links

- Undo the default: [[Platform Identity Switch Rollback]]
- Renew the legacy certificate once, if passes still need updates near expiry: [[Platform Certificate Renewal]]
