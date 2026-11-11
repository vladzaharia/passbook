## Conclusion

The scanner-content model and renderer exist, but the nontechnical editor does not. Several capabilities described in the scanner design document are also **not wired into production**. Building only the missing editor would therefore expose controls that cannot deliver their advertised result.

Scanner authoring should be a separate, platform-neutral template surface—not an extension of Apple Wallet field layout. Apple remains full-fidelity primary; Google/Samsung can declare narrower native capabilities. All installed wallet/device instances of one entitlement should share its scanner content and check-in state.

## 1. Exact current implementation map

| Layer | Implemented behavior |
|---|---|
| Authored document | `TemplateManifest.scan.display`, strict version-1 schema in `src/passkit/template/scan-display/schema.ts:259-287`. |
| Import/save | Manifest travels through package analysis and display validation. Designer version saves use the same upload-analysis pipeline; invalid non-dry-run saves are rejected. `worker/modules/templates/versions.ts:39-162`. |
| Default content | Without an authored display, `defaultScanDisplay` chooses a numeric action panel where applicable, then a Details panel from eligible primary/secondary/auxiliary Wallet fields. Holder/name and secret fields are excluded from that default field list. `scan-display/defaults.ts:15-105`, `pass-fields.ts:49-83`. |
| Production scope | Worker constructs role-filtered inputs, eligible pass fields, pass metadata, scan/event/scanner context and history. `worker/modules/scan/display.ts:63-120`. |
| Rendering | Pure `renderScanDisplay` filters elements, evaluates bindings/conditions, selects the first matching header variant, limits panels and cuts trailing content to fit. `scan-display/render.ts:34-183`. |
| Client contract | Server sends rendered strings/numbers/asset URLs—not authored expressions—in `ScanDisplay`. `shared/contracts/scan-display.ts:1-215`. |
| Consumption | `ResultCard` paints identity/header and shared `DisplayPanels`; ready-card displays are explicitly forwarded by `scan-loop.tsx:80-90`. Every shipped row variant has a client dispatch branch in `display/panel.tsx:10-44`. |
| Failure | Rendering falls back to the default display, then identity-only content. A custom-display failure does not prevent the verdict. `worker/modules/scan/display.ts:125-164`. |

### The editor gap is real

- `designer/outline.tsx:84-120` exposes Wallet/template/input/barcode/relevance sections—no scanner-content section.
- `designer.tsx` always mounts `DesignerPreview`, the Wallet preview.
- `designer-page.tsx` does not consume a scanner mode.
- Nevertheless, `admin/scanning/event-page.tsx:170-179` links to `design?mode=scan`. That link currently opens the ordinary designer.
- Input editing exposes label/type/required/default/sample/name, but no `x-scan` visibility control: `designer/section-inputs.tsx:21-89`.
- Phone authoring is explicitly preview-only: `designer/layout.tsx:24-38`.
- Template writes currently require the global admin route guard; this audit does **not** establish a shipped partner-org-admin authoring permission. `worker/modules/templates/routes.ts:41-50`.

The existing editor proposal is useful prior design, not shipped UI: `docs/design/scanner/display-model.md:1413-1416` explicitly says “Nothing is built.”

Also distinguish three unrelated things currently named “display”:

1. Apple `pass.json`: Wallet appearance.
2. `manifest.display`: list/search title/subtitle/status projection.
3. `manifest.scan.display`: scanner result content.

The editor must not blur these.

## 2. Shipped authored primitives

Source: `scan-display/schema.ts:115-287`, `render-rows.ts:111-234`, `walk.ts:65-152`.

| Primitive | Authorable content and limits |
|---|---|
| Header/identity | Holder source; photo with minimum role; success icon/title; metadata line; up to two header chips; up to eight ordered header variants. |
| Panel | Title, icon, tone, minimum role, condition, outcome screens, action-ID filter, preset provenance and ordered rows. Up to six authored panels; at most two rendered. |
| `heading` | Text and optional detail, 24 characters each after rendering. |
| `field` | Label 20, value 48, optional icon, emphasis and empty behavior: hide or dash. |
| `big` | Value 12, label 20, unit 12, optional tone. |
| `columns` | Two–four cells; normal/big size. Labels 12; values 16 normal or 8 big. Individual cells do **not** have conditions or roles. |
| `progress` | Numeric value, explicit/inferred goal, reward text/count, icon, auto/stamps/bar. Goals 1–1000; over ten uses a bar. |
| `money` | Numeric amount, currency, label, low-balance threshold and pending action IDs. |
| `history` | Visits, scans or value history; requested limit 1–5; configurable amount/time/location/action components. See runtime limitations below. |
| `image` | Existing `thumbnail` or `strip` source only, title/detail—not arbitrary URL/upload. See missing runtime wiring below. |
| `chips` | One–four chips, each with text, tone, icon, role and condition. |
| `list` | One–four icon/text/detail items; optional adaptive two-column pairing; per-item role/condition. |
| `note` | Plain text up to 140, optional icon; neutral/info/attention tone. |
| `divider` | Structural separation only. |

Other supported mechanics:

- Eight preset **factories**: Membership, Loyalty, Balance, Ticket, Offer, Access, Details, Note. They write ordinary rows; they are not separate rendering engines. `presets.ts:17-36`.
- Text supports literals, inserted bindings and count-based singular/plural/optional zero forms.
- Formatting: date, time, datetime, day, ago, count, money, uppercase, duration. No HTML/URL formatting. `format.ts:7-18`.
- Conditions: equals, membership, empty, numeric comparisons, calendar days from now, All/Any/Not. Validation permits at most four levels and twelve tests. `condition.ts`, `validate-refs.ts:171-195`.
- Element roles are cumulative: Door → Desk → Manager. An element cannot lower its parent’s role.

### Rendering constraints authors need to see

`density.ts` and `validate-refs.ts` enforce:

- Display document ≤16 KiB.
- Each panel: one–six rows, at most five weighted row units.
- Whole result: six units including panel frames and relevant header costs.
- An over-budget success result is a save error; other outcomes receive cut warnings.
- Later panels/rows can be omitted. The renderer preserves the first row.
- Images must be first and unique within their panel.
- Dividers cannot start/end a panel or be adjacent.
- A heading cannot be the final row.
- Only one authored history row across the display.
- Large-value rows have additional placement limits.

Geometry, typography, breakpoints, verdict colors and motion remain application-owned. There are no authored CSS coordinates, fonts, arbitrary colors, HTML, links or button rows. The result body can scroll (`result/result.css:127-137`).

## 3. Implemented versus merely possible

These are prerequisites for an honest editor, not patch-introduced review findings.

### Important production gaps

1. **“Live on the next scan without updating passes” is not implemented.**  
   `resolve.ts:142-146` resolves the pass’s pinned template version; the registry honors that explicit version (`templates/registry.ts:122`). The designer saves with `activate: false` (`save-flow.ts:49`), and the version API accepts only a Boolean activation flag. There is no shipped `displayOnly` response/build-key behavior in the examined save contract. Do not use the design document’s immediate-publication copy yet.

2. **Several scan-context bindings are catalogued but unavailable in real displays.**  
   `safeDisplay` forwards no scan facts (`outcome.ts:56-71`). Consequently production `scan` scope contains only outcome, current time and direction (`display.ts:101-105`), not action/method/reason/amount/before/after/previous. Renderer options `actionId` and `amountOpen` are also not forwarded. Action-scoped panels and pending-action previews therefore cannot currently behave as the pure renderer permits.

3. **Images are renderer-supported but not populated for live panels.**  
   `render-rows.ts` requires `assets.thumbnail`/`assets.strip`; production supplies only `assets.photo` (`display.ts:118`). These image rows disappear even when the Wallet package contains those assets.

4. **History is partially implemented.**  
   Production supplies visit/scan counts, last visit/scan and lists capped by SQL at three entries. Value lists and ledger are always empty (`repo-history.ts:54,79-80`); `inside` and `checkedInAt` are not populated there. Five-row history, value-ledger panels and “Changed elsewhere” are not end-to-end capabilities.

5. **Money/stamp action execution is not implemented by the current action dispatcher.**  
   The manifest types support check-in/add/take/set/use-up, but `act.ts:73-74` rejects every selected non-check-in action. `ResultCard` also renders only check-in action buttons. Showing a stored balance/progress value is different from implementing a charge/top-up/reward operation.

6. **Wallet field bindings are raw values, not Wallet-formatted values.**  
   Production maps `field.value` directly (`display.ts:83-86`). The picker must not promise that dates, currencies or localized values match Wallet automatically.

7. **Preview helpers are not a working preview service.**  
   `routes-display.ts:4` exports an empty router. `sampleScope` exists, but leaves `fields`/assets empty, includes richer synthetic scan/history facts than production, and does not apply production input secrecy filtering (`sample.ts:68-123`). Using it directly would create misleading role/fidelity previews.

8. **Customer configuration is schema-only here.**  
   `customer: {greet,chips,panel}` exists in the document shape. The current live customer path does not consume it. `live-render.ts:19-35` removes holder/pass/photo information and emits generic system copy; `live-screen.tsx:142-159` paints that generic view. The planned customer reference/allowlist validations and renderer are not present in the inspected display implementation.

Source templates also do not currently contain authored `"scan"` blocks; the preset/example helpers should not be described as already-designed displays shipped by every starter.

## 4. Safety controls—and boundaries not to overclaim

### Existing controls worth reusing

- Inputs have `x-scan`: Door/default, Desk, Manager, Hidden.
- Email/URI formats and email/tel/URL widgets are always excluded.
- Secret/contact-like name segments are excluded **unless explicitly annotated with `x-scan`**. This is not an unconditional secret-name prohibition.
- Inputs used only as barcode messages are excluded.
- Bound Wallet fields are removed when they read denied inputs, read `pass.*`, or equal the barcode message.
- Pass credential/token/serial/barcode paths are forbidden.
- `pass.externalId` is Desk+.
- Both data scope and authored elements are filtered before evaluation.
- Text is sanitized/truncated; values containing template syntax do not become recursively evaluated expressions.
- Custom success titles permit only literal text plus a plausible holder name. Heads-up/refusal system language remains authoritative.
- Refusals render no panels/photo/chips; only the literal refused note survives. Client panel suppression provides a second check.

Sources: `scope.ts:46-148,169-200`, `validate-rules.ts`, `render-header.ts`, `render.ts:125-153`.

### Important boundary

These controls do **not** establish whole-scanner field secrecy:

- Stored `pass.title`/`subtitle` enter the scope without checking the provenance of their list projections.
- `card.values` separately reads action inputs without these display filters.
- Expanded `passView` uses `stripPassJson`, which removes credentials and masks email-like strings, but does not apply panel `minRole`/`x-scan` filtering. The client can flip that pass view.

Evidence: `display.ts:88-99`, `dto.ts:25-44,107-138,182,208-213`, `result/pass-preview.tsx:80-90`.

The new editor must therefore describe visibility as **All staff (Door+), Desk+, Manager**, never “Everyone” in a way that includes customers. Privacy must follow field provenance across aliases, projections, previews and expanded pass inspection—not merely hide a panel.

## 5. Recommended author workflow

### A. Clear ownership and entry points

Organization template → **Pass data / Wallet presentations / Scanner results**.

- Organization-owned template name stays visible throughout.
- Built-in templates remain immutable; use the existing Duplicate workflow.
- Template detail gains a scanner-result thumbnail and **Edit scanner results**.
- Event “Result screen · Edit” opens that exact surface.
- Device layout selection remains elsewhere. “Operator view” and “Customer display” are not content documents or staff roles.

### B. Start useful, without code

Opening an uncustomized template shows its actual default and **Customize this result**.

Offer the existing preset factories with human-readable field mappings and sample values. Unmatched fields require an explicit choice; do not insert empty/broken bindings silently.

Outline:

- Identity
- Success header
- Header rules
- Ordered information panels
- Staff/refused notes

No JSON or expression syntax is necessary for normal authoring.

### C. Make every row understandable

Each row editor exposes:

- Display label—explicitly “changes this scanner label only.”
- **Text** versus **Pass data** source.
- Token insertion with friendly field labels, type, minimum audience and safe sample.
- Type-compatible formatting.
- Empty behavior where supported.
- **Who can see this**.
- **Show when**.
- Move up/down, duplicate, remove and undo.

Allow adaptive columns/list pairing, not free positioning. Show placement errors before committing an invalid move. Provide an accessible alternative to dragging.

Use a small shared condition builder: field → operator → typed value, All/Any groups, plain-language summary. Imported complex rules should remain preserved and explained, not silently flattened.

### D. Separate preview controls from saved content

Preview controls:

- Outcome: ready/success/heads-up/refused.
- Staff audience: Door/Desk/Manager.
- Phone/tablet/wide operator.
- Light/dark, large text.
- Safe sample presets and temporary overrides.

“Door” must not imply phone, nor “Desk” imply desktop. Preview selection must never elevate permission, edit personalization, change input defaults or dirty the authored document.

Use the actual scope sanitizer and result components. A role switch over an unfiltered `sampleScope` is insufficient.

### E. Honest save/publication

One draft and undo history can span surfaces, but publication explains effects separately:

- Scanner presentation only.
- Semantic pass-data change.
- Apple Wallet presentation.
- Other enabled providers and affected instances.

Do not promise next-scan publication until version selection is implemented accordingly. Failed validation/save keeps the draft and leaves the active version unchanged.

## 6. Wallet tiering and multiple installations

Recommended contract—not a claim about current implementation:

- Canonical semantic fields, entitlement identity and scanner content live above wallet adapters.
- Apple is the primary, full-fidelity native adapter.
- Google/Samsung can expose deliberately narrower **declared native subsets**, with provider-specific preview, readiness, update/revoke state and explicit optional omissions.
- Unsupported **required security/business semantics fail closed**; optional visual differences are explained and previewed.
- Native wallet layout is provider-specific. Scanner field selection should not depend permanently on Apple `fields.<key>`.

Preserve the Apple cutover by importing current inputs/bindings into stable semantic field identities and keeping the existing Apple issuance path as its adapter. Legacy Wallet-field references need an explicit mapping/compatibility report—not perpetual parsing of Apple output as the canonical model.

One entitlement may have many wallet/device instances simultaneously:

- Provider previews are tabs, not mutually exclusive provider overrides.
- Installation/update/revoke status belongs to each instance.
- Scanner credentials resolve to the shared entitlement before actions, history and duplicate-entry decisions.
- Scanning the same entitlement from another phone/watch/provider must not create a new holder, reset check-in state or select different organization authority.
- Scanner-only display changes should not require updating every native artifact.

Provider-specific omissions and native lifecycle failures belong in author/admin readiness views; they should not masquerade as the entitlement’s admission status.

## 7. Priority and acceptance

**P1 — Usable authoring:** correct entry point, source-safe field picker, presets, ordered rows, labels and visibility without code.

**P1 — Honest integration/security:** production-equivalent scope previews; complete lineage filtering; no customer sharing through staff roles; correct publication/version semantics.

**P2 — Rich-content completion:** image asset wiring, full scan context, action filtering and requested history. Do not expose these as working controls before their runtime paths are complete.

### Acceptance cases

- **Core flow:** event Edit opens scanner results; add Ticket; bind Seat; rename its scanner label; reorder; save. Wallet labels/layout, canonical data and issued values remain unchanged.
- **Roles:** a Desk-only field is absent—not merely CSS-hidden—from Door payloads, previews, variants, fallback identity and expanded pass surfaces. Customer receives no staff content.
- **Outcomes:** custom success content cannot alter admission meaning; heads-up retains system wording; refused displays no panels/photo/chips, only the permitted note.
- **Missing/hostile values:** blank/null/zero, invalid numbers/dates, long Unicode names, bidi/control characters and literal markup have defined output; no broken bindings or execution.
- **Fit:** compact widths, short landscape, 200% text, light/dark and reduced motion; no horizontal overflow; cut rows are identified in the editor; verdict/action controls remain reachable.
- **Mobile:** phone operators can use all allowed content regardless of role. Retaining the existing phone **authoring preview-only** policy is acceptable only if explicit, with no hidden editable/destructive controls or draft loss.
- **Keyboard:** complete add/bind/condition/reorder/remove/undo/save flow without pointer; named pickers; predictable focus restoration; movement/status announcements.
- **Failures:** dry-run unavailable, save rejected, assets unavailable and render exception produce honest states; preserve drafts; never display stale preview as current or a failed action as success.
- **Preview fidelity:** samples cannot demonstrate ledger/action/image behavior production does not supply. Real-pass preview returns authorized, filtered data before it reaches the browser.
- **Providers:** Apple full-fidelity preview plus honest Google/Samsung subset previews/diffs; unsupported required semantics block that provider; optional omissions are explicit.
- **Multiple installations:** scanning two provider/device instances shares entitlement history and duplicate-entry enforcement; changing scanner content applies consistently without conflating instance lifecycle state.

Read-only source audit completed; no builds, tests, edits, network or visual checks performed.
