# Security

## Threat model

- Anonymous internet: sign-in, magic links, public pass pages, Apple web service, hooks.
- Signed-in holders: portal APIs. Org-scoped API keys: machine API.
- Tenant admins' connector URLs: outbound fetches (SSRF).
- Admins are trusted but audited. A stolen admin session is the worst case.

## Capabilities

| Secret | Stored | Notes |
| --- | --- | --- |
| Session, magic link, API key | hashed | Shown once. |
| Download token (`/p/<token>`) | retrievable | Recorded call: admins re-send it. Rotatable. Never logged. |
| ApplePass token | retrievable | Devices need it back. Rotatable. Never logged. |
| Pass serial | plain | The personalization capability (SEC-1). NFC identities must not use caller-chosen or guessable serials. |

## Fails closed

Each shows on the admin status page.

| Control | When missing | Status component |
| --- | --- | --- |
| Rate-limit bindings | 503 `RATE_LIMIT_UNAVAILABLE`, logged once per isolate | `ratelimits` (failing, names the binding) |
| Turnstile | Email sign-in refused, `auth.turnstile_unconfigured` or `auth.turnstile_unavailable` logged | `turnstile` |
| KEK | Secrets cannot be read or written | `build`, probe errors |
| Magic-link daily cap | Sends dropped, `auth.magic_daily_cap` logged | `email` (degraded at 80 %, failing at cap) |

Magic-link sends are also capped per address (5/h), per network (30/day) and, for verification mail, per signed-in user (10/day).

## Personalization

`/wallet/v1/passes/.../personalize` signs a token Wallet chooses. Tokens with `{ } [ ] "`, backslash, whitespace or control characters are refused, so no JSON container (a forged `manifest.json`) can be signed. Deleted and voided passes answer 404. First token wins.

## Outbound fetches (SSRF)

- https and 443 only, no credentials, no IP literals, no redirects, size and time caps.
- Denied hosts: `PUBLIC_BASE_URL`, `OIDC_ISSUER`, `workers.dev`, and `SSRF_DENY_HOSTS` (comma list, `plrs.im`).
- Private, link-local, CGNAT, multicast, NAT64, 6to4, Teredo and discard IPv6 ranges are refused after DNS.
- Residual: DNS TOCTOU. The DoH check and the fetch resolve separately, and Workers cannot pin an IP. Cloudflare itself refuses private ranges.
- Not done: per-connection host allowlists.

## Sign-in

- `oidc.trustEmail` is off by default. When on, it applies only if Pocket ID sends `email_verified=true`. Otherwise an existing owner must prove the address by mail. The status `oidc` component is degraded while it is on. Trade-off: on, a Pocket ID user whose email matches an account links at once.
- Each identity link writes `auth.identity_linked` (provider, how, verified flag; no email).
- Break-glass: a wrong token writes `auth.breakglass_failed` (100 rows/h, then counted only); a success writes `auth.breakglass_used`. Delete `BREAKGLASS_TOKEN_SHA256` to turn the route off (it then answers 404). The status `breakglass` component shows last use and failures today.
- Refused principals write `auth.denied` (admin route as a non-admin, CSRF failure, missing API-key scope; 500 rows/h). Unknown keys and anonymous 401s are logs and Analytics only.

## Mail headers

Org names and the sender name reject controls, line separators and bidi marks at write time. The mailer flattens them again as a backstop. Support links must be https without credentials. DB identities may only bind `APNS_*` names, and a binding counts only if it has `fetch`.

## Public OpenAPI

`/api/v1/openapi.json` stays public: the same contracts ship in the SPA bundle.

## Owner actions

- Keep NFC off on every signing identity until the personalization fix is deployed.
- Pocket ID: stop users editing their own email. Decide whether to turn `oidc.trustEmail` back on.
- Break-glass: delete `BREAKGLASS_TOKEN_SHA256` while unneeded, or put Cloudflare Access or a WAF IP rule in front of `/auth/breakglass*`. Keep `.secrets/breakglass-token` offline.
- After deploy, open the status page: `ratelimits` shows every `RL_*` present; `turnstile` and `breakglass` read as expected.
- GitHub: default workflow permissions read-only, Dependabot alerts and security updates on, `main` protected with the `ci` check required.
- Admin offboarding: remove the user from `wallet-admins` in Pocket ID and revoke their sessions (Admin > Users > Revoke sessions). The role snapshot lasts up to 1 h idle and 12 h absolute.
- Deploy and apply new D1 migrations yourself. Agents never deploy or use `--remote`.

## Dev advisories

`npm audit` and `npm audit --omit=dev` report 0. Overrides in `package.json` pin `undici` 7.30.1 and `sharp` 0.35.5 inside `miniflare`, and `zod` 4.6.7 inside `@cloudflare/vitest-pool-workers`. Drop them once the Cloudflare packages ship fixed ranges. `@cloudflare/vite-plugin` stays at 1.64.0: the fixed 1.66.0 is under 14 days old.
