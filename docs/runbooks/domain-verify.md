---
tags: runbook, domains, verify
---
# Domain Verify

Use after a deploy, a route change or a domain move to check the production hosts. Read-only: it only sends GET and HEAD requests. Host policy: `PUBLIC_BASE_URL`'s host serves everything (plain http gets a 308 to https); a `vars.REDIRECT_HOSTS` host (`wallet.plrs.im`) answers every request with an uncached 308 to the same path and query on `PUBLIC_BASE_URL`; any other host gets 421. Details are in [docs/operations.md](../operations.md#domains).

A pass keeps the `webServiceURL` it was issued with, so its host must keep serving `/wallet/*` itself; do not replace that with a redirect.

## 1. Health

```sh name=check-health confirm=no
curl -sI https://passbook.mobile/health | head -n 1
```

```text
HTTP/2 200
```

## 2. The old host redirects

```sh name=check-redirect confirm=no
curl -sI 'https://wallet.plrs.im/p/x?y=1' | grep -i -E '^(HTTP|location)'
```

```text
HTTP/2 308
location: https://passbook.mobile/p/x?y=1
```

## 3. The sign-in metadata names only the production host

Every URL in the document should be on `passbook.mobile`.

```sh name=check-client-metadata confirm=no
curl -s https://passbook.mobile/auth/oidc/client-metadata.json
```

## 4. Browser checks

- Sign in with Polaris ID and with an email link on `passbook.mobile`. Status shows Email Sending and Turnstile configured.
- Issue a pass and add it to Wallet: its back shows the `passbook.mobile` support link, and an update reaches the phone.
