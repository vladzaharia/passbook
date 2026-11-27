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
| `nfc.available`, `nfc.reading`, `nfc.formats` | `available` means NFC reader hardware is present and enabled; `reading` means native reader mode is active. Supported hardware reports `["wallet-vas"]`, including while NFC is disabled; no hardware reports `[]`. With bridge v2 it also reads third-party tags (`tag-uid`, `tag-sun`; see below). |
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

Android re-sends `capabilities` on input-device changes, USB attach and detach, NFC adapter changes and resume (input-device, USB, Bluetooth bond and camera-availability changes are debounced 200 ms). iOS re-sends it on keyboard connect and disconnect, and on the other changes above.

Vendor scan broadcasts: when a vendor scanner service is installed the app also listens for its scan intent and delivers reads as `{event:'scan', source:'barcode', value}`. A broadcast can come from any app, so a value only ever becomes a normal `barcode` scan: 1 to 2048 characters, no control characters, one read at a time and duplicates within two seconds dropped by `ScanGate`, exactly as for typed input. Receivers are registered `RECEIVER_EXPORTED`, which Android 13+ requires for broadcasts from other apps. The manual action and extra in Settings still work, and keyboard output keeps working through the input field.

| Vendor | Action and extra | Status |
| --- | --- | --- |
| Zebra DataWedge | `im.plrs.passbook.reader.action.SCAN`, string extra `com.symbol.datawedge.data_string` | Confirmed. The action is chosen in the profile, so the app sends `SET_CONFIG` once (action `com.symbol.datawedge.api.ACTION`, `CONFIG_MODE` `CREATE_IF_NOT_EXIST`, later versions `UPDATE`, no `RESET_CONFIG`) to create its own device-wide profile "PassBook Scanner" bound to this package: barcode input, Intent output as broadcast (`intent_delivery` 2), no intent category, keystroke output off (profile version 2 adds the KEYSTROKE plugin with `keystroke_output_enabled` false through `UPDATE`, so one scan is not delivered twice; version 1 left it on). It asks for `SEND_RESULT`, stores a done flag only on `SUCCESS`, and logs a failure as `scan.datawedge_config_failed code=<RESULT_CODE>`. The profile stays after uninstall. Receivers also accept the `DEFAULT` category, which DataWedge may add. Not yet run on a Zebra device. [Result codes](https://techdocs.zebra.com/datawedge/latest/guide/api/resultinfo/), [tutorial (category left blank, Broadcast delivery)](https://techdocs.zebra.com/datawedge/latest/guide/api/tutorials/) [Set Config](https://techdocs.zebra.com/datawedge/latest/guide/api/setconfig/), [Intent output](https://techdocs.zebra.com/datawedge/latest/guide/output/intent/) |
| Sunmi | `com.sunmi.scanner.ACTION_DATA_CODE_RECEIVED`, string extra `data` | Confirmed. Broadcast output must be on (the default; mode switch is `com.sunmi.scanner.ACTION_BAR_DEVICES_SETTING`). [Scanner guide](https://file.cdn.sunmi.com/SUNMIDOCS/Barcode-Scanner-User-Guide-20201202.pdf) |
| Honeywell | `com.honeywell.sample.action.BARCODE_DATA`, `data` | Unverified, off. Honeywell has no fixed action: the app that claims the scanner chooses it (needs the `com.honeywell.decode.permission.DECODE` permission, which this app does not hold) and the sample string is documented as a placeholder. Use the manual action and extra in Settings. [Data Collection Intent API](https://support.honeywellaidc.com/servlet/fileField?entityId=ka02K000000cS1bQAE&field=File_1__Body__s) |
| Urovo | `android.intent.ACTION_DECODE_DATA`, `barcode_string` | Action and extra confirmed, service package names unverified, so off. Needs the scanner output mode set to intent (`WEDGE_KEYBOARD_ENABLE` 0). [ScanManager](https://en.urovo.com/developer/android/device/ScanManager.html) |
| Newland | `nlscan.action.SCANNER_RESULT`, `SCAN_BARCODE1` | Action and extra confirmed, service package names unverified, so off. Needs Output Mode "Output via API" in the scanner settings. [ScanDemo](https://github.com/NewlandAutoID/ScanDemo), [API handbook](https://d1bx683snmhtki.cloudfront.net/MobileTerminal/Newland_Android_PDA_API_Handbook.pdf) |

Broadcast hardening, per vendor. The receiver has to be exported because the sender is the vendor's own app, so it cannot be limited with `exported=false`. Instead it is registered only while the activity is resumed, accepts at most 4 broadcast reads per second (excess is dropped and logged as `scan.broadcast_rate_limited`), bounds each value, and shares the 1500 ms same-payload dedupe with keyboard input. On API 34+ a broadcast with no sender package logs `scan.broadcast_unattributed`; it is not refused, because vendor services are not known to set one. The read's origin stays inside the app: the wire `method` enum has no broadcast value, so the server sees a normal `barcode` scan.

- Zebra DataWedge: no sender permission is documented, and broadcast delivery cannot target a component, so the profile uses broadcast (`intent_delivery` 2) with the app's own action. Delivery to an explicit component (`startActivity` or `startService`) is possible but not confirmed on a device; it is not used. The DataWedge result receiver ignores an API 34+ result that names another package.
- Sunmi: no sender permission is documented. Same hardening as above.
- Honeywell: the decode service is protected by `com.honeywell.decode.permission.DECODE`, held by the claiming app, not required of a receiver. Unverified and off.
- Deployment: allow-list installed apps through MDM; a broadcast is as trusted as keyboard entry.

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

## Scan gate (v2 addendum)

- `hello` may carry `features:string[]`. The web sends `['scanAck']` when it
  posts `{version, op:'scanAck', id}` as soon as it receives a native `scan`.
- The app advertises `features:['scanAck']` as a top-level field of `ready` and `capabilities`, outside `capabilities`. The web sends `scanAck` only when it saw it.
- The app answers every `hello` with `ready` (current snapshot), also a repeat
  one on the same page. The version and features are those of the latest
  `hello`.
- With `scanAck` the app holds the next scan only until the ack, at most 2 s,
  and sends no `timeout` after that. Without it, the app holds until `result`
  (15 s, then `timeout`) as before.
- The app drops the same payload from the same source within 1500 ms. A tag
  read the web asked for with `tagRead` is never dropped. There is no scan
  queue: a read arriving while the gate is held (waiting for the ack) shows
  "Finish the current scan first." and is not forwarded. Queuing happens in the
  web page, not here. Up to 16 acknowledged reads await their verdict.
- Additive event `{event:'busy', id?:string}`: a `tagRead` (with its `id`) was
  refused because a read is in flight, or the scan queue is full. It does not
  cancel the pending check. A web that does not know `busy` ignores it.
  `cancelled` keeps its meaning: the read ended without a result.

### `scanSettle` (additive, still v2)

- Both sides list `scanSettle` in `features` (web in `hello`, app in `ready` and
  `capabilities`). The web sends the ops below only when the app listed both
  `scanAck` and `scanSettle`. `android/web/reader-client.js` (third-party
  adapter) does not list it and never sends them.
- `{version:2, op:'revise', id, outcome:'accepted'|'rejected'|'error'}`: a
  correction to a read that already got `result`. The status line changes only
  when `id` is the read delivered last and the latest one answered. No buzz, no
  gate change.
- `{version:2, op:'dropped', id, reason:'duplicate'|'replaced'|'closed'}`: the
  page ended the read without a verdict. The app releases the id once and, only
  when it is the read delivered last, shows "Already scanned", "Skipped" or the
  idle text. An unknown reason reads as `closed`. No buzz.
- Status text is written only for the read delivered last. A `result`,
  `revise` or `dropped` for an older id finishes silently; unknown or already
  released ids are ignored.
- Every `hello` resets the gate and the delivered and answered ids, and records
  whether the page listed `scanSettle`.
- When the page listed `scanSettle` it buzzes itself (a v2 `haptic`) and the app
  adds no native buzz on `result`. For a page without it the app keeps its
  100 ms buzz on `result`.

## Receipt acknowledgement (`scanAck`, additive, still v2)

A read used to hold the native gate until its verdict, so a second read during review was dropped silently. The web now acknowledges receipt separately.

| Direction | Message |
|-----------|---------|
| Web → app | `{version:2, op:'hello', versions:[1,2], features:['scanAck']}` |
| Web → app | `{version:n, op:'scanAck', id:string}` |

- Both sides advertise, and acks happen only when both do. The app lists `features:['scanAck']` as a top-level field of every `ready` and `capabilities` event, beside `capabilities`, never inside the snapshot (the web validates the snapshot strictly). The web sends `scanAck` only after the app advertised it, so an older app never sees the op. An older web ignores the extra event field and keeps the snapshot.
- `features` is an optional array of names (at most 8, each at most 32 characters). Each side ignores names it does not know, so this is not a version bump: the wire stays v2 and a v1 or older app sees an extra `hello` field it ignores.
- On every valid `scan` event, when the app advertised `scanAck`, the web posts `scanAck {id}` at once, before any verdict, then sends `result` as before. It sends the ack with the negotiated version.
- If the web advertised `scanAck`, the app's gate holds only until the ack, at most 2 s. After that the gate is free and the app shows "Verifier did not respond. Scan again." (no `timeout` event). The verdict is matched to its `id` later without blocking further reads. A read that arrives while the gate waits for an ack shows "Finish the current scan first."
- If the web did not advertise it, the app keeps the old behaviour: one read holds the gate until its `result` or 15 s.
- The web owns a read that arrives during review or while a result shows: the loop holds it (review), queues it (checking, result) or answers with a chip, and says so on screen. A read the page cannot take (not started, blocked) shows a notice and gets `result` `error`.
- An app that does not advertise `scanAck` gets today's behaviour: no ack, gate held until the verdict.

## Backend obligations

For Apple VAS, use the matching pass encryption private key to decrypt the cryptogram using the VAS ECDH/KDF/AES-GCM scheme. Validate the authenticated payload and timestamp, and map its opaque credential to the expected tenant and pass. Reject replayed cryptograms according to your policy; perform redemption/check-in changes atomically. Neither the Android `source` field, its request nonce, nor the reader timestamp authenticates a genuine reader or proves a fresh tap to the server.

Authenticate the operator/device and enforce its tenant, venue and operation permissions on the server. Pass identifiers and cryptograms must not enter access logs or analytics. Do not send download links, Apple web-service tokens or pass-signing keys as scan credentials. The web verifier's own authentication and authorization remain required.

Only the configured exact HTTPS origin and main frame can use the bridge. In-app navigation is limited to that origin and PassBook hosts (`passbook.mobile`, `wallet.plrs.im` and their subdomains); any other link opens in the browser, so identity-provider sign-in that leaves those hosts runs in the browser, not the reader. Settings open on press and hold; saving a different origin asks for confirmation naming it, clears cookies, storage and cache, and rebinds the bridge to the new origin. NFC stops and pending results are invalidated on navigation. Other origins never receive the bridge. Test your actual OIDC/passkey flow on the P400; WebView identity-provider support varies. Bridge origin checks do not protect against an XSS in the trusted verifier itself.

Scanner broadcasts are untrusted input from local apps, just like keyboard entry. They grant no extra authority. Install only trusted apps on managed readers.
