# Pass creation and per-pass maintenance audit

Source-only; no browser, builds, tests, edits, or production calls. Paths are repository-relative. Layout/usability consequences below are **[INFERENCE]** unless the source explicitly demonstrates a mismatch.

## Journey and control ownership

- **Create:** `/admin/passes/new` proceeds through Organization → Template → Details → Holder → Review. Organization is skipped for scoped/deep-linked/single-organization flows; only active templates with active versions appear (`src/web/admin/passes/new-pass-page.tsx:63-90`).
- **Content:** Details and the existing pass’s Fields tab edit schema-declared values, not field placement, labels, or template structure (`src/web/admin/passes/schema-form/schema.ts:135-158,288-290`). This is a structured form with a live preview—not direct manipulation. Template **Design** already exists separately (`src/web/admin/templates/detail-page.tsx:165-178`).
- **Recipient:** Holder email/ownership is separate from displayed names or identifiers. The customer page presents pass details and Wallet actions, rather than this authoring form (`src/web/portal/pass-detail-page.tsx:37-56,76-104`).
- **Confirmation/maintenance:** Creation opens the pass detail page with Send/Add holder, Copy link, and Create another actions (`src/web/admin/passes/detail/callouts.tsx:72-124`). Fields supports drafts, saving, discarding, and version conflicts.

## Positive patterns to preserve

Schema labels, grouping, defaults, typed widgets, and inline validation provide a strong non-technical foundation. Invalid submission focuses the first invalid control and announces an error count (`src/web/ui/form.tsx:27-60`). Native radio tiles support arrows/Enter (`src/web/ui/option-tile.tsx:22-70`); repeated fields have explicit reorder buttons, Alt-arrow shortcuts, and announcements (`src/web/admin/passes/schema-form/list-input.tsx:37-40,218-246`).

Creation retries reuse an idempotency key; updates send only changed fields with `If-Match` (`src/web/admin/passes/new-pass-create.ts:30-36`; `src/web/admin/passes/detail/fields-tab.tsx:129-140`). Responsive Show pass alternatives already exist (`src/web/admin/passes/preview-layout.tsx:18-65`).

## Prioritized recommendations

### P1 — Correct recipient-transfer timing and partial-success messaging

**Persona/state:** An operator changes an owned pass’s recipient.

**Evidence:** The dialog says the current owner loses the pass “once the new holder signs in” (`src/web/admin/passes/detail/holder-tab.tsx:75-77`). Reassignment actually clears ownership immediately, then attempts attachment (`src/worker/modules/holders/repo.ts:226-239`; `src/worker/modules/holders/service.ts:160-185`). Assignment and sending are separate awaited requests; email failure displays an error after assignment has succeeded (`holder-tab.tsx:51-62`).

**Change:** Explain immediate account reassignment, distinguish it from Wallet removal, and report “Holder changed; email not sent” with a resend action.

**Observable acceptance:** Reassign to an unregistered synthetic address without signing in; ownership changes immediately. Force subsequent email failure; the dialog clearly acknowledges the completed transfer.

### P1 — Stop treating requested email as confirmed sending

**Persona/state:** An operator chooses Create and send.

**Evidence:** The created marker records `payload.sendEmail`, not delivery outcome (`src/web/admin/passes/new-pass-create.ts:39-44`). The confirmation consequently says “created and sent” (`src/web/admin/passes/detail/callouts.tsx:87-90`), although creation deliberately succeeds when email enqueueing is rate-limited (`src/worker/modules/passes/create.ts:179-193`).

**Change:** Separate Created, Email queued, and Email not sent states; link to Delivery and offer safe retry.

**Observable acceptance:** Locally simulate email limiting: one pass is created, no “sent” claim appears, and retry cannot create another pass.

### P2 — Make sample ghosts and preview failure explicit

**Persona/state:** A novice completes Details, then clears a required field or changes templates.

**Evidence:** Empty required values borrow samples (`src/web/admin/passes/new-pass-preview.tsx:19-30`). The `dealt` flag becomes true once and never resets; opacity is its only sample distinction (`:59-71,92-100`). Preview errors are not exposed in the returned state; missing preview data renders a skeleton.

**Change:** Show a textual “Sample values—not saved” indicator whenever substitutions exist. Expose updating/error states and distinguish any last successful preview from current values.

**Observable acceptance:** Fill then clear Name: the sample is unmistakably labeled. Fail preview loading: users receive an explanation and retry action, not indefinite loading.

### P2 — Let Review genuinely review the complete pass

**Persona/state:** An operator checks expiry, back text, links, or repeated entries before issuance.

**Evidence:** Review silently limits content to four fields; arrays become item counts (`src/web/admin/passes/new-pass-review.tsx:6-13,50-60`). The wizard uses `PassPreview` without face controls (`new-pass-preview.tsx:94-102`), whose default is front-only (`src/web/admin/passes/pass-preview.tsx:75-79`). The detail preview already provides Front/Details and approximation handling (`:109-188`).

**Change:** Provide all populated values in expandable schema groups, readable dates/options, expandable list contents, and the existing two-sided preview. Label it a Wallet approximation.

**Observable acceptance:** On Generic, enter expiry, Message, and Wi-Fi details; every value and the back are inspectable before Create, including on a phone.

### P2 — Keep issuer context visible and warn before clearing values

**Persona/state:** A scoped partner enters from a template, then changes organization/template.

**Evidence:** Organization can be omitted from the steps and its Review edit action (`src/web/admin/passes/new-pass-page.tsx:63-72,289-293`). Changing either choice immediately clears input (`:166-179`).

**Change:** Keep an issuer/template summary visible. Explain “Details changes this pass only”; route structural changes to template Design. Warn before replacing a choice that clears authored values.

**Observable acceptance:** A deep-linked operator can identify the issuer before typing; switching templates with entered values offers Keep editing versus Change and clear.

### P2 — Explain conflict resolution rather than implying a neutral merge

**Persona/state:** Two maintainers edit the same pass.

**Evidence:** “Merge my edits” overlays all locally changed keys onto the latest values (`src/web/admin/passes/detail/fields-tab.tsx:120-124,219-230`). No overlapping-field comparison is shown.

**Change:** Present “Saved / Yours” for overlapping changes, explicit per-field choices, and clearer “Discard my edits and reload” wording. Preserve automatic merging for non-overlapping changes.

**Observable acceptance:** Two sessions change the same field: neither value is silently selected. Different-field edits survive merging; discard restores saved content and clears the Unsaved state.

### P2 — Make connection ownership and immediate resets understandable

**Persona/state:** Partner staff maintain synchronized content.

**Evidence:** Connection-owned fields are disabled; their source chip only offers a tooltip (`src/web/admin/passes/schema-form/schema-form.tsx:139-168,217-230`). “Use the connection’s value” immediately PATCHes the pass, outside Save (`src/web/admin/passes/detail/fields-tab.tsx:168-179`).

**Change:** Link to the connection/source workflow and either stage reset until Save or explicitly label/confirm its immediate effect. Explain that Save updates this pass; Notify holders controls notification messaging, not publication.

**Observable acceptance:** Keyboard users can discover where to edit locked content. Reset timing is explicit, and subsequent Discard cannot appear to undo an already-persisted reset.

### P2 — Give unavailable and invalid states a usable next step

**Evidence:** Missing schema produces no validation errors, while Details shows loading/error; the wizard does not supply `nextDisabled` (`src/web/admin/passes/new-pass-page.tsx:137-148,202-215,251-256`). Empty organization/template states have no recovery actions (`new-pass-steps.tsx:87-89,156-159`). Server errors on Review merely direct users back to Details or Holder (`new-pass-page.tsx:297-303`).

**Change/acceptance:** Block progression until fields load; provide Retry and permission-appropriate organization/template actions. A server field rejection should offer a direct route to—and focus—the offending control while retaining input.

**Interaction direction:** Retain structured forms. No source evidence establishes a benefit from drag-and-drop here; preserve keyboard controls, responsive stacking, and phone preview access.
