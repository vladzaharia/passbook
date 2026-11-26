---
tags: runbook, go-live, apple, signing, production
confirm: true
profile: passbook-owner
---
# Go-Live Apple Signing and APNs

Owner only. Agents never deploy or use `--remote` (AGENTS.md). Steps 2 and 3 of the go-live order, after [[Go-Live Polaris ID Client]].

Turns the exported Pass Type ID certificate into the platform signing files, then uploads it as the APNs mTLS binding. Pass Type ID: `pass.im.plrs.wallet`. Without the APNs binding the platform signs passes but cannot push updates; the alternative is a team push key (.p8) added on the identity's Push card.

## Prerequisites

- The Pass Type ID certificate exported as a `.p12` from your Apple developer account.
- Profile `passbook-owner` defines `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and `P12_PASSWORD` (the export password; never put it on a command line).

## Parameters

```sh name=set-params confirm=no
export P12_FILE="${P12_FILE:-Pass.p12}"
```

## 1. Convert and check the certificate

Checks the chain, key match and dates. Writes `.secrets/platform-certificate.pem`, `.secrets/platform-key.pem` and `.dev.vars` (none committed).

```sh name=credentials confirm=no
: "${P12_PASSWORD:?add P12_PASSWORD to the profile}" && npm run credentials -- "$P12_FILE"
```

## 2. Plan the APNs binding

Dry run: prints the plan.

```sh name=identity-plan confirm=no
npm run identity:add
```

## 3. Upload the APNs binding

Uploads `.secrets/platform-*.pem` with `wrangler mtls-certificate upload` and adds `mtls_certificates: APNS` to `wrangler.jsonc`.

```sh name=identity-apply confirm="Upload the platform certificate to Cloudflare as the APNS mTLS certificate?"
npm run identity:add -- --apply
```

## 4. Regenerate types

Commit the result.

```sh name=gen confirm=no
npm run gen
```

## 5. After the deploy

Using a team push key instead: add the `.p8` on the identity's Push card, deploy, then press Check there. Failures with `APNS_TOKEN_TRANSPORT_FAILED` in the logs mean the runtime cannot reach APNs over HTTP/2. Apple answers 429 `TooManyProviderTokenUpdates` if tokens are re-signed too often (after setting a key, or on many isolates at once); the push job retries it.

Next: [[Go-Live Secrets]]. Yearly renewal: [[Platform Certificate Renewal]].
