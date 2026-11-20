# API

Machine API under `/api/v1`. The reference is generated from the code at `GET /api/v1/docs` (JSON,
public; `/api/v1/openapi.json` is the same document). Anyone gets the operations an API key can call; a signed-in platform admin gets all of them. It lists the security schemes and, per operation,
the key scopes that allow it (an operation without an `apiKey` entry is not callable with a key). This
page covers what it does not: conventions, headers, common tasks.

## Quick start

1. Ask your operator for an organization. Sign in, switch the console to Test mode.
2. API keys, Create: Test, scopes `passes:read passes:write templates:read`. Copy the secret.
3. `export KEY=wlt_...  BASE=https://passbook.mobile/api/v1`
4. `curl -H "Authorization: Bearer $KEY" $BASE/api-keys/me` shows the key's org, mode and scopes.
5. `curl -H "Authorization: Bearer $KEY" $BASE/templates` and pick a `templateId`.
6. A template needs an approved release; a second person approves it in Templates.
7. `curl -X POST $BASE/passes -H "Authorization: Bearer $KEY" -H "Idempotency-Key: b-1" -H "Content-Type: application/json" -d '{"templateId":"...","externalId":"b-1","input":{...}}'`
8. Open the returned `downloadUrl` on an iPhone and tap Add.
9. `curl -X PATCH $BASE/passes/$ID -H "Authorization: Bearer $KEY" -H "If-Match: 1" -H "Content-Type: application/json" -d '{"input":{...},"notify":true}'`
10. `curl "$BASE/passes?externalId=b-1" -H "Authorization: Bearer $KEY"` finds it again. Go live with a Live key.

## Authenticate

1. Admin console, API keys, Create. Pick an org (or none for all orgs), scopes, optional expiry.
2. Copy the secret (`wlt_<prefix>_<secret>`). It is shown once; only a hash is stored.
3. Send it as a bearer token. No cookie, no CSRF header.

```
curl "https://passbook.mobile/api/v1/passes" \
  -H "Authorization: Bearer $WALLET_API_KEY"
```

| Scope | Allows |
|---|---|
| `passes:read` | GET passes, assets, versions, delivery, events, devices, bundles |
| `passes:write` | create, update, void, remove, refresh, assets, resend email, bundles |
| `holders:write` | assign, reassign, unassign holders |
| `templates:read` | GET templates |
| `messages:write` | broadcasts: list, read, create, edit, preview, send, send again, cancel, per-pass items. A `change` also needs `passes:write` |
| `scans:read` | scoped scanner event and scan-log reads; read a roll call |
| `scans:write` | scan from a till as one named terminal (see Scan from a till); start, confirm and end a roll call; org-bound keys only |
| `connections:read` | scoped connection reads |
| `connections:write` | scoped connection changes and actions; setting `autoCreate`, `autoEmail`, `defaultTemplateId`, `mapping` or `onMissing` also needs `passes:write` |
| `webhooks:manage` | read and manage outbound webhook endpoints, deliveries, replay and test events (see Outbound webhooks). Neither `connections:*` nor `passes:*` scopes reach these routes, and this scope reaches nothing else |

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
| `Idempotency-Key` | pass create, resend | 1 to 200 characters; a retry returns the first result |
| `If-Match: <version>` | pass update | optimistic concurrency; stale is `412 VERSION_CONFLICT` |
| `x-passbook-mode` | console sessions | `test` selects Test mode; keys use their own mode |

Scans use the body's `idempotencyKey` (a UUIDv7), not the header.

### Who am I

`GET /api-keys/me` (any valid key) returns `id`, `name`, `prefix`, `scopes`, `orgId` (null for a
platform key), `mode`, `createdAt`, `lastUsedAt` and `expiresAt`. Never the secret or its hash.

### Test mode

A key is live or test. It takes the mode the console is in when it is created (the dialog's mode is
the console's mode; a `mode` in the request body is ignored for a session). The secret is
`wlt_<prefix>_<secret>` either way and carries no mode marker: the console shows a Test badge, and
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
by invitation APIs. The acceptance page names the organization with `POST /orgs/invitations/preview` and submits the token as `POST /orgs/invitations/accept`. Org member lists include each member's name and email. Revocation
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
`integrations:read` (list) or `integrations:manage` (create, revoke) in that org; a platform
admin without membership cannot manage them. A creator can delegate only scopes their own roles
grant (`403 API_KEY_SCOPE_EXCEEDS_CREATOR`); a platform admin can delegate any. Overview and audit `orgId` values are explicit platform
filters and never grant tenant authority.
Select the platform with `orgId=null` in GET or DELETE queries and `"orgId": null` in POST bodies;
select a tenant by its explicit org ID.

Platform `GET /orgs`, `GET /orgs/{id}` and `POST /orgs/{id}/status` return directory and
lifecycle fields only: `id`, `slug`, `name`, `status`, `createdAt`, `counts` and `countsCapped`.
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

Dated changes, newest last; `/api/v1` is unversioned and changes only additively (new fields,
routes and filters). The reference's `info.version` is not a release number.

Clients written against the earlier API keep working with these differences (as of 2026-11).

- **Pass create with a key**: `templateVersion`, `releaseId` and `releaseGeneration` are optional
  together. Send none and the server uses the scope's effective approved release; with none it
  returns `409 TEMPLATE_RELEASE_REQUIRED` (approve and publish a release in the admin console, then
  retry). Send only some and it returns `422`. `mode` defaults to the key's mode; a mismatch is
  `409 MODE_MISMATCH`.
- **Lists**: a global key or a session without `orgId` gets `422 ORG_REQUIRED`. A session listing a
  forbidden org's passes gets `403`, not an empty `200`.
- **Cutover**: uploaded templates start with a `legacy` release at their active version, so
  existing integrations keep creating passes. New versions need a candidate, a second reviewer
  and a release (see [Approved template releases](#approved-template-releases)).

## Signed webhooks

Inbound connector webhooks (`POST /hooks/connections/{id}`) are signed with the connection's webhook
secret. Sign the raw request body:

```
ts=$(date +%s)
sig=$(printf '%s.%s' "$ts" "$BODY" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" -hex | sed 's/^.* //')
curl -X POST "https://passbook.mobile/hooks/connections/$CONNECTION_ID" \
  -H "x-wallet-timestamp: $ts" -H "x-wallet-signature: v1=$sig" \
  -H "Content-Type: application/json" --data-binary "$BODY"
```

The MAC is HMAC-SHA-256 over `<timestamp>.<raw body>`, hex, prefixed `v1=`. The timestamp is in
seconds; the server refuses one older than 5 minutes or more than 1 minute ahead, a body over
256 KB, and a signature that does not match (constant-time compare). Use the exact bytes you
send: re-serializing the JSON changes the MAC. Rotate the secret with
`POST /connections/{id}/webhook-secret`. PassBook sends no outbound webhooks yet; when it does, they
will use this scheme.

## Errors

`application/problem+json`:

```json
{ "type": "…", "title": "Unprocessable", "status": 422, "code": "VALIDATION",
  "detail": "…", "requestId": "…", "issues": [{ "path": "input.holder", "message": "Required" }] }
```

Branch on `code`, not `detail`. Quote `requestId` when asking for help.

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

## Create a pass

```
curl -X POST https://passbook.mobile/api/v1/passes \
  -H "Authorization: Bearer $WALLET_API_KEY" \
  -H "Idempotency-Key: member-000123-v1" \
  -H "Content-Type: application/json" \
  -d '{ "templateId": "<template id>", "externalId": "member-000123",
        "input": { "holder": "Alex Morgan", "memberId": "000123" },
        "holderEmail": "alex@example.com", "sendEmail": true }'
```

An org-bound key sends no `orgId`, `mode` or release fields: the key's org and mode apply and the
effective approved release is used (see Changes for existing clients).

- `input` is validated against the template's `inputs` schema. See `GET /api/v1/templates/{id}`.
- `Idempotency-Key` (1 to 200 chars): a retry with the same key and body returns the first result.
  The same key with a different body is 409 `IDEMPOTENCY_KEY_REUSED`.
- `templateId` must be a template. A blueprint answers 409 `TEMPLATE_IS_BLUEPRINT`
  (`docs/design/blueprints-and-templates.md`).
- Optional: `serial`, `externalId`, `identityId`, `connectionId` + `externalRef`.
- `externalId` is your own key. `GET /passes?externalId=` returns the passes with exactly that value
  (case-sensitive, inside the key's org and mode). It is not unique by default. A template whose
  manifest sets `"externalId": { "unique": true }` allows one pass per value, per org and mode: a
  create or update that repeats it is `409 EXTERNAL_ID_TAKEN`. Deleted passes release their value;
  voided and removed ones keep it.
- `serial` is honored only for passes on the org's own Apple identity (409 `SERIAL_TAKEN` on a repeat). On the shared platform identity the server generates the serial and ignores the field; use `externalId` for your own key.
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
  -H "Authorization: Bearer $WALLET_API_KEY" -H "Content-Type: application/json" \
  -d '{ "templateId": "<template id>",
        "source": { "kind": "file", "name": "people.csv", "csv": "Name,Ref\nAna,A1\nBen,A2" },
        "plan": { "mapping": { "holder": { "from": "/Name" } },
                  "holderEmail": null, "externalId": { "from": "/Ref" },
                  "match": "externalId", "keepManual": false, "save": false } }'
# state "ready" with counts; fix errors or send skipInvalid, then:
curl -X POST ".../pass-imports/$ID/commit" -H "Authorization: Bearer $WALLET_API_KEY" \
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
  -H "Authorization: Bearer $WALLET_API_KEY" -H "If-Match: 3" \
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
| `POST /webhook-endpoints/{id}/secret` | manage | `{ overlapHours: 0 \| 24 \| 72 }` (default 24). `{ secret }`, shown once |
| `POST /webhook-endpoints/{id}/test` | manage | sends one `webhook.test` to this endpoint: `{ ok, status, durationMs, errorCode }`. 10 a minute per org and mode, then `429`; the destination host's shared send budget is charged too |
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

`apiVersion` is a date, currently `2026-12-01`, and is pinned per endpoint until a manager patches it. A new
type or a new optional `data` field is not a new version, so ignore unknown types and fields. A rename, a
removal or a change of meaning gets a new version, and each version is supported for at least 12 months. The
feed takes `?apiVersion=` and defaults to the newest.

## Scanner console

Console routes need a session and `scanning:manage`. They act on the console mode (`x-passbook-mode`); a scanner, setup or event of the other mode is a 404.

- `POST /scanners/{id}/pairing`, `/pair-here`, `/token` on a removed scanner answer 409 `SCANNER_REVOKED`. Send `?restore=true` to restore it; the audit log records `scanner.restore`.
- `GET /scan-staff?orgId=&q=&limit=&cursor=` returns `items`, and `hasMore` with `nextCursor` when there are more. Pass `nextCursor` as `cursor` for the next page.
- `GET /scan/staff?q=` (paired scanner) finds staff by name. The scanner session sets `staffTruncated: true` when its `staffList` was cut at 500.

## Scanner device actions

The paired scanner (or an admin session joining a scanning session) calls `/api/v1/scan/*`. `POST /scan/resolve` returns a card with `actions[]`; `POST /scan/actions` runs one.

- A request carries `idempotencyKey`, `actionId` and, by kind: `amount` (add, take), `value` and `expectedVersion` (set), `approval`. A repeat of a key replays the stored answer.
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
  -H "Authorization: Bearer $WALLET_API_KEY" \
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
| `POST /roll-calls/{id}/marks` | `{ "marks": [{ "passId", "status": "present" \| "out" \| "none", "at" }] }`, up to 100. The later `at` wins per person. `scans:write` |
| `POST /roll-calls/{id}/end` | end it; ending twice answers with the record. `scans:write` |

`orgId` is for signed-in users; an org-bound key names its org. Each person carries `presence` (`in`, `left`, `lapsed`), `late` (tapped in after the start) and `notConfirmedOut` (the clock closed the stay and no one confirmed it). Scanners use the same calls under `/scan/roll-call` with the device's own sign-in; a key reaches only `/roll-calls`.

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
- Public pass and bundle links (`/p/{token}`, `/b/{token}`), the Apple web service (`/wallet/v1`) and webhooks
  (`/hooks/connections/{id}`) have their own auth and are not part of the key API.
