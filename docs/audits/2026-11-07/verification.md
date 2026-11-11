# Exercised verification

Audit date: 2026-11-07. Main checkout HEAD `8f5bee02ae999ad59b4ed42f8e033517d3cd15e4`; iOS worktree HEAD `0458552466f9f8c0c76f0893bf673d6217d22099`. Reviewers also observed preexisting Android capability edits: this is a working-checkout audit, not certification of an immutable release artifact. No application fixes or production mutations were performed.

## Baseline and integration checks

| Command / scenario | Observed result | Boundary |
|---|---|---|
| `npm run check` | Passed: 434 test files, 4,763 tests; generation, Biome, rules, TypeScript, tests, Vite/bundle checks and Wrangler dry run completed. | Main checkout baseline, before temporary audit harnesses. Does not establish production configuration or hardware behavior. |
| `env -u CI npx playwright test --project=setup` | 3 passed. | Local mock OIDC, fixture identities and isolated local D1. Initial invocation with inherited CI refused the already-running server; unsetting CI selected documented local server reuse. |
| `env -u CI npx playwright test e2e/02-create-pass.spec.ts e2e/07-public-link.spec.ts e2e/10-a11y.spec.ts e2e/14-sandbox.spec.ts e2e/23-scanning-sessions.spec.ts --project=e2e` | 34 passed, including setup dependencies. | Pass creation/download, public link lifecycle, sampled axe checks, sandbox capture and shared scanner sessions. Not exhaustive accessibility or lifecycle proof. |
| Android `./gradlew :app:testDebugUnitTest :app:lint :app:assembleDebug` with Android Studio JDK and local SDK | Overall FAILED: `UnsupportedChromeOsCameraSystemFeature` at `MainActivity.java:309`. Unit-test and debug-assembly tasks completed; lint reported 1 error, 0 warnings. | Do not treat APK assembly as a clean native baseline. No lint suppression or baseline modification. |
| Android `./gradlew :app:connectedDebugAndroidTest` | Passed: 6 instrumented tests on isolated `passbook-p400-api33`, Android 13 emulator. | Actual WebView/native test activity, not RF, vendor firmware or physical accessory interoperability. |
| iOS `xcodebuild -project ios/PassBookScanner.xcodeproj -scheme PassBookScanner -sdk iphonesimulator -destination 'platform=iOS Simulator,id=DD831C64-D650-420A-AD2E-ED74140EECE3' -derivedDataPath /tmp/passbook-audit-ios-derived CODE_SIGNING_ALLOWED=NO build` | Succeeded with Xcode 27.2. | Unsigned simulator build; no signing, entitlement approval or TestFlight operation. |
| `xcrun simctl install … PassBookScanner.app`, then `xcrun simctl launch … mobile.passbook.scanner` | Installed, launched and visually displayed the unpaired scanner. | Shipping origin is hardcoded; observed anonymous hosted pairing page only. No pairing, authenticated production operation, camera, NFC or bridge round trip performed there. |

`node tools/e2e-server.ts` created fresh `.wrangler/e2e-state` and throwaway `.dev.vars.e2e`, applied local migrations, started mock OIDC on 5174 and Vite on 5173. Readiness initially timed out while migrations completed; subsequent local health/auth/browser checks succeeded. No `--remote` or deployment application was used.

## Security reproductions

These were positive reproductions of unsafe behavior, not regression tests asserting safety. Fixture addresses, pass data, keys and photographs were synthetic. No real email was sent.

### Queued recipient receives replacement credentials — reproduced

Command: `npm run test:worker -- src/worker/modules/delivery/audit-queued-recipient.test.ts`.

Result: **1 test passed**, demonstrating the unsafe state.

1. Create active live-mode fixture pass owned by A; request an attached email through the real scoped resend service.
2. Retain its original queued job; reassign ownership to B, rotate the download link, and update the pass contents.
3. Confirm the former link returns 404 and the replacement returns the current signed artifact through the local Hono app.
4. Process the original job through the real queue dispatcher and fake mailer.
5. Assert the captured recipient is A, the message contains the replacement URL, and the attachment bytes equal the current artifact. Repeat dispatch: provider/outbox replay guards prevent a duplicate, but do not prevent the first disclosure.

Counter-control exercised: an API-key resend to a non-holder is rejected. The reproduction used the authorized admin service path; it does not claim anonymous enqueue access.

### Scanner secret/role filtering and photo alias — reproduced

Command: `npm run test:worker -- src/worker/modules/scan/audit-scanner-disclosure.test.ts`.

Result: **4 passed, 1 failed**. The failed case is separately explained below; the four completed cases establish:

- A Door display omits synthetic secret/desk-only values while the same response's raw `passView.passJson` retains them. A Desk display may show its permitted desk-only value.
- `showPhoto:false` denies `member.png`, but the same actor can retrieve identical synthetic photo bytes through `thumbnail@3x.png` when `includeInPass:true`.
- An insufficient photo role has the same alias bypass.
- With `includeInPass:false`, the thumbnail does not expose the private photo. Actor-bound asset grants remain enforced.

Fixtures use the in-memory registry and are also checked against the uploaded-manifest validator. This does not demonstrate anonymous or cross-tenant image access.

### Monitor promotion after metadata rename — reproduced independently over HTTP

The fifth worker-harness case observed `device_role='scan'` after a name-only PATCH, then failed its assumption that `surface` would remain `desk`: the actual value was `auto`. The harness was **not changed or re-pinned to make it pass**. It stopped before exercising the action.

An independent local HTTP smoke then used the real running Worker, an admin request context and a separate paired-monitor context:

1. Clone the starter generic template and create a synthetic pass and watched source scanner.
2. Create a standalone monitor using `/api/v1/scan-setups`, with an explicit accepted template and watch source; pair it once.
3. Submit a valid check-in with that monitor cookie/CSRF: **403 `SCREEN_ONLY`**.
4. As admin, PATCH `/api/v1/scanning-sessions/{setupId}/devices/{setupId}` with only `{name:'Audit monitor renamed'}`.
5. Resubmit using the **unchanged** monitor cookie/CSRF and a fresh idempotency key: **200, `kind:'ok'`**.
6. Query scan history as admin: an `ok` check-in for that monitor/pass is recorded.

This is admin-triggered unintended permission expansion, not a monitor-authenticated administration bypass. Source review explains the stronger persistent variant: creation defaults survive PATCH `.partial()`, replacing omitted surface with `auto`.

Temporary reproduction files were removed after execution; no existing tests or verification configuration were modified.

## Browser observations

Managed Chrome inspected actual desktop and phone surfaces, using local test accounts. Screenshots are synthetic and contain no production passes:

- [Admin settings](screenshots/admin-settings.png): grouped cards, nine visible controls, no collapsed Advanced group in the observed page.
- [Portal phone empty state](screenshots/portal-phone.png): navigation, empty-state copy and secondary-email action fit 390 CSS px without horizontal overflow.
- [Scanner pairing phone](screenshots/scanner-pairing-phone.png): distinctive buddy treatment, pairing input and recovery/admin affordances.
- [iOS Duo anonymous pairing](screenshots/ios-duo-unpaired.png): native app displays the hosted scanner; this proves loading, not native capabilities.

Desktop scanning-session list and creation dialog, public pass installation and sign-in were also visually inspected. Scanner pairing at 390×844 had no horizontal document overflow; reduced-motion media emulation was active. Keyboard Tab reached its pairing input.

Command palette manual check: after opening and dismissing Search, focus remained on a removed/dismissed search input; the next Tab went to Skip to content rather than returning to the invoking Search button. This corroborates the shared-kit focus-restoration finding, not a whole-app keyboard audit.

Local login displayed a Turnstile browser-verification error. The local site-key configuration is not production evidence; no production Turnstile defect is asserted.

## Limits and interpretation

Passing checks do not contradict the reproductions: existing coverage does not exercise these boundaries. No physical P400, USB/Bluetooth reader, NFC tag/Wallet RF exchange, Apple Watch, external camera or Duo outside-display activation was tested. No VoiceOver/TalkBack session, mail-client rendering matrix, signed release, provider-account approval or production WAF/Access/backup review occurred.

Other findings remain source-confirmed or explicitly inferred as labelled in the independent reports. In particular, OIDC account pre-hijacking depends on provider email policy; multi-isolate caches and lifecycle/concurrency interleavings require dedicated deterministic reproductions. Native build success does not establish App-Bound Domains bridge operation.
