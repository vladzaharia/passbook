# API

Machine API under `/api/v1`. The reference is generated from the code at `GET /api/v1/docs` (JSON,
public; `/api/v1/openapi.json` is the same document). Anyone gets the operations an API key can call; a signed-in platform admin gets all of them. It lists the security schemes and, per operation,
the key scopes that allow it (an operation without an `apiKey` entry is not callable with a key). This
page covers what it does not: conventions, headers, common tasks.

## Quick start

1. Ask your operator for an organization. Sign in, switch the console to Test mode.
2. API keys, Create: Test, scopes `passes:read passes:write templates:read`. Copy the secret.
3. `export KEY=pb_test_...  BASE=https://passbook.mobile/api/v1`
4. `curl -H "Authorization: Bearer $KEY" $BASE/api-keys/me` shows the key's org, mode and scopes.
5. `curl -H "Authorization: Bearer $KEY" $BASE/templates` and pick a `templateId`.
6. A template needs an approved release; a second person approves it in Templates.
7. `curl -X POST $BASE/passes -H "Authorization: Bearer $KEY" -H "Idempotency-Key: b-1" -H "Content-Type: application/json" -d '{"templateId":"...","externalId":"b-1","input":{...}}'`
8. Open the returned `downloadUrl` on an iPhone and tap Add.
9. `curl -X PATCH $BASE/passes/$ID -H "Authorization: Bearer $KEY" -H "If-Match: 1" -H "Content-Type: application/json" -d '{"input":{...},"notify":true}'`
10. `curl "$BASE/passes?externalId=b-1" -H "Authorization: Bearer $KEY"` finds it again. Go live with a Live key.

## Authenticate

1. Admin console, API keys, Create. Pick an org (or none for all orgs), a type, scopes or a role, expiry.
2. Copy the secret (`pb_live_<prefix>_<secret>`). It is shown once; only a hash is stored.
3. Send it as a bearer token. No cookie, no CSRF header.

```
curl "https://passbook.mobile/api/v1/passes" \
  -H "Authorization: Bearer $PASSBOOK_KEY"
```

| Scope | Allows |
|---|---|
| `passes:read` | GET passes, assets, versions, delivery, events, devices, bundles |
| `passes:write` | create, update, void, remove, refresh, assets, resend email, bundles, `POST /passes/bulk-reissue` (an org key rebuilds its own org, `orgId` defaults to it; a platform key must name the org; a test key rebuilds test mode; one active run per target, else 409 `BULK_RUN_ACTIVE` with the run id; 6 starts per key per hour, then 429) |
| `holders:write` | assign, reassign, unassign holders |
| `templates:read` | GET templates |
| `audit:read` | `GET /audit` and `/audit/export` for the key's own organization: Live keys only (a developer sandbox key too), named on the key, never through a role. A key reads at most 90 days at a time (send `from`) and 100 entries a page; an export is 2 an hour per key and 6 an hour across the organization's keys, and leaves an `audit.export` entry. Entries are redacted exactly as for a member. Never `/audit/platform` |
| `templates:write` | clone a blueprint, create a version, request review. A Test key acts as its creator, who must hold `templates:author`; a Live key may only request review |
| `templates:review` | approve a candidate. Test keys only (a Live key is refused at mint, `API_KEY_SCOPE_TEST_ONLY`); the key acts as its creator, who must hold `templates:review` |
| `templates:publish` | release a candidate. Test keys only (refused at mint on a Live key); the key acts as its creator, who must hold `templates:publish` |
| `messages:write` | broadcasts: list, read, create, edit, preview, send, send again, cancel, per-pass items. A `change` also needs `passes:write` |
| `scans:read` | scoped scanner event and scan-log reads; read a roll call |
| `scans:write` | scan from a till as one named terminal (see Scan from a till); start, confirm and end a roll call; org-bound keys only |
| `connections:read` | scoped connection reads |
| `connections:write` | scoped connection changes and actions; setting `autoCreate`, `autoEmail`, `defaultTemplateId`, `mapping` or `onMissing` also needs `passes:write` |
| `webhooks:manage` | read and manage outbound webhook endpoints, deliveries, replay and test events (see Outbound webhooks). Neither `connections:*` nor `passes:*` scopes reach these routes, and this scope reaches nothing else |
| `brand:manage` | read and edit the org's brand kit (`/api/v1/brand`): web logo, accent, mark level. Reaches nothing else |
| `org:read` | read the org's pass setup (`GET /orgs/{orgId}/pass-setup`) and features. Any console member can mint it. Org-bound keys |
| `org:write` | change the org's pass setup (`PATCH /orgs/{orgId}/pass-setup`, `POST /orgs/{orgId}/brand-assets`): name, brand, support, email, allowed channels. Only `org_admin` can mint it |
| `wallet:write` | turn a Google or Samsung account on for a channel that is already allowed (`PATCH /orgs/{orgId}/pass-setup`). Allowing or blocking a channel needs `org:write`. Needs `integrations:manage` to delegate |
| `api-keys:write` | child keys of the calling key: mint, list, read, rotate, retire, revoke; rotate itself. A service key only (see Child keys) |
| `scanning:admin` | Door credentials: pairing codes (`POST /scanners/{id}/pairing`), till tokens (`POST /scanners/{id}/token`), staff (`/scan-staff` list, create, edit, reset PIN), the code on `POST /scanners` and `POST /scanning-sessions/{id}/devices`, and `POST /scanning-sessions/setup` with staff and paired devices. PINs, codes and tokens come back once. Org-bound, live keys only, expiry within 90 days, rate limited. Only an `org_admin` session with Polaris ID sign-in and step-up mints it, by naming it in `scopes`: no role or parent key includes it |
| `nfc:keys` | Secure tag keysets: `/nfc/keysets` list, create, rotate, retire, revoke, re-enrol, disable, import. Generated keys come back once. Live keys of one organization, with an expiry within 90 days. Only an `org_admin` session with Polaris ID sign-in and step-up mints it, by naming it in `scopes`: no role or parent key includes it |
| `scanning:write` | `POST /templates/{id}/scan-setup`: make a template's scanning events and session. Needs `scanning:manage` to delegate, so only `org_admin` can mint it. It reads the event names, venues and dates on the template's issued passes, and reaches nothing else |
| `scan-setup:read` | `GET /scan-setups` and `GET /scan-setups/{id}`: read the org's managed scanner and screen setups. Needs `scanning:read` to delegate. Also `GET /scanners/{id}/pairing`, the pairing poll (never the code). Reaches nothing else; another org's setup is a 404 |

### Token types

| Type | Owner | Secret starts | Rules |
|---|---|---|---|
| Service | the org | `pb_live_` / `pb_test_` | made by a member with `integrations:manage`; expiry optional |
| Personal | one member | `pbp_live_` / `pbp_test_` | made by any member for themself; expiry required, at most 90 days; works only while the membership and user are active, and within the member's current roles; no `scans:write` |
| Platform | the operator, no org | `pbo_live_` / `pbo_test_` | made by a platform admin; expiry required (at most 90 days), IP allowlist required, no roles |

Keys made before this carry `wlt_` and keep working as service (org) or platform (no org) keys, with the same scopes. An older platform key has no expiry or IP list: it is not expired, the console shows "No expiry", and each use logs `API_KEY_PLATFORM_UNBOUNDED`.
A secret scanner can match the labels. Keys are never logged: the logger and audit rows redact every label.

**Personal keys and sessions.** A personal key is its own credential, bounded by the membership and the user, not by a browser session: signing out or revoking a session does not end it. Revoke it, retire it, or remove the membership.

**Keys stay on servers.** A key sent with browser headers is refused: 403 `KEY_IN_BROWSER`, live or test, before the secret is checked. Browser headers are `Sec-Fetch-Site`, `Origin` or a `__Host-wallet_` cookie. curl, Node `fetch`, Python, Go and Workers `fetch` send none of them (`Sec-Fetch-Mode`, `User-Agent` and other cookies do not count). `/api/v1` sends no CORS headers. In the browser, the developer portal's Try it uses a try token (see Developer sandbox).

Two proxy setups forward the browser's headers with your key and get refused:
- nginx `proxy_pass` forwards every client header. Add `proxy_set_header Origin "";`, `proxy_set_header Cookie "";` and `proxy_set_header Sec-Fetch-Site "";` (and the other `Sec-Fetch-*`).
- A Worker or Node proxy that passes the incoming request or its headers on (`fetch(new Request(url, request))`, `http-proxy-middleware`). Build new headers with only what PassBook needs: `Authorization`, `Content-Type`, `Idempotency-Key`, `If-Match`.

Rollout: a key made before 1 December 2026 that is sent from a browser still works until 31 December 2026. The answer carries a `PassBook-Warning` header saying so, and we log `KEY_IN_BROWSER_SEEN` with the org and key prefix. Keys made from 1 December 2026 are refused at once.

**Roles.** `roles` holds role presets: `org_admin`, `integration_admin`, `template_author`, `template_reviewer`,
`template_publisher`, `pass_operator`, `read_only`. The role's scopes are copied into the key's `scopes` when it is made and the role stays as a label: a bundle that gains a scope later never reaches an existing key. A creator can give a role only if every scope in it is within their own roles
(`403 API_KEY_SCOPE_EXCEEDS_CREATOR`). The terminal scope `scans:write` and the credential scopes `scanning:admin` and `nfc:keys` are never in a role: name them in `scopes`.

**Expiry and retirement.** `expiresAt` is fixed when the key is made. `POST /api-keys/{id}/retire` with
`{"orgId": ..., "retireAt": <ms>}` ends the key at that instant, once, never after `expiresAt`
(`409 API_KEY_RETIRE_SET` for a second call). Revoking is immediate and permanent.

**Rotation.** `POST /api-keys/{id}/rotate` with `{"orgId": ..., "overlapHours": 0-168}` (default 24) makes a new key and
retires the old one `overlapHours` later (never after its `expiresAt`), in one batch. The response is `{key, previous}`; `key.secret`
is shown once and works at once. The new key has the old one's stored scopes, roles, mode, addresses, expiry, limits and terminals,
and `rotatedFrom` names the old key. A member can rotate a key only if they could mint it (`403 API_KEY_SCOPE_EXCEEDS_CREATOR`), in
the key's mode (`403 API_KEY_MODE_MISMATCH`); a personal key only its own member. A key that is revoked, retiring or expired is
`409 API_KEY_NOT_ROTATABLE`. Rotate and mint take `Idempotency-Key`: a retry returns the stored key without its secret (`Idempotent-Replayed: true`), so it never makes a second key; a client that lost the response rotates again. A key with `api-keys:write` rotates itself with `POST /api-keys/me/rotate` (`{"overlapHours"}`).

**Child keys.** A service key with `api-keys:write` mints a child with `POST /api-keys` (the same body: `orgId` is the key's own).
The child is narrower than its parent in every dimension: scopes (never `api-keys:write` or `scans:write`: one level only),
mode (the parent's), expiry (not later; omitted means the parent's), `ipAllow` (each range inside one of the parent's; omitted means
the parent's), `templateIds` and `passStyles` (inside the parent's). Anything wider is `403 API_KEY_CHILD_WIDER` or
`403 API_KEY_SCOPE_EXCEEDS_CREATOR`. A key reaches only its own children: `GET /api-keys`, `GET /api-keys/{id}`,
`GET /api-keys/{id}/activity`, `POST /api-keys/{id}/rotate`, `POST /api-keys/{id}/retire` and `DELETE /api-keys/{id}` take a child of
the caller, and any other key is `404 API_KEY_NOT_FOUND`. A child ends with its parent: revoking the parent revokes its children,
and retiring or rotating it retires them at the same instant; a retiring key mints no more (`403 API_KEY_PARENT_RETIRING`). A key holds at
most 50 open children (`422 API_KEY_CHILD_LIMIT`). Revoking a key also revokes the keys it replaced itself with through
`/me/rotate`, hop by hop; a key a person rotated is not touched. A key without `api-keys:write` is `403 MISSING_SCOPE`. A key caller is
not told which member made a key.

**Activity.** `GET /api-keys/{id}` adds the parent, the key that replaced it, its open children and the network of its last use.
`GET /api-keys/{id}/activity` gives the last use, the calls of the last 30 days by action, and the latest calls (time, action, target,
network, and for a refused call its code). It reads the audit log: no request bodies and no secrets. A member needs `audit:read` for it (or
the key is their own personal key); `GET /api-keys/{id}` needs only `integrations:read`.

**IP allowlist.** `ipAllow` lists addresses or CIDR ranges (`203.0.113.0/24`, `2001:db8::/32`), set when the key is made
and never changed; ranges wider than an IPv4 /8 or IPv6 /32, or lists that cover every address, are refused (`422 API_KEY_IP_TOO_BROAD`). A request from any other address, or with none, is `401 INVALID_API_KEY`, the same as a wrong key.
Only `cf-connecting-ip` is read. The key list shows the network of the last use.

**Template and style limits.** `templateIds` and `passStyles` are stored with the key and never change. A limited key reaches
only passes (and their events, scans, prints and webhook endpoints) of its templates: with `passStyles` a template counts when every
one of its styles is allowed, so a template that gains a style drops out; with both, a template must pass both. Limits only narrow:
the key holds no more than the same key without them. A route takes a limited key only where it enforces the limit and answers every
other one `403 API_KEY_RESTRICTED_ROUTE`. Today only `GET /api-keys/me` takes one; the pass, holder, template and webhook routes
adopt the limit as they move to the grant builder's reads and writes. Only pass, holder, template and NFC scopes can be limited.

Tenant list requests name an organization with `orgId`. An org-bound key may omit it (on pass create
and on pass, holder and bundle lists it defaults to the key's org) and must otherwise send exactly
that org; another org is `403`. `GET /delivery` takes `passId` and the same `orgId` rule. A global key
sends `orgId=<org>`, or `orgId=null` for a platform-wide list. A platform-scoped bearer
key has no tenant membership and is authorized by its scopes and each route's organization rules.
Tenant sessions require an active membership with the operation's capability; a platform role
alone does not grant tenant access. Platform-wide administration and organization membership
management use session authorization as described below.

### Rate limits

600 requests per minute per key, in fixed 60-second windows. Every response to a key carries
`RateLimit-Policy: 600;w=60`, `RateLimit-Limit: 600` and `RateLimit-Reset` (seconds until the window
turns over). Past the limit the answer is `429 RATE_LIMITED` with `Retry-After` (whole seconds, at
most 60; wait at least that long, the limiter's windows are not guaranteed to align with the clock), `RateLimit-Remaining: 0` and the same policy and reset. The limiter reports pass or fail
only, so `RateLimit-Remaining` is sent on 429 alone. Other limits (login, scanners, public links) send
`Retry-After: 60` or their own wait on 429 and no `RateLimit-*` headers.

### Request headers

| Header | Where | Meaning |
|---|---|---|
| `Authorization: Bearer <key>` | all key routes | the API key |
| `Idempotency-Key` | pass create, resend, bulk email, bundle email, broadcasts (`POST /passes` refuses keys starting `broadcast-create:`, `bulk-send:` or `rollout-tell:`: 422 `IDEMPOTENCY_KEY_RESERVED`; on `POST /broadcasts`, `rollout-tell:<active release id>` is the console's Tell holders on a message to one template and version, any other use of it is 422, and a second caller on a used one is 409 `TELL_ALREADY_SENT`) | 1 to 200 characters; a retry returns the first result; the same key with another request is 422 `IDEMPOTENCY_KEY_REUSED`, a repeat while the first runs is 409 `IDEMPOTENCY_IN_PROGRESS` |
| `If-Match: <version>` | pass update | optimistic concurrency; stale is `412 VERSION_CONFLICT` |
| `x-passbook-mode` | console sessions | `test` selects Test mode; keys use their own mode |

Scans use the body's `idempotencyKey` (a UUIDv7), not the header.

### Who am I

`GET /api-keys/me` (any valid key) returns `id`, `name`, `prefix`, `scopes`, `kind`, `roles`, `orgId` (null for a
platform key), `mode`, `createdAt`, `lastUsedAt`, `expiresAt` and `retireAt`. Never the secret or its hash.

### Test mode

A key is live or test. It takes the mode the console is in when it is created (the dialog's mode is
the console's mode; a `mode` in the request body is ignored for a session). The secret says which:
`pb_test_...` or `pb_live_...` (older keys: `wlt_`, no marker). The console shows a Test badge, and
`GET /api-keys/me` returns `mode`. An admin session is test when it sends `x-passbook-mode: test`. Lists and
counts show only the caller's mode. A key reads and changes only its own mode; another mode's pass or bundle is
`404`. A session reads either mode by id (`mode` is returned) but changes only the mode it is in: otherwise
`409 MODE_MISMATCH`. Bulk actions skip other-mode passes and list them as `MODE_MISMATCH`. A pass or bundle takes the
creator's mode. Email for a test pass or bundle is never sent: it lands in the Test inbox. A Test key
with `passes:read` reads its own organization's inbox (`GET /test-inbox`, `GET /test-inbox/{id}`); a
Live key is `403 TEST_KEY_REQUIRED`, another organization or a platform key is `403`. The preview
frame and send-to-me need a session. Test data older
than `sandbox.purgeDays` (default 30) is deleted daily.

### Organization memberships

These endpoints require a cookie session; mutations also require the session's CSRF header and
same-origin check. `GET /orgs/memberships/me` lists only the signed-in user's active memberships.
An active organization administrator, or a platform administrator acting explicitly as one, can:

- `GET /orgs/{id}/memberships` (active members) and `GET /orgs/{id}/invitations` (history)
- `POST /orgs/{id}/invitations` with `{ "email": "...", "roles": ["read_only"] }`
- `DELETE /orgs/{id}/invitations/{invitationId}` or
  `DELETE /orgs/{id}/memberships/{membershipId}`

The invitee opens the delivered link and signs in with a verified account address exactly matching
the normalized invited address. Invitations expire after seven days, can be revoked, and are
single-use. The link's token is sent only in the email and stored only as a hash; it is not returned
by invitation APIs. The acceptance page names the organization with `POST /orgs/invitations/preview` and submits the token as `POST /orgs/invitations/accept`. Accepting needs a Polaris ID sign-in, with no email-link grace: the page sends anyone else to `/auth/oidc/start`, and the POST answers 403 `IDP_SIGN_IN_REQUIRED` (`signInUrl` points back to the page). An invitee with no Polaris ID account asks the inviter for access first. Org member lists include each member's name and email. Revocation
is effective on the next membership/capability lookup.
If the mail provider reports a delivery failure, the invitation remains recorded and can be
revoked or replaced; provider acceptance does not prove inbox delivery.

Membership is not inferred from a platform role or owning a pass. A platform administrator may
manage invitations and memberships without acquiring a membership or tenant capabilities.
Tenant lists and forms use an explicit `orgId`; selecting an organization never grants authority.
The console restores its `wallet-org-filter` selection only while it remains a valid active
membership and does not automatically select a sole organization. Switching organizations clears
stale scoped state. A resource detail resolves its actual organization before canonicalizing
navigation, and an explicit conflicting organization is masked.

Global administrators without tenant membership retain platform administration for Users,
Organizations, organization detail, Settings, Status, Identities and API keys, but tenant
surfaces and workspaces require current membership and capabilities. The tenant workspace is
`/admin/orgs/{id}?view=workspace&orgId={id}`; bare organization detail remains platform-only.
The pass wizard selects Apple releases through `/templates/eligible` and pins the reviewed release.

API keys are managed with a session; a key cannot list, create or revoke keys. Platform keys
(`orgId=null`) need a platform admin and no membership. An organization's keys need membership with
`integrations:read` (list) or `integrations:manage` (create, revoke) in that org; any member can create and
revoke their own personal key; a platform
admin without membership cannot manage them. A creator can delegate only scopes their own roles
grant (`403 API_KEY_SCOPE_EXCEEDS_CREATOR`); a platform admin can delegate any. Overview and audit `orgId` values are explicit platform
filters and never grant tenant authority.
Select the platform with `orgId=null` in GET or DELETE queries and `"orgId": null` in POST bodies;
select a tenant by its explicit org ID.

Platform `GET /orgs`, `GET /orgs/{id}` and `POST /orgs/{id}/status` return directory and
lifecycle fields only: `id`, `slug`, `name`, `status`, `personal`, `personalOwner`, `createdAt`, `counts` and `countsCapped`.
Every platform admin gets one personal org on OIDC sign-in (`personal: true`; `personalOwner` is the user, platform views only). Its owner sees it named "Personal" in `GET /orgs/memberships/me`; the stored name is the owner's. The slug prefix `personal-` is reserved (`400 ORG_SLUG_RESERVED`). A personal org has one member, its owner: inviting to it or revoking the owner is `409 ORG_PERSONAL_SINGLE_MEMBER`.
`GET /orgs/{id}/workspace` returns the full tenant organization summary and requires `org:read`
membership. Organization updates, branding and organization-settings writes require `org:manage`;
organization-settings reads require `org:read`.

Org and organization-settings reads return `configRevision`. Send it back as `configRevision` in
`PATCH /orgs/{id}`, `PUT /orgs/{id}/branding/{slot}` and `PUT /settings` (org scope): a save made from
older values returns 409 `SETTINGS_CHANGED`, so refetch and retry. The field is optional; clients that omit
it are checked against the revision the server reads in the same request, which only catches a write that
lands mid-request.

The server-owned role mapping unions capabilities when a membership has multiple roles:

| Role | Capabilities in addition to `org:read` |
|---|---|
| `org_admin` | All capabilities below, plus `org:manage`, `members:read` and `members:manage` |
| `integration_admin` | `integrations:read`, `integrations:manage`, `templates:read`. Turning on a connection's issuing switches (`autoCreate`, `autoEmail`, `defaultTemplateId`, `mapping`, `onMissing`), and changing the source of one that issues or has bound passes (config, secrets, webhook secret or its rotation, mode, `holderEmailField`, re-enabling), also needs `passes:operate` (a key needs `passes:write`). Turning issuing off does not |
| `template_author` | `templates:read`, `templates:author` |
| `template_reviewer` | `templates:read`, `templates:review` |
| `template_publisher` | `templates:read`, `templates:publish` |
| `pass_operator` | `templates:read`, `passes:read`, `passes:operate`, `messages:read`, `messages:manage`, `scanning:read`, `audit:read` |
| `read_only` | `integrations:read`, `templates:read`, `passes:read`, `messages:read`, `scanning:read`, `audit:read` |

`org_admin` also has `scanning:manage`. Clients cannot submit capabilities directly. Subsequent
server modules can import `getOrgAccess(ctx, userId, orgId)`,
`requireOrgCapability(ctx, userId, orgId, capability)` and `listMyOrgMemberships(ctx, userId)`
from `src/worker/modules/orgs/access.ts`; each queries current active membership, user and org
state. `requireOrgManager(ctx, session, orgId)` is the separate platform-or-org-administrator
management check and must not be used as a general tenant capability grant.

## Changes for existing clients

Dated changes are in the [changelog](/developers/changelog) (`docs/api/changelog/`, one file per release date). `/api/v1` changes additively unless a dated `PassBook-Version` carries the change (`docs/api/versions.json`). Send `PassBook-Version: 2026-11-22` to opt in to every dated change (`2026-11-20` for the first only); without it behaviour is unchanged, and an unlisted date answers `422 API_VERSION_UNKNOWN`. `info.version` in the reference is the newest version date. A fix that stops a request from reaching more than it asked (a refused filter, say) ships to every client without a version and is listed as breaking in the changelog.

- **Unreleased, managed Apple identities**: `GET /wallet-identities`, `POST /orgs/{orgId}/identities/apple`
  (202, `Idempotency-Key`, needs the `identity.managed` feature), `POST /identities/{id}/renew`,
  `GET /identities/{id}/certificates`, `POST /identities/{id}/revoke-certificate`, `/identity-runs`
  (list, get, retry, cancel) and `GET /platform/apple-calls`. `PATCH /identities/{id}` takes
  `rotation` (`auto` or `manual`) and `issuing`; an identity gains `kind`, `status`, `rotation`,
  `issuing`, `nextRotationAt` and `handle`. All are for signed-in people: a platform admin, or an
  organization member for their own organization. Keys are not accepted yet.

## Conventions for new routes

- **Status**: creating a resource returns `201`; queuing a job returns `202` and names the job
  or resource to poll; an action on an existing resource returns `200`. `POST /roll-calls` answers
  `201` under `PassBook-Version: 2026-11-20` and later, `200` without it. `POST /offboard` is an action and stays `200`.
- **Lists**: return `pageOf(item)` (`{ items, nextCursor }`) and take `cursor` and `limit`. Use
  `after` only for an ordered stream.
- **Time filters**: `createdAfter`, `createdBefore`, `updatedSince`, in ms.
- **Path ids**: one name per resource, `{id}` or `{orgId}`; never both for the same path.

## Signed webhooks

Inbound connector webhooks (`POST /hooks/connections/{id}`) are signed with the connection's webhook
secret. Sign the raw request body:

```
ts=$(date +%s)
sig=$(printf '%s.%s' "$ts" "$BODY" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" -hex | sed 's/^.* //')
curl -X POST "https://passbook.mobile/hooks/connections/$CONNECTION_ID" \
  -H "x-passbook-timestamp: $ts" -H "x-passbook-signature: v1=$sig" \
  -H "Content-Type: application/json" --data-binary "$BODY"
```

The older `x-wallet-timestamp` and `x-wallet-signature` are accepted too. The MAC is HMAC-SHA-256 over `<timestamp>.<raw body>`, hex, prefixed `v1=`. The timestamp is in
seconds; the server refuses one older than 5 minutes or more than 1 minute ahead, a body over
256 KB, and a signature that does not match (constant-time compare). Use the exact bytes you
send: re-serializing the JSON changes the MAC. Rotate the secret with
`POST /connections/{id}/webhook-secret`.

## Errors

`application/problem+json`:

```json
{ "type": "…", "title": "Unprocessable", "status": 422, "code": "VALIDATION",
  "detail": "…", "requestId": "…", "issues": [{ "path": "input.holder", "message": "Required" }] }
```

Branch on `code`, not `detail`. Quote `requestId` when asking for help.

`KEY_IN_BROWSER` (403): an API key was sent with browser headers. Call from your server; a proxy must strip `Origin`, `Sec-Fetch-*` and `Cookie` (see Authenticate).

`FEATURE_NOT_INCLUDED` (403) carries `feature`: the organization's plan lacks it, so ask PassBook to turn it on. Every key call of an organization also needs its `api` feature: `off` refuses all, `read` allows only GET and HEAD (so `POST` reads such as `/broadcasts/preview` and `/scan/lookup` are refused too), `full` allows all. Platform-wide keys are not limited by it. Operations that need a feature carry `x-feature` in the OpenAPI document.

Delivery features follow the plan too: Google and Samsung Wallet (`wallet.google`, `wallet.samsung`), `print` and `nfc` (Basic to bind tags, Secure to create keysets). A channel the plan lacks reads `{ "on": false, "source": "platform", "reason": "not_included" }`, creating a print, binding a tag or turning `nfc.tags` on answers `FEATURE_NOT_INCLUDED`, and the settings entry for `nfc.tags` carries `blockedByPlan`. A downgrade only pauses: passes, copies, printed tickets and tag bindings stay (a printed ticket and a bound tag still admit at the door), only new prints, binds and wallet offers are refused, and an upgrade turns them back on.

Managed Apple identity errors: `IDENTITY_ALREADY_PROVISIONED` (409, the org has one), `IDENTITY_HANDLE_RESERVED` and `IDENTITY_HANDLE_INVALID` (422, choose another handle), `IDENTITY_HANDLE_TAKEN` (409), `IDENTITY_NOT_ROTATABLE` (409, only a managed identity with a certificate renews automatically), `IDENTITY_NOT_READY` (409, no certificate yet), `IDENTITY_RUN_OPEN` (409, only a failed or cancelled run retries), `IDENTITY_RUN_CLOSED` (409, the run already finished), `IDENTITY_RUN_NOT_FOUND` (404), `IDENTITY_CONFIRM_MISMATCH` (422, type the pass type ID), `IDENTITY_CERT_NOT_FOUND` (404) and `IDENTITY_CERT_NOT_REVOCABLE` (409, only a superseded certificate issued by Apple). `ORG_REQUIRED` (422) on the two lists means a member must name their organization.

`FEATURE_LIMIT_REACHED` (403) carries `feature`, `limit` and `used`: a create would pass the organization's cap for that feature. It covers live and test passes, templates, members (pending invitations count), API keys, scanner devices, webhook endpoints, connections, broadcasts a day and join cards a day (a join visitor sees only the daily-limit answer). A downgrade never removes anything: what exists stays, only new creates are refused, and a removed or revoked item frees its slot. A pass import that reaches the limit stops creating: it reports the rest as `skipped` (`progress.skipped`, row code `FEATURE_LIMIT_REACHED`) and still applies its updates. A connection sync records each refused record as failed and goes on. Daily limits count per mode, so test-mode work never uses up the live allowance. Emails a day (`email.perDay`) lower the organization's own daily email cap and answer `EMAIL_RATE_LIMITED`.

## Developer sandbox

`POST /api/v1/developer/sandbox` (a signed-in person: session, CSRF and a Turnstile token; never a key) makes your sandbox, once per person: a `developer` organization with you as admin, a Test personal key (`pbp_test_...`, 30 days, the secret shown once) and a "Quickstart ticket" template released in Test. `GET` reads it back, with `turnstileSiteKey` for the check that makes one. A repeat `POST` finishes a sandbox a failed request left half made and returns it; the key is minted once, so the repeat has `key: null` and `previousKey`: roll it. `DELETE` closes your sandbox (read-only, keys revoked); it is not made again.

**Try tokens.** `POST /api/v1/developer/try-token` (signed-in person, CSRF) returns `{ token, expiresAt }`: a `pbtry_` bearer that acts as your sandbox's Test key for 15 minutes, and the one bearer a browser may send. It works only beside the session cookie it was made for, so it cannot be used from curl or another machine. Audit rows of its writes carry `via: "try"`. It ends at expiry, sign-out, a revoked session, a revoked, expired or retired key, a closed sandbox, or `DELETE /api/v1/developer/try-token` (ends every try token of your sandbox). Routes for a signed-in person never take it, except the request log and rail below. Minting and using share `RL_API_TRY`: 60 a minute per session. The portal keeps it in memory and refreshes it at 12 minutes; never store it or put it in a URL.

**Request log.** `GET /api/v1/developer/logs` lists the Test calls your sandbox's key made: method, route, path, status, `code`, duration and request id, newest first, for 7 days. Filters: `status` (`2xx`, `4xx`, `5xx` or one status), `code`, `path` (anywhere in it), `method`, `keyId`, with `cursor` and `limit`. `GET /api/v1/developer/logs/{id}` adds the request and response bodies for the first 24 hours (`hasBodies`, `bodiesExpireAt`). Bodies are JSON in which only known-safe fields (ids, states, kinds, codes, versions, times, counts) keep their value; every other value is `[redacted]`, and a body over 16 KB or not JSON is a one-line marker. Only a developer organization's Test calls are logged: a Live call or a real organization's call writes nothing. A sandbox records at most 2,000 calls an hour and 20,000 in all; past that `capped` is `hour` or `total` and newer calls are not recorded until the hour turns or older rows expire. `GET /api/v1/developer/rail` returns the key's mode, scopes, rate tier and the calls of the last hour. All three read your own sandbox with the session, or with the try token beside it; a real API key is refused (401). Rows are written after the response (`waitUntil`), so a call is never slower for it. A call refused before its key is known (401, a missing scope) is not logged.

**Public status.** `/developers/status` (and `/developers/status.json`) shows components (API, Apple push, email, webhook delivery, and Google or Samsung Wallet once a platform credential exists) as operational, degraded, outage or not enabled, and incident notes. No organization, count or identity is in it. Incident notes are rows of `status_incidents`; see `docs/operations.md`.

A sandbox pass is a preview. Nothing in a sandbox is ever signed, added to a wallet, pushed or mailed: issue and send calls answer with the same shapes, `downloadUrl` is the TEST preview page (`/preview/<link>`, a signed link that expires after 30 days; the page is noindex and has no Add button), pass detail carries `testPreview: true`, and mail lands in the test inbox. `GET /p/<token>/pass.pkpass` answers `SANDBOX_PREVIEW_ONLY` (409). A sandbox never holds Live: a Live key or request is refused. Its plan is the `developer` preset (500 test passes, 10 templates, 3 webhook endpoints); a create at a cap answers `SANDBOX_QUOTA` (403) with `feature`, `limit` and `used`, as `FEATURE_LIMIT_REACHED` does elsewhere. A sandbox with no activity for 90 days closes.

## Approved template releases

`GET /api/v1/templates/eligible?orgId=<org>&mode=live&provider=apple` returns a bounded page
of choices usable by that organization and mode. Optional `limit` is 1–200 (default 100);
pass `nextCursor` as `cursor` for the next page. A session needs `templates:read` or `passes:read`
in the selected organization; an API key needs either corresponding scope and must cover that org.
The requested mode must match the session header or API key mode. This picker is Apple-scoped.

```json
{ "items": [{ "templateId": "…", "name": "…", "templateOrgId": null,
  "origin": "baked", "releaseId": "…", "releaseGeneration": 1, "version": "…",
  "candidateHash": "…", "supportsCheckIn": true }], "nextCursor": null }
```

The list includes org-owned and shared uploaded templates only when the selected org has its own
approved release, and generated baked templates with a trusted system release. Blueprints are never
listed. It never falls back to another org's release or an unapproved draft. `supportsCheckIn` is derived from the
released version. Issuance rechecks the selected release and its assets.

An upload with no organization is staged: only platform administrators see it. `POST /templates/{id}/share`
with `{shared: true}` (platform administrator) offers it to every org, `{shared: false}` stages it again;
an org that already holds a candidate or release of it keeps seeing it. Baked templates are always shared.

For an uploaded template, a `templates:author` session creates a candidate with
`POST /templates/{id}/candidates` and `{orgId, mode, provider: "apple", version}`. A different
`templates:review` session approves it at `/templates/{id}/candidates/{candidateId}/approve`
with `{orgId, mode, provider, candidateHash}`. A `templates:publish` session posts to
`/templates/{id}/releases` with `{orgId, mode, provider, candidateId, approvalId, candidateHash,
expectedGeneration}`. Use generation `0` for the first release and the current scoped generation
thereafter. `GET /templates/{id}/candidates` and `/templates/{id}/releases` accept the same scope
as query parameters and expose candidate approvals and release history; people appear by name
(`authorName`, `reviewerName`, `createdByName`).
`POST /templates/{id}/release` does the three steps for both modes in one call: `{orgId?, version, modes?, expected?, request?}`
(a `templates:publish` session, or a Test key holding `templates:write`, `templates:review` and `templates:publish`; a Live key
cannot release). Test runs first, then Live. Each mode creates or reuses its candidate, reuses or writes an approval (`test` in Test,
`sole` in Live only for the sole reviewer) and publishes at `expected` (default: the current generation). Test follows Live: a Test
head newer than Live's previous version stays and answers `test: kept`. Without a usable approval the answer is 409
`TEMPLATE_REVIEW_REQUIRED` with `plan`; what already ran stays, and the same call resumes. `modes` defaults to `["live","test"]`
for a person and `["test"]` for a key or a developer org, which may not name Live. `Idempotency-Key` is required: the same key and
body replays the first answer, the same key with another body is 422 `IDEMPOTENCY_KEY_REUSED`. `?dryRun=true` returns `{version,
modes, diff, fromVersion, state}` (steps, passes and devices reached per mode, a grouped diff) and writes nothing. `request: true`,
or `POST /templates/{id}/review-requests` (`templates:write`), creates or reuses the candidates without approving.
`GET /templates/{id}/releases/impact?orgId&mode&provider&version` returns what a publish or rollback to
`version` changes: `passes` (`{count, capped}`: the org's passes in that mode not yet on it, counted up to
10,000) and a semantic `diff` of `fields`, `images`, `barcode` and `colors`, each change
`{label, kind, from, to}`; `more` counts changes beyond the 50 listed per group.

Google and Samsung projections use these same candidate, approval, release and rollback routes.
Creating a native candidate adds `sourceReleaseId` and the provider-specific `projection` object.
It binds the exact effective Apple release and configured provider-account revision and identity;
the candidate response exposes those bindings and the normalized projection for review. An
independent reviewer must approve that candidate. A source release or account change makes the
projection ineligible until a new candidate is reviewed and published.

A Google candidate sends `projection: {schema: 2, provider: "google", approvedOmissions}`. The
server compiles the version and stores the pins: compiler revision, a hash of the version's
`wallets` block, a hash of the fidelity report and the omissions. `approvedOmissions` must name
exactly the omissions the report has (`capability` or `capability@path`), else the candidate is
refused with `WALLET_PROJECTION_CONFLICT`; a target that is off or blocked gets
`WALLET_PROJECTION_BLOCKED`. Approval and publication need the pins as they are then; a compiler
update re-opens review. A published Google release whose compiler later adds an omission pauses new
offers until a new candidate is approved; updates to passes already on the wallet continue. Schema 1
Google candidates cannot be published (`WALLET_PROJECTION_SCHEMA`). Publication does not enable
issuance: the provider gate and offers stay closed.

Samsung publication requires fresh, candidate-specific provider verification and a schema 1
projection until its runtime moves to the compiler. Configuration or an admin assertion alone does
not establish provider readiness.

Rollback is `POST /templates/{id}/releases/rollback` with `{orgId, mode, provider, releaseId,
candidateHash, expectedGeneration, reason}`; `reason` is a nonblank string of at most 500
characters and is recorded in the audit event. Rollback appends a new generation, not a pointer
rewind. An archived org-owned template may be restored in Live mode by rolling back to its current
approved head; that also creates a new generation. An archived template with no approved Live release as its head is restored with
`POST /templates/{id}/restore` (`restorable` on the detail). Candidate-only, Test-only and legacy history do
not block it; a shared template needs a platform administrator. There is no activate route. A released candidate cannot be republished
directly; use rollback or a new reviewed candidate. Uploads and version edits remain drafts.

### Release state

`GET /templates/{id}` returns `release` for an uploaded template the caller's org can release
(not for baked templates, blueprints or staged uploads). The server computes it; clients read it
rather than deriving it from candidates and releases.

```json
{ "live": { "version": "v1", "at": 1763700000000, "by": "Alex Kim" },
  "test": { "version": "v2", "at": 1763710000000, "state": "ahead" },
  "draft": { "version": "v2", "at": 1763705000000 },
  "review": { "state": "open", "version": "v2", "by": "Sam Rivera", "at": 1763706000000 },
  "alone": false, "next": "review" }
```

- `live` and `test` are the Apple heads. `test.state` is `ahead` when Test holds a newer version
  than Live (a Try), otherwise `following`.
- `draft` is the newest valid saved version when it is newer than Live.
- `review` covers the draft in Live: `open` is an unreleased candidate with no independent
  approval, `approved` has one.
- `alone` is the sole-approval rule for the caller: they author, review and publish, are the org's
  only review-capable member, and no reviewer was removed in the last 7 days. The database still
  decides at commit.
- `next` is the caller's step: `design`, `try` (no Live head and Test lacks the draft), `release`,
  `request_review`, `review`, `wait` (in review, or approved for someone else to publish), or
  `null` (nothing newer than Live, or no template capability).

`POST /templates/{id}/candidates` returns the existing unreleased candidate when the same author
already sealed the same version, content and release policy in that scope, with its approvals,
instead of creating a duplicate.

## Google and Samsung Wallet providers

Provider accounts and projections are scoped by `orgId`, `mode` (`live` or `test`) and
`provider` (`google` or `samsung`), independently of Apple identities. The account routes require
a verified cookie session with active organization membership, not an API key or platform-admin
override. The session mode must match the requested mode; writes also require CSRF and
same-origin checks. Under `/api/v1/wallet-providers/accounts`:

| Method and path | Input | Required capability |
|---|---|---|
| `GET /` | query `orgId`, `mode`, `provider` | `integrations:read` |
| `PUT /` | `{orgId, mode, provider, expectedRevision, credentials}` | `integrations:manage` |
| `POST /verify` | `{orgId, mode, candidateId, candidateHash}` | `integrations:manage` |
| `POST /revoke` | `{orgId, mode, provider, expectedRevision}` | `integrations:manage` |

Use revision `0` for initial configuration and the current revision thereafter. Google credentials
are `issuerId`, `serviceAccountEmail`, `privateKeyPem` and `scopes` containing exactly
`https://www.googleapis.com/auth/wallet_object.issuer`. Samsung credentials are `partnerId`,
`certificateId`, `cardId`, `partnerPrivateKeyPem`, `partnerCertificatePem` and
`samsungCertificatePem`. Credentials are encrypted and never returned. The Google issuer identity
and Samsung partner/card identity cannot be changed by rotation. Revocation returns
`409 WALLET_ACCOUNT_INSTANCES_ACTIVE` until linked instances are retired.

Account readiness is `absent`, `configured` or `revoked`, with `externalApprovalVerified: false`.
Configuration and user assertions are not provider proof. `POST /verify` probes a reviewed Samsung
candidate and returns `{verified, verifiedAt, expiresAt}`; it checks authenticated `state=ACTIVE`
and `testingModeOff=Y` evidence bound to the candidate, account, card, type, subtype and
headquarters country, valid for at most five minutes. Such evidence can establish card publication
but not recipient-market eligibility or account-level approval. Samsung offers remain unavailable.
Google publishing approval and replay-safe Save behavior remain unverified, so Google publication
and offers remain unavailable. An expired offer redirect does not prove a disclosed Google Save
link cannot be replayed.

The provider projection uses the existing independently reviewed release lifecycle above and binds
the source Apple release, its generation and hash, the provider account and revision, identity and
adapter policy. Google GenericObject and Samsung loyalty/others projections accept only supported
generic fields and no barcode or UTF-8 QR; unsupported semantics fail closed. Source, account,
policy or evidence changes can make a projection ineligible.

`GET /api/v1/wallet-providers/passes/{id}` reads the selected pass's Google and Samsung instance
status. A session needs active membership with `passes:read` in the pass's organization; an API
key needs `passes:read` and organization access. For both, the selected mode must match the pass
mode or the route returns `404`. The response is `no-store` and contains `credentialGeneration`
and a fixed `providers` pair, Google followed by Samsung:

- `lifecycle`: `absent`, `blocked`, `ready`, `active`, `revoking`, `revoked` or `retired`.
- `desiredOperation`: `null` or `{version, kind, state, reason}`. `kind` is `upsert` or `revoke`;
  `state` is `pending`, `claimed`, `retry`, `succeeded`, `failed`, `superseded` or `uncertain`.
  `reason` is `null` or one of `ok`, `not_issued`, `rate_limited`, `unavailable`, `timeout`,
  `unauthorized`, `rejected`, `invalid_response` or `provider_error`.
- `priorGenerationRetirementPending`: whether an older scoped instance has not satisfied the
  canonical retirement-settled predicate. This includes unresolved operations, missing required
  tombstones and Google replay-policy limits; a never-issued instance requires proof. Settlement
  does not prove device deletion. `installation` is always `unknown`.

`absent` means no current-generation instance was observed, not that the account is unconfigured.
`ready` and `active` are local lifecycle states; neither they nor an accepted operation prove
publication, recipient-market eligibility, installation or device deletion. The response excludes
IDs, credentials, references, tokens, URLs, personal data and raw provider or callback data.

The public capability route is `GET /p/{token}/wallet/{provider}`; when an offer is eligible,
pass pages and pass email can link to it alongside the existing Apple action. They do not embed
provider bearer material. The Samsung wrapper `GET /p/wallet/samsung/{offer}` uses a short-lived,
single-use reference. Neither a link nor provider acceptance establishes installation.

`GET /w/i/{sha256}.png` is public and rate limited. It serves only derived template art (never a
personal image) as an immutable PNG; the hash is the only address. Unknown hashes are 404.

Each provider identity is bound to a positive credential generation. At holder-transfer start, the
pass generation advances to reserve the target, the old holder link is revoked, a pending transfer
is recorded and retirement of old provider identities is staged. The reserved generation remains
blocked until all old retirements are safely settled; the final compare-and-swap assigns the new
holder and credentials under that reserved generation and completes the transfer. Provider
eligibility gates still apply. Samsung callback tombstones are preserved, and generations never
reuse provider IDs, references or tokens. A potentially issued or disclosed Google object remains
held without proven replay-safe retirement; a strictly proven never-issued placeholder may retire
locally. Samsung provider acceptance establishes neither physical deletion nor recipient-market
eligibility.

Google's signed save/delete callback is `POST /wallet/v1/google/{accountId}`; set the absolute
URL as the account's GenericClass `callbackOptions.url`. It verifies ECv2SigningOnly signatures;
events identify a class and object, not a particular holder.
Samsung's server interaction is `GET` or `POST /wallet/v1/samsung/cards/{cardId}/{refId}`;
its authenticated path-bound authorization does not authenticate query fields or callback bodies.
Only already-promoted Samsung references may refresh under current approved bindings. A retained
Data Fetch reference can remain reusable after first fetch: protect it as a secret. For both
providers, installation remains unknown absent authenticated authoritative holder-specific
evidence. Routes must be deployed before use; see [operations](operations.md#google-and-samsung-wallet-accounts).

### Google managed and shared issuers

A Google credential has a `provenance`: `platform` (PassBook's own), `managed` (a child issuer
PassBook made, named "<Org> via PassBook") or `own` (the org's issuer). Managed and shared issuers
sign with PassBook's service account; no key changes hands, and the org credential follows the
platform key's rotation.

| Method and path | Who | Notes |
|---|---|---|
| `POST /api/v1/orgs/{orgId}/wallet-accounts/google/managed` `{mode: "live"}` | org member with `integrations:manage`, live session, `identity.managed` | 202 with a run. `GET` on the same path reads the latest run |
| `POST /api/v1/platform/orgs/{orgId}/wallet-accounts/google/managed` | platform admin | Same run, no plan check |
| `POST /api/v1/platform/orgs/{orgId}/wallet-accounts/google/managed/complete` `{issuerId}` | platform admin | Finishes a run that waits with `google_manual_issuer` |
| `POST /api/v1/orgs/{orgId}/wallet-accounts/google/shared` `{issuerId}` | org member with `integrations:manage` | Checks `issuer.get` with PassBook's service account. `GET` returns the address to add as a user of the issuer |
| `POST /api/v1/platform/wallet-credentials/{id}/rotate-key` | platform admin | Starts a service-account key rotation; the first success arms the 90-day schedule |

A run is `queued`, `running`, `waiting`, `succeeded` or `failed`. Until PassBook is a trusted
aggregator, Google refuses `issuer.insert` and the run waits as `google_manual_issuer`: a platform
admin makes the issuer in the Google Pay & Wallet Console, shares it with PassBook's service
account, then completes the run with its id.

Error codes: `WALLET_PLATFORM_CREDENTIAL_MISSING` (409, no PassBook Google credential for the
mode), `WALLET_ISSUER_EXISTS` (409, the org already has a Google issuer), `WALLET_ISSUER_CLAIMED`
(409, another org holds the issuer), `WALLET_ISSUER_NOT_WAITING` (409), `GOOGLE_ISSUER_NOT_SHARED`
(422, add the service account to the issuer), `GOOGLE_UNAVAILABLE` (502), `FEATURE_NOT_INCLUDED`
(403, `identity.managed` is off).

## Create a pass

```
curl -X POST https://passbook.mobile/api/v1/passes \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Idempotency-Key: member-000123-v1" \
  -H "Content-Type: application/json" \
  -d '{ "templateId": "<template id>", "externalId": "member-000123",
        "input": { "holder": "Alex Morgan", "memberId": "000123" },
        "holderEmail": "alex@example.com", "sendEmail": true }'
```

An org-bound key sends no `orgId`, `mode` or release fields: the key's org and mode apply and the
effective approved release is used (see Changes for existing clients).

- `input` is validated against the template's `inputs` schema. `GET /api/v1/templates/{id}/input-schema` returns it as JSON Schema (key scope `templates:read`).
- `Idempotency-Key` (1 to 200 chars): a retry with the same key and body returns the first result.
  The same key with a different body is 422 `IDEMPOTENCY_KEY_REUSED`.
- `templateId` must be a template. A blueprint answers 409 `TEMPLATE_IS_BLUEPRINT`
  (`docs/design/blueprints-and-templates.md`).
- Optional: `serial` (honored only on your own signing identity), `externalId` (your key, any time), `identityId`, `connectionId` + `externalRef` (connection-created passes only).
- `externalId` is your own key. `GET /passes?externalId=` returns the passes with exactly that value
  (case-sensitive, inside the key's org and mode). It is not unique by default. A template whose
  manifest sets `"externalId": { "unique": true }` allows one pass per value, per org and mode: a
  create or update that repeats it is `409 EXTERNAL_ID_TAKEN`. Deleted passes release their value;
  voided and removed ones keep it.
- `serial` is honored only for passes on the org's own Apple identity (409 `SERIAL_TAKEN` on a repeat). On an identity shared by orgs the server generates the serial and ignores the field; use `externalId` for your own key.
- The response carries the pass id, the download link and the current `version`.

An authorized pass detail or retained-version read returns `409 PASS_TRANSFER_PENDING` while
credential retirement is pending; pass lists omit those passes. The same response applies to an
idempotent issuance replay during a transfer, without disclosing the reserved link or prior
holder content. Retry after the transfer completes; a stale read returns `409 PASS_CONFLICT`.
Current pass details include `reissueRequired`, true only while an eligible verified waiting
holder needs a replacement because its credential cannot be safely rotated. It does not mean the
holder has been attached.

## Import passes

Bulk create and update from a CSV, over `/api/v1/pass-imports`. Create, check, commit and discard need
`passes:operate` (a session) or `passes:write` (a key); reads need `passes:read`. Send `orgId` as a query
parameter (an org-bound key needs none). An import belongs to the caller's mode.

| Route | Notes |
|---|---|
| `POST /pass-imports` | `{ templateId, source, plan? }`. `source` is `{ kind: "file", name, csv }` (up to 2,000,000 bytes) or `{ kind: "url", url }` (https). With a `plan`, or a mapping saved for the template, it is checked at once (`state: "ready"`); otherwise `mapping` with the `columns`. 30 an hour per org and mode. |
| `POST /pass-imports/{id}/check` | `{ plan }`: `mapping`, `holderEmail`, `externalId`, `match` (`externalId`, `email`, `none`), `keepManual`, `save`. 120 an hour. |
| `POST /pass-imports/{id}/commit` | `{ skipInvalid, email }`. Starts the run; a repeat returns the running import. 409 `IMPORT_HAS_ERRORS`, `IMPORT_BUSY`, `IMPORT_EXPIRED`, `IMPORT_STATE`. |
| `GET /pass-imports`, `GET /pass-imports/{id}` | State, `counts`, `progress`, `problems` (first 100, errors first), `previews`. Poll `state` until `done`, `failed` or `stale`. |
| `GET /pass-imports/{id}/rows?state=` | 100 a page: `result`, `passId`, `code`, `message`. |
| `GET /pass-imports/{id}/errors.csv` | The rows that failed the check, columns kept, with a Problem column. `no-store`; 410 `IMPORT_FILE_GONE` after a day. |
| `GET /pass-imports/{id}/results.csv` | Row, result, pass id, links. Session only in practice: the links are capabilities, so a key's read scope is refused (403). |
| `POST /pass-imports/{id}/remove-created` | Session only. `{ cursor }`, 50 a call; loop on `nextCursor`. Edited or scanned passes are skipped (`IMPORT_PASS_CHANGED`, `IMPORT_PASS_SCANNED`). |
| `POST /pass-imports/{id}/email-rest` | `{ cursor }`, 50 a call. Mails created passes that went out without mail; a repeat mails nobody twice. `skipped` counts mail held back by the daily or hourly cap. |
| `DELETE /pass-imports/{id}` | Discards a draft that is not running. |

```
curl -X POST "https://passbook.mobile/api/v1/pass-imports" \
  -H "Authorization: Bearer $PASSBOOK_KEY" -H "Content-Type: application/json" \
  -d '{ "templateId": "<template id>",
        "source": { "kind": "file", "name": "people.csv", "csv": "Name,Ref\nAna,A1\nBen,A2" },
        "plan": { "mapping": { "holder": { "from": "/Name" } },
                  "holderEmail": null, "externalId": { "from": "/Ref" },
                  "match": "externalId", "keepManual": false, "save": false } }'
# state "ready" with counts; fix errors or send skipInvalid, then:
curl -X POST ".../pass-imports/$ID/commit" -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "Content-Type: application/json" -d '{ "skipInvalid": false, "email": false }'
```

Column pointers are `/` plus the header (`~` as `~0`, `/` as `~1`). Row problems carry `row` (the
spreadsheet row; the header is row 1), `column`, `code` and a one-sentence `message`. A cell starting with
`=`, `+`, `-` or `@` (after any spaces) is written back with a leading `'` in CSV downloads and read back
without it. Guide: [importing-passes.md](importing-passes.md).

## Update a pass

`PATCH /api/v1/passes/{id}` with `If-Match: <version>`. A stale version returns 412
`VERSION_CONFLICT`: re-read and retry. A changed pass is rebuilt and pushed to its devices.

```
curl -X PATCH https://passbook.mobile/api/v1/passes/$ID \
  -H "Authorization: Bearer $PASSBOOK_KEY" -H "If-Match: 3" \
  -H "Content-Type: application/json" \
  -d '{ "input": { "points": 1300 } }'
```

## Stamp cards

On a template with `manifest.stamps`, `GET /api/v1/passes/{id}` carries `stamps` (`input`, `goal`, `count`, `card`, `ready`, `maximum`), counted by the pass's own template version.

`POST /api/v1/passes/{id}/stamps` (`passes:write`; session `passes:operate`) takes `{ "action": "add", "count": 1 }` (`count` 1 to 20, default 1) or `{ "action": "redeem" }`. It counts from the freshly read pass, publishes the pass and returns the pass detail. The input is then `manual` (a connection no longer owns it).

| Status | Code | When |
|---|---|---|
| 409 | `STAMPS_NONE` | the pass's template has no stamps |
| 409 | `STAMPS_CARD_FULL` | add on a full card; redeem first |
| 409 | `STAMPS_NO_REWARD` | redeem before the goal |
| 409 | `PASS_CONFLICT` | the pass changed during the write; re-read and retry |

A card never climbs above the maximum of a release waiting to reissue it. The stamp that fills the card alerts the holder even when the daily push budget is spent.

`GET /api/v1/templates/{id}/stamps-impact?goal=` (`orgId` optional) counts what a new goal does to live cards: `passes`, `readyNow`, `readyLost`, `newlyReady`, `highest`, `highestKept`. A template without stamps answers 409 `STAMPS_NONE`.

## Holders

`GET /api/v1/holders` lists assignments for an organization (see Authenticate for `orgId`).
Filters: `email`, `state`.

```
POST /api/v1/holders/assign        { "passId": "…", "email": "alex@example.com" }
POST /api/v1/holders/assign-bulk   { "items": [ { "passId": "…", "email": "…" } ] }   (max 100)
POST /api/v1/holders/unassign      { "passId": "…" }
```

`assign` works on an unowned pass. An owned pass changes hands through `reassign`.

Changing a holder starts a credential transfer. The previous public link and bundle membership are
revoked immediately; the existing assignment remains visible while `transfer.state` is `pending`.
Scanner actions, downloads and new Wallet offers are blocked until older provider credentials are
retired and the new holder's Apple and scanner credentials are committed. The response's `transfer`
contains `transferId` and `state`; pending work is retried, not rolled back to the old credentials.
On successful completion, holder-specific uploaded pass assets and member photos are removed from
the current pass. Objects in the dedicated pass-asset and photo namespaces are queued for deletion;
unrecognized legacy object keys are retained for review. Add reviewed imagery for the new holder
separately; failed or still-pending transfers leave the previous assets intact.
If the approved template uses a barcode or lookup value that cannot rotate, the request fails with
`PASS_REISSUE_REQUIRED`. The issuer must reissue a pass with a rotating credential. No API can
physically erase a previously installed offline Wallet copy.

`DELETE /api/v1/me/passes/{id}` returns `200` when removal completes or `202` with
`{ "transferId": "…", "state": "pending" }` while retirement is underway. The requester can
check `GET /api/v1/me/pass-removals/{transferId}`. `GET /api/v1/me/passes` also returns
`pendingRemovals` and, for an eligible verified holder, `reissueRequired` entries directing them
to contact the issuer; these entries do not mean the pass has been attached.

Queued emails bind the selected recipient, attachment choice, holder, credential and lifecycle
generations, public link and artifact version. A changed binding cancels the old intent
(`DELIVERY_STALE`); unbound legacy rows cancel with `DELIVERY_UNBOUND`. Issuance email requests
remain durable while a verified-holder attachment is pending and are reauthorized before delivery.
Request a new email only after reviewing the current recipient and content.
An outbox entry with state `partial` and error code `EMAIL_OUTCOME_UNKNOWN` means the email provider
may have accepted the message. It is not automatically retried: investigate before explicitly
requesting another send. Provider acceptance does not establish inbox delivery.
Refresh jobs and push coalescing are scoped to the original credential and lifecycle generations;
an old job cannot be rebound to a new holder.

## Retained connection webhooks

For a stored Live connection, `GET /connections/{id}/webhook-failures` lists retained webhook
status metadata. A session needs `integrations:read` for the connection's organization; an API
key needs `connections:read` and access to that organization.
`POST /connections/{id}/webhook-failures/{retentionId}/replay` explicitly requests a replay.
It requires `integrations:manage` for a session or `connections:write` for an API key, with
access to the connection's organization, and returns `202` with `{ "ok": true }` when queued.
It does not guarantee completion.
Each list item carries `uncertainItems`, the number of items whose effect is unknown.
`POST /connections/{id}/webhook-failures/{retentionId}/resolve` (no body) records that an operator
checked the source system for those items. It needs the same access as replay and returns `200`
with `{ "ok": true, "resolved": 1, "state": "resolved" }`. `resolved` is the number of items
closed; `state` is `resolved` when nothing else is left in the chunk, otherwise the chunk stays
`failed` or `blocked` and can still be replayed. The call is audited as
`connection.webhook_resolve`. It answers `409` for a chunk that is still queued
(`WEBHOOK_STILL_PENDING`), already finished (`WEBHOOK_ALREADY_FINISHED`), has no uncertain item
(`WEBHOOK_NOTHING_TO_RESOLVE`) or has an item that may still be running
(`WEBHOOK_EFFECT_UNCERTAIN`). A resolved chunk cannot be replayed. By-id connection routes answer
`404` to a caller outside the connection's organization.

A provider's retry of an event whose enqueue failed or never finished dispatches the stored
chunks again; a minute cron does the same for events nobody retried. Failed, blocked and
ignored retained payloads are deleted 30 days after their last change unless an item is
uncertain, and deleting a connection removes its retained payloads.

Verified ingress binds each item to its connection, pass incarnation and admitted release before
effects. A new pass ID is reserved with the item claim before creation. A holder transfer cannot
start while a retained item for that pass is started or has an uncertain outcome, including the
item that initiated the request. Older started or uncertain items without a proven pass binding
conservatively block transfers for that organization until an authorized review resolves them.
Pre-cutover work that is kept only for review never runs, so it does not block transfers.
Verified new ingress retains the connection's configured auto-create and auto-email behavior.

Pre-cutover events and queue messages are kept for review and never run. A message without an
organization, generation or key binding is logged (`queue.legacy_job_ignored`) and retained as
ignored.

These routes are unavailable in Test mode. Retained payloads are encrypted; status responses
expose neither payloads, record references, secrets, nor the sender-controlled event ID. The
`eventRef` is an opaque hash for correlation, not the original event ID. Stale jobs can appear
as `ignored`; this state is terminal and cannot be replayed. Replay also refuses unavailable or
changed context, uncertain effects, and incompatible release changes. Proven items blocked before
effects can be explicitly rebound to the current approved release by replay. See
[Connection webhook recovery](operations.md#connection-webhook-recovery) for operational guidance.

## Outbound webhooks

An endpoint receives signed `POST`s for the events it subscribes to. Delivery is at least once with no
ordering promise: dedupe on the event `id`, and order by `createdAt` or `pass.version` when it matters.

**Access.** A session needs `integrations:read` (view) or `integrations:manage` (change) in the org. An
API key needs `webhooks:manage`. Delivery detail and the feed carry event payloads, so `integrations:read` and `webhooks:manage` can read
them without `passes:read`; payloads hold no personal data. Readers get `url: null` and `urlMasked` (host, then `/…` for any path):
the URL is a capability, shown in full only to managers. Both modes work. The mode is fixed at
creation from the key's mode or the session's `x-passbook-mode`, never from the body; an endpoint receives
events of its own mode only. Other orgs' and the other mode's endpoints answer `404`. Lists and creates take
`orgId` as elsewhere (an org-bound key may omit it).

| Route | Needs | Notes |
|---|---|---|
| `GET /webhook-endpoints?orgId=` | read | `{ items }`, at most 10 per org and mode |
| `POST /webhook-endpoints` | manage | `{ orgId?, url, description?, eventTypes, templateIds? }`. `201` `{ endpoint, secret }`. `?validate=1` checks everything, writes nothing, answers `200 { ok: true }` |
| `GET`, `PATCH`, `DELETE /webhook-endpoints/{id}` | read, manage, manage | `PATCH` takes any create field plus `status` (`active`, `paused`) and `apiVersion`. A resume clears the failure counters |
| `POST /webhook-endpoints/{id}/secret` | manage | `{ overlapHours: 0 \| 1 \| 24 \| 72 \| 168 }` (default 24). `{ secret }`, shown once |
| `POST /webhook-endpoints/{id}/test` | manage | `{ type? }`, default `webhook.test`: sends one signed event to this endpoint: `{ ok, status, durationMs, errorCode, captureId }`. Any other type carries sample data (`sample: true` on the event, `externalId` `sample_order_1042`) and goes to Test endpoints only (`409 SAMPLE_EVENT_LIVE`). 10 a minute per org and mode, then `429`; the destination host's shared send budget is charged too |
| `POST /webhook-endpoints/capture` | manage | the sandbox's capture endpoint, made if it has none: `201 { endpoint, secret }`, or `200` with `secret: null` when it exists. `409 CAPTURE_DEVELOPER_ONLY` outside a developer sandbox in Test |
| `GET /webhook-endpoints/{id}/captures`, `.../captures/{captureId}` | read | stored requests, newest first (`type`, `limit`, `cursor`): headers and the raw body |
| `POST /webhook-endpoints/{id}/captures/{captureId}/replay` | manage | signs the stored body again and stores it as a new capture, same event id |
| `POST /webhook-endpoints/{id}/captures/secret` | manage | `{ secret }`, the capture endpoint's current signing secret; audited as `webhook.capture_secret.reveal` |
| `GET /webhook-endpoints/{id}/deliveries` | read | `state`, `type`, `limit`, `cursor`; newest first |
| `GET /webhook-endpoints/{id}/deliveries/{eventId}` | read | adds `attemptLog` and the `payload` |
| `POST /webhook-endpoints/{id}/deliveries/{eventId}/replay` | manage | one delivery again; `409 DELIVERY_PENDING` while it waits |
| `POST /webhook-endpoints/{id}/replay` | manage | `{ from, to, include?, missing? }`, below |

`eventTypes` is an explicit list of 1 to 32 types, with no wildcard. `templateIds` (up to 20 of the org's
own templates) narrows it; `null` means all. The URL must be `https` on port 443 with a public host (no
credentials, IP literal or platform host): `422 UNSAFE_URL`. It is re-checked on every attempt. The 11th
endpoint in a mode is `409 WEBHOOK_ENDPOINT_LIMIT`, and an org may create 20 endpoints an hour (`429`). Create, update, delete, rotate and replay are audited
(`webhook.endpoint.*`, `webhook.secret.rotate`, `webhook.replay`) with the host only, never the path or a secret.

**Replay.** A replayed delivery is sent with the same event `id` and body. `from` and `to` are event times
in ms. `include` is `failed` (default), `failed_and_cancelled` or `all` (also delivered). It resets at most
10,000 deliveries (`422 REPLAY_TOO_LARGE`: narrow the range). With `missing: true` it also creates deliveries
for subscribed events in the window that the endpoint never had, but only from the last 7 days: older
delivered rows are already purged, so a wider window would send events again. `{ queued }` counts both.
One bulk replay per org and mode per minute, counted from the committed first chunk (a replay that queued nothing does not count). A first chunk that fails answers `503 REPLAY_NOT_QUEUED` with nothing queued and the minute unspent; a single-delivery replay is limited to 10 a minute per org and
mode, and its audit row is written once a minute per endpoint.

**Retries.** Up to 9 attempts over about 3 days; a non-2xx answer, a timeout (10 s) or a refused connection
retries, and a `Retry-After` on `429` or `503` is honored (capped). After 72 hours of failures with at least
10 failed attempts in a row the endpoint is disabled and its pending deliveries are cancelled; patch
`status: "active"` to resume. Redirects are not followed. The response body is ignored. Sends to one host are paced per org
(120 a minute) and across all orgs (600 a minute); a delivery over its share waits, uncounted.

### Capture endpoints (the webhook tester)

A developer sandbox in Test mode has a capture endpoint (`target: "capture"`). It stores the signed request
PassBook would send, with the same headers, body and signature code, and sends nothing: it has no URL, takes
nothing from outside, and exists nowhere else. `POST /test` with a `type`, a pass change in the sandbox and a
replay all land there; erasing a pass erases its captures. It keeps 200 captures per endpoint, 600 an hour per org and 256 KiB per capture, for 7
days; over the hourly count a delivery waits and a test send answers `429`. The developer portal's
Webhooks page reads them every 3 seconds and checks each signature in the browser. `docs/api/webhook-vectors.json`
holds golden requests signed by the server, passing and failing, for testing your own verification.

### Receive and verify

Each request is JSON with these headers:

```
x-passbook-event-id: <event id>
x-passbook-event-type: pass.scanned
x-passbook-timestamp: <unix seconds, this attempt>
x-passbook-signature: v1=<hex>[, v1=<hex>]
```

The signature is `HMAC-SHA256(secret, "<timestamp>.<raw body>")` in hex, with the secret's UTF-8 bytes as
the key. During a rotation overlap the header carries one `v1=` per live secret; accept the request if any
matches. Every retry is signed again with a new timestamp. Compare in constant time, reject timestamps more
than 5 minutes off, and verify the raw bytes before parsing.

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(rawBody, headers, secret) {
  const ts = Number(headers['x-passbook-timestamp']);
  const header = headers['x-passbook-signature'];
  if (!Number.isFinite(ts) || !header || Math.abs(Date.now() / 1000 - ts) > 300) return false;
  const want = createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
  return header.split(',').some((part) => {
    const p = part.trim();
    if (!p.startsWith('v1=')) return false;
    const got = p.slice(3);
    return got.length === want.length && timingSafeEqual(Buffer.from(got), Buffer.from(want));
  });
}
```

Test vector: secret `whsec_test_vector`, timestamp `1764000000`, body
`{"id":"0193a1b2-0000-7000-8000-000000000001","type":"webhook.test"}` gives
`v1=2e47be5b02039b59b046e18c0a95a355bc374db0c467ffd40bac4de9bd480ca1`.

### Events

The body is `{ id, type, apiVersion, createdAt, orgId, mode, pass, data }`. `id` is the ledger id and the
dedupe key; `createdAt` is when the event happened (an offline scan synced late keeps its scan time);
`pass` is `{ id, externalId, templateId }`, and `null` only for `webhook.test`. Types: `pass.issued`,
`pass.updated`, `pass.voided`, `pass.unvoided`, `pass.removed`, `pass.restored`, `pass.installed`,
`pass.uninstalled`, `pass.scanned`, `pass.scan_refused`, `pass.scan_undone`, `push.failed`, `email.failed`
and `webhook.test` (sent on request only). `data` is a fixed allowlist per type. No holder name, email,
personalization value, device id, push token or capability URL appears in any payload.

### Event feed

`GET /events` (and `GET /events/{id}`) returns the same events as the webhooks, for a poller or a
catch-up. It needs `passes:read` (a key scope, or the session capability), not `webhooks:manage`, and
follows the key's or session's mode. Take `orgId` as above.

- Cursors (`ev2.` and 22 characters) are opaque and per org and mode: store and echo them, never compute with them; another org's or mode's cursor is `422`. Cursors from the previous release (`ev1.<n>`) are still accepted for one more release, then dropped: switch to the `nextCursor` you get back. Query: `after` (a cursor or `now`), `types` (comma list), `passId`, `limit` (1 to 200, default 50),
  `apiVersion`.
- Response: `{ items, nextCursor, hasMore }`, ascending. `nextCursor` is never null: the last item's cursor,
  or the cursor you sent when the page is empty. Store it and call again. With no `after` the feed starts at
  the oldest retained event; `after=now` returns no items and the current head.
- An event written late (an offline scan) gets a new cursor, so a poller sees it on its next call.

### Retention and versions

The feed keeps events for `min(30 days, the platform events retention)`. A cursor older than that resumes at
the oldest event without a notice. Delivered deliveries are kept 7 days; failed and cancelled ones as long as
their event; attempts 30 days (test sends 7). Secrets are removed a day after they expire.

`apiVersion` is a date, currently `2026-11-20`, and is pinned per endpoint until a manager patches it. A new
type or a new optional `data` field is not a new version, so ignore unknown types and fields. A rename, a
removal or a change of meaning gets a new version, and each version is supported for at least 12 months. The
feed takes `?apiVersion=` and defaults to the newest.

## Scanner console

Console routes need a session and `scanning:manage`; `GET /scan-setups` and `GET /scan-setups/{id}` also take a key with `scan-setup:read`. Setup writes stay session-only (`scan-setup:write` is reserved and cannot be minted). They act on the console mode (`x-passbook-mode`); a scanner, setup or event of the other mode is a 404. The one exception is `POST /templates/{id}/scan-setup`, which a key with `scanning:write` also calls: it acts in the key's org and mode, its events and session have no user creator, and the audit rows name the key.

- `POST /scanners/{id}/pairing`, `/pair-here`, `/token` on a removed scanner answer 409 `SCANNER_REVOKED`. Send `?restore=true` to restore it; the audit log records `scanner.restore`.
- `GET /scan-staff?orgId=&q=&limit=&cursor=` returns `items`, and `hasMore` with `nextCursor` when there are more. Pass `nextCursor` as `cursor` for the next page.
- `GET /scan/staff?q=` (paired scanner) finds staff by name. The scanner session sets `staffTruncated: true` when its `staffList` was cut at 500.

## Scanning setup in one call

`POST /scanning-sessions/setup` makes the zones, events, staff, sessions and devices for a set of doors in one batch. It takes a console session with `scanning:manage` or a key with `scanning:write`, acts in the caller's mode, and needs an `Idempotency-Key` (400 `SCAN_SETUP_KEY_REQUIRED`; not needed with `dryRun`). `?dryRun=true` returns the plan without writing. The body is `ScanSetupIntentSchema` (`src/shared/contracts/scan-setup-intent.ts`):

- `places`: zones to make (`ref`, `name`, optional `key`, `inside` a ref or zone id, `max`, `count`, `tapOut`, `maxStayMinutes`, `clearAt`) or `{ zoneId }` to reuse. At most 8; three levels below a root.
- `events`: new events (`ref`, `name`, `templateIds`, `opensAt`, `closesAt`, `max`, `reentry`), `{ eventId }`, or `{ fromTemplate, ref? }` for a template's upcoming events. At most 10.
- `staff`: people to add (`name`, `role`). At most 50. PINs come back once.
- `doors`: one session each (1-8). `place`, `admits` (`{ any: true }` or `templateIds` and `events`, by ref or id), `hours` (`always`, or `every`/`mon`…`sun` spans plus `closed` dates), `scanners` (`{ by: 'anyone', as }` or `{ by: 'staff' }`), `devices` (1-10: `name`, `layout`, `direction`, `reader`) and `more` for any other session setting.
- `preset`: `front_desk`, `event_night` or `venue`. It fills only what a door leaves out.
- `timeZone`: absent is the org's, else UTC.

Defaults: a counted place or a re-entry event sets the door to In and out with Track in / out; a barcode reader there scans In. A place with a max tracks, with a 12 h max stay and clear-at at the last closing time. A door with no place and no re-entry gets no direction. Hours are only what the body says.

A ref (`^[a-z][a-z0-9-]{0,23}$`) names something made in the same call; an unknown, duplicate or wrong-kind ref, a zone cycle or a fourth level is 422 with the field path. The answer, and the dry run, carry `checks` (`code`, `level`, `message`, optional `fix`); any `error` check stops the write. Codes: `NO_EXIT`, `NO_MANAGER`, `NO_STAFF`, `PLAN_MISSES_PLACE`, `HOURS_DIFFER`, `EVENT_NO_PASSES`, `READER_BOTH`, `PLACE_ON_EVENT`, `DIRECTION_NEEDS_TRACKING`, `TEST_ONLY`.

The call writes everything in one batch: a failure writes nothing. Names that are taken get the lowest free number after them (`Gym 2`); the answer has the names made. The answer (`ScanSetupResultSchema`) lists each session with its devices and pairing codes, the zones and events made or reused, staff with their PINs, and `checks`. PINs and codes appear once and are never stored or logged.

- **Replay.** The same `Idempotency-Key` and body returns the same ids with `replayed: true` and no PINs or codes. A device that was never paired and whose code ran out gets a new one, and `pairingReissued` is true. The same key with another body is 409 `SCAN_SETUP_KEY_REUSED`.
- **Errors.** A plan problem is 422 `SCAN_SETUP_INVALID`, an `error` check 422 `SCAN_SETUP_CHECKS_FAILED`; both carry `issues` with a path. A name or key taken during the call is 409 `SCAN_SETUP_NAME_TAKEN`: send it again. A key for another org gets 404.
- **Keys.** `scanning:write` makes events, sessions, new places (live keys only) and devices with no pairing code; its rows have no user creator and the audit row names the key. `scanning:admin` (org-bound, live keys only, refused at mint otherwise as 422 `API_KEY_CREDENTIAL_LIVE_ORG`; `expiresAt` required, at most 90 days ahead: 422 `API_KEY_EXPIRY_REQUIRED` / `API_KEY_EXPIRY_TOO_LONG`; only an `org_admin` session with Polaris ID sign-in and step-up can mint it, never a key or a role) also makes staff and gives PINs and pairing codes once, up to 10 such setups an hour and 100 PINs, codes and tokens a day per key, shared with the credential routes below (429 `RATE_LIMITED`). Without it, staff are 403 `SCAN_SETUP_ADMIN_SCOPE`; places or staff from a test key are 403 `SCAN_SETUP_LIVE_ONLY`. The grant itself refuses the tables a key's scope does not cover. Test mode: places and staff are shared with live.
- **Platform keys.** Every route a `scanning:*`, `scan-setup:*` or `nfc:keys` key calls is bound to the key's own org, so a platform key (no org) gets 404 on every list and by id, and a key of another org gets an empty page on a list. The exception is `GET /scans` with `scans:read`, which a platform key may use to name an org: it is the read-only feed, with no names and no pass titles.
- **Modes.** A live `scanning:write` key can move a scanner between live and test, either way, and can revoke it. A test key gets 404 on live scanners.
- **Replay and pairing.** A replay reissues expired codes for a console session only, one commit per device: two replays at once can each mint a code, and the later one wins.
- **Offline.** `event_night` gives a door the offline list only when it needs no exits (no tracked place, no re-entry, no direction). An explicit list on a door that needs exits is the error check `OFFLINE_LIST_BLOCKED`.
- **Limits.** At most 10 new events in all, counting each `fromTemplate` entry's events (422 `SCAN_SETUP_INVALID`).
- **Devices.** `name` is optional on `POST /scanning-sessions/{id}/devices`: the session's name and the next free number.
- **End.** `PATCH /scanning-sessions/{id}` with `{ "status": "ended", "removeDevices": true }` revokes every device of the session in the same write. It defaults to false and needs a console session.

## Credentials by API key

A PIN, pairing code or till token appears once, in the answer of the call that made it. It is stored only as a hash and is never logged or audited. With an `Idempotency-Key`, a replay returns the same ids with `Idempotent-Replayed: true`, and every secret is `null`. To get a new one, call again without the key: that replaces the credential. The API returns the pairing `url` and no QR image: draw the QR from `url`.

| Call | Key scope | Does |
| --- | --- | --- |
| `POST /scanners/{id}/pairing` | `scanning:admin` | A new pairing code for a browser device; replaces any live one. `?restore=true` brings a removed scanner back (audited) |
| `GET /scanners/{id}/pairing` | `scan-setup:read` | Polls `waiting`, `paired` or `expired`; never shows the code |
| `POST /scanners/{id}/token` | `scanning:admin` | A till token (365 days); replaces the old one at once. Only tills take one: a device is 422 `SCANNER_NOT_TERMINAL`, and a till has no pairing code (422 `SCANNER_NOT_PAIRABLE`) |
| `POST /scanners` | `scanning:admin` or `scanning:write` | Makes a scanner. A browser device made by an `scanning:admin` key comes with its code, once; a `scanning:write` key gets `pairing: null` and may make one in either mode |
| `POST /scanning-sessions/{id}/devices` | `scanning:admin` or `scanning:write` | Adds a device to a session; the code is as above |
| `GET /scan-staff` | `scanning:admin` | The org's staff, plain accounts (no activity or locks); another org is an empty page, a platform key 404 |
| `POST /scan-staff` | `scanning:admin` | Adds a person; the PIN comes back once. A taken name is 409 `STAFF_NAME_TAKEN` |
| `PATCH /scan-staff/{id}` | `scanning:admin` | Renames, changes the role or disables a person; a disable signs them out everywhere |
| `POST /scan-staff/{id}/reset-pin` | `scanning:admin` | A new PIN, once; the old one stops and the person is signed out of every device |
| `GET /nfc/keysets` | `nfc:keys` | The org's keysets and their key versions; never key material. Another org is 404 `ORG_NOT_FOUND` |
| `POST /nfc/keysets` | `nfc:keys` | Makes a keyset (needs the `nfc` feature at Secure). Generated keys come back once in `keys`; typed-in keys are never echoed |
| `POST /nfc/keysets/{id}/rotate` | `nfc:keys` | A new key version; the same once-only rule. A key is never asked for a step-up |
| `POST /nfc/keysets/{id}/keys/{version}/retire`, `/revoke`, `/reenrol`, `/disable`, `/import` | `nfc:keys` | As in the console. An import dry run is free |

An `Idempotency-Key` on create and rotate replays the answer with `keys: null`; the stored request is hashed over HMACs of any typed-in keys and the import file, never the raw values. A key's keyset writes share 30 a day, charged first and refunded when nothing commits. A `scanning:admin` key cannot touch keysets, and an `nfc:keys` key cannot touch pairing, tokens or staff (403 `MISSING_SCOPE`).

On staff list, edit and reset, and on keyset list and create, an org-bound key may omit `orgId`: it acts in its own organization. A platform key gets 404 `ORG_NOT_FOUND` on every scan list, whether or not it names an organization, and a session that omits `orgId` where the list does not page across its organizations gets 422 `VALIDATION`.

These keys are live and bound to one organization: a key of another organization or a platform key gets 404, the same answer as a missing id, and test-mode scanners get 404. A key's staff list shows no activity or locks; a key never makes a credential in test mode. The audit log names the key and the caller's network.

Limits per key: 60 credential calls an hour, and 100 PINs, codes and tokens a day, shared with `POST /scanning-sessions/setup`; keyset writes have their own 30 a day. Over a limit is 429 `RATE_LIMITED` with `Retry-After`; a call refused with 4xx costs nothing.

Console only: pair here, joining as an admin device, sample passes, and every credential in test mode. Use an IP allowlist on these keys.

## Scanner device actions

The paired scanner (or an admin session joining a scanning session) calls `/api/v1/scan/*`. `POST /scan/resolve` returns a card with `actions[]`; `POST /scan/actions` runs one.

- A request carries `idempotencyKey`, `actionId` and, by kind: `amount` (add, take), `value` and `expectedVersion` (set), `approval`. A repeat of a key replays the stored answer.
- Customer screen draft: `PUT /scan/draft {ref, actionId, amount}` shows "To pay" or "Adding" and the balance after on the customer screens that follow this scanner, for a money `take` or `add` only; `ref` is the resolve's `idempotencyKey`. It needs the scanner's own presented read under 60 s old (409 `SCAN_DRAFT_STALE`) and a money action within its limit (422 `SCAN_DRAFT_INVALID`). `DELETE /scan/draft?ref=` clears it and the ready card. Both answer `{screens}`, are for a paired scanner device only (403 `DEVICE_REQUIRED`), and never block the commit. `PUT` is refused while the session is paused or closed, like the actions it previews. Drafts count against their own limit (300 a minute per scanner), never the scan budget. The session's `showDraft` switch (default on) governs money on the customer screen: the draft, and the balance line on the draft and on the receipt after a charge. The receipt headline ("Paid $12.00") always shows. A review body carries the figure apart in `figure`. Scans through an API key publish nothing to screens.
- Value actions: `add`, `take`, `set`, `use_up` change an input of the pass and publish it. Stamp cards use the same kinds. Add is capped at the input's maximum; take beyond the balance is refused `no_balance`; a stamp on a full card is `card_full`; an input owned by a connection is `managed_elsewhere` unless the action allows it; a daily amount cap is `limit_reached`. A `set` with a stale `expectedVersion` is a heads-up `stale` carrying a fresh card. Invalid amounts or values answer 422 `SCAN_AMOUNT_INVALID` or `SCAN_VALUE_INVALID`.
- `ScanCardAction.input` (`type`, `label`, `min`, `max`, `step`, `maxLength`, `enum`) is present on a `set` with no fixed value and says what it accepts; the server validates again.
- `ScanCardAction.lock` is `role`, `approval` or `max`. `approval` is unlocked by a Manager PIN: send `approval: { pin }` (six digits) on the same action under a new idempotency key, or on `POST /scan/scans/{id}/undo`. `approval.staffId` is optional: without it the PIN is matched against the org's active managers. When the scanner's staff sign-in is on, `staffId` is required: 422 `PIN_MANAGER_REQUIRED`. A wrong PIN (also one that two managers share) is 400 `PIN_INVALID` with `triesLeft`. Five misses per manager in five minutes, or 20 per scanner in an hour, answer 429 `RATE_LIMITED`; a PIN with no manager named divides both limits by the number of managers it is tested against, and counts against one org-wide hourly counter. The approver is recorded on the scan.
- Undo reverses add, take, set and use up. `UNDO_SUPERSEDED` (409) when a newer scan or edit moved the gate or value.
- Codes not found are counted per scanner (or admin actor) in 10-minute windows: after 30, 429 `SCAN_TOO_MANY_MISSES` with `Retry-After`. The first crossing of the cap is audited (`scan.misses_capped`).
- 409 `SCAN_UNCONFIRMED`: the action committed but the answer could not be confirmed (its template changed meanwhile). Scan again; the key replays the result.
- Photo and asset links in answers are short-lived grants (`docs/security.md`); an expired or voided one is 404 `ASSET_NOT_FOUND`.

## Scan from a till

A `scans:write` key scans as one of the terminals it was minted for, in its own organization and mode. Create the terminals in Scanning, then pick them in the key dialog (`terminalIds` on `POST /api-keys`: at least one with this scope, none without; org-bound keys only). The binding never changes: other terminals mean a new key. Send the key and the terminal's id:

```bash
curl -X POST https://passbook.mobile/api/v1/scan/actions \
  -H "Authorization: Bearer $PASSBOOK_KEY" \
  -H "x-passbook-device: $TERMINAL_ID" \
  -H "Content-Type: application/json" -d '{ ... }'
```

- Only `POST /scan/resolve`, `/scan/actions` and `/scan/scans/{id}/undo` accept a key; any other scan route is 403 `API_KEY_ROUTE`. No Origin header is needed.
- A platform key is 403 `API_KEY_ORG_REQUIRED`; a key without the scope is 403 `MISSING_SCOPE`; a missing header is 422 `DEVICE_REQUIRED`.
- Every other terminal id (unknown, another org or mode, not bound to this key, removed or expired) is the same 404 `TERMINAL_NOT_FOUND`.
- The actor is the terminal: scans are its own (`s:<terminalId>`), at its role (Desk at most) and scope, with its session rules. A key never approves or overrides: `approval` or `overrideOf` is 403 `API_KEY_NO_APPROVAL`, and a Manager-only action is refused like on any terminal.
- A key undoes only its own scans, inside the undo window. The terminal's own token and the key cannot undo each other's scans.
- A key revoked or expired, or an org whose access changed, while a scan is in flight is checked again when the scan commits: 401 `INVALID_API_KEY` or 403 `ORG_ACCESS_CHANGED`, nothing written.
- Each scan records the key (`api_key_id`); history, the scans CSV (**API key**) and the ledger carry it. Rate limits and miss counts are the key's own (`k:<keyId>:s:<terminalId>`), so a key cannot lock out the physical till.

## Roll call

A roll call freezes who is inside and records who is confirmed present or out. Calls are over one scanning session's places (`sessionId`) or every tracked zone of the org. One call is open per scope; starting again joins it. Names show as the pass title. Max stay and Clear at exits in its places wait until it ends (at most 12 hours).

| | |
| --- | --- |
| `GET /roll-calls?orgId=&sessionId=` | the open call, or `{ "rollCall": null }`. `scans:read` |
| `POST /roll-calls?orgId=&sessionId=` | start, or join the open call. `scans:write` |
| `GET /roll-calls/{id}` | a call, open or ended. `scans:read` |
| `POST /roll-calls/{id}/marks` | `{ "marks": [{ "rollCallId", "passId", "status": "present" \| "out" \| "none", "at" }] }`, up to 100. Every mark names this call. The answer is the call plus `results`, one per mark: `applied` or `refused` with a `code` (`ROLL_CALL_MARK_MISMATCH`, `ROLL_CALL_NOT_LISTED`, `ROLL_CALL_SCANNED_SINCE`, `SCAN_UNDO_FORBIDDEN`, `SCAN_UNDO_EXPIRED`); a refused mark never fails the others. 409 `ROLL_CALL_ENDED` is for the whole request. The later `at` wins per person; `at` is the device time corrected by its offset from `serverNow`, and never later than the server's own. `scans:write` |
| `POST /roll-calls/{id}/end` | end it; ending twice answers with the record. `scans:write` |

`orgId` is for signed-in users; an org-bound key names its org. Each person carries `presence` (`in`, `left`, `lapsed`), `late` (tapped in after the start) and `notConfirmedOut` (the clock closed the stay and no one confirmed it). Out also exits the person from the place and taking it back puts them back in; for an API key Out is a confirmation alone. A key with `scans:write` acts as its terminals: it reaches only the calls of their sessions (`sessionId`), anything else is 404. Names are read from the pass when a call is shown, never stored; ended calls leave with the scans retention window (holds honoured) and a deleted pass takes its marks. Scanners use the same calls under `/scan/roll-call` with the device's own sign-in; a key reaches only `/roll-calls`.

## Person history and staff notes

Paired scanners and scanning consoles call these under `/api/v1/scan/passes/{id}`; the pass must be in the device's org, mode and template scope, else 404 `PASS_NOT_FOUND`.

- `GET .../history?filter=all|visits|changes&cursor=&limit=` (1-50, default 20) is the last 30 days, newest first. `nextCursor` is null on the last page; send it back as `cursor`. Each line has `event` (`scanned`, `checked_in`, `checked_out`, `refused`, `held`, `let_in`, `undone`, `value`, `note`), `reason`, `label`, `place`, `staff` and `amount`. Door sees visits only, with no `staff`, `amount` or notes; Desk and above see all. A scan whose signed policy does not hold is `scanned` with only its time. An undo is not a line: the scan it undid is `undone`. Notes appear as `note` lines without their text.
- `GET .../notes` lists up to 100 notes, newest first, each with `own` (the viewer wrote it) and `edited`. Desk and above, never a terminal; Door is 403 `NOTE_ROLE`.
- `POST .../notes` `{ body, idempotencyKey }` adds one. `body` is one plain line of 1-280 characters; a repeated `idempotencyKey` returns the first note. Desk and above on a paired, non-terminal scan device; 20 per minute per device (429). A pass holds 100 notes (409 `NOTE_CAP`) and one device adds at most 10 to one pass a day (409 `NOTE_DEVICE_CAP`).
- `PATCH .../notes/{noteId}` `{ body }` and `DELETE .../notes/{noteId}`: the note's author, or a Manager and above (also from the console). Anyone else gets 404 `NOTE_NOT_FOUND`.
- Audited as `scan.note.add`, `.edit` and `.delete` with the length, never the text. Opening history (its first page) and notes leaves `scan.history.read` and `scan.note.read` with a count and no content.
- History and notes are read only while the session is active and inside its hours; a Manager and above reads through a pause. A mixed-scope device reads only its own events.

A completed credential transfer (a new holder) deletes the pass's notes, and history starts at the transfer: the next holder never sees the previous one's visits or notes.

Notes are staff-only: never on a customer screen, a pass or an email. They are deleted with the pass, age out with the scans retention window (holds honoured; Test-mode notes follow the sandbox window), and are in the org export and purge.

## Scanner history

Scanning lists and forms use an explicit `orgId` and the caller's scanning capabilities. The
session organization picker offers only memberships with `scanning:manage`; released template
choices retain the selected organization, mode, provider and `supportsCheckIn` capability.

`GET /scans` requires an organization and the caller's mode. Sessions need both `scanning:read`
and `passes:read`; an API key needs `scans:read` and is limited to its organization if scoped.
Supported filters include `passId`, `eventId`, `scannerId`, `outcome`, `reason`, `from` and `to`.
`q` is session-only; `staffId` matches no rows for API keys. `limit` is 1–100.
`GET /scans/{id}` requires a session and authorizes against the scan's actual organization,
masking foreign resources.

Cursors are authenticated, encrypted and scoped to the caller, organization, mode, operation and filters; they expire
after 24 hours. Raw IDs are not cursors. A bounded scan of the underlying ledger can return an
empty page with a non-null `nextCursor`; continue until it is null. Filters, cursors and counts
match only identifiers the caller may see. `GET /scans/export` is a session-only CSV export with
`orgId`, `from` and `to`; the range is at most 92 days and 100,000 rows, with at most 10 exports
per user per hour.

Quarantined legacy Test passes, cross-organization or cross-mode relations, and corrupt non-null
release pins are excluded before pagination and counts. If a historical pass, safe current policy
or valid Wallet snapshot is unavailable, the record remains a ledger-only fact with pass-derived
details redacted; its recorded outcome and reason are not rewritten. Action, title and scanner-name
projections require authenticated event-time proof and current scope, source and role policy.
Hidden or unproven actions are not exposed or aggregated. API keys receive no holder, card, staff
identity, custom-action metadata or pass-bound action kind, ID or label. Opaque pass/template IDs
require valid scoped provenance and an authenticated event proof.
Action breakdowns are omitted entirely if any contributing action source is hidden or unproven;
overall totals use scoped immutable proofs. API keys receive no action-role metadata or `byAction`
breakdown.
Where no scoped release history exists, a valid legacy pass may use its pinned policy. An existing
but ineligible or corrupt release head never reopens that fallback.
Hard-deleted passes retain only trusted nonexcluded, noninvalidated ledger and aggregate evidence;
quarantine at deletion permanently excludes their historical rows.

## Close an organization

Session only: no API key reaches these routes (an export hands over every holder's data).

- `POST /orgs/{orgId}/close`: a platform admin, or an org admin with `{ "confirmSlug": "<slug>" }`. 409 `ORG_HELD` under a legal hold. Passes stop updating; 30 days to export.
- `POST /orgs/{orgId}/reopen`: platform admin, inside the 30 days (409 `ORG_REOPEN_WINDOW`, `ORG_PURGING`).
- `GET /orgs/{orgId}/lifecycle`: `status` (`active`, `suspended`, `closed`), `closedAt`, `purgeAfter`, `held`, `canReopen`. `GET /platform/closed-orgs` lists closed orgs.
- `POST /orgs/{orgId}/exports` (202) starts an archive, one at a time (409 `ORG_EXPORT_RUNNING`); `GET /orgs/{orgId}/exports` lists them; `POST /orgs/{orgId}/exports/{id}/link` returns `{ url, expiresAt }` once it is `ready`. The link is the credential (1 hour, consumed by its first download): `GET /org-exports/{id}/download?exp&sig` returns the zip, NDJSON per entity plus template, brand and member photo files, without secrets or key material. `repo-export.ts` lists the entities and `repo-export-excluded.ts` the tables left out, each with its reason.

## Brand kit

`/api/v1/brand` reads and edits the org's look on holder pages and emails. A key needs `brand:manage`; a session needs
`org:read` to view and `org:manage` to change. An org-bound key may omit `orgId`.

| Call | Does |
| --- | --- |
| `GET /api/v1/brand` | the kit: `accent`, `webLogo` (`/brand/{orgId}/{sha}.png`, `w`, `h`), support contacts, `mark` (what holders see), `markChosen`, `markAllowed`, `configRevision` |
| `PATCH /api/v1/brand` | `accent` (hex, `null` clears) and `mark` (`full`, `small`, `none`). `none` is `403 BRAND_MARK_NOT_ALLOWED` until the org's plan includes it |
| `PUT /api/v1/brand/web-logo` | `{ "png": "<base64>" }`: a still PNG, at most 1024 by 512 px and 512 KB |
| `DELETE /api/v1/brand/web-logo` | removes it |

Send the `configRevision` you read; a save from older values is a `409`. SVG, JPEG and animated PNG are refused with
`422`. The logo is served without a session at its content-addressed path, so a changed logo is a new URL.

## Pass setup

One read and one write for an org's brand, support, email and channels, with each wallet's account and Apple ID. The contract is `src/shared/contracts/pass-setup.ts`.

| Call | Does |
| --- | --- |
| `GET /orgs/{orgId}/pass-setup` | the view in the caller's mode: `brand`, `channels`, `apple`, `templates`, `checks`, `revision`, `passCount`. `org:read`, or `brand:manage` |
| `PATCH /orgs/{orgId}/pass-setup` | `expectedRevision` plus any of `brand` and `channels` (`allowed` or `blocked`). `?dryRun=true` answers `{ dryRun, view, diff, impact }` and writes nothing. A session needs `org:manage`; a key `org:write`, or `brand:manage` for a body of logo, icon, web logo, colours, `logoHasName`, accent and `mark` only (`403 MISSING_SCOPE` otherwise). `wallet:write` (or a member with `integrations:manage`) may send only `channels` entries that allow Google or Samsung when that channel is already allowed, to turn a ready account on; it cannot allow or block a channel. A Test key changes the brand kit only (`403 MODE_LIVE_REQUIRED`) unless the org is a sandbox; a platform key cannot call it. An apply reads `Idempotency-Key`; a dry run needs none |
| `POST /orgs/{orgId}/brand-assets` | stage a PNG (`slot`: `logo`, `icon`, `webLogo`); answers `{ slot, sha, version, w, h, expiresAt }`. Name it in a PATCH as `{ "sha": "…", "version": "…" }` (both from the answer; a web logo needs the sha only) to commit it |

- **Values.** Each brand value is `{ value, source }`: `source` is `passbook` (default or placeholder) or `org`. Logo, icon and pass colours add `templatesOwn`, the templates that keep their own. `null` in a PATCH clears a value.
- **Chain.** Each channel has `levels`, in order `passbook`, `plan`, `org`, `template`, each with `state` (`ok`, `partial`, `off`, `needs`, `locked`), `reason` and `canChange`. The first level that is not `ok` or `partial` stops the channel. `plan` is an entitlement refusal; elsewhere the API still reports its `source` as `platform`. `on` means no level down to the org stops it.
- **Checks.** Each has `code`, `level` (`error`, `warn`, `info`), `area`, `message`, optional `channel` and `templateIds`, and `fix` (`action`, `target`). Warnings and errors are to-dos; info rows are suggestions. Codes: `BRAND_LOGO`, `BRAND_ICON`, `BRAND_COLORS`, `BRAND_CONTRAST`, `ACCENT_CONTRAST`, `SUPPORT_MISSING`, `APPLE_SHARED_ID`, `APPLE_ID_FAILED`, `APPLE_ID_EXPIRING`, `APPLE_PUSH`, `WALLET_ACCOUNT`, `NO_CHANNEL`, `TEMPLATE_BRAND_OWN`. Fix actions are stable ids such as `upload_logo`, `start_apple_managed` and `setup_wallet_account`.
- **Template and pass chains.** `GET /templates/{id}/channels` and `GET`/`PUT /passes/{id}/channels` add `levels`, the same chain per channel ending in `template` (or `pass`). The template read also has `overrides` (passes with their own choice, per channel) and `overridePasses`.
- **Reset passes.** `POST /templates/{id}/channels/reset-passes` with `{ orgId, channels?, dryRun? }` clears the passes' own choices in the channels that have one. It resets a page of passes per call and answers `{ overrides, passes, done, skipped, remaining }`; repeat while `remaining` is above 0 and `done` above 0. Needs `templates:publish` and `passes:operate`.
- **Stale saves.** A PATCH with an old `expectedRevision` is `409 PASS_SETUP_CHANGED`: read again and resend. An empty body is `422 PASS_SETUP_EMPTY`.
- **Allowed.** `allowed` takes the channel out of the org's block list; `blocked` adds it. Blocking is a kill switch: copies and enrolments stay. For Google and Samsung, `allowed` also turns the enrolment on in the same write when the platform has released the provider, the plan includes it and the account's source and check are ready; a key then also needs `wallet:write`. Otherwise the account stays off and `checks` carries `WALLET_ACCOUNT`.
- **Images.** `POST /orgs/{orgId}/brand-assets` stores the PNG and queues it for deletion after 24 hours; a PATCH that names its `sha` keeps it. An unknown or expired `sha` is `422 BRAND_ASSET_NOT_FOUND`. At most 100 staged or superseded uploads wait per org (`429`).

## Other

- Most lists take `limit` (1 to 200) and `cursor`; scanner history has the tighter limit above.
  The response has `nextCursor` (null at the end).
- `void` and `unvoid` toggle a pass; `rotate-link` invalidates the old download link.
- Three ways to end a pass: `void` marks it voided and republishes it (reversible with `unvoid`);
  `remove` publishes a last voided, expired version so Wallet moves it to Expired passes (reversible
  with `restore`); `DELETE /passes/{id}` deletes the record from lists and frees its `externalId`. After a
  delete Wallet keeps the pass on the device and it receives no further updates.
- Device ids: `devices[].device` in a pass detail is the sync log's `device` (first 12 hex characters of
  SHA-256 of the device id); `shortId` is only its last six characters, for display.
- `POST /passes/{id}/new-code` mints a new scan code in place and updates the holder's Wallet pass; the old code stops scanning. Same serial and holder. Three per pass per hour; 409 `NEW_CODE_UNSUPPORTED` when the barcode is not the scan code.
- Links are stored as a MAC plus a sealed copy (`docs/security.md`). If the sealed copy is unreadable, `downloadUrl` in `GET /me/passes` and `url` on a bundle are `null`; `rotate-link` issues a working one. Pass detail and mail answer 503 `TOKEN_SEAL_MISSING`.
- `POST /passes/{id}/remove` (`{ message? }`) publishes a last version that is voided and expired, so Wallet
  moves it to Expired passes; no API removes a pass from a device. `POST /passes/{id}/restore` undoes it.
  Bulk: `POST /passes/bulk` with `action: "remove"`.
- `GET /passes/{id}/events` is the sync log, newest first: `kind` (one or a comma list) or `group`
  (`delivery`, `devices`, `changes`). `GET /passes/{id}/devices` is per-device sync and push state.
- `GET /delivery?passId=` lists a pass's outbox entries (`orgId` as on other lists).
- `GET /bundles` lists bundles for an organization and the caller's mode. Optional filter: `passId`.
- `POST /bundles` (`{ orgId, passIds, name, holderEmail?, sendEmail? }`) shares 1 to 10 passes of one org
  behind one link, `/b/{token}`. Then `send-email`, `rotate-link` and `DELETE` on `/bundles/{id}`.
- `POST /broadcasts` sends a message, or a scheduled change of any inputs, to the active passes a `target`
  matches (`templateIds`, optional `onDevice`, `holderState`, `q`). A `message` sets `patch: { message: text }`
  on templates with `manifest.messaging`; an empty text clears it. `send` is `draft`, `now` or `schedule` (with
  `at`); `clearAfter` (ms) clears a message later. `POST /broadcasts/preview` counts a target first.
  `POST /broadcasts/{id}/send` sends a draft, `POST /broadcasts/{id}/cancel` stops a draft or schedule.
  `PATCH /broadcasts/{id}` edits a draft or a scheduled message that has not started (same body as
  create). `POST /broadcasts/{id}/retry` sends a failed, partial or cancelled message again as a new
  one in the same mode. Send, cancel, edit and retry act on the caller's mode only (404 otherwise).
  Progress is in `GET /broadcasts/{id}` (`state`, `counts`, `errorCode`);
  `GET /broadcasts/{id}/items?outcome=` lists the passes it reached.
- A pass notifies its holder at most `push.budgetPerDay` times (default 3) in 24 h; later changes publish
  silently. `GET /passes/{id}` has `pushBudget` (`used`, `limit`, `resetsAt`). An update that leaves the pass
  unchanged is never pushed.
- `GET /test-inbox` and `GET /test-inbox/{id}` require a Test-mode tenant session with `passes:read`, or
  a Test key with `passes:read` in the same organization.
  `POST /test-inbox/{id}/send-to-me` requires `passes:operate` and sends to the signed-in user's
  verified address.
- Request and response bodies are JSON except `PUT /passes/{id}/assets/{name}` (PNG body) and
  `POST /templates/uploads` (zip or multipart, up to 15 MB).
- `POST /templates/{id}/versions` (session with `templates:author`) saves an uploaded template version from JSON, with the
  same checks as an upload. Body: `passJson`, `manifest`, `assets` (`{ name, sha1 }` for a file the template
  already has, `{ name, upload }` for a PNG as base64), `dryRun` (validate and build only; returns the report
  and the built pass). A saved version is always a draft; only a reviewed release activates it. Built-in templates answer 403 `TEMPLATE_BAKED`; duplicate one first.
  A stored template version is immutable: saving the same `(templateId, version)` with identical
  content is idempotent while that version exists; different content under the same key returns a
  conflict. Once a version is deleted, its key cannot be reused. Publishing or rollback requires
  a reviewed release and advances its scoped generation.
- `GET /templates` lists templates; `?blueprint=true` lists blueprints. `POST /templates/{id}/use`
  (session with `templates:author` in `orgId`) makes a template from a blueprint: `{ orgId, name,
  version? }`, 201 with the template. `version` is a draft (`passJson`, `manifest`, `assets`); without it
  the copy is exact. Its first version is a candidate: release it as usual. `POST /templates/{id}/use/check`
  takes the same body with `version` and returns the dry-run report and the built pass.
- `POST /templates/{id}/scan-setup` (session with `scanning:manage` in `orgId`; no API key) sets up
  scanning for a template: `{ orgId, timeZone? }`, 200 `{ session, created, events, noEvents }`. The session
  is live (active or paused), admits the template and has no hours, so each pass's own `scan.window` gates
  entry. A template that names its event on each pass (`eventName` plus a start input, or an
  upcoming-events list) also gets one event per distinct upcoming event on its issued, unvoided passes in the
  request's mode (soonest 10); the template's `sample` is never read. Repeat calls reuse the live session
  and add events passes have gained since (`created: false`, `events` lists what was added). One live
  session per template and mode is held by a unique index, so concurrent calls end with one. `noEvents` is
  true when the template names events but no pass has an upcoming one. A blueprint answers 422
  `BLUEPRINT_NOT_SCANNABLE`, a template with no active version 409 `TEMPLATE_NOT_RELEASED`.
- Public pass and bundle links (`/p/{token}`, `/b/{token}`), the Apple web service (`/wallet/v1`) and webhooks
  (`/hooks/connections/{id}`) have their own auth and are not part of the key API.
