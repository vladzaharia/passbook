# Consolidated Scanner and Native Security Audit

## Scope and evidence

Read-only inspection of Worker scan/NFC services, shared contracts, pairing/staff/device authorization, photos/history, scanner bridges/runtime/offline storage, Android WebView/manifest/NFC parser, and discovered iOS Swift/configuration sources.

Main paths are relative to `/Users/vlad/Repos/wallet`; iOS paths to `/private/tmp/wallet-ios-scanner`. **No edits, network calls, builds, tests or payload execution.** All six findings are **confirmed-source**; acceptance scenarios remain unexercised by this reviewer.

## Findings — bugs

### 1. P1 high — Raw pass preview bypasses secret and role filtering

**Evidence:** `src/worker/modules/scan/dto.ts:16-36,208-212`; `src/worker/modules/scan/resolve-outcome.ts:30-41`; compare `src/worker/modules/scan/display.ts:64-84`.

A paired Door scanner presenting an accepted pass receives `card.passView.passJson`. Unlike the rendered display, this representation does not apply secret-input or `x-scan` restrictions: it removes six credential keys and masks email-shaped strings.

Phone fields, role-hidden pass fields, Wi-Fi credentials and management URLs can survive. Concrete bindings occur in `templates/starter-generic/wallet.template.json:248-250,309-313` and `templates/starter-boarding-pass/wallet.template.json:567-579`. Authority conveyed by external management links remains unverified.

**Counter-control:** Tenant, mode and accepted-template checks still apply.

**Fix/check:** Apply consistent role/secret filtering to every representation. Resolve a sentinel-filled pass as Door and inspect the **complete JSON response**, not just `display`, for prohibited values.

### 2. P1 high — Wallet thumbnail bypasses member-photo restrictions

**Evidence:** `src/worker/modules/scan/routes.ts:225-235`; `src/worker/modules/public/service.ts:92-96,151-158`; `src/worker/modules/passes/repo-member-photo.ts:67-76`; `src/worker/modules/scan/dto.ts:150-152,208-212`.

With `includeInPass=true`, the private member photo becomes `thumbnail@3x.png`. Scanner asset authorization checks photo permissions only for `member.png`; the thumbnail follows the general asset handler.

A scanner denied photos by `showPhoto=false` or photo `minRole` can obtain its normal card grant and retrieve the same photo through the thumbnail alias.

**Counter-control:** Grants remain actor/pass-bound and expiring; access is not anonymous.

**Fix/check:** Authorize the underlying photo across all aliases and preview manifests. Test both photo-off and insufficient-role cases: neither member nor thumbnail paths may return the image.

### 3. P1 high — Capacity override inherits ordinary re-entry permission

**Evidence:** `src/worker/modules/scan/act.ts:81-97`; `src/worker/modules/scan/rules.ts:96-101`; `src/worker/modules/scan/act-check-in.ts:48-51`. Required Manager boundary: `docs/design/scanner/scanner-architecture.md:325`.

Every override except cooldown is authorized as `let_in_again`. Default `letInAgain='anyone'` therefore lets Door staff override `capacity_full` without a Manager PIN; commit removes the capacity predicate.

Existing test source explicitly expects this over-capacity admission without approval. This is an implemented-policy mismatch, not a concurrency conjecture.

**Counter-control:** The override must reference the actor’s recent eligible scan and match its pass/action.

**Fix/check:** Make capacity exceptions independently Manager-only. At capacity one, an unapproved second admission must not commit; an approved exception must record its approver.

### 4. P2 medium — Metadata PATCH promotes read-only screen credentials

**Evidence:** `src/worker/modules/scan/scanning-devices.ts:93-114`; `src/shared/scan-surfaces.ts:14-20`; `src/worker/modules/scan/repo-scanning-devices.ts:122`; `src/shared/contracts/scanning-sessions.ts:112-119`.

A rename preserving legacy `surface:'desk'` recalculates Desk → Operator → `scan`, also converting `display` into `device`. The paired credential remains unchanged.

A name-only wire PATCH is stronger: creation defaults survive `.partial()`, supplying `surface:'auto'` and `overrides:{}`. Installed Zod source confirms this behavior (`node_modules/zod/v4/core/schemas.js:2102-2124,2158-2173`). Auto remains actionable after later reports. Customer devices are also affected.

**Preconditions/counter-controls:** PATCH requires administrator authentication (`routes-scanning-sessions.ts:32`); monitors cannot perform it themselves. The resulting screen holder gains unintended mutation authority. Standalone monitors with omitted accepts default to accepting all templates (`setups.ts:149-154`).

**Fix/check:** Preserve omitted PATCH fields and separate layout normalization from authorization. Pair a standalone monitor, confirm `403 SCREEN_ONLY`, rename it as administrator, then retry a valid action with unchanged monitor credentials. It must remain forbidden before and after capability reporting.

### 5. P2 medium — Historical responses bypass mode isolation

**Evidence:** `src/worker/modules/scan/repo-scans.ts:191-198`; `src/worker/modules/scan/repo-session-activity.ts:21-25`; `src/worker/modules/scan/act-replay.ts:26-29,83-85`.

Initial evaluation suppresses identity for other-mode passes, but refused scans retain their pass ID. Recent/activity queries join its title without matching the referenced pass’s mode.

After a scanner changes mode, replaying an earlier successful key also loads and renders the original pass without checking its mode against the current actor.

**Counter-control:** Candidate retrieval remains tenant-scoped; live-hub publication explicitly redacts other-mode identities.

**Fix/check:** Enforce mode constraints on historical references and replay rendering. Other-mode rejection must reveal no title through history; replay after switching modes must reveal no previous-mode display.

### 6. P2 medium — Pending scans can migrate into another event

**Evidence:** `src/web/scan/platform/runtime.ts:60-64,195-205`; `src/web/scan/machine/store.ts:168-185`; `src/web/scan/machine/commands.ts:199-214`; `src/worker/modules/scan/act-claim.ts:16-31,43-50`.

Scope reconciliation runs at runtime creation, not live updates. An uncertain request retains no original event provenance. If its initial transmission never reached the Worker, reassignment from event A to B can cause its retry to admit into B without another presentation.

**Counter-controls:** Current pass restrictions still run; automatic retries expire after two minutes.

**Fix/check:** Bind pending requests to their original scope/revision and invalidate memory/persistence on scope changes. Drop an A request before receipt, switch to B, restore connectivity: no B admission may result.

## Strengths and useful negative evidence

- Hashed credentials, expiring atomic pairing, current-row revocation checks and cookie CSRF protection.
- PIN attempts reserved before comparison: five misses per person/scanner per five minutes, twenty per scanner/hour (`staff-pin.ts:50-69`).
- Ordinary capability reports do not independently promote explicitly configured Customer screens.
- Android checks configured HTTPS origin/main frame, disables file/content/mixed-content access, gates debugging, and excludes backup/transfer.
- iOS checks HTTPS host/main frame, foreground state and correlated result IDs; navigation/backgrounding stops hardware. No credible cross-origin bridge exploit survived review.
- VAS cryptograms are rejected rather than treated as verified. Customer live rows redact identity.

## Recommendations and limitations

**Product recommendation, not confirmed vulnerability:** Fleet-lock Android verifier settings on unattended devices; configuration intentionally changes the trusted origin.

Staff sign-in/admin, roster/batch and NFC backend surfaces remain absent/placeholders; helper review does not establish operational end-to-end services. iOS NDEF entitlement is not Wallet VAS authorization: primary references are [Core NFC](https://developer.apple.com/documentation/corenfc) and [ProximityReader](https://developer.apple.com/documentation/proximityreader), not fetched during this review.

Apple/provider approval, physical NFC/HID behavior, installed release safeguards and production behavior remain unverified. Parent-run reproduction evidence is separate.
