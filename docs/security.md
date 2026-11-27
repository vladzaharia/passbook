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
| Download token (`/p/<token>`), bundle token (`/b/<token>`) | MAC + sealed copy | Lookup by HMAC (`h1:`); the link is shown again from an AES-GCM copy bound to id, org and purpose. A database read yields no link. The database refuses a plain value (triggers of 0059 and 0065), and migration 0070 refuses to run while one is left. A presented `h1:` value never matches, so a leaked MAC is no link. Rotatable. Never logged. |
| Scanner asset grant | none | Stateless HMAC, one hour. See Scanner security. |
| Manager PIN | hashed | HMAC under a key from the oldest KEK. Rate-limited. |
| ApplePass token (`authenticationToken`) | MAC + sealed copy | Device calls compare the MAC of the presented token in constant time (own HMAC key; a stored MAC is no token). `pass.json` builds read the AES-GCM copy; stored `pass_versions.pass_json` never carries the token. Rotated by a credential transfer. Never logged. |
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
- Scanner asset grants (`scan-asset-v4`) are stateless capabilities valid for one hour: a nonce, an
  expiry, a truncated HMAC and, for a grant minted from a scanned credential, masked 8-byte
  prefixes of its keyed tombstone refs. The HMAC covers the recipient, pass, the release the pass
  is actually used under, photo and credential lineage; nothing is stored. Redemption rereads that
  lineage, recomputes the HMAC in constant time, fences it in SQL (including that no tombstone
  starts with a carried prefix) and rechecks current authority, including after opening the
  stream. A rotated keyset, or a successor release that changes the adapter, capabilities or
  audience policy, voids a grant; an identical republish keeps it. Grant URLs and logs must not expose raw credentials or proof material,
  and logs must not contain the grant itself.
- Manager PINs are six digits, hashed under a key derived from the oldest KEK. A wrong PIN counts
  against the manager (5 per 5 minutes) and the scanner (20 per hour); past either, 429
  `RATE_LIMITED`. A PIN sent without a manager is tested against the org's active managers: both
  limits divide by their number, an org-wide hourly counter bounds a fleet of devices, and two
  managers sharing a PIN answer as a wrong one (`PIN_INVALID`, logged `PIN_AMBIGUOUS`). The attempt
  is reserved only once policy says the action needs approval; an unspent PIN is refunded inside
  the scan's own grant.
- Codes not found are counted per scanner (or admin actor) in 10-minute windows. Past 30, 429
  `SCAN_TOO_MANY_MISSES` (with `Retry-After`) and one `scan.misses_capped` audit row. A miss counts
  only when its grant commits; otherwise `SCAN_MISS_UNCOUNTED` is logged.
- Internal DTOs, URLs and logs must not carry raw credentials or CSRF secrets. The authorized
  `/api/v1/scan/session` `csrfToken` response is the deliberate browser handshake exception; it
  must not be propagated into internal DTOs, URLs or logs.
- Migration `0041` retains authenticated scan provenance in `scan_retention_proofs`: a scoped,
  keyed pass reference, event and scan digests, snapshots and MAC, not the deleted pass identity
  or event payload. Committed check-in and undo transitions are ordered by a database sequence;
  the transition guard prevents an older occupancy state becoming authoritative after a later
  transition is changed or removed. Auto exits, desk mark-outs and undos written after this change
  carry the same proof (MAC v2, bound to the kind) in the batch that writes them, with a plain
  authority on the ledger row (`system`, `device`, `console`, `undo`) and no gate or presence snapshot; the batch aborts if the written row differs from what the proof signs. The 0041 comment that an undo has no proof is stale. Older
  rows have none, and none is minted later.
- Use the application retention workflow for pass deletion, not direct SQL: it stages a scoped
  deletion intent and preserves eligible final gate and presence evidence in the guarded deletion
  transaction. Retained history is authenticated against the current scan and keyset before use;
  missing, invalid, excluded or stale evidence must not authorize disclosure or occupancy. Do not
  fabricate proofs or bypass the guards to recover legacy data; investigate and restore valid
  provenance and keys instead. Normal scan retention removes proofs with their scan.
- Migration `0047` makes session identity, lifetime and CSRF secret immutable, retires deleted
  session and scanner IDs, and guards scanner credential changes (authority is the scanner's `credential_epoch`, `0052`; the
  `0047` revision trigger was dropped by `0063`); replacement cannot bypass these protections. Migration `0048` adds monotonic
  `imageGeneration` fencing for image mutations and durable asset GC: uploads are reserved,
  detached references retain rollback holds, and retired keys cannot be reused. Deletion is
  limited to eligible pass-asset and member-photo namespaces and guarded against live references.

### Credential keys

`scanning:admin` and `nfc:keys` are minted by a signed-in `org_admin` with a recent step-up, never by a key or through a role. It is for live keys bound to one org, and it expires within 90 days. A PIN, pairing code, till token or tag key is shown once, in the answer that made it, and is never logged or audited; the logger also redacts `wls_` tokens and PIN and key fields. The idempotency store hashes typed-in tag keys as HMACs, so a weak key cannot be confirmed offline. A replay with an `Idempotency-Key` stores the answer with every secret null. Limits are per key, and a call that commits nothing is refunded.

## Fails closed

Each shows on the admin status page.

| Control | When missing | Status component |
| --- | --- | --- |
| Rate-limit bindings | 503 `RATE_LIMIT_UNAVAILABLE`, logged once per isolate | `ratelimits` (failing, names the binding) |
| Turnstile | Email sign-in refused, `auth.turnstile_unconfigured` or `auth.turnstile_unavailable` logged | `turnstile` |
| KEK | Secrets cannot be read or written | `build`, probe errors |
| Magic-link daily cap | Sends dropped, `auth.magic_daily_cap` logged | `email` (degraded at 80 %, failing at cap) |

The Request access form (`POST /access`) mails PassBook's own inbox (`ACCESS_REQUEST_EMAIL`). A missing `EMAIL` binding, an invalid recipient or a failed send answers 503 `ACCESS_MAIL_UNAVAILABLE` and logs `marketing.access_unconfigured` or `marketing.access_failed`; it never answers success without sending. The one exception is the honeypot field, which answers success and sends nothing (`marketing.access_trap`).

Magic-link sends are also capped per address (5/h), per network (30/day) and, for verification mail, per signed-in user (10/day).

## Hosts

- Only `PUBLIC_BASE_URL`'s origin (`passbook.mobile`) serves the app and sets cookies. Sessions and sign-in bindings are host-only `__Host-` cookies there.
- A `REDIRECT_HOSTS` host (`wallet.plrs.im`) only answers 308 to the same path and query on the canonical origin, uncached. It runs no route, so it sets no cookie and serves no API.
- Any other host gets 421 and logs `host.refused`, so a stray route or a `workers.dev` URL cannot serve the app under another origin. Plain http on the canonical host gets a 308 to https.
- The public site's pages (`/`, `/door`, `/blueprints`, `/build`, `/access`) carry their own CSP (`marketingContentSecurityPolicy`): no inline script or style element, same-origin only, Trusted Types limited to the `passbook-marketing` policy. `POST /access` is same-origin only, capped at 4 KB, and limited per network (5 a minute, `RL_ACCESS`) and overall (30 a minute, `RL_ACCESS_ALL`). It takes no Turnstile: the only recipient is our own inbox. Logs hold the purpose and field paths, never a name, address, organization or message.
- Files `public/` ships are served by the asset layer on every attached host. They are public by design.

## Personalization

`/wallet/v1/passes/.../personalize` signs a token Wallet chooses. Tokens with `{ } [ ] "`, backslash, whitespace or control characters are refused, so no JSON container (a forged `manifest.json`) can be signed. Deleted and voided passes answer 404. First token wins.

## Outbound fetches (SSRF)

- https and 443 only, no credentials, no IP literals, no redirects, size and time caps.
- Denied hosts: `PUBLIC_BASE_URL`, `REDIRECT_HOSTS`, `OIDC_ISSUER`, `workers.dev`, and `SSRF_DENY_HOSTS` (comma list, `plrs.im`).
- Private, link-local, CGNAT, multicast, NAT64, 6to4, Teredo and discard IPv6 ranges are refused after DNS.
- Residual: DNS TOCTOU. The DoH check and the fetch resolve separately, and Workers cannot pin an IP. Cloudflare itself refuses private ranges.
- Not done: per-connection host allowlists.

## Outbound webhooks

- **No holder data in any payload, under any scope.** No name, email, personalization value, raw device id, push token or capability URL. `externalId` is the tenant's own key, sent as is: do not use emails as external ids. A receiver that needs the holder calls `GET /passes/{id}` (scoped, rate limited, audited). A leaked endpoint secret or URL therefore leaks no holder data. The ledger refuses such values, and a test asserts no payload field derives from holder or device columns.
- **Isolation invariant.** An event goes only to endpoints of its own org and mode, and every read of endpoints, deliveries, attempts and the feed is fenced by the caller's org and mode (another tenant's id answers 404). It holds in the schema, not only in code: the journal trigger copies org and mode from the pass row, deliveries reference `(endpoint, org, mode)` and `(feed seq, org, mode)` by composite foreign keys, keys are immutable, the feed is append-only, replay selects with the endpoint's own keys, the sender asserts the payload's org and mode against the endpoint before signing, and a secret's AAD binds it to its endpoint and mode. A test endpoint receives test-pass events only.
- **URL safety.** The rules above apply at save (`422 UNSAFE_URL`, with a DoH check) and again on every attempt. Redirects are never followed. A webhook is a blind, signed POST: the tenant sees a status code and a duration, never a response body. Headers are fixed. Residual: DNS rebinding between the check and the send (see Outbound fetches); the impact is lower here because nothing of the response comes back.
- **Secrets.** Per-endpoint signing secret (`whsec_…`), shown once at creation or rotation, sealed with the envelope scheme and never returned again. Rotation keeps the old secret signing for 0, 24 or 72 hours; each request carries one signature per live secret. Requests are signed over `timestamp.body` (HMAC-SHA-256); receivers reject timestamps more than 5 minutes off and compare in constant time. A manager sees the full URL (it is a capability); readers get the host and `/…` only. Logs and audit rows hold the host only.
- **Scope.** API keys need `webhooks:manage`, which reaches nothing else; `connections:*` and `passes:*` scopes do not reach these routes. The event feed needs `passes:read`.

## Sign-in

- `oidc.trustEmail` is off by default. When on, it applies only if Polaris ID sends `email_verified=true`. Otherwise the address is proven by mail before any account is made or linked. After the proof the browser goes back through Polaris ID, so the first session carries the group roles. Set `oidc.trustEmail` only if the provider verifies emails. The status `oidc` component is degraded while it is on. Trade-off: on, a Polaris ID user whose email matches an account links at once, and a new subject's first sign-in needs no mail.
- Ownership of an address is a `user_emails` row (or a primary email on an account with no Polaris ID identity). A primary email on a provider account is a claim: a mailbox proof never merges into it. The proof gets its own account and the claimant keeps its sign-in with a placeholder `<id>@unverified.invalid` primary (`auth.primary_email_unproven`). `isOwnedByOther` ignores such claims.
- Addresses proven while `oidc.trustEmail` was on keep counting as verified after it is turned off; turning it off does not unprove them.
- Unverified-primary accounts show as "No verified email" (session, admin lists, scanner admin names, verify mail). A claimant is refused when disabled, keeps its account when the proving browser is signed in as it, and is otherwise released once (`auth.primary_email_unproven`). Identity-proof mails are capped per network, per subject and per address. Pre-existing rows were handled at the 2026-11-18 cutover.
- A platform admin naming an address for a user sends a verification link (`user.email_proof_requested`); the address joins the account, and waiting passes attach, only when the user follows it signed in.
- `RL_LOGIN` (OIDC, magic consume, break-glass), `RL_MAGIC_LINK` and `RL_SCAN_PAIR` key on the client's /24 (v4) or /64 (v6). Every other `rateLimit` defaults to the full IPv4 address or the IPv6 /64, so a venue's NAT pool is not one bucket.
- The code-entry failure counter keys on address and browser (10 a day), so a stranger's wrong guesses cannot lock the owner out. A per-address ceiling of 50 failures a day, across browsers, refuses codes only: the emailed link keeps working.
- Turnstile verdicts must name the `PUBLIC_BASE_URL` host and the `magic_request` action (`auth.turnstile_hostname`, `auth.turnstile_action`); only Cloudflare's always-pass test secret skips this.
- Counter keys built from addresses (`magic:*`, `pass-email:*`) are HMACs under a derived key (`counter.*` labels), not bare hashes; old counters expire on their own.
- A Polaris ID email that is only a secondary address of an account is mailed a proof like any unproven claim; the masked main email is shown only after the proof (or when the provider is trusted). A member whose primary an email session moved can link Polaris ID after mail proof to that primary, if the account has no Polaris ID yet (`auth.identity_linked_moved_primary`); the proof must be opened in the browser that signed in.
- Each identity link writes `auth.identity_linked` (provider, how, verified flag; no email).
- Break-glass: a wrong token writes `auth.breakglass_failed` (100 rows/h, then counted only); a success writes `auth.breakglass_used`. Delete `BREAKGLASS_TOKEN_SHA256` to turn the route off (it then answers 404). The status `breakglass` component shows last use and failures today.
- Refused principals write `auth.denied` (admin route as a non-admin, CSRF failure, missing API-key scope; 500 rows/h). Unknown keys and anonymous 401s are logs and Analytics only.

## Mail headers

Org names and the sender name reject controls, line separators and bidi marks at write time. The mailer flattens them again as a backstop. Support links must be https without credentials. DB identities may only bind `APNS_*` names, and a binding counts only if it has `fetch`.

## Public OpenAPI

`/api/v1/openapi.json` stays public: the same contracts ship in the SPA bundle.

## Owner actions

- Keep NFC off on every signing identity until the personalization fix is deployed.
- Polaris ID: stop users editing their own email. Decide whether to turn `oidc.trustEmail` back on.
- Break-glass: delete `BREAKGLASS_TOKEN_SHA256` while unneeded, or put Cloudflare Access or a WAF IP rule in front of `/auth/breakglass*`. Keep `.secrets/breakglass-token` offline.
- After deploy, open the status page: `ratelimits` shows every `RL_*` present; `turnstile` and `breakglass` read as expected.
- GitHub: default workflow permissions read-only, Dependabot alerts and security updates on, `main` protected with the `ci` check required.
- Admin offboarding: remove the user from `wallet_admins` in Polaris ID and revoke their sessions (Admin > Users > Revoke sessions). The role snapshot lasts up to 1 h idle and 12 h absolute.
- Offboarding also revokes organization memberships: each org's Members list, or `DELETE /api/v1/orgs/{id}/memberships/{membershipId}` (`org_admin`, or a platform admin acting as one). A removed `wallet_admins` group does not remove a membership, and a member keeps tenant access until revoked. Revoke the person's API keys and pending invitations in the same pass.
- Role changes in Polaris ID reach a live session only when it ends. A Polaris ID session for a non-admin lasts 7 days idle and 30 days absolute, an admin's 1 h and 12 h. Back-channel logout (Polaris ID P6) is the fix; until then revoke sessions by hand.
- `OIDC_REQUIRE_AMR` ships empty. Set it to `phr` once Polaris ID 2.19.3 or later is confirmed to emit `amr`, and keep emailed login codes off in Polaris ID until then: with them on, mailbox access makes a strong session. See `docs/operations.md`.
- Platform API keys made before 0142 have no expiry or IP list. They keep working and log `API_KEY_PLATFORM_UNBOUNDED` on each use; the console shows "No expiry". Revoke and reissue them. New platform keys need an IP list and an expiry of 30 days or less (90 with `platform:read` alone).
- A platform key cannot act in a personal organization, and only its owner exports it. A platform admin may still close or reopen one. Reads of a personal organization's passes by a platform key are not blocked yet.
- An org export link lasts 1 hour and works once. Pass and bundle links go to another address only when an org admin sends them.
- Deploy and apply new D1 migrations yourself. Agents never deploy or use `--remote`.

## Platform keys

A Platform key (`kind = platform`, no organization, `pbo_`) acts on the control plane. See [Platform Keys](runbooks/platform-keys.md).

**Isolation.** The route gate (key kind and organization), the mint and an insert trigger (no organization-bound row holds a `platform:*` scope, and no row mixes platform and organization scopes), and the grant SQL (a platform grant refuses a key that has an organization) each refuse an organization credential on a platform route. A platform scope is never read as tenant authority.

**Guards.**

| Guard | Rule |
| --- | --- |
| Mint | A platform admin in a Polaris ID session (not break-glass), sign-in within 10 minutes. The mint is the step-up: a key never steps up. |
| Scopes | `platform:*` only, never with an organization scope. Live only, standard rate tier. |
| Expiry | At most 30 days; 90 with `platform:read` alone. |
| IP range | Required, no wider than a /8. A refusal is `INVALID_API_KEY` with no reason. |
| Creator | Live only while the creator is an active user, checked at the gate and again in the grant. |
| Rate | The standard tier plus 60 writes a minute per key on platform routes. |
| Audit | Every write records `api_key`, the key id and no organization; refusals record `auth.denied`. |
| Browser | `KEY_IN_BROWSER` applies. |

**Person-only: never a key** (403 `PERSON_REQUIRED`). Criteria: P1 a safety brake whose release is a judgment; P2 undoes a decision the Polaris ID owner made; P3 irreversible, or fans out across every organization; P4 changes who can sign in or moves a sign-in identity; P5 mints a credential that outlives the key.

| Route | Why |
| --- | --- |
| Freeze Polaris ID | P1: the emergency stop, lifted only in Polaris ID. |
| Clear the SCIM breaker | P1: clearing it is a decision about what tripped it. |
| Offboard, `dryRun: false` | P3: ends memberships, grants, keys and sessions. A dry run is allowed. |
| Lift a hold; remove an external role | P2: overrules the Polaris ID owner. |
| Wallet release enable-ready, `apply: true` | P3: turns on issuing for every ready organization. A dry run is allowed. |
| Platform settings naming `auth.*` or `oidc.*` | P4: decides who gets in. Every other setting is allowed. |
| Revoke a signing certificate | P3: every pass it signed stops updating. |
| Add, remove or promote a person's email | P4. Revoking sessions is allowed. |
| Release a retention hold | P3: a purge can then run. |
| Mint or rotate a platform key | P5. |
| Personal organization, creator organization, enrolment hold and release, migration resolve grants | P2 and P3: SQL-fenced to a platform admin session. |
| Close, reopen and export an organization, export link | P3: strict session routes, never platform routes. |

Declared per route: a platform route without `key` is person-only, and `route-inventory.test.ts` fails until each platform route is on one list. A key never makes, promotes, demotes or removes an administrator, on platform routes or on organization member routes (403 `KEY_CANNOT_ADMINISTER`, checked in the service and in the grant). `PATCH /api/v1/users/{id}` by a key refuses a platform admin target (409 `IDP_PLATFORM_ADMIN`), and `POST /api/v1/orgs` by a key refuses `addMe`.

The Polaris ID platform routes (groups, claims, users, status, invitations) take keys, except freeze, the SCIM breaker clear, hold restore and remove-external, which are person-only, and offboard, which a key may only dry run. A key's writes audit as the key; the `*_by` columns of group, rule, member and role-grant rows name the key's creator, who must be active. A key never reads or writes a platform admin's claims, and never grants a role to one (409 `IDP_PLATFORM_ADMIN`). The users, status and orgs routes take keys too: a key's writes audit as the key, and a `*_by` column names its creator. A key never touches a personal org (403 `PERSON_REQUIRED` on its status, `ORG_PERSONAL` on its page, features, holds and metrics), never closes an org or releases a hold, and never changes a user's emails. `PATCH /api/v1/users/{id}` refuses an admin target (409 `IDP_PLATFORM_ADMIN`) and a user who owns a personal org (403 `PERSON_REQUIRED`).

Platform operations stay out of the public developer portal; the SDKs carry them as `pb.platform.*`.

## Save to this phone

The saved door view (`/p/<token>/barcode`) is one Cache Storage entry per pass, kept 7 days at most and never past the pass's expiry. The page holds no token. "Add to Home screen" makes a plain shortcut with no manifest, so no install service sees the URL; the shortcut URL still lives in launcher and device-backup data, and a revoked link only dies when the shortcut is next opened online.

## Dev advisories

`npm audit` and `npm audit --omit=dev` report 0. Overrides in `package.json` pin `undici` 7.30.1 and `sharp` 0.35.5 inside `miniflare`, and `zod` 4.6.7 inside `@cloudflare/vitest-plugin`. Drop them once the Cloudflare packages ship fixed ranges. `@cloudflare/vite-plugin` stays at 1.64.0: the fixed 1.66.0 is under 14 days old.
