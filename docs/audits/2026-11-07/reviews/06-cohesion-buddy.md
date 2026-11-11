# Scanner UI, motion and native-feedback audit

**Boundaries:** scanner boot/operator/customer screens, result/display renderers, buddy engine/CSS, sound preferences, machine timing, Android acknowledgements, and iOS customer-display handoff. Reviewed source and feature-introduction diffs; findings are not all regressions from the latest styling commit.

Paths are relative to `/Users/vlad/Repos/wallet`; **iOS:** denotes `/private/tmp/wallet-ios-scanner`.

## Findings

### 1. Forward web-originated results to the native customer display
**P1 · confirmed-source · confidence 0.99**

**Evidence:** iOS: `src/web/scan/input/native-reader.ts:75–78`; `ios/PassBookScanner/ScannerViewController.swift:144–154,160–176`.

Camera and HID reads originate in the web scanner. Native `result()` rejects them because they lack a pending native-read ID; the Swift display changes only through that native-read transaction. Consequently, the new customer display stays **Ready** during ordinary camera/HID check-ins, even while the operator sees a verdict. This defect accompanies the display introduced in `23879b74`.

**Fix:** separate customer presentation updates from correlated reader acknowledgements, forwarding server-confirmed outcomes from every supported input source.

**Acceptance:** on an available accessory display, camera and HID scans each show checking, acceptance/refusal, and return to ready.

### 2. Preserve acknowledgement correlation for queued native reads
**P1 · confirmed-source · confidence 0.98**

**Evidence:** `src/web/scan/platform/runtime.ts:154–158`; `machine/reduce-read.ts:98–99`; `input/android-reader.ts:59–61`; `machine/reduce-tick.ts:41–42`.

When another scan is checking, a native barcode is retained as `loop.next`, but `emit()` returns null because it checks only the current input. The adapter immediately acknowledges **error**. The reducer later processes that queued barcode and can successfully check it in, without a corresponding native acceptance. The iOS adapter has the same mismatch at iOS: `src/web/scan/input/native-reader.ts:66–68`.

**Fix:** represent queued acceptance explicitly and retain its correlation until its actual verdict—or reject it before enqueueing.

**Acceptance:** delay scan A, submit native scan B, then resolve both; B must never receive an error followed by an unacknowledged successful mutation.

### 3. Reflow results when viewport height is constrained
**P2 · confirmed-source · confidence 0.97**

**Evidence:** `src/web/scan/ui/scan.css:35–37,170–177`; `result/result.css:5–9`.

The result layer permanently reserves **117 + 284 = 401 px** vertically below 1024 px width. A landscape phone around 390 px high therefore has no remaining result-card area; the fixed shell and result both clip overflow. The short-height rule only reduces typography, not these reservations.

**Fix:** provide height-aware geometry that prioritizes a readable verdict and reachable actions over the decorative buddy reserve.

**Acceptance:** check accepted, refused, and held-action results at 844×390 and 667×375, including browser zoom. Headline, identity, and Done must remain usable.

### 4. Persist Sound changes through the player
**P2 · confirmed-source · confidence 0.99**

**Evidence:** `src/web/scan/scan-loop.tsx:111–114`; `machine/reduce-env.ts:94–95`; `sound/player.ts:70–80`; `platform/runtime.ts:75`.

The Sound checkbox changes only reducer state. Production callers never invoke `setEnabled()`, which owns persistence and the enable-preview/unlock behavior. Turning sound off therefore reverts after reload or a new shift. Conversely, an existing stored disabled preference keeps the player silent even if the checkbox is switched on.

**Fix:** synchronize the UI preference with the existing player API.

**Acceptance:** toggle off, reload, and remain silent; toggle on and hear the preview plus the next verdict.

### 5. Announce the actionable flag instead of “Refused”
**P2 · confirmed-source · confidence 0.99**

**Evidence:** `src/web/scan/machine/present.ts:74–82`; `machine/outcome.ts:40–42`; `src/shared/copy/scan.ts:51`; `src/worker/modules/scan/resolve.ts:288–289`.

For a real `check_required` response, the headline is `{flag}`. `announcementFor()` delegates to `headlineOf()`, which strips that placeholder and falls back to **Refused**. Thus a screen-reader operator hears a rejection instead of the required check, while the visible amber card correctly shows the flag.

**Fix:** derive spoken and visible headlines from the same populated outcome values.

**Acceptance:** a stop flag such as “Unpaid dues” must be announced as that check, not “Refused.”

### 6. Keep the scanner buddy landed between reactions
**P2 · confirmed-source · confidence 0.98**

**Evidence:** `src/web/scan/scan-loop.tsx:243–251`; `src/web/ui/art/buddy-art.tsx:113–116`; `art-wallet.css:118–123`; `art.css:152–154`.

Each beat changes the Buddy React key and remounts its seated WalletArt, but the scanner never supplies `landed` or `still`. Every read/result therefore restarts the shared falling entrance alongside the intended scan reaction. `immediate` controls scene replay; it does not disable that entrance.

**Fix:** mark subsequent scanner renders landed while retaining explicit reaction replay.

**Acceptance:** with normal motion, consecutive reads must not make the buddy disappear/fall in again. Reduced-motion behavior should remain unchanged.

### 7. Apply the result-beat delay only once
**P2 · confirmed-source · confidence 0.99**

**Evidence:** `src/web/scan/machine/store.ts:63–72`; `buddy/beats-1.css:9–10,165–173`; `timing.ts:24–26`.

The store waits 150 ms before publishing the result beat, then CSS adds another 150 ms delay. A 550 ms reaction consequently starts around T+300 and finishes around T+850, contradicting the explicit T+150/T+700 timing contract and separating motion from the verdict sound.

**Fix:** give either the store or CSS ownership of the delay, not both.

**Acceptance:** record a normal-motion verdict: reaction starts approximately 150 ms after the verdict and rests by 700 ms.

## Strengths and counter-controls

- Verdicts retain independent colour, glyph, and text signals.
- Persistent polite/assertive regions deliberately reannounce repeated messages: `ui/live-announcer.tsx:20–44`.
- Core motion is guarded by reduced-motion media queries; reduced-motion result transitions are short fades.
- Native acknowledgements require matching IDs, and raw VAS reads are explicitly rejected rather than falsely accepted: `input/android-reader.ts:53–56,67–70`.
- Phone/operator/customer surfaces have distinct responsibilities; persisted `desk` choices intentionally migrate to operator behavior: `src/shared/scan-surfaces.ts:8–15`.

## Product recommendations—not additional bugs

Android uses the same 100 ms vibration for acceptance, refusal, and errors (`MainActivity.java:219–223`). Decide deliberately whether outcome-specific patterns and a shared mute policy are wanted; equivalent iPhone haptics are not currently promised.

## Limitations and verdict

No edits, builds, tests, production requests, audio playback, assistive-technology sessions, or hardware verification were performed. Native customer-display behavior is conditional on the source’s platform availability guard and system-provided accessory; availability/entitlements were not independently verified. Existing door E2E coverage requests reduced motion (`e2e/16-scan-door.spec.ts:34`), so it does not exercise the two choreography defects.

**Overall correctness: incorrect. Confidence: 0.97.** The strongest problems are contradictory native acknowledgements and missing web-to-native customer feedback; the remaining findings affect accessibility, persistence, and presentation reliability.
