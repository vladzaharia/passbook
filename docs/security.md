# Security

## Threat model

- Anonymous internet: sign-in, magic links, public pass pages, Apple web service, hooks.
- Signed-in holders: portal APIs. Org-scoped API keys: machine API.
- Tenant admins' connector URLs: outbound fetches (SSRF).
- Admins are trusted but audited. A stolen admin session is the worst case.
- Cloudflare account operators with direct R2 write access are trusted infrastructure operators,
  outside the application authorization boundary.

Template release candidates bind the complete manifest, pass content, preview and output asset
metadata, and SHA-256 of the actual bytes to the selected organization, mode, provider, policy
revisions and author. A different authorized reviewer must approve the exact candidate before
publication; missing preview assets fail closed. Baked extra assets are versioned and sealed.
Version assets are created conditionally and existing objects must match byte-for-byte; release
resolution rechecks their content. A privileged operator who changes R2 directly between that
check and pass assembly can still change the bytes used by the build: D1 cannot atomically fence
an external R2 write. Restrict and audit direct bucket access accordingly.

Native provider projections are separate reviewed candidates bound to the effective Apple release,
the provider-account revision and identity, and the complete normalized projection. Changing the
source or account makes the projection ineligible without erasing approval history. Provider
credentials are encrypted and never returned with candidate metadata. Samsung publication
requires fresh provider evidence. Google publication and offers remain blocked until issuer
approval and replay-safe Save behavior can be verified.

## Capabilities

| Secret | Stored | Notes |
| --- | --- | --- |
| Session, magic link, API key | hashed | Shown once. |
| Download token (`/p/<token>`) | retrievable | Recorded call: admins re-send it. Rotatable. Never logged. |
| ApplePass token | retrievable | Devices need it back. Rotatable. Never logged. |
| Pass serial | plain | The personalization capability (SEC-1). NFC identities must not use caller-chosen or guessable serials. |

Holder transfers reserve a monotonic credential generation before invalidating the public link.
During the pending interval, downloads, scanner actions and new provider offers fail closed.
Completion requires retirement of older provider incarnations and rotates the Apple and scanner
credentials. Keyed, organization- and mode-scoped tombstones prevent retired scanner identifiers
from being accepted again. Rotating only the public link does not create a credential generation.

## Scanner security

- Keep the oldest KEK when rotating keys: it derives the scan PIN, asset-grant and credential
  tombstone HMAC keys. The credential-reference keyset sentinel commits to that keyset. A missing
  sentinel with retained references or proof provenance, or a commitment mismatch, fails closed;
  restore the original key rather than silently reinitializing it. Lazy bootstrap is allowed only
  for an empty reference store and is fenced in the same D1 transaction by the requesting actor's
  current authority.
- Scanner asset grants are short-lived opaque capabilities bound to the recipient, pass, relevant
  source and credential lineage. Provenance stores the token hash, organization, mode, expiry and
  keyed credential references, not raw credentials. Redemption rechecks current authority and
  lineage, including after opening the stream; expired provenance is cleaned up in bounded batches.
  Grant URLs and logs must not expose raw credentials or proof material, and logs must not contain
  the grant itself.
- Internal DTOs, URLs and logs must not carry raw credentials or CSRF secrets. The authorized
  `/api/v1/scan/session` `csrfToken` response is the deliberate browser handshake exception; it
  must not be propagated into internal DTOs, URLs or logs.
- Migration `0041` retains authenticated scan provenance in `scan_retention_proofs`: a scoped,
  keyed pass reference, event and scan digests, snapshots and MAC, not the deleted pass identity
  or event payload. Committed check-in and undo transitions are ordered by a database sequence;
  the transition guard prevents an older occupancy state becoming authoritative after a later
  transition is changed or removed.
- Use the application retention workflow for pass deletion, not direct SQL: it stages a scoped
  deletion intent and preserves eligible final gate and presence evidence in the guarded deletion
  transaction. Retained history is authenticated against the current scan and keyset before use;
  missing, invalid, excluded or stale evidence must not authorize disclosure or occupancy. Do not
  fabricate proofs or bypass the guards to recover legacy data; investigate and restore valid
  provenance and keys instead. Normal scan retention removes proofs with their scan.
- Migration `0047` makes session identity, lifetime and CSRF secret immutable, retires deleted
  session and scanner IDs, and requires scanner credential changes to advance their authority
  revision; replacement cannot bypass these protections. Migration `0048` adds monotonic
  `imageGeneration` fencing for image mutations and durable asset GC: uploads are reserved,
  detached references retain rollback holds, and retired keys cannot be reused. Deletion is
  limited to eligible pass-asset and member-photo namespaces and guarded against live references.

## Fails closed

Each shows on the admin status page.

| Control | When missing | Status component |
| --- | --- | --- |
| Rate-limit bindings | 503 `RATE_LIMIT_UNAVAILABLE`, logged once per isolate | `ratelimits` (failing, names the binding) |
| Turnstile | Email sign-in refused, `auth.turnstile_unconfigured` or `auth.turnstile_unavailable` logged | `turnstile` |
| KEK | Secrets cannot be read or written | `build`, probe errors |
| Magic-link daily cap | Sends dropped, `auth.magic_daily_cap` logged | `email` (degraded at 80 %, failing at cap) |

Magic-link sends are also capped per address (5/h), per network (30/day) and, for verification mail, per signed-in user (10/day).

## Hosts

- Only `PUBLIC_BASE_URL`'s origin (`passbook.mobile`) serves the app and sets cookies. Sessions and sign-in bindings are host-only `__Host-` cookies there.
- A `REDIRECT_HOSTS` host (`wallet.plrs.im`) only answers 308 to the same path and query on the canonical origin, uncached. It runs no route, so it sets no cookie and serves no API.
- Any other host gets 421 and logs `host.refused`, so a stray route or a `workers.dev` URL cannot serve the app under another origin. Plain http on the canonical host gets a 308 to https.
- Files `public/` ships are served by the asset layer on every attached host. They are public by design.

## Personalization

`/wallet/v1/passes/.../personalize` signs a token Wallet chooses. Tokens with `{ } [ ] "`, backslash, whitespace or control characters are refused, so no JSON container (a forged `manifest.json`) can be signed. Deleted and voided passes answer 404. First token wins.

## Outbound fetches (SSRF)

- https and 443 only, no credentials, no IP literals, no redirects, size and time caps.
- Denied hosts: `PUBLIC_BASE_URL`, `REDIRECT_HOSTS`, `OIDC_ISSUER`, `workers.dev`, and `SSRF_DENY_HOSTS` (comma list, `plrs.im`).
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
- Offboarding also revokes organization memberships: each org's Members list, or `DELETE /api/v1/orgs/{id}/memberships/{membershipId}` (`org_admin`, or a platform admin acting as one). A removed `wallet-admins` group does not remove a membership, and a member keeps tenant access until revoked. Revoke the person's API keys and pending invitations in the same pass.
- Deploy and apply new D1 migrations yourself. Agents never deploy or use `--remote`.

## Dev advisories

`npm audit` and `npm audit --omit=dev` report 0. Overrides in `package.json` pin `undici` 7.30.1 and `sharp` 0.35.5 inside `miniflare`, and `zod` 4.6.7 inside `@cloudflare/vitest-plugin`. Drop them once the Cloudflare packages ship fixed ranges. `@cloudflare/vite-plugin` stays at 1.64.0: the fixed 1.66.0 is under 14 days old.
