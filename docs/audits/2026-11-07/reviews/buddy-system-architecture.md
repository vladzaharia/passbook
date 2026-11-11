# Buddy mascot system architecture audit

## Evidence boundary

Source inspection covered shared components, scanner dispatch/CSS, SSR, export generators, organization settings, Android artwork, and the separate iOS worktree at `/private/tmp/wallet-ios-scanner`. Static iOS/web icons were visually inspected. No edits, builds, tests, rendering scripts, or production requests were performed.

This is an architecture audit, not a regression review of the unrelated Android patch. Previously reported scanner entrance/double-delay defects are not repeated. No new urgent security risk was identified.

## Architecture and positive patterns

- **Genuine shared geometry:** `WalletArt` defines six wallet states and four explicit moods; an omitted mood represents neutral. `BuddyArt` supplies hook-free markup, while `Buddy` adds replay and presence registration (`src/web/ui/art/wallet.tsx:4-31`; `buddy-art.tsx:75-128`; `buddy.tsx:12-19`).
- **Useful separation of concepts:** geometry state, emotion, scene choreography, and scanner-held pose are distinct. Nine semantic `StateArt` compositions share failure mappings through `ACTED_STATES` (`state-art.tsx:10-29`; `state-acts.ts:3-14`).
- **Consistent presentation:** theme tokens, non-scaling strokes, and optical sizing are centralized (`art.css:4-60`). Face artwork reuses wallet parts rather than maintaining another full illustration (`face.tsx:1-7,42-64`).
- **Accessibility and restraint:** decorative SVGs are non-focusable; replay respects reduced motion; presence counting and dialog CSS support one Buddy per view (`base.tsx:65-82`; `replay.ts:9-12`; `presence.ts:3-29`; `art-wallet.css:252-255`).
- **Existing coverage is valuable:** tests inspect SPA/SSR compositions, geometry budgets, motion properties, replay, and timing ceilings (`state-art.test.tsx:25-65`; `art.test.tsx:81-151`; `replay.test.tsx:178-229`). These tests were inspected, not executed.
- **Exports reuse sources:** email PNGs and social artwork render `WalletArt`. The separate `BrandMark`/favicon optical drawings are deliberate small-size treatments—not interchangeable full-body mascot variants (`tools/build-email-art.ts:44-84`; `tools/build-icons.ts:73-100`; `tools/lib/icon-art.ts:19-31`).

## P2 — Close the scanner’s animation dependency graph

**Persona / lifecycle / action:** venue operator; fresh scanner launch; milestone or reward result.

**Confirmed:** `/scan` loads its own entry and pared-down providers (`scan.html:24`; `src/web/scan/main.tsx:5-9`; `src/web/lib/core-providers.tsx:5-8`). `ScanLoop` imports `Buddy` directly and scanner beat CSS (`scan-loop.tsx:6,24`). That path loads the rest stylesheet, not the lazy art registry containing `cheer.css` (`ui/art/buddy.tsx:1-3`; `replay.ts:1-4`; `registry.ts:43`). Yet the scanner’s `fan` beat references five `wl-s-cheer-*` keyframes defined there (`scan/buddy/beats-1.css:164-194`; `ui/art/scenes/cheer.css:22-94`).

**[INFERENCE] Impact:** without another stylesheet injection, a cold scanner document cannot perform those milestone animations. Directly selected generic scenes have the same dependency risk.

**Countercontrols:** verdict text, glyphs, colors, and transaction processing remain independent.

**Recommendation:** explicitly import the shared keyframes/scenes each entry uses; retain one definition rather than copying animation code or loading the entire entity registry unnecessarily.

**Acceptance—not executed:** open `/scan` directly in an isolated context, trigger a milestone, and inspect the expected running animations and settled frame under both motion preferences.

## P2 — Complete the produced-beat-to-rendered-parts contract

**Persona / lifecycle / action:** merchant operator; balance or loyalty transaction; top up, charge, stamp, or redeem.

**Confirmed:** presentation emits `coins` for currency add/take operations (`src/web/scan/machine/present.ts:46-57`), but scanner CSS has no corresponding beat selector. Other implemented selectors target stamp marks, punch holes/chads, sparks, clocks, hands, and clouds (`buddy/beats-1.css:211-232,263-270`; `beats-2.css:33-44,140-163`). The scanner supplies none of their required slot markup; `BuddyArt` only forwards supplied slots (`scan-loop.tsx:243-252`; `ui/art/buddy-art.tsx:111-127`).

**Impact:** named reactions are incomplete: currency has no currency-specific track, and prop-dependent animations target absent elements. This does not establish incorrect monetary or admission results.

**Countercontrols:** visible amounts, action labels, verdicts, and basic body reactions remain available.

**Recommendation:** keep beat names scanner-owned, as intended, but derive one typed scanner presentation descriptor containing beat, pose, wallet state, direction, and required parts. Every emitted beat needs an implemented track or an explicit intentional still treatment.

**Acceptance—not executed:** enumerate actual producer outputs; verify their selectors, required rendered nodes, inbound/outbound direction, normal-motion reaction, and reduced-motion still.

## P3 — Make valid compositions discoverable and retire dormant variants

**Persona / lifecycle / action:** integration maintainer; adding a screen or lifecycle state; selecting reusable Buddy feedback.

**Confirmed examples of taxonomy drift:**

- Shift summary requests `scene="scan" pose="count"`, while counting is implemented as a **scene**, not that pose (`src/web/scan/ui/shift-sheet.tsx:43`; `ui/art/scenes/count.css:4-28`).
- Partial broadcasts select `mend` but render no torn-pass prop, leaving part of that scene’s choreography without its object (`admin/messages/detail-counts.tsx:8-13,67-71`; `ui/art/scenes/mend.css:18-23`).
- `stow` remains public and shipped, but the production-source search found no selector-producing caller (`buddy-art.tsx:20`; `registry.ts:48`; `scenes/stow.css:1-16`).

**Impact:** reuse currently requires undocumented knowledge of scene prerequisites; plausible-looking combinations compile while delivering incomplete effects.

**Countercontrols:** existing canonical failure compositions and their parity tests demonstrate the right pattern.

**Recommendation:** extend existing semantic recipes with required props/dependencies, preserving low-level composition APIs. Correct current mismatches; remove dormant scene API/CSS unless a real lifecycle owner is identified. Do not collapse geometry, mood, pose, and scene into one oversized status enum.

**Acceptance—not executed:** each advertised recipe renders its required parts; shift counting uses its real scene; every retained scene has a documented production use.

## P3 — Enforce export freshness and declare platform identity

**Persona / lifecycle / action:** release maintainer and partner operator; branding update or installation; receiving email, sharing links, identifying installed scanners.

**Confirmed:** export generators require manual reruns, but normal `gen`, `check`, and `build` do not invoke them (`tools/build-email-art.ts:1-3`; `tools/build-icons.ts:1-4`; `package.json:15-38`). Existing tests check expected files, dimensions, transparency, and selected pixels—not fresh-render parity (`tools/build-email-art.test.ts:18-64`; `tools/site-meta.test.ts:31-120`).

**[INFERENCE] Risk:** missed regeneration can leave older email/social/install artwork after source or token changes. No current stale export was demonstrated.

Platform identity also differs: scanner PWA uses shared web icons (`public/scan.webmanifest:14-22`); iOS registers a separate 1024px raster that currently looks consistent with the web mark (`iOS:ios/PassBookScanner/Assets.xcassets/AppIcon.appiconset/Contents.json:3-7`). Android uses a distinct blue reader glyph (`android/app/src/main/AndroidManifest.xml:9-10`; `res/drawable/ic_reader.xml:1-5`). That difference may be intentional.

**Recommendation:** maintain an export manifest with source/dependency fingerprints and a freshness gate. Include iOS in the canonical generation process where parity is intended; document Android’s product-identity decision.

**Acceptance—not executed:** a source/token change must invalidate affected exports; compare regenerated web, email, iOS, and Android identities against the documented policy.

## P3 — Publish organization-customization and artwork-rights boundaries

**Persona / lifecycle / action:** organization buyer or partner designer; onboarding and campaign approval; approving customer-facing branding.

**Confirmed:** organization accent is explicitly the console-avatar accent, not Buddy theming (`src/web/admin/orgs/org-form.tsx:149-156`). Buddy uses shared theme tokens (`ui/art/art.css:4-12`). `email.buddy` defaults off and governs pass/bundle emails (`shared/contracts/settings.ts:63-64`; `worker/modules/delivery/email.ts:81-85`; `modules/bundles/deliver.ts:71-72`). Sign-in email includes Buddy independently (`worker/email/sign-in.ts:92-101`). Scanner templates deliberately cannot address system-owned Buddy (`docs/design/scanner/display-model.md:1084-1086`).

**Business recommendation—not a confirmed defect:** publish a surface-by-surface customization matrix; do not imply end-to-end white-labeling.

**Rights boundary:** inspected sources do not establish Buddy authorship or permitted partner redistribution/marketing use. The design-system MIT statement is not, by itself, evidence of Buddy artwork rights (`docs/design/platform-architecture.md:43-44`).

**Recommendation:** record owner-approved provenance, rights, attribution, permitted modifications, and partner-use rules alongside the canonical assets.

**Acceptance—not executed:** two organizations with different accents and email settings exhibit the documented scope; partner-facing asset permissions are explicitly approved rather than inferred.
