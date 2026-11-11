# Scanner and Admin Visual Audit

## Scope and verdict

Inspected scanner boot, shell, operator, result/display painting, customer/legacy monitor views, admin scanning, shared controls and styles. Reviewed `8f5bee0` against its parent; the working-tree diff was empty. No edits, builds, tests, browser sessions or production calls.

**Verdict: incorrect — one P2 workflow integration gap remains after the session-only creation cutover. Confidence: 0.91.** No P0/P1 issue identified in this visual-design slice.

There is no current `src/web/scan/desk` directory: actionable desk work lives in `operator/`; the legacy read-only monitor lives in `live/`. These are different experiences, not interchangeable display designs.

## Finding

### P2 — Finish the event-assignment cutover to scanning sessions
**Confidence: confirmed-source. Patch anchor:** `src/web/admin/scanning/scanning-page.tsx:90–94`.

The Devices tab now creates session-based devices, but Events → **Assign scanners** still presents those devices and submits individual scanner IDs (`events/assign-dialog.tsx:26–30,46–56`). Its consumer calls `assertStandaloneSession` (`src/worker/modules/scan/events.ts:287`), which rejects managed children with `SCANNING_SESSION_CONFIG_REQUIRED` (`legacy-session.ts:13–19`). Consequently, following the exposed event-assignment workflow with a device created through the new UI fails.

**Counter-control:** the server correctly prevents a child device from overriding shared session configuration. Selecting an event through the session’s Passes settings is an available alternative (`sessions/session-fields.tsx:64–95`).

**Fix:** migrate the Events action to parent-session assignment/configuration, rather than offering managed children to the legacy endpoint. Preserve the server guard.

**Acceptance:** in a fresh organization, create a session and device through the UI, then configure its event from the Events page without an API-created legacy fixture or configuration-conflict error. The current event E2E creates that legacy fixture directly (`e2e/16-scan-admin.spec.ts:23–30`), so it does not establish this flow.

## Product recommendations — not confirmed patch bugs

### P3 — Differentiate blocking boot states visually
**Confidence: confirmed-source design observation.**

Blocking slate cards now use the same raised surface and muted text as ordinary boot cards (`scan/ui/scan-boot.css:39–48`), while `BootCard` always renders a happy mascot (`scan/ui/boot-card.tsx:33–35`). “Scanner unavailable” therefore has weaker visual separation from loading and pairing than the result screen’s explicit verdict hierarchy.

**Counter-control:** blocking panels retain alert announcements and focus their recovery action (`scan/boot/block-panel.tsx:38–64`).

**Recommendation:** give blocking states a restrained status icon/accent and state-appropriate mascot treatment; avoid another full-screen verdict treatment.

**Acceptance:** compare loading, pairing, paused and unavailable states side by side in both themes. Their urgency should be recognizable before reading the full sentence.

### P3 — Validate the operator’s result layout independently
**Confidence: [INFERENCE]; existing fit risk, not attributed to this patch.**

Operator mode caps the result card at 600px (`scan/operator/operator.css:111–112`), but desktop result styling reserves a 360px verdict band and uses a 128px identity photo (`scan/result/result.css:165–168,207–210`). Body padding and identity gutters further reduce the remaining content width. This deserves dedicated geometry evidence rather than assuming the polished scanner-display examples cover operator cards.

**Recommendation:** adapt the result arrangement to its container width; stack the band and details when necessary.

**Acceptance:** at desktop width, show an operator result containing a photo, long holder name, chips and panels. Confirm readable identity details and no clipped or horizontally scrolling content. Repeat with a short landscape viewport.

### P3 — Include narrow-zoom admin popups in visual acceptance
**Confidence: confirmed-source constraint; rendered clipping [INFERENCE]. Existing shared-kit behavior.**

The organization scope selector uses `Combobox` (`ui/layout/scope-switcher.tsx:34–42`). Its popup has a 224px minimum width and 16px collision padding without an available-width cap (`ui/combobox.tsx:84–88`). That exceeds the documented 195-CSS-pixel zoom scenario.

**Recommendation:** constrain popup width to available viewport space and allow its contents to adapt.

**Acceptance:** open organization scope at 200% phone zoom; the search field and options must remain usable without clipping or page-level horizontal scrolling.

## Strengths and counter-controls

- **Distinctive purposes:** the surface picker separates check-in views from Customer display, provides miniature previews and exposes selected state (`sessions/surface-picker.tsx:26–30,82–126`).
- **Real operator differentiation:** routing mounts the lookup/activity panel and removes camera UI for Operator, rather than merely enlarging the scanner display (`scan/scan-loop.tsx:108–116,142–147,200–201`).
- **Coherent visual foundation:** themed raised/sunken surfaces, separated boot header/body, consistent section spacing and responsive boot columns give the views a credible shared visual language.
- **Strong interaction primitives:** shared inputs provide 44px coarse-pointer controls and at least 16px text (`ui/input.tsx:19–24`); field errors have descriptions, and danger callouts have an icon plus alert semantics (`ui/field.tsx:24–47`; `ui/callout.tsx:48–53`). Scanner dock actions are 50px tall (`scan/ui/scan-dock.css:133–144`).

## Evidence limits

No rendered appearance, contrast, touch accuracy or hardware behavior was verified. Existing axe tests vary wrapper widths, while display-fit tests calculate specified heights; neither proves actual operator geometry (`scan/app.test.tsx:69–75`; `scan/display/display-fit.test.ts:9–18`).

Central browser acceptance should cover 320/390px phones, the 900px automatic-layout boundary, tablet landscape, light/dark themes, keyboard-open reflow, long names, offline/reconnecting states, and reduced motion. Source inspection supports a generally coherent design—not a visual sign-off.
