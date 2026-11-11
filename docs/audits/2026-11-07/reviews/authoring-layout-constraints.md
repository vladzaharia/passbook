# Template layout editing: constrained builder, not page canvas

**Recommendation:** retain structured editing, add clearer placement controls and an annotated, selectable preview. Do not replace it with a free-position canvas.

**Evidence boundary:** source-only audit; no edits, builds, tests, browser/device checks, or provider calls. Interaction friction below is explicitly marked as inference.

## What already exists

This is **not JSON-only authoring**. The designer supports grouped field ordering, labels, static/input-bound values, formatting, colors, image slots, style selection, undo, and a live Front/Details preview:

- `src/web/admin/templates/designer/outline.tsx:83-118`
- `src/web/admin/templates/designer/field-editor.tsx:23-128`
- `src/web/admin/templates/designer/preview.tsx:43-95`

However, it is a **schema-driven inspector with visual feedback**, not direct manipulation: the preview renders `PassCardStage` without field-selection/edit callbacks.

### Three models must remain distinct

1. **Apple Wallet layout:** ordered arrays in predefined groups, not arbitrary coordinates. The actual generic package contains `headerFields`, `primaryFields`, `secondaryFields`, and `backFields` (`templates/starter-generic/pass.json:46-119`). The event package adds constrained auxiliary rows, including `row: 0/1` (`templates/starter-event-ticket/pass.json:86-104`). Validation limits that row property to event-ticket auxiliary fields (`src/passkit/schema/validate-fields.ts:218-222`).

2. **Pass-entry form:** the template’s input schema determines what a colleague fills in for an individual pass. The Fields tab selects declared personalization values and saves `input`, not layout (`src/web/admin/passes/detail/fields-tab.tsx:75-82,128-134`).

3. **Scanner/customer display:** a separate ordered panel/row schema with typed components and two-to-four-column rows—not unrestricted nested stacks (`src/passkit/template/scan-display/schema.ts:131-240,257-278`). Rendering also removes trailing content to fit (`render.ts:56-73,175`). The proposed scanner canvas remains explicitly described as unbuilt in `docs/design/scanner/display-model.md:1414-1435`; the current designer outline does not mount that editor.

**Tradeoff:** an explicit form builder benefits input labels, choices, grouping, validation, and help. A constrained preview benefits understanding Wallet regions and scanner panels. An arbitrary page builder would imply positioning, nesting, typography, and wrapping guarantees these models do not provide.

## Prioritized critique

### P1 — Make publication predictable across editing paths

**Persona/state:** another administrator maintains an existing, issued template.

The visual designer saves with `activate: false` (`src/web/admin/templates/designer/save-flow.ts:49`), followed by a distinct Activate action. Conversely, Manifest JSON save calls `replaceManifest` and reports only “Manifest saved” (`src/web/admin/templates/manifest-editor.tsx:43-45`). That server path calls `commitVersion` without disabling activation (`src/worker/modules/templates/mutations.ts:202-217`); persistence activates existing templates by default (`persist.ts:106-116`).

Thus the expert escape hatch has materially different publication consequences.

**Direction:** use the same Save version → Review → Activate contract for structured, JSON, and imported updates. Keep JSON explicitly “Advanced”; distinguish `wallet.template.json` from Wallet `pass.json`. Show organization, draft base, active version, affected pass count, and which surface changes. Preserve the existing built-in Duplicate path (`designer-page.tsx:70-106`).

For concurrent maintainers, display when the active version changes beneath an open draft: the current designer intentionally keeps its original base (`designer-page.tsx:114-117`). Do not assume a new ownership or permissions policy.

### P2 — Replace implicit movement with explicit placement

**Persona/state:** an author wants “Member number” on the back instead of the front.

There are useful existing alternatives to dragging: Up/Down buttons, Alt+Arrow shortcuts, and an announced new position (`section-fields.tsx:28-38,94-135`). Preserve these.

But nudging stays within its group. Cross-group movement exists in the data operation (`ops-pass.ts:123-139`), while disclosure content mounts only for the selected section (`outline.tsx:48-78`). There is no explicit “Move to another group” control.

**[INFERENCE]** Requiring authors to discover drag behavior and translate Primary/Secondary/Auxiliary into visible regions makes this task harder than a placement selector.

**Direction:** add “Location” and “Position” controls, using names such as “Main information (Primary)” and “Pass details (Back).” Show effective capacity and non-displayed fields. Counts depend on style and barcode; secondary/auxiliary can share four slots, and poster-generic secondary/auxiliary are not shown (`validate-fields.ts:38-90`). Keep drag optional, not the only route.

### P2 — Finish typed authoring before adding canvas complexity

**Persona/state:** a non-engineer maintains imported numeric fields or creates a choice/list input.

The input palette offers seven scalar types; existing lists retain their rows/schema without an editor (`inputs.ts:3-14`; `section-inputs.tsx:35-66`). Yet pass-entry rendering already understands choices, groups, help, and nested lists (`src/web/admin/passes/schema-form/schema.ts:93-155`).

A concrete mismatch also exists: static Wallet numeric values appear blank in the Text control because `str` rejects numbers; editing writes a string (`field-editor.tsx:20,47-52`). Number formatting requires numeric values (`validate-fields.ts:191-195`).

**Direction:** provide typed value controls, a choice editor, form grouping/help, and supported list-item editing. Separate “Data collected per pass” from “Where it appears.” Hide identifiers, expressions, and advanced Apple properties behind progressive disclosure without destroying imported properties.

### P2 — Make preview limitations and overflow observable

**Persona/state:** an author approves long names, multilingual text, or poster/legacy layouts.

The designer always targets `ios27`; only semantic approximations receive the Approximate badge (`preview.tsx:75,91-95`). The normalized model already contains both modern and legacy layouts (`src/shared/pass-view/normalize.ts:46`). Invalid drafts retain the last successfully built card (`designer/api.ts:54-58`).

Front text truncates with ellipsis; primary text uses length-based size reductions, while details wrap (`src/web/pass-card/pass-card-text.css:1-29,108-111`). Semantic poster titles come from semantics rather than necessarily the primary-field array (`front.tsx:156-164`).

**Direction:** always label the preview as a browser approximation; expose modern/legacy selection, sample inputs, and “Showing last valid preview.” Identify clipped, details-only, and semantic-controlled content. Offer long/empty/localized synthetic samples, not real holder records.

### P2 — Provide a responsive form alternative

Below 640px, structure and issues are replaced by preview-only content; saving is also hidden (`layout.tsx:23-39`; `designer.tsx:274-282`; `src/web/lib/media.ts:22`). Coarse-pointer CSS enlarges field selection and drag grips to 44px (`designer.css:209-220`), but this is not evidence of successful touch dragging.

**Direction:** provide phone Edit/Preview tabs with the same structured controls, validation, and publication flow. No compressed desktop canvas or drag dependency.

## Conceptual wireframe

Header: **Template · Organization · Based on Version N · Active Version M**.

Surface switcher: **Pass-entry form | Wallet | Scanner/operator | Customer**—clearly separating capabilities not yet implemented.

Wallet: **Front / Details**, region outline with capacities, selected-field properties, annotated preview, and linked issues. Preview selection opens the same inspector; it never enables free positioning.

## Observable acceptance scenarios

- Keyboard and touch users move a field between valid groups, choose its position, hear confirmation, and undo without dragging.
- Numeric static fields retain their value/type; authors create choices and list inputs without JSON.
- Long and empty synthetic values reveal clipping and details-only content; modern/legacy differences and stale previews are explicit.
- A phone user edits a label, resolves an error, saves, and previews without losing the draft.
- Structured, JSON, and import updates do not change issued passes before explicit activation; activation states its scope.
- Two maintainers retain independent drafts; a changed active base is visible before publication. Wallet edits do not implicitly alter scanner/customer display configuration.
