---
tags: runbook, polaris-id, polaris-binding, incident, production
confirm: true
profile: passbook-polaris-binding
---
# Polaris Binding Compromise

Owner only. Agents never deploy or use `--remote` (AGENTS.md).

Settings, Polaris ID has Freeze; use it first if the card is reachable. First turn-on: [[Polaris Binding Turn On]].

Use when the binding's Polaris ID API key may have leaked. On Polaris ID v2.19.3 the key is a full admin key, so treat it as identity provider compromise. Order matters: revoke first, review, then replace.

## Prerequisites

Signed in with `npx wrangler login` (or `CLOUDFLARE_API_TOKEN` in the profile `passbook-polaris-binding`).

## 1. Revoke the key (UI)

Revoke the key in Polaris ID first.

## 2. Find the last good call

The ledger lists the binding's own calls only; anything else came from outside it.

```sh name=last-calls confirm=no
npx wrangler d1 execute polaris-binding --config workers/polaris-binding/wrangler.jsonc --remote --command "SELECT * FROM idp_calls ORDER BY rowid DESC LIMIT 100"
```

## 3. Review the Polaris ID audit log (UI)

Since the last good `idp_calls` row, review changes to users, groups, signup tokens and OIDC clients. Remove any group membership or admin you did not add. Delete unknown signup tokens.

## 4. Create a new key and set it

Follow [[Polaris Binding Key Rotation]] from step 1. Never give CI a Cloudflare token that can deploy `polaris-binding`: anyone who can redeploy it can read the key.
