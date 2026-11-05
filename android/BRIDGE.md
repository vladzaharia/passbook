# Web verifier integration

Copy `web/reader-client.js` into the verifier's assets. Keep your existing camera flow; native scans are another input to the same rules.

```js
import { ReaderClient } from './reader-client.js';

const reader = new ReaderClient();
reader.addEventListener('scan', async ({ detail: scan }) => {
  try {
    // Implement this in the verifier using its authenticated, tenant-scoped API.
    const decision = await verifyScan(scan);
    reader.result(scan.id, decision); // 'accepted', 'rejected', or 'error'
  } catch {
    reader.result(scan.id, 'error');
  }
});
reader.connect();
```

`verifyScan` is the integration point, not an endpoint included in this app. Show decisions in the web UI only if `reader.result` returns `true`. Do not display an old acceptance result for a subsequent scan.

## Wire format v1

Native object: `window.PassBookNative`. Send JSON strings with `postMessage`; receive JSON strings through `onmessage`.

| Direction | Message |
| --- | --- |
| Web → app | `{version:1, op:'hello'}` |
| App → web | `{version:1, event:'ready', nfc:boolean, ecp:false, diagnostics:boolean, appVersion:string}` |
| Web → app | `{version:1, op:'start'}` / `{version:1, op:'stop'}` (NFC only) |
| App → web | `{version:1, event:'scan', id:string, readAt:number, source:'apple-vas', passTypeIdentifier:string, cryptogram:string}` |
| App → web | `{version:1, event:'scan', id:string, readAt:number, source:'barcode', value:string}` |
| Web → app | `{version:1, op:'result', id:string, outcome:'accepted'|'rejected'|'error'}` |
| App → web | `{version:1, event:'timeout'}` |

`cryptogram` is standard Base64 of the VAS `9F27` value. `readAt` is the Android wall clock in milliseconds, useful for display, not authoritative freshness. Barcode values are bounded to 2048 characters without control characters. A single scan may be pending; results expire after 15 seconds. Repeated identical inputs are suppressed for two seconds. Pausing/navigating invalidates pending results. The bundled diagnostics uses a local-only `captured` acknowledgement, which cannot grant acceptance.

The handshake must run on each full page navigation. Web messaging requires Android System WebView support for `WEB_MESSAGE_LISTENER`. Upgrade WebView through your device management process if the app reports it unavailable.

The app also emits `{version:1, event:'cancelled'}` when opening native settings or pausing. The adapter clears pending requests on cancellation/timeout. `reader.result` returns `false` for an unknown, completed or cancelled scan; discard that decision in your web UI. Invalid outcome values throw. Subscribe to `timeout` and `cancelled` to clear the web result display.

## Backend obligations

For Apple VAS, use the matching pass encryption private key to decrypt the cryptogram using the VAS ECDH/KDF/AES-GCM scheme. Validate the authenticated payload and timestamp, and map its opaque credential to the expected tenant and pass. Reject replayed cryptograms according to your policy; perform redemption/check-in changes atomically. Neither the Android `source` field, its request nonce, nor the reader timestamp authenticates a genuine reader or proves a fresh tap to the server.

Authenticate the operator/device and enforce its tenant, venue and operation permissions on the server. Pass identifiers and cryptograms must not enter access logs or analytics. Do not send download links, Apple web-service tokens or pass-signing keys as scan credentials. The web verifier's own authentication and authorization remain required.

Only the configured exact HTTPS origin and main frame can use the bridge. HTTPS identity-provider navigation is supported; NFC stops and pending results are invalidated on navigation. Other origins never receive the bridge. Test your actual OIDC/passkey flow on the P400; WebView identity-provider support varies. Bridge origin checks do not protect against an XSS in the trusted verifier itself.

Scanner broadcasts are untrusted input from local apps, just like keyboard entry. They grant no extra authority. Install only trusted apps on managed readers.
