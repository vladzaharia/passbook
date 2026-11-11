# Template, scan and customer surface preview model

## Conclusion

“One design” must mean one semantic template/entitlement source, not one visual layout reused for every audience. Wallet provider presentations, staff decision cards, operator lookup/activity, visitor/customer live feed, native accessory status, and device layouts are distinct projections with separate authority rules. The mainline product has no unified nontechnical authoring/preview flow today.

### Current model

| Surface | Current source/runtime | Current gap |
|---|---|---|
| Wallet front/details | Apple `pass.json` + bindings/assets → sample PassKit build → `normalize`/`PassCardStage` | Existing visual designer, but forces target `ios27`; no clock/locale/time-zone controls. This is not provider-neutral. |
| Per-pass scan decision card | Pinned template `manifest.scan.display` → worker visibility/scope → `renderScanDisplay` → scan result UI | Schema/runtime exists, but no working no-code scan-display composition editor. Event “Result screen → Edit” opens Wallet designer; empty `/scan-display` API. |
| Operator lookup/selected pass | Root template display fields, masked email/photo policies → lookup row; selection previews stripped Apple JSON | Lookup does not use scan display; preview and result card are different projections. |
| Operator activity | Recent completed scans join the pass’s **current** display title, polling every 5s | Fixed system structure; does not use pinned authored display. Current title may differ from title retained on scan. |
| Legacy monitor | Separate read-only live feed | It is not another authored scan template. Shared-session legacy Desk can map to Operator; standalone monitor remains read-only. |
| Customer live output | Separate `liveRowFor` projection strips identity/pass/photo/scanner and supplies generic copy; only recent presented scans; no replay on reconnect | No template-authored customer content. `scan.display.customer` is accepted in schema but unused in contract/runtime/reference validation. Do not enable it by feeding staff content through CSS or late redaction. |
| iOS/Duo outside display | Separate unintegrated worktree; status-only hosted page plus UIKit fallback | Not mainline-integrated, not authorable, hardware-unverified. Android reports app-level customer display unsupported. |
| Surface selection | Scanner/Operator/Customer appearance selection and schematic admin thumbnails | Device layout changes placement, not role or authorization; there are no rendered content previews per mode. |

Source anchors: `src/web/admin/templates/designer/preview.tsx`; `src/passkit/template/scan-display/{schema.ts,render.ts,validate.ts,validate-refs.ts,defaults.ts}`; `src/worker/modules/scan/{display.ts,resolve.ts,lookup.ts,live-render.ts,repo-session-activity.ts,routes-display.ts}`; `src/shared/scan-surfaces.ts`; `src/web/scan/`.

## Confirmed design/runtime gaps

1. **Nonworking Scan editor route.** Event Result-screen edit points at `?mode=scan`, but route consumes only template ID and opens Wallet designer. Nested `designer/scan/` edits lookup configuration, not display content. Server preview router is empty.
2. **Customer schema is inert and under-validated.** `scan.display.customer` schema accepts greet/chip/panel references, but renderer/contract do not consume them and validator does not enforce corresponding customer audience/reference/row policy. Keep generic current behavior until separate projection exists.
3. **Identity source divergence.** Root `manifest.display` is list/search identity; `scan.display.holder` is an independent decision-card identity. Event template can show attendee on decision card while lookup/live/activity show event title. Live row publication and activity query also use different temporal title sources (published row vs current pass title).
4. **Default scanner is not a Wallet mirror.** Details choose primary/secondary/aux fields, not header/back/additional-info; selected rows lose native date/currency formatting and runtime has no locale strings. Do not market it as a faithful Wallet preview.
5. **Sample preview is not production-equivalent.** It seeds synthetic inputs, fields, action/history context and assets; runtime does not have all the same context. Rich renderer/example supports actions, reasons/methods and amount fields that production payload may omit. Examples must not imply non-check-in actions work.
6. **Visibility protections are incomplete across output types.** Core authored display filters roles/secrets, refuses unsafe text and suppresses panels on refusal; customer live path is separately redacted. But `passView` JSON, action values, stored titles/subtitles, lookup/live/activity use other paths. A future “hidden” control must protect derived identity, preview JSON, action values and all projections, not only authored rows. See [scanner display security report](authoring-scan-display.md) and original local reproduction in `../verification.md`.
7. **Semantic field edits do not maintain display references.** Rename/removal operations cover ordinary bindings/list projections, not all `scan.display` dependencies. Unknown references may be warnings, leaving stale references after save.
8. **Publication model differs from documented instant scan-display update.** Designer saves inactive template versions; passes resolve pinned versions. Display-only edit does not automatically reach next scan as documented unless a version/publication flow explicitly rebinds/revisions it.

## Recommended author-preview model

Canonical versioned template contains provider-neutral semantic fields, classifications, bindings, shared labels, validity/credential requirements, and reusable identity/summary choices. Keep separate projections for:

- Provider-native wallet output and provider-specific mapping/readiness.
- Staff scan decision (Door/Desk/Manager role projection).
- Operator lookup/confirmation and activity summary.
- Explicit visitor/customer live display.
- System-owned verdict, authorization, flags/actions and native accessory status.

Apple remains full-fidelity first-class adapter with migration/import from current PassJson; Google/Samsung are genuine 1.5-class adapters with native artifact, lifecycle and their own previews, not export/relabel. Every instance of one entitlement can coexist independently. Unsupported required semantics fail closed; optional presentation loss is explicit. Preview switching must not remove another provider mapping.

Use the same server-side audience sanitizer, semantic evaluation and runtime painter in preview and production. Author previews are side-effect-free, not operational authorization. Real-pass fixture data must be server-filtered for the selected audience before entering the browser. Customer is its own allowlisted projection, never “Door minus fields.” Verdict/refusal/action authority stays system-owned. Native accessory view is status-only; no extra native policy engine.

Preview controls should identify source snapshot (draft/published/issued provider instance), presentation surface, audience (role vs endpoint), synthetic/authorized fixture, verdict/state/history, clock, locale, timezone, viewport and device capabilities. Distinguish provider-native fidelity from a browser approximation.

## Observable acceptance

### P1 — Safe, truthful nontechnical editing
- Result-screen Edit opens a distinct scan-display editor, not Wallet front/back.
- Authors use semantic pickers and typed visibility/conditions, no raw expressions; every binding shows source, audience and effective privacy.
- Door/Desk/Manager previews omit forbidden information from the payload, including derived titles, action values and raw pass JSON.
- Customer preview/runtime is independently allowlisted and contains no identity/history/credentials unless expressly allowed; invalid IDs and staff-only rows block publish.
- One fixture yields matching preview/runtime identity, fields, assets, roles, flags and decision semantics; refusal cannot be replaced by authored success copy.

### P1 — Coherent publication
- Display-only publication reaches the next scan for already-issued passes without needless Wallet artifact rebuild/push, with versioned rollback.
- Pinned-template/rebind behavior is explicit. Semantic field rename/removal either updates all projections or blocks publication with repair steps.
- Unsupported action operations are visibly unavailable, never simulated as executable.

### P2 — Complete authoring semantics
- Defaults are labelled as defaults and not presented as Wallet mirror.
- Fixed time/locale/zone tests cover before/after validity, missing data/assets/photo and customer expiry/reconnect.
- Provider previews show native placement, readiness, omitted semantics and alternatives; email preview shows every eligible provider’s branded CTA and prerequisites.
- Scanner/Operator/Customer layout changes preserve authorization roles. Duo outside view previews failure/unavailable accessory; Android does not advertise unsupported app-level second display.

Source/docs inspection only; no edits, builds, tests, network or physical-device validation were performed. Mainline presence of separate worktree iOS display does not establish integration or hardware support.
