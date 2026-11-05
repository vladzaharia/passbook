# /scan client architecture

Front-end design for the staff scanner. It serves `ux-door.md` (UD), `ux-desk.md` (UK) and `buddy-motion.md`, and
calls the API in `arch-server.md` (AS). Other sources: research `research/scanning/report.md` (R§), its notes
`web-feasibility.md` (WF§) and `ux-guidelines.md` (UXG), the critic's corrections at the end of the report (C#),
`n8b-buddy.md` (B) and `docs/design/scanner/platform-map.md` (PM§). Paths are relative to `scratchpad/next` unless they start
with `/`. **[U]** = unverified, needs a device test. **[I]** = our inference.

---

## 0. Decisions

| # | Decision | Why |
| --- | --- | --- |
| D1 | `/scan` is a **separate HTML entry** (`scan.html` → `src/web/scan/main.tsx`), not a lazy route of the SPA. It shares chunks (React, Radix, kit files, tokens, theme) with the SPA. | Permissions-Policy and CSP are per document. A client-side navigation from `/admin` into a lazy `/scan` route keeps the admin document's `camera=()`, and the camera fails (PM§7). It also gives the scanner its own budget (the SPA has ~5 B headroom, PM§8), its own manifest scope and its own service-worker scope. UD and UK assumed a lazy route; nothing in their UX depends on it. |
| D2 | Headers are path-scoped: `/scan` gets `camera=(self)`, `worker-src 'self'` and `'wasm-unsafe-eval'`. `/assets/*` gets `'wasm-unsafe-eval'` too, so the decode worker can compile WebAssembly whichever policy WebKit applies to it. | PM§7 items 1-3. CSP3 gives a dedicated worker the policy of its own script response [U on WebKit]. SPA documents stay unchanged. |
| D3 | Decoder: **`zxing-wasm@3.1.6` `reader` build in a module Worker** on every iOS device. Native `BarcodeDetector` only where `getSupportedFormats()` covers the scanner's formats, which is never Safari. No `barcode-detector` ponyfill layer. | R§5.8.1, WF§1-2. Using it directly gives `ReaderOptions` (formats, `maxNumberOfSymbols: 1`) and corner positions for the lock box. 3.1.6 was published 2026-10-19, 16 days ago, so it passes the 2-week rule. Measured from the package: `zxing_reader.wasm` is 946,860 B raw and **407,682 B gzip**; the glue is 12,297 B gzip. |
| D4 | One normalized `ScanInput` comes from four sources (camera, wedge, NFC bridge, manual) into one store. Wedge detection reads **`event.code`**, not `event.key`, so a German or French iPad layout still yields the US characters the reader sent. | R§2.2.6 (one outcome for every input). R§3.4 (the US layout must match), UD§8.1 (the layout check). |
| D5 | The scan machine is **one pure reducer returning `{ state, cmds }`**, shared by door and desk. Its regions: the scan loop, camera, overlay, network/outbox, reader, card actions, block. Effects run from commands, so every transition is unit-testable without timers or DOM. | Task 2. UK§2.1 and UD§12 ask for one `useScanMachine`. |
| D6 | **Offline ships in two steps, plus a third.** **v1:** online only. Every request carries a client UUIDv7 key. An action with no answer becomes *Not confirmed*: it is retried with the same key every 10 s and on reconnect for 2 min, and a re-scan of the same code reuses the key. **v2** (opt-in per scanner, check-in only): a hashed code roster with no personal data, an offline queue, batch sync and conflicts. **v3:** a service worker scoped to `/scan`, for a cold start offline. | R§5.6, UK§6.24, UD§11, AS§6.6. iOS has no Background Sync (WF§7). |
| D7 | The Start tap is a camera, audio and wake-lock gate, **not** a loop state. A wedge reader, search or manual entry work before anyone taps Start, so a desk iPad with a reader never needs the camera. | R§2.1 Start; UK decision 7. |
| D8 | **One `ScanBuddy`** with an immediate beat API (`beat`, `beatKey`), cut by the next scan. Beats ship in `src/web/scan/buddy/` with their own budget test, outside the shared scenes budget (11 B headroom, UK decision 12). | B "Speed"; PM§8 (`useScene` waits 700 ms; scenes last ≥1.8 s). |
| D9 | Owner sizes win over the research's 56 pt. Verdict actions are kit `Button size="lg"` (44 px), full width. The app uses `AppShell holder={false}`: no Dynamic Type, admin sizes. | Owner direction; UK decision 13. UD§2.2 named `holder`; the owner's rule wins. |
| D10 | Capability URLs never leave the device. A scanned `/p/…` or `/b/…` link of our origin, or a pairing link while paired, is refused locally and never sent. Codes and names never go into a URL. | PM§10 gaps 27 and 32. Holders will show the Add QR (ux-principles "Off iPhone the QR leads"). |
| D11 | **Offline shows as a header chip, not the shell's `OfflineBanner`.** | The banner pushes the viewfinder down by 32 px, which breaks the owner's no-layout-shift rule. UK§6.24 uses the chip; UD D17 used the banner. |
| D12 | The pairing link is **`/scan#pair=CODE`** (AS§2.3), not `?pair=` (UD D7). | A fragment never reaches a server log or a Referer. UD's reason for the query string (`isPublicPath` exact match) goes away with D1. The confirm-before-pair page of UD§4.3 stays. |

---

## 1. Entry, bundle and headers

### 1.1 The entry

```
scan.html                         repo root, beside index.html
src/web/scan/main.tsx             entry
public/scan.webmanifest           home-screen manifest
```

`scan.html` copies `index.html`'s head, with these differences. The copied parts are: charset, the viewport with
`viewport-fit=cover`, `color-scheme`, both `theme-color` metas, icons, `format-detection` and `/theme-init.js`.

```html
<title>Scan · PassBook</title>
<meta name="robots" content="noindex, nofollow" />
<link rel="manifest" href="/scan.webmanifest" />
<meta name="apple-mobile-web-app-title" content="Scan" />
<!-- no og:* tags: nothing here is for sharing -->
<script type="module" src="/src/web/scan/main.tsx"></script>
```

`main.tsx` does what `src/web/main.tsx` does, minus the router:

- `z.config({ jitless: true })`;
- `installInputModality()`;
- the `vite:preloadError` reload-once guard. Move it from `src/web/main.tsx` to `lib/chunk-reload.ts` (h0) so both
  entries import one copy;
- `import '../styles/app.css'`;
- then `createRoot(#root).render(<StrictMode><ScanApp/></StrictMode>)`.

It does **not** import `pass-card/barcode-loader.ts`: the result card hides the barcode (7.4).

`ScanApp` wraps everything in `AppProviders` (`lib/providers.tsx`: Query, theme, tooltip, toaster), with the client from
`createQueryClient()`. So the provider stack stays one implementation.

**Kit imports by file, never through the barrel.** `@/web/ui/index.ts` re-exports `command-palette` (cmdk) and
`data-table`. Scan code imports files such as `@/web/ui/button.tsx` and `@/web/ui/dialog.tsx`. The scan bundle check
(1.3) forbids the same markers as the SPA's.

### 1.2 Serving `/scan`

- **Production.** `run_worker_first: ["/*", …]` sends `/scan` to the Worker, and `spaPage()` (`src/worker/app.ts:47`)
  calls `ASSETS.fetch`. The asset layer's default `html_handling` (`auto-trailing-slash`) answers `/scan` with
  `scan.html` [U: verify with `wrangler dev`; the e2e header check in 10.6 covers it]. The scanner is one page:
  no hash routing and no path changes while the camera runs (WebKit 215884, WF§3).
- **Dev.** Add `'!/scan'` to `VITE_DEV_PATHS` in `vite.config.ts` so that Vite answers it. Vite's HTML fallback serves
  `scan.html` for `/scan` when that file exists [U: confirm in Vite 8].
- **Build.** `build.rolldownOptions.input = { main: 'index.html', scan: 'scan.html' }` [U: confirm that the Cloudflare
  Vite plugin builds two HTML inputs into `dist/client`].
- **SPA side.**
  - Delete the placeholders `src/web/routes/scan.tsx` and `src/web/scan/scan-page.tsx` (n8-owned).
  - Drop `'/scan'` from `isPublicPath` (`lib/guards.ts`, h0).
  - Admin links to the scanner are plain `<a href="/scan">`, because D1 needs a full document load. With the route gone,
    a typed TanStack `Link to="/scan"` stops compiling, which is the guard we want.
- **Pairing link.** `https://<origin>/scan#pair=<code>` (AS§2.3). `boot/pair-link.ts` reads the fragment once at boot
  and calls `history.replaceState(null, '', '/scan')` before any request. Then it shows UD§4.3's confirm card. Only the
  **Pair** tap posts `pair`.

### 1.3 Budgets

| Chunk | Loads | Budget (gzip) | Contents |
| --- | --- | --- | --- |
| Scan initial (`scan.html` entry + modulepreloads) | page load | **150,000 B** (`SCAN_BUDGET_BYTES`) | React, React DOM, TanStack Query, zod, shell, reducer, wedge, kit button/dialog/input, theme, `app.css` |
| `decoder` | prefetched on the Start panel, run on Start or on the desk's camera button | 16 kB JS + the wasm (408 kB gzip, cached immutable) | `camera/decode-worker.ts`, `zxing-wasm/reader` |
| `result` | prefetched on idle after boot | 25 kB | `result-pass.tsx`, `shared/pass-view/normalize`, `pass-card` (no barcode) |
| `buddy` | after the first paint | art kit share + beats ≤3 kB (UK§2.8; final number in `buddy-motion.md`) | `buddy/*` |
| `sound` | on Start | ≤1.5 kB | `sound/*` |
| `lookup` | first open; prefetched on idle | 8 kB | `lookup/*` |
| `desk` | when the scanner's flow is `choose` | 20 kB | member card, pickers, keypad, review |
| `offline` (v2) | when the scanner has offline check-in | 6 kB | roster, sync |

`tools/check-bundle.ts` (foundation) gains a second run over `dist/client/scan.html`, with `SCAN_BUDGET_BYTES`. It uses
the same `FORBIDDEN` markers plus `routeTree` (the scan entry must never pull the SPA router tree) and `__passbookScan`
(the e2e hook, 10.6).

If the first build exceeds 150 kB, split Vite's `tanstack` chunk group into `tanstack-query` and `tanstack-router`
before asking for more. Today the group bundles the router with Query (`vite.config.ts`), and the scanner needs only
Query.

### 1.4 Headers

Both `public/_headers` and `src/worker/platform/security-headers.ts` change. They are foundation-owned, so the change
goes through integration; `security-headers.test.ts` keeps them in step.

```
/scan
  ! Content-Security-Policy
  Content-Security-Policy: <the /* policy> with script-src 'self' 'wasm-unsafe-eval' https://challenges.cloudflare.com and worker-src 'self'
  ! Permissions-Policy
  Permissions-Policy: camera=(self), microphone=(), geolocation=(), payment=(), usb=()
  ! Referrer-Policy
  Referrer-Policy: no-referrer

/assets/*
  ! Content-Security-Policy
  Content-Security-Policy: default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'

/scan.webmanifest
  Content-Type: application/manifest+json
  Cache-Control: public, max-age=86400

/scan-sw.js                       (v3)
  Cache-Control: no-cache
```

- On `/assets/*`, `'wasm-unsafe-eval'` matters only to worker scripts; documents ignore a script response's CSP.
  `connect-src 'self'` inside the worker lets `zxing-wasm` fetch its `.wasm` from `/assets/`.
- `security-headers.ts` exports `SCAN_PERMISSIONS_POLICY` and `scanContentSecurityPolicy()` beside the existing
  constants, and adds `/scan` to `NO_REFERRER_PREFIXES` (UD§15.1).
- `wrangler.jsonc` `run_worker_first` adds `"!/scan.webmanifest"`, and in v3 `"!/scan-sw.js"`. The service worker is
  emitted by the build, not shipped in `public/`, so `tools/wrangler-config.test.ts` must accept build-emitted names.

---

## 2. Input pipeline

### 2.1 The normalized event

```ts
// src/web/scan/input/types.ts
export type ScanMethod = 'camera' | 'wedge' | 'nfc' | 'manual';         // AS§5.1, R§5.8.21
export type CodeFormat = 'qr' | 'pdf417' | 'aztec' | 'code128' | 'code39' | 'codabar' | 'ean13' | 'itf';

/** What a source emits. Sources never call the network. */
export interface RawRead {
  method: ScanMethod;
  code?: string;           // decoded text, typed code, or NFC VAS message (= scanCode, AS D9)
  passId?: string;         // a row picked in lookup
  format?: CodeFormat;     // camera only
  box?: Quad;              // camera only: corners in screen px, for the lock box and the buddy's eyes
}

/** What the store works with. */
export interface ScanInput extends RawRead {
  id: string;              // client UUIDv7; the idempotency key of the request it causes, unless reused (3.4)
  at: number;              // epoch ms, from the injected clock
  sig: string;             // dedupe signature: 'c:' + code, or 'p:' + passId
  local?: LocalRefusal;    // set by normalize (2.2); never sent
}

export interface InputSource {
  readonly method: ScanMethod;
  /** Starts listening; returns stop. `emit` may be called at any time, including before Start. */
  start(emit: (read: RawRead) => void): () => void;
}
```

`input/bus.ts` owns the sources. `bus.emit(read)` runs `normalizeRead()`, stamps `id`, `at` and `sig`, and dispatches
`{ type: 'read', input }` to the store. Every source goes through `bus.emit`, including the e2e test hook (10.6).

### 2.2 Normalizing a code (`input/normalize.ts`, pure)

The server normalizes again (AS§5.2). The client does only what keeps data on the device.

1. Strip ASCII control characters and trailing CR, LF and Tab (readers append them). Trim.
2. Empty, or more than 1024 UTF-8 bytes: local refusal `not_found` (the server's rule, AS§5.2).
3. If the code parses as a URL on our origin (`location.origin`, plus `PUBLIC_BASE_URL` injected at build):
   - a `/p/…` or `/b/…` link becomes local refusal `add_link`, because the holder showed Add to Wallet, not the pass.
     **Never sent.** UD and UK own the copy.
   - `/scan#pair=…` in the pairing view is the pairing code. While paired, it is local refusal `not_found`. **Never
     sent.**
   - Any other path on our origin is local refusal `not_found`.
4. Otherwise the code goes to the server as it is. The client does not upper-case or re-encode it.

A local refusal produces the same `ScanOutcome` (3.3) with `local: true` and no request, so it looks and sounds like
every other refusal.

### 2.3 Camera source

`camera/` is plain TypeScript with no React: `CameraController`, `FrameLoop` and `Decoder`. `ui/viewfinder.tsx` owns the
`<video>` and hands it to the controller. The desk's camera dialog (UK§6.23) mounts the same `Viewfinder`.

**Decoder choice** (`camera/decoder.ts`):

```ts
export interface Decoder {
  init(formats: CodeFormat[]): Promise<void>;          // rejects with DecoderError('load' | 'unsupported')
  decode(frame: Frame): Promise<DecodeHit | null>;     // one symbol at most
  close(): void;
}
export async function createDecoder(formats: CodeFormat[]): Promise<Decoder> {
  if ('BarcodeDetector' in globalThis) {
    const supported = await BarcodeDetector.getSupportedFormats().catch(() => []);
    if (formats.every((f) => supported.includes(NATIVE_NAME[f]))) return new NativeDecoder();
  }
  return new ZxingWorkerDecoder();                     // every iPhone and iPad (R§5.8.1, WF§1)
}
```

- `formats` come from the scan session: the union of the barcode formats of the scanner's templates. The default is
  `['qr', 'pdf417', 'aztec', 'code128']`, the minimum in PM§5. Code 39, Codabar, EAN-13 and ITF exist only on iOS 27.
- **Worker** (`camera/decode-worker.ts`), created with
  `new Worker(new URL('./decode-worker.ts', import.meta.url), { type: 'module' })`:
  ```ts
  import { prepareZXingModule, readBarcodes, type ReaderOptions } from 'zxing-wasm/reader';
  import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url';
  prepareZXingModule({
    overrides: { locateFile: (p, prefix) => (p.endsWith('.wasm') ? wasmUrl : prefix + p) },
    fireImmediately: true,
  });
  const options = (formats): ReaderOptions => ({ formats, maxNumberOfSymbols: 1, tryHarder: true,
    tryRotate: true, tryInvert: false, tryDownscale: true, textMode: 'Plain' });
  ```
  - Protocol (`camera/worker-protocol.ts`):
    - `{ t: 'init', formats }` → `{ t: 'ready' } | { t: 'error', code }`;
    - `{ t: 'frame', id, w, h, buf }` (a transferred RGBA `ArrayBuffer`) →
      `{ t: 'hit', id, text, format, corners, ms } | { t: 'miss', id, ms }`.
  - `tryInvert: false`, because Wallet draws codes dark on light. Turn it on only if field tests show inverted codes.
- **Native** (`camera/native-decoder.ts`): `new BarcodeDetector({ formats })` and `detect(video)` on the main thread,
  at the same throttle. It serves Chrome desktop, and Android later.

**Frame loop** (`camera/frame-loop.ts`):

| Constant | Value | Source |
| --- | --- | --- |
| `DECODE_INTERVAL_MS` | 125 (8 decodes/s, never more than 10) | R§5.8.1, WF§2 |
| `DECODE_INTERVAL_IDLE_MS` | 250 (4/s), on a stand after 60 s with no read | UD§2.1 |
| `ROI_FRACTION` | 0.7 of the shorter video side, centred | R§5.8.1 "centre crop" |
| `ROI_MAX_SIDE` | 640 px after downscale; 480 when the last 10 decodes average over 120 ms | WF§2 |
| `WIDE_EVERY` | every 4th frame decodes the whole frame, scaled to ≤960 px wide, for PDF417 and off-centre codes | [I] |
| `PDF417_ROI` | when `formats` includes `pdf417`: 0.85 × 0.45 of the frame (a wide band) | [I] PDF417 is ~3:1 |
| `WORKER_FRAME_TIMEOUT_MS` | 1000; after 3 timeouts in a row, terminate and recreate the worker | [I] |
| `DECODER_INIT_TIMEOUT_MS` | 8000, then camera status `decoder_failed` | [I] |

- Grab frames with `requestVideoFrameCallback` where present, else `requestAnimationFrame`. Skip a frame unless
  `now - lastSent ≥ interval` **and** the worker is idle (backpressure: never queue frames).
- Copy the ROI with `ctx.drawImage(video, sx, sy, sw, sh, 0, 0, dw, dh)` into one reused canvas
  (`getContext('2d', { willReadFrequently: true })`), call `getImageData`, and transfer `data.buffer`.
- The loop runs only while `decodeActive(state)` is true (3.6). On a hit it stops at once (R§2.1 "Detected"). The
  controller calls `video.pause()`, which freezes the frame (UD§5.2 Detected). `video.play()` resumes it: the video is
  muted and `playsinline`, so no gesture is needed.
- `camera/roi.ts` maps the decoder's corners from ROI pixels to screen pixels through the `object-fit: cover`
  transform. The lock box (UD§5.2: a 2 px outline) and the buddy's eyes (B "Code detected") use that box.

**Stability and dedupe** (`camera/stability.ts`, pure):

- 2D symbols (QR, PDF417, Aztec) carry error correction, so one read is enough.
- 1D symbols (Code 128, Code 39, Codabar, EAN-13, ITF) need **two identical reads within 600 ms** before they emit.
- While the decode loop stays active, the same code is not emitted again within `DECODER_REPEAT_MS = 1500`. This only
  stops flooding; the 5 s and 30 s semantic dedupe is the store's job (3.4).

The camera lifecycle is in 6.1.

### 2.4 Keyboard wedge (barcode guns, VAS readers in keyboard mode)

Wedge input looks exactly like typing, so detection is by timing (WF§5, R§5.8.4, UD§8.1). A connected hardware keyboard
hides the iOS on-screen keyboard (C#2, WF§5). The desk therefore uses its own keypad for amounts (UK decision 5).

**Detector** (`input/wedge-detector.ts`, a pure class, no DOM):

```ts
export interface WedgeConfig {
  maxGapMs: number;          // a longer gap starts a new burst
  maxMeanGapMs: number;      // mean gap of an accepted burst
  minLength: number;
  idleAcceptMs: number;      // no terminator: accept after this much quiet …
  idleMinLength: number;     // … if at least this long …
  idleMaxMeanGapMs: number;  // … and this fast
  maxLength: number;
}
export const WEDGE_STANDARD: WedgeConfig = { maxGapMs: 80, maxMeanGapMs: 50, minLength: 4,
  idleAcceptMs: 150, idleMinLength: 8, idleMaxMeanGapMs: 30, maxLength: 1024 };
export const WEDGE_SLOW: WedgeConfig = { maxGapMs: 150, maxMeanGapMs: 90, minLength: 4,   // Bluetooth readers that batch (WF§5)
  idleAcceptMs: 250, idleMinLength: 8, idleMaxMeanGapMs: 60, maxLength: 1024 };

export type WedgeKey =
  | { k: 'char'; ch: string; t: number }
  | { k: 'end'; key: 'Enter' | 'Tab'; t: number }
  | { k: 'ignore'; t: number }       // Shift, CapsLock: no reset, no character
  | { k: 'other'; t: number };       // anything else: reset

export type WedgeVerdict =
  | { v: 'none' }
  | { v: 'burst' }                   // ≥2 chars and the last gap ≤ maxGapMs: callers may preventDefault
  | { v: 'human'; ch: string }       // one char, then no second within maxGapMs
  | { v: 'scan'; code: string; start: number; end: number; via: 'Enter' | 'Tab' | 'idle' };
```

Rules:

1. **`char`.** If the buffer is empty, or `t - last > maxGapMs`, the buffer restarts with this character. Otherwise
   the character is appended.
2. **`end`.** It is a scan when all three hold:
   - `length ≥ minLength`;
   - `(last - start) / (length - 1) ≤ maxMeanGapMs`;
   - `t - last ≤ maxGapMs`.

   Otherwise the buffer resets and the key does what it normally does.
3. **Reset.** `other`, `event.repeat`, `event.isComposing`, or Ctrl, Meta or Alt held.
4. **`flushIdle(t)`.** A timer calls it `idleAcceptMs` after the last character. It returns a scan when the idle rules
   hold (C#: no delimiter guarantees, R§3.4). It returns `human` when the buffer holds exactly one character.
5. **Too long.** More than `maxLength` characters: reset.

**Characters come from `event.code`.** `input/us-keymap.ts` maps physical keys, with and without Shift, to the
US-layout character: `KeyA`-`KeyZ`, `Digit0`-`Digit9`, `Numpad0`-`Numpad9`, `Minus`, `Equal`, `BracketLeft`,
`BracketRight`, `Backslash`, `Semicolon`, `Quote`, `Comma`, `Period`, `Slash`, `Backquote` and `Space`. Readers emit
HID usages for a US layout (R§3.4, nfc.md). Mapping the physical code recovers what they meant, whatever layout iPadOS
has. Use `event.key` only when `event.code` is empty (some virtual HID stacks) [U]. UD§8.1's layout check (three bursts
with characters outside `[A-Za-z0-9\-_.:/]` turn the chip into **Set the keyboard to U.S.**) stays as a guard for that
fallback.

**Listener** (`input/wedge-source.ts`): one `keydown` listener on `window`, in the capture phase.

| Focus is on | Behaviour |
| --- | --- |
| Nothing editable (body, a button, the scan region) | Feed every key. On `burst`, `preventDefault()` the key, so a burst's characters or its Enter never press a focused button such as **Done**. On `scan`, `preventDefault()` the terminator and emit. On `human`, open lookup with that character typed in (UD§8.1 slow typing). |
| A **registered** scan field (lookup, pairing code) | Feed passively and never `preventDefault` characters. Snapshot the field value when a burst starts. On `scan`, `preventDefault()` the terminator, restore the field to the snapshot through its registered setter, close the lookup sheet and emit (UD§8.1, UK decision 6). Focus never moves because of reader input. |
| Any other editable (none should exist in `/scan`) | Do not feed. The reader chip shows paused (UD§8.2). |

- Fields register through `useWedgeField(ref, setValue)` (`input/wedge-field.tsx`). The scanner's text inputs are all
  `ScanTextField`, which calls it. A test asserts that every `input` and `textarea` rendered in the scan app is
  registered. The desk's amount fields are `inputmode="none"` with the in-app keypad (UK decision 5): keys typed into
  them are bursts or nothing.
- **Method.** The emitted method is `'nfc'` when the scanner's reader setting is NFC **and** the code has the scan-code
  shape (`^[A-Z2-7]{26}$` after removing spaces and dashes; AS§5.2, UD§8.1). Otherwise it is `'wedge'`.
- **Focus.** Keystrokes reach the window listener only while the page has focus. When an overlay closes, focus returns
  to the control that opened it (Radix does this), or to the scan region (`tabIndex={-1}`, labelled with the scanner
  name). The store tracks `window` `blur` and `focus`. While the window is blurred (iPad Split View, the address bar),
  the reader chip shows paused, and a tap on the chip focuses the scan region (UD§8.2).
- **Fallback sink**, opt-in per device (`passbook-scan-reader-focus: field`). A visually hidden
  `<input inputmode="none" aria-label="Reader input">` holds focus whenever no other control has it. It is refocused
  100 ms after a blur unless focus moved to a control. `inputmode="none"` keeps the iOS keyboard down. Use it only if a
  reader does not deliver window `keydown` events without a focused field [U: test with a VTAP100 and a Socket S700 on
  iPad and iPhone Safari].
- `passbook-scan-reader-timing` (`standard | slow`) picks `WEDGE_STANDARD` or `WEDGE_SLOW`.
- A VTAP stays silent when it cannot decrypt a pass (C#7), so nothing reaches the page. UD§8.2 and UK
  (`READER_NO_READ_HINT`) show a tip after a quiet spell. The store runs that timer (3.4).

### 2.5 Manual entry and lookup

`lookup/lookup-panel.tsx` serves both postures: a kit `Dialog` bottom sheet on the phone, the left rail on a landscape
iPad, a popover in portrait (UK§2.1). It has one `ScanTextField`, 16 px on touch.

| Typed | What happens |
| --- | --- |
| Enter on a code with no spaces and no `@`, ≥4 characters | `bus.emit({ method: 'manual', code })`. The same pipeline and verdicts as a camera read (R§5.8.5) |
| ≥3 characters with letters (`SEARCH_MIN`) | Live name search, debounced `SEARCH_DEBOUNCE` (250 ms, `lib/debounce.ts`), via `lookup(q)`. At most 10 masked rows (R§4 rules 3-4, AS§7.2) |
| Contains `@` | No live search. On Enter, check with `strictEmail()` (`src/shared/email.ts`): invalid shows the field error; valid calls `lookup(email)` once (R§4 rule 3) |
| A row picked | `bus.emit({ method: 'manual', passId })`. Focus goes to the card heading on the desk (UK§2.9) |
| Several rows match one code | `MatchPicker` (UK§6.19), the same rows |
| 429 | Field error with the `Retry-After` seconds; the field stays usable (R§4 rule 5) |
| Offline | Inline **Look up needs a connection.** (UD§11); search disabled (UK§6.24) |

Lookup queries use `gcTime: 0`, so a name never stays in TanStack Query's cache after the panel closes. AS§12 puts `q` in
a GET query string. Section 13 asks the Unify phase to make it a POST body, because a name is personal data (PM§10
gap 27).

### 2.6 Native NFC bridge (interface only)

A future native shell (a `WKWebView` app using ProximityReader `readVAS`, R§3.3) would feed the same bus.

```ts
// src/web/scan/input/nfc-bridge.ts
export interface NfcBridge {
  /** Hardware and entitlement are present; false on the web. */
  available(): Promise<boolean>;
  /** One read through the system sheet. Resolves with the decrypted VAS message; rejects on cancel or timeout. */
  read(options: { signal: AbortSignal }): Promise<{ message: string }>;
}

/** The shell injects `window.passbookNative.nfc`. On the web this returns null. */
export function detectNfcBridge(): NfcBridge | null;
```

- `NfcSource.start(emit)` exists only when `detectNfcBridge()` returns a bridge. A **Hold near** button in the bottom bar
  calls `read()`, and the result becomes `emit({ method: 'nfc', code: message })`. HIG wording: "hold near", never "tap"
  or "NFC" (R§2.1).
- A VTAP Cloud webhook to a paired scanner (R§5.1, Later) would be a fourth `InputSource`, reading a server event
  stream. It is not built.
- Nothing else changes when a bridge appears: the verdicts are shared (R§2.2.6).

---

## 3. The scan state machine

One reducer serves both postures. **Door posture**: the scanner's `flow` is `auto`, or the desk has a ready action
armed. A scan applies the action, then the verdict floods and auto-resumes. **Desk posture**: `flow` is `choose`. A scan
opens a member card, staff pick an action, and the verdict floods and settles into the card's band (UK§2.5-2.6).

### 3.1 Shape

```ts
// src/web/scan/machine/types.ts
export type Loop =
  | { s: 'ready'; since: number; hint: 0 | 1 | 2 | 3 }
  | { s: 'checking'; input: ScanInput; key: string; since: number; slow: boolean; next: ScanInput | null }
  | { s: 'member'; input: ScanInput; card: Card; since: number; band: ScanOutcome | null;
      picker: Draft | null; held: ScanInput | null; locked: boolean }
  | { s: 'reviewing'; input: ScanInput; card: Card; draft: Draft; held: ScanInput | null }
  | { s: 'applying'; input: ScanInput; card: Card | null; draft: Draft; key: string; since: number;
      slow: boolean; next: ScanInput | null }
  | { s: 'verdict'; input: ScanInput; card: Card | null; outcome: ScanOutcome; since: number;
      closeAt: number | null;      // auto-dismiss deadline; null = held until a tap
      settleAt: number | null;     // desk: when the flood settles into the card's band
      openFrom: number;            // from here a different code replaces the verdict
      next: ScanInput | null }
  | { s: 'paused'; reason: 'idle' | 'hidden' | 'camera_lost' };

export interface Draft { actionId: string; amount: number | null; value?: unknown; override?: boolean;
                         overrideOf?: string; confirmed?: boolean }

export type CameraStatus = 'off' | 'starting' | 'live' | 'blocked' | 'unavailable' | 'decoder_failed' | 'disabled';

export interface ScanState {
  loop: Loop;
  started: boolean;                  // the Start tap happened (audio, wake lock, camera)
  camera: CameraStatus;
  overlay: null | 'lookup' | 'camera' | 'recent' | 'settings' | 'shift';   // 'camera' = the desk iPad's dialog
  block: null | 'revoked' | 'suspended' | 'signed_out';                    // UD§4.5 full-screen panels
  posture: 'door' | 'desk';          // from the session's flow
  layout: 'handheld' | 'stand';      // UD§2.1, device preference
  armed: { actionId: string; amount: number | null; sticky: boolean } | null;  // UK§6.22 ready action
  scope: { key: string | null; direction: 'in' | 'out'; operator: string | null };  // UD§5.1 picks
  focused: boolean;
  online: boolean;
  unsure: Unsure[];                  // actions with no answer yet (v1)
  queue: { pending: number; oldestAt: number | null; conflicts: number };   // v2
  reader: { kind: 'none' | 'barcode' | 'nfc'; lastAt: number | null; badLayout: number };
  undo: { scanId: string; key: string; since: number } | null;
  ignore: Ignore[];                  // ≤ 20, pruned on every event
  recent: Recent[];                  // ≤ 20, newest first
  counts: Counts;
  prefs: { holdResults: boolean; sound: boolean };
  lastActivity: number;
}

export interface Ignore { sig: string; until: number; why: 'accepted' | 'refused' | 'shown'; headline?: string }
export interface Unsure { key: string; sig: string; passId?: string; draft: Draft; at: number;
                          state: 'retrying' | 'expired' }
```

The reducer is `reduce(state, event, deps: { now: number; id: () => string }): { state; cmds: Cmd[] }`. `now` and `id`
are inputs and are never read inside: AGENTS.md's "inject time and ids", applied to the client. The reducer is split by
concern so that each file stays under 300 lines: `reduce-read.ts`, `reduce-answer.ts`, `reduce-card.ts`,
`reduce-env.ts`, plus `reduce.ts` to dispatch.

### 3.2 Events and commands

```ts
export type ScanEvent =
  | { type: 'start' }                                     // the Start tap (UD§5.1)
  | { type: 'scope'; scope: Partial<ScanState['scope']> }
  | { type: 'camera'; status: CameraStatus }
  | { type: 'read'; input: ScanInput }
  | { type: 'answer'; key: string; outcome: ScanOutcome; replay?: boolean }
  | { type: 'fail'; key: string; error: FailCode; retryAfterMs?: number; requestId?: string }
  | { type: 'offline'; key: string; outcome: ScanOutcome }         // v2: the offline decision for a read
  | { type: 'pick'; actionId: string }                    // member → picker, reviewing or applying
  | { type: 'amount'; value: number | null }
  | { type: 'review' } | { type: 'confirm' } | { type: 'cancel' }
  | { type: 'switch' } | { type: 'keep' }                 // UK§6.27 "Another pass was scanned"
  | { type: 'override'; actionId: string }                // Let in again / Let in anyway (UD§5.3)
  | { type: 'arm'; actionId: string; amount: number | null; sticky: boolean } | { type: 'disarm' }
  | { type: 'undo'; scanId: string } | { type: 'undone'; key: string; outcome: ScanOutcome }
  | { type: 'dismiss' }                                   // Done, a tap on the flood, Esc
  | { type: 'tick' }                                      // a deadline from nextDeadline() passed
  | { type: 'visible'; visible: boolean } | { type: 'focus'; focused: boolean }
  | { type: 'online'; online: boolean }
  | { type: 'queue'; pending: number; oldestAt: number | null; conflicts: number }
  | { type: 'overlay'; open: ScanState['overlay'] }
  | { type: 'resume' }                                    // "Tap to scan"
  | { type: 'prefs'; prefs: Partial<ScanState['prefs']> }
  | { type: 'counts'; counts: Counts };

export type FailCode = 'network' | 'timeout' | 'server' | 'rate_limited' | 'revoked' | 'suspended'
                     | 'signed_out' | 'forbidden';

export type Cmd =
  | { c: 'resolve'; key: string; input: ScanInput }
  | { c: 'act'; key: string; input: ScanInput; draft: Draft | 'auto' }
  | { c: 'undo'; key: string; scanId: string }
  | { c: 'unsure.keep'; entry: Unsure } | { c: 'unsure.drop'; key: string }
  | { c: 'offline.decide'; key: string; input: ScanInput }            // v2
  | { c: 'camera'; op: 'start' | 'pause' | 'resume' | 'stop' | 'slow' }
  | { c: 'wake'; op: 'request' | 'release' }
  | { c: 'audio'; op: 'unlock' }
  | { c: 'sound'; tone: Tone }
  | { c: 'beat'; beat: BuddyBeat | 'cut' }
  | { c: 'announce'; text: string; polite: boolean }
  | { c: 'focus'; target: 'done' | 'region' | 'enter-code' | 'card-heading' | 'action' }
  | { c: 'chip'; chip: 'just_now' | 'already_open' | { same: string } }
  | { c: 'celebrate' };
```

`machine/store.ts` holds the state and runs `reduce`. It applies commands through injected `deps` (api, camera, sound,
buddy, announcer, unsure store, clock), and re-arms one `setTimeout` for `nextDeadline(state)`
(`machine/deadlines.ts`, pure). `useScanMachine()` reads the store with `useSyncExternalStore`. Tests drive `reduce`
directly, or the store with fake deps and a fake clock.

### 3.3 Outcomes and verdicts

```ts
// the server's outcome (AS§5.5, contracts/scan.ts), widened by client-only kinds
export type OutcomeKind = 'ok' | 'heads_up' | 'refused' | 'ready'   // from the server
                        | 'system' | 'queued';                       // client-only
export interface ScanOutcome {
  kind: OutcomeKind;
  reason: string | null;       // a server reason (AS§5.5), or a client one (below)
  action?: { id: string; label: string; kind: ActionKind };
  pass?: ScanPass;             // title, subtitle, template name, status, preview, flags
  previous?: { scanId: string; at: number; scannerName: string; location?: string; actionLabel?: string };
  cooldownRemainingMs?: number;
  value?: { before?: number; after?: number; of?: number; unit?: string };
  actions?: CardAction[];      // kind 'ready': the member card's actions
  flags?: string[];            // heads_up check_required: stop flags to confirm (C#10)
  scanId?: string; undoUntil?: number;
  counts?: Counts; milestone?: 'hundred' | 'all_in';
  replay?: boolean;            // the server replayed a stored outcome for this key (AS§6.6)
  requestId?: string; retryAfterMs?: number;
  local?: boolean;             // decided on the device
}
```

Client reasons:

- `system`: `network`, `timeout`, `unconfirmed`, `still_unconfirmed`, `server`, `rate_limited`;
- `refused`: `add_link`, plus a local `not_found`;
- `queued`: `saved_offline`.

UD and UK own the copy, in `src/shared/copy/scan.ts` (`SCAN_COPY`). The file is shared because the admin Sync log
titles the same reasons. A reason the client does not know (a newer server) renders as a refusal with a generic
headline and keeps working.

`machine/present.ts` (pure) turns `(outcome, posture)` into a `Presentation`: wash role, hold, tone, buddy beat,
live-region politeness, announcement and focus. It is one table, the only place these rules live:

| Kind | Wash (UD§3.1) | Door hold | Desk card hold | Opens from | Tone | Region | Focus |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `ok` | green | `OK_HOLD` 1200 | settles to the band after `OK_HOLD` | `NEXT_SCAN_AFTER_VERDICT` 600 | `ok` (`reward` on a milestone or a reward) | status | none |
| `queued` | green (UD§5.3) | `OK_HOLD` | — | 600 | `ok` | status | none |
| `heads_up` | amber | until a tap or a different code | until **Done** or a different code | 600 | `heads_up` | status | **Done** |
| `refused` | red | `REFUSED_HOLD` 3000; `ambiguous` holds until a tap (UD§5.3) | until **Done** or the next scan | 600 | `refused` | alert | none |
| `system` | slate | until a tap or any scan; `rate_limited` until `Retry-After` | settles to the band | 600 | `system` | alert | first action |
| `ready` | none: opens the member card, no flood (UK decision 2) | — | — | — | none | status (the title) | none |

With **Hold results until tapped** (`prefs.holdResults`), every `closeAt` is null and `CARD_IDLE_CLEAR` is off (UD§3.3,
UK§2.6).

### 3.4 Transitions

All constants live in `src/web/scan/timing.ts` as `SCAN_TIMING`, the union of UD§3.3 and UK§2.2:

```ts
export const SCAN_TIMING = {
  OK_HOLD: 1200, NEXT_SCAN_AFTER_VERDICT: 600, REFUSED_HOLD: 3000,
  SAME_CODE_ACCEPTED_IGNORE: 5000, SAME_CODE_REFUSED_IGNORE: 30000, CHIP: 1500,
  SPINNER_DELAY: 300, LOOKUP_TIMEOUT: 5000,
  HINT_AFTER: 4000, HINT_STEP: 4000, HINT_ACTIVE_WINDOW: 20000,
  IDLE_PAUSE: 60000, STREAM_RELEASE: 300000,
  FLOOD_SETTLE: 280, CARD_IDLE_CLEAR: 60000,
  UNDO_WINDOW: 600000, UNSURE_RETRY_EVERY: 10000, UNSURE_RETRY_WINDOW: 120000,
  READER_NO_READ_HINT: 8000, SEARCH_DEBOUNCE: 250,
  BEAT_DELAY: 150, BEAT_MAX: 700, COUNTS_POLL: 15000,
} as const;
```

`COUNTS_POLL` follows AS§8.2 (an idle scanner polls at most every 15 s). UD§3.3 asked for 10 s; every answer carries
the counts anyway.

**`read`, from any source, in every loop state.** First prune `ignore`. A read with `input.local` set skips the network
and enters `verdict` directly (2.2).

| Loop | Same `sig` as the input on screen or in flight | Different `sig`, ignored | Different `sig`, not ignored |
| --- | --- | --- | --- |
| `ready`, `paused` | — | chip `just_now`, or `{ same: headline }` for a refused code (UD§5.2) | enter `checking` (below); a paused camera stays paused until `resume` |
| `checking`, `applying` | drop | drop | keep as `next` (one slot, newest wins; UK§6.27) |
| `member`, no picker | chip `already_open` (UK§6.27) | chip | enter `checking`; the old band's Undo moves to the recent list |
| `member` with a picker, `reviewing` | chip `already_open` | chip | keep as `held`, cmd `sound heads_up`. The UI shows **Another pass was scanned** with **Switch** and **Keep editing** (UK§6.27) |
| `verdict` | chip `just_now` (R§2.1) | chip | before `openFrom`: keep as `next`. After: cmd `beat cut`, enter `checking` |

`system` verdicts also give way to the *same* code (UD§3.3: "the same code on system kinds replaces").

**Entering `checking`** with input `i`:

1. **Offline.** If `online` is false: in v2 with a fresh roster, cmd `offline.decide`. Otherwise go straight to verdict
   `system network` without a request (UK§6.24).
2. **Key.** If `unsure` holds an entry with the same `sig` or `passId` from the last `UNSURE_RETRY_WINDOW`, reuse its
   key: the server replays the original outcome instead of applying twice (AS§6.6, UD§5.2 "It won't count twice").
   Otherwise `key = i.id`.
3. **Commands.** `camera pause` if live; `beat lock` (camera) or `beat look` (others). Then the request:
   - door posture: `act { key, input: i, draft: armed ? { actionId: armed.actionId, amount: armed.amount } : 'auto' }`
     (AS§6.1: `actionId: 'auto'` resolves and applies in one round trip);
   - desk posture: `resolve { key, input: i }`.

   Each request carries `scope` (event or session key, direction, operator) and the device's `dayStart`.

**Deadlines.** `nextDeadline` returns the earliest one, and `tick` handles whichever has passed.

| Loop | Deadline | Effect |
| --- | --- | --- |
| `ready`, camera `live`, no overlay, `now - lastActivity < HINT_ACTIVE_WINDOW` | `since + HINT_AFTER + HINT_STEP × hint` | `hint += 1`, up to 3: **Move back a little**, the glare tip, **Won't scan? Tap Look up.** (UD§5.2) |
| `ready`, handheld, camera `live` | `lastActivity + IDLE_PAUSE` | enter `paused idle`; cmds `camera pause`, `beat sleep` |
| `ready`, stand, camera `live` | `lastActivity + IDLE_PAUSE` | cmd `camera slow` (4/s; UD§2.1 "never pauses") |
| `paused` | `since + STREAM_RELEASE` | cmd `camera stop` (WF§3, battery) |
| `ready`, reader configured | `max(lastActivity, reader.lastAt) + READER_NO_READ_HINT` | the no-read tip (UD§8.2, UK§2.2) |
| `checking`, `applying`, not `slow` | `since + SPINNER_DELAY` | `slow = true`; cmds `beat rummage`, `sound read` (the soft tick; UD§5.2) |
| `checking`, `applying` | `since + LOOKUP_TIMEOUT` | handled as `fail timeout` |
| `verdict` with `settleAt` | `settleAt` | enter `member` with `band = outcome` (UK§2.5) |
| `verdict` with `closeAt` | `closeAt` | enter `ready`, or enter `checking` with `next` |
| `verdict` with `next` | `openFrom` | enter `checking` with `next` |
| `member`, no picker | `lastActivity + CARD_IDLE_CLEAR` | enter `ready` (privacy; UK§2.2) |
| `unsure` retrying | `at + UNSURE_RETRY_WINDOW` | `state = 'expired'` (below) |

**`answer`** for the current `key`. Stale keys go to the late-answer rule.

- `ready` (the desk card): enter `member` with `card`; cmd `beat look`; announce the title politely.
- Any other kind: enter `verdict`, with `closeAt`, `settleAt` and `openFrom` from the `Presentation`. The commands are
  the tone, then `beat` after `BEAT_DELAY`, then the announcement and focus. A `milestone` adds `celebrate`. Then:
  - `ok`: add `{ sig, until: now + SAME_CODE_ACCEPTED_IGNORE }`, push to `recent`, take `counts`, and disarm a one-shot
    ready action;
  - `refused`: add `{ sig, until: now + SAME_CODE_REFUSED_IGNORE, headline }` (R§2.1, Admittee's 30 s);
  - `heads_up`: add `{ sig, why: 'shown' }`, which becomes `now + 5000` on dismiss;
  - `system`: no ignore entry, because scanning again is the remedy;
  - if the key was in `unsure`: cmd `unsure.drop`.

**Late answers** (an `unsure` retry that lands while the screen has moved on):

- If the loop still shows that input (`verdict` or `member` with the same `sig`), the late outcome replaces it, flood
  included (UK§6.24 "then it becomes the real outcome").
- Otherwise the matching `recent` row is updated with the late result and announced politely. Nothing interrupts the
  current scan (UD§11).

**`fail`** for the current `key`:

| Error | `checking` | `applying` |
| --- | --- | --- |
| `network`, `timeout` | Door (`act`, which may have applied): cmd `unsure.keep`, verdict `system unconfirmed`. In v2 with offline check-in: cmd `offline.decide` instead. Desk (`resolve`, nothing applied): verdict `system network` or `timeout` | cmd `unsure.keep`, verdict `system unconfirmed` |
| `server` | verdict `system server` with `requestId` | same |
| `rate_limited` | verdict `system rate_limited`; `closeAt = now + retryAfterMs` | same |
| `forbidden` | verdict `refused forbidden` | same |
| `revoked`, `suspended`, `signed_out` | `block` set; cmds `camera stop`, `wake release`; the UD§4.5 panel replaces everything. `revoked` also wipes local data (6.4) | same |

**`unsure` retries.** The store (not the reducer) re-sends each `retrying` entry with its original key and body: every
`UNSURE_RETRY_EVERY` while online, on `online`, and on `visible` (UK§6.24). When the window ends, the entry becomes
`expired`:

- its recent row reads **Still not confirmed**;
- if that pass's card is on screen, the band becomes `system still_unconfirmed` and `locked: true`. The card's actions
  stay disabled until it is reopened, so a second tap cannot double-apply under a new key (UK§6.24).

Expired entries stay in IndexedDB for the shift (6.4).

**Card actions** (desk; `reduce-card.ts`):

- **`pick`.** An action that needs an amount opens the picker (`picker = draft`; focus moves into it, UK§2.9). An
  action whose `confirm` is true, or with an amount above `confirmAbove`, goes to `reviewing` (UK decision 4). Anything
  else goes to `applying` with `key = id()` and cmd `act`.
- **`review`** goes from the picker to `reviewing`. **`confirm`** in `reviewing` goes to `applying` with a new key.
- **`cancel`** closes the picker, or goes from `reviewing` back to `member`.
- **`switch`** discards the draft and enters `checking` with `held`. **`keep`** drops `held`.
- **`override`** (door heads-up **Let in again**). It enters `applying` with
  `draft = { actionId, override: true, overrideOf: <the heads-up's key> }` and a **new** key. UD§5.3 said "the original
  `idempotencyKey`", but the server replays a stored key's outcome (AS§6.6), so the override needs its own key.
  `overrideOf` links the two.
- **`check_required`** heads-up (stop flags, AS§5.5). Its action re-sends the same draft with `confirmed: true` under a
  new key.
- **`arm` / `disarm`** set `armed` (UK§6.22). While armed, reads take the door path.
- **`undo`.** Sets `undo` and sends cmd `undo` with a new key. The `undone` event:
  - desk: a neutral band on the card with the new value, no flood (UK§6.14);
  - door: updates the recent row;
  - both: `sound undo`, a polite announcement, `beat rewind`.

**`dismiss`** in `verdict` enters `ready`, or `checking` with `next`, or `member` when a desk card is under the flood.
In `checking` and `applying` it does nothing: the request is in flight, and the flood must not claim success first
(R§2.3).

**`start`** (the Start tap). It runs synchronously inside the click handler, because audio needs the gesture
(R§5.8.2). It sets `started`, and sends cmds `audio unlock`, `wake request`, and `camera start` unless the camera is
`disabled` (a reader-only scanner; UD§5.1). On a stand the default camera is the front one, mirrored (UD D16).

**`camera`** status events:

- `live` sets `ready.since = now`, so the hint clock starts when the picture does.
- `blocked`, `unavailable` and `decoder_failed` show the camera panel. If the Start button had focus and disappeared,
  cmd `focus enter-code`. The loop stays `ready`, so the wedge and manual entry still work (D7).

**`visible false`** enters `paused hidden`, with cmds `camera pause` and `beat cut`; the system releases the wake lock.
**`visible true`** keeps `paused hidden` (**Tap to scan**, UD§5.2): the wake lock and audio need a gesture after
backgrounding (WF§6, WebKit 255363). A wedge read still goes through.

**`resume`** (a tap) enters `ready`, with cmds `wake request`, `audio unlock` and `camera resume` (or `start`, if the
stream was released or the track ended).

**`overlay`.** Opening one stops decoding (3.6) but leaves the loop alone. A read while an overlay is open still runs,
and the verdict closes the overlay. The desk's `camera` overlay is the exception: its first decode closes it 120 ms
after the read (UK§6.23).

### 3.5 The UX state names, mapped

| UD / UK / R§5.2 state | Machine |
| --- | --- |
| `start` | `started: false`; the Start panel |
| `aiming` (door), `idle` (desk iPad), `reader_ready` | `ready`; the posture, `camera` and `reader` pick the picture |
| `hint` | `ready.hint` 1-3 |
| detected / locked | the instant between a camera `read` and `checking`: cmd `camera pause` freezes the frame, then `beat lock` |
| `checking` (spinner after 300 ms) | `checking`, with `slow` |
| `member`, `picking`, `reviewing`, `applying` | `member`, `member.picker`, `reviewing`, `applying` |
| `ok`, `heads_up`, `refused` | `verdict` with that kind; the desk settles into `member.band` |
| `network`, timeout, server, rate limited | `verdict system <reason>` |
| `unsure`, still not confirmed | `verdict system unconfirmed`; `unsure` entries; `member.locked` |
| `queued` | `verdict queued` (v2) |
| `undoing` | `undo` set |
| `armed` | `armed` set |
| `lookup`, `multi_match` | `overlay: 'lookup'`; the panel owns its own query state |
| `camera_blocked`, `camera_unavailable` | `camera` status; the loop is unaffected |
| decoder failed to load | `camera: 'decoder_failed'` |
| `paused` | `paused idle`, `hidden` or `camera_lost` |
| `revoked`, org suspended, signed out | `block` |
| `shift_summary` | `overlay: 'shift'` |
| milestones | `outcome.milestone` → cmd `celebrate` |
| pairing | outside the machine: `boot/` shows the pairing view until the session says paired |

### 3.6 Derived values (`machine/derive.ts`, pure)

```ts
export const decodeActive = (s: ScanState, visible: boolean) =>
  visible && s.started && s.camera === 'live' && s.block === null &&
  s.loop.s === 'ready' && (s.overlay === null || s.overlay === 'camera');
export const pendingBadge = (s: ScanState, now: number) => ({
  n: s.queue.pending + s.unsure.filter((u) => u.state === 'retrying').length,
  late: s.queue.oldestAt !== null && now - s.queue.oldestAt > 600_000,   // amber after 10 min (R§5.5, UD§11)
});
export const readerChip = (s: ScanState) =>
  s.reader.kind === 'none' ? null : !s.focused ? 'paused' : s.reader.badLayout >= 3 ? 'layout' : 'ready';
```

---

## 4. Feedback wiring

### 4.1 Order of a verdict

This follows UD§3.4 and UK§5.1. In the frame of the `answer`: wash, icon, headline and the tone. The buddy beat starts
`BEAT_DELAY` (150 ms) later, Scandit's 150 ms (R§5.4). The announcement is set right after the DOM commit. Nothing waits
for motion. A new scan cuts the beat: `beat cut` removes `data-run`, so the buddy is at its rest pose at once.

### 4.2 Verdict and flood

- `ui/scan-verdict.tsx` (`ScanVerdict`, UK§2.1) is the one verdict component for both postures:
  - door: a full-bleed flood under the header (UD§2.5);
  - desk: a flood over the stage that settles into the card's 64 px band (UK§2.5).

  Motion follows the UX docs: transform and opacity only, and the reduced-motion blocks they give.
- A tap on the flood background (`event.target === event.currentTarget`) dispatches `dismiss`. A real **Done** button is
  always there for keyboard and VoiceOver users. Esc dismisses too.
- The hold rail (UD§3.4) is a `scaleX` animation whose duration is `closeAt - since`. It is hidden when `closeAt` is
  null.

### 4.3 Sound (`sound/`)

- `platform/audio-unlock.ts` creates the `AudioContext` once, inside the Start (and Resume) click handler, and calls
  `resume()` synchronously. It sets `navigator.audioSession.type = 'playback'` when the API exists, so the silent switch
  does not mute the scanner (R§5.4, UD§1) [U on iOS 26/27; it also pauses other audio on the device]. If
  `state === 'interrupted'` (a phone call), it resumes on the next tap.
- `sound/tones.ts` is data, UK§2.7's table: `ok`, `reward`, `heads_up`, `refused`, `system`, `undo`, `read`. `read`
  plays only from the `slow` deadline (UD§5.2's soft tick at 300 ms), never on every read. A fast answer then makes one
  sound, not two. UK§2.7 had it on every read.
- `sound/player.ts` (lazy, on Start) builds each tone from `OscillatorNode` and `GainNode`, with UK's attack and release
  values. No audio files, so no `media-src` change (PM§7 item 5).
- Sound is on by default and remembered per device (`passbook-scan-sound`).
- No haptics on iPhone (R§5.4). The client calls nothing and promises nothing.

### 4.4 Tokens

`src/web/scan/ui/verdict.css` is in the scan chunk only (UK§2.4). It defines the four washes and their text colours as
`--scan-ok`, `--scan-heads`, `--scan-refused`, `--scan-system`, each with an `-on` pair, from UD§3.1. They are the same
in both themes (UD D2). `ui/verdict.test.ts` computes each pair's contrast from `src/generated/resolved-tokens.ts` and
requires at least 4.5:1 (R§5.4). No hex values in components; any new colour goes in as a token.

---

## 5. Server calls

`src/web/scan/api/scan-api.ts` wraps the endpoints in AS§12. Schemas come from `src/shared/contracts/scan.ts`.

| Function | Endpoint (AS§12) | Client use |
| --- | --- | --- |
| `pairPreview(code)` | per UD§4.3; AS has `pair` only (section 13) | the confirm card's scanner name; consumes nothing |
| `pair(code)` | `POST /api/v1/scan/pair` | sets the cookie; returns `ScanSession` |
| `session(orgId?)` | `GET /api/v1/scan/session` | scanner or admin profile, org, mode, flow, templates with actions, formats, scope options, settings, `csrfToken`. Refetched on `visible`, on `online` and every 5 min |
| `resolve(body)` | `POST /api/v1/scan/resolve` | the desk card |
| `act(body)` | `POST /api/v1/scan/actions` | door scans, card actions, overrides |
| `undo(scanId, key)` | `POST /api/v1/scan/scans/{id}/undo` | Undo |
| `recent()` | `GET /api/v1/scan/scans?limit=20` | the recent list after a reload |
| `lookup(q)` | `GET /api/v1/scan/lookup` | 2.5 |
| `stats()` | `GET /api/v1/scan/stats` | `COUNTS_POLL` while idle and visible |
| `summary(since)` | `GET /api/v1/scan/summary` | end of shift |
| `signOut()` | `POST /api/v1/scan/sign-out` | Unpair |
| `batch(items)` | `POST /api/v1/scan/batch` | v2 sync |
| `roster(cursor)` | not in AS yet (section 13) | v2 |
| asset URLs | `GET /api/v1/scan/passes/{id}/assets/{name}` | the result card's pass; never a download token (PM§5) |

- The API client is `createApiClient({ getCsrfToken: () => session.csrfToken, onUnauthorized })` from `lib/api.ts`. The
  scanner cookie is `HttpOnly` (AS§2.2): script never reads it, and the CSRF secret comes from `session`.
- **Admin principal.** It adds `orgId` to every body (AS§2.5) and n6's `modeHeaders()` (`lib/mode.ts`), so Test mode
  follows the browser. A paired scanner never sends the mode header: its mode is bound on the server (PM§5).
- **Body.** `{ idempotencyKey, input: { code, method } | { passId, method: 'manual' }, actionId, amount?, override?,
  confirmed?, clientTs, dayStart, scope… }`. `dayStart` is the device's local midnight (AS§6.1).
- **Errors** map in `api/to-fail.ts`:

  | Response | `FailCode` |
  | --- | --- |
  | `ApiError` status 0 | `network` |
  | aborted after `LOOKUP_TIMEOUT` | `timeout` |
  | 401 on a scanner | `revoked` |
  | 401 on an admin session | `signed_out` |
  | 403 `ORG_SUSPENDED` | `suspended` |
  | 403 `SCAN_FORBIDDEN` | `forbidden` |
  | 429 | `rate_limited`, with `Retry-After` |
  | 5xx | `server`, with the problem's request id |
  | 409 `PASS_CONFLICT` | retried once with the same key (AS§6.6), then `server` |

---

## 6. Platform

### 6.1 Camera lifecycle (`camera/camera.ts`)

| Step | Behaviour | Source |
| --- | --- | --- |
| Permission check | On boot, `navigator.permissions?.query({ name: 'camera' })` where supported. `denied` shows the blocked panel before any tap, with Enter code (door) or Search (desk) as the main button. Never call `getUserMedia` before the Start tap | R§2.3, UXG STRICH `getCameraPermissionState` |
| Start | `getUserMedia({ audio: false, video: { facingMode: { ideal: layout === 'stand' ? 'user' : 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } } })`, or `deviceId: { exact }` when a camera was remembered. One long-lived stream | R§5.8.1-2, WF§3, UD D16 |
| Errors | `NotAllowedError` and `SecurityError` → `blocked`. `NotReadableError` and `AbortError` → `unavailable`. `NotFoundError` and `OverconstrainedError` → retry once with `{ video: true }`, then `unavailable` | R§5.2 panels |
| Lens | After the first grant, `enumerateDevices()`. `pick-camera.ts` prefers a back camera whose label matches `/back camera$/i` and not `/ultra\|wide\|tele\|dual\|triple/i`; it restarts on that camera once and remembers its `deviceId` (`passbook-scan-camera`). iOS localizes the labels, so the heuristic can miss. The remembered choice and Switch camera are the real fix | R§5.8.3, WF§3, WebKit 253186 |
| Switch camera | Cycles through every `videoinput` and remembers the choice. The front camera's preview is mirrored with `scale: -1 1`; decoding uses the unmirrored frame | UD§7.3 |
| Torch | Show the button only when `track.getCapabilities().torch` exists. Toggle it with `applyConstraints({ advanced: [{ torch }] })`, and keep our own on/off state (Safari 18.4 fixed a stale `getSettings()`). It works on iOS 17+ | C#1, UD§7.2 |
| Detected | The decode loop stops; `video.pause()` freezes the frame | R§2.1 |
| Resume | `video.play()`; the decode loop restarts. No new `getUserMedia` | UXG STRICH stop/start |
| Idle | Handheld: after 60 s, `paused idle`. Decoding stops and the preview dims through an opacity overlay (UD§5.2); the stream stays. After 5 min more, `track.stop()`. Stand: decoding drops to 4/s | R§5.2, WF§3, UD§2.1 |
| Hidden | `visibilitychange` to hidden stops decoding. On return, if `track.readyState === 'ended'` or the track is `muted`, the next Resume calls `getUserMedia` again | WF§3, WebKit 252465 |
| Track ended mid-session | `track.onended` → `paused camera_lost` | [I] |
| Leaving | `pagehide` stops every track | |

### 6.2 Wake lock (`platform/wake-lock.ts`)

`navigator.wakeLock.request('screen')` runs in the Start and Resume handlers. Listen for `release`. Never re-request
without a gesture (WebKit 255363). It works in Safari 16.4+, and in home-screen apps from iOS 18.4 (WF§6). There is no
NoSleep fallback: it is a looping-video hack and a new dependency. The live camera stream may keep the screen on anyway
[U].

### 6.3 Home screen on iOS

`public/scan.webmanifest`:

```json
{ "id": "/scan", "name": "PassBook Scan", "short_name": "Scan", "start_url": "/scan", "scope": "/scan",
  "display": "standalone", "background_color": "#060912", "theme_color": "#060912",
  "icons": [ "the three icons from manifest.webmanifest" ] }
```

The design accepts these iOS realities:

- **Camera permission does not persist across launches** of a home-screen app, and hash navigation re-prompts (WebKit
  215884, WF§3). So: one Start tap per launch, and no hash routing (1.2).
- **A home-screen app has its own cookie jar and storage, separate from Safari** [U: what iOS 17+ copies at install].
  So pairing happens inside the installed app, with the code typed or scanned by the app's own camera. A pairing link
  opened from Mail or the Camera app pairs Safari, not the app. `/admin/scanners`' pairing instructions say so
  (ux-admin); the scanner itself says nothing.
- **Wake Lock** works in home-screen apps only from iOS 18.4 (WF§6).
- **Storage.** Call `navigator.storage.persist()` the first time anything is written to IndexedDB. Whether the 7-day
  script-storage cap applies to home-screen apps is disputed (WF§7). The `unsure` entries are short-lived anyway, and
  the v2 queue shows a pending badge that turns amber after 10 min.
- **Status bar** `default`, as in the SPA (ux-principles "Head, icons and previews").
- **No install prompt** or banner in the scanner. Safari works.

### 6.4 Offline

**v1 (ships with the scanner): online only, honest.**

- Every request carries `idempotencyKey` (client UUIDv7), `clientTs` and `method` (R§5.6, AS§6.1).
- **Offline before sending** (`online` false). A read gives `system network` without a request (UK§6.24). Search and
  card actions are disabled, labelled **Waiting for connection**, through `mutationButton` (`lib/online.ts`).
- **No answer to an action** (a network error or `LOOKUP_TIMEOUT` after sending). The request may have reached the
  server, so it becomes an `Unsure` entry, retried with the same key (3.4). `offline/unsure-store.ts` mirrors the
  entries in IndexedDB, so a reload keeps them for the shift: `{ key, scannerId, sig, passId?, draft, body, at, state }`.
  `body` holds the code. No holder data is stored.
- A re-scan inside the window reuses the key, so the guest in front of staff gets the original answer, not "Already
  checked in" (UD§5.2).
- **Never queued:** stamps, points, `set` and `redeem` (R§5.6, UK§6.24).

**v2 (opt-in per scanner, check-in and check-out only; UD§11, AS§6.6 phase 5).**

- **Roster** (`offline/roster.ts`). Downloaded on Start and refreshed every 60 s while online, as a delta by cursor
  (UD§11). Entries: `{ h, status, in, eventKey }`, where `h` is the first 128 bits (32 hex) of SHA-256 of the scan
  code, and of the barcode message when that differs (the same digest as `passes.barcode_hash`, PM§5).
  - **No names, emails or titles** (R§4 rules 4 and 7). Offline verdicts show no holder (UD§5.3 `queued`).
  - Valid for 24 h; after that offline check-in turns off until a refresh.
  - Capped at 50,000 entries, about 2 MB in IndexedDB.
  - Cleared on Unpair and on a new event.
  - AS has no roster endpoint yet (section 13). If access design refuses it, v2 does not ship.
- **Decide** (`offline/decide.ts`, pure). It hashes the code with `crypto.subtle`, looks it up and follows UD§11's table
  exactly:

  | Roster | Verdict |
  | --- | --- |
  | Found, active, not in, not queued | `queued` (green). Set `in` locally and enqueue |
  | Already in (roster or queue) | heads-up already in, `previous.at` from local data; **Let in again** queues an override when allowed |
  | Voided or removed | refused, the same copy as online |
  | Not in the roster | refused `not_found`, with the offline sub |
  | No roster, or stale | `system network` |

- **Queue rows:** `{ key, code, method, clientTs, scope, override?, state: 'queued' }`.
- **Sync** (`offline/sync.ts`) posts to `batch`:
  - when: on `online`, on `visible`, every 15 s while rows remain (`navigator.onLine` lies, WF§7), after any successful
    request, and on **Sync now**;
  - how: batches of 50, oldest `clientTs` first, with backoff 2, 4, 8 … 60 s on failure;
  - a row leaves the queue only when the server returns its per-item outcome.

  iOS has no Background Sync, so the queue drains only while the page is open (R§5.6, WF§7). The pending badge shows
  that.
- **Conflicts.** A per-item heads-up (another door got there first) or refusal becomes an amber mark on the recent row,
  plus a count in the shift sheet (UD§11). Nothing interrupts the door. The holder title comes back in the sync reply
  and is never stored.

**v3: service worker.** `scan-sw.js`, scope `/scan`. A small Vite plugin builds it with the precache list (the scan
entry's hashed files plus the wasm).

- Navigation is network-first with a 3 s timeout, falling back to the cached `scan.html`.
- `/assets/*` is cache-first. `/api/*` is never cached.
- A new worker activates on the next launch: no `skipWaiting` mid-shift.
- It is registered only on scanners with offline check-in. UD§11 says that, until v3 ships, the admin setting warns
  that a reload offline fails.

**Wipe** (`offline/wipe.ts`) runs on `revoked`, on Unpair, and when the session's `scannerId` differs from the stored
one. It deletes the roster and the queue. Rows that belonged to another scanner are listed once in the shift sheet
with Discard; they cannot sync under a revoked credential.

### 6.5 IndexedDB (`offline/db.ts`)

Database `passbook-scan`, version 1, with these stores:

- `unsure` (keyPath `key`);
- `queue` (keyPath `key`, index `clientTs`);
- `roster` (keyPath `h`);
- `meta` (keyPath `k`): `scannerId`, `rosterCursor`, `rosterAt`.

The wrapper is about 60 lines of promises, with no `idb` dependency. Every access goes through the `UnsureStore`,
`QueueStore` and `RosterStore` interfaces. Each has an in-memory implementation for unit tests; the IndexedDB
implementation runs in e2e (real Chromium).

Every `catch` classifies (AGENTS.md: no silent catch):

- `QuotaExceededError` turns offline check-in off for the session and shows a shift-sheet line.
- Any other error disables persistence for the session. `unsure` retries continue in memory.

### 6.6 Per-device preferences (`platform/prefs.ts`)

`localStorage`. Blocked storage falls back to the defaults, as `lib/mode.ts` does. The keys:

| Key | Holds |
| --- | --- |
| `passbook-scan-sound` | sound on (default) or off |
| `passbook-scan-hold` | hold results until tapped |
| `passbook-scan-layout` | `handheld` or `stand`; the default comes from width (UD§2.1) |
| `passbook-scan-camera` | the camera's `deviceId` |
| `passbook-scan-camera-off` | reader-only device |
| `passbook-scan-reader-timing` | `standard` or `slow` |
| `passbook-scan-reader-focus` | `document` or `field` |
| `passbook-scan-shift` | shift start, scope and operator name (UD D6, UD§5.1) |

Device settings never sync to the server (UD§13). No codes, names or tokens go into `localStorage`. The operator name
is the staff member's own label, typed on the device.

---

## 7. Buddy, pass preview and kit reuse

### 7.1 One buddy

`buddy/scan-buddy.tsx` is `<ScanBuddy beat beatKey mood seat />` (UK§2.8). It renders `BuddyArt`
(`ui/art/buddy-art.tsx`, markup with no hooks) and calls `useRegisterBuddy()` (`ui/art/presence.ts`), so a toast shows a
check instead of the face. It does **not** use `Buddy` or `useScene`, which start a scene 700 ms after landing
(`ui/art/replay.ts`).

- **Immediate beats.** A new `beatKey` restarts the beat at once with `runScene()` from `ui/art/replay.ts`: attribute
  off, style flush, attribute on. A new beat cuts the old one. `beat="cut"` removes `data-run`, which leaves the CSS
  rest pose. Under reduced motion only the pose swaps (`data-mood`).
- **Mapping.** `buddy/beat-map.ts` (pure, tested) maps `(kind, reason, action kind, posture)` and the loop states to a
  beat and a mood, from B's table, UD§6 and UK§5.3. The beat names and their choreography belong to `buddy-motion.md`;
  the map only names them.
- **Seats.** UD D14 and UK§2.1 seat it on the viewfinder frame while aiming, and on the result card or stage card while
  a result shows. Under the flood, the viewfinder buddy hides the way a dialog hides the page's buddy. Two
  implementations are possible, and `buddy-motion.md` picks one:
  - **(a)** One instance portalled (`createPortal`) into whichever `data-buddy-seat` node is current. The entrance fall
    plays once per session; every later seat change is a cut plus a beat.
  - **(b)** Two instances, with the covered one hidden by the flood (`art-wallet.css`, the dialog rule).

  The client supports both: `ScanBuddy` takes a `seat` element, and presence counting already tolerates two.
- **Timing.** Every result beat lasts ≤`BEAT_MAX` (700 ms) and starts `BEAT_DELAY` after the verdict. Only the
  pending `rummage` and the NFC `rings` loop, and they are marked `.wl-essential` (B "Idle").
- **Budget.** `buddy/beats.css` ≤3 kB gzip, and props ≤16 SVG nodes (UK§2.8). `buddy/beats.test.ts` checks the size,
  that every beat ends by 700 ms (loops excepted) and that each ends on the rest pose. It reads the stylesheet the way
  `ui/art/art.test.tsx` does.
- **Lazy.** `ScanBuddy` loads after the first paint, inside `Suspense`, with a fixed-size empty seat, so there is no
  layout shift. The scanner works without it.

### 7.2 Celebrations and the shift

- `ui/celebrate.tsx` (`Celebrate when`) plays when an answer carries `milestone` (AS§8.2), once (motion doc Signature 9,
  UD§5.3).
- End of shift (`overlay: 'shift'`) shows `summary(since)` with the buddy's `count` scene, the one registry scene the
  scanner reuses (UK decision 12, UK§6.28).

### 7.3 Counters

The header chips use kit `CountUp`, which counts from the last value shown (motion doc "Numbers"). Counts arrive with
every answer and from the idle poll. The store keeps the newest by `asOf`, so a count never goes backwards.

### 7.4 The pass on the result card

`ui/result-pass.tsx` turns `ScanPass.preview` into a `PassView` with `normalize()` (`src/shared/pass-view`) and renders
`PassCardStage` with `still` (no tilt: the card is glanced at). The wrapper is `aria-hidden` and `inert`: the headline
and sub line already say who and what, and `PassCard`'s `.pc-void` overlay has its own `role="status"`, which would
announce twice.

Two shared changes are needed (section 9):

- `PassCard` gains `barcode={false}` (workstream b), so the card neither shows the code nor loads the encoder chunk.
  UK§9 calls it `hideBarcode`; b picks the name.
- `usePassView` moves from `admin/passes/pass-preview.tsx` into `src/web/pass-card/use-pass-view.ts`, so admin and
  scanner share it.

### 7.5 Kit reuse

| Need | Kit piece |
| --- | --- |
| Frame | `ui/layout/app-shell.tsx`: the scanner header as `bar`, `width="full"`, `holder={false}` (D9). New props: `flush` (main without gutters, a flex column filling `100dvh`) and `offlineBanner={false}` (D11). The n6 `band` slot holds `ModeBand` |
| Test mode | n6 `ui/layout/mode-band.tsx` and `mode-pill.tsx`, given the scanner's mode (needs a `mode` prop) |
| Buttons | `ui/button.tsx`: `lg` for verdict actions, `md` elsewhere, with the `busy` and `done` verbs. `ui/icon-button.tsx` in the bottom bar |
| Pairing | `CodeField`, moved from `portal/` to `ui/` with a `length` prop (UD§15.3); the hosted card from sign-in |
| Lookup, recent, settings | `ui/dialog.tsx` (a bottom sheet under 640), `ui/sheet.tsx`, `ui/input.tsx`, `ui/field.tsx`, `ui/list-row.tsx`, `ui/empty-state.tsx`, `ui/switch-row.tsx`, `ui/segmented-control.tsx`, `ui/status-pill.tsx` |
| Events | `ui/option-tile.tsx` (UD§5.1) |
| Undo errors | `toast.error` (`ui/toaster.tsx`) |
| Session ended (admin) | the UD§4.5 panel; its **Sign in** goes to `/login?next=/scan` |
| Errors | `ui/error-state.tsx` |

---

## 8. Structure

Everything under `src/web/scan/**` belongs to n8. The estimates keep each file under 300 lines (hard limit 330). Tests
sit beside the code.

```
scan.html                                  entry (root; integration wires the vite input)
public/scan.webmanifest
src/shared/copy/scan.ts                    SCAN_COPY: reason headlines and subs, shared with the admin Sync log
src/shared/contracts/scan.ts               schemas (shared with arch-server)
src/web/scan/
  main.tsx                    ~40   entry
  app.tsx                     ~90   providers; boot gate: session → pairing view, block panel or scanner
  timing.ts                   ~40   SCAN_TIMING (3.4)
  boot/
    use-scan-session.ts       ~90   session query, refetch rules, principal kind
    pair-view.tsx             ~200  PairCard: CodeField + Scan pairing code (UD§4.2)
    pair-confirm.tsx          ~90   UD§4.3
    pair-link.ts              ~40   read and strip #pair=
    admin-scope.tsx           ~150  Scan as admin: org pick (UD§4.4)
    block-panel.tsx           ~100  revoked, suspended, signed out (UD§4.5)
  machine/
    types.ts                  ~180  state, events, commands, outcome
    reduce.ts                 ~120  dispatch, prune, deadlines tick
    reduce-read.ts            ~200  the read table, entering checking
    reduce-answer.ts          ~220  answers, fails, late answers, unsure expiry
    reduce-card.ts            ~240  member, picker, reviewing, applying, override, arm, undo
    reduce-env.ts             ~160  start, camera, visibility, focus, online, overlay, prefs, scope, counts
    present.ts                ~160  Presentation table (3.3)
    ignore.ts                 ~60   (pure)
    deadlines.ts              ~100  nextDeadline (pure)
    derive.ts                 ~60
    store.ts                  ~160  createScanStore(deps): dispatch, command runner, timer, subscribe
    commands.ts               ~220  command executor over injected deps, unsure retry loop
    use-scan-machine.ts       ~40   useSyncExternalStore binding
    fixtures.test-support.ts  ~120  test state builders
  input/
    types.ts                  ~70
    bus.ts                    ~60
    normalize.ts              ~100
    us-keymap.ts              ~80
    wedge-detector.ts         ~150
    wedge-source.ts           ~150  window listener, preventDefault rules, field registry, human → lookup
    wedge-field.tsx           ~70   useWedgeField, ScanTextField
    nfc-bridge.ts             ~50
    nfc-source.ts             ~50
  camera/
    camera.ts                 ~230  CameraController
    pick-camera.ts            ~60   (pure)
    errors.ts                 ~40   (pure)
    frame-loop.ts             ~170
    roi.ts                    ~80   (pure)
    stability.ts              ~70   (pure)
    decoder.ts                ~60
    native-decoder.ts         ~50
    zxing-decoder.ts          ~150  worker client
    decode-worker.ts          ~80
    worker-protocol.ts        ~40
    fake-camera.test-support.ts ~90 test-only CameraController
  platform/
    audio-unlock.ts           ~60
    wake-lock.ts              ~50
    lifecycle.ts              ~60   visibility, focus, online → store events
    prefs.ts                  ~100
    persist.ts                ~20
  sound/
    tones.ts                  ~50   data (UK§2.7)
    player.ts                 ~70   synth (lazy)
  api/
    scan-api.ts               ~180
    to-fail.ts                ~60
  offline/
    db.ts                     ~70
    unsure-store.ts           ~120  v1
    hash.ts                   ~20
    wipe.ts                   ~50
    roster.ts                 ~160  v2
    decide.ts                 ~80   v2 (pure)
    queue-store.ts            ~100  v2
    sync.ts                   ~160  v2
    sw-register.ts            ~40   v3
  ui/
    scan-shell.tsx            ~170  ScanShell: AppShell, header, stage, bottom bar, live regions, container queries
    scan-header.tsx           ~150  name, CounterChip, ReaderChip, OfflineChip, PendingChip, Ready chip, menu
    viewfinder.tsx            ~220  video, reticle, lock box, hint pill, frozen frame, buddy seat
    start-panel.tsx           ~200  UD§5.1: events, direction, name, Start scanning
    camera-panel.tsx          ~110  CameraPanel: blocked, unavailable, decoder failed
    reader-stage.tsx          ~120  UD§8.2 NFC prompt and no-read tip
    bottom-bar.tsx            ~130
    scan-verdict.tsx          ~200  ScanVerdict: flood, band, hold rail, dismiss
    verdict-body.tsx          ~180  icon, headline, sub, meta, actions per outcome
    result-pass.tsx           ~70   (lazy chunk)
    recent-scans.tsx          ~200  RecentScans: rows, Undo, late results, conflicts
    settings-sheet.tsx        ~180
    shift-summary.tsx         ~120
    live-announcer.tsx        ~60   LiveAnnouncer: two regions; clear, then set 50 ms later (UK§2.9)
    chips.tsx                 ~80
    verdict.css               ~150
  lookup/
    lookup-panel.tsx          ~180  LookupPanel / LookupField
    lookup-results.tsx        ~120  LookupResults, MatchPicker
  desk/                             UK§9's files, in the desk chunk
    desk-layout.tsx, member-card.tsx, action-drawer.tsx, stepper.tsx, keypad.tsx, review.tsx,
    recent-rail.tsx           each ≤250
  buddy/
    scan-buddy.tsx            ~130  (lazy)
    beat-map.ts               ~100  (pure)
    beats.css                 ≤3 kB gzip
    props.tsx                 ~120
  dev/
    test-hook.ts              ~60   e2e source, dev builds only (10.6)
```

`knip.json` (foundation) gets entries for `scan.html` / `src/web/scan/main.tsx` and
`src/web/scan/camera/decode-worker.ts`. The `*.test-support.ts` names put the two test helpers under
`tools/check-sizes.ts`'s rule that production code never imports test-support modules.

---

## 9. Changes outside n8's ownership

| File | Owner | Change |
| --- | --- | --- |
| `vite.config.ts` | foundation / integration | second HTML input; `'!/scan'` in `VITE_DEV_PATHS`; v3 SW plugin; maybe split the `tanstack` chunk group |
| `tools/check-bundle.ts` | foundation | second budget for `scan.html` (`SCAN_BUDGET_BYTES = 150_000`); `routeTree` and `__passbookScan` in its forbidden markers |
| `public/_headers`, `src/worker/platform/security-headers.ts` | foundation | 1.4 |
| `wrangler.jsonc` `run_worker_first`, `tools/wrangler-config.test.ts` | integration | `!/scan.webmanifest`; v3 `!/scan-sw.js` (build-emitted) |
| `knip.json`, `package.json` | foundation | new entries; `zxing-wasm` `3.1.6` exact |
| `src/web/lib/guards.ts` | h0 | drop `/scan` from `isPublicPath` |
| `src/web/main.tsx` → `src/web/lib/chunk-reload.ts` | h0 | share the preload-error guard |
| `src/web/ui/layout/app-shell.tsx` | h0 | `flush` and `offlineBanner` props |
| `src/web/ui/layout/mode-band.tsx` | n6 | optional `mode` prop (defaults to `useMode()`) |
| `src/web/portal/code-field.tsx` → `src/web/ui/` | j, h0 | `length` prop (UD§15.3) |
| `src/web/pass-card/PassCard.tsx` and `Front` | b | optional barcode-off prop (SSR-safe) |
| `src/web/admin/passes/pass-preview.tsx` → `src/web/pass-card/use-pass-view.ts` | i, b | move `usePassView` |
| `e2e/**`, `playwright.config.ts` | integration | a scan project with the camera fake flags (10.6) |

---

## 10. Testing

Every `npm run check` gate applies: biome, sizes, knip, typecheck, tests and both bundle budgets.

### 10.1 Reducer (`machine/*.test.ts`, unit project, no DOM)

The tests are table-driven: `given state × event → expected state and cmds`. `fixtures` build states (`readyLive()`,
`verdict('ok')`, `memberWithPicker()` …) and a fake `id()` counter. Required cases:

- Every cell of the `read` table in 3.4. That includes replacing `next` (newest wins), `held` with Switch and Keep
  editing, `already_open`, the same-code chips, and `beat cut` on an interrupt.
- The same code within 5 s after `ok` gives the chip and no request; at 5001 ms it sends. Refused: 30 s, and the chip
  carries the headline.
- `checking` turns `slow` at 300 ms and sends `beat rummage` and `sound read` once. The timeout at 5000 ms follows the
  `fail timeout` row.
- Door network failure: `unsure.keep` and `system unconfirmed`. A re-read of the same code inside 2 min reuses the key;
  after 2 min it gets a new key. When the window expires, the card is `locked`.
- Desk resolve network failure: no `unsure` entry.
- Offline before sending: `system network` and no request.
- A late answer on screen replaces the verdict; off screen, it updates the recent row only.
- `heads_up` never closes on its own. `holdResults` holds every verdict and turns off `CARD_IDLE_CLEAR`. `ambiguous`
  holds. `rate_limited` closes at `Retry-After`.
- Door verdicts close; desk verdicts settle into `member.band` at `OK_HOLD` (`ok`, `system`). `heads_up` and `refused`
  hold on the card.
- `override` uses a new key and carries `overrideOf`; `check_required` re-sends with `confirmed`.
- `armed` sticky versus one-shot; armed reads take the door path.
- `dismiss` is ignored while `checking`.
- Hidden enters `paused hidden`, and visible keeps it paused. `resume` sends `wake request`, `audio unlock` and
  `camera resume`.
- Camera `blocked` while focus was on Start sends `focus enter-code`, and wedge reads still reach `checking`.
- Idle: handheld pauses at 60 s and stops the stream 5 min later; a stand slows down and never pauses.
- `revoked` sets `block`, stops the camera and releases the wake lock.
- Stale answer keys do nothing beyond the late-answer rule. An unknown reason renders as a refusal.
- **Property test** (hand-rolled, seeded, no new dependency). 2,000 random event sequences never produce two requests in
  flight for the loop, never close a `heads_up` on a timer, and always keep `ignore` and `recent` at 20 entries or fewer.
- `present.test.ts` covers every kind × posture row of 3.3.

### 10.2 Wedge (`input/wedge-detector.test.ts`, `wedge-source.test.ts`)

**Synthetic timelines** (detector):

| Input | Result |
| --- | --- |
| a 26-char code at 8 ms per key, then Enter | scan |
| the same at 120 ms per key (a human) | nothing; the first char gives `human` |
| a 3-char burst | nothing |
| 30 ms keys with a 200 ms gap in the middle | two bursts, neither accepted |
| 10 chars at 5 ms, no terminator, then 150 ms quiet | scan via idle |
| Shift between characters | ignored |
| a repeated key | reset |
| Tab as the terminator | scan, and `preventDefault` called |

- `WEDGE_SLOW` accepts 70 ms batches that `WEDGE_STANDARD` rejects.
- `us-keymap`: `code: 'KeyY'` with `key: 'z'` (German layout) yields `Y`; shifted digits and the numpad map too. Three
  bursts through the `key` fallback with characters outside the allowed set set `badLayout`.
- The method is `nfc` only with an NFC reader and a scan-code-shaped value.

**jsdom source tests:**

- A burst while a button has focus does not press it.
- A burst into the registered lookup field restores the field's previous value, keeps focus in the field and emits a
  scan.
- A burst into an unregistered input is ignored.
- A person typing "anna" into the lookup field is left alone.
- One slow key with nothing focused opens lookup with that character.

A guard test renders the scan app in each state and asserts that every `input` and `textarea` is registered.

### 10.3 Camera and decoder

- `pick-camera`, `errors`, `roi` and `stability` are pure and get unit tests.
- **Fake camera** (`camera/fake-camera.test-support.ts`). It implements the `CameraController` interface:
  `start()` resolves to a scripted status, and it adds `emitHit(text, format, box)` and `fail(error)`. Component tests
  use it to drive the viewfinder through live, blocked, unavailable, decoder failed, frozen, torch and mirrored states.
- **Decoder fixture test** (`camera/zxing-decoder.test.ts`, unit project, Node). It loads `zxing-wasm/reader` with the
  wasm from `node_modules` and decodes committed PNG fixtures to RGBA. The fixtures are generated once with the existing
  `shared/pass-view/barcode-svg.ts` encoders: a 26-char scan code as QR, PDF417, Aztec and Code 128, plus a rotated QR
  and a PDF417 at 2× module width. A zxing upgrade fails here first.
- **Frame loop**, with a fake decoder and a fake clock: never two frames in flight; at most 8 per second (4 when slow);
  it stops on a hit; it shrinks frames after slow decodes.

### 10.4 Components and axe (`web` project, jsdom, `vitest-axe`)

- Render `ScanShell` with a store in each state of 3.5, at phone, portrait-tablet and landscape container sizes, in
  light and dark. Assert:
  - no axe violations;
  - the live-region text and which region it lands in;
  - the focus target: **Done** on heads-up, the first action on `system`, the card heading after a lookup pick.
- The flood has a **Done** button and Esc dismisses. A click on the card does not dismiss.
- The camera preview and the buddy are `aria-hidden`. The pass preview is `aria-hidden` and `inert`.
- Lookup: the minimum length, the `@` rule, the 429 message, the 10-row cap, the masked email shown as given, and the
  offline line.
- `verdict.test.ts`: the four washes' text contrast is ≥4.5:1 (4.4).
- `beats.test.ts` (7.1). `beat-map.test.ts` covers every kind and every reason in `contracts/scan.ts`.
- `copy.test.ts`: every server reason in `contracts/scan.ts` has a `SCAN_COPY` entry.
- `kit-lint.test.ts` already applies (toasts, copying, formatting, motion tokens).

### 10.5 Offline

- `decide.test.ts` (pure): every row of the v2 table.
- `unsure-store.test.ts` and `queue-store.test.ts`, against the memory stores: lifecycle, window expiry, and the wipe on
  a scanner change.
- `sync.test.ts`, with a fake clock and a fake API: batches of 50, ordered by `clientTs`, backoff, per-item conflicts,
  and nothing deleted before the ack.

### 10.6 e2e (Playwright, `e2e/14-scan-*.spec.ts`)

- **Injected source.** `dev/test-hook.ts` is imported only under `if (import.meta.env.DEV)`; the e2e server runs
  `vite dev` (`tools/e2e-server.ts`). It acts only when the page was opened with
  `page.addInitScript(() => { window.__passbookScanTest = true })`. It then exposes
  `window.__passbookScan.read({ method, code })`, which calls `bus.emit`. Production builds drop the import by constant
  folding, and the scan bundle check forbids `__passbookScan`.
- **Real decoder path.** A second spec launches Chromium with `--use-fake-ui-for-media-stream
  --use-fake-device-for-media-stream --use-file-for-fake-video-capture=e2e/fixtures/scan-qr.y4m` and grants `camera`.
  Linux Chromium has no `BarcodeDetector`, so this runs the zxing worker, the CSP and the `.wasm` fetch end to end.
  `e2e/fixtures/make-y4m.ts` writes the y4m from an encoded QR of a seeded pass's scan code, with no ffmpeg needed.
- **Specs:**
  - pair a scanner from `/admin/scanners`, through the `#pair=` link, and land on `/scan`, with no code left in the URL;
  - Start, then a camera read checks in: green, and the counter reads 1;
  - the same code again within 5 s shows the chip, and the pass's Sync log gets no second event;
  - after 5 s, the same code gives heads-up with **Done** focused, and **Let in again** gives green;
  - a voided pass and a test pass on a live scanner are refused;
  - a wedge burst (`page.keyboard.type(code, { delay: 5 })` + Enter) checks in;
  - lookup by name picks a row;
  - undo from the recent list works;
  - `context.setOffline(true)` gives `system network` with no request;
  - an action whose response is aborted (`page.route` abort) becomes Not confirmed, and the retry after reconnect writes
    exactly one ledger event;
  - a desk scanner opens a card, adds a stamp through the keypad and review, and undoes it;
  - a revoked scanner shows the block panel.
- Each spec runs `@axe-core/playwright` on its main states, at 1180×820, 820×1180 and 390×844, in light and dark (UK§9).
  It also asserts the `/scan` response headers: the camera policy, and a CSP with `worker-src` and
  `wasm-unsafe-eval`.
- Reduced motion is already the e2e default (`playwright.config.ts`). One spec runs with motion on, to catch beat
  errors.

### 10.7 Device checks (manual, before release)

On iPhone (a Safari tab and the home-screen app) and iPad, on the current iOS, check:

- decode times for QR and PDF417 shown on another phone's screen (C "Still unverified": zxing-wasm decode times);
- the lens pick and the torch;
- the wake lock;
- audio with the silent switch on;
- a Socket S700 and a VTAP100 typing into the page, in document mode and then in field mode;
- the camera re-prompt on relaunch;
- pairing inside the home-screen app.

The results go in the n8 report.

---

## 11. Rollout

1. **Shell and inputs.** The entry, headers, session, pairing, reducer, wedge, lookup, door verdicts, sound, kit pieces
   and the v1 `unsure` path. Online only.
2. **Camera.** The controller, the worker decoder, lens pick, torch, idle and visibility rules, the fake camera and the
   y4m e2e.
3. **Desk.** The member card, pickers, keypad, review, ready action and undo bands.
4. **Buddy and polish.** `ScanBuddy`, beats, milestones and the shift summary.
5. **v2 offline check-in**, once the access design allows the roster and AS adds its endpoint. **v3 service worker**
   after it.
6. **NFC.** A VTAP needs nothing new in the client: the reader setting already maps wedge input to `method: 'nfc'`. The
   native bridge stays an interface until a native shell exists.

---

## 12. Risks and unverified points

- **Worker CSP on WebKit.** It is unknown whether a module worker takes the `/assets/*` policy or the document's. Both
  carry `'wasm-unsafe-eval'`, so either works. Verify on iOS with the production headers [U].
- **Serving `/scan`.** `/scan` → `scan.html` through the Worker-first asset fetch, and Vite dev's fallback [U]. An e2e
  check of the header and the body covers it.
- **zxing-wasm on iPhone.** Decode time and the PDF417 read rate are unknown [U] (C "Still unverified"). If PDF417 reads
  poorly, templates should prefer QR or Aztec (WF§4), which the designer can nudge. A commercial SDK (STRICH) stays the
  fallback.
- **Wedge readers on iOS.** Whether a reader's keystrokes reach Safari on iPad and iPhone without a focused field is
  unknown [U]. The field sink is the fallback.
- **Audio session.** Whether `navigator.audioSession.type = 'playback'` beats the silent switch on iOS 26/27 is unknown
  [U]. It may also pause music on the device.
- **Home-screen cookies.** What iOS copies from Safari into a home-screen app at install is unknown [U]. Pairing inside
  the app avoids depending on it.
- **The wasm on a slow line.** The wasm is 408 kB gzip. It is prefetched on the Start panel, but a first Start on 3G may
  wait a few seconds. Wedge and manual entry already work during that time.

## 13. Open questions

For the owner (genuinely theirs):

1. **Hardware for the device checks.** One VTAP100 (GBP 139) and one Bluetooth barcode reader, to verify wedge input in
   iPad and iPhone Safari (R§5.8, open question 2). Without them, wedge support ships untested on iOS.

For the Unify phase (decide there, not with the owner):

2. **Lookup as POST.** `lookup` moves `q` into a POST body, so a name never appears in a URL (AS§12 has GET).
3. **Pair preview.** AS adds `pair/preview` for UD§4.3's confirm card, which shows the scanner name without consuming
   the code.
4. **Roster.** AS adds the v2 roster endpoint (`GET /api/v1/scan/roster?cursor=`), if access design allows a hashed
   code roster on a device.
5. **One reason vocabulary.** UD's reasons (`already_in`, `wrong_day`, `not_open`, `event_ended`, `wrong_event`) and
   AS's (`already_done`, `not_yet_valid`, `session_closed`) need one list in `contracts/scan.ts`. The client only maps
   codes to copy.
6. **Scope.** UD's events (`scan.event`, `GET /scan/events`) versus AS's door sessions (`scan_sessions`). The Start
   panel lists whatever the session returns, and the client sends the chosen key back as opaque `scope`.
7. **Overrides.** An override needs a new idempotency key plus `overrideOf` (3.4), not the original key (UD§5.3).
