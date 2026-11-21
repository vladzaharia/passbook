# Web verifier integration

PassBook `/scan` implements this bridge in `src/web/scan/input/native-reader.ts`. Native barcodes enter its normal input bus and receive acceptance only after the authenticated check-in API returns `ok`. Encrypted VAS is refused with an error acknowledgement until server decryption is available.

For another verifier, copy `web/reader-client.js` into its assets. Native scans are another input to the same rules.

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
| App → web | `{version:1, event:'ready', nfc:boolean, ecp:false, diagnostics:boolean, appVersion:string, capabilities:object}` |
| App → web | `{version:1, event:'capabilities', capabilities:object}` |
| Web → app | `{version:1, op:'start'}` / `{version:1, op:'stop'}` (NFC only) |
| App → web | `{version:1, event:'scan', id:string, readAt:number, source:'apple-vas', passTypeIdentifier:string, cryptogram:string}` |
| App → web | `{version:1, event:'scan', id:string, readAt:number, source:'barcode', value:string}` |
| Web → app | `{version:1, op:'result', id:string, outcome:'accepted'|'rejected'|'error'}` |
| Web → app | `{version:1, op:'haptic', pattern:number[]}` |
| App → web | `{version:1, event:'timeout'}` |

`cryptogram` is standard Base64 of the VAS `9F27` value. `readAt` is the Android wall clock in milliseconds, useful for display, not authoritative freshness. Barcode values are bounded to 2048 characters without control characters. Without `scanAck` (below) a single scan may be pending and results expire after 15 seconds; the app then shows "Unverified · no decision received" and sends `timeout`. The same payload from the same source within 1500 ms is dropped; anything else is forwarded. Pausing/navigating invalidates pending results. The bundled diagnostics uses a local-only `captured` acknowledgement, which cannot grant acceptance.

`haptic` plays one verdict's feedback. `pattern` is on/off durations in milliseconds, starting with an on: at most 8 entries, each 0 to 500; anything else is dropped. The web sends it only when the capability snapshot has `haptics: true`, and uses `navigator.vibrate` otherwise. Android plays the waveform; iOS maps one pulse to an impact, two to a warning and three or more to an error notification.

`ready` retains its v1 top-level fields. Both events carry the same nested capability snapshot:

| Field | Android meaning |
| --- | --- |
| `platform`, `appVersion` | `"android"` and the native application version (at most 32 characters). |
| `camera.available`, `camera.permission` | A camera is currently enumerated (or a built-in camera is known when enumeration throws). Permission is `granted`, `denied`, `restricted`, `unavailable`, or `unknown` from the current OS state and observed permission results. Android cannot always distinguish a first request from permanent denial, so the app uses `unknown` rather than guessing. Reporting never requests permission. |
| `keyboard.supported`, `keyboard.connected`, `keyboard.connectionObservable` | `true`, `null`, `false`: keyboard-wedge input uses the OS text-input path, but Android cannot reliably identify a connected barcode wedge. Focus must be in the intended native or web input field. |
| `nfc.available`, `nfc.reading`, `nfc.formats` | `available` means NFC reader hardware is present and enabled; `reading` means native reader mode is active. Supported hardware reports `["wallet-vas"]`, including while NFC is disabled; no hardware reports `[]`. This implementation does not read NDEF. |
| `vas.deviceSupported`, `vas.available`, `vas.reader`, `vas.reason` | Native NFC hardware support is distinct from verification. `available` is always `false`: no dedicated backend verifier is integrated. `reader` is `"android-native"` when supported, otherwise `"none"`; `reason` explains the limitation. |
| `externalReader.mode`, `externalReader.connected` | `"keyboard"` and `null`; this does not claim a connected scanner or generic USB/Bluetooth serial support. |
| `haptics` | `true`: the app plays the `haptic` op. |
| `customerDisplay.supported`, `customerDisplay.available`, `customerDisplay.active` | All `false`; no customer-display integration is implemented. |
| `hardware` | Optional array, at most 16 entries: `{kind, id, name?, builtIn, connected, state, facing?, trigger?, reason?}`. `kind` is `camera`, `barcode`, `nfc`, `keyboard`, `usb`, `bluetooth`, `display`, `haptics` or `speaker`; `state` is `ready`, `active`, `off`, `needs-permission`, `unavailable` or `error`; `connected` is `true`, `false` or `null` (unknown). `id` is at most 64 characters and never a serial or MAC. `name` is the OS name, at most 80 characters; the web keeps it on the device. `reason` is at most 120 characters. Existing fields above are unchanged. See the per-kind table below. |

`hardware` entries on Android and iOS:

| Kind | Android | iOS |
| --- | --- | --- |
| `camera` | One per `CameraManager` camera, `facing` from `LENS_FACING` (`front`, `back`, `external`). `state`: `ready` when permission is granted, `needs-permission` otherwise, `unavailable` when restricted. | One per `AVCaptureDevice.DiscoverySession` video device, `facing` from `position`; `external` for external cameras. Same states from authorization. |
| `barcode` | Built-in reader, `builtIn:true`. A non-external, non-virtual keyboard-source `InputDevice` whose name or descriptor matches a scanner word (scanner, barcode, scan, honeywell, zebra, symbol, datalogic, urovo, newland, sunmi, chainway), or an installed vendor scanner service (Zebra DataWedge, Sunmi, Honeywell, Urovo, Newland) with `state:'ready'`. Listed once. `trigger:'unknown'`. | Not reported. |
| `nfc` | Present when the device has an adapter: `ready`, `active` while reading, or `off` with reason "NFC is off in Settings". | Present when `NFCReaderSession.readingAvailable`: `ready`, or `active` while reading. |
| `keyboard` | External, non-virtual keyboard-source `InputDevice` (a wedge scanner looks like one), `connected:true`. Below API 34 a device with a vendor id counts as external. | `GCKeyboard.coalesced` when a hardware keyboard or wedge scanner is connected, `connected:true`. |
| `usb` | `UsbManager` devices except hubs, `name` is the product name, `connected:true`. | Not reported. |
| `bluetooth` | Bonded HID peripherals, `connected:null`, only when `BLUETOOTH_CONNECT` is already granted (for example by device policy). The app never requests it. | Not reported. |
| `haptics`, `speaker` | Vibrator present; audio output feature present. | Haptics engine support; always a speaker. |
| `display` | Not reported. | Not reported. |

Android re-sends `capabilities` on input-device changes, USB attach and detach, NFC adapter changes and resume (debounced 200 ms). iOS re-sends it on keyboard connect and disconnect, and on the other changes above.

Vendor scan broadcasts: when a vendor scanner service is installed the app also listens for its scan intent and delivers reads as `{event:'scan', source:'barcode', value}`. A broadcast can come from any app, so a value only ever becomes a normal `barcode` scan: 1 to 2048 characters, no control characters, one read at a time and duplicates within two seconds dropped by `ScanGate`, exactly as for typed input. Receivers are registered `RECEIVER_EXPORTED`, which Android 13+ requires for broadcasts from other apps. The manual action and extra in Settings still work, and keyboard output keeps working through the input field.

| Vendor | Action and extra | Status |
| --- | --- | --- |
| Zebra DataWedge | `im.plrs.passbook.reader.action.SCAN`, string extra `com.symbol.datawedge.data_string` | Confirmed. The action is chosen in the profile, so the app sends `SET_CONFIG` once (action `com.symbol.datawedge.api.ACTION`, `CONFIG_MODE` `CREATE_IF_NOT_EXIST`, later versions `UPDATE`, no `RESET_CONFIG`) to create its own device-wide profile "PassBook Scanner" bound to this package: barcode input, Intent output as broadcast (`intent_delivery` 2), no intent category, keystroke output left at its default so the keyboard path remains a fallback. It asks for `SEND_RESULT`, stores a done flag only on `SUCCESS`, and logs a failure as `scan.datawedge_config_failed code=<RESULT_CODE>`. The profile stays after uninstall. Receivers also accept the `DEFAULT` category, which DataWedge may add. Not yet run on a Zebra device. [Result codes](https://techdocs.zebra.com/datawedge/latest/guide/api/resultinfo/), [tutorial (category left blank, Broadcast delivery)](https://techdocs.zebra.com/datawedge/latest/guide/api/tutorials/) [Set Config](https://techdocs.zebra.com/datawedge/latest/guide/api/setconfig/), [Intent output](https://techdocs.zebra.com/datawedge/latest/guide/output/intent/) |
| Sunmi | `com.sunmi.scanner.ACTION_DATA_CODE_RECEIVED`, string extra `data` | Confirmed. Broadcast output must be on (the default; mode switch is `com.sunmi.scanner.ACTION_BAR_DEVICES_SETTING`). [Scanner guide](https://file.cdn.sunmi.com/SUNMIDOCS/Barcode-Scanner-User-Guide-20201202.pdf) |
| Honeywell | `com.honeywell.sample.action.BARCODE_DATA`, `data` | Unverified, off. Honeywell has no fixed action: the app that claims the scanner chooses it (needs the `com.honeywell.decode.permission.DECODE` permission, which this app does not hold) and the sample string is documented as a placeholder. Use the manual action and extra in Settings. [Data Collection Intent API](https://support.honeywellaidc.com/servlet/fileField?entityId=ka02K000000cS1bQAE&field=File_1__Body__s) |
| Urovo | `android.intent.ACTION_DECODE_DATA`, `barcode_string` | Action and extra confirmed, service package names unverified, so off. Needs the scanner output mode set to intent (`WEDGE_KEYBOARD_ENABLE` 0). [ScanManager](https://en.urovo.com/developer/android/device/ScanManager.html) |
| Newland | `nlscan.action.SCANNER_RESULT`, `SCAN_BARCODE1` | Action and extra confirmed, service package names unverified, so off. Needs Output Mode "Output via API" in the scanner settings. [ScanDemo](https://github.com/NewlandAutoID/ScanDemo), [API handbook](https://d1bx683snmhtki.cloudfront.net/MobileTerminal/Newland_Android_PDA_API_Handbook.pdf) |

"Confirmed" means the vendor documentation was checked, not the sender: any app can send these broadcasts, so reads are bounded and still need a valid code at the server.

Unverified vendors are gated by the `unverifiedScanners` flag in `ReaderConfig` (shared preference `reader`/`unverifiedScanners`, default `false`, kept when Settings is saved). With it off they are neither registered nor listed in `hardware`.

Snapshots are sent at handshake, when NFC is started/stopped or its adapter changes, on activity pause/resume, and after camera permission results or camera availability callbacks. A new page must handshake again. The supplied `ReaderClient` keeps the legacy ready envelope in `reader.capabilities`; on an update it replaces `reader.capabilities.capabilities`, refreshes the legacy `nfc` boolean, and dispatches a `capabilities` event whose `detail` is the nested snapshot.

The capability snapshot contains no pass identifiers or encrypted data. For backwards compatibility only, the existing v1 `apple-vas` scan event still forwards the encrypted cryptogram to the explicitly configured trusted verifier page. PassBook's page rejects that event; do not send it through a generic scan-code API, write it to logs or analytics, or interpret capture as verification.

The handshake must run on each full page navigation. Web messaging requires Android System WebView support for `WEB_MESSAGE_LISTENER`. Upgrade WebView through your device management process if the app reports it unavailable.

The app also emits `{version:1, event:'cancelled'}` when opening native settings or pausing. The adapter clears pending requests on cancellation/timeout. `reader.result` returns `false` for an unknown, completed or cancelled scan; discard that decision in your web UI. Invalid outcome values throw. Subscribe to `timeout` and `cancelled` to clear the web result display.

## Wire format v2 (NFC tags)

v2 adds third-party NFC tags (`nfc-tag`). Everything in v1 stays. A v1 app keeps
v1: no tags, today's behaviour.

Handshake: the web sends `{version:2, op:'hello', versions:[1,2]}`. The app
answers `ready` with `version` set to the highest version it speaks. The web
sends every later message with that version.

| Direction | Message |
|-----------|---------|
| Web → app | `{version:2, op:'tagRead', id:string, prompt:string, timeoutMs:number}` |
| Web → app | `{version:2, op:'tagCancel', id:string}` |
| Web → app | `{version:2, op:'start'}` / `{version:2, op:'stop'}` with `formats:('wallet-vas'\|'tag')[]` |
| App → web | `{version:2, event:'scan', id:string, readAt:number, source:'nfc-tag', tag:{uid?:string, uidRandom:boolean, tech:'a'\|'b'\|'isodep'\|'unknown', ndef?:{type:'U'\|'T', value:string}}}` |

- `tagRead` is one read, at most 60000 ms. iOS opens the system sheet with
  `prompt`. Android arms reader mode for one tag. `tagCancel` ends it.
- `start` and `stop` take `formats` for continuous reading (Android). Without
  `formats` they mean `['wallet-vas']`, as in v1.
- `uid` is hex, 4, 7 or 10 bytes. `uidRandom` is true when the tag shows a random
  ID (4 bytes, first byte `0x08`); the server refuses it. `ndef.value` is at most
  1024 bytes. A read carries `uid` or `ndef`, never neither.
- The `scan` event is acknowledged with `result` as in v1. A tag scan is not
  accepted until the authenticated API answers.
- Capabilities: `nfc.formats` adds `tag-uid` and `tag-sun`. New `nfc.continuous`
  (boolean) is true when the app reads tags without `tagRead`.
- Android: a tag read ends a pending `tagRead`; a `tagRead` that times out ends
  with `{event:'cancelled', id}` (the `tagRead` id), which ends only that read and
  leaves any in-flight barcode check alone. VAS is tried first and a SELECT answer of `6A82`
  falls through to the tag read. The same tag read again within two seconds is
  dropped. A tag whose NDEF value is over 1024 bytes is sent with `uid` only.
- Tag data stays out of logs, analytics and URLs. The server stores a keyed hash
  of the UID, never the UID.

## Receipt acknowledgement (`scanAck`, additive, still v2)

A read used to hold the native gate until its verdict, so a second read during review was dropped silently. The web now acknowledges receipt separately.

| Direction | Message |
|-----------|---------|
| Web → app | `{version:2, op:'hello', versions:[1,2], features:['scanAck']}` |
| Web → app | `{version:n, op:'scanAck', id:string}` |

- `features` is an optional array of names (at most 8, each at most 32 characters). Each side ignores names it does not know, so this is not a version bump: the wire stays v2 and a v1 or older app sees an extra `hello` field it ignores.
- On every valid `scan` event the web posts `scanAck {id}` at once, before any verdict, then sends `result` as before. It sends the ack with the negotiated version.
- If the web advertised `scanAck`, the app's gate holds only until the ack, at most 2 s. After that the gate is free and the app shows "Verifier did not respond. Scan again." (no `timeout` event). The verdict is matched to its `id` later without blocking further reads. A read that arrives while the gate waits for an ack shows "Finish the current scan first."
- If the web did not advertise it, the app keeps the old behaviour: one read holds the gate until its `result` or 15 s.
- The web owns a read that arrives during review or while a result shows: the loop holds it (review), queues it (checking, result) or answers with a chip, and says so on screen. A read the page cannot take (not started, blocked) shows a notice and gets `result` `error`.
- An older Android app that predates this op shows "Verifier requested an unsupported reader operation." for each ack. Update the app with the web.

## Backend obligations

For Apple VAS, use the matching pass encryption private key to decrypt the cryptogram using the VAS ECDH/KDF/AES-GCM scheme. Validate the authenticated payload and timestamp, and map its opaque credential to the expected tenant and pass. Reject replayed cryptograms according to your policy; perform redemption/check-in changes atomically. Neither the Android `source` field, its request nonce, nor the reader timestamp authenticates a genuine reader or proves a fresh tap to the server.

Authenticate the operator/device and enforce its tenant, venue and operation permissions on the server. Pass identifiers and cryptograms must not enter access logs or analytics. Do not send download links, Apple web-service tokens or pass-signing keys as scan credentials. The web verifier's own authentication and authorization remain required.

Only the configured exact HTTPS origin and main frame can use the bridge. HTTPS identity-provider navigation is supported; NFC stops and pending results are invalidated on navigation. Other origins never receive the bridge. Test your actual OIDC/passkey flow on the P400; WebView identity-provider support varies. Bridge origin checks do not protect against an XSS in the trusted verifier itself.

Scanner broadcasts are untrusted input from local apps, just like keyboard entry. They grant no extra authority. Install only trusted apps on managed readers.
