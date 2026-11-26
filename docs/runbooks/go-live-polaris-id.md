---
tags: runbook, go-live, polaris-id, auth
confirm: true
---
# Go-Live Polaris ID Client

Owner only. Agents never deploy or use `--remote` (AGENTS.md). Step 1 of the go-live order; do the others in order after it: [[Go-Live Apple Signing and APNs]], [[Go-Live Secrets]], [[Go-Live Provision]], [[Deploy First]], [[First Admin and Device Test]].

Registers PassBook as a client of Polaris ID. PassBook uses a Client ID Metadata Document: `vars.OIDC_CLIENT_ID` is `${PUBLIC_BASE_URL}/auth/oidc/client-metadata.json`, which the Worker serves (public client, PKCE, no secret; callback and post-logout URLs come from `PUBLIC_BASE_URL`). Most steps are in the Polaris ID admin UI; the commands only read.

Group semantics (what each `OIDC_*_GROUP` var grants, exact matching) are in [docs/operations.md](../operations.md#go-live-reference).

## Prerequisites

- Polaris ID admin access (v2.19.3 or later).
- `PUBLIC_BASE_URL` in `wrangler.jsonc` is the production origin.

## Parameters

```sh name=set-params confirm=no
export PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-https://passbook.mobile}"
```

## 1. Allow the metadata document

In Polaris ID, Application Configuration, OIDC, Client ID Metadata Documents: add the exact URL below to the allowed metadata document URLs (or `CIMD_URL_ALLOWLIST` when the UI config is disabled).

```sh name=show-metadata-url confirm=no
echo "$PUBLIC_BASE_URL/auth/oidc/client-metadata.json"
```

Metadata changes reach Polaris ID within an hour, or at once with Refresh in its client list.

## 2. Check the Worker serves it

Needs a deployed Worker. Every URL in the document should be on the production host.

```sh name=check-metadata confirm=no
curl -fsS "$PUBLIC_BASE_URL/auth/oidc/client-metadata.json"
```

## 3. First sign-in, then set the client

The first sign-in creates the client in Polaris ID. Then:

1. Set its allowed groups to the group names `OIDC_*_GROUP` expects (PassBook also checks the groups claim itself).
2. Logo: Polaris ID ignores the document's `logo_uri`. Set Logo URL and Dark logo URL on the client to `${PUBLIC_BASE_URL}/icons/icon-512.png`; Polaris ID downloads and keeps it.
3. Settings, "Trust Polaris ID emails" links and verifies an address only when Polaris ID sends `email_verified: true`. Never set Polaris ID's `EMAILS_VERIFIED=true`: a user could then claim any address.

Check the real group values in the logs of a refused sign-in (`auth.oidc_no_access` lists the groups it received) before a deploy that changes them.

## A registered client instead

Set its id in `vars.OIDC_CLIENT_ID`. A confidential client also needs the `OIDC_CLIENT_SECRET` secret ([[Go-Live Secrets]]). Local dev only loads secrets listed in `secrets.required`, so the mock provider runs as a public client.

## Related

- Rename groups: [[Polaris ID Group Rename]]
- Require the console group: [[Polaris ID Console Group Required]]
- Pin platform admins: [[Polaris ID Pin Platform Admins]]
- Polaris ID down: [[Break-Glass Token]]
