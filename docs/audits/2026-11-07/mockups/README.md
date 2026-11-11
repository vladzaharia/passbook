# Control UX mockups — local prototype set

These are **proposed post-audit frames**, not current product UI. They use synthetic data and local files. Open any prototype HTML directly; local assets load without an app server or network access.

The frames use PassBook's generated design tokens, local Rubik font, and static SSR markup from the shared PassCard component. Synthetic Harbor artwork, a camera-scene still, provider badge files, and a generated sample barcode support the visual states.

- [Admin/control interfaces](admin-interfaces.html): platform settings Basic/Advanced, organization directory and workspace, people/access, org-bound API key, test-only connection test, template release, pass review/issue, provider delivery and transfer.
- [Governance routes](admin-governance.html): overview, status, audit, users/detail, Apple identities/detail, API keys, revocation and one-time secret disclosure.
- [Operations routes](admin-operations.html): pass list/detail/lifecycle, templates/import, connections, messages/audience review/outcomes, scanning resources and scanner/session/event details, test inbox, account and email management.
- [Customer portal](customer-portal.html): multi-issuer portfolio, pass detail and recovery, wallet offers, browser barcode display, sign-in/account security, public pass states and sign-in email.
- [Other surfaces](other-surfaces.html): wallet selection with provider artwork, pass-delivery email, provider-neutral authoring, scan-display editor, operator session, scanner result shell and customer display.
- Shared local style and interactions: [prototype.css](prototype.css), [prototype.js](prototype.js).
- [Wallet asset provenance and usage constraints](wallet-badges/README.md).
- Full route/capability preservation matrix and target workflows: [UX redesign report](../reviews/control-ux-redesign.md).
- Cross-surface policy, accessibility, safety and motion contracts: [UX system specification](../reviews/control-ux-system.md).

## Functionality preservation

**The mockups do not replace the current admin route shell or remove any application feature.** The five local prototypes cover the current admin/customer route matrix across selected target-state frames; their selectors group related journeys, not production routes. Preserve all existing routes, list/detail/create flows, scanner and messaging actions, account flows and controls. The route-by-route preservation matrix is in the [redesign report](../reviews/control-ux-redesign.md). No product route or runtime behavior was changed.

The prototypes switch between their selected frames, update scope/role/mode context, reset scroll on view changes, support Basic/Advanced and provider/audience/face modes, open review dialogs, change theme, and expose scanner session return. Complete state sets use keyboard-operable tabs; non-tab selectors use ordinary pressed buttons. `data-mock-action` controls announce the intended action and explicitly do not persist or call a service.

## Safety and asset limits

- All people, organizations, addresses, pass records, counts and provider states are synthetic.
- Tenant roles, provider readiness, immutable approvals, lifecycle fences and per-instance outcomes are proposed; the HTML does not enforce or verify them.
- Harbor Club artwork and pass records are synthetic. The barcode fallback uses a generated Code 128 sample (`HBR-1042`), not a production credential. The scanner image is a static still, not a live camera feed.
- Provider actions use platform artwork without edits; availability requirements stay outside the badge. Google and Samsung files and sources are in [wallet-badges](wallet-badges/README.md). Apple uses the app's existing badge asset, which remains an interim copy pending the account owner's accepted official kit.
- The barcode page is a synthetic browser presentation state, not an active credential; production must render the pass's exact barcode format/message and keep server-side scan verification. A webpage does not provide NFC or emulate Wallet VAS.
- Customer output is a separate allowlisted projection. Staff identity, pass reason and private contact fields are absent from the generic customer-display state.
- Buddy is decorative and state-correct: the static local art appears only for confirmed success. Its light/dark asset follows the theme. The one-time entrance is transform/opacity-only; `prefers-reduced-motion` leaves the settled art. No ambient animation loop.

## Screenshots

`final-*` images document the previous selected prototype pass; the current route-evidence row is dated 2026-11-08, with the wallet-badge refresh dated 2026-11-09. `critique-*` and `pass*` retain earlier iterations; they are not alternate approved designs. Fixed SaveBar screens are shown as top and bottom viewport captures because a full-page screenshot can place the bar midway over the page.

| Surface | Evidence |
| --- | --- |
| Admin settings | [Basic](final-admin-settings-basic.png), [Advanced top](final-admin-settings-advanced-top.png), [Advanced bottom](final-admin-settings-advanced-bottom.png), [mobile top](final-admin-settings-mobile-top.png), [mobile bottom](final-admin-settings-mobile-bottom.png) |
| Organization and access | [Directory](final-admin-directory.png), [workspace top](final-admin-workspace-top-viewport.png), [workspace bottom](final-admin-workspace-bottom-viewport.png), [scoped API key](final-admin-api-key.png) |
| Connection, release and pass lifecycle | [Test-only connection with Buddy](final-admin-connection-test.png), [immutable release](final-admin-release.png), [pass review](final-admin-pass-review.png), [delivery/transfer](final-admin-delivery-transfer.png) |
| Customer wallet choices | [iPhone](final-wallet-iphone.png), [Galaxy with alternatives](final-wallet-galaxy-alternatives.png), [Android](final-wallet-android.png), [unknown device](final-wallet-unknown.png), [phone layout](final-wallet-mobile.png), [phone Galaxy alternatives](final-wallet-mobile-galaxy.png), [multi-wallet email](final-wallet-email.png) |
| Authoring and scan privacy | [Apple front](final-pass-studio-apple-front.png), [Apple details](final-pass-studio-apple-details.png), [Google projection](final-pass-studio-google.png), [customer-safe scan editor](final-scan-editor-customer.png) |
| Scanner and customer display | [Operator session](final-operator-session.png), [scan result desktop](final-active-scan-desktop.png), [light theme](final-active-scan-light.png), [reduced motion](final-active-scan-reduced-motion.png), [portrait phone](final-active-scan-mobile.png), [320px phone](final-active-scan-320.png), [short landscape](final-active-scan-landscape.png), [customer display](final-customer-display.png) |
| Complete route redesign · 2026-11-08 | [Governance mobile](redesign-admin-governance-mobile.png), [operations mobile](redesign-admin-operations-mobile.png), [pass detail desktop](redesign-admin-pass-detail-desktop.png), [settings mobile](redesign-admin-settings-advanced-mobile.png), [scan event mobile](redesign-admin-scanning-event-mobile.png), [320px customer detail](redesign-customer-detail-320.png), [public pass](redesign-customer-public-desktop.png), [wallet chooser at 600px](redesign-wallet-chooser-tablet.png) |
| Wallet badge refresh · 2026-11-09 | [wallet choice at 600px](redesign-wallet-badges-unknown-tablet.png), [email desktop](redesign-pass-email-badges-desktop.png), [email mobile](redesign-pass-email-badges-mobile.png), [customer portfolio bundle and pass badges](redesign-customer-portfolio-mobile.png), [customer detail and Show barcode](redesign-customer-detail-mobile.png), [public pass badges](redesign-customer-public-wallet-badges-desktop.png), [browser barcode desktop](redesign-customer-barcode-desktop.png), [browser barcode mobile](redesign-customer-barcode-mobile.png) |

## Visual critique passes

1. **Desktop content/state pass.** Corrected scope and route labels, separated recommendation from installed status, kept provider requirements outside provider buttons, and checked sticky-save reachability at both scroll ends. Final evidence is the desktop/admin and authoring rows above.
2. **Responsive/operator pass.** At 390×844 and 320×568, removed blank hidden-mode chrome and horizontal overflow; at 844×390, replaced the clipped page header/navigation with a compact scanner stage. Added a visible Session return action, raised interactive controls to 44px touch targets and form text to 16px, and kept the scanner result, Undo, next-pass and dock controls in-frame at all three sizes.
3. **Theme, Buddy and motion pass.** Fixed the empty-attribute theme-button no-op, labelled it with the next theme action, and synchronized the local light/dark Buddy image. Forced reduced-motion emulation and verified `animation-name: none`; checked customer output remains generic. Final dark/light/reduced-motion and audience screenshots are linked above.
4. **High-fidelity asset pass.** Replaced hand-authored card approximations with static SSR markup from the shared PassCard component, including its registered barcode renderer; layered synthetic Harbor Club mark and strip artwork; added a static camera-scene still; and normalized wallet actions without imitating official artwork. Refreshed the linked `final-*` screenshots from the current prototypes.
5. **Full route and customer-first pass.** Reviewed governance, operations and customer paths against the route matrix; corrected state truth, missing pass recovery, wallet eligibility, mobile table labels, advanced-settings disclosure, scanning detail coverage, scan-based message targeting and account-email management. The new images above show representative desktop/tablet/mobile states; scanner UI and reference frames were left unchanged.

Browser smoke evidence: exercised portfolio, pass detail/removal, public-pass error, sign-in code, email focus recovery, admin pass/scanning/message routes and dialogs, advanced settings disclosure, theme, and keyboard tabs. The 2026-11-09 badge pass exercised unknown-device wallet choices at 600×900 and 320×700; portfolio, email, and detail at 393×852; email at 1440×1000; public pass at 1440×1000; detail at 320×700; and barcode at 1440×1000 and 393×852. Google primary/compact/email, Samsung light/dark and Apple interim artwork loaded in their tested states; checked 320px and 393px surfaces had no horizontal overflow or browser errors. The barcode is synthetic and non-admissible. Prototype-only evidence—not keyboard/screen-reader/contrast certification, product API test, camera/native/device test, provider acceptance, or release check.
