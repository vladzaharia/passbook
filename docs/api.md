# API

Machine API under `/api/v1`. The reference is generated from the code at `GET /api/v1/openapi.json`
(public). This page covers what the reference does not: auth, conventions, common tasks.

## Authenticate

1. Admin console, API keys, Create. Pick an org (or none for all orgs), scopes, optional expiry.
2. Copy the secret (`wlt_<prefix>_<secret>`). It is shown once; only a hash is stored.
3. Send it as a bearer token. No cookie, no CSRF header.

```
curl "https://passbook.mobile/api/v1/passes?orgId=$ORG_ID" \
  -H "Authorization: Bearer $WALLET_API_KEY"
```

| Scope | Allows |
|---|---|
| `passes:read` | GET passes, assets, versions, delivery, events, devices, bundles |
| `passes:write` | create, update, void, remove, refresh, assets, resend email, bundles |
| `holders:write` | assign, reassign, unassign holders |
| `templates:read` | GET templates |
| `messages:write` | broadcasts: list, read, create, edit, preview, send, send again, cancel, per-pass items. A `change` also needs `passes:write` |
| `scans:read` | scoped scanner event and scan-log reads |
| `connections:read` | scoped connection reads |
| `connections:write` | scoped connection changes and actions |

Tenant list requests name an organization with `orgId`. An org-bound key may omit it (it defaults
to the key's org) and must otherwise send exactly that org; another org is `403`. A global key
sends `orgId=<org>`, or `orgId=null` for a platform-wide list. A platform-scoped bearer
key has no tenant membership and is authorized by its scopes and each route's organization rules.
Tenant sessions require an active membership with the operation's capability; a platform role
alone does not grant tenant access. Platform-wide administration and organization membership
management use session authorization as described below.
Limit: 600 requests per minute per key, then 429.

### Test mode

A key is live or test (`mode` when it is created; shown with a Test badge and `wlt_test_` in the console,
the secret format is the same). An admin session is test when it sends `x-passbook-mode: test`. Lists and
counts show only the caller's mode. A key reads and changes only its own mode; another mode's pass or bundle is
`404`. A session reads either mode by id (`mode` is returned) but changes only the mode it is in: otherwise
`409 MODE_MISMATCH`. Bulk actions skip other-mode passes and list them as `MODE_MISMATCH`. A pass or bundle takes the
creator's mode. Email for a test pass or bundle is never sent: it lands in the Test inbox. Test data older
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
grant (`403 API_KEY_SCOPE_EXCEEDS_CREATOR`); a platform admin can delegate any. Overview and audit
`orgId` values are explicit platform filters and never grant tenant authority.
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
| `integration_admin` | `integrations:read`, `integrations:manage`, `templates:read` |
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

Clients written against the earlier API keep working with these differences.

- **Org-bound keys**: `orgId` is optional on pass create and on pass, holder and bundle lists, and
  defaults to the key's org. A foreign org is `403`.
- **Pass create with a key**: `templateVersion`, `releaseId` and `releaseGeneration` are optional
  together. Send none and the server uses the scope's effective approved release; with none it
  returns `409 TEMPLATE_RELEASE_REQUIRED` (approve and publish a release in the admin console, then
  retry). Send only some and it returns `422`. `mode` defaults to the key's mode; a mismatch is
  `409 MODE_MISMATCH`.
- **Holder and bundle lists**: a global key or a session without `orgId` gets `422 ORG_REQUIRED`.
  A session listing a forbidden org's passes gets `403`, not an empty `200`.
- **Cutover**: uploaded templates start with a `legacy` release at their active version, so
  existing integrations keep creating passes. New versions need a candidate, a second reviewer
  and a release (see [Approved template releases](#approved-template-releases)).

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
approved release, and generated baked templates with a trusted system release. It never falls
back to another org's release or an unapproved draft. `supportsCheckIn` is derived from the
released version. Issuance rechecks the selected release and its assets.

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

Samsung publication requires fresh, candidate-specific provider verification. Google candidates
can be authored and reviewed, but publication and offers remain blocked until external issuer
approval and replay-safe Save behavior can be verified; configuration or an admin assertion alone
does not establish provider readiness.

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
  -d '{ "orgId": "<org id>", "templateId": "<template id>",
        "templateVersion": "<released version>", "releaseId": "<release id>",
        "releaseGeneration": 1, "mode": "live",
        "input": { "holder": "Alex Morgan", "memberId": "000123" },
        "holderEmail": "alex@example.com", "sendEmail": true }'
```

- `input` is validated against the template's `inputs` schema. See `GET /api/v1/templates/{id}`.
- `Idempotency-Key` (1 to 200 chars): a retry with the same key and body returns the first result.
  The same key with a different body is 409 `IDEMPOTENCY_KEY_REUSED`.
- Optional: `serial`, `externalId`, `identityId`, `connectionId` + `externalRef`.
- The response carries the pass id, the download link and the current `version`.

An authorized pass detail or retained-version read returns `409 PASS_TRANSFER_PENDING` while
credential retirement is pending; pass lists omit those passes. The same response applies to an
idempotent issuance replay during a transfer, without disclosing the reserved link or prior
holder content. Retry after the transfer completes; a stale read returns `409 PASS_CONFLICT`.
Current pass details include `reissueRequired`, true only while an eligible verified waiting
holder needs a replacement because its credential cannot be safely rotated. It does not mean the
holder has been attached.

## Update a pass

`PATCH /api/v1/passes/{id}` with `If-Match: <version>`. A stale version returns 412
`VERSION_CONFLICT`: re-read and retry. A changed pass is rebuilt and pushed to its devices.

```
curl -X PATCH https://passbook.mobile/api/v1/passes/$ID \
  -H "Authorization: Bearer $WALLET_API_KEY" -H "If-Match: 3" \
  -H "Content-Type: application/json" \
  -d '{ "input": { "points": 1300 } }'
```

## Holders

`GET /api/v1/holders?orgId={orgId}` lists assignments for the specified organization. `orgId` is
required even for an organization-scoped API key; optional filters include `email` and `state`.

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

## Scanner console

Console routes need a session and `scanning:manage`. They act on the console mode (`x-passbook-mode`); a scanner, setup or event of the other mode is a 404.

- `POST /scanners/{id}/pairing`, `/pair-here`, `/token` on a removed scanner answer 409 `SCANNER_REVOKED`. Send `?restore=true` to restore it; the audit log records `scanner.restore`.
- `GET /scan-staff?orgId=&q=&limit=&cursor=` returns `items`, and `hasMore` with `nextCursor` when there are more. Pass `nextCursor` as `cursor` for the next page.
- `GET /scan/staff?q=` (paired scanner) finds staff by name. The scanner session sets `staffTruncated: true` when its `staffList` was cut at 500.

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
- `POST /passes/{id}/remove` (`{ message? }`) publishes a last version that is voided and expired, so Wallet
  moves it to Expired passes; no API deletes a pass from a device. `POST /passes/{id}/restore` undoes it.
  Bulk: `POST /passes/bulk` with `action: "remove"`.
- `GET /passes/{id}/events` is the sync log, newest first: `kind` (one or a comma list) or `group`
  (`delivery`, `devices`, `changes`). `GET /passes/{id}/devices` is per-device sync and push state.
- `GET /delivery?orgId={orgId}` lists delivery entries for the specified organization; `orgId` is
  required, including for organization-scoped API keys. Optionally filter by `passId`.
- `GET /bundles?orgId={orgId}` lists bundles for the specified organization and caller mode;
  `orgId` is required, including for organization-scoped API keys. Optionally filter by `passId`.
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
- `GET /test-inbox` and `GET /test-inbox/{id}` require a Test-mode tenant session with `passes:read`.
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
- Public pass and bundle links (`/p/{token}`, `/b/{token}`), the Apple web service (`/wallet/v1`) and webhooks
  (`/hooks/connections/{id}`) have their own auth and are not part of the key API.
