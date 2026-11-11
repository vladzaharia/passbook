# PassBook platform audit — 2026-11-07

## Executive assessment

The platform has meaningful security foundations: tenant-scoped repositories and keys, CSRF-protected sessions, encrypted credentials, signed/validated Apple passes, leased outboxes, a fail-closed scanner decision path, and locally reproducible test environments. Independent audits nevertheless found multiple **P1 release-blocking defects** across credential delivery, scanner authorization/privacy, live-vs-test isolation, concurrency, and credential policy. Do not treat this checkout as security-approved or its scanner-native capability patch as release-ready until the P1s below are resolved and retested.

No P0 finding was established. “Confirmed-source” means the faulty behavior is supported by implementation; it does **not** mean every conditional live exploit, timing window, or production prerequisite was exercised. Every P1 must be triaged against the deployed revision and fixed or explicitly risk-accepted by the owner. This audit made no application-code fixes.

## Reproduced in isolated local environments

1. **Stale email discloses replacement access.** A real queued resend to holder A, followed by reassignment, link rotation and pass update, sent A the new link and current `.pkpass` attachment. The old link returned 404. Local fake-mailer only; no external email. Details: [security reproductions](verification.md#security-reproductions), [red-team report](reviews/10-red-pass-delivery.md).
2. **Scanner response leaks hidden credential/data fields.** A filtered Door display omitted synthetic secret/desk-only values, while the same scan response’s `passView.passJson` retained them. In the same local harness, `showPhoto:false` and an insufficient photo role blocked `member.png` but not the same photo through the `thumbnail@3x.png` alias. The harness result was 4 passing checks and one monitor-case assertion failure; that failed assumption is reported rather than patched over. See [verification](verification.md#scanner-secretrole-filtering-and-photo-alias) and [scanner security report](reviews/12-blue-scanner-native.md).
3. **Read-only monitor elevated by administrator rename.** With unchanged paired cookie/CSRF, a valid check-in changed from `403 SCREEN_ONLY` to `200 ok` after a name-only session-device PATCH; the D1 scan ledger recorded it. This is administrator-triggered privilege expansion—not an unauthenticated admin mutation. See [verification](verification.md#monitor-promotion-after-metadata-rename) and [scanner security report](reviews/12-blue-scanner-native.md).

## P1 — Blockers to resolve first

### Prevent unauthorized pass disclosure or admission

- **Former-holder delivery:** tie queued recipient, pass revision and credential generation to delivery intent; cancel stale jobs after reassignment/rotation. Update retries must preserve and reconfirm the original recipient/attachment instead of silently defaulting to the current holder. [R2](reviews/10-red-pass-delivery.md), [settings](reviews/25-settings-platform.md).
- **Test API key → live connector data:** prohibit test passes binding to live connections; enforce mode in refresh/poll/webhook selectors, including existing bindings. A test-key write response itself can reveal mapped personalization, and a test binding can intercept a future live reference. [R2](reviews/10-red-pass-delivery.md), independently counterchecked by [blue-team](reviews/11-blue-platform.md).
- **Scanner data exfiltration:** filter secret inputs, hidden fields and role-scoped values from *all* scan-response representations, including raw `passView.passJson`. Apply member-photo permission checks to every asset alias, including Wallet thumbnails. [scanner security](reviews/12-blue-scanner-native.md); reproductions in [verification](verification.md).
- **Monitor/customer permission drift:** preserve screen purpose and omitted PATCH fields; never derive authorization from layout normalization or schema defaults. Name-only admin PATCH elevated a paired read-only monitor. Require unchanged credentials to remain read-only. [scanner security](reviews/12-blue-scanner-native.md), [settings](reviews/26-settings-scanner.md).
- **Capacity override policy:** `capacity_full` currently flows through the ordinary “let in again” permission; default `anyone` permits over-capacity admission without a Manager PIN despite the scanner policy document. Make this exception independently manager-authorized. Source-confirmed; acceptance scenario not executed. [scanner security](reviews/12-blue-scanner-native.md).
- **Door action correlation:** queued native barcode inputs can be acknowledged as errors and subsequently committed without a matching native success. Preserve input-to-verdict correlation across queueing or reject before acceptance. [buddy/motion audit](reviews/06-cohesion-buddy.md), [web/native code audit](reviews/08-code-web-native.md).
- **Cross-event retries:** uncertain offline/timeout scan retries do not retain their original event/config scope. A retry after reassignment can be applied to a different event. Bind retries to immutable scope/revision and reject stale work. [scanner security](reviews/12-blue-scanner-native.md), [operator UX](reviews/04-ux-operator-admin.md).

### Fence lifecycle, tenancy and credential policy

- **Publication after deletion/unbind:** delete, binding changes and publication do not share a sufficient CAS fence. A delayed unvoid or prior-connection publish can commit after its authority/lifecycle was revoked; Apple may serve an active package during the soft-delete grace period. Add terminal-state, binding and generation predicates to the committing write. Source-grounded interleaving; deterministic execution remains outstanding. [backend](reviews/07-code-backend.md), [red team](reviews/10-red-pass-delivery.md).
- **Stale tenant metadata in template cache:** a warm Worker isolate can retain an old template `orgId` after another isolate reassigns a template, allowing stale authorization on pass creation. Cache immutable payload separately and fetch tenant ownership metadata fresh. Multi-isolate reproduction outstanding. [backend](reviews/07-code-backend.md).
- **OIDC unverified-email pre-account hijack:** an unproven email claim can create/link an identity first; the real mailbox owner can later prove the email and attach passes to that identity-bearing account. Confirmed code path; actual exploitation depends on production IdP claim/group policy, which was not verified. Require proof before canonical ownership/merging. [red team](reviews/09-red-auth-tenant.md).
- **NFC authentication validation is warning-only:** an NFC-authenticated pass can build without `sharingProhibited`, despite Apple’s documented requirement to prevent older-OS sharing from bypassing NFC authentication. Make the combination a hard validation error. Do not enable NFC identities until fixed and separately approved. [wallet feasibility](reviews/28-wallet-feature-research.md), [security operations](../../security.md#owner-actions).

## P2 — High-value fixes and release checks

| Area | Highest-impact findings | Full evidence |
|---|---|---|
| Pass, webhooks, synchronization | Missing webhook dispatch can be deduplicated/lost; queued webhook jobs adopt newer authority/configuration; generation can change during build before an unfenced commit; deferred/missing records can advance or starve polling; transient preparation/rebuild errors may be acknowledged or classified as terminal. | [Backend](reviews/07-code-backend.md), [red team](reviews/10-red-pass-delivery.md), [Cloudflare runtime](reviews/13-cloudflare-runtime.md) |
| Broadcast and bulk work | API `target.scan` is dropped from recipient filtering and preview; bulk reissue truncates or misreports failure; older version workflows can downgrade passes after a newer activation; partial email batches hide already-queued work. | [Customer/business lifecycle](reviews/03-ux-customer-business.md), [backend](reviews/07-code-backend.md) |
| Holder and public behavior | Cross-org API-key pass detail exposes the account’s global primary email; holder bundle downloads omit organization-active checks; installing one paginated bundle part changes the eligibility set and can invalidate later parts. | [Red team](reviews/09-red-auth-tenant.md), [customer/business lifecycle](reviews/03-ux-customer-business.md) |
| Scanner operations and privacy | Staff sign-in UI reaches no mounted handler; event assignment offers incompatible session children; expired uncertain scans can block end-shift forever; history/replay can expose another mode’s pass title; iOS customer display does not receive camera/HID verdicts; weak/duplicate bridge acknowledgements and camera reconfiguration have races. | [Operator UX](reviews/04-ux-operator-admin.md), [scanner security](reviews/12-blue-scanner-native.md), [web/native code](reviews/08-code-web-native.md), [parity](reviews/23-parity-protocol.md), [iOS](reviews/19-ios-implementation.md) |
| Native and hardware integration | iOS declares `WKAppBoundDomains` without opting its privileged WebView into app-bound navigation; bridge operation requires runtime validation. Android capability events are dropped by the deployed `/scan` adapter. iOS NDEF is not reachable from current scanner UI; VAS is not implemented/verified on either scanner. | [iOS security](reviews/20-ios-platform-security.md), [Android security](reviews/22-android-platform-security.md), [parity](reviews/23-parity-protocol.md), [hardware](reviews/17-hardware-capabilities.md), [feasibility](reviews/18-hardware-feasibility.md) |
| Accessibility and visual quality | Scanner speech can disagree with its verdict; camera-failure focus target may not exist; short-height scanner results clip; Undo ignores hold-results; command-palette focus restoration and mobile bundle/tab relationships need fixes. Portal contains an expired-pass Add affordance. | [Scanner accessibility](reviews/16-a11y-scanner-native.md), [customer/admin accessibility](reviews/15-a11y-customer-admin.md), [customer visual](reviews/01-visual-customer.md), [cohesion](reviews/05-cohesion-design.md), [buddy/motion](reviews/06-cohesion-buddy.md) |
| Cloudflare operations | Budget deferrals can exhaust queue attempts before execution; daily key checks hide inherited KEK bindings; Status can report healthy cron/DLQ state despite terminal hook/delivery failures; safe-fetch timeout excludes DNS; D1-only restore can resurrect deleted R2 references. | [Blue-team](reviews/11-blue-platform.md), [Cloudflare runtime](reviews/13-cloudflare-runtime.md), [Cloudflare operations](reviews/14-cloudflare-ops.md) |
| Settings and admin UX | Settings lack Basic/Advanced separation; several policies have no UI controls. Some controls cannot clear saved settings. Retry email loses recipient/attachment intent; template activation in Test mode can affect live passes without accurate impact disclosure; admin create/delete/archive flows can report false outcomes. | [Global settings](reviews/25-settings-platform.md), [scanner settings](reviews/26-settings-scanner.md), [customer/business lifecycle](reviews/03-ux-customer-business.md) |
| Android build | The current capability patch fails mandatory Gradle lint at `android/app/src/main/java/im/plrs/passbook/reader/MainActivity.java:309` (`UnsupportedChromeOsCameraSystemFeature`). Use `FEATURE_CAMERA_ANY` for fallback detection and preserve front-only semantics. | [Android implementation](reviews/21-android-implementation.md), [verification](verification.md#baseline-and-integration-checks) |

The table is deliberately a triage index, not a replacement for individual findings. The full reviewer reports include affected flows, counter-controls, exact evidence and acceptance checks. P2 does **not** mean safe to release by default.

## UI, UX, settings and maintainability

The visual system is broadly coherent: a shared component kit, artwork and semantic scan verdicts support admin, portal, public and scanner screens; observed phone layouts fit without horizontal page overflow. This is not a visual/accessibility sign-off. Reports document contrast, focus, mobile assistive names, scanner sound/motion timing, stale state, recovery copy, settings provenance, misleading ownership/delivery promises, and workflow states requiring dedicated follow-up.

Maintainability is generally aided by the Worker/service/repository layering, shared validation contracts, pure PassKit engine, generated registries, and native shells delegating scanning policy to a shared web scanner. The strongest code risks are correctness at asynchronous boundaries—stale intent, retries, versions, binding/mode fences—and duplicate or mismatched native bridge contracts, not wholesale language/framework choice.

## Dedicated control/settings UX redesign

The separate [control UX redesign report](reviews/control-ux-redesign.md), [render-ready UX specification](reviews/control-ux-system.md), and [interactive mockups/screenshots](mockups/README.md) do not change this audit's security verdict or replace its global priority ranking. The mockups are additive target-state frames, not a replacement route shell; the report maps current admin routes and non-admin capabilities for preservation. No product code or existing route was changed.

## Cross-wallet decision

Current issuance, lifecycle and installation are Apple Wallet-specific; no Google Wallet or Samsung Wallet adapter was found. **Do not model another wallet as Apple `pass.json` export.** Retain a provider-neutral domain credential with separate provider-specific object/artifact state, credentials, update/revocation and installed status. Define feature support per provider, and fail closed for required semantics such as rotating credentials, identity/privacy or NFC; only degrade optional presentation with explicit disclosure. Google Wallet is feasible with issuer-backed class/object APIs and save JWTs; Samsung requires partner approval, card templates and market/device eligibility. Google Smart Tap, Samsung NFC, and Apple VAS are distinct gated protocols. See [provider coupling/design](reviews/27-wallet-providers.md) and [capability matrix/primary references](reviews/28-wallet-feature-research.md).

## Expanded customer, tenant and authoring requirements

Follow-up reviews establish the intended target and its gaps; these do not claim the features are implemented:

- **Organization isolation:** Organization membership/RBAC must be explicit, with every admin/API/resource/background action scoped server-side. Customer portfolio is an intentional exception: a verified holder can see only their own passes across issuers. Keep holder ownership distinct from org administration. See [integration audit](integration-audit.md) and [tenant RBAC review](reviews/multitenancy-rbac-security.md).
- **One logical entitlement, many wallets/devices:** Apple remains full-fidelity first-class; Google and Samsung require genuine native 1.5-class adapters with declared narrower semantics. Provider object/update/revoke and installation observations are separate; no exclusive provider or global `inWallet`. See [multi-instance lifecycle](reviews/wallet-multi-instance-lifecycle.md), [credential/revocation findings](reviews/wallet-revocation-credentials.md), and [adapter architecture](reviews/wallet-adapter-modularity.md).
- **Adaptive customer actions:** Recommend Apple on Apple devices, Samsung on eligible Samsung devices and Google on eligible generic Android; retain every other eligible wallet accessibly. UA affects ordering only, never authorization/installed state. Email includes every eligible provider’s official branded action and requirements; current flows and interim Apple badge assets are Apple-only. See [adaptive wallet offers](reviews/business-adaptive-wallet-offers.md).
- **Nontechnical authoring:** Canonical semantic content must drive provider-specific wallet projections and distinct staff, operator and customer displays. The existing scan display is not available as a proper nontechnical authoring flow; customer schema fields are not a live customer renderer. See [authoring surface model](reviews/authoring-surface-preview-model.md), [designer review](reviews/authoring-wysiwyg-designer.md), and [scan-display security](reviews/authoring-scan-display.md).

The partner audit includes a proposed lifecycle checklist and local-only evidence in [integration audit](integration-audit.md) and [business verification](business-verification.md). Provider account approval, strict partner-org admin rollout, issuer credentials and production behavior remain unverified.

## Global priority report

No P0 was established. The global P0–P3 definitions, security and target-release gates, cross-category dependencies, acceptance evidence and ordered remediation plan are in [priority report](priority-report.md). Triage is source/local-evidence based; conditional risks, owner decisions, unexecuted scenarios and unverified production configuration remain labelled.

Run the project check after implementation; Android lint/tests, iOS build and physical device/provider acceptance remain separate gates. See the priority report for the exact verification record and execution sequence.

## Audit coverage, artifacts and limitations

- The original 28 scoped investigations are retained under [`reviews/`](reviews/), followed by business, multi-tenancy, authoring, provider-lifecycle and Cloudflare-service follow-ups. Security slices include independent red/blue reviews and local reproductions.
- [`verification.md`](verification.md) records commands, observed pass/fail results, reproduction details, browser observations and the exact boundary of each claim.
- Synthetic screenshots are under [`screenshots/`](screenshots/). Examples: [portal phone](screenshots/portal-phone.png), [scanner pairing](screenshots/scanner-pairing-phone.png), [admin settings](screenshots/admin-settings.png), [iOS Duo simulator](screenshots/ios-duo-unpaired.png).
- This was a repository/local-simulator audit, not an account, production or physical-device penetration test. No real recipient delivery, production scan, remote database, deploy, signing operation, or secret-value inspection occurred. Production configuration, tenant roster, actual IdP claims, WAF/Access, email/APNs, D1/R2 recovery, residency, wallet provider approval and physical hardware acceptance remain unverified.

## Independent reports

1. [Customer visual audit](reviews/01-visual-customer.md)
2. [Scanner/admin visual audit](reviews/02-visual-scanner.md)
3. [Customer/business lifecycle](reviews/03-ux-customer-business.md)
4. [Operator/admin scanner UX](reviews/04-ux-operator-admin.md)
5. [Cross-interface cohesion](reviews/05-cohesion-design.md)
6. [Scanner buddy and motion](reviews/06-cohesion-buddy.md)
7. [Backend/pass engine](reviews/07-code-backend.md)
8. [Web/native code quality](reviews/08-code-web-native.md)
9. [Red team — authentication/tenant isolation](reviews/09-red-auth-tenant.md)
10. [Red team — pass delivery/lifecycle](reviews/10-red-pass-delivery.md)
11. [Blue team — platform defensive controls](reviews/11-blue-platform.md)
12. [Blue team — scanner/native security](reviews/12-blue-scanner-native.md)
13. [Cloudflare runtime/service fit](reviews/13-cloudflare-runtime.md)
14. [Cloudflare operations/deployment](reviews/14-cloudflare-ops.md)
15. [Accessibility — portal/public/admin](reviews/15-a11y-customer-admin.md)
16. [Accessibility — scanner/native](reviews/16-a11y-scanner-native.md)
17. [Hardware/capability inventory](reviews/17-hardware-capabilities.md)
18. [Hardware/platform feasibility](reviews/18-hardware-feasibility.md)
19. [iOS/iPadOS implementation](reviews/19-ios-implementation.md)
20. [iOS/iPadOS platform security](reviews/20-ios-platform-security.md)
21. [Android implementation](reviews/21-android-implementation.md)
22. [Android platform security](reviews/22-android-platform-security.md)
23. [Scanner capability protocol parity](reviews/23-parity-protocol.md)
24. [Cross-platform scanner runtime parity](reviews/24-parity-experience.md)
25. [Platform settings](reviews/25-settings-platform.md)
26. [Scanner settings](reviews/26-settings-scanner.md)
27. [Wallet provider architecture](reviews/27-wallet-providers.md)
28. [Wallet feature feasibility](reviews/28-wallet-feature-research.md)

## Follow-up reports

- [Partner integration and multi-tenant readiness](integration-audit.md) and [local business verification](business-verification.md).
- Business integrations: [API developer contract](reviews/business-api-developer.md), [API cross-check](reviews/business-api-cross-check.md), [inbound connector behavior](reviews/business-inbound-integrations.md), [inbound security](reviews/business-inbound-security.md), [outbound partners](reviews/business-outbound-partners.md), [data flow](reviews/business-data-flow.md), [data lifecycle](reviews/business-data-lifecycle.md), [reliability](reviews/business-reliability.md), [contract operations](reviews/business-contract-operations.md), [commercial readiness](reviews/business-commercial-readiness.md), [customer wallet entry](reviews/business-customer-wallet-entry.md), and [adaptive wallet offers](reviews/business-adaptive-wallet-offers.md).
- Multi-tenancy: [RBAC security](reviews/multitenancy-rbac-security.md), [control plane](reviews/multitenancy-control-plane.md), [schema relationships](reviews/multitenancy-schema-relationships.md), [resource isolation](reviews/multitenancy-resource-isolation.md), [lifecycle/recovery](reviews/multitenancy-lifecycle-recovery.md), [security isolation](reviews/multitenancy-security-isolation.md), and [customer portfolio](reviews/multitenancy-customer-portfolio.md).
- Authoring: [pass flow](reviews/authoring-pass-flow.md), [visual designer](reviews/authoring-visual-designer.md), [WYSIWYG designer](reviews/authoring-wysiwyg-designer.md), [layout/interactions](reviews/authoring-layout-interaction.md), [layout constraints](reviews/authoring-layout-constraints.md), [template version lifecycle](reviews/authoring-template-version-lifecycle.md), [collaboration](reviews/authoring-template-collaboration.md), [issuance trust](reviews/authoring-issuance-trust.md), [pass trust](reviews/authoring-pass-trust.md), [scan-display security](reviews/authoring-scan-display.md), and [surface-preview model](reviews/authoring-surface-preview-model.md).
- Provider-neutral wallet architecture and lifecycle: [domain model](reviews/wallet-domain-model.md), [security/degradation](reviews/wallet-security-degradation.md), [tenant wallet architecture](reviews/issuance-tenant-wallet-architecture.md), [adapter modularity](reviews/wallet-adapter-modularity.md), [adapter operations](reviews/wallet-adapter-operations.md), [multi-instance lifecycle](reviews/wallet-multi-instance-lifecycle.md), and [revocation/credentials](reviews/wallet-revocation-credentials.md).
- [Buddy visual character](reviews/buddy-visual-character.md), [buddy state/UX](reviews/buddy-state-ux.md), and [buddy system architecture](reviews/buddy-system-architecture.md).
- [Authoring interface verification](authoring-verification.md) and [screenshots](screenshots/).
