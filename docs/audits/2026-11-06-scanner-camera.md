# Scanner camera verification — 2026-11-06

## Scope

Camera pixels → self-hosted ZXing WASM Worker → real check-in API → persisted camera scan.
The browser tests keep the production decoder, input bus, state machine, auth, database and UI.

`npm run test:e2e:camera` runs Chromium, Firefox and WebKit over HTTPS. It exercises eight
barcode formats: QR, PDF417, Aztec, Code 128, Code 39, Codabar, EAN-13 and ITF. Each engine
reads a continuous sequence across 390×844, 1180×820 and 1440×900 viewports, with portrait
video and 90° rotation. Each pass must produce exactly one successful camera ledger entry.

The shared browser fixture replaces camera acquisition with a canvas MediaStream containing
barcode pixels; it does not inject decoded reads. A separate Chromium project keeps native
`getUserMedia` and reads a generated Y4M video through the browser's fake camera device.
It verifies live media settings, actual WASM decoding and the committed server acceptance.

The local matrix passed all 13 tests (including three setup checks): native camera API,
24 format-to-check-in verifications across three engines, and recovery/lookup scenarios in each.
Review captures: [Chromium](../design/scanner/review/camera-chromium.png),
[Firefox](../design/scanner/review/camera-firefox.png),
[WebKit](../design/scanner/review/camera-webkit.png).

## Corrections

- Advertise the four newer linear pass formats in scanner sessions.
- Bound decode frames to a 640 px aiming crop and a 960 px full frame every fourth read.
  Both portrait and landscape images have a bounded long edge.
- Confirm linear barcode text in two reads within 600 ms; suppress immediate repeats for 1.5 s.
  Server idempotency and check-in gates remain the authority for admission.
- Warm the WASM decoder explicitly; handle initialization, worker, message and frame timeouts.
  A broken decoder releases the stream and offers Retry camera.
- Keep initialization progressing through session/count updates, and pause while applying actions.
- Treat device enumeration and torch capability probing as optional. Retry unsupported/stale
  constraints with an unconstrained camera; retain explicit permission failures.
- Release late permission grants after navigation, stop disconnected tracks, and retry acquisition
  without reloading or re-pairing.
- Set muted, inline playback explicitly. Skip empty video frames and transient capture errors.
- Bound the optional frozen checking frame and fall back to live video if it cannot be captured.
- Offer Use camera on reader-configured devices, and Retry camera after failures.
- Preserve a deliberately disabled camera through background/resume. Restart an armed native
  reader when returning to a result; returning to Paused still requires Resume.

## Failure and flow coverage

Browser scenarios cover permission denial then retry, unplug then retry, background then Resume,
optional enumeration denial, overconstrained acquisition, delayed decoder startup, blocked WASM
fetch then retry, and a barcode held under an open lookup sheet. Lookup must commit no scans;
closing it must resume decoding and check in the presented pass.

Unit coverage additionally exercises stale worker replies, one frame in flight, stalled initialization
and decode, worker errors, transfer errors, late camera grants, front/wide selection, empty frames,
transient/permanent capture errors, paused frame rejection, throttling and linear-code stability.
The existing check-in suite covers atomic capacity/first-scan races, duplicate protection, undo,
mode isolation, lookup review, masked identities, scanner administration and accessibility/layout.

## Reproduce

```sh
npm ci
npx playwright install --with-deps chromium firefox webkit
npm run check
npm run coverage
npm run test:e2e
npm run test:e2e:camera
```

CI runs the camera suite in a separate test job after `check`, preserving browser traces,
screenshots and per-format check-in timings. Tests use local D1 and an ephemeral local TLS
certificate; production credentials and camera recordings are not part of the fixtures.

On macOS 27 the pinned Firefox needs isolated app data to avoid its protected real-browser
folder. The test config scopes that workaround to the child Firefox process; see
[Playwright #42768](https://github.com/microsoft/playwright/issues/42768).

## Hardware limits

Automated engine and viewport coverage does not establish physical device compatibility.
HTTPS, browser/OS camera permission and a browser with MediaStream, Canvas, Workers and
WebAssembly are required. An insecure origin, denied permission or missing camera shows
recovery and manual/reader input rather than a successful scan.

Physical iPhone/iPad Safari and installed home-screen mode, Android Chrome/WebView and P400,
front-only laptop cameras, low-end hardware, autofocus, torch, glare, distance and accessibility
assistive technology still need the venue/device trials in `scanner-plan.md` and
`android/ACCEPTANCE.md`. Android 13 emulator checks also passed: 18 unit tests, three bridge tests, four real WebView
instrumentation checks, lint, assembly and native camera acquisition on WebView 109. The first camera permission prompt was reproduced
and fixed: the request survives the system dialog, waits for the Activity to resume and rechecks
its origin. Pending requests are cancelled on navigation, browser cancellation and destruction.
The fix ships in Reader 0.2.2 with the original update signing identity.
These checks do not establish physical P400 or camera optics behavior.

The existing APK loads the hosted `/scan` code, so these camera
changes do not require a new APK or signing identity. NFC verification remains a later milestone.
