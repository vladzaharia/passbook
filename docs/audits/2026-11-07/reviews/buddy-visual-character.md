# Buddy mascot: character-system audit

## Scope and evidence boundary

Read-only review of Buddy across public pass/sign-in, holder portal, admin, email, Wallet presentation and scanner surfaces. Inspected source dispatch, design guides, email PNGs, the app icon, existing portal/pairing screenshots, and scanner phone/tablet/camera screenshots.

No edits, checks, new renders, animation playback, production calls or installed-Wallet inspection were performed. Existing screenshots establish appearance at capture time, not current browser/device compatibility. Findings concern current implementation; regression attribution was not established.

## Character assessment and coverage

**Design judgement:** Buddy is recognizable, personable and appropriately product-specific. The stitched pocket, screen-face, foil cards and dangling feet form a coherent character rather than an unrelated decorative animal. The large scanner screenshots retain that identity without obscuring the verdict. Tiny treatments sensibly simplify the drawing rather than shrinking every detail.

The system already has substantial expressive range:

| Surface | Confirmed implementation |
|---|---|
| **Canonical character** | `src/web/ui/art/wallet.tsx:32-57,80-140` defines shared pocket, screen, cards, feet and expressions. Unset mood is neutral; explicit moods are happy, flat, sad and curious. |
| **Public pass and holder portal** | They share `HolderPassView`; installation uses pointing/nudging, installed passes use happy/count, and unavailable passes use sad treatments: `src/web/portal/holder-pass-view.tsx:49-83`; `add/add-block.tsx:13-65`. |
| **Sign-in and hosted pages** | Login distinguishes success, slips and failures; hosted pages render the same React artwork rather than separate illustrations: `src/web/portal/login-scene.tsx:188-230`; `src/worker/ssr/hosted-art.tsx:14-18`. |
| **Admin** | Creation/voiding use wave/tear; uploads compose Buddy with template art: `src/web/admin/passes/detail/detail-page.tsx:154-174`; `src/web/admin/templates/upload-drop.tsx:154-158`. |
| **Email** | Twenty-four shipped PNG slices cover light/dark, two densities, happy/curious at L and happy at M. Generation uses the actual WalletArt drawing: `tools/build-email-art.ts:51-83`; `src/shared/email-art.ts:6-35`. |
| **Wallet artwork** | Interface `WalletArt` must not be confused with issuer pass imagery. Real pass assets follow template, organization and per-pass precedence: `src/worker/modules/passes/builder.ts:188-234`. |
| **Scanner** | Operator results have a substantial beat vocabulary; customer displays use a separate, simpler expression selection: `src/web/scan/machine/present.ts:46-75`; `src/web/scan/live/live-screen.tsx:142-152`. |

## Findings

### P2 — Complete the scanner’s reaction artwork

**Persona / lifecycle / action:** Loyalty issuer and venue operator; live operation; crediting balances, stamping/redeeming and handling offline or uncertain scans.

**Confirmed source:** Currency operations select `coins` in `src/web/scan/machine/present.ts:52-55`, but the shipped scanner beat styles contain no corresponding coin reaction. The scanner renderer also supplies none of the artwork slots (`onCard`, `front`, `aside`, `prop`): `src/web/scan/scan-loop.tsx:243-251`. Buddy forwards only supplied artwork: `src/web/ui/art/buddy-art.tsx:111-123`.

Consequently, selectors for stamp marks, punch holes, clocks and clouds have no matching prop markup—for example, `src/web/scan/buddy/beats-1.css:211-232` and `beats-2.css:140-141`. These are specified visual states, not merely aspirational decorative additions: `docs/design/scanner/buddy-motion.md:239-277,294-309`.

**Impact:** Distinct loyalty and recovery actions lose their intended character storytelling. This is not evidence of incorrect balances or admissions; result text, icons and colours remain independent countercontrols.

**Recommendation:** Finish the existing compositions before adding more poses: coins, stamp, hole/chad, pending/offline clock and system-error props. Reuse the shared slots and existing drawings.

**Acceptance—not executed:** Compare ordinary check-in, balance change, stamp, redemption, offline save and connection failure. Each should show its intended complete composition, including the specified reduced-motion still.

### P2 — Restore consistent expression meanings at surface adapters

**Persona / lifecycle / action:** Venue staff and customers; onboarding, admission and recovery; deciding whether equipment or an operation is ready, pending or blocked.

**Confirmed source:**

- Every boot/blocking card receives happy/peek, including removed, expired and suspended scanners: `src/web/scan/ui/boot-card.tsx:33-35`; `boot/block-panel.tsx:10-19,43-45`. **Carry-forward:** already identified in the earlier scanner visual audit.
- Customer displays select happy for every latest outcome except refusal, including heads-up, ready and undo: `src/web/scan/live/live-screen.tsx:142-152`.
- Operator neutral is converted to flat: `src/web/scan/scan-loop.tsx:247`. Flat compresses the eyes to 25% height and the body slightly: `src/web/ui/art/art-wallet.css:58-60,92-94`. The existing camera screenshots visibly show this half-lidded waiting expression.
- Broadcast `sending` uses happy/count: `src/web/admin/messages/detail-counts.tsx:8-12`.

These diverge from the documented neutral/pending, flat/slip and happy/confirmed-success meanings: `docs/design/motion-and-expression.md:130-136`.

**Impact:** The same character expression no longer reliably conveys the same operational moment across a partner’s customer and staff experiences. Increased hesitation or support demand is an inference, not a measured result.

**Countercontrols:** Status copy, recovery actions and verdict colours still communicate the actual state.

**Recommendation:** Restore attentive neutral for readiness, curiosity for attention/checks, flat for minor slips/undo, apologetic sadness for system problems, and happy for confirmed success. Customer refusals should remain empathetic rather than accusatory.

**Acceptance—not executed:** Review ready, checking, queued, accepted, heads-up, refused, unavailable, paused and undo side by side across operator, customer and boot hosts.

### P3 — Preserve the object when reusing a narrative scene

**Persona / lifecycle / action:** Communications administrator; partial-failure recovery; reviewing a broadcast.

`partial` selects `mend`, but its Buddy receives no torn-pass prop: `src/web/admin/messages/detail-counts.tsx:11,71`. The authored scene repairs that object; its CSS explicitly targets the prop and torn corner: `src/web/ui/art/scenes/mend.css:1-22`. The canonical composition supplies it correctly: `src/web/ui/art/state-acts.ts:12`.

**Impact:** The character performs a repair gesture into empty space, weakening an otherwise useful recovery metaphor. Counts and failure details remain available.

**Recommendation:** Supply the complete torn-pass composition, or use a genuinely prop-free concerned pose.

**Acceptance—not executed:** Inspect a partial broadcast in normal and reduced motion; no gesture should depend on an absent object.

## Reusable visual principles

These are **P3 art-direction recommendations**, not additional functional defects:

1. **Keep identity invariants.** Preserve pocket proportions, screen-face and teal/violet/gold card order. Let status live in expression, gesture and surrounding verdict—not wholesale character recolouring.
2. **Maintain optical masters.** Keep the bold 20-unit logo distinct from illustrated Buddy. Preserve the miniature’s enlarged face and removed stitching (`src/web/ui/layout/brand-mark.tsx:4-18`; `src/web/ui/art/face.tsx:28-48`). Document the shipped 192/256 px scanner tier, absent from the guide’s tier table: `base.tsx:19`; `art.css:45-52`; guide `motion-and-expression.md:106-116`.
3. **Ground full-body poses.** Keep feet, contact shadow and a legible supporting edge together. The pairing halo currently floats a seated character; either provide a ledge or use a deliberate face-only emblem there: `src/web/scan/ui/scan-boot.css:88-106`.
4. **Protect partner ownership.** Keep Buddy outside actual pass pixels and retain opt-in email branding. Pass email already conditionally includes it rather than forcing platform personality onto every issuer: `src/worker/email/pass.ts:160-168`.
5. **Publish a complete approval sheet.** Include actual-size light/dark examples, neutral through happy, every prop, email seams and scanner stills. Documented scanner motion sheets/videos are explicitly missing: `docs/design/scanner/README.md:20-26`.

The immediately missing states are predominantly **missing bindings/compositions**, not a need for another character redesign: attentive ready, pairing, paused, blocked/apologetic, offline-with-clock, and complete loyalty reactions.

**Proposed visual verification:** Review 20/24/48/64/96/128/192/256 px treatments at 1×, in both themes and grayscale; check silhouette, eyes, fan tips, feet, prop clearance and email seams. No contrast-compliance claim is made from this inspection.

**Overall correctness:** incorrect for the described mascot-state coverage. The core character system is strong, but reaction artwork and expression integration are incomplete. No mascot-only P1 blocker or urgent security risk was established. **Confidence:** 0.97 for source findings; aesthetic assessments remain design judgements.
