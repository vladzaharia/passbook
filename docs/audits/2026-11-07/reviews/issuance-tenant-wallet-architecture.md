> `TenantIssuanceIntegration` is running a newer turn. The output below is from its PREVIOUS run (published 19.1s ago), not the current one. Live progress: `history://TenantIssuanceIntegration`; its next result auto-delivers to its owner.## Assessment

**Strict tenant administration is not implemented.** Global admins are deliberate v1 architecture, not an accidental bypass (`docs/design/platform-architecture.md:22–24`; `src/worker/platform/auth.ts:124–145,180–197`). That architecture must change for the requested isolation model.

This is a baseline audit, not patch-regression findings; the working diff concerns Android. Paths below are relative to `src/worker/modules/` unless stated.

## Current boundaries

- **Administration and credentials:** Connections, signing identities and API-key management require global-admin sessions. Org-bound machine keys have scopes and immutable live/test mode; null-org keys are platform-wide. Resolution rejects revoked/expired keys and inactive owning orgs (`connections/routes.ts:43`; `identities/routes.ts:30`; `api-keys/service.ts:61–109,135–164`). Source-test endpoints expose field previews and therefore need tenant authorization—not merely hidden credentials (`connections/test-config.ts:21–35`).

- **Issuance:** `POST /passes` checks `passes:write`, requested-org access and active-org status. Templates/signers must belong to that org or be global; connections must belong to that org (`passes/routes-write.ts:25–61`; `create.ts:64–99`; `builder.ts:88–103`; `identities/db-resolver.ts:94–115`). Supplying input plus a connection/reference does **not** prove that input came from upstream.

- **Source authority:** Authenticated polling or HMAC-verified webhooks supply records. Mapping produces template inputs; manual field locks survive synchronization until reset. Upstream email can assign waiting passes, but verified mailbox proof controls account attachment (`connections/records.ts:120–184`; `passes/connection-passes.ts:35–75`; `holders/service.ts:253–262`). Source identity never grants org administration.

- **Templates and portability:** D1 `org_id` controls ownership; baked `manifest.org` only seeds it. Null-org baked **and uploaded** templates are globally usable. Versions are immutable, but ownership and active-version pointers are mutable. Clone creates a new tenant template ID and copies active content/assets; export removes `manifest.org` and packages active `pass.json`, manifest and assets—not external signer/connection bindings (`templates/mutations.ts:65–120`; `lifecycle.ts:29–49`). Shared activation can rebuild passes across orgs (`passes/stale-reissue.ts:55–63`; `repo-ops.ts:107–126`).

- **Brand, signing and artifacts:** Server inputs overwrite issuer IDs, organization name, serial, token and service URL after template processing. Pass-image overrides beat org branding, which beats template imagery (`src/passkit/build.ts:254–260`; `passes/builder.ts:189–198`). R2 access relies on authorized pass rows/capabilities, not storage prefixes. Signer selection is explicit → org default → permissible global default → Platform. Shared signers share the serial namespace. APNs keys are team-wide; registration-specific push tokens prevent cross-org push redirection (`migrations/0001_platform.sql:295`; `0012_identities.sql:3–14`; `0006_apple.sql:1–5`).

- **Apple/device coupling:** Templates contain Apple `PassJson`; each pass stores one signer, serial, authentication token and artifact (`src/passkit/template/registry.ts:9–19`; `migrations/0001_platform.sql:264–308`). Multiple registrations share that credential. Apple artifact retrieval has no device identifier, and removal republishes a pass-wide artifact (`apple/routes.ts:108–127`; `passes/remove.ts:22–57`). **Unregistration is not independently revoking a device credential.**

- **Customer union:** `/me` selects by `owner_user_id` across organizations (`me/repo.ts:41–49`). This intentionally aggregates the verified customer’s passes; it must not merge tenant source records or confer management authority.

## Revalidated defects and gaps

All are **high-confidence source findings**, not runtime reproductions.

1. **P1 — Stale template ownership authorizes foreign issuance.** Registry caches retain mutable `orgId` under `id@version`; reassignment invalidates only the current isolate. Another warm isolate can continue treating a newly private template as global (`templates/registry.ts:38–49,111–143`; `org-assignment.ts:18–34`; `passes/builder.ts:88–103`). Reconfirms audit **07**. Cache immutable content separately from current authorization metadata.

2. **P1 — Test keys can consume live source records.** Test passes may bind same-org production connections. Refresh/sync then use production credentials and selectors without pass-mode constraints. The unique reference index also lets a test binding occupy a future live reference (`passes/create.ts:71–83`; `connection-bind.ts:34–66`; `connections/jobs.ts:26–66`; `repo-passes.ts:45–99`; `migrations/0001_platform.sql:322–323`). Reconfirms audits **10/11**. Reject crossings before fetching and quarantine existing invalid bindings.

3. **P1 — Stale source authority can commit.** Webhook jobs omit intake generation and adopt current configuration. Publication checks binding/generation before asynchronous work, but commits by pass ID/version only (`connections/webhooks.ts:79–84,100–131`; `passes/connection-passes.ts:35–48`; `repo-write.ts:142,228–230`). Later polling slices omit org-active checks (`connections/sync.ts:54–60,71–96`). Reconfirms/extends audits **07/10**. Carry source/binding/revocation generations through final writes and holder assignment.

4. **Additional P2 defects require separate fixes:**
   - Archived templates remain usable for new issuance despite the lifecycle contract (`templates/lifecycle.ts:10`; `registry.ts:120–125`).
   - Ownership reassignment checks passes but not referencing connection defaults (`org-assignment.ts:18–26`), stranding auto-create configurations.
   - Clone/export omit baked preview-only extras still referenced by manifests (`mutations.ts:85–111`; `lifecycle.ts:40–47`; `registry.ts:149–154`).
   - Promoting an org identity clears the global default, affecting unrelated org fallback selection (`identities/repo.ts:193–203`).

5. **P2 — Holder union leaks into tenant projections/delivery policy.** Rechecked audit **09**: pass details expose global primary email, including blocked-user label fallback (`passes/detail.ts:158–180`; `repo.ts:54–75`); holder bundles omit org-active delivery checks (`me/repo.ts:79–94`; `service.ts:250–264`). Neither follows from legitimate customer aggregation.

Test-pass APNs can reach real devices. This is confirmed behavior, **not** an established policy violation.

## Proposed target model

- **Tenant authority:** Require authenticated org membership and explicit permission for every management, preview, history and operational action. Reserve platform-wide principals for platform operations. Separate source-use authority from ordinary pass writing. Enforce org and applicable data-mode consistency in services, repositories and committing writes. Connection `poll/webhook/...` mode is ingestion policy, not environment.

- **Portable authoring:** Use immutable, platform-neutral semantic blueprints with typed inputs, assets and required/optional semantics—not canonical Apple JSON plus export plugins. Tenant bindings pin blueprint version, branding, source mapping, provider accounts and fallback policy. Global blueprints contain reviewed content only; tenant data, native identifiers, credentials and operational histories are not automatically shareable. Global publication must not silently change another tenant’s binding.

- **Tiered native adapters:** Apple remains full-fidelity primary, including explicit native extensions/layouts. Google/Samsung have real native issuance/update/artifacts/readiness and provider-specific previews, with narrower declared capability subsets. Authors see native previews, payload/layout diffs, omissions and fallback decisions. Optional degradation requires versioned approval; unsupported required/security semantics fail closed.

- **Entitlement and instances:** One tenant/domain entitlement supports concurrent provider/account credential instances and observed device installations. Add/update/revoke/install states belong to each instance, not one global status or exclusive provider switch. Server-owned provider identifiers and permissions remain tenant-scoped. Shared Apple credential groups must be distinguished from independently controllable instances; unavailable or unobservable device controls cannot appear successful.

- **Onboarding:** Establish membership and issuer/provider authority; adopt a pinned blueprint; review native capabilities; configure org/environment-specific sources and credentials; exercise isolated samples; explicitly enable live issuance/auto-email. Platform Apple signing and shared-team APNs may remain centrally managed infrastructure. Tenant administrators must not rotate shared-team keys or change unrelated defaults.

## Migration and acceptance

Preserve existing Apple pass-type/serial/token/service-URL tuples, protocol routes and immutable histories. Inventory cross-resource references and unclassified null-org uploads before creating bindings. Preserve Apple-only features explicitly rather than claiming lossless neutral conversion. Credential ownership/kind changes require AAD-aware re-encryption (`src/worker/platform/crypto.ts:4–24`).

| Acceptance boundary | Required result |
|---|---|
| Tenant A receives B’s known IDs | No B configuration, source previews, credentials, history or artifacts; approved global resources still work. |
| Test/live source operations | No live fetch through create, bind, refresh, poll or webhook—including legacy bindings and identical references. |
| Delayed work | Suspension, rebinding, configuration or credential changes prevent stale commits. |
| Templates | Warm-cache ownership changes remain isolated; archive blocks issuance; clone/export preserves preview assets; A’s changes leave B unchanged. |
| Customer union | Verified customer sees A+B entitlements without org rights, private-primary-email disclosure or inactive-org delivery bypass. |
| Providers/devices | Concurrent additions coexist; instance states/actions remain distinct; required unsupported semantics block issuance/update; optional omissions are explicit. |

No edits, tests, builds, production access or secret reads. Provider/device-specific feasibility and deployed configuration remain unverified. Issuer/team ownership, entitlements and controller/retention obligations require owner/legal confirmation.
