---
tags: runbook, platform-keys, api, local
confirm: true
env:
  BASE_URL: http://localhost:5173
  KEY_IP: 203.0.113.10
---
# Platform Keys

Use to mint, check, rotate and revoke a Platform key: the credential an operator's automation holds for platform routes (`/api/v1/platform/*`). It never reaches an organization's data. The blocks run against `npm run dev` with the key the demo seed makes; production uses the same calls with a key from the console. Background: [operations](../operations.md) and [security](../security.md).

A Platform key is `kind = platform`, has no organization and starts `pbo_`. It holds `platform:*` scopes only; the other flavour, All organizations, holds organization scopes only and never reaches a platform route. The two are never mixed on one key.

| Scope | Covers by key |
| --- | --- |
| `platform:read` | every `GET` of a key-callable platform route |
| `platform:settings` | read and write platform settings, except sign-in (`auth.*`, `oidc.*`) |
| `platform:wallet` | the wallet release report and the enable-ready dry run |

## Prerequisites

- `npm run dev:vars` and `npm run db:local` ran once ([[Local Dev Setup]]). Run `npm run dev:oidc` and `npm run dev` in their own terminals; the app answers at `BASE_URL`.
- The demo data is seeded (step 1). The seed writes the key to `.wrangler/seed-platform-key.env`, which is untracked. Nothing prints it.
- `npm run breakglass` ran once: the seed reads that local token itself, or `SEED_BREAKGLASS_TOKEN` if set.
- `curl` is installed.
- A caller's address is the `cf-connecting-ip` header, which Cloudflare sets in production. Locally the blocks send `KEY_IP`, inside the seeded key's range `203.0.113.0/24`.

## 1. Make the demo key

Seeds the demo organizations and a Platform key named "Ops status" with `platform:read`, `platform:settings` and `platform:wallet`, 30 days, range `203.0.113.0/24`. It signs in through the mock Polaris ID, so the 10-minute step-up that minting needs is fresh. It prints the file the key is in, never the key. Safe to rerun: an existing key is kept. If the secret file is gone, revoke the key in the console and rerun.

```sh name=seed-key confirm="Seed demo data and the Ops status key into the local dev database?"
node tools/seed-demo.ts --url "$BASE_URL" --state .wrangler/state
```

```text
Platform key "Ops status": PASSBOOK_KEY is in .wrangler/seed-platform-key.env (docs/runbooks/platform-keys.md).
```

Load the key into this shell. It stays out of every command line.

```sh name=load-key confirm=no
set -a && . .wrangler/seed-platform-key.env && set +a && : "${PASSBOOK_KEY:?the seed did not write the key}"
```

In production a platform admin makes the key: Platform > API keys > Create > Platform, signed in with Polaris ID (a break-glass session cannot), then confirm it is you. Pick only the scopes the automation needs, an IP range for its egress, and an expiry of at most 30 days (90 with `platform:read` alone). Copy the secret once.

## 2. Check the key

Define one function for every call. The key goes in on stdin, never on a command line.

```sh name=define-call confirm=no
pbk() { curl -sS -w '\nHTTP %{http_code}\n' -K - -H "cf-connecting-ip: $KEY_IP" -H 'content-type: application/json' "$@" <<EOF
header = "Authorization: Bearer $PASSBOOK_KEY"
EOF
}
```

`platform:read` reads the platform settings. Expect HTTP 200 and the settings list (the end of the body is shown).

```sh name=check-key confirm=no
pbk "$BASE_URL/api/v1/platform/settings" | tail -c 400
```

A key outside its range, expired, revoked or whose creator is disabled gets 401 `INVALID_API_KEY` with no reason. Check the address first:

```sh name=check-wrong-ip confirm=no
pbk -H 'cf-connecting-ip: 198.51.100.7' "$BASE_URL/api/v1/platform/settings"
```

```text
{"type":"https://passbook.mobile/developers/errors/INVALID_API_KEY","title":"Unauthenticated","status":401,"code":"INVALID_API_KEY","detail":"The API key is invalid or expired.","requestId":"..."}
HTTP 401
```

## 3. Read the wallet release

Needs `platform:wallet`. The report is what a Google or Samsung flip depends on: state per mode, credentials, enrolments by readiness. [[Wallet Provider Flip]] uses it.

```sh name=wallet-release confirm=no
pbk "$BASE_URL/api/v1/platform/wallet-release" | tail -c 600
```

## 4. Dry-run enable-ready

A dry run lists the Off enrolments that would turn On. It changes nothing. The apply stays in the Release card.

```sh name=enable-ready-dry-run confirm=no
pbk -X POST -d '{"apply":false}' "$BASE_URL/api/v1/platform/wallet-release/google/test/enable-ready"
```

```text
{"applied":false,"enrolments":[]}
HTTP 200
```

## 5. What a key cannot do

Each call is refused before it changes anything.

Apply is a person's go/no-go:

```sh name=refuse-apply confirm=no
pbk -X POST -d '{"apply":true,"orgIds":[]}' "$BASE_URL/api/v1/platform/wallet-release/google/test/enable-ready"
```

A sign-in setting decides who gets in:

```sh name=refuse-sign-in-setting confirm=no
pbk -X PUT -d '{"values":{"auth.consoleEmailUntil":null}}' "$BASE_URL/api/v1/platform/settings"
```

A Platform key has no organization scope, so organization routes refuse it:

```sh name=refuse-org-route confirm=no
pbk "$BASE_URL/api/v1/passes"
```

Apply and the sign-in setting answer 403 `PERSON_REQUIRED`; the passes route answers 403 `MISSING_SCOPE`:

```text
{"type":"https://passbook.mobile/developers/errors/PERSON_REQUIRED","title":"Forbidden","status":403,"code":"PERSON_REQUIRED","detail":"This needs a person signed in with Polaris ID.","requestId":"..."}
HTTP 403
```

Person-only, for any platform key: freeze Polaris ID, clear the SCIM breaker, offboard (a dry run is allowed), lift a hold, remove an external role, apply a wallet release, change sign-in settings, revoke a certificate, move a person's email, release a retention hold, mint or rotate a platform key. A key also never makes, promotes, demotes or removes an administrator. The list and reasons are in [security](../security.md).

## 6. Rotate and revoke

Both are a person's, in the console, with Polaris ID and a recent sign-in. A key never renews itself.

- Rotate: Platform > API keys > the key > Rotate. Set an overlap (`retire_at`) so the automation swaps its secret before the old one stops. Update the secret store, then confirm with step 2.
- Revoke: Platform > API keys > the key > Revoke. It stops at once. Disabling the creator in the console or in Polaris ID stops it too.
- Every write a key makes is in the platform audit log as `api_key` with the key id, and the key's page shows what it called.

## Limits

A platform key is on the `standard` rate tier, plus 60 writes a minute per key on platform routes (429 `RATE_LIMITED`). Platform writes accept `Idempotency-Key`. A key sent from a browser is refused (`KEY_IN_BROWSER`).
