# Scanner Accessibility Audit

## Scope and evidence

Inspected scanner/operator UI, customer displays, result timing, announcements, buddy motion, camera recovery, keyboard-wedge input, sound, Android controls/bridge, and iOS accessibility metadata.

Paths below are relative to `/Users/vlad/Repos/wallet`; **iOS:** paths are relative to `/private/tmp/wallet-ios-scanner`. This was source inspection only: no edits, builds, tests, production calls, or assistive-technology/device testing.

## Findings

### 1. P2 — Announce the actual verdict and required check
**Confidence: confirmed-source.**

`src/web/scan/machine/present.ts:75-82` announces the configured action label rather than the completed check-in direction. Thus a checkout can announce “Check in” while the visual card says “Checked out” (`result/result-card.tsx:62-69`). Separately, `check_required` and `cooldown` headlines become “Refused” because `machine/outcome.ts:40-42` removes their placeholders; required flag information disappears.

**Fix:** Share system-verdict formatting between visual and spoken output, including direction and populated warning details.  
**Acceptance:** With VoiceOver/TalkBack, check in, check out, and trigger an “Unpaid dues” warning; speech must convey the same decision and instruction as the card.

### 2. P2 — Make camera-failure recovery reachable and announced
**Confidence: confirmed-source.**

`src/web/scan/machine/reduce-env.ts:59-65` emits an `enter-code` focus command after camera failure. Its consumer queries `[data-scan-code]` (`platform/runtime.ts:126-136`), but the phone lookup field exists only after opening the conditional sheet (`ui/scan-overlays.tsx:55-56`; `lookup/lookup-panel.tsx:122`). The command therefore silently does nothing. Camera error text has no live-region semantics (`ui/camera-layer.tsx:69-102`).

**Fix:** Announce the failure and focus the existing Look up control, or open lookup before focusing its field.  
**Acceptance:** Deny camera permission and simulate decoder failure; keyboard/screen-reader users must discover and operate the alternative without searching the page.

### 3. P2 — Preserve verdict visibility in short viewports
**Confidence: confirmed-source geometry; rendered impact inferred.**

`src/web/scan/ui/scan.css:35-38,81-84,171-177` reserves 401px vertically inside a fixed, overflow-hidden shell. Below that height, the result has no remaining vertical space. `result/result.css:1-9,27-37` additionally clips a non-shrinking verdict band; only its body scrolls (`:120-127`). The short-height rule changes typography, not those reserves (`:222-231`).

**Fix:** Make vertical reservations responsive and allow the complete result to remain scrollable.  
**Acceptance:** At 844×390 and desktop 200–400% zoom, read the full verdict and reach every action without changing orientation or zoom.

### 4. P2 — Keep Undo results held when the accessibility preference is enabled
**Confidence: confirmed-source.**

`src/web/scan/machine/reduce-door.ts:130-135` unconditionally gives an Undo verdict a 1.2-second close deadline, bypassing `holdResults`. This contradicts the control’s documented promise to disable every timed dismissal (`docs/design/scanner/arch-client.md:566-567`).

**Fix:** Apply the same hold preference when updating an Undo verdict.  
**Acceptance:** Enable Keep results until tapped, scan successfully, then Undo; “Undone” must remain until explicitly dismissed.

### 5. P2 — Expose retained scan decisions without relying on hidden glyphs
**Confidence: confirmed-source.**

`src/web/scan/ui/recent-scans.tsx:35-47` hides the outcome glyph from assistive technology and prefers the action label over the reason. Successful and warning records can consequently both read “Check in,” omitting whether admission succeeded. The last-scan button similarly exposes holder/time but not outcome (`ui/last-scan-strip.tsx:33-42`).

**Fix:** Include a textual verdict and applicable reason in both retained representations.  
**Acceptance:** After success, duplicate-entry warning, and refusal, identify each decision using only screen-reader output from Recent and the strip.

### 6. P2 — Announce successive customer results with identical labels
**Confidence: confirmed-source.**

The customer display renders only `latest.label` in its live region (`src/web/scan/live/live-screen.tsx:143-155`). Consecutive successful scans receive the same redacted “Checked in” label (`src/worker/modules/scan/live-render.ts:19-34`), producing no changed announcement text. Unlike the scanner’s `LiveAnnouncer`, this path does not clear/reannounce per event.

**Fix:** Trigger a persistent announcer using the scan event ID, while preserving customer-data redaction.  
**Acceptance:** Scan two different accepted passes within ten seconds; each result must be announced exactly once.

### 7. P2 — Restore focus after returning from inline lookup confirmation
**Confidence: confirmed-source.**

`src/web/scan/lookup/lookup-panel.tsx:44-47` focuses the confirmation heading but explicitly excludes inline lookup from restoring field focus. Activating Back removes the focused confirmation subtree (`:73-75`). Operator lookup uses `inline` and also remounts on submission (`operator/operator-panel.tsx:34-39,80-95`), without a replacement focus target.

**Fix:** Distinguish initial inline rendering from returning/resetting and restore focus appropriately.  
**Acceptance:** Complete search → select → Back and search → check-in using keyboard/Switch Access; focus must remain predictable and support the next lookup.

### 8. P2 — Retain Dynamic Type font metadata on the iOS customer display
**Confidence: confirmed-source.**

**iOS:** `ios/PassBookScanner/CustomerDisplay.swift:85-89` copies a preferred font’s point size into a generic `systemFont`, then enables automatic category adjustment. [Apple explicitly requires a preferred or UIFontMetrics-scaled font](https://developer.apple.com/documentation/uikit/uicontentsizecategoryadjusting/adjustsfontforcontentsizecategory); the reconstructed font does not meet that contract.

**Fix:** Use the preferred font or UIFontMetrics, preserving the intended weight.  
**Acceptance:** Change text size while the display remains active; status text must resize and remain readable. This customer-display path is source-gated to iOS 27.1+ (`ScannerViewController.swift:102-114`).

## Strengths and counter-controls

- Persistent polite/assertive scanner regions explicitly handle repeated messages (`ui/live-announcer.tsx:20-35`).
- Main verdicts combine words and distinct glyphs; sound is not the sole decision channel.
- Ordinary result deadlines and member-card idle clearing respect the hold preference.
- Result/buddy motion has reduced-motion alternatives; camera/manual/reader alternatives exist.
- Android provides a polite native status region, labeled hardware input, and substantial native targets (`android/app/src/main/java/im/plrs/passbook/reader/MainActivity.java:126-159`). Identical result vibrations are therefore a **product-enhancement opportunity**, not independently a confirmed accessibility failure.

## Remaining evidence

Device validation is still required for focus ordering, speech interruption, zoom, touch, Bluetooth/USB keyboards, Switch Control/Access, and native font scaling. Additional source risks warrant targeted testing: the iOS load-error overlay has no explicit accessibility modal/focus notification (`ScannerViewController.swift:225-261`), and native customer-status changes only update static labels (`CustomerDisplay.swift:107-111`). Their actual VoiceOver effects remain **inference**, not demonstrated defects.

Relevant primary guidance: [W3C status messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html) and [reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html).
