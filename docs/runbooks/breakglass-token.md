---
tags: runbook, auth, breakglass, production
confirm: true
profile: passbook-owner
---
# Break-Glass Token

Owner only. Agents never deploy or use `--remote` (AGENTS.md).

Admin sign-in for when Polaris ID is down. `npm run breakglass` writes a new token to `.secrets/breakglass-token` (never printed) and its SHA-256 to `.dev.vars`, and prints the `wrangler secret put` command for production. The Worker stores only the hash. Sign in at `/auth/breakglass` with the token: an admin session as "Break-glass admin", 30 minutes idle, 4 hours max. Every sign-in is in the audit log; failures are logged and rate limited.

Keep the token offline (password manager). Rotate it after any use you did not expect.

When Polaris ID is down, deploys still work (the client id is the metadata URL). `--allow-no-oidc` only matters for a placeholder `OIDC_CLIENT_ID`.

## Prerequisites

Profile `passbook-owner` defines `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and, after step 1, `BREAKGLASS_TOKEN_SHA256`.

## 1. Create a token

Prints the production command (with the hash) and writes the token file. Add the hash to the profile as `BREAKGLASS_TOKEN_SHA256` and the token to your password manager.

```sh name=breakglass-create confirm=no
npm run breakglass
```

To replace an existing token, run it with `--rotate`, then repeat step 2 and deploy. It is `norun` so a full run of this note never replaces a token by accident.

```sh name=breakglass-rotate norun
npm run breakglass -- --rotate
```

## 2. Set the hash in production

```sh name=put-breakglass-hash confirm="Set BREAKGLASS_TOKEN_SHA256 on the production Worker?"
: "${BREAKGLASS_TOKEN_SHA256:?add it to the profile}" && printf %s "$BREAKGLASS_TOKEN_SHA256" | npx wrangler secret put BREAKGLASS_TOKEN_SHA256
```

After a rotate, [[Deploy]].

To turn sign-in off: [[Break-Glass Off]].
