---
tags: runbook, apple, signing, certificate, production
confirm: true
profile: passbook-owner
---
# Platform Certificate Renewal

Owner only. Agents never deploy or use `--remote` (AGENTS.md).

Yearly, Apple. Use when the platform Pass Type ID certificate nears expiry (Status warns 30 days before). Passes keep working; the pass type ID must match the old one. Other identities rotate in the admin console instead: Identities, Rotate certificate (admin session only; `POST /api/v1/identities/{id}/rotate`). Re-sign all passes is on the same page.

## Prerequisites

- A new Pass Type ID certificate for the platform pass type, ordered in the developer portal (or Xcode) with your own Apple ID, exported as a `.p12`.
- Profile `passbook-owner` defines `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and `P12_PASSWORD`.

## Parameters

```sh name=set-params confirm=no
export P12_FILE="${P12_FILE:-Pass.p12}"
```

## 1. Convert and check

Writes `.secrets/platform-certificate.pem`, `.secrets/platform-key.pem` and `.dev.vars`; checks chain, key match and dates.

```sh name=credentials confirm=no
: "${P12_PASSWORD:?add P12_PASSWORD to the profile}" && npm run credentials -- "$P12_FILE"
```

## 2. Update the signer secrets

```sh name=put-signer-certificate confirm="Replace SIGNER_PLATFORM_CERTIFICATE on the production Worker?"
npx wrangler secret put SIGNER_PLATFORM_CERTIFICATE < .secrets/platform-certificate.pem
```

```sh name=put-signer-key confirm="Replace SIGNER_PLATFORM_PRIVATE_KEY on the production Worker?"
npx wrangler secret put SIGNER_PLATFORM_PRIVATE_KEY < .secrets/platform-key.pem
```

## 3. Update the APNs binding

Re-uploads the certificate as the APNS mTLS certificate. Dry run first.

```sh name=identity-plan confirm=no
npm run identity:add
```

```sh name=identity-apply confirm="Upload the renewed platform certificate as the APNS mTLS certificate?"
npm run identity:add -- --apply
```

## 4. Deploy

Commit any `wrangler.jsonc` change, then [[Deploy]].

## 5. Re-sign

Existing passes are rebuilt with the new certificate from the admin console: Identities, the platform identity, Re-sign all.
