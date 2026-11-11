# Pass-authoring trust audit

**Method:** Source-only; no edits, checks, external calls or holder data. Acceptances below are proposed, not exercised. These findings concern current authoring behavior, not the unrelated Android diff.

**Existing safeguards:** The wizard seeds defaults, validates holder email and protects identical create retries. Fields preserves dirty drafts, uses `If-Match` and offers conflict recovery. Pass detail already provides Front/Details previews; image replacement has keyboard-accessible buttons. Instance forms edit declared **data**, not reusable template structure.

## Findings

### P1 — A Test draft can become a Live issuance

**Flow:** A clerk reviews a Test pass; another tab disables Test mode. Mode synchronizes across tabs, and requests use the current mode—not the draft’s original mode. Review does not name the mode; entering a valid email automatically selects sending.

**Evidence:** `src/web/lib/mode.ts:38-56`; `src/web/lib/api.ts:58-62`; `src/web/admin/passes/new-pass-page.tsx:95-118`; `new-pass-review.tsx:54-61`.

**Change/acceptance:** Bind issuance intent to an explicitly reviewed mode. Changing mode must invalidate that review. A synthetic Test draft must not silently create/send Live after another tab switches modes. Show the full recipient without truncation.

### P1 — Delivery Retry changes recipient and attachment intent

**Flow:** An operator sends an attached pass to an alternate address. After failure, Outbox **Retry** sends to the current holder instead and drops the attachment: Retry supplies neither original value.

**Evidence:** `src/web/admin/passes/detail/delivery-tab.tsx:75-81,148-151`; `src/worker/modules/passes/service.ts:216-231`; `src/worker/modules/delivery/service.ts:119-134`.

**Change/acceptance:** Retry the recorded delivery intent, displaying its destination and attachment. With synthetic holder A and alternate recipient B, Retry must target B with the original attachment—not A.

### P1 — Reviewed and edited template versions can diverge

The wizard omits `templateVersion`, so creation resolves whichever version is active at submission. Existing-pass Fields loads the active template’s schema, while PATCH retains the pass’s stored template version. An older pass can therefore display inputs belonging to a different build contract.

**Evidence:** `src/web/admin/passes/new-pass-page.tsx:109-118`; `detail/pass-tabs.tsx:47-55`; `src/worker/modules/templates/service.ts:136-149`; `src/worker/modules/passes/publish.ts:87-98`.

**Change/acceptance:** Pin the reviewed definition version; edit existing passes against their actual version. Activate v2 after reviewing v1: creation must retain v1 or explicitly require re-review. A v1 pass must not require v2-only inputs.

### P2 — Draft preview does not represent actual packaged images

Preview applies organization text/colors, but returns template/preview-only assets. Actual packaging additionally applies organization branding, per-pass overrides and member-photo thumbnails. Editing an unrelated field can consequently display different artwork from the eventual package.

**Evidence:** `src/worker/modules/templates/service.ts:233-270`; `src/worker/modules/passes/builder.ts:188-224`; `src/web/admin/passes/detail/detail-page.tsx:115-138`.

**Change/acceptance:** Preview the proposed update using the existing pass’s complete issuance context. A synthetic branded pass with a custom thumbnail must retain both images throughout editing and packaging.

### P2 — API-created passes hide effective defaults

API creation stores supplied input unchanged; binding and validation apply defaults separately. Fields initializes only from stored personalization. Consequently a package can show “Standard” and zero points while its editable controls appear blank. Required inputs with defaults can also fail client validation despite being valid server-side.

**Evidence:** `src/worker/modules/passes/create.ts:118`; `src/passkit/template/manifest.ts:260-274`; `src/web/admin/passes/detail/fields-tab.tsx:75-80`; `schema-form/schema.ts:189-191,269-277`.

**Change/acceptance:** Display effective values with “Template default” provenance, preserving unset versus explicit values. Create a synthetic Generic pass through the API without tier/points: Fields and packaged content must agree; unrelated edits must remain saveable.

### P2 — Visible validation errors do not consistently block or guide

Invalid location text stays local while the form retains its last valid coordinates; parent validation checks only stored values. Next/Save can therefore accept a form displaying a location error. Boolean/time-zone controls also discard validation ARIA properties, while blocked-submit focus searches specifically for `aria-invalid`.

**Evidence:** `src/web/admin/passes/schema-form/location-input.tsx:33-43,62-68`; `new-pass-page.tsx:137-148`; `schema-form/controls.tsx:52-62,120-134`; `src/web/ui/form.tsx:13,37-49`.

**Change/acceptance:** Composite controls must participate in form validity and preserve error semantics. Invalid synthetic coordinates must block submission and receive focus. Required yes/no and time-zone errors must be announced and keyboard-reachable.

### P2 — Preview and final review overstate completeness

Wizard preview uses sample substitutions, exposes no Front/Details control, and does not surface preview fetching/errors. Previous preview data is retained during recalculation. Review shows only four fields and reduces lists to counts. The semantic-layout “Approximate” chip exists in detail’s panel, not the wizard; the barcode disclaimer is screen-reader-only.

**Evidence:** `src/web/admin/passes/new-pass-preview.tsx:19-28,59-102`; `src/web/admin/templates/api.ts:181-196`; `new-pass-review.tsx:11-12,50-53`; `pass-preview.tsx:180-205`; `src/web/pass-card/barcode.tsx:114-116`.

**Change/acceptance:** Label Sample/Updating/Unavailable states and browser approximation visibly. Provide keyboard/mobile front/back controls and expandable complete effective values. A synthetic pass with back terms, expiry and five-plus inputs must be fully inspectable before issuance; failed previews must never look current.

### P2 — Draft loss and field-location explanations need explicit ownership

Changing organization/template clears entered values without a reset confirmation. Separately, the form infers “Shown on the back” from the textarea widget—not its binding. A legitimate long-text input bound to the front therefore receives misleading guidance.

**Evidence:** `src/web/admin/passes/new-pass-page.tsx:166-179`; `schema-form/schema-form.tsx:155-161`.

**Change/acceptance:** Confirm destructive draft resets; explain field destinations from bindings/audience metadata. A synthetic front-bound textarea must identify its actual destination. Keep structured forms and explicit buttons; drag/drop does not solve these problems.

## Baseline blockers still present

Already documented in `docs/audits/2026-11-07/reviews/03-ux-customer-business.md`:

- **P1:** Unchecked connection takeover still omits the boolean, whose server default takes over fields (`detail/connection-tab.tsx:47-59`; worker `passes/connection-bind.ts:43-47`). Unchecked binding must preserve manual ownership.
- **P2:** Create can suppress email-cap failure yet display “sent” (`passes/create.ts:179-189`; web `new-pass-create.ts:43`). Report created/queued/captured/failed separately.
- **P2:** Discard can leave “Never expires” checked after restoring expiry (`schema-form/datetime-input.tsx:51,99-103`; `detail/fields-tab.tsx:265-266`). Checkbox and saved date must agree.
- **P2:** Holder reassignment clears ownership immediately, contrary to dialog timing copy; email failure follows an already-committed transfer (`detail/holder-tab.tsx:48-62,77`; worker `holders/repo.ts:234`). Explain immediate effect and offer send-only recovery.

## Updated provider authoring contract

Use a **platform-neutral semantic definition**, with Apple the full-fidelity primary adapter and Google/Samsung real native adapters supporting declared narrower subsets. Review must show provider-specific previews, diffs, readiness, defaults and explicit optional omissions; unsupported **required** semantics block issuance. Preserve current Apple identifiers, credentials and registrations through cutover.

One entitlement must support concurrent provider/device instances—not exclusive provider selection. Show independent lifecycle outcomes and honest unknown installation states; saving must not imply every device updated.

Author previews should include customer/scanner exposure and the outgoing email: all eligible providers need compliant branded buttons and precise eligibility requirements. Public web may recommend a likely wallet, with accessible alternatives—not UA-based exclusion.

**Acceptance:** One synthetic entitlement remains usable across Apple and another eligible provider simultaneously; an individual instance failure/revocation neither duplicates nor voids the entitlement’s other instances, and provider fan-out does not multiply invitation emails.
