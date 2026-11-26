---
tags: runbook, go-live, secrets, production
confirm: true
profile: passbook-owner
---
# Go-Live Secrets

Owner only. Agents never deploy or use `--remote` (AGENTS.md). Steps 4 and 5 of the go-live order, after [[Go-Live Apple Signing and APNs]].

Sets the Worker secrets. Every value comes from the profile through stdin, so none appears in this note or on a command line.

## Prerequisites

Profile `passbook-owner` defines:

- `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`
- `KEK_V1`: generate once with the `norun` block below, store it in the vault, add it to the profile. Back it up outside Cloudflare: losing it loses every stored credential.
- `TURNSTILE_SECRET` (and `OIDC_CLIENT_SECRET` only for a registered Polaris ID client)
- `BREAKGLASS_TOKEN_SHA256`: from [[Break-Glass Token]]

Turnstile (step 4): create a widget whose hostnames include `PUBLIC_BASE_URL`'s host. Put its site key in `vars.TURNSTILE_SITE_KEY`. `deploy:check` refuses the always-pass test key.

```sh name=generate-kek norun
openssl rand -base64 32
```

## 1. Turnstile secret

```sh name=put-turnstile-secret confirm="Set TURNSTILE_SECRET on the production Worker?"
: "${TURNSTILE_SECRET:?add it to the profile}" && printf %s "$TURNSTILE_SECRET" | npx wrangler secret put TURNSTILE_SECRET
```

## 2. Encryption key

```sh name=put-kek-v1 confirm="Set KEK_V1 on the production Worker?"
: "${KEK_V1:?add it to the profile}" && printf %s "$KEK_V1" | npx wrangler secret put KEK_V1
```

## 3. Platform signer

Contents of the files that [[Go-Live Apple Signing and APNs]] wrote.

```sh name=put-signer-certificate confirm="Set SIGNER_PLATFORM_CERTIFICATE on the production Worker?"
npx wrangler secret put SIGNER_PLATFORM_CERTIFICATE < .secrets/platform-certificate.pem
```

```sh name=put-signer-key confirm="Set SIGNER_PLATFORM_PRIVATE_KEY on the production Worker?"
npx wrangler secret put SIGNER_PLATFORM_PRIVATE_KEY < .secrets/platform-key.pem
```

## 4. Break-glass hash

```sh name=put-breakglass-hash confirm="Set BREAKGLASS_TOKEN_SHA256 on the production Worker?"
: "${BREAKGLASS_TOKEN_SHA256:?add it to the profile}" && printf %s "$BREAKGLASS_TOKEN_SHA256" | npx wrangler secret put BREAKGLASS_TOKEN_SHA256
```

## 5. Registered Polaris ID client only

Skip with the default public client.

```sh name=put-oidc-client-secret confirm="Set OIDC_CLIENT_SECRET on the production Worker?"
: "${OIDC_CLIENT_SECRET:?add it to the profile}" && printf %s "$OIDC_CLIENT_SECRET" | npx wrangler secret put OIDC_CLIENT_SECRET
```

## 6. Verify

Lists the secrets the Worker has (names only) and checks the required ones.

```sh name=list-secrets confirm=no
npx wrangler secret list
```

```sh name=check-secrets confirm=no
npm run deploy:check -- --secrets
```

## Optional secrets

`SIGNER_PLATFORM_INTERMEDIATE` (defaults to the bundled WWDR G4), `MAGIC_LINK_DAILY_CAP`, `KEK_V2`, `MAC_KEY_VERSION` and `MAC_KEY_VERSION_PREVIOUS` (rotation: [[KEK Rotation]], [[MAC Key Rotation]]).

Next: [[Go-Live Provision]].
