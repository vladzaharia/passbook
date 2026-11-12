# Wallet providers: current state

Branch `feat/mockup-journeys` (uncommitted, on `main` 8f5bee02). Read-only survey. Tests: wallet-providers 348/349 pass; the failure is a trigger alias bug in migration 0043 fixed elsewhere.

Paths below are relative to `src/worker/modules/wallet-providers/` unless they start with `src/`, `migrations/` or `public/`. The module has 143 files, about 14.5K lines of source (34.5K with tests).

**Bottom line.** Neither Google nor Samsung can deliver a pass today. Issuance is hard-denied by five uncoordinated kill switches. Behind them, Google cannot be published, Samsung refs are never promoted, and Samsung UPDATED notifications are always refused. The only live surfaces are account credential storage, projection authoring and approval (API only), Samsung evidence probing, status read, and the cron drain, which has nothing to drain.

## 1. Architecture as built

### Modules and roles

| Area | Files | Role |
| --- | --- | --- |
| Accounts and credentials | `account-service.ts`, `account-credential-material.ts`, `account-credential-read.ts`, `repo-accounts.ts`, `repo-account-writes.ts`, `repo-account-lineage.ts`, `google-credentials.ts`, `samsung-credentials.ts`, `routes-accounts.ts` | One account per (org, mode, provider). Credentials are envelope-encrypted with AAD scope (`platform/crypto.ts`). Revision CAS (`expectedRevision`). Google issuer is immutable once set. An HMAC key for Google object ids is minted per account. Validation is local only (no call to the provider). Permission is `integrations:manage` through `tenantAuthorityOf`. Revoke is `POST /revoke`. |
| Keyset commitment | `passes/credential-keyset.ts`, `passes/repo-credential-keyset.ts`, then `instance-types.ts` `WalletCredentialKeysetProof` | A KEK-ring commitment stored in `credential_ref_keyset` (migration 0042). It is threaded as `credentialKeysetCommitment` through every wallet read and write. See section 5. |
| Projection from Apple templates | `projection-contract.ts` (zod schemas, policy revisions), `projection-source.ts`, `projection-current.ts`, `projection-service.ts` (create, approve, list), `projection-service-support.ts`, `projection-read-service.ts` (`getApprovedProjection`), `projection-release-service.ts` (publish, rollback), `render-projection.ts`, `google-projection.ts`, `samsung-template.ts`, `repo-projection*.ts` | A provider candidate reuses `template_candidates`, `template_approvals` and `template_releases` (migration 0038). It binds to one immutable Apple source release (`source_release_id/generation/hash`, `projection_json`, `provider_account_id/revision`). Two-person approval (the reviewer is not the author). Mounted through `modules/templates/releases.ts`, which switches on `provider !== 'apple'` at lines 76, 92, 154, 202, 227, 244 and 277. |
| Samsung evidence | `samsung-verification.ts`, `samsung-verification-routes.ts`, `repo-samsung-verification.ts` | `POST /api/v1/wallet-providers/accounts/verify` probes the active Samsung card template. Evidence goes to `wallet_provider_projection_evidence` (live) and `..._history`. Evidence lives 5 minutes (`MAX_EVIDENCE_AGE_MS = 300_000`). It is part of the release-binding predicate. |
| Instances and operations | `instance.ts` (facade), `instance-input.ts`, `instance-types.ts`, `instance-claims.ts`, `instance-offer-refs.ts`, `repo-instance*.ts`, `repo-instance-proof.ts` (the 130-line `walletInstanceProofSql`) | An instance is one (pass, provider, credential generation). Operations are the desired-state queue (`upsert`, `revoke`) with versions, claims with a 120 s lease, and outcomes. Claims go `pending`, `claimed`, then `succeeded`, `failed`, `rejected` or `uncertain`. |
| Lifecycle (reconcile) | `lifecycle.ts`, `lifecycle-instance-schedule.ts`, `repo-sync-queue.ts` | Dirty-instance consumer. DB triggers (0037) mark `wallet_provider_instance_dirty` when passes, accounts, releases, assets, photos, templates or orgs change. `reconcileWalletInstance` enqueues `upsert` or `revoke`. |
| Sync | `sync.ts` (`drainWalletProviderSync`, cron `wallet.sync` at `src/worker/jobs/cron.ts:39`), `sync-operation.ts`, `sync-operation-{google,samsung,retirement,context}.ts`, `sync-errors.ts`, `repo-sync-targets.ts`, `repo-sync-retention.ts` | Each minute: purge expired offers, expire claims, drain dirty (30 per run), run due operations (30), finish retirements (30). |
| Runtime and adapters | `runtime.ts`, `runtime-core*.ts`, `runtime-google.ts`, `runtime-samsung.ts`, `runtime-tombstone.ts`, `runtime-response.ts`, `google-{oauth,rest,offer,ids,errors,crypto}.ts`, `samsung.ts`, `samsung-token*.ts` | Fenced wrappers that decrypt credentials and call the provider. Google: OAuth, REST upsert/patch/inactivate of Generic class and object, Save-to-Wallet JWT. Samsung: JWT, data-fetch link, UPDATED/DELETED notification. |
| Offers and save links | `offers.ts`, `offers-eligibility.ts`, `offers-instance.ts`, `repo-offers.ts`, `repo-instance-offers.ts`, `routes-offers.ts` | `GET /p/:token/wallet/:provider` returns 302 to a provider link. `GET /p/wallet/samsung/:offer` redeems a Samsung offer ref. `listWalletOffers` feeds email, the SSR page and the portal. Offer refs are short-lived and instance-bound. |
| Callbacks | `routes-callbacks.ts` and `callbacks-samsung.ts` (`/wallet/v1/samsung/cards/:cardId/:refId`, GET card data and POST state), `callbacks-{ref,body,fields}.ts`, `repo-callbacks*.ts`; `routes-google-callbacks.ts`, `google-callback-{handler,crypto,binding}.ts`, `repo-google-callback.ts` (`/wallet/v1/google/:accountId`) | Google: Tink-compatible ECDSA signature check, replay table, class/object binding registry. Samsung: JWT auth, replay table, receipt claim, per-ref fetch claim, country hints. |
| Tombstones and retirement | `callbacks-tombstone.ts`, `repo-callbacks-tombstone*.ts`, `callbacks-retirement` tests, `sync-operation-retirement.ts`, `repo-instance-retirement*.ts`, `repo-callbacks-retirement.ts` | Samsung tombstones (`wallet_samsung_tombstones`) are immutable proof that a ref is dead. Retirement is a two-step process: request, then settle. It gates pass purge and new credential generations through `providerRetirementCompleteSql` (`repo-sync-retention.ts:11`). |
| Status | `status.ts`, `repo-status.ts`, `routes-status.ts`, `src/shared/contracts/wallet-provider-status.ts` | `GET /api/v1/wallet-providers/passes/{id}`, read-only per-pass provider rows (session or API key). |
| Mounts | `src/worker/app.ts:128-129, 147-150`, `src/worker/jobs/cron.ts:39` | Admin API, public `/p` offers, `/wallet/v1/{google,samsung}` callbacks. |

### Data model

Migration 0037 creates the provider tables. 0038 extends template tables and adds the view `template_provider_apple_sources`. 0042 adds credential generations, transfers and the keyset (`credential_ref_keyset`). 0043 adds `credential_keyset_commitment` columns and about 40 guard triggers. 0050 re-creates `wallet_provider_generation_ready_guard`.

- Accounts: `wallet_provider_accounts` (revision CAS, transition and audit triggers, no delete), `wallet_provider_credentials` (append-only), `wallet_provider_account_events` (append-only).
- Instances: `wallet_provider_instances` (one active per pass and provider; lifecycle `ready`, `blocked`, `revoked`, `retired`; forward-only), `wallet_provider_instance_operations`, `wallet_provider_instance_outcomes`, `wallet_provider_instance_dirty`, `wallet_provider_sync_targets`, `wallet_provider_pass_authority`.
- Offers: `wallet_provider_offer_refs`, `wallet_samsung_fetch_refs` (has `promoted_at`, never set), `wallet_samsung_country_hints`.
- Callbacks: `wallet_provider_callback_events`, `wallet_samsung_auth_replays`, `wallet_samsung_callback_receipts`, `wallet_google_callback_{bindings,receipts,replays}`.
- Retirement: `wallet_samsung_tombstones` (append-only).
- Evidence: `wallet_provider_projection_evidence`, `wallet_provider_projection_evidence_history`.
- Projections (no new tables): `template_candidates`, `template_approvals` and `template_releases` with provider `google` or `samsung`.
- Dirty triggers (0037:358-436) fire on `passes`, `wallet_provider_accounts`, `template_releases`, `pass_assets`, `member_photos`, `templates` and `orgs`.

### Kill switches (all must be removed or replaced by one policy)

| # | Where | What it gates |
| --- | --- | --- |
| 1 | `instance-policy.ts:5` `UNVERIFIED_ISSUANCE_PROVIDERS = ['google','samsung']`, so `walletIssuancePermitted()` is always false | `listWalletOffers` returns [] (`offers.ts:46`), so no badge anywhere. Also `issueWalletOffer` (`offers.ts:90`), `redeemSamsungOffer` (`offers.ts:209`), `createWalletInstance` (`instance.ts:80`), `createWalletInstanceAndOffer` and `createWalletOfferRef` (`instance-offer-refs.ts:51,83`), `ensureSamsungFetchRef` (`callbacks-ref.ts:91`), `putSamsungFetchRef` (`repo-callbacks.ts:76`). |
| 2 | `runtime-core-credentials.ts:161` `if (!purpose) throw runtimeAccountUnavailable()` | Every runtime call without a retirement or refresh purpose: offers, class/object upserts and `googleRuntimeIdHashes`. |
| 3 | `repo-offers.ts:103` `AND 0 = 1` in `walletOfferSnapshotCurrent` | The offer snapshot is never current, so no offer can be minted even with switch 1 off. |
| 4 | `repo-projection.ts:95-99`: the last `INTERSECT` requires `pc.provider = 'samsung'` plus the Samsung evidence predicate | No Google release can bind to an instance, operation or offer. |
| 5 | `repo-projection-write.ts:196` `AND c.provider = 'samsung'`, plus `projection-release-service.ts:57` and `projection-read-service.ts:90` | Google publishing. |

Related soft gates:
- `sync-operation-retirement.ts:44` `if (provider === 'google') return false`. Google retirement never completes.
- `generation_ready_guard` triggers (0043, 0050) block a credential generation from becoming ready until the prior provider generation is retired (`repo-instance-proof.ts:47`, `repo-sync-retention.ts:22-29`).

## 2. Capability matrix

Status key: **E2E** = works end to end; **GATED** = implemented and tested, but unreachable in production; **HALF** = partly wired; **MISSING**; **DEAD** = code with no production path.

| Journey | Google | Samsung |
| --- | --- | --- |
| Account setup and credential storage | **E2E** (admin API and UI). `account-service.ts:154`, `routes-accounts.ts`, `src/web/admin/orgs/wallet-accounts*.tsx`, `wallet-provider-account.tsx`. Envelope-encrypted, revision CAS. Validation is local only. The UI warns that configured accounts cannot issue. | **E2E**, same files. Samsung adds a tombstone-verification credential read (`account-credential-read.ts`) and a country hint. |
| Projection authoring and review | **HALF**. API only: create and approve through `projection-service.ts:85,169` via the template release routes. No admin UI in `src/web/admin/templates`. Candidates can be approved but never published (switch 5). `getApprovedProjection` returns null. | **GATED**. API only, no UI. Create, approve, probe (`/verify`) and publish all work. Evidence expires in 5 minutes and lives inside durable-queue predicates. The probe ignores `mode` and requires `testingModeOff = 'Y'`, so test and sandbox projections can never verify (`samsung-template.ts:186`, `repo-samsung-verification.ts:39`). |
| Issuance (save link or data link) | **GATED** (switches 1-4). Even if open: the first tap 404s, because `offers.ts:162` demands a `succeeded` operation right after creating a `pending` one. Save JWT: `google-offer.ts`, `runtime-google.ts:87`. | **GATED** (switches 1-3). Data-fetch link: `samsung.ts:42`, `callbacks-ref.ts`. Even if open: refs are never promoted, so every card-data fetch is rejected (`callbacks-samsung.ts:53`). |
| Delivery in email and the holder portal (wallet choice, badges) | **HALF**. Plumbing is complete: email `src/worker/modules/delivery/email.ts:104` and `src/worker/email/pass.ts:69`; SSR `src/worker/modules/public/routes.ts:92`; portal `src/worker/modules/me/service.ts:70`, `src/web/portal/holder-pass-view.tsx:131`. Badge is `public/icons/wallet-providers/google/add-to-google-wallet.svg`. Gmail and Outlook do not render SVG. Offers list is always empty (switch 1). | **HALF**. Same plumbing. Badge is PNG (`public/icons/wallet-providers/samsung/add-to-samsung-wallet.png`). No wallet choice UI beyond a flat list of links. Offers list is always empty. |
| Updates after a pass change | **GATED**. DB dirty triggers, then `lifecycle.ts`, then `sync-operation-google.ts`, then `google-rest.ts` patch. No instances exist, so nothing runs. Unit tests cover it. | **DEAD** in practice. UPDATED always fails: `runtime-samsung.ts:74` builds no purpose for upserts, `runtime-core-credentials.ts:161` throws, `sync-errors.ts:51` records it as `unauthorized`/`rejected`. No instances exist either. |
| Void and remove | **HALF**. Pass removal triggers a `revoke` operation (inactivate object). Retirement never completes (`sync-operation-retirement.ts:44`), so a revoked Google instance retries every 60 s and blocks purge and new credential generations. Latent, as no instances exist. | **GATED**. DELETED notification and tombstone path work in tests (`sync-operation-samsung.ts`, `callbacks-tombstone.ts`). The unreachable 204 branch is dead (`sync-operation-samsung.ts:97`). |
| Credential transfer | **HALF**. Not provider-specific: `passes/credential-transfer*`, `repo-credential-transfer-finish.ts` and `repo-credential-transfer-read.ts` require `providerRetirementCompleteSql` for the old generation. 0043 adds `wallet_provider_generation_advance`, `wallet_provider_transfer_complete_guard` and `wallet_provider_transfer_completed`. Blocked forever if a Google instance ever existed. | Works when no instance exists or the instance is tombstoned. Otherwise it depends on the tombstone path. |
| Scanning | **MISSING**. Wallet-provider code has no scan hook. `scan/**` references only provider fixtures (credential-keyset tests, e.g. `scan/repo-output-authority-split-test-fixtures.ts:13`). Native passes carry no scan payload. | **MISSING**, same. |
| Callbacks | **GATED**. `/wallet/v1/google/:accountId` is mounted and live. Signature check and replay table work. A redelivered nonce gets 401 (`google-callback-handler.ts:139`). The catch-all returns 503 with no log (`:156`). Root keys are fetched uncached with raw `fetch` (`google-callback-crypto.ts:150`). Nothing has a binding, so every request is rejected. | **DEAD** in practice. `/wallet/v1/samsung/cards/:cardId/:refId` is mounted, but refs are never promoted, so all callbacks are rejected. |
| Retirement and tombstones | **HALF**. Google has no tombstone concept. Retirement is deliberately never "complete" (replayable Save JWT; `sync-operation-retirement.ts:41-44`). | **GATED**. Tombstone persistence, the 90-line CTE (`repo-callbacks-tombstone-retirement.ts:44`), and settle all work in tests. |
| Admin status and health | **E2E** for reading. `GET /api/v1/wallet-providers/passes/{id}` leads to `src/web/admin/passes/detail/wallet-provider-status.tsx`, and to the Devices tab via `devices-tab.tsx`. Rows are empty in practice. Card copy leaks engineering status (`wallet-provider-status.tsx:144`). No org-level health view or `uncertain` operator action. | Same. |
| Test mode | **HALF**. Every table is scoped by `mode` ('live' or 'test'). Sandbox purge covers provider tables (`src/worker/modules/sandbox/repo.ts:100-105`). Google projection has no mode-specific logic. | **MISSING**. The probe rejects test-mode templates (see projection row). |
| Bulk reissue | **MISSING**. No reference in `workflows/bulk-reissue.ts`. A reissue bumps `credential_generation`, which the 0043 triggers fence on provider retirement. Nothing creates new-generation instances. | **MISSING**, same. |

## 3. Known defects

Sources: audit units wallet-providers-1 and -2, other units' wallet findings, synthesis section 3, and my own reading. Severity is the auditor's, or mine where marked (R).

### Blocks delivery

1. **Samsung refs never promoted.** `callbacks-samsung.ts:53` calls `findSamsungFetchSnapshot(..., requirePromoted=true)`. `repo-callbacks.ts:175`, `repo-callbacks-events.ts:34,113` and `repo-callbacks.ts:234` require `r.promoted_at IS NOT NULL`. Nothing in `src/` or `migrations/` writes `promoted_at` (only `0037:447` declares it). The pre-promotion window `samsungInitialWindowSql` (`repo-callbacks.ts:62-68`) is unreachable. Medium.
2. **Google can't be published.** `projection-release-service.ts:57` (`candidate.provider !== 'samsung' || ... throw changed()`), `projection-read-service.ts:90`, `repo-projection-write.ts:196`, `repo-projection.ts:95-99`. Publish returns a misleading 409 `WALLET_PROJECTION_CONFLICT` ("changed, reload"). Low in the audit; this is the Google blocker.
3. **Five kill switches** (section 1): `instance-policy.ts:5`, `runtime-core-credentials.ts:161`, `repo-offers.ts:103`, `repo-projection.ts:95-99`, `repo-projection-write.ts:196`. Medium.
4. **Samsung UPDATED always refused.** `runtime-samsung.ts:74-79` makes a purpose only for retirement claims. `runtime-core-credentials.ts:161` throws. `sync-errors.ts:51-57` maps this to `unauthorized`/`rejected` permanently. A `RuntimeRefreshPurpose` already exists. Medium.
5. **Google first tap always 404s.** `offers.ts:162` requires a `succeeded` operation straight after `instance-offer-refs.ts:97-112` creates it `pending`. `listWalletOffers` advertises the link regardless (`offers.ts:55-70`). Medium.

### Data integrity

6. **`uncertain` is terminal.** `sync-operation.ts:90` (`holdClaim`) and callers at `:94-108`, `:143-144`, `sync-operation-google.ts:119`, `sync-operation-samsung.ts:33-36,57,85,128`. `expireClaims` (`repo-instance-claims.ts:110-135`) also yields it. The only exit, `settleWalletClaim` (`instance-claims.ts:90`, `repo-instance-claims.ts:138`), has no production caller or route. One concurrent pass edit can block all later updates and revokes for that instance. Medium.
7. **Google retirement never completes.** `sync-operation-retirement.ts:44`. Revoked Google instances are re-deferred every 60 s (`sync.ts:98-105`, `repo-instance-retirement.ts:139-155`). This blocks pass purge and new credential generations through `providerRetirementCompleteSql` (`repo-sync-retention.ts:22-29`) and `previous_settled` (`repo-instance-proof.ts:47`). Low while no instances exist. High once Google is on, and also for credential transfer.
8. **Samsung evidence TTL.** 5 minutes (`repo-samsung-verification.ts:9`). A new probe resets a verified row to `pending` (`:149-154`). The evidence predicate sits inside `listDueOperations`, `claimOperation`, offer reads and `deferWalletSyncOperation`, so expiry stalls the durable queue. Medium.
9. **Samsung probe ignores mode.** `samsung-template.ts:186`, `repo-samsung-verification.ts:39`, `repo-instance-proof.ts:136` hardcode `testing_mode_off = 'Y'`. Test and sandbox projections cannot verify. Medium.
10. **Release insert tautology.** `repo-projection-write.ts:197` binds `? = ?` to `authority.userId, authority.userId`. Low.

### Correctness and reliability

11. **Redelivered Google callback gets 401.** `google-callback-handler.ts:139-144` with `repo-google-callback.ts:236-265` (`ON CONFLICT DO NOTHING`, returns false on a duplicate). Medium.
12. **Silent catch-all.** `google-callback-handler.ts:156-171` maps every error to 503 with no log. `google-callback-binding.ts:95-98` and `account-credential-material.ts:123-126` do the same. `sync.ts:87-90` and the `catch` blocks at `sync.ts:62,100,118` log only a code and swallow the error. Medium.
13. **Probe catch-all** turns keyset outages and D1 errors into `{verified:false}` (`samsung-verification.ts:145-148`). Low.
14. **Discarded binding lookups** with a contradictory comment (`google-callback-handler.ts:141-143,153-154`). Low.
15. **Plain `Error` instead of `AppError`:** `callbacks-ref.ts:80`, `projection-release-service.ts:99`. Low.
16. **Keyset commitment re-asserted about 125 times** across the module, often twice per check (`google-callback-handler.ts:35-45,86-161`), each an HMAC plus a D1 read, duplicating what the SQL fences already enforce. Medium.
17. **Multi-kilobyte SQL fences:** `repo-instance-proof.ts:12-144` (inlined into 8 or more statements, three credential decryptions per outbound fetch in `runtimeExecution`), `repo-callbacks-tombstone-retirement.ts:44-133` (the same CTE in 4 statements), `repo-account-lineage.ts`, `repo-accounts.ts:209-243`. Medium.

### Standards

18. **`crypto.randomUUID()` ids (UUIDv4) in services:** `instance-claims.ts:150,208`, `instance-offer-refs.ts:101,135`, `instance.ts:98,125`, `samsung.ts:199`, `samsung-template.ts:165`. They break time-ordered keyset paging (`listDueOperations` and `listRetirementsReady` with `afterId`) and AGENTS.md's rule. Medium.
19. **`Date.now()` defaults** in `samsung.ts:45,125,174`, `samsung-token.ts:64,133,178,198`, `samsung-credentials.ts:118,141`, `samsung-template.ts:148,196`, `samsung-token-inbound.ts` (1). Low.
20. **Missing timeouts.** Only the Samsung template probe has one (`samsung-template.ts:161`, 10 s). No `AbortSignal` on `samsung.ts:192-202` (update/cancel; the claim lease is 120 s, so a hang yields `uncertain`), Google OAuth (`google-oauth.ts:41`), Google REST (`google-rest.ts:34`), the runtime fetcher (`runtime-core.ts:111`), or Google callback keys (`google-callback-crypto.ts:150`). They also bypass `platform/safe-fetch`. Low to medium (R).
21. **Google callback root keys uncached** (`google-callback-crypto.ts:150`). Low.
22. **Schemas in the module:** `SamsungVerificationInputSchema` and `SamsungVerificationResultSchema` (`samsung-verification.ts:39-51`) should be in `src/shared/contracts/wallet-providers.ts`. Low.
23. **Dead branch:** `sync-operation-samsung.ts:97` (the 204 branch). Low.
24. **Stray session state:** `.omc/state/...` under the module directory, not git-ignored. Low.

### Outside the module

25. Google email badge is SVG (`src/worker/email/pass.ts:69`). Medium.
26. Admin copy leaks engineering status (`src/web/admin/passes/detail/wallet-provider-status.tsx:144`) and stacks disclaimers (`src/web/admin/orgs/wallet-provider-account.tsx:150`). Low and medium.
27. Wallet account forms unmount on focus (`src/web/admin/orgs/wallet-accounts.tsx:39`). Medium (audit synthesis, Web).
28. `docs/design/platform-architecture.md:23` still lists Google Wallet as a non-goal. Medium.
29. Tests seed `ManualClock` from the wall clock (`kek-continuity.test.ts:72`, `projection.test.ts:139`, `account-service.test.ts:51`, `lifecycle.test.ts:78`). Low.

Owner decision pending (W2-10): (a) quarantine behind one policy gate that reports "disabled" everywhere, or (b) make Samsung work end to end: promotion, UPDATED purpose, test-mode evidence, durable evidence history, an `uncertain` reconciler and timeouts. Either way: `ctx.ids`, idempotent Google nonces, logged catches, schemas in shared contracts.

## 4. Reuse, rework, delete

**Reusable as-is**
- Account store: `account-service.ts`, `account-credential-*.ts`, `repo-account*.ts`, the 0037 account tables and triggers, `routes-accounts.ts`, and the admin UI `src/web/admin/orgs/wallet-accounts*.tsx` (after the focus fix).
- Provider adapters: `google-{oauth,rest,offer,ids,errors,projection,credentials}.ts`, `samsung-{token,token-inbound,token-errors,credentials}.ts`, `samsung.ts` (after timeouts, `now` and request-id injection), and `google-callback-crypto.ts` (after adding a cache).
- Projection schemas and rendering: `projection-contract.ts`, `render-projection.ts`, `projection-source.ts`.
- Dirty-trigger approach: the `wallet_provider_dirty_*` triggers and `lifecycle*.ts` scheduling.
- Delivery plumbing: `listWalletOffers` call sites in email, SSR and portal; `src/shared/contracts/wallet-provider-status.ts`; the `/p/:token/wallet/:provider` route shape.
- Status read: `status.ts`, `repo-status.ts` and the admin status card (after copy cleanup).
- Callback endpoints and mounts, once the policy gate is fixed.

**Needs rework**
- All five kill switches: replace with one provider policy (per-provider, per-org) read from a single place, reporting "disabled" in the API and UI.
- Google publish path (items 2 and 3) and Google retirement (item 7: decide on a replay boundary, or a TTL-based settle).
- Samsung: `promoted_at` writer (item 1), UPDATED purpose (item 4), mode-aware probe (item 9), evidence TTL moved out of the queue predicates (item 8).
- `uncertain` (item 6): a reconciler or an operator route for `settleWalletClaim`, plus timeouts inside the lease.
- Google first-tap flow (item 5): return a "preparing" state, or build the object synchronously.
- Fences: replace the keyset/column-equality SQL (section 5).
- Id and clock injection, `AppError` use, logged catches, contract placement.
- Samsung verification flow in the UI: none exists today (API only). The same goes for projection authoring and review.
- Google badge to PNG.

**Delete or quarantine**
- `sync-operation-samsung.ts:97` (unreachable 204 branch) and the `? = ?` clause at `repo-projection-write.ts:197`.
- The 125 repeated keyset assertions, once epochs land; the 90-line retirement CTE copies and `walletInstanceProofSql` inlining; `samsungInitialWindowSql` if promotion happens at creation.
- The `.omc/` directory inside the module.
- If decision (a) is taken: everything behind the gate (`offers*`, `instance-offer-refs.ts`, `callbacks-*`, `runtime-*`, sync operations, tombstones, about 70 percent of the module) can be parked or removed, keeping only the account store, status and projection schemas.

## 5. Dependence on column-equality fences (W3-01 replacement)

The fences are: (1) `credential_keyset_commitment`, a column equality against `credential_ref_keyset` through `credentialRefKeysetSql`; (2) pass column equality (`p.version`, `p.revision`, `p.lifecycle_generation`, `p.release_id`, `p.credential_generation`) against snapshots stored on the instance and operation; (3) account `revision` equality; (4) projection-binding and evidence predicates.

**Fence helpers**
- `passes/repo-credential-keyset.ts`: `credentialRefKeysetSql` (line 5), `credentialRefKeysetInitializeStmt`, `matchesCredentialRefKeyset`.
- `passes/credential-keyset.ts`: `requireCredentialRefKeyset`, `ensureCredentialRefKeyset`, `credentialRefKeysetCommitment`.
- In the module: `assertCredentialKeyset`, `requireSamsungCredentialKeyset`, `assertCallbackKeyset`, `assertBindingKeyset`, `requireProjectionProof`, `assertRuntimeCredentialKeyset`, `findAccountWithCredentialKeyset`, `walletOfferKeysetCurrent`, `validCommitmentSql` (repo-callbacks-keyset), `samsungOperationKeysetSql`, `desiredOperationKeysetSql`, `retirementProjectionSql`, `samsungRetirementProjectionSql`, `samsungTombstoneBindingSql`, `accountCredentialLineageSql`, `walletInstanceProofSql`, `walletInstanceOperationCurrentSql`, `projectionReleaseBindingPredicateSql`, `samsungProjectionEvidencePredicateSql`, `walletRetiredInstanceSettledSql`, `walletUnissuedPlaceholderSql`, `walletNoProviderArtifactsSql`, `providerRetirementCompleteSql`.
- Carrier types: `WalletCredentialKeysetProof` (`instance-types.ts:30`), used by `WalletInstanceProof`, `WalletClaimRef`, `WalletPassRevision`, `ApprovedProjection`, `DirtyWalletInstance`, `WalletPassSnapshot` and `ProjectionRetirementMetadata`.

**Heaviest users** (`credentialRefKeysetSql` count, then `credentialKeysetCommitment` count)
- `repo-instance.ts` (8, 23)
- `repo-instance-mutations.ts` (8, 23)
- `repo-account-writes.ts` (7)
- `repo-sync-targets.ts` (6)
- `repo-samsung-verification.ts` (6)
- `repo-projection-store.ts` (5)
- `repo-instance-retirement.ts` (5, 18)
- `repo-instance-retirement-staging.ts` (5)
- `repo-instance-claims.ts` (5, 15)
- `repo-google-callback.ts` (5, 19)
- `repo-callbacks-tombstone.ts` (5)
- `repo-callbacks-events.ts` (5)
- `account-credential-read.ts` (33 commitment mentions)
- `account-service.ts` (21)
- `repo-callbacks.ts` (16)
- `repo-projection.ts` (16)

**All files that carry the commitment** (non-test; 70 files): account-credential-material, account-credential-read, account-service, callbacks-ref, callbacks-samsung, callbacks-tombstone, google-callback-binding, google-callback-handler, google-ids, instance-input, instance-claims, instance-offer-refs, instance-types, instance, lifecycle-instance-schedule, lifecycle, offers-eligibility, offers-instance, offers, projection-read-service, projection-current, projection-service-support, projection-service, runtime-core-credentials, runtime-google, runtime-samsung, runtime-tombstone, samsung-verification, sync-operation, sync-operation-context, sync-operation-google, sync-operation-samsung, sync-operation-retirement, sync, status, and every `repo-*.ts` listed in section 1 except fixtures (about 36 repo files).

**Pass-column fences** (`p.version/revision/lifecycle_generation/release_id/credential_generation = op.* or instance.*`): `repo-instance-proof.ts:41-109`, `repo-instance.ts`, `repo-instance-mutations.ts`, `repo-instance-offers.ts`, `repo-offers.ts`, `repo-sync-queue.ts`, `repo-sync-targets.ts`, `repo-sync-retention.ts`, `repo-instance-retirement-staging.ts`, `repo-status.ts`, `repo-callbacks.ts`, `repo-callbacks-tombstone.ts`, `repo-callbacks-tombstone-retirement.ts`, `repo-google-callback.ts`, `repo-accounts.ts`, `repo-account-writes.ts`, `repo-projection.ts`, `repo-projection-write.ts`, `repo-samsung-verification.ts`.

**Outside the module that touches the same fences**
- `src/worker/modules/passes/repo-credential-keyset.ts:50-54` (the keyset initializer checks the provider tables are empty).
- `repo-credential-transfer-{finish,read}.ts`, `repo-ops-retention.ts` and `src/worker/modules/sandbox/repo.ts:6,100-105` (all call `providerRetirementCompleteSql` or `walletRetiredInstanceSettledSql`).
- Migrations: 0042 (`credential_ref_keyset`, `pass_credential_*`), 0043 (about 40 triggers, 98 `credential_keyset_commitment` mentions), 0050.

**Replacement mapping.** Revision epochs (`passes.row_version`, `connections.authority_epoch`) replace the pass-column equality set. Per-batch grant rows replace the inline `credentialRefKeysetSql` and `walletInstanceProofSql` text. A provider instance would then store one pass epoch plus one account epoch, and the proof becomes a single equality instead of a 130-line CTE. The keyset commitment can collapse to one pin per request, which removes the 125 assertions. The 0043 immutability triggers (`*_keyset_immutable`, `*_identity`) stay as the invariant layer, but need the alias fix.
