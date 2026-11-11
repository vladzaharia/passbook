# Accessibility audit — public, portal and admin

**Scope:** Main-worktree source review of shared controls/layouts, PassCard, public holder/bundle/auth SSR, email, portal, and representative admin forms, tables and dialogs. Paths below are relative to `/Users/vlad/Repos/wallet`. These are baseline audit findings, not claims that the Android working-tree patch introduced them.

No edits, builds, tests, production calls or assistive-technology sessions were performed.

## Findings

All findings below are **P2 medium, confirmed-source**; browser/screen-reader manifestations remain unexercised.

### 1. Restore focus after dismissing the command palette

`src/web/ui/command-palette.tsx:106–112` creates a state-controlled Radix dialog without a `DialogTrigger` or `onCloseAutoFocus`. Its external openers are at `src/web/ui/layout/admin-layout.tsx:45–56`. Radix prevents default restoration and focuses only its trigger (`node_modules/@radix-ui/react-dialog/dist/index.mjs:174–176`), which is absent here.

**Impact:** Esc from Search loses the invoking control/field instead of returning keyboard users to their task.

**Fix/check:** Reuse `useOpener`/`restoreOpener`. From an admin form field and the Search button, open with Cmd/Ctrl+K or keyboard activation, dismiss, and verify focus returns appropriately. See [modal focus guidance](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/).

### 2. Remove invisible keyboard stops from mobile bundle miniatures

`src/worker/ssr/bundle-page.css:66–72` disables pointer interaction and hides `.pc-seg` below 640px. However, the native radio inputs are outside that fieldset and remain focusable (`src/web/pass-card/stage.tsx:135–144`). Their visible focus indicators are applied to the now-hidden labels.

**Impact:** `/b/:token` contains invisible radio stops, especially noticeable with several passes or desktop zoom entering the mobile layout.

**Fix/check:** Hide the miniature controls themselves or retain usable visible controls. Tab through a multi-pass bundle at 375px and 400% zoom: every focus stop must be visible.

### 3. Preserve panel names when tabs become a phone select

`src/web/ui/tabs.tsx:65–78` replaces five-or-more tab triggers with a Select, unmounting the trigger elements. `TabsContent` still renders Radix panels (`:210–215`), whose `aria-labelledby` references those missing trigger IDs (`node_modules/@radix-ui/react-tabs/dist/index.mjs:174–175`).

**Impact:** Selection still works, but panel names/relationships disappear on mobile. Concrete consumers include `/admin/scanning` and `/admin/passes/:id`.

**Fix/check:** Supply valid panel naming for the select presentation. At widths below 640px, inspect every active panel’s accessible name and verify all ID references resolve.

### 4. Announce rejected sign-in fields

`src/web/portal/login-email-face.tsx:61–63,96–97` and `login-code-face.tsx:59–61,105–129` use ordinary forms with custom validation. Field errors render as non-live text, without moving focus; they bypass the shared blocked-submit behavior.

**Impact:** Submitting malformed email, incomplete code, or wrong/expired code from the submit button changes content away from focus without reliably announcing why sign-in stopped.

**Fix/check:** Reuse the kit’s error-focus/announcement pattern. Keyboard-submit each failure on `/login`; verify the invalid field receives focus and its error is announced. General server failures already use alert Callouts.

### 5. Forward time-zone validation metadata

`src/web/admin/passes/schema-form/controls.tsx:120–135` forwards only the field ID to the time-zone Combobox, dropping `aria-describedby`, `aria-invalid` and required metadata from `FormField`.

**Impact:** For a template with a required time-zone input, its displayed error is disconnected from the control. The shared invalid-field dispatcher only finds `[aria-invalid="true"]` (`src/web/ui/form.tsx:13,37–41`), so it also skips that field.

**Fix/check:** Forward the same accessibility metadata as other widgets. Create/edit a pass using a required time-zone schema; submitting it empty must focus the control and expose the error.

### 6. Preserve units in retention settings

`src/web/ui/number-field.tsx:39–44` hides the unit from assistive technology. `/admin/settings` supplies “days” solely through that suffix for Audit, Sync log and Test-data retention (`src/web/admin/settings/fields.ts:71–101`); their labels/help do not otherwise specify the unit.

**Impact:** Screen-reader users receive a retention number and range without knowing its time unit.

**Fix/check:** Include the spoken unit in the label or associated description. Focus each retention control and verify “days” is announced without requiring an invalid submission.

### 7. Identify each bundle-email Add destination

`src/worker/email/bundle.ts:44–49` emits identical “Add” links beside pass titles in separate cells; the enclosing table is presentational (`:81`). There is no programmatic association between each link and its pass title.

**Impact:** Navigating directly between email links does not identify which pass will be added.

**Fix/check:** Use link text such as “Add Thursday ticket”, or an equivalent supported association. In a multi-pass email, each Add action must identify its destination. See [link-purpose guidance](https://www.w3.org/WAI/WCAG22/Understanding/link-purpose-in-context.html).

## Contrast: intentional styling requiring correction

**P2 compliance gap; confirmed-source.** Shared placeholders use `#858b9a` on white in light mode and `#646b7d` on `#020408` in dark mode (`src/web/styles/wallet.css:25–29,57–60,88–91`; `src/web/ui/input.tsx:11–12`). Their approximate contrast is **3.41:1 / 3.85:1**, below 4.5:1 for normal text. The source explicitly intends reduced placeholder contrast, so this is a design choice—not an accidental regression.

Raise default placeholder contrast; the `prefers-contrast` override does not fix default-mode conformance. Check empty fields in both themes. [WCAG explicitly includes placeholders](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html).

## Strengths and counter-controls

- Shared forms associate labels/errors, focus invalid controls and announce an error count (`ui/field.tsx:27–62`, `ui/form.tsx:29–61`).
- General dialogs implement naming, opener restoration and dirty-dismiss confirmation. The palette exception should not be generalized to all overlays.
- PassStage makes inactive faces inert (`pass-card/stage.tsx:113–116`); tilt checks reduced motion (`tilt.ts:41–45`). Login flips have a reduced-motion presentation.
- Buttons/inputs commonly provide 44px coarse-pointer targets. Smaller fine-pointer controls require spacing assessment, not an automatic failure.
- Barcode previews identify themselves as approximate/not scannable and render supplied `altText` (`barcode.tsx:89–116`). Emails have plaintext alternatives and static artwork.

## Recommendations and remaining validation

**Product recommendation:** Provide a readable full-text pass view on public holder/bundle pages. PassCard deliberately truncates front values and scales typography with card width (`pass-card-text.css:1–29`, `pass-card-base.css:8–23`). Portal details provide an alternative; public pages do not provide the equivalent composition. Also offer a nonvisual QR-transfer action without exposing raw capability/barcode tokens.

**Validation matrix:** Run axe plus keyboard/VoiceOver/Safari and NVDA/Firefox checks on:

- `/p/:token`: active, expired, voided, removed; both faces and long fields.
- `/b/:token`: multiple passes, mobile miniatures and zoom.
- `/login`, `/auth/magic`, `/auth/breakglass`: success, validation and expired/error states.
- `/`, `/passes/:id`, `/account`: pending email, failures, QR and removal dialogs.
- Admin pass lists above 100 rows, mobile detail tabs, scanning session dialogs, designer and retention settings.

Check 320px reflow, 200% text enlargement, 400% zoom, reduced motion, both themes, and image-blocked email clients. Virtualized tables expose only a row window without row-count/index metadata (`ui/data-table.tsx:111–112,207–248`); complete AT traversal needs explicit validation.

Existing axe coverage filters to serious/critical findings and primarily visits initial pages (`e2e/10-a11y.spec.ts:7–12,38–79`); it is not whole-application evidence.

**Verdict:** Accessibility gaps remain; no P0/P1 issue was established in this source-only slice.
