# Web verifier integration

PassBook `/scan` implements this bridge in `src/web/scan/input/native-reader.ts`. Native barcodes enter its normal input bus and receive acceptance only after the authenticated check-in API returns `ok`. Encrypted VAS is refused with an error acknowledgement; no VAS verification is integrated.

For another verifier, copy `web/reader-client.js` into its assets. Native scans are another input to the same rules.

```js
import { ReaderClient } from './reader-client.js';

const reader = new ReaderClient();
reader.addEventListener('scan', async ({ detail: scan }) => {
  if (scan.source !== 'barcode') {
    reader.result(scan.id, 'error'); // Legacy encrypted VAS is not verified by this integration.
    return;
  }
  try {
    // Implement this in the verifier using its authenticated, tenant-scoped API.
    const decision = await verifyBarcode(scan.value);
    reader.result(scan.id, decision); // 'accepted', 'rejected', or 'error'
  } catch {
    reader.result(scan.id, 'error');
  }
});
reader.connect();
```

`verifyBarcode` is the integration point, not an endpoint included in this app. Show decisions in the web UI only if `reader.result` returns `true`. Do not display an old acceptance result for a subsequent scan.

## Wire format v1

Native object: `window.PassBookNative`. Send JSON strings with `postMessage`; receive JSON strings through `onmessage`.

| Direction | Message |
| --- | --- |
| Web → app | `{version:1, op:'hello'}` |
| App → web | `{version:1, event:'ready', nfc:boolean, ecp:false, diagnostics:boolean, appVersion:string, capabilities:object}` |
| App → web | `{version:1, event:'capabilities', capabilities:object}` |
| Web → app | `{version:1, op:'start'}` / `{version:1, op:'stop'}` (NFC only) |
| App → web | `{version:1, event:'scan', id:string, readAt:number, source:'apple-vas', passTypeIdentifier:string, cryptogram:string}` |
| App → web | `{version:1, event:'scan', id:string, readAt:number, source:'barcode', value:string}` |
| Web → app | `{version:1, op:'result', id:string, outcome:'accepted'|'rejected'|'error'}` |
| App → web | `{version:1, event:'timeout'}` |

`cryptogram` is standard Base64 of the VAS `9F27` value. `readAt` is the Android wall clock in milliseconds, useful for display, not authoritative freshness. Barcode values are bounded to 2048 characters without control characters. A single scan may be pending; results expire after 15 seconds. Repeated identical inputs are suppressed for two seconds. Pausing/navigating invalidates pending results. The bundled diagnostics uses a local-only `captured` acknowledgement, which cannot grant acceptance.

`ready` retains its v1 top-level fields. Older v1 APKs omit `capabilities`; clients must continue to accept those ready messages. On current APKs both events carry the same nested capability snapshot:

| Field | Android meaning |
| --- | --- |
| `platform`, `appVersion` | `"android"` and the native application version (at most 32 characters). |
| `camera.available`, `camera.permission` | A camera is currently enumerated (or a built-in camera is known when enumeration throws). Permission is `granted`, `denied`, `restricted`, `unavailable`, or `unknown` from the OS state and observed permission results. Android cannot always distinguish a first request from permanent denial, so the app uses `unknown` rather than guessing. Reporting never requests permission. Camera capture remains the web page's `getUserMedia` flow. |
| `keyboard.supported`, `keyboard.connected`, `keyboard.connectionObservable` | `true`, `null`, `false`: keyboard-wedge input uses the OS text-input path, but Android cannot reliably identify a connected barcode wedge. Focus must be in the intended native or web input field. |
| `nfc.available`, `nfc.reading`, `nfc.formats` | `available` means NFC reader hardware is present and enabled; `reading` means native reader mode is active. Supported hardware reports `["wallet-vas"]`, including while NFC is disabled; no supported reader reports `[]`. This implementation does not read NDEF. |
| `vas.deviceSupported`, `vas.available`, `vas.reader`, `vas.reason` | Native NFC reader support is distinct from verification. `available` is always `false`: no dedicated backend verifier is integrated. `reader` is `"android-native"` when supported, otherwise `"none"`; `reason` explains the limitation. |
| `externalReader.mode`, `externalReader.connected` | `"keyboard"` and `null`; this does not claim a connected scanner or generic USB/Bluetooth serial support. |
| `customerDisplay.supported`, `customerDisplay.available`, `customerDisplay.active` | All `false`; no customer-display integration is implemented. |

Snapshots are sent at handshake, when NFC is started/stopped or its adapter changes, on activity pause/resume, and after camera permission results or camera availability callbacks. A new page must handshake again. The supplied `ReaderClient` keeps the legacy ready envelope in `reader.capabilities`; on an update it replaces `reader.capabilities.capabilities`, refreshes the legacy `nfc` boolean, and dispatches a `capabilities` event whose `detail` is the nested snapshot.

The capability snapshot contains no pass identifiers or encrypted data. For backwards compatibility only, the existing v1 `apple-vas` scan event still forwards the encrypted cryptogram to the explicitly configured trusted verifier page. PassBook's page rejects that event; do not send it through a generic scan-code API, write it to logs or analytics, or interpret capture as verification.

The handshake must run on each full page navigation. Web messaging requires Android System WebView support for `WEB_MESSAGE_LISTENER`. Upgrade WebView through your device management process if the app reports it unavailable.

The app also emits `{version:1, event:'cancelled'}` when opening native settings or pausing. The adapter clears pending requests on cancellation/timeout. `reader.result` returns `false` for an unknown, completed or cancelled scan; discard that decision in your web UI. Invalid outcome values throw. Subscribe to `timeout` and `cancelled` to clear the web result display.

## Backend obligations

For Apple VAS, use the matching pass encryption private key to decrypt the cryptogram using the VAS ECDH/KDF/AES-GCM scheme. Validate the authenticated payload and timestamp, and map its opaque credential to the expected tenant and pass. Reject replayed cryptograms according to your policy; perform redemption/check-in changes atomically. Neither the Android `source` field, its request nonce, nor the reader timestamp authenticates a genuine reader or proves a fresh tap to the server.

Authenticate the operator/device and enforce its tenant, venue and operation permissions on the server. Pass identifiers and cryptograms must not enter access logs or analytics. Do not send download links, Apple web-service tokens or pass-signing keys as scan credentials. The web verifier's own authentication and authorization remain required.

Only the configured exact HTTPS origin and main frame can use the bridge. HTTPS identity-provider navigation is supported; NFC stops and pending results are invalidated on navigation. Other origins never receive the bridge. Test your actual OIDC/passkey flow on the P400; WebView identity-provider support varies. Bridge origin checks do not protect against an XSS in the trusted verifier itself.

Scanner broadcasts are untrusted input from local apps, just like keyboard entry. They grant no extra authority. Install only trusted apps on managed readers.
