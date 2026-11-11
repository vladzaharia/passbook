# Visual template designer audit

**Scope:** Source-only review of `/admin/templates/:id/design` and its version lifecycle. No edits, builds, tests, browser measurements, production calls or holder data. These are existing UX/product gaps, not regressions attributed to the unrelated working-tree patch.

## What genuinely exists

This is a **structured Apple Wallet editor with live preview**, not a free-position canvas. Its implementation substantially matches `docs/design/next-wave.md:229-252`:

- **Style/layout:** Apple styles, poster/semantic options, transit type, logo text and description (`src/web/admin/templates/designer/section-style.tsx:21-79`).
- **Appearance:** three color controls with contrast warnings; style-specific PNG image slots, requirements, replacement/removal and unused-image notices (`src/web/admin/templates/designer/section-colors.tsx:6-68`; `src/web/admin/templates/designer/section-images.tsx:12-78`).
- **Front/back fields:** add/remove/reorder; label, static/input value, existing expressions, change message, alignment, date/number formatting and back-link switch (`src/web/admin/templates/designer/section-fields.tsx:16-152`; `src/web/admin/templates/designer/field-editor.tsx:23-122`).
- **Inputs/barcode:** scalar input definitions, defaults/samples, barcode format/message/alt text, scan-code binding and lookup ID. Existing list schemas/samples remain read-only (`src/web/admin/templates/designer/section-inputs.tsx:22-219`; `src/web/admin/templates/designer/section-barcode.tsx:12-71`).
- **Validation/publication:** automatic server dry-run, linked Issues, browser drafts, undo/redo, immutable saves and separate activation. Invalid saves are rejected server-side and preserve the draft (`src/web/admin/templates/designer/api.ts:36-73`; `src/web/admin/templates/designer/save-flow.ts:37-62`; `src/worker/modules/templates/versions.ts:39-156`).

## Priority usability gaps

### P1 — Make activation’s real impact explicit

**Flow:** An administrator saves a design, then chooses **Activate**, potentially while Test mode is selected.

The confirmation uses `template.passCount`, which is mode-specific and includes undeleted voided passes. Reissue instead selects active, undeleted passes across modes. Consequently, “No passes use this template yet” can precede changes to live holders.

**Evidence:** `src/web/admin/templates/activate-dialog.tsx:20-54`; `src/worker/modules/templates/repo-usage.ts:5-17`; `src/worker/modules/passes/repo-ops.ts:122-137`.

**Recommendation:** Obtain the actual eligible impact from the server; separate Live/Test counts and explain asynchronous propagation. The shared-template model itself is not the defect.

**Acceptance:** With zero test passes and eligible live passes, activation explicitly names the live impact and never claims zero affected passes.

### P2 — Connect preview selection to the property editor

**Flow:** A novice sees an incorrect field and clicks it.

The inspector correctly follows **outline** selection, including renamed fields, but the preview has no field-selection connection. Front/Details state is independent. Authors must identify the matching Header/Primary/Secondary/Auxiliary row themselves.

**Evidence:** `src/web/admin/templates/designer/preview.tsx:43-99`; `src/web/admin/templates/designer/section-fields.tsx:88-130`; `src/web/admin/templates/designer/reducer.ts:63-79`.

**Recommendation:** Add bidirectional selection and highlighting, automatically revealing the correct face. Label inspector ownership clearly: shared content versus the selected wallet’s presentation.

**Acceptance:** Selecting a preview field or its outline row opens the same properties; keyboard selection provides equivalent behavior and visible focus.

### P2 — Expose constrained placement, not imaginary layers

**Flow:** An author wants a front field on the back, or adds several detail fields.

Only one outline section opens at a time; field properties offer no **Move to area** control. Dragging works within the visible list, while arrow buttons and Alt+Arrow provide good alternatives. Per-group Add limits also conceal shared capacity: coupon/store-card secondary and auxiliary fields share four face slots.

**Evidence:** `src/web/admin/templates/designer/outline.tsx:47-75`; `src/web/admin/templates/designer/section-fields.tsx:18-44,80-152`; `src/passkit/schema/validate-fields.ts:69-88`; `src/shared/pass-view/layout.ts:161-210`.

**Recommendation:** Provide **Move to Front/Details → area**, human-readable slot explanations, shared-capacity meters and “Shown in Details” indicators. Retain drag for ordering; do not introduce arbitrary x/y positioning, z-index or layer controls that native Wallet cannot honor.

**Acceptance:** A keyboard/touch user moves a field between supported areas without recreating it; shared-slot overflow is explained before publication.

### P2 — Let authors create variable content without leaving the field

**Flow:** An author adds a membership number or combines a prefix with customer-specific data.

The Value picker distinguishes template text from existing inputs, but cannot create an input. The author must leave the field, open Inputs, create it, then return. Custom expressions are editable only when already present; they expose raw syntax. Default/Sample controls are plain text even for number, boolean and date/time inputs.

**Evidence:** `src/web/admin/templates/designer/controls.tsx:131-177`; `src/web/admin/templates/designer/field-editor.tsx:41-64`; `src/web/admin/templates/designer/section-inputs.tsx:22-85`.

**Recommendation:** Add **Create pass input** inside Value, typed default/sample controls and a literal-plus-field token composer. Keep identifiers, raw expressions and formatting mechanics under Advanced. Explain that template text affects everyone, inputs vary per pass, and samples only drive preview.

**Acceptance:** A novice creates “Member [membership number]”, supplies a valid example and sees the generated issuance form without typing expression syntax.

### P2 — Make preview fidelity and freshness visible

The designer fixes preview to iOS 27 although the renderer supports legacy layouts and the design rules require a target switch. When validation fails, it deliberately retains the last successful pass, but does not label that card as stale; draft images continue updating independently.

**Evidence:** `src/web/admin/templates/designer/preview.tsx:59-95`; `src/web/admin/templates/designer/api.ts:36-56`; `src/web/admin/templates/designer/designer.tsx:259-265`; `docs/design/ux-principles.md:133-140`.

**Recommendation:** Reuse the existing OS-target toggle, identify browser approximation, and explicitly label **Last valid preview**. Keep preview assets consistent with its validated snapshot.

**Acceptance:** Poster/fallback differences are inspectable; an invalid edit cannot leave an apparently current, successful preview.

### P2 — Make saved versions maintainable before activation

The designer opens the active version only. Versions exposes **Report** and **Activate**, but no selected-version preview, comparison or **Edit this version**. Rollback is possible by activating an older snapshot, without a dedicated comparison/recovery journey.

**Evidence:** `src/web/admin/templates/designer/designer-page.tsx:112-143`; `src/web/admin/templates/versions-panel.tsx:48-108`.

**Recommendation:** Allow resuming inactive saved versions; add change summaries and before/after previews. Identify historical activation as rollback and explain its reissue consequences.

**Acceptance:** Another maintainer can inspect, continue and review an inactive version without first publishing it.

## Clarified wallet direction

Use canonical **semantic content**, with Apple’s full-fidelity native presentation as the primary adapter—not Apple `pass.json` as the universal authored document. Preserve existing Apple mappings, immutable history and issued credentials through migration.

Google/Samsung may remain deliberately narrower **1.5-class** integrations, but need real native issuance/update, readiness and provider-specific previews/diffs. Preflight must expose optional omissions/fallbacks and block unsupported required semantics. Provider tabs are viewing lenses, never mutually exclusive ownership: one domain pass may have several provider/device installations. Release impact must distinguish domain passes from wallet instances.

## Desktop, tablet and phone

Desktop uses three columns; 768–1279px places issues beneath the preview; 640–767px stacks; below 640px is intentionally preview-only. Touch targets already receive 44px treatment (`src/web/admin/templates/designer/designer.css:1-33,208-222`; `src/web/admin/templates/designer/layout.tsx:23-45`).

**[INFERENCE]** Narrow tablet inspectors warrant visual validation, not an asserted overflow defect. Acceptance should cover 1440, 1180, 820 and 390px, keyboard/touch and enlarged text. Phone review should retain version/provider identity and warnings even while editing remains unavailable.
